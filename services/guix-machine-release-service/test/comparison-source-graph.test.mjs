import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {comparisonSources,materializeSources,exportChangeSources,verifyChangeSources,prepareExportedComparison} from '../scripts/materialize-sources.mjs';
import {machineSources as sourceDeclaration,directMountsOnly,machineSourceIdentity,mountedSourceClosure} from '../scripts/source-pins.mjs';
const machineSources=snapshot=>sourceDeclaration(snapshot,'HEAD',{mounts:directMountsOnly});

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'source-graph-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ALLOW_PROTOCOL:'file',GIT_TERMINAL_PROMPT:'0'};
  const run=(program,args)=>{assert.equal(program,'git');const r=spawnSync(program,['-c','core.hooksPath=/dev/null',...args],{env,encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  const git=(directory,...args)=>run('git',['-C',directory,...args]);
  const write=(directory,path,body)=>{mkdirSync(dirname(join(directory,path)),{recursive:true});writeFileSync(join(directory,path),body);};
  const commit=(directory,files={},mounts)=>{
    for(const [path,body] of Object.entries(files))write(directory,path,body);
    if(mounts){
      for(const row of git(directory,'ls-files','--stage').split('\n'))if(row.startsWith('160000 '))git(directory,'update-index','--force-remove',row.split('\t')[1]);
      write(directory,'.gitmodules',mounts.map(({repository,path,ref='main'})=>`[submodule "${path}"]\n path = ${path}\n url = https://github.com/${repository}.git\n branch = ${ref}\n`).join(''));
    }
    git(directory,'add','.');
    for(const mount of mounts??[]){mkdirSync(join(directory,mount.path),{recursive:true});git(directory,'update-index','--add','--cacheinfo',`160000,${mount.commit},${mount.path}`);}
    git(directory,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','fixture');
    return git(directory,'rev-parse','HEAD');
  };
  const repo=(name,files={},mounts=[])=>{const directory=join(root,name);mkdirSync(directory);git(directory,'init','-q','-b','main');return {directory,commit:commit(directory,files,mounts)};};
  const child=repo('child',{'package.json':'{"name":"@fixture/child","version":"1.0.0"}\n','index.mjs':'export const value=1;\n'});
  const parent=repo('parent',{},[{repository:'fixture/child',path:'nested/child',commit:child.commit}]);
  const prefix='machines/cold-red-gate';
  const machineFiles=(lock='reviewed-lock-1\n',entry='@fixture/child')=>({[`${prefix}/machine.json`]:JSON.stringify({repository:'561-group/cold-red-gate',run:{entries:[entry]}}),[`${prefix}/machine.scm`]:'(fixture)\n',[`${prefix}/channels.scm`]:'(fixed-channels)\n',[`${prefix}/dependencies.lock.yaml`]:lock});
  const machine=repo('machine',machineFiles(),[{repository:'fixture/parent',path:'sources/parent',commit:parent.commit}]);
  const snapshot=join(machine.directory,prefix),locals=new Map([['fixture/parent',parent.directory],['fixture/child',child.directory]]);
  return {root,run,git,repo,commit,write,child,parent,machine,snapshot,prefix,locals,machineFiles};
}

test('one graph carries root/definition/lock identities and every nested origin edge',t=>{
  const f=fixture(t),result=comparisonSources(f.snapshot,join(f.root,'pair'),new Map(),{localSources:f.locals,run:f.run});
  assert.equal(result.base.graphSha256,result.head.graphSha256);
  assert.equal(result.base.machine.definition,f.prefix);
  assert.equal(result.base.machine.commit,f.machine.commit);
  assert.notEqual(result.base.machine.tree,result.base.machine.definitionTree);
  assert.match(result.base.machine.lockBlob,/^[a-f0-9]{40}$/);
  assert.deepEqual(result.base.graph.edges.map(e=>[e.from,e.to,e.path]),[
    ['561-group/cold-red-gate','fixture/parent','sources/parent'],['fixture/parent','fixture/child','nested/child']]);
  assert.equal(result.plan.scope,'comparison-only');assert.deepEqual(result.plan.delta,[]);
});

test('coupled parent and child changes resolve their actual candidate topology',t=>{
  const f=fixture(t),next=f.commit(f.child.directory,{'index.mjs':'export const value=2;\n'});
  f.commit(f.parent.directory,{},[{repository:'fixture/child',path:'different/child',commit:next}]);
  const pair=comparisonSources(f.snapshot,join(f.root,'pair'),new Map([['fixture/parent',f.parent.directory],['fixture/child',f.child.directory]]),{localSources:f.locals,run:f.run});
  assert.equal(pair.base.repositories.find(s=>s.repository==='fixture/child').commit,f.child.commit);
  assert.equal(pair.head.repositories.find(s=>s.repository==='fixture/child').commit,next);
  const edge=pair.head.graph.edges.find(e=>e.to==='fixture/child');assert.equal(edge.path,'different/child');assert.equal(edge.commit,next);assert.equal(edge.selectedCommit,next);
  assert.deepEqual(pair.plan.delta.map(x=>x.repository),['fixture/child','fixture/parent']);
});

test('a later edge with a third authored pin cannot hide behind a selected node',t=>{
  const f=fixture(t),candidate=f.commit(f.child.directory,{'index.mjs':'export const value=2;\n'}),third=f.commit(f.child.directory,{'index.mjs':'export const value=3;\n'});
  f.git(f.child.directory,'checkout','-q','--detach',candidate);
  f.commit(f.parent.directory,{},[{repository:'fixture/child',path:'nested/child',commit:third}]);
  assert.throws(()=>comparisonSources(f.snapshot,join(f.root,'pair'),new Map([['fixture/parent',f.parent.directory],['fixture/child',f.child.directory]]),{localSources:f.locals,run:f.run}),/candidate edge conflicts/);
});

test('new and retired owners are actual candidate topology, never free-standing replacements',t=>{
  const f=fixture(t),newOwner=f.repo('new-owner',{'package.json':'{"name":"@fixture/new"}\n'});
  f.commit(f.parent.directory,{},[{repository:'fixture/new',path:'nested/new',commit:newOwner.commit}]);
  f.locals.set('fixture/new',newOwner.directory);
  const pair=comparisonSources(f.snapshot,join(f.root,'pair'),new Map([['fixture/parent',f.parent.directory],['fixture/new',newOwner.directory]]),{localSources:f.locals,run:f.run});
  assert.ok(pair.plan.delta.find(x=>x.repository==='fixture/new').baseline===null);
  assert.ok(pair.plan.delta.find(x=>x.repository==='fixture/child').candidate===null);
  assert.throws(()=>comparisonSources(f.snapshot,join(f.root,'unused'),new Map([['fixture/new',newOwner.directory]]),{localSources:f.locals,run:f.run}),/unused source replacement/);
});

test('same owner and commit retains all edges, while ref disagreement and unsupported role metadata refuse in either order',t=>{
  const f=fixture(t),other=f.repo('other',{},[{repository:'fixture/child',path:'shared',commit:f.child.commit}]);
  const spec=machineSources(f.snapshot);spec.repositories.push({repository:'fixture/other',commit:other.commit,path:'sources/other',ref:'main'});
  const paths=new Map([...f.locals,['561-group/cold-red-gate',f.machine.directory],['fixture/other',other.directory]]),receive=s=>paths.get(s.repository);
  const graph=mountedSourceClosure(spec,receive);assert.equal(graph.repositories.filter(s=>s.repository==='fixture/child').length,1);assert.equal(graph.graph.edges.filter(e=>e.to==='fixture/child').length,2);
  const reversed={...spec,repositories:[spec.repositories[0],...spec.repositories.slice(1).reverse()]};assert.equal(mountedSourceClosure(reversed,receive).graphSha256,graph.graphSha256);
  f.commit(other.directory,{},[{repository:'fixture/child',path:'shared',commit:f.child.commit,ref:'release/child'}]);
  const refSpec={...spec,repositories:spec.repositories.map(s=>s.repository==='fixture/other'?{...s,commit:f.git(other.directory,'rev-parse','HEAD')}:s)};
  assert.throws(()=>mountedSourceClosure(refSpec,receive),/conflicting mounted ref/);
  const raw=f.repo('input',{'article.md':'source bytes\n'});paths.set('fixture/input',raw.directory);
  for(const rows of [[{purpose:'unsupported-role'},{}],[{},{purpose:'unsupported-role'}]]){
    const direct=rows.map((role,i)=>({repository:'fixture/input',commit:raw.commit,path:`raw${i}`,ref:'main',...role}));
    assert.throws(()=>mountedSourceClosure({...spec,repositories:[spec.repositories[0],...direct]},receive),/source roles are not part/);
  }
});

test('candidate machine root has its own definition and lock; root alias and foreign machine refuse',t=>{
  const f=fixture(t),candidate=join(f.root,'candidate-machine');
  f.run('git',['clone','-q','--no-hardlinks','--no-checkout',f.machine.directory,candidate]);f.git(candidate,'checkout','-q','--detach',f.machine.commit);
  const next=f.commit(candidate,f.machineFiles('separately-reviewed-lock-2\n'));
  const pair=comparisonSources(f.snapshot,join(f.root,'pair'),new Map(),{candidateSnapshot:join(candidate,f.prefix),localSources:f.locals,run:f.run});
  assert.equal(pair.base.machine.commit,f.machine.commit);assert.equal(pair.head.machine.commit,next);assert.notEqual(pair.base.machine.lockBlob,pair.head.machine.lockBlob);assert.notEqual(pair.base.graphSha256,pair.head.graphSha256);
  const alias=join(f.root,'alias');symlinkSync(f.snapshot,alias);assert.throws(()=>machineSourceIdentity(alias),/redirected/);
  f.commit(candidate,{[`${f.prefix}/machine.json`]:'{"repository":"other/machine","run":{"entries":["@fixture/child"]}}'});
  assert.throws(()=>comparisonSources(f.snapshot,join(f.root,'foreign'),new Map(),{candidateSnapshot:join(candidate,f.prefix),localSources:f.locals,run:f.run}),/changes repository identity/);
});

test('complete local custody refuses absent or extra carriers before any candidate program executes',t=>{
  const f=fixture(t),missing=new Map(f.locals);missing.delete('fixture/child');
  assert.throws(()=>comparisonSources(f.snapshot,join(f.root,'missing'),new Map(),{localSources:missing,run:f.run}),/carrier is missing/);
  const extra=new Map([...f.locals,['fixture/extra',f.child.directory]]);
  assert.throws(()=>comparisonSources(f.snapshot,join(f.root,'extra'),new Map(),{localSources:extra,run:f.run}),/cover exactly/);
});

test('incomplete local Git objects refuse with every transport disabled',async t=>{
  const {verifyLocalSourceObjects}=await import('../scripts/materialize-sources.mjs');
  const {unlinkSync}=await import('node:fs');
  const f=fixture(t),blob=f.git(f.child.directory,'rev-parse',`${f.child.commit}:index.mjs`);
  f.git(f.child.directory,'remote','add','origin','https://example.invalid/must-not-fetch.git');
  f.git(f.child.directory,'config','remote.origin.promisor','true');
  f.git(f.child.directory,'config','remote.origin.partialclonefilter','blob:none');
  unlinkSync(join(f.child.directory,'.git','objects',blob.slice(0,2),blob.slice(2)));
  assert.throws(()=>verifyLocalSourceObjects(f.child.directory,f.child.commit),/lacks complete committed code objects|without transport/);
  assert.throws(()=>comparisonSources(f.snapshot,join(f.root,'incomplete'),new Map(),{localSources:f.locals,run:f.run}),/lacks complete committed code objects|without transport/);
});

test('machine binding verifies the root and nested definition separately and refuses lexical alternatives',async t=>{
  const {verifyMachineSnapshot}=await import('../scripts/qualify-candidate-toolchain.mjs');
  const f=fixture(t),identity={repository:'561-group/cold-red-gate',commit:f.machine.commit,tree:f.git(f.machine.directory,'rev-parse','HEAD^{tree}'),definition:f.prefix};
  const binding=verifyMachineSnapshot(f.machine.directory,identity);assert.equal(binding.root,f.machine.directory);assert.equal(binding.snapshot,f.snapshot);
  for(const definition of ['../outside','/absolute','machines/../machines/cold-red-gate','machines\\cold-red-gate','machines//cold-red-gate','machines/./cold-red-gate'])
    assert.throws(()=>verifyMachineSnapshot(f.machine.directory,{...identity,definition}),/canonical repository-relative/);
  assert.throws(()=>verifyMachineSnapshot(f.machine.directory,{...identity,repository:'other/machine'}),/authenticated source root/);
  assert.throws(()=>machineSourceIdentity(f.machine.directory+'/machines/../machines/cold-red-gate'),/canonical spelling/);
  const foreign=f.repo('foreign',{'machine.json':'{"repository":"561-group/cold-red-gate","run":{"entries":["@fixture/child"]}}'});
  assert.throws(()=>verifyMachineSnapshot(foreign.directory,identity),/identity|tree differs/);
});

test('generic nested inputs retain every source origin and reject unsupported metadata in either order',t=>{
  const f=fixture(t),repository='fixture/content',input=f.repo('content',{'posts/a.md':'exact committed bytes\n','history/record':'retained evidence'});
  f.commit(f.parent.directory,{},[{repository,path:'content',commit:input.commit}]);
  const parentCommit=f.git(f.parent.directory,'rev-parse','HEAD');
  f.commit(f.machine.directory,{},[{repository:'fixture/parent',path:'sources/parent',commit:parentCommit}]);
  const spec=machineSources(f.snapshot),paths=new Map([['561-group/cold-red-gate',f.machine.directory],['fixture/parent',f.parent.directory],[repository,input.directory]]);
  const receive=source=>paths.get(source.repository),direct={repository,path:'input-direct',commit:input.commit,ref:'main'};
  const graphs=[true,false].map(first=>mountedSourceClosure({...spec,repositories:[spec.repositories[0],...(first?[direct,spec.repositories[1]]:[spec.repositories[1],direct])]},receive));
  assert.equal(graphs[0].graphSha256,graphs[1].graphSha256);
  assert.equal(graphs[0].graph.edges.filter(edge=>edge.to===repository).length,2);
  assert.deepEqual(graphs[0].repositories.find(row=>row.repository===repository).paths,['input-direct','sources/parent/content']);
  for(const purpose of [null,'','executable','other'])for(const first of [true,false]){
    const conflicting={...direct,purpose};
    assert.throws(()=>mountedSourceClosure({...spec,repositories:[spec.repositories[0],...(first?[conflicting,spec.repositories[1]]:[spec.repositories[1],conflicting])]},receive),/source roles are not part/);
  }
  for(const ref of [null,'',' main','main\n','a b'])assert.throws(()=>mountedSourceClosure({...spec,repositories:[spec.repositories[0],{...direct,ref}]},receive),/invalid tracked ref/);
});

test('direct comparison authenticates both roots before copying lock or channel worktree bytes',t=>{
  for(const file of ['dependencies.lock.yaml','channels.scm'])for(const side of ['baseline','candidate']){
    const f=fixture(t);let candidateSnapshot=f.snapshot,directory=f.machine.directory;
    if(side==='candidate'){
      directory=join(f.root,'candidate-root');f.run('git',['clone','-q','--no-hardlinks',f.machine.directory,directory]);candidateSnapshot=join(directory,f.prefix);
    }
    f.git(directory,'update-index','--assume-unchanged',`${f.prefix}/${file}`);f.write(directory,`${f.prefix}/${file}`,'mutable unauthorized bytes\n');
    assert.throws(()=>comparisonSources(f.snapshot,join(f.root,'pair'),new Map(),{candidateSnapshot,localSources:f.locals,run:f.run}),/source identity or bytes refused/);
  }
});

test('complete-code export and preparation preserve genuine changed topology, added and retired owners',t=>{
 const f=fixture(t),added=f.repo('added-owner',{'package.json':'{"name":"@fixture/added"}\n'});
 f.commit(f.parent.directory,{},[{repository:'fixture/added',path:'new/path',commit:added.commit}]);f.locals.set('fixture/added',added.directory);
 const work=join(f.root,'export'),changes=new Map([['fixture/parent',f.parent.directory],['fixture/added',added.directory]]);
 const {receipt,sha256}=exportChangeSources(f.snapshot,work,changes,{localSources:f.locals,run:f.run});
 assert.equal(receipt.kind,'guix.change-source-carriers.v2');
 assert.equal(receipt.sources.find(row=>row.repository==='fixture/added').pin,null);
 assert.equal(receipt.sources.find(row=>row.repository==='fixture/child').selected,null);
 const restored=prepareExportedComparison(work,sha256,join(f.root,'restored'));
 assert.equal(restored.sourcePlanSha256,receipt.sourcePlanSha256);assert.deepEqual(restored.sourcePlan.delta,receipt.sourcePlan.delta);
 assert.deepEqual(verifyChangeSources(work,sha256),receipt);
});

test('complete-code artifact retains separately authenticated root definitions and lock commits',t=>{
 const f=fixture(t),candidate=join(f.root,'candidate-machine');f.run('git',['clone','-q','--no-hardlinks',f.machine.directory,candidate]);
 const next=f.commit(candidate,f.machineFiles('candidate reviewed lock\n'));
 const work=join(f.root,'export'),{receipt,sha256}=exportChangeSources(f.snapshot,work,new Map(),{candidateSnapshot:join(candidate,f.prefix),localSources:f.locals,run:f.run});
 const restored=prepareExportedComparison(work,sha256,join(f.root,'restored'));
 assert.equal(f.git(restored.snapshot,'rev-parse','HEAD'),f.machine.commit);assert.equal(f.git(restored.candidateSnapshot,'rev-parse','HEAD'),next);
 assert.notEqual(receipt.snapshot.lockBlob,receipt.candidateSnapshot.lockBlob);
});

test('generic mounted input bytes follow the complete inert export contract in either mount order',t=>{
 for(const first of [true,false]){
  const f=fixture(t),repository='fixture/content',input=f.repo('content',{'posts/a.md':'retained body'});
  const direct={repository,path:'content',commit:input.commit},parent={repository:'fixture/parent',path:'parent',commit:f.parent.commit};
  f.commit(f.machine.directory,{},first?[direct,parent]:[parent,direct]);
  f.locals.set(repository,input.directory);const work=join(f.root,'export');
  const {receipt,sha256}=exportChangeSources(f.snapshot,work,new Map(),{localSources:f.locals,run:f.run});
  assert.equal(receipt.sources.find(source=>source.repository===repository).selected.commit,input.commit);
  assert.ok(existsSync(join(work,'source-carriers.json')));
  assert.equal(verifyChangeSources(work,sha256).sourcePlanSha256,receipt.sourcePlanSha256);
 }
});

test('distinct Unicode edge bytes have deterministic identity without locale equivalence',t=>{
 const f=fixture(t),spec=machineSources(f.snapshot),source={repository:'fixture/child',commit:f.child.commit,ref:'main'},
   rows=[{...source,path:'é'},{...source,path:'e\u0301'}];
 const paths=new Map([['561-group/cold-red-gate',f.machine.directory],['fixture/child',f.child.directory]]);
 const graph=direct=>mountedSourceClosure({...spec,repositories:[spec.repositories[0],...direct]},row=>paths.get(row.repository));
 const first=graph(rows),second=graph([...rows].reverse());
 assert.equal(first.graphSha256,second.graphSha256);assert.equal(new Set(first.graph.edges.map(edge=>edge.path)).size,2);
});
