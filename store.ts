import { GitStore, type Files } from './git-store.ts';
import { viewer } from './identity.ts';

export class HttpError extends Error {
  status: number;
  errors?: { resource: string; code: string; field: string; message: string }[];
  constructor(status: number, message: string, errors?: HttpError['errors']) {
    super(message); this.status = status; this.errors = errors;
  }
}
export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(422, `${field} is required`);
  return value;
}
export interface Label { id: number; name: string; color: string }
export interface Comment { id: number; body: string; user: typeof viewer; created_at: string }
export interface Issue {
  id: number; node_id: string; number: number; title: string; body: string;
  state: string; labels: Label[]; user: typeof viewer; created_at: string; updated_at: string;
  closed_at: string | null; comments: number;
}
export interface Pull extends Issue {
  head: { ref: string; sha: string }; base: { ref: string; sha: string };
  merged: boolean; merged_at: string | null; merge_commit_sha: string | null;
}
export class Repository {
  id: number;
  name: string;
  description = '';
  private = false;
  default_branch = 'main';
  git = new GitStore();
  labels = new Map<string, Label>();
  issues = new Map<number, Issue>();
  pulls = new Map<number, Pull>();
  comments = new Map<number, Comment[]>();
  nextNumber = 1;
  created_at: string;
  constructor(id: number, name: string, date: string) { this.id = id; this.name = name; this.created_at = date; }
  tip(branch = this.default_branch) { return this.git.resolve(branch); }
}

/** Shared domain state for REST and future git, GraphQL and MCP adapters. */
export class ForgeStore {
  repos = new Map<string, Repository>();
  nextId = 1;
  private tick = 0;
  // Stable, increasing timestamps keep replay commits and creation ordering reproducible.
  now(): string { return new Date((1735689600 + this.tick++) * 1000).toISOString(); }
  repo(owner: string, name: string): Repository {
    const repo = owner === viewer.login ? this.repos.get(name) : undefined;
    if (!repo) throw new HttpError(404, 'Not Found');
    return repo;
  }
  createRepo(body: Record<string, unknown>): Repository {
    const name = requireString(body.name, 'name');
    if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..') throw new HttpError(422, 'Invalid repository name');
    if (this.repos.has(name)) throw new HttpError(422, 'Validation Failed', [
      { resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' },
    ]);
    const repo = new Repository(this.nextId++, name, this.now());
    repo.description = typeof body.description === 'string' ? body.description : '';
    repo.private = body.private === true;
    if (typeof body.default_branch === 'string') repo.default_branch = requireString(body.default_branch, 'default_branch');
    this.repos.set(name, repo);
    return repo;
  }
  repositoryJson(repo: Repository, origin: string) {
    const full = `${viewer.login}/${repo.name}`, url = `${origin}/api/v3/repos/${full}`;
    return { id: repo.id, node_id: `R_${repo.id}`, name: repo.name, full_name: full, owner: viewer,
      private: repo.private, description: repo.description, default_branch: repo.default_branch,
      url, html_url: `${origin}/${full}`, clone_url: `${origin}/${full}.git`, git_url: `${origin}/${full}.git`,
      fork: false, archived: false, has_issues: true, created_at: repo.created_at, permissions: { admin: true, push: true, pull: true } };
  }
  commit(repo: Repository, branch: string, files: Files, message: string): string {
    const parent = repo.tip(branch);
    const sha = repo.git.createCommit(files, parent ? [parent] : [], message, `${viewer.name} <${viewer.email}>`, Date.parse(this.now()) / 1000);
    repo.git.refs.set(`refs/heads/${branch}`, sha);
    return sha;
  }
  issue(repo: Repository, body: Record<string, unknown>): Issue {
    const title = requireString(body.title, 'title');
    if (body.labels !== undefined && !Array.isArray(body.labels)) throw new HttpError(422, 'labels must be an array');
    const labels = ((body.labels ?? []) as unknown[]).map(name => {
      const label = typeof name === 'string' ? repo.labels.get(name) : undefined;
      if (!label) throw new HttpError(422, 'Unknown label');
      return label;
    });
    const id = this.nextId++, date = this.now();
    return { id, node_id: `I_${id}`, number: repo.nextNumber++, title, body: typeof body.body === 'string' ? body.body : '',
      state: 'open', labels, user: viewer, created_at: date, updated_at: date, closed_at: null, comments: 0 };
  }
  pull(repo: Repository, body: Record<string, unknown>): Pull {
    const head = requireString(body.head, 'head').replace(`${viewer.login}:`, ''), base = requireString(body.base, 'base');
    const headSha = repo.tip(head), baseSha = repo.tip(base);
    if (!headSha || !baseSha || head === base) throw new HttpError(422, 'Invalid head or base branch');
    const issue = this.issue(repo, body);
    const pull: Pull = { ...issue, node_id: `PR_${issue.id}`, head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha }, merged: false, merged_at: null, merge_commit_sha: null };
    repo.pulls.set(pull.number, pull);
    return pull;
  }
  refreshPull(repo: Repository, pull: Pull): Pull {
    if (!pull.merged) {
      pull.head.sha = repo.tip(pull.head.ref) ?? pull.head.sha;
      pull.base.sha = repo.tip(pull.base.ref) ?? pull.base.sha;
    }
    return pull;
  }
  mergePull(repo: Repository, pull: Pull): string {
    if (pull.state !== 'open') throw new HttpError(405, 'Pull request is not open');
    this.refreshPull(repo, pull);
    const files = repo.git.merge(pull.base.sha, pull.head.sha);
    if (!files) throw new HttpError(405, 'Pull request is conflicted');
    const sha = this.commit(repo, pull.base.ref, files, `${pull.title} (#${pull.number})`);
    pull.state = 'closed'; pull.merged = true; pull.merge_commit_sha = sha;
    pull.merged_at = pull.closed_at = pull.updated_at = this.now();
    return sha;
  }
  pullFiles(repo: Repository, pull: Pull) {
    this.refreshPull(repo, pull);
    const old = repo.git.files(repo.git.mergeBase(pull.base.sha, pull.head.sha)), head = repo.git.files(pull.head.sha);
    const lines = (sha?: string) => sha ? repo.git.get(sha, 'blob').payload.toString('utf8').split('\n').filter((s, i, a) => i < a.length - 1 || s !== '') : [];
    return [...new Set([...old.keys(), ...head.keys()])].sort().filter(path => old.get(path)?.sha !== head.get(path)?.sha).map(filename => {
      const before = old.get(filename), after = head.get(filename);
      const a = lines(before?.sha), b = lines(after?.sha);
      let prefix = 0, suffix = 0;
      while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++;
      while (suffix < Math.min(a.length, b.length) - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
      const additions = b.length - prefix - suffix, deletions = a.length - prefix - suffix;
      return { filename, sha: after?.sha ?? before!.sha, status: !before ? 'added' : !after ? 'removed' : 'modified', additions, deletions, changes: additions + deletions };
    });
  }
}
