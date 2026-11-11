import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {workspaceSelectionSources} from '../scripts/workspace-selection-sources.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
function git(root,...args){const r=spawnSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-C',root,...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'workspace-source-projection-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const child=join(directory,'child'),workspace=join(directory,'workspace'),artifact=join(directory,'receipt');
  for(const p of [child,workspace,artifact])await mkdir(p);
  git(child,'init','-q');await mkdir(join(child,'test'));await writeFile(join(child,'test/check.mjs'),'// inert declared receiving test\n');
  await writeFile(join(child,'package.json'),JSON.stringify({name:'@red-cup-engineering/example',version:'1.0.0',receivingTests:['test/check.mjs']})+'\n');
  git(child,'add','.');git(child,'commit','-qm','child fixture');const childCommit=git(child,'rev-parse','HEAD');
  git(workspace,'init','-q');await writeFile(join(workspace,'package.json'),'{"name":"@561-group/fixture","version":"1.0.0"}\n');await writeFile(join(workspace,'pnpm-workspace.yaml'),"packages: ['a']\n");await writeFile(join(workspace,'pnpm-lock.yaml'),'lockfileVersion: 9.0\n');
  const snapshot=join(workspace,'deployment');await mkdir(snapshot);await writeFile(join(snapshot,'machine.json'),JSON.stringify({name:'fixture',repository:'561-group/fixture',run:{entries:['@red-cup-engineering/example'],receivingPackages:['@red-cup-engineering/example']}})+'\n');
  git(workspace,'-c','protocol.file.allow=always','submodule','add','-q',child,'a');git(workspace,'config','-f','.gitmodules','submodule.a.url','https://github.com/red-cup-engineering/example.git');
  git(workspace,'add','.');git(workspace,'commit','-qm','machine fixture');
  const sourceHashes={};for(const path of ['package.json','pnpm-workspace.yaml','pnpm-lock.yaml'])sourceHashes[path]=hash(await readFile(join(workspace,path)));
  const manifestHashes={};for(const id of ['.','a'])manifestHashes[id]=hash(await readFile(join(workspace,id,'package.json')));
  const lock=await readFile(join(workspace,'pnpm-lock.yaml'));await writeFile(join(artifact,'pnpm-lock.yaml'),lock);
  const selection={type:'NodeRuntimeWorkspaceSelectionInstallReceipt',version:1,status:'installed',sourceConfigurationUnchanged:true,workspace,commit:git(workspace,'rev-parse','HEAD'),artifact,scopedLockSha256:hash(lock),sourceHashes,manifestHashes,importerIds:['.','a'],sourceMounts:[{path:'a',revision:childCommit}]};
  return {directory,workspace,artifact,snapshot,selection,childCommit};
}
test('genuine verifier and committed edges project exact existing source facts',async t=>{
  const f=await fixture(t),r=await workspaceSelectionSources(f);
  assert.equal(r.sources.sourceGraphSha256,undefined);assert.equal(r.identity.repository,'561-group/fixture');
  assert.deepEqual(r.sources.repositories,[{repository:'561-group/fixture',commit:f.selection.commit,path:'.',paths:['.']},{repository:'red-cup-engineering/example',commit:f.childCommit,path:'a',paths:['a']}]);
  const p=r.sources.packages.find(p=>p.name==='@red-cup-engineering/example');assert.equal(p.path,'.');assert.equal(p.repository,'red-cup-engineering/example');assert.equal(p.commit,f.childCommit);
  assert.equal(p.receiving.tests[0].gitBlob,git(join(f.workspace,'a'),'rev-parse','HEAD:test/check.mjs'));
  assert.equal(p.receiving.tests[0].sha256,hash(await readFile(join(f.workspace,'a/test/check.mjs'))));
});
test('Code receipt rejects changed child revision before projection',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'a/new'),'changed');git(join(f.workspace,'a'),'add','.');git(join(f.workspace,'a'),'commit','-qm','changed');
  await assert.rejects(workspaceSelectionSources(f),/differs from recorded source/);
});
test('cannot turn a changed working manifest into committed package evidence',async t=>{
  const f=await fixture(t);const file=join(f.workspace,'a/package.json');await writeFile(file,'{"name":"@red-cup-engineering/forged","version":"1.0.0"}\n');f.selection.manifestHashes.a=hash(await readFile(file));
  await assert.rejects(workspaceSelectionSources(f),/tracked changes/);
});
test('authored receiver demand outside installed selection refuses',async t=>{
  const f=await fixture(t);const file=join(f.snapshot,'machine.json');const m=JSON.parse(await readFile(file));m.run.entries.push('@red-cup-engineering/missing');await writeFile(file,JSON.stringify(m));git(f.workspace,'add','.');git(f.workspace,'commit','-qm','missing demand');f.selection.commit=git(f.workspace,'rev-parse','HEAD');
  await assert.rejects(workspaceSelectionSources(f),/outside installed selection/);
});
test('working machine declaration cannot replace committed identity',async t=>{
  const f=await fixture(t);await writeFile(join(f.snapshot,'machine.json'),'{"repository":"foreign/claim"}');await assert.rejects(workspaceSelectionSources(f),/tracked changes/);
});
test('selected root mount URL must have existing supported GitHub custody',async t=>{
  const f=await fixture(t);git(f.workspace,'config','-f','.gitmodules','submodule.a.url','file:///unrelated');git(f.workspace,'add','.gitmodules');git(f.workspace,'commit','-qm','unsupported URL');f.selection.commit=git(f.workspace,'rev-parse','HEAD');
  await assert.rejects(workspaceSelectionSources(f),/unsupported URL/);
});
