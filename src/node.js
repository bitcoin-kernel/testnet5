#!/usr/bin/env node
// The testnet5 node: sync from genesis over P2P, validating every block in full, follow the tip,
// and serve an esplora-compatible API. Nothing is trusted but proof of work and the rules.
//
//   node src/node.js [--api 3497] [--host 127.0.0.1] [--peers host1,host2] [--data ./data]
//
// Blocks are kept in <data>/blocks.bin. On start they are read back and validated again, then only
// newer blocks are fetched over P2P.
import { loadKernel } from './kernel.js';
import { Chain } from './chain.js';
import { Net, PEERS } from './net.js';
import { serveApi } from './api.js';
import { BlockFile } from './store.js';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

const k = await loadKernel();
const chain = new Chain(k);
const store = new BlockFile(new URL('blocks.bin', new URL(arg('--data', '../data/').replace(/\/?$/, '/'), import.meta.url)).pathname);
const net = new Net(k, chain, { peers: arg('--peers', PEERS.join(',')).split(','), log, store });

const t0 = Date.now();
const stored = store.load();
for (let h = 0; h < stored.length; h++) {
  try {
    const block = k.codec.decode('Block', stored[h].toString('hex'));
    if (h === 0) chain.setGenesis(block); else chain.connect(block);
  } catch (e) { log(`stored block ${h} dropped: ${e.message}`); store.dropFrom(h); break; }
}
if (stored.length) log(`validated ${chain.height + 1} stored blocks in ${((Date.now() - t0) / 1000).toFixed(1)} s (${(store.bytes() / 1e6).toFixed(2)} MB on disk)`);

await net.start();
log(`synced to ${chain.height} (${chain.tip.slice(0, 16)}…) in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${chain.utxo.size} coins, ${net.peers.size} peers`);

let last = chain.height;
setInterval(() => { if (chain.height !== last) { log(`tip ${chain.height} ${chain.tip.slice(0, 16)}…, ${net.mempool.size} in mempool`); last = chain.height; } }, 5000);

serveApi({ k, chain, net, port: Number(arg('--api', 3497)), host: arg('--host', '127.0.0.1'), log });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { net.stop(); store.close(); process.exit(0); });
