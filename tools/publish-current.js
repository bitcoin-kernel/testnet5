#!/usr/bin/env node
// Publish the open epoch: every block after the last sealed epoch file, as one file in the same format
// (u32le length + raw block), plus a small JSON describing it, to an R2 bucket. The browser node fetches
// these two after the sealed files, so it reaches the tip with one request to our bucket instead of one
// per block to anyone's server. Uploads only when the tip has moved.
//
//   node tools/publish-current.js [--every 600] [--once] [--rpc …] [--cookie …]
//
// R2 keys come from ~/.aws/credentials [r2] and are never printed. Bucket and paths below.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const RPC = arg('--rpc', 'http://127.0.0.1:18352');
const COOKIE = arg('--cookie', `${process.env.HOME}/testnet5-rehearsal/data/testnet5/.cookie`);
const EVERY = Number(arg('--every', 600));
const ENDPOINT = 'https://d705ea401fbfa0d91735b26b0d1aa69d.r2.cloudflarestorage.com/assumeutxo';
const PREFIX = 'testnet5/';
export const PUBLIC = 'https://pub-8cae8bad22cf4f44b22188af9b1c0064.r2.dev/testnet5/';
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

async function rpcBatch(calls) {
  const auth = 'Basic ' + Buffer.from((await readFile(COOKIE, 'utf8')).trim()).toString('base64'); // re-read: it changes on restart
  const r = await fetch(RPC, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(calls.map(([method, params], id) => ({ jsonrpc: '1.0', id, method, params }))) });
  return (await r.json()).sort((a, b) => a.id - b.id).map((x) => { if (x.error) throw new Error(x.error.message); return x.result; });
}

async function r2Keys() {
  const text = await readFile(`${process.env.HOME}/.aws/credentials`, 'utf8');
  const section = text.split(/^\[/m).find((s) => s.startsWith('r2]')) ?? '';
  const get = (k) => (section.match(new RegExp(`^${k}\\s*=\\s*(\\S+)`, 'm')) ?? [])[1];
  return { key: get('aws_access_key_id'), secret: get('aws_secret_access_key') };
}

async function put(name, body, type, { key, secret }) {
  // curl reads the credentials from argv of a child process (not a shell), and the body from stdin
  const child = execFile('curl', ['-sS', '--fail', '--aws-sigv4', 'aws:amz:auto:s3', '--user', `${key}:${secret}`, '-X', 'PUT',
    '-H', `Content-Type: ${type}`, '-H', 'Cache-Control: public, max-age=60', '--data-binary', '@-', `${ENDPOINT}/${PREFIX}${name}`]);
  const done = new Promise((resolve, reject) => {
    let err = ''; child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`upload ${name} failed (${code}): ${err.trim().slice(0, 200)}`)));
  });
  child.stdin.end(body);
  await done;
}

let lastTip = null;
async function once() {
  const sealedIndex = JSON.parse(await readFile(new URL('../epochs/index.json', import.meta.url), 'utf8'));
  const from = (sealedIndex.epochs.at(-1)?.to ?? -1) + 1;
  const [tip] = await rpcBatch([['getblockcount', []]]);
  const [tipHash] = await rpcBatch([['getblockhash', [tip]]]);
  if (tipHash === lastTip) return;
  if (tip < from) { log(`tip ${tip} is inside the sealed files; nothing to publish`); lastTip = tipHash; return; }
  const hashes = await rpcBatch(Array.from({ length: tip - from + 1 }, (_, i) => ['getblockhash', [from + i]]));
  const raws = await rpcBatch(hashes.map((h) => ['getblock', [h, 0]]));
  const parts = [];
  for (const hex of raws) { const b = Buffer.from(hex, 'hex'); const len = Buffer.alloc(4); len.writeUInt32LE(b.length); parts.push(len, b); }
  const file = Buffer.concat(parts);
  const meta = { network: 'testnet5', format: 'u32le length + raw block, repeated', file: 'current.bin', from, to: tip,
    lastHash: hashes.at(-1), bytes: file.length, sha256: createHash('sha256').update(file).digest('hex'), built: new Date().toISOString() };
  const keys = await r2Keys();
  if (!keys.key || !keys.secret) throw new Error('no [r2] keys in ~/.aws/credentials');
  await put('current.bin', file, 'application/octet-stream', keys); // the data first, then the pointer to it
  await put('current.json', JSON.stringify(meta, null, 2) + '\n', 'application/json', keys);
  lastTip = tipHash;
  log(`published blocks ${from}..${tip} (${file.length} bytes, ${meta.sha256.slice(0, 12)}…)`);
}

const loop = async () => { try { await once(); } catch (e) { log(`error: ${e.message}`); } };
await loop();
if (!process.argv.includes('--once')) setInterval(loop, EVERY * 1000);
