// assumeUTXO from the coin set this node built itself, byte for byte as Bitcoin Core does it:
//
// - hashSerialized3: the UTXO set hash (kernel/coinstats.cpp), the txoutset_hash dumptxoutset prints
//   and assumeUTXO snapshots commit to. For every coin, in chainstate key order:
//     outpoint (32-byte txid, internal order; uint32 vout LE)
//     uint32 LE  height * 2 + coinbase
//     CTxOut     int64 LE value; CompactSize script length; script
//   all fed to one SHA-256d, shown byte-reversed like every uint256 Core prints.
//
// - snapshotFile: the file dumptxoutset writes (rpc/blockchain.cpp WriteUTXOSnapshot), version 2:
//     'utxo' 0xff, uint16 LE 2, the network's 4-byte message start, base block hash, uint64 LE coin count;
//     then per txid: txid, CompactSize(coins), and per coin CompactSize(vout), VARINT(code),
//     VARINT(CompressAmount(value)), the compressed script (compressor.cpp).
//
// Coins come in the engine's shape: { outpoint: { txid (display hex), vout }, output: { value, scriptPubKey }, height, coinbase }.
// Key order is Core's LevelDB order: 'C' + txid (internal order) + VARINT(vout), bytewise.
import { createHash } from 'node:crypto';

const rev = (hex) => Buffer.from(hex, 'hex').reverse();

// Core's VARINT (serialize.h WriteVarInt: MSB base-128, minus one per continuation byte)
export function varint(n) {
  n = BigInt(n); const out = [];
  for (let len = 0; ; len++) { out.push(Number(n & 0x7fn) | (len ? 0x80 : 0)); if (n <= 0x7fn) break; n = (n >> 7n) - 1n; }
  return Buffer.from(out.reverse());
}

function compactSize(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b;
}

// The coins in Core's key order, txid already in internal byte order.
function sorted(coins) {
  const rows = [];
  for (const c of coins) { const txid = rev(c.outpoint.txid); rows.push({ key: Buffer.concat([txid, varint(c.outpoint.vout)]), txid, c }); }
  return rows.sort((a, b) => Buffer.compare(a.key, b.key));
}

const code = (c) => ((c.height << 1) | (c.coinbase ? 1 : 0)) >>> 0;

export function hashSerialized3(coins) {
  const rows = sorted(coins), h = createHash('sha256'), head = Buffer.alloc(16);
  let amount = 0n;
  for (const { txid, c } of rows) {
    const value = BigInt(c.output.value), script = Buffer.from(c.output.scriptPubKey, 'hex');
    head.writeUInt32LE(c.outpoint.vout, 0); head.writeUInt32LE(code(c), 4); head.writeBigInt64LE(value, 8);
    h.update(txid); h.update(head); h.update(compactSize(script.length)); h.update(script);
    amount += value;
  }
  return { hash: createHash('sha256').update(h.digest()).digest().reverse().toString('hex'), coins: rows.length, amount };
}

// compressor.cpp CompressAmount
export function compressAmount(n) {
  n = BigInt(n); if (n === 0n) return 0n;
  let e = 0n;
  while (n % 10n === 0n && e < 9n) { n /= 10n; e++; }
  if (e < 9n) { const d = n % 10n; n /= 10n; return 1n + (n * 9n + d - 1n) * 10n + e; }
  return 1n + (n - 1n) * 10n + 9n;
}

// An uncompressed key is only compressed when it is a point on secp256k1 (CPubKey::IsFullyValid).
const P = 2n ** 256n - 2n ** 32n - 977n;
const mod = (a) => ((a % P) + P) % P;
const onCurve = (x, y) => x < P && y < P && mod(y * y) === mod(x * x * x + 7n);

// compressor.cpp CompressScript, then ScriptCompression::Ser's fallback of VARINT(size + 6) and the script
export function compressScript(s) {
  if (s.length === 25 && s[0] === 0x76 && s[1] === 0xa9 && s[2] === 20 && s[23] === 0x88 && s[24] === 0xac) return Buffer.concat([Buffer.from([0]), s.subarray(3, 23)]);
  if (s.length === 23 && s[0] === 0xa9 && s[1] === 20 && s[22] === 0x87) return Buffer.concat([Buffer.from([1]), s.subarray(2, 22)]);
  if (s.length === 35 && s[0] === 33 && s[34] === 0xac && (s[1] === 2 || s[1] === 3)) return s.subarray(1, 34);
  if (s.length === 67 && s[0] === 65 && s[66] === 0xac && s[1] === 4) {
    const x = BigInt('0x' + s.subarray(2, 34).toString('hex')), y = BigInt('0x' + s.subarray(34, 66).toString('hex'));
    if (onCurve(x, y)) return Buffer.concat([Buffer.from([4 | (s[65] & 1)]), s.subarray(2, 34)]);
  }
  return Buffer.concat([varint(s.length + 6), s]);
}

// -> Buffer, the whole snapshot file. magic: the network's message start as hex (testnet5: '46495645').
export function snapshotFile(coins, { baseHash, magic }) {
  const rows = sorted(coins), parts = [];
  const head = Buffer.alloc(51);
  head.write('utxo', 0, 'latin1'); head[4] = 0xff; head.writeUInt16LE(2, 5);
  Buffer.from(magic, 'hex').copy(head, 7); rev(baseHash).copy(head, 11); head.writeBigUInt64LE(BigInt(rows.length), 43);
  parts.push(head);
  for (let i = 0; i < rows.length;) {
    let j = i; while (j < rows.length && rows[j].txid.equals(rows[i].txid)) j++;
    parts.push(rows[i].txid, compactSize(j - i));
    for (; i < j; i++) {
      const c = rows[i].c;
      parts.push(compactSize(c.outpoint.vout), varint(code(c)), varint(compressAmount(c.output.value)), compressScript(Buffer.from(c.output.scriptPubKey, 'hex')));
    }
  }
  return Buffer.concat(parts);
}
