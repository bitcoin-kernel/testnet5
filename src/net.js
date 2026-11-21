// Testnet5 over P2P: connect to peers, sync headers and blocks from genesis, follow the tip (with
// reorgs by most work), and keep a mempool of transactions peers announce or we broadcast.
import { Peer } from 'bitcoin-kernel-node/src/peer.js';
export const USER_AGENT = '/bitcoin-kernel-testnet5:0.0.1/'; // also the implementation an attestation names

export const PEERS = ['lapis.erisian.com.au', 'carmine.libbitcoin.net', 'wormer.libbitcoin.net'];
const MSG_TX = 1, MSG_BLOCK = 2, WITNESS = 0x40000000;
const ZERO = '0'.repeat(64);

export class Net {
  constructor(k, chain, { peers = PEERS, port = k.params.port, log = console.log, store = null } = {}) {
    Object.assign(this, { k, chain, hosts: peers, port, log, store });
    this.peers = new Map();   // host -> Peer
    this.mempool = new Map(); // txid -> tx
    this.syncing = false;
  }

  async start() {
    await Promise.all(this.hosts.map((h) => this.#connect(h)));
    if (!this.peers.size) throw new Error('no testnet5 peer reachable');
    await this.sync();
    this.timer = setInterval(() => this.sync().catch((e) => { this.lastError = { at: Date.now(), message: e.message }; this.log(`sync: ${e.message}`); }), 30000);
    this.redial = setInterval(() => this.hosts.filter((h) => !this.peers.has(h)).forEach((h) => this.#connect(h)), 60000);
  }

  stop() { clearInterval(this.timer); clearInterval(this.redial); for (const p of this.peers.values()) p.close(); }

  async #connect(host) {
    const peer = new Peer(this.k.p2p, this.k.codec);
    try {
      await peer.connect(host, this.port, { userAgent: USER_AGENT });
    } catch (e) { peer.close(); return; }
    peer.host = host;
    // unsolicited messages: block/tx announcements and the transactions we asked for
    peer.listeners.push({ command: 'inv', fn: (m) => this.#onInv(peer, m.payload) });
    peer.listeners.push({ command: 'tx', fn: (m) => this.#onTx(m.payload) });
    peer.socket.on('close', () => { if (this.peers.get(host) === peer) this.peers.delete(host); });
    this.peers.set(host, peer);
    this.log(`peer ${host} ${peer.peerVersion?.userAgent ?? ''} at ${peer.peerVersion?.startHeight ?? '?'}`);
  }

  #onInv(peer, inv) {
    const items = inv?.items ?? inv?.inventory ?? [];
    if (items.some((i) => (i.type & ~WITNESS) === MSG_BLOCK)) this.sync().catch((e) => this.log(`sync: ${e.message}`));
    const want = items.filter((i) => (i.type & ~WITNESS) === MSG_TX && !this.mempool.has(i.hash) && !this.chain.txAt.has(i.hash));
    if (want.length) peer.send('getdata', { items: want.map((i) => ({ type: MSG_TX | WITNESS, hash: i.hash })) });
  }

  #onTx(tx) {
    const txid = this.k.codec.txid(tx);
    if (this.chain.txAt.has(txid) || this.mempool.has(txid)) return;
    const why = this.check(tx);
    if (!why) this.mempool.set(txid, tx);
  }

  // A mempool admission check: well formed, every input an unspent coin (confirmed or in the pool),
  // no double spend against the pool, outputs not above inputs. Scripts are left to the peers.
  check(tx) {
    if (!this.k.blocks.validateTransaction(tx).ok) return 'malformed';
    const spent = new Set();
    for (const t of this.mempool.values()) for (const i of t.inputs) spent.add(`${i.prevout.txid}:${i.prevout.vout}`);
    let inSum = 0;
    for (const i of tx.inputs) {
      const key = `${i.prevout.txid}:${i.prevout.vout}`;
      if (spent.has(key)) return 'conflicts with the mempool';
      const coin = this.chain.utxo.get(key)?.output ?? this.mempool.get(i.prevout.txid)?.outputs[i.prevout.vout];
      if (!coin) return 'missing or spent input';
      inSum += coin.value;
    }
    return inSum >= tx.outputs.reduce((s, o) => s + o.value, 0) ? null : 'outputs exceed inputs';
  }

  // Drop pool entries a new block made invalid (spent inputs, double spends). Works from a snapshot:
  // deleting and re-adding keys while iterating the live Map re-queues them, and the loop never ends.
  recheck() {
    const pool = [...this.mempool];
    this.mempool.clear();
    for (const [id, tx] of pool) if (!this.check(tx)) this.mempool.set(id, tx);
  }

  // Broadcast: admit, then announce to every peer by sending the transaction itself.
  broadcast(tx) {
    const why = this.check(tx);
    if (why) throw new Error(why);
    const txid = this.k.codec.txid(tx);
    this.mempool.set(txid, tx);
    for (const p of this.peers.values()) p.send('tx', tx);
    return txid;
  }

  #peer() {
    const ps = [...this.peers.values()].sort((a, b) => (b.peerVersion?.startHeight ?? 0) - (a.peerVersion?.startHeight ?? 0));
    if (!ps.length) throw new Error('no peers');
    return ps[0];
  }

  async #getHeaders(peer, locator) {
    peer.send('getheaders', { version: 70016, blockLocator: locator, hashStop: ZERO });
    return ((await peer.waitFor(['headers'], 30000)).payload?.entries ?? []).map((e) => e.header);
  }

  async #getBlocks(peer, hashes) {
    const got = new Map();
    peer.send('getdata', { items: hashes.map((hash) => ({ type: MSG_BLOCK | WITNESS, hash })) });
    await peer.collect('block', hashes.length, { timeoutMs: 120000, onItem: (m) => got.set(this.k.codec.blockHash(m.payload.header), m.payload) });
    return hashes.map((h) => { const b = got.get(h); if (!b) throw new Error(`block ${h} not delivered`); return b; });
  }

  // Bring the chain to the best tip our peers know: headers first, then the blocks, each validated
  // in full as it is connected. A branch that forks below our tip is taken only with more work.
  async sync() {
    if (this.syncing) return; this.syncing = true;
    try {
      const peer = this.#peer();
      if (this.chain.height < 0) { const g = (await this.#getBlocks(peer, [this.k.params.genesisHash]))[0]; this.chain.setGenesis(g); this.#keep(g); }
      for (;;) {
        const hdrs = await this.#getHeaders(peer, this.chain.locator());
        if (!hdrs.length) break;
        const fork = this.chain.byHash.get(hdrs[0].prevBlockHash);
        if (fork == null) throw new Error(`peer ${peer.host} sent headers that connect to nothing we have`);
        const fresh = hdrs.filter((h) => !this.chain.byHash.has(this.k.codec.blockHash(h)));
        if (!fresh.length) break;
        if (fork < this.chain.height) {
          let theirs = 0n, ours = 0n;
          for (const h of hdrs) theirs += this.k.headers.work(h); // their branch, from fork + 1
          for (let h = fork + 1; h <= this.chain.height; h++) ours += this.k.headers.work(this.chain.headers[h]);
          if (theirs <= ours) break; // their branch is not heavier (yet)
          this.log(`reorg: back to ${fork} (dropping ${this.chain.height - fork} block(s))`);
          const dropped = this.chain.blocks.slice(fork + 1);
          this.chain.truncate(fork);
          this.store?.truncate(fork);
          for (const b of dropped) for (const tx of b.transactions.slice(1)) this.mempool.set(this.k.codec.txid(tx), tx);
        }
        for (let i = 0; i < fresh.length; i += 200) {
          const want = fresh.slice(i, i + 200).map((h) => this.k.codec.blockHash(h));
          for (const b of await this.#getBlocks(peer, want)) {
            this.chain.connect(b);
            this.#keep(b);
            for (const tx of b.transactions.slice(1)) this.mempool.delete(this.k.codec.txid(tx));
          }
        }
        this.recheck();
        if (hdrs.length < 2000) break;
      }
      this.lastSync = { at: Date.now(), height: this.chain.height }; // for GET /status
    } finally { this.syncing = false; this.store?.sync(); }
  }

  // a block that just validated and connected goes to disk, as the raw bytes it came as
  #keep(block) { this.store?.append(Buffer.from(this.k.codec.encode('Block', block))); }
}
