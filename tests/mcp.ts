import assert from 'node:assert/strict';
import { baseUrl, headers, context, close, post } from './surface-harness.ts';
const { MCP_CHECKS } = await import('../docs/conformance/checks-mcp.ts');
try {
  let passed = 0;
  for (const check of MCP_CHECKS) { const start = performance.now(); const r = await check.fn(context()); console.log(`${r.ok ? 'PASS' : 'FAIL'} ${check.id}: ${r.detail}`); if(r.ok) passed++; assert(performance.now()-start < 3000); }
  assert.equal(passed,15);
  const rpc = (method: string, params: any = {}, id: any = 7) => post('/mcp', { jsonrpc:'2.0', id, method, params });
  assert.equal(await (await rpc('tools/list')).text(), await (await rpc('tools/list')).text());
  assert.equal((await (await rpc('unknown')).json()).error.code,-32601);
  assert.equal((await (await rpc('tools/call', {name:'get_repo',arguments:{owner:5,repo:'bad'}})).json()).error.code,-32602);
  assert.equal((await (await post('/mcp', [])).json()).error.code,-32600);
  const notification = await post('/mcp', {jsonrpc:'2.0',method:'notifications/initialized'}); assert.equal(notification.status,202); assert.equal(await notification.text(),'');
  await rpc('tools/call',{ name:'create_repo', arguments:{name:'mcp-parity-extra'} });
  const owner = context().scenario.viewer.login;
  const result = await (await rpc('tools/call', {name:'create_issue',arguments:{owner,repo:'mcp-parity-extra',title:'Cross surface'}})).json();
  const issue = JSON.parse(result.result.content[0].text);
  const rest = await (await fetch(`${baseUrl}/api/v3/repos/${owner}/mcp-parity-extra/issues/${issue.number}`,{headers})).json(); assert.deepEqual(rest,issue);
  const gql = await (await post('/api/graphql',{query:`{repository(owner:"${owner}",name:"mcp-parity-extra"){issue(number:${issue.number}){id number title}}}`})).json();
  assert.deepEqual(gql.data.repository.issue,{id:issue.node_id,number:issue.number,title:issue.title});
  console.log('PASS supplemental MCP timing, identical list bytes, errors, notifications, MCP/REST/GraphQL parity');
} finally { close(); }
