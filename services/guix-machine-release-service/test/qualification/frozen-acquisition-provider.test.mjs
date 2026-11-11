import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {providerFixture,put} from '../fixtures/frozen-provider-fixture.mjs';

test('genuine pnpm10 frozen admission: negative inputs precede a clean synthetic fetch',async t=>{
  const fixture=await providerFixture(t);
  const cases=[
    ['known SQLite lock identity',f=>{f.lock.packages['sqlite3@5.0.0']={resolution:f.lock.packages['drc3-inert@1.0.0'].resolution};},/SQLite admission refused/],
    ['npm alias SQLite identity',f=>{f.lock.importers['.'].dependencies.storage={specifier:'npm:sqlite3@5',version:'sqlite3@5.0.0'};},/SQLite admission refused/],
    ['reviewed hook checksum',f=>{f.lock.pnpmfileChecksum='previous-reviewed-hook';},/hook checksum/],
    ['runtime binary resolution',f=>{f.lock.packages['drc3-inert@1.0.0'].resolution.type='binary';},/non-registry resolution/],
    ...['codeload.github.com','gitlab.com','bitbucket.org'].map(host=>[
      `Git-hosted archive ${host}`,f=>{f.lock.packages['drc3-inert@1.0.0'].resolution.tarball=`https://${host}/example/archive.tar.gz`;},/Git-hosted archive/]),
    ...['dependencies','optionalDependencies'].map(field=>[
      `package metadata ${field} overrides snapshots`,f=>{f.lock.packages['drc3-inert@1.0.0'][field]={unreviewed:'1.0.0'};},/overrides snapshot edges/]),
    ['workspace npm configuration',f=>{put(join(f.work,'.npmrc'),'fix-lockfile=true\n');},/workspace npm configuration/],
    ['configuration bootstrap',f=>{f.config.configDependencies={pacquet:'1.0.0'};},/workspace setting/],
    ['stale manifest',f=>{f.manifests['.'].dependencies['drc3-inert']='2.0.0';},/specifier differs/],
    ['manager mismatch',f=>{f.manifests['.'].packageManager='pnpm@11.9.0';},/packageManager/],
    ['missing reviewed integrity',f=>{delete f.lock.packages['drc3-inert@1.0.0'].resolution.integrity;},/integrity is missing/],
  ];
  for(const [label,amend,expected] of cases)await t.test(label,async()=>{
    const f=fixture.workspace();amend(f);
    put(join(f.work,'pnpm-lock.yaml'),f.lock);put(join(f.work,'pnpm-workspace.yaml'),f.config);
    put(join(f.work,'package.json'),f.manifests['.']);
    const before=fixture.requests.length,result=await fixture.acquire(f);
    assert.notEqual(result.status,0);assert.match(result.stderr,expected);
    assert.equal(fixture.requests.length,before,'refusal must precede registry requests');
    assert.equal(existsSync(join(f.work,'node_modules')),false);
  });
  await t.test('conflict input cannot fall through to resolution',async()=>{
    const f=fixture.workspace();put(join(f.work,'pnpm-lock.yaml'),'<<<<<<< unreviewed\n'+JSON.stringify(f.lock)+'\n=======\n>>>>>>> other\n');
    const result=await fixture.acquire(f);assert.notEqual(result.status,0);assert.match(result.stderr,/conflict markers/);assert.equal(fixture.requests.length,0);
  });
  await t.test('metadata resolution remains held before manager execution',async()=>{
    const f=fixture.workspace(),result=await fixture.acquire(f,'resolve');
    assert.notEqual(result.status,0);assert.match(result.stderr,/metadata resolution is held/);assert.equal(fixture.requests.length,0);
  });
  await t.test('clean reviewed workspace installs without metadata or outside providers',async()=>{
    const f=fixture.workspace(),before=readFileSync(join(f.work,'pnpm-lock.yaml'),'utf8');
    const divergent=join(f.caseRoot,'divergent');mkdirSync(divergent);
    put(join(divergent,'pnpm-workspace.yaml'),{packages:[],configDependencies:{pacquet:'1.0.0'}});
    f.env.NPM_CONFIG_WORKSPACE_DIR=divergent;f.env.npm_config_workspace_dir=divergent;f.env.npm_config_lockfile_dir=divergent;
    const result=await fixture.acquire(f);assert.equal(result.status,0,result.stderr);
    assert.equal(readFileSync(join(f.work,'pnpm-lock.yaml'),'utf8'),before,'reviewed lock bytes are preserved');
    assert.ok(fixture.requests.some(request=>request.path==='/-/drc3-inert-1.0.0.tgz'));
    assert.ok(fixture.requests.some(request=>request.path==='/-/yaml-2.9.0.tgz'));
    assert.deepEqual(fixture.unexpected,[]);
    assert.equal(readFileSync(join(f.work,'node_modules/drc3-inert/index.cjs'),'utf8'),"module.exports = 'synthetic-inert';\n");
    const events=readFileSync(join(fixture.root,'boundary-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    const workers=events.filter(event=>event.event==='worker-created');
    const initialized=events.filter(event=>event.event==='initialized'&&event.role==='manager'&&event.threadId>0);
    assert.ok(workers.length>0,'genuine package fetching used its worker implementation');
    assert.equal(initialized.length,workers.length,'every created provider worker initialized the boundary control');
  });
});
