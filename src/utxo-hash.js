#!/usr/bin/env node
// The UTXO set hash (Core's hash_serialized_3) at one or more heights, from blocks this node has
// validated itself. Reads <data>/blocks.bin read-only, so it is safe beside a running node; every
// block is validated again on the way up. With --dump, also writes each snapshot file as Core's
// dumptxoutset does (<dir>/utxo-tbtc5-<height>.dat), byte for byte, and prints its sha256.
// --json prints dumptxoutset's fields plus what an attestation needs (assumeutxo attest --from <file>).
//
//   node src/utxo-hash.js --height 2016[,4032,…] [--data ./data] [--dump <dir>] [--json]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { loadKernel } from './kernel.js';
import { Chain } from './chain.js';
import { hashSerialized3, snapshotFile } from './snapshot.js';
import { USER_AGENT } from './net.js';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const heights = String(arg('--height', '')).split(',').filter(Boolean).map(Number).sort((a, b) => a - b);
if (!heights.length || heights.some((h) => !Number.isInteger(h) || h < 0)) { console.error('usage: node src/utxo-hash.js --height <h>[,<h>…] [--data <dir>] [--dump <dir>] [--json]'); process.exit(2); }
const dumpDir = arg('--dump');
const path = new URL('blocks.bin', new URL(arg('--data', '../data/').replace(/\/?$/, '/'), import.meta.url)).pathname;

const buf = readFileSync(path), raws = [];
for (let at = 0; at + 4 <= buf.length;) { const n = buf.readUInt32LE(at); if (at + 4 + n > buf.length) break; raws.push(buf.subarray(at + 4, at + 4 + n)); at += 4 + n; }
if (heights.at(-1) > raws.length - 1) { console.error(`${path} holds blocks 0..${raws.length - 1}; no block ${heights.at(-1)}`); process.exit(1); }

const k = await loadKernel();
const chain = new Chain(k);
const out = [];
let txs = 0;
for (let h = 0; h <= heights.at(-1); h++) {
  const block = k.codec.decode('Block', raws[h].toString('hex'));
  if (h === 0) chain.setGenesis(block); else chain.connect(block);
  txs += block.transactions.length; // Core's nChainTx counts genesis's coinbase too
  if (h !== heights[out.length]) continue;
  const t0 = Date.now(), r = hashSerialized3(chain.utxo.values());
  const o = { coins_written: r.coins, base_hash: chain.tip, base_height: h, txoutset_hash: r.hash, nchaintx: txs, amount: Number(r.amount) / 1e8, ms: Date.now() - t0,
    // every block from genesis was validated here, so the set is this node's own: chainstate full, validated
    network: 'tbtc5', genesis: chain.hashes[0], implementation: USER_AGENT, chainstate: 'full', validated: true, computed_at: new Date().toISOString().slice(0, 19) + 'Z' };
  if (dumpDir) {
    const file = resolve(dumpDir, `utxo-tbtc5-${h}.dat`);
    if (existsSync(file)) { console.error(`${file} exists`); process.exit(1); }
    const bytes = snapshotFile(chain.utxo.values(), { baseHash: chain.tip, magic: k.params.magic });
    mkdirSync(dumpDir, { recursive: true }); writeFileSync(file, bytes);
    Object.assign(o, { path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  out.push(o);
}
if (process.argv.includes('--json')) console.log(JSON.stringify(out.length === 1 ? out[0] : out, null, 2));
else for (const o of out) console.log(`${o.base_height} ${o.base_hash} ${o.txoutset_hash} · ${o.coins_written} coins · ${o.nchaintx} tx · ${o.ms} ms${o.path ? ` · ${o.path} ${o.bytes} bytes sha256 ${o.sha256}` : ''}`);
