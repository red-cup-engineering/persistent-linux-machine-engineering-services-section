import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {comparisonSources} from '../scripts/materialize-sources.mjs';
import {prepare} from '../scripts/prepare-sources.mjs';
import {runDeclaredReceiving} from '../scripts/test-change.mjs';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'comparative-mounted-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const run=(program,args)=>{assert.equal(program,'git');const r=spawnSync(program,args,{encoding:'utf8',env:{PATH:process.env.PATH,HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ALLOW_PROTOCOL:'file',GIT_TERMINAL_PROMPT:'0'}});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 const git=(directory,...args)=>run('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','-C',directory,...args]);
 const put=(directory,path,bytes)=>{mkdirSync(dirname(join(directory,path)),{recursive:true});writeFileSync(join(directory,path),bytes);};
 const commit=(directory,files={},mounts=[])=>{
  for(const [path,bytes] of Object.entries(files))put(directory,path,bytes);
  if(mounts.length)put(directory,'.gitmodules',mounts.map(m=>`[submodule "${m.path}"]\n path = ${m.path}\n url = https://github.com/${m.repository}.git\n`).join(''));
  git(directory,'add','.');for(const m of mounts)git(directory,'update-index','--add','--cacheinfo',`160000,${m.commit},${m.path}`);
  git(directory,'commit','-q','--allow-empty','-m','fixture');return git(directory,'rev-parse','HEAD');
 };
 const repo=(name,files,mounts)=>{const directory=join(root,name);mkdirSync(directory);git(directory,'init','-q');git(directory,'remote','add','origin',`https://github.com/fixture/${name}.git`);return {directory,commit:commit(directory,files,mounts)};};
 const child=repo('child',{'datum.txt':'old'});
 const parent=repo('parent',{'package.json':JSON.stringify({name:'@fixture/parent',version:'1.0.0',type:'module',receivingTests:['receiving/check.mjs']}),
 'receiving/check.mjs':`import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';test('mounted bytes',()=>assert.equal(readFileSync(new URL('../content/datum.txt',import.meta.url),'utf8'),'new'));\n`},[{repository:'fixture/child',path:'content',commit:child.commit}]);
 const machine=repo('machine',{'machine.scm':'(list)\n','machine.json':JSON.stringify({repository:'fixture/machine',run:{entries:['@fixture/parent'],receivingPackages:['@fixture/parent']}})},[{repository:'fixture/parent',path:'services/parent',commit:parent.commit}]);
 const selected=commit(child.directory,{'datum.txt':'new'});
 const localSources=new Map([['fixture/parent',parent.directory],['fixture/child',child.directory]]);
 const pair=()=>comparisonSources(machine.directory,join(root,'graphs'),new Map([['fixture/child',child.directory]]),{localSources,run});
 return {root,run,git,put,commit,child,parent,machine,selected,localSources,pair};
}
const scope=(pair,side)=>({kind:'guix.comparison-preparation.v1',side,plan:pair.plan,planSha256:pair.planSha256,baselineGraph:pair.base.graph,candidateGraph:pair.head.graph});

test('genuine mounted receiving uses exact baseline and selected child bytes with unchanged parent',t=>{
 const f=fixture(t),pair=f.pair(),results=[];
 for(const [side,spec] of [['baseline',pair.base],['candidate',pair.head]]){
  const output=join(f.root,side);prepare({...spec,comparison:scope(pair,side),output});
  results.push(runDeclaredReceiving(output,{PATH:process.env.PATH})[0].results[0].passed);
  const source=JSON.parse(readFileSync(join(output,'sources.json'))).packages.find(p=>p.name==='@fixture/parent');
  assert.deepEqual(source.mounts,[{repository:'fixture/child',commit:side==='baseline'?f.child.commit:f.selected,path:'content',...(side==='candidate'?{authoredCommit:f.child.commit}:{})}]);
 }
 assert.deepEqual(results,[false,true]);
 assert.equal(pair.base.repositories.find(p=>p.repository==='fixture/parent').commit,pair.head.repositories.find(p=>p.repository==='fixture/parent').commit);
});

test('ordinary preparation cannot silently accept comparative selected child substitution',t=>{
 const f=fixture(t),pair=f.pair();
 assert.throws(()=>prepare({...pair.head,output:join(f.root,'ordinary')}),/source differs|exact source graph/);
 const comparison=scope(pair,'candidate');comparison.planSha256='0'.repeat(64);
 assert.throws(()=>prepare({...pair.head,comparison,output:join(f.root,'corrupt-plan')}),/graph pair and plan/);
});

test('an authored third pin refuses before generic mounted receiving can run',t=>{
 const f=fixture(t),third=f.commit(f.child.directory,{'datum.txt':'third'});
 const parent=f.commit(f.parent.directory,{},[{repository:'fixture/child',path:'content',commit:third}]);
 f.git(f.child.directory,'checkout','-q','--detach',f.selected);
 assert.throws(()=>comparisonSources(f.machine.directory,join(f.root,'third'),new Map([['fixture/parent',f.parent.directory],['fixture/child',f.child.directory]]),{localSources:f.localSources,run:f.run}),/candidate edge conflicts/);
 assert.notEqual(parent,f.parent.commit);
});

test('a graph identity cannot erase receiving enrollment or add unrelated executable entries',t=>{
 const f=fixture(t),pair=f.pair();
 for(const change of [{receivingPackages:[]},{entries:[]},{buildEntries:['@fixture/unowned']}]){
  const output=join(f.root,'refused-'+Object.keys(change)[0]);
  assert.throws(()=>prepare({...pair.head,comparison:scope(pair,'candidate'),...change,output}),/entries|enrollment/);
  assert.equal(existsSync(output),false);
 }
 assert.throws(()=>prepare({...pair.base,declarationOnly:true,output:join(f.root,'declaration')}),/declaration-only/);
});
