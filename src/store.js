// Blocks on disk for the Node node: one append-only file, each block as a 4-byte little-endian length
// then its raw bytes (with witness), the same format as the epoch files. Only validated blocks are
// written; on start they are read back and validated again, so the file is a cache, not a trust anchor.
// A reorg truncates the file at the fork. Writes are synchronous so the file never runs ahead of the chain.
import { openSync, readFileSync, writeSync, ftruncateSync, fsyncSync, closeSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export class BlockFile {
  constructor(path) {
    this.path = path;
    this.ends = []; // height -> byte offset just past that block
  }

  // -> raw blocks (Buffers), height order. A torn last record (crash mid-write) is cut off.
  load() {
    mkdirSync(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) { this.fd = openSync(this.path, 'w+'); return []; }
    const buf = readFileSync(this.path), out = [];
    let at = 0;
    while (at + 4 <= buf.length) {
      const n = buf.readUInt32LE(at);
      if (at + 4 + n > buf.length) break;
      out.push(buf.subarray(at + 4, at + 4 + n));
      at += 4 + n; this.ends.push(at);
    }
    this.fd = openSync(this.path, 'r+');
    if (at < buf.length) ftruncateSync(this.fd, at);
    return out;
  }

  get size() { return this.ends.at(-1) ?? 0; }

  append(raw) {
    const rec = Buffer.alloc(4 + raw.length);
    rec.writeUInt32LE(raw.length); raw.copy(rec, 4);
    writeSync(this.fd, rec, 0, rec.length, this.size);
    this.ends.push(this.size + rec.length);
  }

  // keep blocks 0..height
  truncate(height) {
    this.ends.length = Math.max(0, height + 1);
    ftruncateSync(this.fd, this.size);
  }

  // drop everything from `height` on (a stored block that no longer validates)
  dropFrom(height) { this.truncate(height - 1); }

  sync() { fsyncSync(this.fd); }
  close() { try { fsyncSync(this.fd); closeSync(this.fd); } catch {} }
  bytes() { return existsSync(this.path) ? statSync(this.path).size : 0; }
}
