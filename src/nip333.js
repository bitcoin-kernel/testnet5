// The testnet5 tip as NIP-333 says it: the newest kind 33333 event with d = "tbtc5" from the pinned
// publisher, read from several relays. Each event is checked here before it counts: Schnorr signature,
// author, and its 12 headers (proof of work, each linking to the one before, the `tip` tag matching).
// The highest checked tip wins. No request to any Bitcoin server.

export const NIP333 = {
  d: 'tbtc5',
  pubkey: 'cccccc0a8338a4aba51691f309f2f892c6c58f655a1ec3fc30522c894c166d9c',
  relays: ['wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom', 'wss://nostr.oxtr.dev'],
};

function ask(url, timeoutMs) {
  return new Promise((resolve) => {
    let ws, done = false; const events = [];
    const finish = () => { if (done) return; done = true; clearTimeout(timer); try { ws.close(); } catch {} resolve(events); };
    const timer = setTimeout(finish, timeoutMs);
    try { ws = new WebSocket(url); } catch { return finish(); }
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 't5', { kinds: [33333], authors: [NIP333.pubkey], '#d': [NIP333.d], limit: 3 }]));
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(m.data); } catch { return; }
      if (msg[0] === 'EVENT' && msg[1] === 't5') events.push(msg[2]);
      if (msg[0] === 'EOSE') finish();
    };
    ws.onerror = finish; ws.onclose = finish;
  });
}

// -> { tip, hash, relays, created_at, headers } or null
export async function nostrTip(k, verifyNostrEvent, { timeoutMs = 6000 } = {}) {
  const answers = await Promise.all(NIP333.relays.map((r) => ask(r, timeoutMs).then((evs) => evs.map((e) => ({ e, r })))));
  const ok = new Map(); // event id -> { result, relays }
  for (const { e, r } of answers.flat()) {
    if (ok.has(e.id)) { ok.get(e.id).relays.add(r); continue; }
    const result = check(k, verifyNostrEvent, e);
    if (result) ok.set(e.id, { result, relays: new Set([r]) });
  }
  const best = [...ok.values()].sort((a, b) => b.result.tip - a.result.tip || b.result.created_at - a.result.created_at)[0];
  return best ? { ...best.result, relays: best.relays.size } : null;
}

function check(k, verifyNostrEvent, e) {
  try {
    if (e.kind !== 33333 || e.pubkey !== NIP333.pubkey) return null;
    if (!e.tags.some((t) => t[0] === 'd' && t[1] === NIP333.d)) return null;
    if (e.created_at > Date.now() / 1000 + 600) return null; // dated in the future: refused
    if (!verifyNostrEvent(e)) return null;
    const tip = Number(e.tags.find((t) => t[0] === 'tip')?.[1]);
    if (!Number.isInteger(tip) || e.content.length % 160 !== 0) return null;
    const headers = [];
    for (let i = 0; i < e.content.length; i += 160) headers.push(k.codec.decode('BlockHeader', e.content.slice(i, i + 160)));
    for (let i = 0; i < headers.length; i++) {
      if (!k.codec.checkProofOfWork(headers[i])) return null;
      if (i && headers[i].prevBlockHash !== k.codec.blockHash(headers[i - 1])) return null;
    }
    return { tip, hash: k.codec.blockHash(headers.at(-1)), created_at: e.created_at, headers, firstHeight: tip - headers.length + 1 };
  } catch { return null; }
}
