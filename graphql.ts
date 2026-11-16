import { ForgeStore, Repository, requireString, type Issue, type Pull } from './store.ts';
import { viewer } from './identity.ts';

type Field = { name: string; key: string; args: Record<string, any>; fields: Field[]; condition?: string };
// A bounded recursive-descent parser, not document-name matching. Values retain variable references.
class Parser {
  tokens: string[] = []; pos = 0;
  constructor(source: string) {
    const re = /\s+|#[^\n]*|,|\.\.\.|"(?:\\.|[^"\\])*"|[_A-Za-z][_0-9A-Za-z]*|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?|[!$():={}\[\]@]/gy;
    while (re.lastIndex < source.length) {
      const at = re.lastIndex, m = re.exec(source);
      if (!m) throw Error(`Unexpected character at ${at}`);
      if (!/^(?:\s|#|,)/.test(m[0])) this.tokens.push(m[0]);
      if (this.tokens.length > 20000) throw Error('Document too large');
    }
  }
  take(value?: string): string { const t = this.tokens[this.pos++]; if (!t || value && t !== value) throw Error(`Expected ${value ?? 'token'}, got ${t ?? 'end of document'}`); return t; }
  name() { const t = this.take(); if (!/^[_A-Za-z]\w*$/.test(t)) throw Error(`Expected name, got ${t}`); return t; }
  peek() { return this.tokens[this.pos]; }
  value(depth = 0): any {
    if (depth > 64) throw Error('Value nesting too deep');
    const t = this.take();
    if (t === '$') return { variable: this.name() };
    if (t === '{') { const o = Object.create(null); while (this.peek() !== '}') { const k = this.name(); this.take(':'); o[k] = this.value(depth + 1); } this.take('}'); return o; }
    if (t === '[') { const a = []; while (this.peek() !== ']') a.push(this.value(depth + 1)); this.take(']'); return a; }
    if (t.startsWith('"') || /^-?\d/.test(t) || ['true', 'false', 'null'].includes(t)) return JSON.parse(t);
    if (!/^[_A-Za-z]\w*$/.test(t)) throw Error(`Invalid value ${t}`);
    return t;
  }
  selection(depth = 0): Field[] {
    if (depth > 32) throw Error('Selection nesting too deep');
    this.take('{'); const fields: Field[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') { this.take(); this.take('on'); const condition = this.name(); fields.push({ name: '...', key: '...', args: {}, condition, fields: this.selection(depth + 1) }); continue; }
      let name = this.name(); const key = name;
      if (this.peek() === ':') { this.take(); name = this.name(); }
      const args = Object.create(null);
      if (this.peek() === '(') { this.take(); while (this.peek() !== ')') { const k = this.name(); this.take(':'); args[k] = this.value(); } this.take(')'); }
      fields.push({ name, key, args, fields: this.peek() === '{' ? this.selection(depth + 1) : [] });
    }
    this.take('}'); if (!fields.length) throw Error('Empty selection'); return fields;
  }
  document() {
    const ops = [];
    while (this.peek()) {
      let kind = 'query', name: string | undefined; const defaults = Object.create(null);
      if (this.peek() !== '{') {
        kind = this.take(); if (!['query', 'mutation'].includes(kind)) throw Error(`Unsupported operation ${kind}`);
        if (this.peek() !== '(' && this.peek() !== '{') name = this.name();
        if (this.peek() === '(') {
          this.take();
          while (this.peek() !== ')') {
            this.take('$'); const v = this.name(); this.take(':');
            if (this.peek() === '[') { this.take(); this.name(); if (this.peek() === '!') this.take(); this.take(']'); } else this.name();
            if (this.peek() === '!') this.take();
            if (this.peek() === '=') { this.take(); defaults[v] = this.value(); }
          }
          this.take(')');
        }
      }
      ops.push({ kind, name, defaults, fields: this.selection() });
    }
    return ops;
  }
}
const schema: Record<string, Record<string, string>> = {
  Query: { viewer: 'User!', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
  Repository: { id: 'ID!', databaseId: 'Int', name: 'String!', nameWithOwner: 'String!', owner: 'User!', defaultBranchRef: 'Ref', viewerPermission: 'RepositoryPermission', hasIssuesEnabled: 'Boolean!', issue: 'Issue', issues: 'IssueConnection!', pullRequests: 'PullRequestConnection!', pullRequest: 'PullRequest', labels: 'LabelConnection' },
  Issue: { id: 'ID!', number: 'Int!', title: 'String!', state: 'IssueState!', body: 'String!', labels: 'LabelConnection' },
  PullRequest: { id: 'ID!', number: 'Int!', title: 'String!', body: 'String!', headRefName: 'String!', baseRefName: 'String!', mergeable: 'MergeableState!', state: 'PullRequestState!', merged: 'Boolean!', files: 'PullRequestChangedFileConnection!' },
  User: { login: 'String!' }, Ref: { name: 'String!' }, Label: { id: 'ID!', name: 'String!', color: 'String!' },
  IssueConnection: { nodes: '[Issue!]!', pageInfo: 'PageInfo!', totalCount: 'Int!' }, PullRequestConnection: { nodes: '[PullRequest!]!', pageInfo: 'PageInfo!', totalCount: 'Int!' },
  LabelConnection: { nodes: '[Label!]!', totalCount: 'Int!' }, PullRequestChangedFileConnection: { nodes: '[PullRequestChangedFile!]!' }, PullRequestChangedFile: { path: 'String!' },
  PageInfo: { hasNextPage: 'Boolean!', endCursor: 'String' }, Node: { id: 'ID!' },
  CreateIssuePayload: { issue: 'Issue' }, CloseIssuePayload: { issue: 'Issue' }, CreatePullRequestPayload: { pullRequest: 'PullRequest' }, MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'CommentEdge' }, CommentEdge: { node: 'IssueComment' }, IssueComment: { id: 'ID!', body: 'String!' },
  __Type: { name: 'String', kind: 'String!', fields: '[__Field!]', enumValues: '[__EnumValue!]', ofType: '__Type' }, __Field: { name: 'String!', type: '__Type!' }, __EnumValue: { name: 'String!' },
};
const enums: Record<string, string[]> = { IssueState: ['OPEN','CLOSED'], PullRequestState: ['OPEN','CLOSED','MERGED'], MergeableState: ['MERGEABLE','CONFLICTING','UNKNOWN'], PullRequestMergeMethod: ['MERGE','SQUASH','REBASE'], RepositoryPermission: ['ADMIN','MAINTAIN','WRITE','TRIAGE','READ'], SearchType: ['ISSUE','REPOSITORY','USER'], IssueOrderField: ['CREATED_AT','UPDATED_AT','COMMENTS'], OrderDirection: ['ASC','DESC'] };
const baseType = (type: string) => type.replace(/[!\[\]]/g, '');
function typeInfo(type: string, fields = false): any {
  if (type.endsWith('!')) return { kind: 'NON_NULL', name: null, ofType: typeInfo(type.slice(0,-1)) };
  if (type.startsWith('[')) return { kind: 'LIST', name: null, ofType: typeInfo(type.slice(1,-1)) };
  return { name: type, kind: enums[type] ? 'ENUM' : schema[type] ? 'OBJECT' : 'SCALAR', ofType: null,
    fields: fields && schema[type] ? Object.entries(schema[type]).map(([name, t]) => ({ name, type: typeInfo(t) })) : null,
    enumValues: enums[type]?.map(name => ({ name })) ?? null };
}

export function graphql(store: ForgeStore, body: any): any {
  if (Array.isArray(body)) return body.map(op => graphql(store, op));
  try {
    if (!body || typeof body.query !== 'string') throw Error('query must be a string');
    const ops = new Parser(body.query).document();
    const op = body.operationName ? ops.find(o => o.name === body.operationName) : ops.length === 1 ? ops[0] : undefined;
    if (!op) throw Error('An operation must be selected');
    const vars = { ...op.defaults, ...body.variables };
    const value = (v: any): any => Array.isArray(v) ? v.map(value) : v && typeof v === 'object' ? ('variable' in v ? vars[v.variable] : Object.fromEntries(Object.entries(v).map(([k,x]) => [k,value(x)]))) : v;
    const validate = (fields: Field[], type: string) => {
      for (const f of fields) {
        if (f.name === '...') { if (!schema[f.condition!]) throw Error(`Unknown type ${f.condition}`); validate(f.fields, f.condition!); continue; }
        if (f.name === '__typename') continue;
        const t = Object.hasOwn(schema[type] ?? {}, f.name) ? schema[type][f.name] : undefined; if (!t) throw Error(`Unknown field ${f.name} on ${type}`);
        if (schema[baseType(t)] && !f.fields.length) throw Error(`Field ${f.name} requires a selection`);
        if (!schema[baseType(t)] && f.fields.length) throw Error(`Field ${f.name} cannot have a selection`);
        if (f.fields.length) validate(f.fields, baseType(t));
      }
    };
    const root = op.kind === 'mutation' ? 'Mutation' : 'Query'; validate(op.fields, root);
    const node = (id: string): any => {
      for (const r of store.repos.values()) {
        if (`R_${r.id}` === id) return { type: 'Repository', repo: r };
        for (const i of r.issues.values()) if (i.node_id === id) return { type: 'Issue', repo: r, item: i };
        for (const i of r.pulls.values()) if (i.node_id === id) return { type: 'PullRequest', repo: r, item: i };
      }
      return null;
    };
    const connection = (items: any[], a: any) => {
      const start = a.after == null ? 0 : Number(Buffer.from(String(a.after), 'base64').toString());
      const first = a.first ?? 100;
      if (!Number.isInteger(start) || start < 0 || !Number.isInteger(first) || first < 0) throw Error('Invalid pagination');
      const nodes = items.slice(start, start + first), end = start + nodes.length;
      return { nodes, totalCount: items.length, pageInfo: { hasNextPage: end < items.length, endCursor: nodes.length ? Buffer.from(String(end)).toString('base64') : null } };
    };
    const wrap = (type: string, repo: Repository, item: any) => item ? { type, repo, item } : null;
    const resolve = (obj: any, type: string, name: string, a: any): any => {
      if (name === '__typename') return obj?.type ?? type;
      if (type === 'Query') {
        if (name === 'viewer') return viewer;
        if (name === '__type') return schema[a.name] || enums[a.name] ? typeInfo(a.name, true) : null;
        if (name === 'node') return node(a.id);
        if (name === 'repository') return a.owner === viewer.login && store.repos.has(a.name) ? { repo: store.repos.get(a.name), type: 'Repository' } : null;
      }
      if (type === 'Mutation') {
        const i = a.input; if (!i || typeof i !== 'object') throw Error('input is required');
        const n = node(i.repositoryId ?? i.issueId ?? i.pullRequestId ?? i.subjectId);
        if (!n) throw Error('Unknown node id');
        const r: Repository = n.repo;
        if (name === 'createIssue' || name === 'createPullRequest') {
          if (n.type !== 'Repository') throw Error('repositoryId must identify a repository');
          if (name === 'createIssue') { const issue = store.issue(r, i); r.issues.set(issue.number, issue); return { issue: wrap('Issue', r, issue) }; }
          return { pullRequest: wrap('PullRequest', r, store.pull(r, { ...i, head: i.headRefName, base: i.baseRefName })) };
        }
        if (name === 'closeIssue') {
          if (n.type !== 'Issue') throw Error('issueId must identify an issue');
          n.item.state = 'closed'; n.item.closed_at = n.item.updated_at = store.now(); return { issue: n };
        }
        if (name === 'mergePullRequest') {
          if (n.type !== 'PullRequest') throw Error('pullRequestId must identify a pull request');
          if (i.mergeMethod && i.mergeMethod !== 'SQUASH') throw Error('Only SQUASH merge is supported');
          store.mergePull(r, n.item); return { pullRequest: n };
        }
        if (!n.item) throw Error('subjectId must identify an issue or pull request');
        const comment = { id: store.nextId++, body: requireString(i.body, 'body'), user: viewer, created_at: store.now() };
        const comments = r.comments.get(n.item.number) ?? []; comments.push(comment); r.comments.set(n.item.number, comments); n.item.comments = comments.length;
        return { commentEdge: { node: { ...comment, id: `C_${comment.id}` } } };
      }
      if (type === 'Repository') {
        const r: Repository = obj.repo;
        const fixed: any = { id: `R_${r.id}`, databaseId: r.id, name: r.name, nameWithOwner: `${viewer.login}/${r.name}`, owner: viewer, defaultBranchRef: r.tip() ? { name: r.default_branch } : null, viewerPermission: 'ADMIN', hasIssuesEnabled: true };
        if (name in fixed) return fixed[name];
        if (name === 'issue') return wrap('Issue', r, r.issues.get(a.number));
        if (name === 'pullRequest') return wrap('PullRequest', r, r.pulls.get(a.number));
        if (name === 'labels') return connection([...r.labels.values()], a);
        const isIssue = name === 'issues';
        const items = [...(isIssue ? r.issues : r.pulls).values()].filter(i => !a.states || a.states.includes(('merged' in i && i.merged ? 'MERGED' : i.state.toUpperCase())));
        const field = a.orderBy?.field === 'UPDATED_AT' ? 'updated_at' : a.orderBy?.field === 'COMMENTS' ? 'comments' : 'created_at';
        const direction = a.orderBy?.direction === 'ASC' ? 1 : -1;
        items.sort((x,y) => direction * (x[field] < y[field] ? -1 : x[field] > y[field] ? 1 : x.number - y.number));
        return connection(items.map(i => wrap(isIssue ? 'Issue' : 'PullRequest', r, i)), a);
      }
      if (type === 'Issue' || type === 'PullRequest') {
        const i: Issue & Partial<Pull> = obj.item;
        if (name === 'id') return i.node_id;
        if (name === 'state') return i.merged ? 'MERGED' : i.state.toUpperCase();
        if (name === 'headRefName') return i.head!.ref;
        if (name === 'baseRefName') return i.base!.ref;
        if (name === 'mergeable') { store.refreshPull(obj.repo, i as Pull); return obj.repo.git.merge(i.base!.sha, i.head!.sha) ? 'MERGEABLE' : 'CONFLICTING'; }
        if (name === 'files') return connection(store.pullFiles(obj.repo, i as Pull).map(f => ({ path: f.filename })), a);
        if (name === 'labels') return connection(i.labels, a);
        return (i as any)[name];
      }
      if (type === 'Label' && name === 'id') return `L_${obj.id}`;
      return obj[name] ?? null;
    };
    const execute = (obj: any, type: string, fields: Field[]): any => {
      if (obj === null) return null;
      type = obj?.type ?? type;
      const out = Object.create(null);
      for (const f of fields) {
        if (f.name === '...') { if (f.condition === type) Object.assign(out, execute(obj, type, f.fields)); continue; }
        const v = resolve(obj, type, f.name, value(f.args));
        const t = baseType(schema[type]?.[f.name] ?? 'String');
        out[f.key] = f.fields.length && v != null ? (Array.isArray(v) ? v.map(x => execute(x,t,f.fields)) : execute(v,t,f.fields)) : v ?? null;
      }
      return out;
    };
    return { data: execute({}, root, op.fields) };
  } catch (e) { return { errors: [{ message: e instanceof Error ? e.message : String(e) }] }; }
}
