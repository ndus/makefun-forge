import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObject { type: ObjectType; payload: Buffer }
export interface TreeEntry { mode: string; name: string; sha: string }
export interface FileEntry { mode: string; sha: string }
export type Files = Map<string, FileEntry>;

/** Raw payloads are the source of truth, including for objects imported by future receive-pack. */
export class GitStore {
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>();

  put(type: ObjectType, payload: Buffer | string): string {
    const bytes = Buffer.from(payload);
    const sha = createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
    this.objects.set(sha, { type, payload: bytes });
    return sha;
  }
  get(sha: string, type?: ObjectType): GitObject {
    const object = this.objects.get(sha);
    if (!object || (type && object.type !== type)) throw new Error(`Missing ${type ?? 'object'} ${sha}`);
    return object;
  }
  loose(sha: string): Buffer {
    const { type, payload } = this.get(sha);
    return deflateSync(Buffer.concat([Buffer.from(`${type} ${payload.length}\0`), payload]));
  }
  resolve(ref: string): string | undefined {
    return this.refs.get(ref) ?? this.refs.get(`refs/heads/${ref}`) ?? (this.objects.get(ref)?.type === 'commit' ? ref : undefined);
  }
  tree(entries: TreeEntry[]): string {
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.mode === '40000' ? '/' : '')), Buffer.from(b.name + (b.mode === '40000' ? '/' : ''))));
    return this.put('tree', Buffer.concat(entries.flatMap(e => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, 'hex')])));
  }
  readTree(sha: string): TreeEntry[] {
    const cached = treeCache.get(this.get(sha, 'tree')); if (cached) return cached;
    const bytes = this.get(sha, 'tree').payload;
    const entries: TreeEntry[] = [];
    for (let offset = 0; offset < bytes.length;) {
      const space = bytes.indexOf(32, offset), nul = bytes.indexOf(0, space);
      if (space < 0 || nul < 0 || nul + 21 > bytes.length) throw new Error('Invalid tree');
      entries.push({ mode: bytes.toString('ascii', offset, space), name: bytes.toString('utf8', space + 1, nul), sha: bytes.subarray(nul + 1, nul + 21).toString('hex') });
      offset = nul + 21;
    }
    return cachePut(treeCache, this.get(sha), entries);
  }
  writeFiles(files: Files): string {
    const build = (prefix: string): string => {
      const entries: TreeEntry[] = [], dirs = new Set<string>();
      for (const [path, file] of files) {
        if (!path.startsWith(prefix)) continue;
        const relative = path.slice(prefix.length), slash = relative.indexOf('/');
        if (slash < 0) entries.push({ ...file, name: relative });
        else dirs.add(relative.slice(0, slash));
      }
      for (const name of dirs) entries.push({ name, mode: '40000', sha: build(`${prefix}${name}/`) });
      return this.tree(entries);
    };
    return build('');
  }
  commit(sha: string): { tree: string; parents: string[]; message: string } {
    const cached = commitCache.get(this.get(sha, 'commit')); if (cached) return cached;
    const text = this.get(sha, 'commit').payload.toString('utf8');
    const split = text.indexOf('\n\n'), headers = text.slice(0, split).split('\n');
    return cachePut(commitCache, this.get(sha), { tree: headers.find(h => h.startsWith('tree '))!.slice(5), parents: headers.filter(h => h.startsWith('parent ')).map(h => h.slice(7)), message: text.slice(split + 2).replace(/\n$/, '') });
  }
  files(commit?: string): Files {
    const files: Files = new Map();
    if (!commit) return files;
    const walk = (tree: string, prefix: string) => {
      for (const entry of this.readTree(tree)) {
        if (entry.mode === '40000' || entry.mode === '040000') walk(entry.sha, `${prefix}${entry.name}/`);
        else files.set(prefix + entry.name, { mode: entry.mode, sha: entry.sha });
      }
    };
    walk(this.commit(commit).tree, '');
    return files;
  }
  createCommit(files: Files, parents: string[], message: string, identity: string, epoch: number): string {
    const tree = this.writeFiles(files);
    return this.put('commit', [`tree ${tree}`, ...parents.map(p => `parent ${p}`), `author ${identity} ${epoch} +0000`, `committer ${identity} ${epoch} +0000`, '', message, ''].join('\n'));
  }
  history(start?: string): string[] {
    const seen = new Set<string>(), pending = start ? [start] : [];
    while (pending.length) {
      const sha = pending.shift()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      pending.push(...this.commit(sha).parents);
    }
    return [...seen];
  }
  mergeBase(a: string, b: string): string | undefined {
    const ancestors = new Set(this.history(a));
    return this.history(b).find(sha => ancestors.has(sha));
  }
  /** Three-way file merge: preserve independent paths; reject competing edits to one path. */
  merge(a: string, b: string): Files | undefined {
    const base = this.files(this.mergeBase(a, b)), ours = this.files(a), theirs = this.files(b);
    const result = new Map(ours);
    const equal = (x?: FileEntry, y?: FileEntry) => x?.sha === y?.sha && x?.mode === y?.mode;
    for (const path of new Set([...base.keys(), ...theirs.keys()])) {
      const old = base.get(path), head = theirs.get(path), current = ours.get(path);
      if (equal(old, head)) continue;
      if (!equal(current, old) && !equal(current, head)) return undefined;
      if (head) result.set(path, head); else result.delete(path);
    }
    for (const path of result.keys()) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) if (result.has(parts.slice(0, i).join('/'))) return undefined;
    }
    return result;
  }
}

// Shared across receive-pack staging stores, keyed by object identity rather than refs.
// At most 4096 small objects per cache; large payloads are deliberately not retained.
const treeCache = new Map<GitObject, TreeEntry[]>();
const commitCache = new Map<GitObject, { tree: string; parents: string[]; message: string }>();
function cachePut<T>(cache: Map<GitObject, T>, object: GitObject, value: T): T {
  if (object.payload.length <= 4096) {
    if (cache.size >= 4096) cache.delete(cache.keys().next().value!);
    cache.set(object, value);
  }
  return value;
}
