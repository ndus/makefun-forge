import { createApp } from '../app.ts';
import { ForgeStore } from '../store.ts';
import { registerHooks } from 'node:module';
import { buildScenario } from '../docs/conformance/wire.ts';
import { Readable } from 'node:stream';
import { ServerResponse, type IncomingMessage } from 'node:http';
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === './calibration.json' && context.parentURL?.endsWith('/docs/conformance/manifest.ts')) {
    return { url: 'data:application/json,' + encodeURIComponent(JSON.stringify({ schema: 'agent-fun/calibration/v1', contest: 'github-core-clone-01', workloads: {} })), shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });

export const store = new ForgeStore(), token = 'local-test-token';
const server = createApp(store, token);
export const baseUrl = 'http://forge.test';
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
        resolve(new Response([202,204].includes(res.statusCode) && !body ? null : body ?? '', { status: res.statusCode, headers }));
      } catch (error) { reject(error); }
      return res;
    }) as typeof res.end;
    server.emit('request', req, res);
  });
};

export const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
export const context = () => ({ baseUrl, token, scenario: buildScenario(), signal: AbortSignal.timeout(15000), deadlineMs: performance.now() + 15000, timeoutMs: 15000, log() {} });
export const close = () => { hook.deregister(); globalThis.fetch = originalFetch; server.close(); };
export const post = (path: string, body: unknown) => fetch(baseUrl + path, { method: 'POST', headers, body: JSON.stringify(body) });
