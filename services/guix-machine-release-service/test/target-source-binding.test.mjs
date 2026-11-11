import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fixture} from './fixtures/portable-source-fixture.mjs';
import {workspaceReceiverInputs} from '../scripts/workspace-selection-sources.mjs';

function git(root,...args){
  const result=spawnSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-C',root,...args],
    {encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});
  assert.equal(result.status,0,result.stderr);return result.stdout.trim();
}
async function target(f,name){
  const root=join(f.outer,name);await mkdir(root);git(root,'init','-q');
  const snapshot=join(root,'definition'),repository='561-group/'+name;
  for(const [path,body] of Object.entries({
    'machine.json':JSON.stringify({name,repository,run:{entries:['@red-cup-engineering/feltos']}}),
    'machine.scm':'; committed target '+name+'\n','channels.scm':'; same admitted channel\n',
    'dependencies.lock.yaml':'historical: target\n',
    'deployment/host.json':JSON.stringify({instance:'instance.json',target:name}),
    'deployment/instance.json':JSON.stringify({profile:'../profiles/profile.json'}),
    'profiles/profile.json':JSON.stringify({target:name}),
  }))await f.put(snapshot,path,body);
  git(root,'add','.');git(root,'commit','-qm','target fixture');
  return {snapshot,repository,commit:git(root,'rev-parse','HEAD')};
}
test('two independently committed targets retain the exact same selected software sources',async t=>{
  const f=await fixture(t,{includeRuntime:false}),a=await target(f,'peer-a'),b=await target(f,'peer-b');
  const left=await workspaceReceiverInputs({...f,target:a}),right=await workspaceReceiverInputs({...f,target:b});
  assert.deepEqual(left.sources,right.sources);assert.deepEqual(left.carriers,right.carriers);
  assert.deepEqual(left.softwareIdentity,right.softwareIdentity);
  assert.equal(left.softwareIdentity.commit,f.selection.commit);assert.equal(left.softwareIdentity.repository,'561-group/fixture');
  assert.equal(left.identity.repository,a.repository);assert.equal(left.identity.commit,a.commit);
  assert.equal(right.identity.repository,b.repository);assert.equal(right.identity.commit,b.commit);
  assert.notEqual(left.identity.commit,right.identity.commit);
  assert.deepEqual(left.controllerFiles,right.controllerFiles);
  assert.notDeepEqual(left.deploymentFiles,right.deploymentFiles);
});
test('swapping a target carrier cannot borrow the expected repository or commit',async t=>{
  const f=await fixture(t,{includeRuntime:false}),a=await target(f,'peer-a'),b=await target(f,'peer-b');
  await assert.rejects(workspaceReceiverInputs({...f,target:{...b,repository:a.repository}}),/differs from its expected source identity/);
  await assert.rejects(workspaceReceiverInputs({...f,target:{...b,commit:a.commit}}),/git rev-parse/);
  await assert.rejects(workspaceReceiverInputs({...f,target:{...a,commit:f.selection.commit}}),/git rev-parse/);
});
test('uncommitted target edits never become deployment or identity evidence',async t=>{
  const f=await fixture(t,{includeRuntime:false}),a=await target(f,'peer-a');
  const before=await workspaceReceiverInputs({...f,target:a});
  await writeFile(join(a.snapshot,'deployment/host.json'),'{"forged":true}');
  await writeFile(join(a.snapshot,'machine.json'),'{"repository":"foreign/claim"}');
  const after=await workspaceReceiverInputs({...f,target:a});
  assert.deepEqual(after.identity,before.identity);assert.deepEqual(after.deploymentFiles,before.deploymentFiles);
  assert.notDeepEqual(after.deploymentFiles.find(row=>row.path==='deployment/host.json').bytes,await readFile(join(a.snapshot,'deployment/host.json')));
});
test('target demand outside the common selected software still refuses',async t=>{
  const f=await fixture(t,{includeRuntime:false}),a=await target(f,'peer-a');
  const machine=JSON.parse(await readFile(join(a.snapshot,'machine.json')));machine.run.entries.push('@example/unselected');
  await writeFile(join(a.snapshot,'machine.json'),JSON.stringify(machine));git(a.snapshot,'add','.');git(a.snapshot,'commit','-qm','new target demand');a.commit=git(a.snapshot,'rev-parse','HEAD');
  await assert.rejects(workspaceReceiverInputs({...f,target:a}),/outside installed selection/);
});
