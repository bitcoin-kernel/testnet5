#!/usr/bin/env node
// Build the sealed epoch files the browser node starts from: one file per closed difficulty period
// (2016 blocks), each block as a 4-byte little-endian length then its raw bytes (with witness, as Core
// serves them). epochs/index.json lists each file's heights, last block hash and sha256. The tab still
// validates every block, so the files are transport, not trust; the index just catches a torn download.
//
//   node tools/build-epochs.js [--rpc http://127.0.0.1:18352] [--cookie <path>]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const RPC = arg('--rpc', 'http://127.0.0.1:18352');
const COOKIE = arg('--cookie', `${process.env.HOME}/testnet5-rehearsal/data/testnet5/.cookie`);
const auth = 'Basic ' + Buffer.from((await readFile(COOKIE, 'utf8')).trim()).toString('base64');
async function rpcBatch(calls) {
  const r = await fetch(RPC, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(calls.map(([method, params], id) => ({ jsonrpc: '1.0', id, method, params }))) });
  return (await r.json()).sort((a, b) => a.id - b.id).map((x) => { if (x.error) throw new Error(x.error.message); return x.result; });
}

const INTERVAL = 2016;
const dir = new URL('../epochs/', import.meta.url);
await mkdir(dir, { recursive: true });
const [tip] = await rpcBatch([['getblockcount', []]]);
const sealed = Math.floor((tip + 1) / INTERVAL); // only periods that are complete
const index = { network: 'testnet5', interval: INTERVAL, format: 'u32le length + raw block, repeated', epochs: [] };
for (let e = 0; e < sealed; e++) {
  const from = e * INTERVAL, to = from + INTERVAL - 1;
  const hashes = await rpcBatch(Array.from({ length: INTERVAL }, (_, i) => ['getblockhash', [from + i]]));
  const raws = await rpcBatch(hashes.map((h) => ['getblock', [h, 0]]));
  const parts = [];
  for (const hex of raws) { const b = Buffer.from(hex, 'hex'); const len = Buffer.alloc(4); len.writeUInt32LE(b.length); parts.push(len, b); }
  const file = Buffer.concat(parts);
  const name = `epoch-${e}.bin`;
  await writeFile(new URL(name, dir), file);
  index.epochs.push({ epoch: e, file: name, from, to, lastHash: hashes.at(-1), bytes: file.length, sha256: createHash('sha256').update(file).digest('hex') });
  console.log(`${name}: blocks ${from}..${to}, ${file.length} bytes`);
}
await writeFile(new URL('index.json', dir), JSON.stringify(index, null, 2) + '\n');
console.log(`epochs/index.json: ${sealed} sealed epoch(s); tip was ${tip}`);
