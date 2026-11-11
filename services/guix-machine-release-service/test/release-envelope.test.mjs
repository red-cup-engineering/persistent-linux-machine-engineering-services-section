import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,lstat,symlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {writeReleaseEnvelope} from '../scripts/release-envelope.mjs';
import {pristineAssemblyEnvelope} from './fixtures/pristine-assembly-envelope.mjs';
async function fixture(t,{supervisor='systemd-user'}={}){
  const directory=await mkdtemp(join(tmpdir(),'release-envelope-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const snapshot=join(directory,'snapshot'),controller=join(directory,'controller'),closure=join(directory,'closure'),workspace=join(directory,'workspace');
  for(const path of [snapshot,controller,closure,workspace])await mkdir(path);
  await mkdir(join(controller,'scripts'));await writeFile(join(controller,'scripts/receive.scm'),'; inert owning receiver fixture\n');
  await mkdir(join(controller,'node_modules'));await writeFile(join(controller,'node_modules/producer-only'),'do not copy\n');
  const machine={name:'fixture-machine',repository:'561-group/fixture',supervisor,environmentFile:'/not-read/private.env'};
  for(const [name,body] of Object.entries({'machine.json':JSON.stringify(machine)+'\n','machine.scm':'; inert declared machine\n','channels.scm':'; pinned channel fixture\n','dependencies.lock.yaml':'historical: declaration\n'}))await writeFile(join(snapshot,name),body);
  const lock=Buffer.from('lockfileVersion: 9.0\n# retain exact bytes\n');
  const sourceImports=Buffer.from('{ "edges": [] }\n');
  const sources={packages:[{name:'fixture',version:'1.0.0',repository:'561-group/fixture',commit:'a'.repeat(40)}]};
  const dependencyEvidence=[{package:'fixture',version:'1.0.0',repository:'561-group/fixture',commit:'a'.repeat(40)}];
  await writeFile(join(workspace,'pnpm-lock.yaml'),lock);await writeFile(join(workspace,'source-imports.json'),sourceImports);
  const args={closure,snapshot,controller,lock,sources,sourceImports,dependencyEvidence,machineCommit:'a'.repeat(40),machineRepository:'561-group/fixture'};
  return {...args,args,directory,workspace};
}
async function files(directory){
  const result={};
  async function walk(path,prefix=''){for(const entry of await readdir(path,{withFileTypes:true})){
    const name=prefix+entry.name;if(entry.isDirectory())await walk(join(path,entry.name),name+'/');
    else result[name]=(await readFile(join(path,entry.name))).toString('base64');
  }}
  await walk(directory);return result;
}
async function legacy(f){
  const closure=join(f.directory,'legacy');await mkdir(join(closure,'node_modules/.pnpm'),{recursive:true});await writeFile(join(closure,'node_modules/.pnpm/lock.yaml'),f.lock);
  await pristineAssemblyEnvelope({...f,closure,providers:{'@red-cup-engineering/guix-machine-release-service':f.controller},environment:{GITHUB_SHA:f.machineCommit,GITHUB_REPOSITORY:f.machineRepository}});
  await rm(join(closure,'node_modules'),{recursive:true});return closure;
}
test('extracted owning envelope matches actual pristine assembler bytes',async t=>{
  const f=await fixture(t),before=await legacy(f);const release=await writeReleaseEnvelope(f.args);
  assert.deepEqual(await files(f.closure),await files(before));
  assert.equal(release.dependencyLockSha256,createHash('sha256').update(f.lock).digest('hex'));
  assert.deepEqual(await readFile(join(f.closure,'.metadata/source-imports.json')),f.sourceImports);
  await assert.rejects(lstat(join(f.closure,'.controller/node_modules')),{code:'ENOENT'});
});
test('existing Shepherd branch remains byte-identical without systemd storage templates',async t=>{
  const f=await fixture(t,{supervisor:'shepherd'}),before=await legacy(f);await writeReleaseEnvelope(f.args);
  assert.deepEqual(await files(f.closure),await files(before));
  await assert.rejects(lstat(join(f.closure,'.storage-systemd')),{code:'ENOENT'});
});
test('refuses existing envelope before creating any sibling output',async t=>{
  const f=await fixture(t);await mkdir(join(f.closure,'.controller'));await writeFile(join(f.closure,'.controller/retained'),'retain');
  const before=await files(f.closure);await assert.rejects(writeReleaseEnvelope(f.args),/already exists/);assert.deepEqual(await files(f.closure),before);
});
test('refuses redirected unpublished closure',async t=>{
  const f=await fixture(t),link=join(f.directory,'redirect');await symlink(f.closure,link);
  await assert.rejects(writeReleaseEnvelope({...f.args,closure:link}),/unredirected/);assert.deepEqual(await readdir(f.closure),[]);
});
test('missing fixed snapshot carrier refuses before output',async t=>{
  const f=await fixture(t);await rm(join(f.snapshot,'channels.scm'));
  await assert.rejects(writeReleaseEnvelope(f.args),{code:'ENOENT'});assert.deepEqual(await readdir(f.closure),[]);
});
test('controller copy failure cleans only owned envelope directories',async t=>{
  const f=await fixture(t);await writeFile(join(f.closure,'retained-application'),'app');
  await assert.rejects(writeReleaseEnvelope({...f.args,controller:join(f.directory,'absent')}),{code:'ENOENT'});
  assert.deepEqual(await readdir(f.closure),['retained-application']);assert.equal(await readFile(join(f.closure,'retained-application'),'utf8'),'app');
});
test('malformed machine unit name fails before output through existing unit provider',async t=>{
  const f=await fixture(t);await writeFile(join(f.snapshot,'machine.json'),JSON.stringify({name:'../../escape'}));
  await assert.rejects(writeReleaseEnvelope(f.args),/invalid machine unit name/);assert.deepEqual(await readdir(f.closure),[]);
});
test('requires original metadata byte carriers',async t=>{
  const f=await fixture(t);await assert.rejects(writeReleaseEnvelope({...f.args,lock:'reformatted'}),/original lock/);assert.deepEqual(await readdir(f.closure),[]);
});
