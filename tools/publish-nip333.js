#!/usr/bin/env node
// NIP-333 (kind 33333) publisher for testnet5: the last 12 block headers (80 bytes each, oldest first)
// as a signed Nostr event with d = n = "tbtc5" and a `tip` tag. Same event builder, signer and relay
// pool as bitcoin-desktop/headers and the BLAKE2b publishers, so the events are byte-compatible.
// A validator first: every header in the window passes the engine's header rules and BIP54's under
// testnet5 before anything is signed.
//
//   node tools/publish-nip333.js [--once] [--dry-run] [--relays a,b] [--poll 10]
//
// Key: NOSTR_PRIVKEY, else `git config nostr.privkey` in KEY_REPO (default ~/ideas/knots, the key the
// other NIP-333 publishers use). Never taken from argv, never printed.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { loadKernel } from '../src/kernel.js';

const HOME = process.env.HOME;
const HEADERS_REPO = process.env.HEADERS_REPO ?? `${HOME}/remote/github.com/bitcoin-desktop/headers`;
const KEY_REPO = process.env.KEY_REPO ?? `${HOME}/ideas/knots`;
const { parsePrivateKey, publicKey, buildHeadersEvent, RelayPool } = await import(`${HEADERS_REPO}/publisher/nostr.js`);

export const WIRE = 'tbtc5';
const HEADERS_COUNT = 12;
const DEFAULT_RELAYS = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom', 'wss://nostr.oxtr.dev'];
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const log = (m) => console.log(`[${new Date().toISOString()}] ${WIRE}: ${m}`);
const fail = (m, code = 1) => { console.error(`[${new Date().toISOString()}] ${WIRE}: FATAL ${m}`); process.exit(code); };

let keyInput = process.env.NOSTR_PRIVKEY ?? null;
if (!keyInput) { try { keyInput = execFileSync('git', ['config', 'nostr.privkey'], { cwd: KEY_REPO }).toString().trim(); } catch {} }
if (!keyInput && !flag('dry-run')) fail(`no key: set NOSTR_PRIVKEY or git config nostr.privkey in ${KEY_REPO}`);
const priv = keyInput ? parsePrivateKey(keyInput) : Buffer.alloc(32, 1);
log(`publishing as ${publicKey(priv)}`);

// headers from the local testnet5 node (cookie re-read each time: it changes on restart)
const RPC = opt('rpc', 'http://127.0.0.1:18352');
const COOKIE = opt('cookie', `${HOME}/testnet5-rehearsal/data/testnet5/.cookie`);
async function rpcBatch(calls) {
  const auth = 'Basic ' + Buffer.from((await readFile(COOKIE, 'utf8')).trim()).toString('base64');
  const r = await fetch(RPC, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(calls.map(([method, params], id) => ({ jsonrpc: '1.0', id, method, params }))) });
  return (await r.json()).sort((a, b) => a.id - b.id).map((x) => { if (x.error) throw new Error(x.error.message); return x.result; });
}

const k = await loadKernel();

// the window plus what the rules need to judge it: 11 headers before (median time) and the period's first
async function validatedWindow(tip) {
  const start = tip - HEADERS_COUNT + 1;
  const iv = k.params.difficultyAdjustmentInterval;
  const want = new Set();
  for (let h = Math.max(0, start - 11); h <= tip; h++) want.add(h);
  for (let h = start; h <= tip; h++) { want.add(Math.max(0, h - (h % iv) - iv)); want.add(h - (h % iv)); }
  const heights = [...want].sort((a, b) => a - b);
  const hashes = await rpcBatch(heights.map((h) => ['getblockhash', [h]]));
  const hexes = await rpcBatch(hashes.map((h) => ['getblockheader', [h, false]]));
  const at = new Map(heights.map((h, i) => [h, k.codec.decode('BlockHeader', hexes[i])]));
  const hexAt = new Map(heights.map((h, i) => [h, hexes[i]]));
  const window = Array.from({ length: HEADERS_COUNT }, (_, i) => at.get(start + i));
  const prevContext = Array.from({ length: 11 }, (_, i) => at.get(start - 11 + i)).filter(Boolean);
  const res = k.headers.validateChain(window, { startHeight: start, prevContext, now: Math.floor(Date.now() / 1000), chainAt: (h) => at.get(h) ?? null });
  const failures = res.flatMap((r) => r.results.filter((x) => x.ok === false).map((x) => `${r.height}:${x.label}:${x.error}`));
  return { hexes: window.map((_, i) => hexAt.get(start + i)), res, failures, start };
}

const relays = opt('relays', DEFAULT_RELAYS.join(',')).split(',').map((s) => s.trim());
const pool = flag('dry-run') ? null : new RelayPool(relays, { log });
if (pool && await pool.connect() === 0) fail('no relays reachable');

let lastPublished = -1, unacked = 0;
async function tick() {
  const [tip] = await rpcBatch([['getblockcount', []]]);
  if (tip === lastPublished) return;
  const w = await validatedWindow(tip);
  if (w.failures.length) { log(`NOT publishing tip ${tip}: ${w.failures.join(' ')}`); return; }
  const passed = w.res.reduce((n, r) => n + r.results.filter((x) => x.ok === true).length, 0);
  const event = buildHeadersEvent({ network: WIRE, headersHex: w.hexes, tip }, priv);
  if (flag('dry-run')) {
    console.log(JSON.stringify({ id: event.id, pubkey: event.pubkey, kind: event.kind, tags: event.tags, content_bytes: event.content.length / 2, tip, start: w.start, rules_passed: passed }, null, 1));
    lastPublished = tip; return;
  }
  const acks = await pool.publish(event);
  if (acks > 0) { lastPublished = tip; unacked = 0; log(`published tip ${tip} (${event.id.slice(0, 12)}…, ${passed} rules passed) — ${acks}/${relays.length} relays acked`); }
  else if (++unacked >= 5) fail('5 consecutive unacked publishes', 3);
  else log(`publish NOT acked (${unacked} consecutive)`);
}

await tick();
if (flag('once')) { pool?.close(); process.exit(0); }
setInterval(() => tick().catch((e) => log(`error: ${e.message}`)), Number(opt('poll', 10)) * 1000);
