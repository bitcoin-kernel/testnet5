// The testnet5 chain in memory: every block, validated in full as it is connected, the set of
// unspent coins, and the indexes the API needs (txid -> where it is, address -> txids). The chain is
// small, so a reorg simply truncates to the fork point and replays from genesis (seconds).

export class Chain {
  constructor(k) {
    this.k = k;
    this.reset();
  }

  reset() {
    this.blocks = [];      // height -> decoded block (genesis at 0)
    this.hashes = [];      // height -> block hash
    this.byHash = new Map();
    this.headers = [];     // height -> header
    this.utxo = new Map(); // "txid:vout" -> coin (engine shape)
    this.txAt = new Map(); // txid -> { height, index }
    this.byAddr = new Map(); // address -> Set(txid)
    this.spentBy = new Map(); // "txid:vout" -> { txid, vin, height }
    this.work = 0n;
  }

  get height() { return this.blocks.length - 1; }
  get tip() { return this.hashes[this.height]; }

  // Genesis is fixed by the network; its coinbase is not a coin (as in Core).
  setGenesis(block) {
    const hash = this.k.codec.blockHash(block.header);
    if (hash !== this.k.params.genesisHash) throw new Error(`genesis ${hash} is not testnet5's`);
    this.#push(block, hash);
    this.#index(block, 0);
  }

  // Validate block (headers, structure, context incl. scripts and BIP54) against the current tip,
  // then connect it. Throws with the failed rules; the chain is unchanged on failure.
  connect(block) {
    const k = this.k, height = this.blocks.length;
    const hash = k.codec.blockHash(block.header);
    const window = this.headers.slice(Math.max(0, height - 11), height);
    const hv = k.headers.validateChain([block.header], { startHeight: height, prevContext: window, chainAt: (h) => this.headers[h] })[0];
    const sv = k.blocks.validateBlockStructure(block);
    const cv = k.blocks.validateBlockContext(block, { height, utxo: this.utxo, mtp: k.headers.medianTimePast(window) });
    const bad = [...hv.results, ...sv.results, ...cv.results].filter((r) => r.ok === false);
    if (bad.length) throw Object.assign(new Error(`block ${height} ${hash.slice(0, 16)}… invalid: ${bad.map((r) => r.error || r.rule).join(', ')}`), { invalid: true });
    this.#index(block, height);
    k.blocks.applyBlock(this.utxo, block, height);
    this.#push(block, hash);
  }

  // Drop everything above `height` and rebuild the coin set and indexes by replaying.
  truncate(height) {
    const keep = this.blocks.slice(0, height + 1);
    this.reset();
    this.setGenesis(keep[0]);
    for (const b of keep.slice(1)) this.connect(b);
  }

  #push(block, hash) {
    this.blocks.push(block); this.hashes.push(hash); this.headers.push(block.header);
    this.byHash.set(hash, this.blocks.length - 1);
    this.work += this.k.headers.work(block.header);
  }

  #index(block, height) {
    const k = this.k;
    block.transactions.forEach((tx, index) => {
      const txid = k.codec.txid(tx);
      this.txAt.set(txid, { height, index });
      if (index > 0) tx.inputs.forEach((inp, vin) => {
        const key = `${inp.prevout.txid}:${inp.prevout.vout}`;
        const coin = this.utxo.get(key);
        if (coin) { this.#touch(this.addressOf(coin.output.scriptPubKey), txid); this.spentBy.set(key, { txid, vin, height }); }
      });
      for (const o of tx.outputs) this.#touch(this.addressOf(o.scriptPubKey), txid);
    });
  }

  #touch(addr, txid) { if (!addr) return; let s = this.byAddr.get(addr); if (!s) this.byAddr.set(addr, s = new Set()); s.add(txid); }

  addressOf(spk) { try { return this.k.script.classify(spk).address; } catch { return null; } }

  tx(txid) { const at = this.txAt.get(txid); return at ? { ...at, tx: this.blocks[at.height].transactions[at.index] } : null; }

  // a block locator: the tip, then back 1, 2, 4, … to genesis
  locator() {
    const out = []; let step = 1;
    for (let h = this.height; h > 0; h -= step) { out.push(this.hashes[h]); if (out.length >= 10) step *= 2; }
    out.push(this.hashes[0]);
    return out;
  }
}
