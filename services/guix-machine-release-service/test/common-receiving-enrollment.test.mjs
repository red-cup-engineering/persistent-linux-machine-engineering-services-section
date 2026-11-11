import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,rm,rename,symlink} from 'node:fs/promises';
import {dirname,join,relative} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fixture} from './fixtures/portable-source-fixture.mjs';
import {receiveWorkspaceRuntime} from '../scripts/envelope-workspace-runtime.mjs';
import {manifestIdentity,packageReceivingChecks} from '../scripts/package-receiving.mjs';

const name='@red-cup-engineering/feltos',testPath='test/receive.test.mjs';
const testBody='// inert committed receiving body; never executed by these tests\n';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function git(root,...args){
  const result=spawnSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-C',root,...args],
    {encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});
  assert.equal(result.status,0,result.stderr);return result.stdout.trim();
}

// Reuse the committed portable-source fixture and genuine production receivers.
// Its original machine-shaped snapshot predates the common-source root contract.
// The adaptation below commits that explicit source identity and refreshes each
// structural receipt. No PNPM, compiler, application or declared test is run.
async function commitFixture(f){
  git(f.workspace,'add','.');git(f.workspace,'commit','-qm','common receiving fixture');
  const commit=git(f.workspace,'rev-parse','HEAD');
  f.selection.commit=commit;f.compilation.sourceCommit=commit;f.command.commit=commit;
  for(const path of Object.keys(f.selection.sourceHashes))f.selection.sourceHashes[path]=hash(await readFile(join(f.workspace,path)));
  for(const id of Object.keys(f.selection.manifestHashes))f.selection.manifestHashes[id]=hash(await readFile(join(f.workspace,id,'package.json')));
}
async function commonFixture(t,options={}){
  const f=await fixture(t);
  f.snapshot=f.workspace;f.selection.roots=['.'];
  const consumer=JSON.parse(await readFile(join(f.workspace,'package.json')));
  consumer.repository={url:'https://github.com/561-group/fixture.git'};
  if(options.omitEnrollment!==true)consumer.receivingPackages=Object.hasOwn(options,'enrollment')?options.enrollment:[name];
  const provider=JSON.parse(await readFile(join(f.workspace,'driver/package.json')));
  if(options.omitTests!==true)provider.receivingTests=Object.hasOwn(options,'tests')?options.tests:[testPath];
  if(Object.hasOwn(options,'providerEnrollment'))provider.receivingPackages=options.providerEnrollment;
  await f.put(f.workspace,'package.json',JSON.stringify(consumer));
  await f.put(f.workspace,'driver/package.json',JSON.stringify(provider));
  await f.put(f.workspace,'driver/'+testPath,testBody);
  await commitFixture(f);
  await f.put(f.runtime,'package.json',JSON.stringify(consumer));
  await f.put(f.provider,'package.json',JSON.stringify(provider));
  await f.put(f.provider,testPath,testBody);
  f.command.produced.files[0].sha256=hash(await readFile(join(f.runtime,'package.json')));
  return {...f,consumer,providerManifest:provider};
}

test('authenticated deploy consumer enrolls exact committed provider tests at their actual packed location',async t=>{
  const f=await commonFixture(t),received=await receiveWorkspaceRuntime(f);
  assert.deepEqual(received.sources.receivingPackages,[name]);
  const source=received.sources.packages.find(row=>row.name===name);
  assert.equal(source.installationPath,relative(f.runtime,f.provider));
  assert.equal(source.path,'driver');assert.equal(source.commit,f.selection.commit);
  assert.equal(source.sourceManifestSha256,manifestIdentity(f.providerManifest));
  assert.deepEqual(source.receiving,{version:1,manifest:f.providerManifest,tests:[{
    path:testPath,gitBlob:git(f.workspace,'rev-parse','HEAD:driver/'+testPath),sha256:hash(testBody),
  }]});
  assert.deepEqual(packageReceivingChecks(f.runtime,received.sources),[{name,directory:f.provider,tests:[join(f.provider,testPath)]}]);
  assert.equal(received.sources.packages.find(row=>row.installationPath==='.').sourceManifestSha256,manifestIdentity(f.consumer));
});

test('a nested deploy importer owns enrollment rather than the workspace root manifest',async t=>{
  const f=await commonFixture(t),consumer={...f.consumer,name:'@561-group/nested-consumer'};
  await f.put(f.workspace,'package.json',JSON.stringify({...f.consumer,receivingPackages:['@example/root-only']}));
  await f.put(f.workspace,'consumer/package.json',JSON.stringify(consumer));
  await f.put(f.workspace,'consumer/index.mjs',await readFile(join(f.workspace,'index.mjs')));
  f.selection.importerIds.push('consumer');f.selection.manifestHashes.consumer='pending committed fixture';f.selection.roots=['consumer'];
  await commitFixture(f);
  await f.put(f.runtime,'package.json',JSON.stringify(consumer));
  f.command.arguments[1]=consumer.name;f.command.produced.files[0].sha256=hash(await readFile(join(f.runtime,'package.json')));
  f.compilation.inspectedPackages.find(row=>row.directory===f.runtime).name=consumer.name;
  const received=await receiveWorkspaceRuntime(f);
  assert.deepEqual(received.sources.receivingPackages,[name]);
  const root=received.sources.packages.find(row=>row.installationPath==='.');
  assert.equal(root.name,consumer.name);assert.equal(root.path,'consumer');
  assert.equal(root.sourceManifestSha256,manifestIdentity(consumer));
});

