#!/usr/bin/env node
// The node's state in one place. statusOf() is what GET /status answers; run as a script, this prints
// it in a few lines, from the API of a running node.
//
//   node src/status.js [--api http://127.0.0.1:3497] [--watch <seconds>] [--json]
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { hashSerialized3 } from './snapshot.js';
import { USER_AGENT } from './net.js';

const INTERVAL = 2016; // Core's retarget period; an epoch is one (bitcoin-desktop/schema epoch.jsonld)
const EPOCHS = new URL('../epochs/index.json', import.meta.url);
let cached = null; // the set's hash at one tip: recomputed only when the tip moves

export function utxoAtTip(chain) {
  if (cached?.tip !== chain.tip) {
    const t0 = Date.now(), r = hashSerialized3(chain.utxo.values());
    cached = { tip: chain.tip, coins: r.coins, amount: Number(r.amount) / 1e8, hashSerialized3: r.hash, ms: Date.now() - t0 };
  }
  const { tip, ...rest } = cached; return rest;
}

export function statusOf({ chain, net, store, started = Date.now(), now = Date.now(), epochsIndex = EPOCHS }) {
  const head = chain.headers[chain.height];
  let lastSealed = null;
  try { if (existsSync(epochsIndex)) { const e = JSON.parse(readFileSync(epochsIndex, 'utf8')).epochs?.at(-1); if (e) lastSealed = { epoch: e.epoch, from: e.from, to: e.to, lastHash: e.lastHash }; } } catch {}
  const periodEnd = (Math.floor((chain.height + 1) / INTERVAL) + 1) * INTERVAL - 1;
  return {
    implementation: USER_AGENT,
    network: 'testnet5',
    uptimeSeconds: Math.round((now - started) / 1000),
    tip: { height: chain.height, hash: chain.tip, time: head?.time ?? null, ageSeconds: head ? Math.max(0, Math.round(now / 1000 - head.time)) : null },
    sync: { lastAt: net.lastSync ? new Date(net.lastSync.at).toISOString() : null, lastHeight: net.lastSync?.height ?? null, syncing: !!net.syncing,
      lastError: net.lastError ? { at: new Date(net.lastError.at).toISOString(), message: net.lastError.message } : null },
    peers: [...net.peers.entries()].map(([host, p]) => ({ host, userAgent: p.peerVersion?.userAgent ?? null, startHeight: p.peerVersion?.startHeight ?? null })),
    mempool: { txs: net.mempool.size },
    utxo: utxoAtTip(chain),
    epochs: { lastSealed, nextPeriodEnd: periodEnd, blocksToGo: periodEnd - chain.height },
    store: store ? { blocks: store.ends.length, bytes: store.size } : null,
  };
}

const ago = (s) => s == null ? '?' : s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
export function render(s) {
  const lines = [
    `${s.implementation} · ${s.network} · up ${ago(s.uptimeSeconds)}`,
    `tip      ${s.tip.height} ${s.tip.hash} · block ${ago(s.tip.ageSeconds)} old`,
    `sync     ${s.sync.syncing ? 'syncing now' : 'last ' + (s.sync.lastAt ?? 'never')}${s.sync.lastError ? ` · last error ${s.sync.lastError.at}: ${s.sync.lastError.message}` : ''}`,
    `peers    ${s.peers.length ? s.peers.map((p) => `${p.host} ${p.userAgent ?? ''} (at ${p.startHeight ?? '?'} on connect)`).join(', ') : 'none'}`,
    `mempool  ${s.mempool.txs} tx`,
    `utxo     ${s.utxo.coins} coins · ${s.utxo.amount} tBTC5 · hash_serialized_3 ${s.utxo.hashSerialized3}`,
    `epochs   last sealed ${s.epochs.lastSealed ? `${s.epochs.lastSealed.epoch} (${s.epochs.lastSealed.from}–${s.epochs.lastSealed.to})` : 'none'} · next period ends at ${s.epochs.nextPeriodEnd}, ${s.epochs.blocksToGo} blocks to go`,
  ];
  if (s.store) lines.push(`store    ${s.store.blocks} blocks · ${(s.store.bytes / 1e6).toFixed(2)} MB`);
  return lines.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
  const api = arg('--api', 'http://127.0.0.1:3497').replace(/\/$/, ''), every = Number(arg('--watch', 0)), json = process.argv.includes('--json');
  const once = async () => {
    let s; try { const r = await fetch(`${api}/status`); if (!r.ok) throw new Error(`HTTP ${r.status}`); s = await r.json(); }
    catch (e) { console.error(`no status from ${api}: ${e.message}`); if (!every) process.exit(1); return; }
    if (every && process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
    console.log(json ? JSON.stringify(s, null, 2) : render(s));
  };
  await once();
  if (every > 0) setInterval(once, every * 1000);
}
