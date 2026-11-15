// The block file: what goes in comes back in order, a reorg truncates at the fork, and a record torn by
// a crash mid-write is cut off on the next load instead of corrupting what follows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlockFile } from '../src/store.js';

const blocks = [Buffer.from('aa'.repeat(81), 'hex'), Buffer.from('bb'.repeat(200), 'hex'), Buffer.from('cc'.repeat(90), 'hex')];
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), 't5store-')); return { dir, path: join(dir, 'blocks.bin') }; };

test('append, close, load gives the same blocks in order', () => {
  const { dir, path } = fresh();
  try {
    const a = new BlockFile(path); assert.deepEqual(a.load(), []);
    for (const b of blocks) a.append(b);
    a.close();
    const back = new BlockFile(path).load();
    assert.equal(back.length, 3);
    back.forEach((b, i) => assert.ok(b.equals(blocks[i])));
    assert.equal(statSync(path).size, blocks.reduce((s, b) => s + 4 + b.length, 0));
  } finally { rmSync(dir, { recursive: true }); }
});

test('truncate keeps blocks 0..height, and appending carries on from there', () => {
  const { dir, path } = fresh();
  try {
    const a = new BlockFile(path); a.load();
    for (const b of blocks) a.append(b);
    a.truncate(0);
    a.append(blocks[2]);
    a.close();
    const back = new BlockFile(path).load();
    assert.equal(back.length, 2);
    assert.ok(back[0].equals(blocks[0]) && back[1].equals(blocks[2]));
  } finally { rmSync(dir, { recursive: true }); }
});

test('a torn last record is cut off on load', () => {
  const { dir, path } = fresh();
  try {
    const a = new BlockFile(path); a.load();
    a.append(blocks[0]); a.append(blocks[1]); a.close();
    const whole = statSync(path).size;
    appendFileSync(path, Buffer.from([0x50, 0, 0, 0, 1, 2, 3])); // claims 80 bytes, has 3
    const b = new BlockFile(path);
    assert.equal(b.load().length, 2);
    assert.equal(statSync(path).size, whole);
    b.append(blocks[2]); b.close();
    assert.equal(new BlockFile(path).load().length, 3);
  } finally { rmSync(dir, { recursive: true }); }
});
