// An esplora-compatible HTTP API over the node's own validated chain: the calls gitmark and
// fund-agent make, and a few more. CORS open, so a browser page can use it.
//
//   GET  /blocks/tip/height  /blocks/tip/hash  /block-height/:h  /block/:hash  /block/:hash/txids
//   GET  /tx/:txid  /tx/:txid/hex  /tx/:txid/status  /tx/:txid/outspends
//   GET  /address/:addr  /address/:addr/utxo  /address/:addr/txs
//   GET  /status        the node's state: tip, sync, peers, mempool, UTXO set hash, epochs (src/status.js)
//   POST /tx            raw hex body; returns the txid
import http from 'node:http';
import { statusOf } from './status.js';

export function serveApi({ k, chain, net, store = null, started = Date.now(), port = 3497, host = '127.0.0.1', log = console.log }) {
  const hex = (tx, legacy = false) => k.codec.encodeHex('Transaction', tx, legacy ? { legacy: true } : {});
  const prevout = (txid, vout) => {
    const at = chain.tx(txid);
    const o = (at?.tx ?? net.mempool.get(txid))?.outputs[vout];
    return o ? vo(o) : null;
  };
  const vo = (o) => {
    const c = chain.addressOf(o.scriptPubKey);
    let type = 'unknown'; try { type = k.script.classify(o.scriptPubKey).type; } catch {}
    return { scriptpubkey: o.scriptPubKey, scriptpubkey_type: type, scriptpubkey_address: c ?? undefined, value: o.value };
  };
  const status = (txid) => {
    const at = chain.txAt.get(txid);
    if (!at) return { confirmed: false };
    return { confirmed: true, block_height: at.height, block_hash: chain.hashes[at.height], block_time: chain.headers[at.height].time };
  };
  const esplora = (tx, txid = k.codec.txid(tx)) => {
    const coinbase = chain.txAt.get(txid)?.index === 0;
    const vin = tx.inputs.map((i, n) => coinbase
      ? { txid: '0'.repeat(64), vout: 0xffffffff, is_coinbase: true, scriptsig: i.scriptSig, witness: tx.witness?.[n], sequence: i.sequence, prevout: null }
      : { txid: i.prevout.txid, vout: i.prevout.vout, is_coinbase: false, scriptsig: i.scriptSig, witness: tx.witness?.[n], sequence: i.sequence, prevout: prevout(i.prevout.txid, i.prevout.vout) });
    const vout = tx.outputs.map(vo);
    const fee = coinbase ? 0 : Math.max(0, vin.reduce((s, i) => s + (i.prevout?.value ?? 0), 0) - vout.reduce((s, o) => s + o.value, 0));
    return { txid, version: tx.version, locktime: tx.lockTime, size: hex(tx).length / 2, weight: k.codec.txWeight(tx), fee, vin, vout, status: status(txid) };
  };
  const findTx = (txid) => chain.tx(txid)?.tx ?? net.mempool.get(txid) ?? null;

  const poolSpends = () => { const s = new Map(); for (const [id, t] of net.mempool) t.inputs.forEach((i, n) => s.set(`${i.prevout.txid}:${i.prevout.vout}`, { txid: id, vin: n })); return s; };
  const touches = (tx, addr) => tx.outputs.some((o) => chain.addressOf(o.scriptPubKey) === addr)
    || tx.inputs.some((i) => prevout(i.prevout.txid, i.prevout.vout)?.scriptpubkey_address === addr);
  const utxos = (addr) => {
    const pool = poolSpends(), rows = [];
    for (const txid of chain.byAddr.get(addr) ?? []) chain.tx(txid).tx.outputs.forEach((o, n) => {
      const key = `${txid}:${n}`;
      if (chain.utxo.has(key) && !pool.has(key) && chain.addressOf(o.scriptPubKey) === addr) rows.push({ txid, vout: n, value: o.value, status: status(txid) });
    });
    for (const [txid, t] of net.mempool) t.outputs.forEach((o, n) => {
      if (chain.addressOf(o.scriptPubKey) === addr && !pool.has(`${txid}:${n}`)) rows.push({ txid, vout: n, value: o.value, status: { confirmed: false } });
    });
    return rows;
  };
  const stats = (addr, txs) => {
    const s = { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: txs.length };
    for (const e of txs) {
      for (const o of e.vout) if (o.scriptpubkey_address === addr) { s.funded_txo_count++; s.funded_txo_sum += o.value; }
      for (const i of e.vin) if (i.prevout?.scriptpubkey_address === addr) { s.spent_txo_count++; s.spent_txo_sum += i.prevout.value; }
    }
    return s;
  };

  const send = (res, code, body) => {
    res.writeHead(code, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json',
      'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname.replace(/^\/api(?=\/)/, '').replace(/\/+$/, '');
    let m;
    try {
      if (req.method === 'OPTIONS') return send(res, 204, '');
      if (req.method === 'POST' && p === '/tx') {
        let body = ''; for await (const c of req) body += c;
        let tx; try { tx = k.codec.decode('Transaction', body.trim()); } catch { return send(res, 400, 'sendrawtransaction RPC error: {"code":-22,"message":"TX decode failed"}'); }
        try { return send(res, 200, net.broadcast(tx)); } catch (e) { return send(res, 400, `sendrawtransaction RPC error: {"code":-26,"message":${JSON.stringify(e.message)}}`); }
      }
      if (req.method !== 'GET') return send(res, 405, 'method not allowed');
      if (p === '/status') return send(res, 200, statusOf({ chain, net, store, started }));
      if (p === '/blocks/tip/height') return send(res, 200, String(chain.height));
      if (p === '/blocks/tip/hash') return send(res, 200, chain.tip);
      if ((m = p.match(/^\/block-height\/(\d+)$/))) return chain.hashes[+m[1]] ? send(res, 200, chain.hashes[+m[1]]) : send(res, 404, 'Block not found');
      if ((m = p.match(/^\/block\/([0-9a-f]{64})(\/txids)?$/))) {
        const h = chain.byHash.get(m[1]); if (h == null) return send(res, 404, 'Block not found');
        const b = chain.blocks[h];
        if (m[2]) return send(res, 200, b.transactions.map((t) => k.codec.txid(t)));
        return send(res, 200, { id: m[1], height: h, version: b.header.version, timestamp: b.header.time, tx_count: b.transactions.length,
          merkle_root: b.header.merkleRoot, previousblockhash: b.header.prevBlockHash, bits: b.header.bits, nonce: b.header.nonce });
      }
      if ((m = p.match(/^\/tx\/([0-9a-f]{64})(\/hex|\/status|\/outspends)?$/))) {
        const tx = findTx(m[1]); if (!tx) return send(res, 404, 'Transaction not found');
        if (m[2] === '/hex') return send(res, 200, hex(tx));
        if (m[2] === '/status') return send(res, 200, status(m[1]));
        if (m[2] === '/outspends') {
          const pool = poolSpends();
          return send(res, 200, tx.outputs.map((_, n) => { const key = `${m[1]}:${n}`; const s = chain.spentBy.get(key) ?? pool.get(key);
            return s ? { spent: true, txid: s.txid, vin: s.vin, status: status(s.txid) } : { spent: false }; }));
        }
        return send(res, 200, esplora(tx, m[1]));
      }
      if ((m = p.match(/^\/address\/([a-z0-9]{14,90})(\/utxo|\/txs)?$/i))) {
        const addr = m[1];
        if (m[2] === '/utxo') return send(res, 200, utxos(addr));
        const conf = [...(chain.byAddr.get(addr) ?? [])].sort((a, b) => chain.txAt.get(b).height - chain.txAt.get(a).height).map((id) => esplora(chain.tx(id).tx, id));
        const pool = [...net.mempool].filter(([, t]) => touches(t, addr)).map(([id, t]) => esplora(t, id));
        if (m[2] === '/txs') return send(res, 200, [...pool, ...conf].slice(0, 50));
        return send(res, 200, { address: addr, chain_stats: stats(addr, conf), mempool_stats: stats(addr, pool) });
      }
      send(res, 404, 'not found');
    } catch (e) { send(res, 500, e.message); }
  });
  server.listen(port, host, () => log(`esplora API on http://${host}:${port}`));
  return server;
}
