// Run the supplied workloads unchanged through the actual HTTP request callback.
import { baseUrl, token, close, post, store } from './surface-harness.ts';
import { readFileSync, writeFileSync } from 'node:fs';
const { runBenchmark } = await import('../docs/conformance/bench.ts');
try {
  const result = await runBenchmark({ baseUrl, token });
  for (const w of result.workloads) {
    if (w.rounds.length !== 3 || w.p50_ms >= 1e9) throw new Error(`${w.name}: ${w.error}`);
  }
  const measurements = Object.fromEntries(result.workloads.map(w => [w.name, { rounds: w.rounds, p50_ms: w.p50_ms }]));
  const baseline = process.argv.indexOf('--baseline');
  if (baseline >= 0) writeFileSync(process.argv[baseline + 1], JSON.stringify(measurements, null, 2));
  const compare = process.argv.indexOf('--compare');
  if (baseline < 0) console.log('BEFORE', readFileSync(compare >= 0 ? process.argv[compare + 1] : new URL('./bench-before.json', import.meta.url), 'utf8'));
  console.log(baseline >= 0 ? 'BEFORE' : 'AFTER', JSON.stringify(measurements, null, 2));
  // Largest issue dataset created by the timed runs: 605 issues, including warmup.
  const start = performance.now();
  const response = await post('/mcp', { jsonrpc: '2.0', id: 'large-list', method: 'tools/call', params: { name: 'list_issues', arguments: { owner: 'adaiversen', repo: 'bench-write', state: 'all' } } });
  const body = await response.json();
  const elapsed = performance.now() - start;
  if (response.status !== 200 || body.result?.isError || JSON.parse(body.result.content[0].text).length !== store.repos.get('bench-write')!.issues.size || elapsed >= 3000) throw new Error('Large MCP list failed or exceeded 3 s');
  console.log(`MCP largest issue list: ${elapsed.toFixed(3)} ms`);
} finally { close(); }

