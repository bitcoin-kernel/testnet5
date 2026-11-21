// The UTXO set hash: replaying the committed epoch files to block 2016 gives the hash_serialized_3
// that Bitcoin Core 32.1 (testnet5 branch) printed for dumptxoutset rollback=2016, and the hash does
// not depend on the order coins are held in. The snapshot file is the one Core wrote, byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadKernel } from '../src/kernel.js';
import { Chain } from '../src/chain.js';
import { createHash } from 'node:crypto';
import { hashSerialized3, snapshotFile } from '../src/snapshot.js';

const records = (file) => {
  const buf = readFileSync(new URL(`../epochs/${file}`, import.meta.url)), out = [];
  for (let at = 0; at + 4 <= buf.length;) { const n = buf.readUInt32LE(at); out.push(buf.subarray(at + 4, at + 4 + n)); at += 4 + n; }
  return out;
};

test('block 2016: same UTXO set hash, coins and tx count as Core', async () => {
  const k = await loadKernel(), chain = new Chain(k);
  const raws = [...records('epoch-0.bin'), records('epoch-1.bin')[0]];
  let txs = 0;
  raws.forEach((raw, h) => { const b = k.codec.decode('Block', raw.toString('hex')); if (h === 0) chain.setGenesis(b); else chain.connect(b); txs += b.transactions.length; });
  assert.equal(chain.height, 2016);
  assert.equal(chain.tip, '00000000000002b460275c363cfa762ede5d89a149133ec92fcca1469378eaac');
  const r = hashSerialized3(chain.utxo.values());
  assert.equal(r.hash, '34b419b3fe6679758f563ba280f8f100be912a948e7930c5c0475c2035eb8a5c');
  assert.equal(r.coins, 6483);
  assert.equal(txs, 2055);
  const file = snapshotFile(chain.utxo.values(), { baseHash: chain.tip, magic: k.params.magic });
  assert.equal(file.length, 280678);
  assert.equal(createHash('sha256').update(file).digest('hex'), 'afc7e2a01956839f43a556c125eab10c3be5f3c9d4cd6ab8e871d5da63d42d0b');
});

test('the hash ignores the order coins are given in (vouts past one VARINT byte included)', () => {
  const coin = (txid, vout, height) => ({ outpoint: { txid, vout }, output: { value: 1000 + vout, scriptPubKey: '51' }, height, coinbase: vout === 0 });
  const a = '11'.repeat(32), b = 'ff' + '00'.repeat(31);
  const coins = [coin(a, 0, 1), coin(a, 5, 2), coin(a, 127, 3), coin(a, 128, 3), coin(a, 300, 4), coin(a, 16512, 5), coin(b, 1, 6)];
  const one = hashSerialized3(coins), two = hashSerialized3([...coins].reverse());
  assert.equal(one.hash, two.hash);
  assert.equal(one.coins, 7);
  assert.equal(one.amount, 7n * 1000n + 0n + 5n + 127n + 128n + 300n + 16512n + 1n);
});

test('amount and script compression follow compressor.cpp', async () => {
  const { compressAmount, compressScript, varint } = await import('../src/snapshot.js');
  assert.equal(compressAmount(0), 0n); assert.equal(compressAmount(1), 1n); assert.equal(compressAmount(5000000000), 50n);
  assert.equal(compressAmount(2100000000000000), 0x1406f40n); assert.equal(compressAmount(1234), 1n + (123n * 9n + 3n) * 10n);
  assert.equal(varint(0).toString('hex'), '00'); assert.equal(varint(127).toString('hex'), '7f'); assert.equal(varint(128).toString('hex'), '8000');
  assert.equal(varint(16511).toString('hex'), 'ff7f'); assert.equal(varint(16512).toString('hex'), '808000');
  const h = '11'.repeat(20);
  assert.equal(compressScript(Buffer.from('76a914' + h + '88ac', 'hex')).toString('hex'), '00' + h);
  assert.equal(compressScript(Buffer.from('a914' + h + '87', 'hex')).toString('hex'), '01' + h);
  const g = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', gy = '483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8';
  assert.equal(compressScript(Buffer.from('21' + '02' + g + 'ac', 'hex')).toString('hex'), '02' + g);
  assert.equal(compressScript(Buffer.from('41' + '04' + g + gy + 'ac', 'hex')).toString('hex'), '04' + g); // G: on the curve, y even
  const off = '41' + '04' + g + '00'.repeat(31) + '01' + 'ac'; // not on the curve: kept whole
  assert.equal(compressScript(Buffer.from(off, 'hex')).toString('hex'), varint(67 + 6).toString('hex') + off);
  assert.equal(compressScript(Buffer.from('0014' + h, 'hex')).toString('hex'), '1c0014' + h); // segwit: size 22 + 6
});
