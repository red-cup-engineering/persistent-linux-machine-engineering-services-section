import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,readFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {verifyMachineDirectory} from '../scripts/machine-directory.mjs';
import {readCommittedConsumerBinding} from '../scripts/project-release-caller.mjs';
for(const prefix of ['', 'lib/group/services/bare-cedar-fog/data/records/metroplat'])test(`machine admission scopes exact committed definitions (${prefix||'standalone'})`,()=>{
 const root=mkdtempSync(join(tmpdir(),'machine-directory-')),directory=join(root,prefix);
 const git=(...args)=>{const r=spawnSync('git',['-C',root,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 try{
  mkdirSync(directory,{recursive:true});git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('config','commit.gpgsign','false');
  for(const name of ['machine.json','machine.scm','channels.scm','dependencies.lock.yaml'])writeFileSync(join(directory,name),'{}\n');
  if(prefix){mkdirSync(join(root,'lib/application'),{recursive:true});writeFileSync(join(root,'lib/application/program.mjs'),'export default 42;');}
  git('add','.');git('commit','-m','machine and independently owned application');
  assert.equal(verifyMachineDirectory(directory).prefix,prefix?prefix+'/':'');
  git('update-index','--assume-unchanged',join(prefix,'machine.json'));writeFileSync(join(directory,'machine.json'),'changed');
  assert.throws(()=>verifyMachineDirectory(directory),/differs from committed/);
  writeFileSync(join(directory,'machine.json'),'{}\n');git('update-index','--no-assume-unchanged',join(prefix,'machine.json'));
  // The machine releases from its repository and gitlinks: a sources.json in its definition is refused.
  writeFileSync(join(directory,'sources.json'),'{}\n');git('add','.');git('commit','-m','a retired pin file');
  assert.throws(()=>verifyMachineDirectory(directory),/undeclared application source: sources\.json/);
  git('rm','-q',join(prefix,'sources.json'));git('commit','-m','without it');
  writeFileSync(join(directory,'application.mjs'),'export default 1');git('add','.');git('commit','-m','invalid machine-local executable');
  assert.throws(()=>verifyMachineDirectory(directory),/undeclared application source/);
  git('rm',join(prefix,'application.mjs'));symlinkSync('/etc/passwd',join(directory,'external'));git('add','.');git('commit','-m','invalid external link');
  assert.throws(()=>verifyMachineDirectory(directory),/undeclared application source|Unsupported/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('a machine at its repository root may mount repositories by gitlink; one inside a larger repository may not',()=>{
 for(const prefix of ['','records/machine']){
  const root=mkdtempSync(join(tmpdir(),'machine-directory-mounts-')),directory=join(root,prefix);
  const git=(...args)=>{const r=spawnSync('git',['-C',root,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
  try{
   mkdirSync(directory,{recursive:true});git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('config','commit.gpgsign','false');
   for(const name of ['machine.json','machine.scm','channels.scm','dependencies.lock.yaml'])writeFileSync(join(directory,name),'{}\n');
   writeFileSync(join(directory,'.gitmodules'),'[submodule "lib/a"]\n\tpath = lib/a\n\turl = https://github.com/o/a.git\n');
   mkdirSync(join(directory,'lib/a'),{recursive:true});
   git('add','.');git('update-index','--add','--cacheinfo',`160000,${'a'.repeat(40)},${join(prefix,'lib/a')}`);git('commit','-m','a machine that mounts');
   if(prefix)assert.throws(()=>verifyMachineDirectory(directory),/inside a larger repository: lib\/a/);
   else assert.equal(verifyMachineDirectory(directory).prefix,'');
  }finally{rmSync(root,{recursive:true,force:true});}
 }
});


for(const prefix of ['', 'records/machine'])test(`optional committed consumer declaration is exact data, not arbitrary machine code (${prefix||'root'})`,()=>{
 const root=mkdtempSync(join(tmpdir(),'machine-binding-')),directory=join(root,prefix),file=join(directory,'release-consumer.json');
 const git=(...args)=>{const r=spawnSync('git',['-C',root,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 const commit=()=>{git('add','.');git('commit','-qm','fixture state');};
 try{
  mkdirSync(directory,{recursive:true});git('init','-qb','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('config','commit.gpgsign','false');
  for(const name of ['machine.json','machine.scm','channels.scm','dependencies.lock.yaml'])writeFileSync(join(directory,name),'{}\n');
  const binding=JSON.parse(readFileSync(new URL('./fixtures/release-consumer-bindings.json',import.meta.url)))['cold-red-gate'];binding.definition=prefix||'.';
  const bytes=JSON.stringify(binding,null,2)+'\n';writeFileSync(file,bytes);commit();
  assert.equal(verifyMachineDirectory(directory).prefix,prefix?prefix+'/':'');assert.deepEqual(readCommittedConsumerBinding(file).binding,binding);
  git('update-index','--assume-unchanged',join(prefix,'release-consumer.json'));writeFileSync(file,bytes+' ');
  assert.throws(()=>verifyMachineDirectory(directory),/differs from committed/);assert.throws(()=>readCommittedConsumerBinding(file),/differs from its committed bytes/);
  writeFileSync(file,bytes);git('update-index','--no-assume-unchanged',join(prefix,'release-consumer.json'));
  for(const name of ['other-consumer.json','release-consumer-copy.json','consumer/release-consumer.json']){
   const target=join(directory,name);mkdirSync(join(target,'..'),{recursive:true});writeFileSync(target,bytes);commit();
   assert.throws(()=>verifyMachineDirectory(directory),/undeclared application source/);git('rm','-q',join(prefix,name));commit();
  }
  chmodSync(file,0o755);commit();assert.throws(()=>verifyMachineDirectory(directory),/Unsupported machine definition carrier: release-consumer.json/);
  chmodSync(file,0o644);writeFileSync(file,'{"kind":"unknown"}\n');commit();
  // Filesystem admission is not policy admission: the actual declaration reader still refuses.
  assert.doesNotThrow(()=>verifyMachineDirectory(directory));assert.throws(()=>readCommittedConsumerBinding(file),/binding/);
  rmSync(file);symlinkSync('machine.json',file);commit();assert.throws(()=>verifyMachineDirectory(directory),/Unsupported machine definition carrier/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
