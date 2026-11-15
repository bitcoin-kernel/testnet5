// Testnet5 header rules on real headers 0..2100 (fixture from a testnet5 node), which include the
// first retarget at 2016. Tampered copies check that the rules testnet5 changes actually bite:
// no 20-minute exception, BIP54's 2-hour timewarp grace, and the mainnet-style retarget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';
import { HeaderEngine } from '@bitcoin-desktop/schema/codec/headers.js';
import { TESTNET5, withTestnet5 } from '../src/params.js';

const load = async (p) => JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8'));
const codec = new Codec(await load('schema/core.jsonld'), await load('schema/proof.jsonld'), await load('schema/p2p.jsonld'));
const he = HeaderEngine.fromSchemas(codec, withTestnet5(await load('schema/chain.jsonld')), await load('schema/validate.jsonld'), 'btc:testnet5');
const headers = (await readFile(new URL('./fixtures/headers-0-2100.hex', import.meta.url), 'utf8')).trim().split('\n').map((h) => codec.decode('BlockHeader', h));

// one rule's verdict for header `hdr` at `height`, in the real chain's context
function rule(id, hdr, height) {
  const ctx = { header: hdr, height, prev: headers[height - 1], mtpWindow: headers.slice(Math.max(0, height - 11), height),
    epochFirst: height % 2016 === 0 ? headers[height - 2016] : null, chainAt: (h) => headers[h] };
  return he.validateHeader(ctx).results.find((r) => r.rule === `btc:rule-header-${id}`).ok;
}

test('genesis is the BIP95 genesis', () => {
  assert.equal(codec.blockHash(headers[0]), TESTNET5.genesisHash);
  assert.equal(headers[0].bits, 0x1a0fffff);
});

test('real headers 1..2100 pass every rule, across the first retarget', () => {
  const v = he.validateChain(headers.slice(1), { startHeight: 1, prevContext: [headers[0]] });
  assert.equal(v.length, 2100);
  assert.deepEqual(v.filter((x) => !x.ok).map((x) => x.height), []);
  assert.equal(headers[2015].bits, 0x1a0fffff);
  assert.equal(headers[2016].bits, 0x1a03ffff); // 4x up, the cap
});

test('no 20-minute exception: powLimit bits after a long gap are rejected mid-period', () => {
  const h = 1000;
  const hdr = { ...headers[h], time: headers[h - 1].time + 3600 }; // an hour after the previous block
  assert.equal(rule('difficulty', hdr, h), true);                  // same bits as the period: fine
  // pretend the period was harder; then min-difficulty bits are wrong even after the gap
  const hard = { ...headers[2050], time: headers[2049].time + 3600, bits: 0x1a0fffff };
  assert.equal(rule('difficulty', hard, 2050), false);
});

test('retarget at 2016 scales the last block of the period (mainnet style)', () => {
  assert.equal(rule('difficulty', headers[2016], 2016), true);
  assert.equal(rule('difficulty', { ...headers[2016], bits: 0x1a0fffff }, 2016), false);
});

test('BIP54 timewarp: a period-first block may be up to 2 hours before the previous one, no more', () => {
  const prev = headers[2015];
  assert.equal(rule('timewarp', { ...headers[2016], time: prev.time - 7200 }, 2016), true);
  assert.equal(rule('timewarp', { ...headers[2016], time: prev.time - 7201 }, 2016), false);
  // testnet4's BIP94 would already reject 601 s; testnet5 allows it
  assert.equal(rule('timewarp', { ...headers[2016], time: prev.time - 601 }, 2016), true);
});

test('a header whose bits do not meet its hash fails proof of work', () => {
  assert.equal(rule('pow', headers[1500], 1500), true);
  assert.equal(rule('pow', { ...headers[1500], nonce: (headers[1500].nonce + 1) >>> 0 }, 1500), false);
});
