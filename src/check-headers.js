#!/usr/bin/env node
// Step 1: validate the whole testnet5 header chain, genesis to tip, with the bitcoin-kernel engine.
// Headers come from a local testnet5 node over RPC (the P2P source comes next). Every header is
// checked by the engine's header rules under TESTNET5, plus BIP54's Murch-Zawy rule, which the engine
// does not have yet: the last block of a difficulty period may not be earlier than the period's first.
//
//   node src/check-headers.js [--rpc http://127.0.0.1:18352] [--cookie <path>]

import { readFile } from 'node:fs/promises';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';
import { HeaderEngine } from '@bitcoin-desktop/schema/codec/headers.js';
import { TESTNET5, withTestnet5 } from './params.js';

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

const load = async (p) => JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8'));
const codec = new Codec(await load('schema/core.jsonld'), await load('schema/proof.jsonld'), await load('schema/p2p.jsonld'));
const he = HeaderEngine.fromSchemas(codec, withTestnet5(await load('schema/chain.jsonld')), await load('schema/validate.jsonld'), 'btc:testnet5');

const t0 = Date.now();
const [tip] = await rpcBatch([['getblockcount', []]]);
const heights = Array.from({ length: tip + 1 }, (_, h) => h);
const hashes = [];
for (let i = 0; i < heights.length; i += 1000) hashes.push(...await rpcBatch(heights.slice(i, i + 1000).map((h) => ['getblockhash', [h]])));
const hex = [];
for (let i = 0; i < hashes.length; i += 1000) hex.push(...await rpcBatch(hashes.slice(i, i + 1000).map((h) => ['getblockheader', [h, false]])));
const headers = hex.map((h) => codec.decode('BlockHeader', h));
const t1 = Date.now();

const genesisOk = codec.blockHash(headers[0]) === TESTNET5.genesisHash;
const verdicts = he.validateChain(headers.slice(1), { startHeight: 1, prevContext: [headers[0]] });

// BIP54 Murch-Zawy: a period's last block (height % 2016 == 2015) is not earlier than its first
const iv = TESTNET5.difficultyAdjustmentInterval;
const zawy = [];
for (let h = iv - 1; h <= tip; h += iv) if (headers[h].time < headers[h - iv + 1].time) zawy.push(h);

const bad = verdicts.filter((v) => !v.ok);
const skipped = {};
for (const v of verdicts) for (const r of v.results) if (r.ok === null) skipped[r.rule] = (skipped[r.rule] || 0) + 1;
const hashesMatch = verdicts.every((v, i) => v.hash === hashes[i + 1]);

console.log(`testnet5 headers 0..${tip}: fetched in ${t1 - t0} ms, validated in ${Date.now() - t1} ms`);
console.log(`genesis ${genesisOk ? 'matches' : 'DIFFERS'} (${TESTNET5.genesisHash.slice(0, 16)}…), block hashes ${hashesMatch ? 'match the node' : 'DIFFER from the node'}`);
console.log(`engine rules: ${verdicts.length - bad.length}/${verdicts.length} headers pass`);
for (const v of bad.slice(0, 10)) console.log(`  FAIL ${v.height} ${v.hash.slice(0, 16)}…: ${v.results.filter((r) => r.ok === false).map((r) => r.error || r.rule).join(', ')}`);
console.log(`BIP54 last-block-not-before-first: ${zawy.length ? 'FAIL at ' + zawy.join(', ') : 'ok'} (${Math.floor((tip + 1) / iv)} periods closed)`);
console.log(`not judged (rule, headers): ${Object.entries(skipped).map(([k, n]) => `${k.replace('btc:rule-header-', '')} ${n}`).join(', ') || 'none'}`);
const chainWork = he.work(headers[0]) + verdicts.at(-1).chainWork; // validateChain starts at block 1
console.log(`chain work: 0x${chainWork.toString(16)}`);
process.exit(genesisOk && hashesMatch && !bad.length && !zawy.length ? 0 : 1);
