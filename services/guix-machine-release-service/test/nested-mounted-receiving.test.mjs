import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync,readFileSync,renameSync,symlinkSync,linkSync,unlinkSync,chmodSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {receive} from '../scripts/receive-pull-requests.mjs';
import {machineSources} from '../scripts/source-pins.mjs';
import {testChange} from '../scripts/test-change.mjs';
import {exportChangeSources,verifyChangeSources,prepareExportedComparison} from '../scripts/materialize-sources.mjs';

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'nested-receiving-'));
  const saved=new Map();
  t.after(()=>{for(const [key,value] of saved)value===undefined?delete process.env[key]:process.env[key]=value;rmSync(root,{recursive:true,force:true});});
  const git=(cwd,...args)=>{
    const result=spawnSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false',...args],
      {cwd,encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ALLOW_PROTOCOL:'file'},timeout:10000});
    assert.equal(result.status,0,result.stderr);return result.stdout.trim();
  };
  const repo=(name,files={},mounts=[])=>{
    const directory=join(root,name);mkdirSync(directory,{recursive:true});git(directory,'init','-q','-b','main');
    for(const [path,body] of Object.entries(files)){mkdirSync(dirname(join(directory,path)),{recursive:true});writeFileSync(join(directory,path),body);}
    if(mounts.length)writeFileSync(join(directory,'.gitmodules'),mounts.map(({repository,path,ref='main'})=>
      `[submodule "${path}"]\n path = ${path}\n url = https://github.com/${repository}.git\n branch = ${ref}\n`).join(''));
    git(directory,'add','.');for(const mount of mounts){mkdirSync(join(directory,mount.path),{recursive:true});git(directory,'update-index','--add','--cacheinfo',`160000,${mount.commit},${mount.path}`);}
    git(directory,'commit','-q','--allow-empty','-m','source');return {directory,commit:git(directory,'rev-parse','HEAD')};
  };
  const child=repo('child',{'package.json':JSON.stringify({name:'@fixture/child',version:'1.0.0'}),'source.mjs':'export const value=1;\n'});
  const parent=repo('parent',{},[{repository:'fixture/child',path:'nested/child',commit:child.commit,ref:'release/child'}]);
  const machine=repo('machine',{'machine.json':JSON.stringify({repository:'fixture/machine',run:{entries:['@fixture/child']}})},
    [{repository:'fixture/parent',path:'mounted/parent',commit:parent.commit}]);
  const entries=[['fixture/child',child.directory],['fixture/parent',parent.directory]];
  const env={GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ALLOW_PROTOCOL:'file',GIT_CONFIG_COUNT:String(entries.length)};
  entries.forEach(([repository,path],i)=>{env[`GIT_CONFIG_KEY_${i}`]=`url.file://${path}.insteadOf`;env[`GIT_CONFIG_VALUE_${i}`]=`https://github.com/${repository}.git`;});
  for(const [key,value] of Object.entries(env)){saved.set(key,process.env[key]);process.env[key]=value;}
  return {root,git,child,parent,machine};
}

test('ordinary dry-run receives the exact recursive owners and tracked refs before selecting pending PRs',t=>{
  const {root,machine}=fixture(t),reads=[];
  const result=receive({snapshot:machine.directory,work:join(root,'work'),dryRun:true,
    github:{openPulls:(repository,ref)=>{reads.push([repository,ref]);return [];},commentOnPull:()=>assert.fail('dry-run must not comment')},
    testChange:()=>assert.fail('dry-run must not execute candidate code'),fetch:()=>assert.fail('dry-run must not fetch PR code')});
  assert.deepEqual(reads,[['fixture/parent','main'],['fixture/child','release/child']]);
  assert.deepEqual(result.received,[]);
});

test('a nested owner behind its exact mounted pin receives the genuine incomplete ancestry verdict',async t=>{
  const {root,git,child,parent,machine}=fixture(t);
  git(child.directory,'checkout','-q','--orphan','unrelated');git(child.directory,'rm','-qrf','.');
  writeFileSync(join(child.directory,'unrelated'),'unrelated history');git(child.directory,'add','.');git(child.directory,'commit','-qm','unrelated');
  const result=await testChange({snapshot:machine.directory,work:join(root,'work'),changes:new Map([['fixture/child',child.directory]]),
    localSources:new Map([['fixture/parent',parent.directory],['fixture/child',child.directory]])});
  assert.equal(result.verdict,'incomplete');assert.equal(result.break.class,'head-behind-pin');
  assert.equal(result.break.repositories[0].repository,'fixture/child');assert.deepEqual(result.packages,[]);
});

