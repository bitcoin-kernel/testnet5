// GET /status: the committed epoch-0 blocks replayed to 2015 (the end of Core's first retarget period), served by
// the real API on a free port. The UTXO hash it reports is the one Core printed for dumptxoutset rollback=2015.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadKernel } from '../src/kernel.js';
import { Chain } from '../src/chain.js';
import { serveApi } from '../src/api.js';
import { statusOf, render } from '../src/status.js';

const k = await loadKernel(), chain = new Chain(k);
const buf = readFileSync(new URL('../epochs/epoch-0.bin', import.meta.url));
for (let at = 0, h = 0; at + 4 <= buf.length; h++) {
  const n = buf.readUInt32LE(at), b = k.codec.decode('Block', buf.subarray(at + 4, at + 4 + n).toString('hex')); at += 4 + n;
  if (h === 0) chain.setGenesis(b); else chain.connect(b);
}
const net = { peers: new Map([['lapis.erisian.com.au', { peerVersion: { userAgent: '/Satoshi:32.1.0/', startHeight: 2015 } }]]), mempool: new Map(), lastSync: { at: Date.UTC(2026, 10, 21), height: 2015 }, syncing: false };
const store = { ends: new Array(2016).fill(0), size: buf.length };

test('statusOf: tip, peers, UTXO set hash as Core has it, the next period end', () => {
  const s = statusOf({ chain, net, store, started: 0, now: 60_000 });
  assert.equal(s.tip.height, 2015);
  assert.equal(s.tip.hash, '00000000000005912750c25d2d60f320d3863e3a73332a7fbc990f8cc6194c93');
  assert.equal(s.utxo.hashSerialized3, '2113a3a90efd190303938952397fddfe5908e7ef9a916408f1aa802c66da9b3e'); // Core: dumptxoutset rollback=2015
  assert.equal(s.utxo.coins, 6475);
  assert.equal(s.epochs.nextPeriodEnd, 4031); // at a period end, the next one
  assert.equal(s.epochs.blocksToGo, 2016);
  assert.equal(s.epochs.lastSealed.to, 4031);
  assert.equal(s.peers[0].userAgent, '/Satoshi:32.1.0/');
  assert.equal(s.uptimeSeconds, 60);
  assert.equal(s.sync.lastError, null);
  assert.match(render(s), /hash_serialized_3 2113a3a9/);
});

test('GET /status over HTTP answers the same', async () => {
  const server = serveApi({ k, chain, net, store, port: 0, log: () => {} });
  await new Promise((r) => server.once('listening', r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/status`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    const s = await r.json();
    assert.equal(s.tip.height, 2015); assert.equal(s.utxo.coins, 6475); assert.equal(s.mempool.txs, 0);
  } finally { server.close(); }
});
