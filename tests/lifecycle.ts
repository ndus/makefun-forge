// Real TCP smoke test, for a host that permits listen(0): node tests/lifecycle.ts
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const token = 'lifecycle-test-token';
let registered = false, polls = 0;
const dummy = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/register' && req.method === 'POST') {
    let text = '';
    for await (const chunk of req) text += chunk;
    const { port } = JSON.parse(text);
    assert(Number.isInteger(port) && port > 0 && port !== 8080);
    const origin = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(origin + '/healthz')).status, 200);
    const root = await fetch(origin + '/api/v3/', { headers: { authorization: `Bearer ${token}` } });
    assert.equal(root.status, 200);
    assert(root.headers.get('x-github-request-id'));
    registered = true;
    res.end('{}');
  } else if (req.url === '/done') {
    assert(registered);
    res.end(JSON.stringify({ done: ++polls >= 2 }));
  } else { res.statusCode = 404; res.end('{}'); }
});
await new Promise<void>((resolve, reject) => { dummy.once('error', reject); dummy.listen(0, '127.0.0.1', resolve); });
const address = dummy.address();
assert(address && typeof address !== 'string');
try {
  const child = spawn(process.execPath, ['main.ts'], { cwd: new URL('..', import.meta.url), env: { ...process.env, MAKEFUN_SHOP_TOKEN: token, MAKEFUN_ENV_URL: `http://127.0.0.1:${address.port}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  clearTimeout(timeout);
  assert.equal(code, 0, output);
  assert(registered && polls >= 2);
  assert(output.includes('[entry] done'));
  console.log('PASS ephemeral bind, registration, repeated /done polling, exit 0');
} finally {
  dummy.closeAllConnections();
  await new Promise<void>(resolve => dummy.close(() => resolve()));
}
