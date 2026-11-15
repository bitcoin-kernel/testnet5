#!/usr/bin/env node
// Step 2: validate every testnet5 block from genesis with the bitcoin-kernel engine and the BIP54
// overlay, keeping the whole set of unspent coins in memory, then compare it with Core's
// gettxoutsetinfo. Blocks come from a local testnet5 node over RPC (P2P comes next).
//
//   node src/check-blocks.js [--rpc http://127.0.0.1:18352] [--cookie <path>] [--to <height>]

import { readFile } from 'node:fs/promises';
import { createKernel } from '@bitcoin-desktop/schema/codec/kernel.js';
import { loadBip54 } from './kernel.js';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const RPC = arg('--rpc', 'http://127.0.0.1:18352');
const COOKIE = arg('--cookie', `${process.env.HOME}/testnet5-rehearsal/data/testnet5/.cookie`);

const auth = 'Basic ' + Buffer.from((await readFile(COOKIE, 'utf8')).trim()).toString('base64');
async function rpcBatch(calls) {
  const r = await fetch(RPC, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(calls.map(([method, params], id) => ({ jsonrpc: '1.0', id, method, params }))) });
  const out = await r.json();
  return out.sort((a, b) => a.id - b.id).map((x) => { if (x.error) throw new Error(x.error.message); return x.result; });
}
const rpc = async (method, ...params) => (await rpcBatch([[method, params]]))[0];

const load = async (p) => JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8'));
const k = createKernel({
  core: await load('schema/core.jsonld'), proof: await load('schema/proof.jsonld'), script: await load('schema/script.jsonld'),
  chain: await load('schema/chain.jsonld'), validate: await load('schema/validate.jsonld'),
  network: 'btc:testnet5', overlays: [await loadBip54()],
});

const tip = Number(arg('--to', await rpc('getblockcount')));
const t0 = Date.now();
const hashes = [];
for (let i = 0; i <= tip; i += 1000) hashes.push(...await rpcBatch(Array.from({ length: Math.min(1000, tip + 1 - i) }, (_, j) => ['getblockhash', [i + j]])));

const utxo = new Map();
const headers = [];
const fails = [];
const notJudged = {};
let txs = 0, fetchMs = 0;
const BATCH = 200;
for (let start = 0; start <= tip; start += BATCH) {
  const f0 = Date.now();
  const raws = await rpcBatch(hashes.slice(start, start + BATCH).map((h) => ['getblock', [h, 0]]));
  fetchMs += Date.now() - f0;
  raws.forEach((raw, j) => {
    const height = start + j;
    const block = k.codec.decode('Block', raw);
    headers.push(block.header);
    const hash = k.codec.blockHash(block.header);
    if (hash !== hashes[height]) fails.push({ height, why: ['hash differs from node'] });
    if (height === 0) return; // genesis: its coinbase is not spendable, as in Core
    const hv = k.headers.validateChain([block.header], { startHeight: height, prevContext: headers.slice(Math.max(0, height - 11), height),
      chainAt: (h) => headers[h] });
    const sv = k.blocks.validateBlockStructure(block);
    const mtp = k.headers.medianTimePast(headers.slice(Math.max(0, height - 11), height));
    const cv = k.blocks.validateBlockContext(block, { height, utxo, mtp });
    const all = [...hv[0].results, ...sv.results, ...cv.results];
    const bad = all.filter((r) => r.ok === false);
    for (const r of all) if (r.ok === null) notJudged[r.rule] = (notJudged[r.rule] || 0) + 1;
    if (bad.length) fails.push({ height, why: bad.map((r) => r.error || r.rule) });
    k.blocks.applyBlock(utxo, block, height);
    txs += block.transactions.length;
  });
}
const ms = Date.now() - t0;

let total = 0;
for (const c of utxo.values()) total += c.output.value;
const core = await rpc('gettxoutsetinfo', 'none');

console.log(`testnet5 blocks 0..${tip}: ${txs} transactions, validated in ${ms - fetchMs} ms (+${fetchMs} ms fetching)`);
console.log(`rules: ${tip - fails.length}/${tip} blocks pass every engine rule and every BIP54 rule`);
for (const f of fails.slice(0, 10)) console.log(`  FAIL ${f.height}: ${f.why.join(', ')}`);
console.log(`not judged (rule: blocks): ${Object.entries(notJudged).map(([r, n]) => `${r.replace(/^.*rule-/, '')} ${n}`).join(', ') || 'none'}`);
const sameTip = core.height === tip;
console.log(`coins: ${utxo.size} worth ${(total / 1e8).toFixed(8)}; Core${sameTip ? '' : ` (at ${core.height}, tip moved)`}: ${core.txouts} worth ${core.total_amount.toFixed(8)} -> ${sameTip ? (utxo.size === core.txouts && Math.round(core.total_amount * 1e8) === total ? 'MATCH' : 'DIFFER') : 'not compared'}`);
process.exit(fails.length ? 1 : 0);
