import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { GitStore, type GitObject, type ObjectType } from './git-store.ts';
const types: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const limit = 64 * 1024 * 1024;
const hash = (b: Buffer) => createHash('sha1').update(b).digest();

export function reachable(store: GitStore, roots: string[], depth = Infinity, stops = new Set<string>()) {
  const objects = new Set<string>(), shallow = new Set<string>();
  const queue: [string, number][] = roots.map(id => [id, 1]);
  for (let i = 0; i < queue.length; i++) {
    const [id, level] = queue[i];
    if (objects.has(id) || stops.has(id)) continue;
    const o = store.get(id); objects.add(id);
    if (o.type === 'commit') {
      const c = store.commit(id); queue.push([c.tree, level]);
      if (level >= depth && c.parents.length) shallow.add(id);
      else for (const p of c.parents) queue.push([p, level + 1]);
    } else if (o.type === 'tree') {
      for (const e of store.readTree(id)) if (e.mode !== '160000') queue.push([e.sha, level]);
    } else if (o.type === 'tag') {
      const target = /^object ([a-f0-9]{40})\n/.exec(o.payload.toString());
      if (!target) throw new Error('Invalid tag');
      queue.push([target[1], level]);
    }
  }
  return { objects, shallow };
}
export function makePack(store: GitStore, ids: Iterable<string>): Buffer {
  const entries = [...ids], header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(entries.length, 8);
  const chunks = [header];
  for (const id of entries) {
    const o = store.get(id); let size = o.payload.length;
    const bytes = [(Number(Object.keys(types).find(k => types[Number(k)] === o.type)) << 4) | (size % 16)]; size = Math.floor(size / 16);
    while (size) { bytes[bytes.length - 1] |= 128; bytes.push(size % 128); size = Math.floor(size / 128); }
    chunks.push(Buffer.from(bytes), deflateSync(o.payload));
  }
  const body = Buffer.concat(chunks); return Buffer.concat([body, hash(body)]);
}
function delta(base: Buffer, data: Buffer): Buffer {
  let p = 0;
  const byte = () => { if (p >= data.length) throw new Error('Truncated delta'); return data[p++]; };
  const variable = () => { let n = 0, factor = 1, b; do { b = byte(); n += (b & 127) * factor; factor *= 128; if (!Number.isSafeInteger(n) || factor > 2 ** 56) throw new Error('Invalid delta size'); } while (b & 128); return n; };
  if (variable() !== base.length) throw new Error('Delta base size mismatch');
  const size = variable(); if (size > limit) throw new Error('Delta too large');
  const out = Buffer.alloc(size); let written = 0;
  while (p < data.length) {
    const op = byte(); let chunk: Buffer;
    if (op & 128) {
      let offset = 0, length = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) offset += byte() * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (16 << i)) length += byte() * 2 ** (8 * i);
      length ||= 65536;
      if (offset + length > base.length) throw new Error('Delta copy out of bounds');
      chunk = base.subarray(offset, offset + length);
    } else {
      if (!op || p + op > data.length) throw new Error('Invalid delta literal');
      chunk = data.subarray(p, p + op); p += op;
    }
    if (written + chunk.length > size) throw new Error('Delta output overflow');
    chunk.copy(out, written); written += chunk.length;
  }
  if (written !== size) throw new Error('Delta output size mismatch');
  return out;
}
/** Resolve both offset and reference deltas, including thin bases already in the store. */
export function readPack(pack: Buffer, existing: GitStore): GitStore {
  const result = new GitStore(); result.objects = new Map(existing.objects);
  if (!pack.length) return result;
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK' || ![2, 3].includes(pack.readUInt32BE(4))) throw new Error('Invalid pack header');
  const end = pack.length - 20;
  if (!hash(pack.subarray(0, end)).equals(pack.subarray(end))) throw new Error('Pack checksum mismatch');
  const count = pack.readUInt32BE(8); if (count > 1000000) throw new Error('Too many objects');
  let p = 12, total = 0;
  const byte = () => { if (p >= end) throw new Error('Truncated pack'); return pack[p++]; };
  const entries: { offset: number; type: number; data: Buffer; base?: number | string; object?: GitObject }[] = [];
  for (let i = 0; i < count; i++) {
    const offset = p; let b = byte(), size = b & 15, factor = 16; const type = (b >> 4) & 7;
    while (b & 128) { b = byte(); size += (b & 127) * factor; factor *= 128; if (size > limit || factor > 2 ** 56) throw new Error('Object too large'); }
    let base: number | string | undefined;
    if (type === 6) { b = byte(); let distance = b & 127; while (b & 128) { b = byte(); distance = (distance + 1) * 128 + (b & 127); if (distance > offset) throw new Error('Invalid delta offset'); } base = offset - distance; }
    else if (type === 7) { if (p + 20 > end) throw new Error('Truncated base'); base = pack.subarray(p, p + 20).toString('hex'); p += 20; }
    else if (!types[type]) throw new Error('Invalid object type');
    const inflated = inflateSync(pack.subarray(p, end), { info: true, maxOutputLength: limit }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    p += inflated.engine.bytesWritten;
    if (inflated.buffer.length !== size) throw new Error('Object size mismatch');
    total += size; if (total > 256 * 1024 * 1024) throw new Error('Pack too large');
    entries.push({ offset, type, data: inflated.buffer, base });
  }
  if (p !== end) throw new Error('Trailing pack data');
  const offsets = new Map(entries.map(e => [e.offset, e]));
  let pending = entries.length, resolvedBytes = 0;
  while (pending) {
    let progress = 0;
    for (const e of entries) {
      if (e.object) continue;
      const base = typeof e.base === 'string' ? result.objects.get(e.base) : typeof e.base === 'number' ? offsets.get(e.base)?.object : undefined;
      if (e.base !== undefined && !base) continue;
      e.object = base ? { type: base.type, payload: delta(base.payload, e.data) } : { type: types[e.type], payload: e.data };
      resolvedBytes += e.object.payload.length;
      if (resolvedBytes > 256 * 1024 * 1024) throw new Error('Resolved pack too large');
      result.put(e.object.type, e.object.payload); progress++; pending--;
    }
    if (!progress) throw new Error('Unresolved delta base');
  }
  return result;
}