test('an enrolled mounted provider retains its own commit and test blob identity',async t=>{
  const mountedName='@red-cup-engineering/guix-machine-release-service',mountedTest='scripts/receive-test.mjs';
  const f=await commonFixture(t,{enrollment:[mountedName]}),source=join(f.workspace,'controller');
  const manifest=JSON.parse(await readFile(join(source,'package.json')));manifest.receivingTests=[mountedTest];
  await f.put(source,'package.json',JSON.stringify(manifest));await f.put(source,mountedTest,testBody);
  git(source,'add','.');git(source,'commit','-qm','mounted receiving fixture');const commit=git(source,'rev-parse','HEAD');
  f.selection.sourceMounts.find(row=>row.path==='controller').revision=commit;await commitFixture(f);
  const packed=join(f.runtime,'node_modules/.pnpm/controller/node_modules',mountedName);
  for(const path of ['package.json','scripts/receive.scm','scripts/check-host.mjs',mountedTest])
    await f.put(packed,path,await readFile(join(source,path)));
  const alias=join(f.runtime,'node_modules',mountedName);await mkdir(dirname(alias),{recursive:true});await symlink(relative(dirname(alias),packed),alias);
  f.compilation.inspectedPackages.push({name:mountedName,version:manifest.version,directory:packed});
  const received=await receiveWorkspaceRuntime(f),provider=received.sources.packages.find(row=>row.name===mountedName);
  assert.equal(provider.repository,'red-cup-engineering/guix-machine-release-service');
  assert.equal(provider.path,'.');assert.equal(provider.commit,commit);assert.notEqual(provider.commit,f.selection.commit);
  assert.equal(provider.receiving.tests[0].gitBlob,git(source,'rev-parse','HEAD:'+mountedTest));
  assert.equal(provider.receiving.tests[0].sha256,hash(testBody));
  assert.deepEqual(packageReceivingChecks(f.runtime,received.sources),[{name:mountedName,directory:packed,tests:[join(packed,mountedTest)]}]);
});

for(const [label,options] of [['omitted',{omitEnrollment:true}],['empty',{enrollment:[]}]] )
  test(label+' consumer enrollment remains explicit absence of package checks',async t=>{
    const f=await commonFixture(t,options),received=await receiveWorkspaceRuntime(f);
    assert.deepEqual(received.sources.receivingPackages,[]);
    assert.ok(received.sources.packages.every(row=>row.receiving===undefined));
    assert.deepEqual(packageReceivingChecks(f.runtime,received.sources),[]);
  });

for(const [label,enrollment] of [['null',null],['string',name],['object',{}],['invalid name',['../other']],['empty name',['']],['nonstring name',[1]],['duplicate',[name,name]]])
  test('malformed '+label+' enrollment refuses rather than becoming empty',async t=>{
    const f=await commonFixture(t,{enrollment});
    await assert.rejects(receiveWorkspaceRuntime(f),/receivingPackages must contain unique package names/);
  });

