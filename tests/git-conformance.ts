import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../app.ts';
import { ForgeStore } from '../store.ts';
import { registerHooks } from 'node:module';
import { GitClient } from '../docs/conformance/git-client.ts';
import { pkt } from '../git-http.ts';
import { buildScenario } from '../docs/conformance/wire.ts';
import { Readable } from 'node:stream';
import { ServerResponse, type IncomingMessage } from 'node:http';
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === './calibration.json' && context.parentURL?.endsWith('/docs/conformance/manifest.ts')) {
    return { url: 'data:application/json,' + encodeURIComponent(JSON.stringify({ schema: 'agent-fun/calibration/v1', contest: 'github-core-clone-01', workloads: {} })), shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });
const { GIT_CHECKS } = await import('../docs/conformance/checks-git.ts');
hook.deregister();
const store = new ForgeStore(), token = 'local-test-token';
const server = createApp(store, token);
const baseUrl = 'http://forge.test';
// Exercise the actual request callback without TCP: this sandbox forbids listen(0).
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const bytes = Buffer.from(await request.arrayBuffer());
  const req = Readable.from(bytes.length ? [bytes] : []) as unknown as IncomingMessage;
  req.url = new URL(request.url).pathname + new URL(request.url).search;
  req.method = request.method;
  req.headers = Object.fromEntries(request.headers);
  req.headers.host = new URL(request.url).host;
  const res = new ServerResponse(req);
  return await new Promise<Response>((resolve, reject) => {
    res.end = ((body?: string | Buffer) => {
      try {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.getHeaders())) if (value !== undefined) headers.set(key, String(value));
        resolve(new Response(res.statusCode === 204 ? null : body ?? '', { status: res.statusCode, headers }));
      } catch (error) { reject(error); }
      return res;
    }) as typeof res.end;
    server.emit('request', req, res);
  });
};
let passed = 0;
try {
  for (const check of GIT_CHECKS) {
    const result = await check.fn({ baseUrl, token, scenario: buildScenario(), signal: AbortSignal.timeout(15000), deadlineMs: performance.now() + 15000, timeoutMs: 15000, log() {} });
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${check.id}: ${result.detail}`);
    if (result.ok) passed++;
  }
  assert.equal(passed, 30);
  const owner = buildScenario().viewer.login, name = 'gitconf-push-first-commit';
  const url = `${baseUrl}/${owner}/${name}.git`, headers = { authorization: `Bearer ${token}` };
  for (const service of ['git-upload-pack', 'git-receive-pack']) {
    assert.equal((await fetch(`${url}/info/refs?service=${service}`)).status, 401);
    assert.equal((await fetch(`${url}/info/refs?service=${service}`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${baseUrl}/other/${name}.git/info/refs?service=${service}`, { headers })).status, 404);
  }
  const v0 = new GitClient({ baseUrl, token, gitProtocol: 0 });
  const clone = await v0.clone(owner, name); assert(clone.objects.size > 0);
  const repo = store.repo(owner, name), tip = repo.tip()!;
  const malformed = Buffer.concat([pkt(`${tip} ${'1'.repeat(40)} refs/heads/main\0report-status side-band-64k\n`), Buffer.from('0000PACKbad')]);
  const response = await fetch(`${url}/git-receive-pack`, { method: 'POST', headers, body: malformed });
  assert.equal(response.status, 200); assert((await response.text()).includes('unpack invalid pack'));
  assert.equal(repo.tip(), tip);
  for (const service of ['git-upload-pack', 'git-receive-pack']) {
    assert.equal((await fetch(`${url}/${service}`, { method: 'POST', headers, body: 'zzzzbroken' })).status, 400);
  }
  const rest = await fetch(`${baseUrl}/api/v3/repos/${owner}/${name}/branches`, { headers });
  assert.equal((await rest.json())[0].commit.sha, tip);
  const [path, file] = [...repo.git.files(tip)][0];
  const content = await fetch(`${baseUrl}/api/v3/repos/${owner}/${name}/contents/${path}`, { headers });
  assert.equal(content.status, 200);
  assert.deepEqual(Buffer.from((await content.json()).content, 'base64'), repo.git.get(file.sha).payload);
  const bulk = Buffer.concat(Array.from({ length: 8192 }, (_, i) => createHash('sha256').update(String(i)).digest()));
  const largeRepo = store.createRepo({ name: 'large-band' });
  const largeTip = store.commit(largeRepo, 'main', new Map([['binary', { mode: '100644', sha: largeRepo.git.put('blob', bulk) }]]), 'large');
  const large = await v0.clone(owner, largeRepo.name);
  assert(large.packBytes > 65520);
  assert(large.objects.has(largeTip));
  assert.deepEqual(large.objects.get(largeRepo.git.files(largeTip).get('binary')!.sha)!.data, bulk);
  console.log('PASS supplemental auth/owner checks, v0 clone, corrupt push isolation, malformed requests, REST branches/contents, multi-packet binary transfer');
} finally { globalThis.fetch = originalFetch; server.close(); }