test('a changed parent mount resolves each graph before the original missing-lock refusal',async t=>{
  const {root,git,child,parent,machine}=fixture(t);
  writeFileSync(join(child.directory,'source.mjs'),'export const value=2;\n');git(child.directory,'commit','-qam','child successor');
  const next=git(child.directory,'rev-parse','HEAD');
  git(parent.directory,'update-index','--cacheinfo',`160000,${next},nested/child`);git(parent.directory,'commit','-qm','advance child');
  const result=await testChange({snapshot:machine.directory,work:join(root,'work'),changes:new Map([['fixture/parent',parent.directory]]),
    localSources:new Map([['fixture/parent',parent.directory],['fixture/child',child.directory]])});
  assert.equal(result.verdict,'not-composed');assert.match(result.reason,/reviewed dependency lock is missing/);
  assert.equal(result.baselineGraph.repositories.find(row=>row.repository==='fixture/child').commit,child.commit);
  assert.equal(result.candidateGraph.repositories.find(row=>row.repository==='fixture/child').commit,next);
  assert.equal(result.sourcePlan.delta.length,2);
  assert.deepEqual(result.packages,[]);
});

test('inert export carries genuine complete nested base/head Git objects after origins are gone',t=>{
  const {root,git,child,parent,machine}=fixture(t);
  git(child.directory,'config','uploadpack.allowFilter','true');git(child.directory,'config','uploadpack.allowAnySHA1InWant','true');
  git(child.directory,'config','http.extraheader','Authorization: fixture-source-secret');
  // Keep a genuinely missing historical blob in an unchanged supplier. The
  // current-tree resolver does not need it; full-code export must acquire it.
  writeFileSync(join(parent.directory,'history.mjs'),'export const prior=1;\n');git(parent.directory,'add','.');git(parent.directory,'commit','-qm','prior history');
  writeFileSync(join(parent.directory,'history.mjs'),'export const prior=2;\n');git(parent.directory,'commit','-qam','current history');
  git(machine.directory,'update-index','--cacheinfo',`160000,${git(parent.directory,'rev-parse','HEAD')},mounted/parent`);git(machine.directory,'commit','-qm','parent history');
  git(parent.directory,'config','uploadpack.allowFilter','true');git(parent.directory,'config','uploadpack.allowAnySHA1InWant','true');
  const originalConfig=readFileSync(join(child.directory,'.git/config'),'utf8');
  writeFileSync(join(child.directory,'source.mjs'),'throw new Error("candidate must never execute while reading sources");\n');
  git(child.directory,'commit','-qam','candidate');const head=git(child.directory,'rev-parse','HEAD');
  const work=join(root,'export');
  let missingObserved=0;
  const run=(program,args,input)=>{
    assert.equal(program,'git','no candidate parser, interpreter, build or package manager may run');
    const result=spawnSync(program,args,{encoding:'utf8',input,timeout:10000});assert.equal(result.status,0,result.stderr);
    if(args.includes('--missing=print'))missingObserved+=result.stdout.split('\n').filter(line=>line.startsWith('?')).length;
    return result.stdout.trim();
  };
  const {receipt,sha256}=exportChangeSources(machine.directory,work,new Map([['fixture/child',child.directory]]),{run});
  assert.ok(missingObserved>0,'a genuine partial clone requires source hydration');
  assert.equal(readFileSync(join(child.directory,'.git/config'),'utf8'),originalConfig,'original reader configuration is untouched');
  assert.equal(receipt.scope,'complete-code-comparison-carriers');assert.equal(receipt.runtimeAcceptance,false);
  assert.deepEqual(receipt.sources.map(row=>row.repository),['fixture/child','fixture/machine','fixture/parent']);
  renameSync(child.directory,child.directory+'-unavailable');renameSync(parent.directory,parent.directory+'-unavailable');renameSync(machine.directory,machine.directory+'-unavailable');
  assert.deepEqual(verifyChangeSources(work,sha256),receipt);
  const source=receipt.sources.find(row=>row.repository==='fixture/child');
  assert.equal(source.selected.commit,head);assert.equal(source.pin.commit,child.commit);
  assert.equal(git(join(work,source.directory),'show',`${child.commit}:source.mjs`),'export const value=1;');
  assert.match(git(join(work,source.directory),'show',`${head}:source.mjs`),/candidate must never execute/);
  assert.doesNotMatch(readFileSync(join(work,source.directory,'.git/config'),'utf8'),/token|credential|insteadOf|extraheader|\/tmp\//i);
  const comparison=prepareExportedComparison(work,sha256,join(root,'comparison'));
  assert.equal(git(comparison.snapshot,'rev-parse','HEAD'),receipt.snapshot.commit);
  assert.equal(comparison.changes[0].commit,head);
  assert.deepEqual(comparison.localSources.map(([repository])=>repository),['fixture/child','fixture/parent']);
  assert.deepEqual(verifyChangeSources(work,sha256),receipt,'forming writable comparison does not mutate artifact custody');
  writeFileSync(join(work,'unexpected'),'artifact contamination');
  assert.throws(()=>verifyChangeSources(work,sha256),/inventory differs/);
  assert.throws(()=>verifyChangeSources(work,'0'.repeat(64)),/digest/);
});

test('an over-budget source export cannot receive a complete artifact receipt',t=>{
  const {root,child,machine}=fixture(t);
  assert.throws(()=>exportChangeSources(machine.directory,join(root,'limited'),new Map([['fixture/child',child.directory]]),{maxBytes:1}),/artifact size or file limit/);
  assert.throws(()=>verifyChangeSources(join(root,'limited'),'0'.repeat(64)),/ENOENT/);
});


test('receiving refuses symlinks, shared storage, alternate stores, modes and configuration tampering',t=>{
  const {root,child,machine}=fixture(t),work=join(root,'tamper');
  const {receipt,sha256}=exportChangeSources(machine.directory,work,new Map([['fixture/child',child.directory]]));
  const directory=join(work,receipt.sources.find(row=>row.repository==='fixture/child').directory);
  const config=join(directory,'.git/config'),original=readFileSync(config),mode=statSync(config).mode&0o777;
  symlinkSync(config,join(work,'redirect'));assert.throws(()=>verifyChangeSources(work,sha256),/not regular/);unlinkSync(join(work,'redirect'));
  linkSync(config,join(root,'shared'));assert.throws(()=>verifyChangeSources(work,sha256),/shares file storage/);unlinkSync(join(root,'shared'));
  const alternate=join(directory,'.git/objects/info/alternates');mkdirSync(dirname(alternate),{recursive:true});
  writeFileSync(alternate,join(child.directory,'.git/objects')+'\n');assert.throws(()=>verifyChangeSources(work,sha256),/inventory differs/);unlinkSync(alternate);
  chmodSync(config,mode^0o100);assert.throws(()=>verifyChangeSources(work,sha256),/inventory differs/);chmodSync(config,mode);
  writeFileSync(config,Buffer.concat([original,Buffer.from('\n[credential]\n helper = malicious\n')]));
  assert.throws(()=>verifyChangeSources(work,sha256),/inventory differs/);writeFileSync(config,original);
  const manifest=join(work,'source-carriers.json'),bytes=readFileSync(manifest);
  writeFileSync(manifest,Buffer.concat([bytes,Buffer.from(' ')]));assert.throws(()=>verifyChangeSources(work,sha256),/preparation digest/);writeFileSync(manifest,bytes);
  assert.deepEqual(verifyChangeSources(work,sha256),receipt);
});

// Actual ordinary metadata acquisition uses only fixture file:// origins.
test('ordinary recursive declaration hydrates mount metadata without claiming complete source custody',t=>{
  const f=fixture(t),cache=join(f.root,'cache'),previous=process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME=cache;t.after(()=>{if(previous===undefined)delete process.env.XDG_CACHE_HOME;else process.env.XDG_CACHE_HOME=previous;});
  for(const source of [f.parent,f.child]){f.git(source.directory,'config','uploadpack.allowFilter','true');f.git(source.directory,'config','uploadpack.allowAnySHA1InWant','true');}
  const spec=machineSources(f.machine.directory);
  assert.deepEqual(spec.repositories.map(source=>source.repository),['fixture/machine','fixture/parent','fixture/child']);
  assert.equal(spec.declarationOnly,true);assert.equal(spec.graphSha256,undefined);
  const child=join(cache,'561-group/mounted-sources',encodeURIComponent('fixture/child'));
  const blob=f.git(f.child.directory,'rev-parse',f.child.commit+':source.mjs');
  const missing=spawnSync('git',['-C',child,'cat-file','--batch-check'],{input:blob+'\n',encoding:'utf8',env:{PATH:process.env.PATH,GIT_NO_LAZY_FETCH:'1',GIT_ALLOW_PROTOCOL:'',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
  assert.equal(missing.status,0);assert.equal(missing.stdout.trim(),blob+' missing');
});
