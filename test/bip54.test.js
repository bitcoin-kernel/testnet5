// The BIP54 overlay on real testnet5 data, and on tampered copies that each rule must reject.
// Block 4152 is the first gitmark funding on testnet5: a coinbase plus one P2WPKH spend of a
// matured coinbase output (fixture: its raw hex and the coin it spends).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createKernel } from '@bitcoin-desktop/schema/codec/kernel.js';
import { sigOpCount, spentSigOps } from '../src/bip54.js';
import { loadBip54 } from '../src/kernel.js';

const load = async (p) => JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8'));
const fixture = (f) => readFile(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const k = createKernel({
  core: await load('schema/core.jsonld'), proof: await load('schema/proof.jsonld'), script: await load('schema/script.jsonld'),
  chain: await load('schema/chain.jsonld'), validate: await load('schema/validate.jsonld'),
  network: 'btc:testnet5', overlays: [await loadBip54()],
});
const parse = (hex) => k.script.parse(hex);

const block = k.codec.decode('Block', (await fixture('block-4152.hex')).trim());
const prev = JSON.parse(await fixture('block-4152-prevout.json'));
const utxo = () => new Map([[`${prev.txid}:${prev.vout}`, {
  outpoint: { txid: prev.txid, vout: prev.vout }, height: prev.height, coinbase: prev.coinbase,
  output: { value: prev.value, scriptPubKey: prev.scriptPubKey } }]]);
const ctxRule = (b, id, height = 4152) =>
  k.blocks.validateBlockContext(b, { height, utxo: utxo(), mtp: 0 }).results.find((r) => r.rule === id);
const clone = (b) => structuredClone(b);

test('the network is testnet5 with BIP54 from block 1', () => {
  assert.equal(k.params.name, 'testnet5');
  assert.equal(k.params.bip54Height, 1);
  assert.equal(k.params.maxTimewarp, 7200);
});

test('real block 4152 passes every rule, the BIP54 ones included', () => {
  assert.ok(k.blocks.validateBlockStructure(block).ok);
  const v = k.blocks.validateBlockContext(block, { height: 4152, utxo: utxo(), mtp: 0 });
  assert.deepEqual(v.results.filter((r) => r.ok === false), []);
  for (const id of ['bip54:rule-blockctx-coinbase-locktime', 'bip54:rule-blockctx-tx-sigops', 'btc:rule-blockctx-scripts']) {
    assert.equal(v.results.find((r) => r.rule === id).ok, true, id);
  }
});

test('coinbase nLockTime must be height - 1', () => {
  assert.equal(block.transactions[0].lockTime, 4151);
  assert.equal(ctxRule(block, 'bip54:rule-blockctx-coinbase-locktime', 4153).ok, false);
  const b = clone(block); b.transactions[0].lockTime = 0;
  assert.equal(ctxRule(b, 'bip54:rule-blockctx-coinbase-locktime').error, 'bad-cb-locktime');
});

test('coinbase nSequence may not be final', () => {
  const b = clone(block); b.transactions[0].inputs[0].sequence = 0xffffffff;
  assert.equal(ctxRule(b, 'bip54:rule-blockctx-coinbase-locktime').ok, false);
});

test('a 64-byte transaction (without witness) is rejected', () => {
  const rule = (b) => k.blocks.validateBlockStructure(b).results.find((r) => r.rule === 'bip54:rule-block-no-64-byte-tx').ok;
  assert.equal(rule(block), true);
  // one input, one output, empty scriptSig: 10 + 41 + 9 + scriptPubKey = 64 with a 4-byte scriptPubKey
  const tx64 = { version: 2, inputs: [{ prevout: { txid: '11'.repeat(32), vout: 0 }, scriptSig: '', sequence: 0xffffffff }],
    outputs: [{ value: 1000, scriptPubKey: '51515151' }], lockTime: 0, witness: [[]] };
  assert.equal(k.codec.encode('Transaction', tx64, { legacy: true }).length, 64);
  const b = clone(block); b.transactions.push(tx64);
  assert.equal(rule(b), false);
});

test('sigops: counted as Core does, and more than 2500 in one transaction is rejected', () => {
  const multisig3 = '53' + '21' + '02'.repeat(33) + '21' + '03'.repeat(33) + '21' + '02'.repeat(33) + '53ae';
  assert.equal(sigOpCount(parse(multisig3), true), 3);   // accurate: OP_3 CHECKMULTISIG
  assert.equal(sigOpCount(parse(multisig3), false), 20); // inaccurate
  assert.equal(sigOpCount(parse('ac'), true), 1);        // CHECKSIG
  // P2SH counts the redeem script, the scriptSig's last push
  assert.equal(spentSigOps(parse, 'a914' + '00'.repeat(20) + '87', '00' + '4c69' + multisig3), 3);
  // a spent bare scriptPubKey of 2501 CHECKSIGs, in one input, breaks the limit
  const b = clone(block);
  const u = utxo(); u.get(`${prev.txid}:${prev.vout}`).output.scriptPubKey = 'ac'.repeat(2501);
  const v = k.blocks.validateBlockContext(b, { height: 4152, utxo: u, mtp: 0 });
  assert.equal(v.results.find((r) => r.rule === 'bip54:rule-blockctx-tx-sigops').error, 'bad-txns-legacy-sigops');
});

test('a period may not end before it began (time-negative-interval)', async () => {
  const headers = (await fixture('headers-0-2100.hex')).trim().split('\n').map((h) => k.codec.decode('BlockHeader', h));
  const at = (hdr, height) => k.headers.validateHeader({ header: hdr, height, prev: headers[height - 1],
    mtpWindow: [], chainAt: (h) => headers[h] }).results.find((r) => r.rule === 'bip54:rule-header-period-order');
  assert.equal(at(headers[2015], 2015).ok, true);
  // the period ending at 2015 began at 0 (Core: first_height = nHeight - 2016 + 1)
  assert.equal(at({ ...headers[2015], time: headers[0].time }, 2015).ok, true);
  assert.equal(at({ ...headers[2015], time: headers[0].time - 1 }, 2015).error, 'time-negative-interval');
  assert.equal(at({ ...headers[2014], time: headers[0].time - 1 }, 2014).ok, true);   // only the last block of a period
});
