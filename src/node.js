#!/usr/bin/env node
// The testnet5 node: sync from genesis over P2P, validating every block in full, follow the tip,
// and serve an esplora-compatible API. Nothing is trusted but proof of work and the rules.
//
//   node src/node.js [--api 3497] [--host 127.0.0.1] [--peers host1,host2]
import { loadKernel } from './kernel.js';
import { Chain } from './chain.js';
import { Net, PEERS } from './net.js';
import { serveApi } from './api.js';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

const k = await loadKernel();
const chain = new Chain(k);
const net = new Net(k, chain, { peers: arg('--peers', PEERS.join(',')).split(','), log });

const t0 = Date.now();
await net.start();
log(`synced to ${chain.height} (${chain.tip.slice(0, 16)}…) in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${chain.utxo.size} coins, ${net.peers.size} peers`);

let last = chain.height;
setInterval(() => { if (chain.height !== last) { log(`tip ${chain.height} ${chain.tip.slice(0, 16)}…, ${net.mempool.size} in mempool`); last = chain.height; } }, 5000);

serveApi({ k, chain, net, port: Number(arg('--api', 3497)), host: arg('--host', '127.0.0.1'), log });
