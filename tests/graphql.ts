import assert from 'node:assert/strict';
import { store, baseUrl, headers, context, close, post } from './surface-harness.ts';
import { GitStore } from '../git-store.ts';
import { GitClient } from '../docs/conformance/git-client.ts';
const { GRAPHQL_CHECKS, configureGraphQLGit } = await import('../docs/conformance/checks-graphql.ts');
const git = new GitClient({ baseUrl, token: context().token });
configureGraphQLGit({ async pushBranch(r) {
  const repo = store.repo(r.owner, r.repo), local = new GitStore();
  for (const [sha, object] of repo.git.objects) local.objects.set(sha, object);
  const parent = repo.tip(r.from ?? r.branch), files = local.files(parent);
  files.set(r.path, { mode: '100644', sha: local.put('blob', Buffer.from(r.content)) });
  const sha = local.createCommit(files, parent ? [parent] : [], r.message, 'Test <test@example.com>', 1735689600);
  const result = await git.push(r.owner, r.repo, [{ ref: `refs/heads/${r.branch}`, oldOid: repo.tip(r.branch) ?? '0'.repeat(40), newOid: sha }], { objects: [...local.objects.values()].map(o => ({ type: o.type, data: o.payload })) });
  return result.report?.unpackOk && result.report.refs.every(r => r.ok) ? null : 'Fixture push failed';
} });
try {
  let passed = 0;
  for (const check of GRAPHQL_CHECKS) { const r = await check.fn(context()); console.log(`${r.ok ? 'PASS' : 'FAIL'} ${check.id}: ${r.detail}`); if (r.ok) passed++; }
  assert.equal(passed, 20);
  const repo = [...store.repos.values()][0], owner = context().scenario.viewer.login;
  const query = async (query: string, variables = {}) => (await post('/api/graphql', { query, variables })).json();
  const head = [...repo.git.refs.keys()].map(r => r.slice(11)).find(r => r !== repo.default_branch)!;
  const created = await query('mutation($input: CreatePullRequestInput!) { createPullRequest(input:$input) { pullRequest { id number title headRefName baseRefName state } } }', { input: { repositoryId: `R_${repo.id}`, title: 'Full parity', headRefName: head, baseRefName: repo.default_branch } });
  const pr = created.data.createPullRequest.pullRequest;
  const rest = await (await fetch(`${baseUrl}/api/v3/repos/${owner}/${repo.name}/pulls/${pr.number}`, { headers })).json();
  assert.deepEqual(pr, { id: rest.node_id, number: rest.number, title: rest.title, headRefName: rest.head.ref, baseRefName: rest.base.ref, state: rest.state.toUpperCase() });
  for (const document of ['', '{', '{ viewer { login }', '{ viewer { login } } garbage', '{ viewer { login( } }']) assert((await query(document)).errors.length);
  assert((await query('{ repository(owner:"missing", name:"missing") { badField } }')).errors[0].message.includes('badField'));
  const before = repo.issues.size;
  assert((await query(`mutation { createIssue(input:{repositoryId:"R_${repo.id}",title:"do not create"}) { issue { badField } } }`)).errors.length);
  assert.equal(repo.issues.size, before);
  const a = store.issue(repo, { title: 'tie a' }), b = store.issue(repo, { title: 'tie b' }); b.created_at = a.created_at; repo.issues.set(a.number,a); repo.issues.set(b.number,b);
  const order = await query(`{ repository(owner:"${owner}", name:"${repo.name}") { issues(first:100,orderBy:{field:CREATED_AT,direction:DESC}) { nodes { number } } } }`);
  const nums = order.data.repository.issues.nodes.map((x: any) => x.number); assert(nums.indexOf(b.number) < nums.indexOf(a.number));
  assert.equal((await fetch(baseUrl+'/api/graphql', { method:'POST', headers: { authorization:'Bearer wrong' }, body:'{}' })).status, 401);
  const intro = await query('{ __type(name:"Issue") { fields { name type { kind name ofType { name } } } } }');
  assert.deepEqual(intro.data.__type.fields.find((f:any) => f.name === 'number').type, { kind:'NON_NULL', name:null, ofType:{name:'Int'} });
  const selected = await (await post('/api/graphql', { query: 'query A { viewer { login } } query B($n: String = "Issue") { __type(name:$n) { name } }', operationName:'B' })).json();
  assert.deepEqual(selected.data, { __type: { name:'Issue' } });
  const malformed = await fetch(baseUrl+'/api/graphql', {method:'POST',headers,body:'{bad'}); assert.equal(malformed.status,400); assert((await malformed.json()).errors.length);
  const batch = await (await post('/api/graphql', [{query:'{'},{query:'{viewer{login}}'}])).json(); assert(batch[0].errors.length); assert.equal(batch[1].data.viewer.login,owner);
  repo.labels.set('bug', {id:999,name:'bug',color:'ff0000'});
  const labels = await query(`{repository(owner:"${owner}",name:"${repo.name}"){labels(first:1){nodes{id name color}}}}`);
  assert.deepEqual(labels.data.repository.labels.nodes,[{id:'L_999',name:'bug',color:'ff0000'}]);
  console.log('PASS supplemental GraphQL PR parity, malformed documents, validation before mutations, tie ordering, auth, introspection types');
} finally { configureGraphQLGit(null); close(); }
