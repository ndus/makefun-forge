import { ForgeStore, HttpError } from './store.ts';
const definitions: [string, string, string[], Record<string, string>][] = [
  ['create_repo', 'Create a repository for the authenticated user.', ['name'], { name: 'string', description: 'string', private: 'boolean' }],
  ['get_repo', 'Read a repository.', ['owner','repo'], {}],
  ['create_issue', 'Create an issue in a repository.', ['owner','repo','title'], { title: 'string', body: 'string' }],
  ['list_issues', 'List repository issues.', ['owner','repo'], { state: 'string' }],
  ['create_pull_request', 'Open a pull request between existing branches.', ['owner','repo','title','head','base'], { title: 'string', body: 'string', head: 'string', base: 'string' }],
  ['merge_pull_request', 'Squash merge a pull request.', ['owner','repo','pull_number'], { pull_number: 'integer' }],
];
const tools = definitions.map(([name, description, required, extra]) => ({ name, description, inputSchema: { type: 'object', required, properties: Object.fromEntries(Object.entries({ ...(name === 'create_repo' ? {} : { owner: 'string', repo: 'string' }), ...extra }).map(([k,type]) => [k,{ type }])) } }));
const record = (x: any) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const rpcError = (id: any, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
export function mcp(store: ForgeStore, body: any, origin: string): { status: number; body?: any } {
  if (!record(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string' || ('id' in body && typeof body.id !== 'string' && typeof body.id !== 'number' && body.id !== null)) return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  // Notifications never carry a JSON-RPC response, including unknown notifications.
  if (!('id' in body)) return { status: 202 };
  const error = (code: number, message: string) => ({ status: 200, body: rpcError(body.id, code, message) });
  if (body.params !== undefined && !record(body.params)) return error(-32602, 'params must be an object');
  const p = body.params ?? {};
  let result: any;
  try {
    switch (body.method) {
      case 'server/discover': result = { supportedVersions: ['2026-07-28'], serverInfo: { name: 'standalone-forge', version: '3.0.0' }, capabilities: { tools: {} } }; break;
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools }; break;
      case 'tools/call': {
        const tool = tools.find(t => t.name === p.name); if (!tool) return error(-32602, `Unknown tool ${String(p.name)}`);
        const a = p.arguments; if (!record(a)) return error(-32602, 'arguments must be an object');
        for (const key of tool.inputSchema.required) if (!(key in a)) return error(-32602, `${key} is required`);
        for (const [key, spec] of Object.entries(tool.inputSchema.properties)) {
          if (!(key in a)) continue;
          if (spec.type === 'integer' ? !Number.isInteger(a[key]) || a[key] < 1 : typeof a[key] !== spec.type || spec.type === 'string' && !a[key].trim()) return error(-32602, `Invalid ${key}`);
        }
        let output: any;
        if (p.name === 'create_repo') output = store.repositoryJson(store.createRepo(a), origin);
        else {
          const repo = store.repo(a.owner, a.repo);
          switch (p.name) {
            case 'get_repo': output = store.repositoryJson(repo, origin); break;
            case 'create_issue': output = store.issue(repo, a); repo.issues.set(output.number, output); break;
            case 'list_issues':
              if (a.state && !['open','closed','all'].includes(a.state)) return error(-32602, 'Invalid state');
              output = [...repo.issues.values()].filter(i => a.state === 'all' || i.state === (a.state ?? 'open')).sort((x,y) => y.number-x.number); break;
            case 'create_pull_request': output = store.pull(repo, a); break;
            case 'merge_pull_request': {
              const pull = repo.pulls.get(a.pull_number); if (!pull) throw new HttpError(404, 'Unknown pull request');
              output = { sha: store.mergePull(repo, pull), merged: true }; break;
            }
          }
        }
        result = { content: [{ type: 'text', text: JSON.stringify(output) }], isError: false }; break;
      }
      default: return error(-32601, `Unknown method ${body.method}`);
    }
  } catch (e) { result = { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true }; }
  return { status: 200, body: { jsonrpc: '2.0', id: body.id, result } };
}
