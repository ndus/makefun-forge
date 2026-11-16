import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, type Repository } from './store.ts';
import { makePack, readPack, reachable } from './git-pack.ts';
const ZERO = '0'.repeat(40);
const FLUSH = Buffer.from('0000');
export function pkt(data: string | Buffer): Buffer {
  const b = Buffer.from(data); if (b.length > 65516) throw new Error('Packet too large');
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]);
}
export function packets(body: Buffer, stopAtFlush = false) {
  const lines: string[] = []; let offset = 0;
  while (offset < body.length) {
    const header = body.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('Invalid pkt-line');
    const size = parseInt(header, 16); offset += 4;
    if (size <= 2) { if (size === 0 && stopAtFlush) return { lines, offset }; continue; }
    if (size < 4 || size > 65520 || offset + size - 4 > body.length) throw new Error('Truncated pkt-line');
    lines.push(body.toString('utf8', offset, offset + size - 4).replace(/\n$/, '')); offset += size - 4;
  }
  if (stopAtFlush) throw new Error('Missing command flush');
  return { lines, offset };
}
function band(data: Buffer) {
  const chunks: Buffer[] = [];
  for (let i = 0; i < data.length; i += 65515) chunks.push(pkt(Buffer.concat([Buffer.from([1]), data.subarray(i, i + 65515)])));
  return Buffer.concat([...chunks, FLUSH]);
}
function peel(repo: Repository, id: string): string {
  const seen = new Set<string>();
  while (repo.git.get(id).type === 'tag') {
    if (seen.has(id)) throw new Error('Tag cycle'); seen.add(id);
    const m = /^object ([a-f0-9]{40})\n/.exec(repo.git.get(id).payload.toString());
    if (!m) throw new Error('Invalid tag'); id = m[1];
  }
  return id;
}
function refs(repo: Repository): [string, string][] {
  const head = repo.git.refs.get(`refs/heads/${repo.default_branch}`);
  return [...(head ? [['HEAD', head] as [string, string]] : []), ...[...repo.git.refs].sort(([a], [b]) => a.localeCompare(b))];
}
function advertisement(repo: Repository, service: string, v2: boolean) {
  if (v2) return Buffer.concat(['version 2\n', 'agent=forge/2\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'].map(pkt).concat(FLUSH));
  const caps = service === 'git-receive-pack' ? 'report-status side-band-64k delete-refs ofs-delta object-format=sha1 agent=forge/2' : `side-band-64k ofs-delta shallow symref=HEAD:refs/heads/${repo.default_branch} agent=forge/2`;
  const entries = refs(repo); if (!entries.length) entries.push(['capabilities^{}', ZERO]);
  const lines = entries.map(([name, id], i) => pkt(`${id} ${name}${i === 0 ? '\0' + caps : ''}\n`));
  if (service === 'git-upload-pack') for (const [name, id] of entries) if (id !== ZERO && repo.git.get(id).type === 'tag') lines.push(pkt(`${peel(repo, id)} ${name}^{}\n`));
  return Buffer.concat([pkt(`# service=${service}\n`), FLUSH, ...lines, FLUSH]);
}
function upload(repo: Repository, body: Buffer) {
  const { lines } = packets(body), v2 = lines.some(l => l.startsWith('command='));
  if (lines.includes('command=ls-refs')) {
    const prefixes = lines.filter(l => l.startsWith('ref-prefix ')).map(l => l.slice(11));
    const entries = refs(repo), head = `refs/heads/${repo.default_branch}`;
    if (!repo.git.refs.has(head) && lines.includes('unborn')) entries.unshift(['HEAD', 'unborn']);
    return Buffer.concat([...entries.filter(([name]) => !prefixes.length || prefixes.some(p => name.startsWith(p))).map(([name, id]) => {
      const extra = name === 'HEAD' && lines.includes('symrefs') ? ` symref-target:${head}` : '';
      const peeled = id !== 'unborn' && lines.includes('peel') && repo.git.get(id).type === 'tag' ? ` peeled:${peel(repo, id)}` : '';
      return pkt(`${id} ${name}${extra}${peeled}\n`);
    }), FLUSH]);
  }
  if (v2 && !lines.includes('command=fetch')) throw new Error('Unknown command');
  const ids = (prefix: string) => lines.filter(l => l.startsWith(prefix)).map(l => {
    const id = l.slice(prefix.length).split(' ')[0]; if (!/^[a-f0-9]{40}$/.test(id)) throw new Error('Invalid object id'); return id;
  });
  const wants = ids('want '), haves = ids('have ').filter(id => repo.git.objects.has(id)), oldShallow = ids('shallow ');
  const depthLine = lines.find(l => l.startsWith('deepen '));
  const depth = depthLine ? Number(depthLine.slice(7)) : Infinity;
  if (!(depth > 0) || (depthLine && !Number.isSafeInteger(depth))) throw new Error('Invalid depth');
  if (!lines.includes('done')) return Buffer.concat([...(v2 ? [pkt('acknowledgments\n')] : []), pkt('NAK\n'), FLUSH]);
  // Shallow clients do not possess the ancestors beyond their boundary.
  const excluded = oldShallow.length ? new Set<string>() : reachable(repo.git, haves).objects;
  const selected = reachable(repo.git, wants, depth);
  const chunks: Buffer[] = [];
  if (depthLine || oldShallow.length) {
    if (v2) chunks.push(pkt('shallow-info\n'));
    for (const id of selected.shallow) chunks.push(pkt(`shallow ${id}\n`));
    for (const id of oldShallow) if (selected.objects.has(id) && !selected.shallow.has(id)) chunks.push(pkt(`unshallow ${id}\n`));
    chunks.push(Buffer.from(v2 ? '0001' : '0000'));
  }
  chunks.push(pkt(v2 ? 'packfile\n' : 'NAK\n'));
  const pack = makePack(repo.git, [...selected.objects].filter(id => !excluded.has(id)));
  chunks.push(v2 || lines.some(l => l.includes('side-band-64k')) ? band(pack) : pack);
  return Buffer.concat(chunks);
}
function receive(repo: Repository, body: Buffer) {
  const { lines, offset } = packets(body, true);
  const caps = lines[0]?.split('\0')[1]?.split(' ') ?? [];
  const commands = lines.map(line => {
    const m = /^([a-f0-9]{40}) ([a-f0-9]{40}) (refs\/[^\0\s]+)(?:\0.*)?$/.exec(line);
    if (!m) throw new Error('Invalid ref command'); return { old: m[1], next: m[2], ref: m[3] };
  });
  let unpack = 'ok', imported = repo.git;
  try { imported = readPack(body.subarray(offset), repo.git); }
  catch { unpack = 'invalid pack'; }
  const report = [pkt(`unpack ${unpack}\n`)];
  const seen = new Set<string>();
  for (const c of commands) {
    let reason = unpack !== 'ok' ? 'unpacker error' : '';
    if (!reason && (/[\x00-\x20\x7f~^:?*\[\\]|\.\.|@\{|\/\/|\/$|\.$/.test(c.ref) || c.ref.split('/').some(s => s.startsWith('.') || s.endsWith('.lock')) || seen.has(c.ref))) reason = 'invalid ref';
    seen.add(c.ref);
    if (!reason && (repo.git.refs.get(c.ref) ?? ZERO) !== c.old) reason = 'stale old oid';
    if (!reason && c.next !== ZERO) {
      try {
        reachable(imported, [c.next]);
        if (c.ref.startsWith('refs/heads/') && imported.get(c.next).type !== 'commit') reason = 'not a commit';
        if (c.old !== ZERO && c.old !== c.next && (imported.get(c.next).type !== 'commit' || imported.get(c.old).type !== 'commit' || !imported.history(c.next).includes(c.old))) reason = 'non-fast-forward';
      } catch { reason = 'missing or invalid object'; }
    }
    if (!reason) {
      repo.git.objects = imported.objects;
      if (c.next === ZERO) repo.git.refs.delete(c.ref); else repo.git.refs.set(c.ref, c.next);
    }
    report.push(pkt(reason ? `ng ${c.ref} ${reason}\n` : `ok ${c.ref}\n`));
  }
  const result = Buffer.concat([...report, FLUSH]);
  return caps.includes('side-band-64k') ? band(result) : result;
}
export async function gitHttp(req: IncomingMessage, res: ServerResponse, repo: Repository, service: string, advertise: boolean) {
  if (!['git-upload-pack', 'git-receive-pack'].includes(service)) throw new HttpError(404, 'Not Found');
  let result: Buffer;
  try {
    if (advertise) result = advertisement(repo, service, service === 'git-upload-pack' && String(req.headers['git-protocol']).split(':').includes('version=2'));
    else {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024 * 1024) throw new Error('Request too large'); chunks.push(Buffer.from(chunk)); }
      result = service === 'git-upload-pack' ? upload(repo, Buffer.concat(chunks)) : receive(repo, Buffer.concat(chunks));
    }
  } catch { throw new HttpError(400, 'Malformed git request'); }
  res.setHeader('content-type', `application/x-${service}-${advertise ? 'advertisement' : 'result'}`);
  res.setHeader('cache-control', 'no-cache'); res.end(result);
}
