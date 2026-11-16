import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { buildScenario } from '../docs/conformance/wire.ts';
const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './calibration.json' && context.parentURL?.endsWith('/docs/conformance/manifest.ts')) return { url: 'data:application/json,' + encodeURIComponent(JSON.stringify({ schema: 'agent-fun/calibration/v1', contest: 'github-core-clone-01', workloads: {} })), shortCircuit: true };
  return next(specifier, context);
} });
const { GIT_CHECKS } = await import('../docs/conformance/checks-git.ts'); hook.deregister();
const token = 'git-integration-token', scenario = buildScenario();
let done = false, resolveBase: (value: string) => void;
const baseReady = new Promise<string>(resolve => { resolveBase = resolve; });
const harness = createServer(async (req, res) => {
  if (req.url === '/register') { let b = ''; for await (const c of req) b += c; const { port } = JSON.parse(b); assert(port > 0 && port !== 8080); resolveBase(`http://127.0.0.1:${port}`); res.end('{}'); }
  else res.end(JSON.stringify({ done }));
});
await new Promise<void>(resolve => harness.listen(0, '127.0.0.1', resolve));
const address = harness.address(); assert(address && typeof address !== 'string');
const child = spawn(process.execPath, ['main.ts'], { env: { ...process.env, MAKEFUN_SHOP_TOKEN: token, MAKEFUN_ENV_URL: `http://127.0.0.1:${address.port}` }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c);
const exited = new Promise(resolve => child.once('exit', resolve));
const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
const temp = await mkdtemp(join(tmpdir(), 'forge-git-'));
try {
  const baseUrl = await Promise.race([baseReady, exited.then(() => { throw new Error(output); })]);
  let passed = 0;
  for (const check of GIT_CHECKS) {
    const result = await check.fn({ baseUrl, token, scenario, signal: AbortSignal.timeout(check.timeoutMs), deadlineMs: performance.now() + check.timeoutMs, timeoutMs: check.timeoutMs, log() {} });
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${check.id}: ${result.detail}`); if (result.ok) passed++;
  }
  assert.equal(passed, 30);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const repo = `${baseUrl}/${scenario.viewer.login}/cli.git`;
  assert.equal((await fetch(`${baseUrl}/api/v3/user/repos`, { method: 'POST', headers, body: JSON.stringify({ name: 'cli' }) })).status, 201);
  for (const service of ['git-upload-pack', 'git-receive-pack']) {
    assert.equal((await fetch(`${repo}/info/refs?service=${service}`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/other/cli.git/info/refs?service=${service}`, { headers })).status, 404);
  }
  const exec = promisify(execFile);
  const git = async (cwd: string, ...args: string[]) => (await exec('git', ['-c', `http.extraHeader=Authorization: Bearer ${token}`, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
  await git(temp, 'clone', repo, 'one'); const one = join(temp, 'one');
  const content = Array.from({ length: 10000 }, (_, i) => `line ${i} ${i * 17}\n`).join('');
  await writeFile(join(one, 'file'), content); await git(one, 'add', '.'); await git(one, 'commit', '-m', 'first'); await git(one, 'push', 'origin', 'main');
  const first = await git(one, 'rev-parse', 'HEAD');
  await git(temp, 'clone', repo, 'two'); const two = join(temp, 'two');
  await writeFile(join(one, 'file'), content + 'second\n'); await git(one, 'commit', '-am', 'second'); await git(one, 'push', 'origin', 'main');
  const second = await git(one, 'rev-parse', 'HEAD');
  await git(two, 'pull', '--ff-only'); assert.equal(await git(two, 'rev-parse', 'HEAD'), second);
  await git(one, 'branch', 'side'); await git(one, 'push', 'origin', 'side');
  await git(one, 'checkout', '-b', 'sibling', first); await writeFile(join(one, 'sibling'), 'sibling'); await git(one, 'add', '.'); await git(one, 'commit', '-m', 'sibling');
  await assert.rejects(git(one, 'push', '--force', 'origin', 'sibling:main'), /non-fast-forward/);
  await git(one, 'checkout', 'main'); await writeFile(join(one, 'third'), 'third'); await git(one, 'add', '.'); await git(one, 'commit', '-m', 'third');
  const third = await git(one, 'rev-parse', 'HEAD');
  await assert.rejects(git(one, 'push', '--force', 'origin', 'main:main', 'sibling:side'), /non-fast-forward/);
  const refs = await git(one, 'ls-remote', 'origin'); assert(refs.includes(`${third}\trefs/heads/main`)); assert(refs.includes(`${second}\trefs/heads/side`));
  await git(one, 'push', 'origin', '--delete', 'side'); assert(!(await git(one, 'ls-remote', 'origin')).includes('refs/heads/side'));
  await git(temp, 'clone', repo, 'three'); assert.equal(await readFile(join(temp, 'three', 'file'), 'utf8'), content + 'second\n');
  await git(join(temp, 'three'), 'fsck', '--full');
  const rest = await fetch(`${baseUrl}/api/v3/repos/${scenario.viewer.login}/cli/contents/third`, { headers }); assert.equal(rest.status, 200); assert.equal(Buffer.from((await rest.json()).content, 'base64').toString(), 'third');
  await git(temp, 'clone', '--depth=1', repo, 'shallow'); assert.equal(await git(join(temp, 'shallow'), 'rev-list', '--count', 'HEAD'), '1');
  await git(join(temp, 'shallow'), 'fetch', '--depth=2'); assert.equal(await git(join(temp, 'shallow'), 'rev-list', '--count', 'HEAD'), '2');
  console.log('PASS CLI clone, commit, thin push, pull, force refusal, mixed push, deletion, reclone, fsck, REST contents, shallow fetch');
  done = true; assert.equal(await exited, 0, output);
} finally { clearTimeout(timer); child.kill(); harness.closeAllConnections(); harness.close(); await rm(temp, { recursive: true, force: true }); }
