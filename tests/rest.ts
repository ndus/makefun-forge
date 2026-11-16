import assert from 'node:assert/strict';
import { createApp } from '../app.ts';
import { ForgeStore } from '../store.ts';
import { registerHooks } from 'node:module';
// The supplied kit omits calibration.json. REST checks never use benchmark timings;
// supply an explicitly uncalibrated fixture only in this test process.
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === './calibration.json' && context.parentURL?.endsWith('/docs/conformance/manifest.ts')) {
    return { url: 'data:application/json,' + encodeURIComponent(JSON.stringify({ schema: 'agent-fun/calibration/v1', contest: 'github-core-clone-01', workloads: {} })), shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });
const { restChecks, restProtocolChecks } = await import('../docs/conformance/checks-rest.ts');
hook.deregister();
import { buildScenario } from '../docs/conformance/wire.ts';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';

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
let failed = 0;
try {
  const createRepository = (name: string) => fetch(baseUrl + '/api/v3/user/repos', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  assert.equal((await createRepository('duplicate-regression')).status, 201);
  const duplicate = await createRepository('duplicate-regression');
  assert.equal(duplicate.status, 422);
  const duplicateBody = await duplicate.text();
  assert.match(duplicateBody, /already exists/i);
  assert.deepEqual(JSON.parse(duplicateBody), {
    message: 'Validation Failed',
    errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
  });
  const invalid = await createRepository('invalid/name');
  assert.equal(invalid.status, 422);
  assert.match((await invalid.json()).message, /invalid/i);
  console.log('PASS duplicate repository REST response and invalid-name validation');
  for (const check of [...restChecks(), ...restProtocolChecks()]) {
    const result = await check.fn({ baseUrl, token, scenario: buildScenario(), signal: AbortSignal.timeout(10_000), deadlineMs: performance.now() + 10_000, timeoutMs: 10_000, log() {} });
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${check.id}${result.ok ? '' : ': ' + result.detail}`);
    if (!result.ok) failed++;
  }
  for (const path of ['/api/v3/', '/api/graphql', '/mcp', '/owner/repo.git/info/refs']) {
    for (const authorization of ['', 'Bearer wrong-token']) {
      const response = await fetch(baseUrl + path, { headers: { authorization } });
      assert.equal(response.status, 401);
      assert.equal(typeof (await response.json()).message, 'string');
      assert(response.headers.get('x-github-request-id'));
    }
  }
  let objects = 0;
  for (const repo of store.repos.values()) {
    for (const [sha, object] of repo.git.objects) {
      const bytes = inflateSync(repo.git.loose(sha));
      assert.equal(createHash('sha1').update(bytes).digest('hex'), sha);
      assert.deepEqual(bytes, Buffer.concat([Buffer.from(`${object.type} ${object.payload.length}\0`), object.payload]));
      if (object.type === 'commit') {
        const commit = repo.git.commit(sha);
        assert.equal(repo.git.get(commit.tree).type, 'tree');
        for (const parent of commit.parents) assert.equal(repo.git.get(parent).type, 'commit');
      }
      objects++;
    }
  }
  console.log(`Verified auth and ${objects} real git objects; ${failed} REST failures`);
  assert.equal(failed, 0);
} finally {
  globalThis.fetch = originalFetch;
  server.close();
}
