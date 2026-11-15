// The testnet5 node in a browser tab. Blocks come in bulk, as sealed epoch files (one per completed
// difficulty period) served next to this page; the tab validates every block with the bitcoin-kernel
// engine and BIP54, so the files are transport, not trust. Validated blocks are kept in IndexedDB,
// so a reload re-validates the local copy and downloads nothing.
//
// Other people's servers are asked at most once per page load, and only for the tip height
// (to show how far the epoch files are behind). Blocks are never fetched one by one.
const ENGINE = 'https://cdn.jsdelivr.net/gh/bitcoin-desktop/schema@v0.0.27';
const { createKernel } = await import(`${ENGINE}/codec/kernel.js`);
const { bip54 } = await import('./bip54.js');
const { Chain } = await import('./chain.js');

export const TIP_SOURCE = 'https://wormer.libbitcoin.net:58143/v1/top';
const EPOCHS = new URL('../epochs/', import.meta.url);

const json = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); };
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export async function loadKernel() {
  const s = (p) => json(`${ENGINE}/${p}`);
  const [core, proof, script, chain, validate, overlay] = await Promise.all([
    s('schema/core.jsonld'), s('schema/proof.jsonld'), s('schema/script.jsonld'), s('schema/chain.jsonld'), s('schema/validate.jsonld'),
    json(new URL('./bip54.jsonld', import.meta.url))]);
  return createKernel({ core, proof, script, chain, validate, network: 'btc:testnet5', overlays: [bip54(overlay)] });
}

// ---- IndexedDB: height -> raw block hex ----
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('testnet5-node', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('blocks');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const store = (db, mode, fn) => new Promise((resolve, reject) => {
  const t = db.transaction('blocks', mode); fn(t.objectStore('blocks'));
  t.oncomplete = () => resolve(); t.onerror = () => reject(t.error);
});
const allCached = (db) => new Promise((resolve, reject) => {
  const out = []; const req = db.transaction('blocks').objectStore('blocks').openCursor();
  req.onsuccess = () => { const c = req.result; if (!c) return resolve(out); out[c.key] = c.value; c.continue(); };
  req.onerror = () => reject(req.error);
});

// an epoch file: u32le length + raw block, repeated
function splitEpoch(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), out = [];
  for (let at = 0; at < buf.length;) { const n = view.getUint32(at, true); out.push(hex(buf.subarray(at + 4, at + 4 + n))); at += 4 + n; }
  return out;
}

export class BrowserNode {
  constructor({ onUpdate = () => {}, log = () => {} } = {}) {
    Object.assign(this, { onUpdate, log });
    this.stats = { cached: 0, fromEpochs: 0, epochBytes: 0, validateMs: 0 };
    this.networkTip = null;
  }

  async start() {
    this.k = await loadKernel();
    this.chain = new Chain(this.k);
    try { this.db = await openDb(); } catch { this.db = null; } // private windows: no cache, still works
    this.busy = true;
    // the one outside request: the tip height, to say how far behind we are
    fetch(TIP_SOURCE, { headers: { accept: 'application/json' } }).then((r) => r.json())
      .then((t) => { this.networkTip = Number(t); this.onUpdate(this); }).catch(() => {});
    // 1. the local copy, each block validated again
    const cached = this.db ? await allCached(this.db) : [];
    let h = 0;
    for (; h < cached.length && cached[h]; h++) {
      try { this.#connect(cached[h], h); } catch (e) { this.log(`cached block ${h} dropped: ${e.message}`); break; }
      this.stats.cached++;
      if (h % 250 === 0) { this.onUpdate(this); await new Promise((r) => setTimeout(r)); }
    }
    if (this.db && h < cached.length) await store(this.db, 'readwrite', (s) => s.delete(IDBKeyRange.lowerBound(h)));
    // 2. the sealed epochs we do not have yet, one file each
    const index = await json(new URL('index.json', EPOCHS));
    for (const e of index.epochs) {
      if (this.chain.height >= e.to) continue;
      this.log(`epoch ${e.epoch}: blocks ${e.from}..${e.to}, ${(e.bytes / 1e6).toFixed(2)} MB`);
      const buf = new Uint8Array(await (await fetch(new URL(e.file, EPOCHS))).arrayBuffer());
      const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)));
      if (digest !== e.sha256) throw new Error(`${e.file}: sha256 ${digest.slice(0, 12)}… is not the index's (torn download?)`);
      this.stats.epochBytes += buf.length;
      const blocks = splitEpoch(buf);
      const batch = [];
      for (let i = this.chain.height + 1 - e.from; i < blocks.length; i++) {
        const height = e.from + i;
        this.#connect(blocks[i], height);
        this.stats.fromEpochs++;
        batch.push([height, blocks[i]]);
        if (i % 250 === 0) { this.onUpdate(this); await new Promise((r) => setTimeout(r)); }
      }
      if (this.chain.tip !== e.lastHash) throw new Error(`epoch ${e.epoch} ends at ${this.chain.tip}, the index says ${e.lastHash}`);
      if (this.db) await store(this.db, 'readwrite', (s) => { for (const [height, b] of batch) s.put(b, height); });
    }
    this.busy = false;
    this.onUpdate(this);
  }

  #connect(blockHex, height) {
    const t0 = performance.now();
    const block = this.k.codec.decode('Block', blockHex);
    if (height === 0) this.chain.setGenesis(block); else this.chain.connect(block);
    this.stats.validateMs += performance.now() - t0;
  }

  balance(address) {
    let value = 0, coins = 0, mature = 0;
    for (const txid of this.chain.byAddr.get(address) ?? []) {
      this.chain.tx(txid).tx.outputs.forEach((o, n) => {
        const coin = this.chain.utxo.get(`${txid}:${n}`);
        if (!coin || this.chain.addressOf(o.scriptPubKey) !== address) return;
        value += o.value; coins++;
        if (!coin.coinbase || this.chain.height - coin.height >= 100) mature += o.value;
      });
    }
    return { value, coins, mature, txs: this.chain.byAddr.get(address)?.size ?? 0 };
  }
}
