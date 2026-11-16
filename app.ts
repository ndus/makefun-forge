import { createServer, type IncomingMessage } from 'node:http';
import { ForgeStore, HttpError, requireString } from './store.ts';
import { viewer } from './identity.ts';

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw new HttpError(413, 'Request body too large');
    chunks.push(Buffer.from(chunk));
  }
  if (!size) return {};
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Malformed JSON body'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object');
  return body as Record<string, unknown>;
}

export function createApp(store = new ForgeStore(), token = process.env.MAKEFUN_SHOP_TOKEN ?? '') {
  let requestId = 0;
  return createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('x-github-request-id', (++requestId).toString(16).padStart(12, '0'));
    const send = (status: number, body?: unknown) => {
      res.statusCode = status;
      res.end(status === 204 ? undefined : `${JSON.stringify(body)}\n`);
    };
    try {
      const origin = `http://${req.headers.host ?? 'localhost'}`;
      const url = new URL(req.url ?? '/', origin);
      const method = req.method ?? 'GET';
      // Harness boot probe is outside the four authenticated application surfaces.
      if (url.pathname === '/healthz' && method === 'GET') return send(200, { ok: true });
      if (!token || req.headers.authorization !== `Bearer ${token}`) throw new HttpError(401, 'Bad credentials');
      const body = await readBody(req);
      let parts: string[];
      try { parts = url.pathname.split('/').slice(1).map(decodeURIComponent); }
      catch { throw new HttpError(400, 'Invalid URL encoding'); }
      const route = parts.join('/').replace(/\/$/, '');
      const page = <T>(items: T[]) => {
        const positive = (value: string | null, fallback: number) => value && /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : fallback;
        const perPage = Math.min(100, positive(url.searchParams.get('per_page'), 30)), current = positive(url.searchParams.get('page'), 1);
        if (current * perPage < items.length) {
          const next = new URL(url); next.searchParams.set('page', String(current + 1));
          res.setHeader('link', `<${next}>; rel="next"`);
        }
        return items.slice((current - 1) * perPage, current * perPage);
      };
      if (route === 'api/v3' && method === 'GET') {
        res.setHeader('x-oauth-scopes', 'repo, read:org');
        return send(200, { current_user_url: `${origin}/api/v3/user` });
      }
      if (route === 'api/v3/meta' && method === 'GET') return send(200, { installed_version: '1.0.0' });
      if (route === 'api/v3/user' && method === 'GET') return send(200, viewer);
      if (route === 'api/v3/user/repos') {
        if (method === 'POST') return send(201, store.repositoryJson(store.createRepo(body), origin));
        if (method === 'GET') return send(200, page([...store.repos.values()].map(repo => store.repositoryJson(repo, origin))));
      }
      if (parts[0] !== 'api' || parts[1] !== 'v3' || parts[2] !== 'repos' || !parts[3] || !parts[4]) throw new HttpError(404, 'Not Found');
      const repo = store.repo(parts[3], parts[4]);
      const tail = parts.slice(5), resource = tail.join('/').replace(/\/$/, '');
      if (!resource) {
        if (method === 'GET') return send(200, store.repositoryJson(repo, origin));
        if (method === 'PATCH') {
          if (body.description !== undefined) {
            if (typeof body.description !== 'string' && body.description !== null) throw new HttpError(422, 'Invalid description');
            repo.description = body.description ?? '';
          }
          return send(200, store.repositoryJson(repo, origin));
        }
        if (method === 'DELETE') { store.repos.delete(repo.name); return send(204); }
      }
      if (resource === 'git/refs' && method === 'POST') {
        const ref = requireString(body.ref, 'ref'), sha = requireString(body.sha, 'sha');
        if (!ref.startsWith('refs/heads/') || /[\s~^:?*\[\\]|\.\.|@\{|\/\/|\/$|\.$/.test(ref) || repo.git.refs.has(ref) || repo.git.objects.get(sha)?.type !== 'commit') throw new HttpError(422, 'Invalid or existing ref');
        repo.git.refs.set(ref, sha);
        return send(201, { ref, object: { type: 'commit', sha } });
      }
      if (resource === 'branches' && method === 'GET') return send(200, page([...repo.git.refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, sha]) => ({ name: ref.slice(11), commit: { sha }, protected: false }))));
      if (resource === 'commits' && method === 'GET') {
        const ref = url.searchParams.get('sha') ?? repo.default_branch, tip = repo.tip(ref);
        if (!tip && ref !== repo.default_branch) throw new HttpError(404, 'Unknown ref');
        return send(200, page(repo.git.history(tip).map(sha => ({ sha, commit: { message: repo.git.commit(sha).message, tree: { sha: repo.git.commit(sha).tree } }, parents: repo.git.commit(sha).parents.map(sha => ({ sha })) }))));
      }
      if (tail[0] === 'contents' && ['GET', 'PUT', 'DELETE'].includes(method)) {
        const path = tail.slice(1).join('/').replace(/\/$/, '');
        if (path.split('/').some(p => p === '.' || p === '..' || p.includes('\0')) || path.includes('//')) throw new HttpError(422, 'Invalid path');
        const branch = method === 'GET' ? url.searchParams.get('ref') ?? repo.default_branch : typeof body.branch === 'string' ? body.branch : repo.default_branch;
        const tip = repo.tip(branch);
        if (!tip && (branch !== repo.default_branch || repo.git.refs.size > 0 || method === 'GET')) throw new HttpError(404, 'Unknown ref');
        const files = repo.git.files(tip), old = files.get(path);
        const fileJson = (filePath: string, sha: string) => ({ type: 'file', name: filePath.split('/').pop(), path: filePath, sha, size: repo.git.get(sha, 'blob').payload.length, encoding: 'base64', content: repo.git.get(sha, 'blob').payload.toString('base64') });
        if (method === 'GET') {
          if (old) return send(200, fileJson(path, old.sha));
          let tree = repo.git.commit(tip!).tree;
          for (const name of path ? path.split('/') : []) {
            const entry = repo.git.readTree(tree).find(e => e.name === name && /^(0?40000)$/.test(e.mode));
            if (!entry) throw new HttpError(404, 'Not Found');
            tree = entry.sha;
          }
          return send(200, repo.git.readTree(tree).map(e => ({ type: /^(0?40000)$/.test(e.mode) ? 'dir' : 'file', name: e.name, path: path ? `${path}/${e.name}` : e.name, sha: e.sha })));
        }
        if (!path) throw new HttpError(422, 'File path required');
        const message = requireString(body.message, 'message');
        if (method === 'DELETE' && !old) throw new HttpError(404, 'Not Found');
        if (old ? body.sha !== old.sha : body.sha !== undefined) throw new HttpError(409, 'Content sha does not match');
        if (method === 'DELETE') {
          files.delete(path);
          return send(200, { content: null, commit: { sha: store.commit(repo, branch, files, message) } });
        }
        if (typeof body.content !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.content.replace(/\s/g, ''))) throw new HttpError(422, 'Invalid base64 content');
        for (const existing of files.keys()) if (existing.startsWith(`${path}/`) || path.startsWith(`${existing}/`)) throw new HttpError(422, 'File and directory path collision');
        const sha = repo.git.put('blob', Buffer.from(body.content, 'base64'));
        files.set(path, { mode: old?.mode ?? '100644', sha });
        return send(old ? 200 : 201, { content: fileJson(path, sha), commit: { sha: store.commit(repo, branch, files, message) } });
      }
      if (resource === 'labels' && method === 'POST') {
        const name = requireString(body.name, 'name');
        if (repo.labels.has(name)) throw new HttpError(422, 'Label already exists');
        const label = { id: store.nextId++, name, color: typeof body.color === 'string' ? body.color : 'ededed' };
        repo.labels.set(name, label); return send(201, label);
      }
      if (resource === 'issues' && method === 'POST') {
        const issue = store.issue(repo, body); repo.issues.set(issue.number, issue); return send(201, issue);
      }
      if ((resource === 'issues' || resource === 'pulls') && method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open', ascending = url.searchParams.get('direction') === 'asc';
        const items = resource === 'issues' ? [...repo.issues.values()] : [...repo.pulls.values()].map(p => store.refreshPull(repo, p));
        return send(200, page(items.filter(i => state === 'all' || i.state === state).sort((a, b) => ascending ? a.number - b.number : b.number - a.number)));
      }
      if (tail[0] === 'issues' && /^\d+$/.test(tail[1] ?? '')) {
        const issue = repo.issues.get(Number(tail[1]));
        if (!issue) throw new HttpError(404, 'Not Found');
        if (tail.length === 2) {
          if (method === 'GET') return send(200, issue);
          if (method === 'PATCH') {
            if (body.state !== undefined && body.state !== 'open' && body.state !== 'closed') throw new HttpError(422, 'Invalid state');
            if (body.title !== undefined) issue.title = requireString(body.title, 'title');
            if (typeof body.body === 'string') issue.body = body.body;
            if (typeof body.state === 'string') { issue.state = body.state; issue.closed_at = body.state === 'closed' ? store.now() : null; }
            issue.updated_at = store.now(); return send(200, issue);
          }
        }
        if (tail.length === 3 && tail[2] === 'comments') {
          const comments = repo.comments.get(issue.number) ?? [];
          if (method === 'GET') return send(200, page(comments));
          if (method === 'POST') {
            const comment = { id: store.nextId++, body: requireString(body.body, 'body'), user: viewer, created_at: store.now() };
            comments.push(comment); repo.comments.set(issue.number, comments); issue.comments = comments.length;
            return send(201, comment);
          }
        }
      }
      if (resource === 'pulls' && method === 'POST') return send(201, store.pull(repo, body));
      if (tail[0] === 'pulls' && /^\d+$/.test(tail[1] ?? '')) {
        const pull = repo.pulls.get(Number(tail[1]));
        if (!pull) throw new HttpError(404, 'Not Found');
        if (tail.length === 2 && method === 'GET') return send(200, store.refreshPull(repo, pull));
        if (tail.length === 3 && tail[2] === 'files' && method === 'GET') return send(200, page(store.pullFiles(repo, pull)));
        if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') return send(200, { sha: store.mergePull(repo, pull), merged: true, message: 'Pull Request successfully merged' });
      }
      throw new HttpError(404, 'Not Found');
    } catch (error) {
      if (!(error instanceof HttpError)) process.stderr.write(`[app] ${error instanceof Error ? error.stack : String(error)}\n`);
      send(error instanceof HttpError ? error.status : 500, { message: error instanceof HttpError ? error.message : 'Internal Server Error' });
    }
  });
}
