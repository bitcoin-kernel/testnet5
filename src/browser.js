// The testnet5 node in a browser tab. Blocks arrive over HTTPS from libbitcoin servers (raw bytes,
// identical to Core's); the tab validates every one with the bitcoin-kernel engine and BIP54, so a
// server is only transport: a bad block fails here like anywhere. Blocks are kept in IndexedDB, so a
// reload re-validates from local copies and fetches only what is new.
const ENGINE = 'https://cdn.jsdelivr.net/gh/bitcoin-desktop/schema@v0.0.27';
const { createKernel } = await import(`${ENGINE}/codec/kernel.js`);
const { bip54 } = await import('./bip54.js');
const { Chain } = await import('./chain.js');

export const SOURCES = ['https://wormer.libbitcoin.net:58143/v1', 'https://carmine.libbitcoin.net:58143/v1'];
const CONCURRENCY = 6;

const json = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); };

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
const tx = (db, mode, fn) => new Promise((resolve, reject) => {
  const t = db.transaction('blocks', mode); const out = fn(t.objectStore('blocks'));
  t.oncomplete = () => resolve(out?.result ?? out); t.onerror = () => reject(t.error);
});
const allCached = (db) => new Promise((resolve, reject) => {
  const out = []; const req = db.transaction('blocks').objectStore('blocks').openCursor();
  req.onsuccess = () => { const c = req.result; if (!c) return resolve(out); out[c.key] = c.value; c.continue(); };
  req.onerror = () => reject(req.error);
});

export class BrowserNode {
  constructor({ onUpdate = () => {}, log = () => {} } = {}) { Object.assign(this, { onUpdate, log }); this.stats = { fetched: 0, cached: 0, validateMs: 0 }; }

  async start() {
    this.k = await loadKernel();
    this.chain = new Chain(this.k);
    try { this.db = await openDb(); } catch { this.db = null; } // private windows: no cache, still works
    // 1. local copies first, each validated again
    const cached = this.db ? await allCached(this.db) : [];
    let h = 0;
    for (; h < cached.length && cached[h]; h++) {
      try { this.#connect(cached[h], h); } catch (e) { this.log(`cached block ${h} dropped: ${e.message}`); break; }
      this.stats.cached++;
      if (h % 250 === 0) { this.onUpdate(this); await new Promise((r) => setTimeout(r)); }
    }
    if (this.db && h < cached.length) await tx(this.db, 'readwrite', (s) => s.delete(IDBKeyRange.lowerBound(h)));
    // 2. the rest from a source, then follow
    await this.sync();
    this.timer = setInterval(() => this.sync().catch((e) => this.log(e.message)), 30000);
  }

  #connect(hex, height) {
    const t0 = performance.now();
    const block = this.k.codec.decode('Block', hex);
    if (height === 0) this.chain.setGenesis(block); else this.chain.connect(block);
    this.stats.validateMs += performance.now() - t0;
  }

  async #fetchBlock(source, height) {
    const r = await fetch(`${source}/block/height/${height}`, { headers: { accept: 'text/plain' } });
    if (!r.ok) throw new Error(`block ${height}: ${r.status}`);
    return (await r.text()).trim();
  }

  async sync() {
    if (this.busy) return; this.busy = true;
    try {
      for (const source of SOURCES) {
        try { await this.#syncFrom(source); this.source = source; break; }
        catch (e) { this.log(`${new URL(source).host}: ${e.message}`); }
      }
    } finally { this.busy = false; this.onUpdate(this); }
  }

  async #syncFrom(source) {
    const top = Number(await (await fetch(`${source}/top`, { headers: { accept: 'application/json' } })).json());
    let reorgs = 0;
    while (this.chain.height < top) {
      const from = this.chain.height + 1, to = Math.min(top, from + 99);
      const hexes = new Array(to - from + 1);
      let next = from;
      await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        while (next <= to) { const h = next++; hexes[h - from] = await this.#fetchBlock(source, h); this.stats.fetched++; }
      }));
      for (let i = 0; i < hexes.length; i++) {
        const height = from + i;
        try { this.#connect(hexes[i], height); }
        catch (e) {
          // a block that does not build on our tip: the source is on another branch, or ours was reorged away
          if (!/prev-link|bad-prevblk|prev/.test(e.message) || reorgs++ > 3) throw e;
          const back = Math.max(0, this.chain.height - 6);
          this.log(`reorg: rolling back to ${back}`);
          this.chain.truncate(back);
          if (this.db) await tx(this.db, 'readwrite', (s) => s.delete(IDBKeyRange.lowerBound(back + 1)));
          break;
        }
        if (this.db) await tx(this.db, 'readwrite', (s) => s.put(hexes[i], height));
      }
      this.onUpdate(this);
    }
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