test('enrollment cannot add an unselected provider',async t=>{
  const f=await commonFixture(t,{enrollment:['@example/unselected']});
  await assert.rejects(receiveWorkspaceRuntime(f),/common receiving provider is not uniquely selected/);
});
test('selected but unobserved enrolled provider refuses',async t=>{
  const f=await commonFixture(t);f.compilation.inspectedPackages=f.compilation.inspectedPackages.filter(row=>row.name!==name);
  await assert.rejects(receiveWorkspaceRuntime(f),/portable receiving provider is absent/);
});
test('enrollment cannot survive an omitted compiler observation of its actual consumer',async t=>{
  const f=await commonFixture(t);f.compilation.inspectedPackages=f.compilation.inspectedPackages.filter(row=>row.name!==f.consumer.name);
  await assert.rejects(receiveWorkspaceRuntime(f),/portable receiving consumer must be observed at the actual deploy root/);
});
test('a nonroot copy cannot replace the compiler observation of the deploy consumer',async t=>{
  const f=await commonFixture(t),copy=join(f.runtime,'node_modules/.pnpm/consumer/node_modules',f.consumer.name);
  await f.put(copy,'package.json',JSON.stringify(f.consumer));
  const alias=join(f.runtime,'node_modules',f.consumer.name);await mkdir(dirname(alias),{recursive:true});
  await symlink(relative(dirname(alias),copy),alias);
  f.compilation.inspectedPackages.find(row=>row.name===f.consumer.name).directory=copy;
  await assert.rejects(receiveWorkspaceRuntime(f),/portable receiving consumer must be observed at the actual deploy root/);
});
test('a dependency cannot enroll packages on behalf of the actual deploy consumer',async t=>{
  const f=await commonFixture(t,{omitEnrollment:true,providerEnrollment:['@example/unselected']});
  assert.deepEqual((await receiveWorkspaceRuntime(f)).sources.receivingPackages,[]);
});
test('the deploy command is authenticated before malformed enrollment is interpreted',async t=>{
  const f=await commonFixture(t,{enrollment:null});f.command.arguments[1]='@example/other';
  await assert.rejects(receiveWorkspaceRuntime(f),/portable command differs from selected deployment/);
});
test('the actual deploy owner must be an explicit selected root before enrollment',async t=>{
  const f=await commonFixture(t);f.selection.roots=['driver'];
  await assert.rejects(receiveWorkspaceRuntime(f),/portable entry owner is outside the explicitly admitted roots/);
});
test('working consumer policy cannot substitute for its original committed manifest',async t=>{
  const f=await commonFixture(t),consumer={...f.consumer,receivingPackages:[]};
  await f.put(f.workspace,'package.json',JSON.stringify(consumer));
  f.selection.sourceHashes['package.json']=hash(await readFile(join(f.workspace,'package.json')));
  f.selection.manifestHashes['.']=f.selection.sourceHashes['package.json'];
  await assert.rejects(receiveWorkspaceRuntime(f),/tracked changes/);
});
test('packed consumer policy cannot substitute for its original committed manifest',async t=>{
  const f=await commonFixture(t);await f.put(f.runtime,'package.json',JSON.stringify({...f.consumer,receivingPackages:[]}));
  await assert.rejects(receiveWorkspaceRuntime(f),/portable product differs from successful producer bytes/);
});
test('a refreshed packed manifest digest still cannot replace committed consumer enrollment',async t=>{
  const f=await commonFixture(t);await f.put(f.runtime,'package.json',JSON.stringify({...f.consumer,receivingPackages:[]}));
  f.command.produced.files[0].sha256=hash(await readFile(join(f.runtime,'package.json')));
  await assert.rejects(receiveWorkspaceRuntime(f),/portable manifest body differs from committed source/);
});
test('selected provider must own an explicit receivingTests declaration',async t=>{
  const f=await commonFixture(t,{omitTests:true});
  await assert.rejects(receiveWorkspaceRuntime(f),/common receiving provider lacks its own receivingTests/);
});
for(const tests of [null,[],[testPath,testPath],['../outside.mjs']])
  test('invalid explicit receivingTests '+JSON.stringify(tests)+' refuses',async t=>{
    const f=await commonFixture(t,{tests});
    await assert.rejects(receiveWorkspaceRuntime(f),/invalid receivingTests declaration/);
  });
test('uncommitted or missing declared test has no receivable source identity',async t=>{
  const f=await commonFixture(t,{tests:['test/missing.test.mjs']});
  await assert.rejects(receiveWorkspaceRuntime(f),/selected source file is not a committed regular carrier/);
});
test('changed packed declared test bytes refuse',async t=>{
  const f=await commonFixture(t);await f.put(f.provider,testPath,testBody+'// altered\n');
  await assert.rejects(receiveWorkspaceRuntime(f),/portable payload differs from committed source/);
});
test('an omitted packed test refuses even when every remaining packed file matches',async t=>{
  const f=await commonFixture(t);await rm(join(f.provider,testPath));
  await assert.rejects(receiveWorkspaceRuntime(f),{code:'ENOENT'});
});
test('a committed symlink cannot supply a declared test blob',async t=>{
  const f=await commonFixture(t);await rm(join(f.workspace,'driver',testPath));
  await symlink('../feltos.mjs',join(f.workspace,'driver',testPath));await commitFixture(f);
  await assert.rejects(receiveWorkspaceRuntime(f),/selected source file is not a committed regular carrier/);
});
test('a packed symlink cannot replace a declared test carrier',async t=>{
  const f=await commonFixture(t);await rm(join(f.provider,testPath));
  await symlink('../feltos.mjs',join(f.provider,testPath));
  await assert.rejects(receiveWorkspaceRuntime(f),/workspace payload is not a regular source carrier/);
});
test('an enrolled provider cannot redirect its selected packed directory',async t=>{
  const f=await commonFixture(t),moved=f.provider+'-moved';await rename(f.provider,moved);
  await symlink(relative(join(f.provider,'..'),moved),f.provider);
  await assert.rejects(receiveWorkspaceRuntime(f),/compiler provider location is redirected/);
});
test('a selected source manifest cannot redirect to another working carrier',async t=>{
  const f=await commonFixture(t),file=join(f.workspace,'driver/package.json'),body=await readFile(file);
  await writeFile(join(f.workspace,'driver/manifest-copy.json'),body);await rm(file);await symlink('manifest-copy.json',file);
  await assert.rejects(receiveWorkspaceRuntime(f),/regular|redirect/);
});
