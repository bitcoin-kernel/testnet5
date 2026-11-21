// The mempool re-check after a block: it ends, keeps what is still valid, drops what a block spent,
// and of two pool transactions spending the same coin keeps only the first. (It used to loop forever
// once the pool held a valid transaction: deleting and re-adding keys while iterating a live Map.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Net } from '../src/net.js';

const k = { params: { port: 18353 }, blocks: { validateTransaction: () => ({ ok: true }) } };
const coin = (value) => ({ output: { value } });
const tx = (prev, value) => ({ inputs: [{ prevout: { txid: prev, vout: 0 } }], outputs: [{ value }] });

test('recheck ends and keeps only what is still spendable', () => {
  const chain = { utxo: new Map([['a:0', coin(100)], ['b:0', coin(100)]]) };
  const net = new Net(k, chain, { peers: [], log: () => {} });
  net.mempool.set('t1', tx('a', 90));
  net.mempool.set('t2', tx('b', 90));
  net.mempool.set('t3', tx('c', 90)); // its coin is gone
  net.recheck();
  assert.deepEqual([...net.mempool.keys()], ['t1', 't2']);
});

test('recheck keeps the first of two spends of one coin', () => {
  const chain = { utxo: new Map([['a:0', coin(100)]]) };
  const net = new Net(k, chain, { peers: [], log: () => {} });
  net.mempool.set('t1', tx('a', 90));
  net.mempool.set('t2', tx('a', 80));
  net.recheck();
  assert.deepEqual([...net.mempool.keys()], ['t1']);
});
