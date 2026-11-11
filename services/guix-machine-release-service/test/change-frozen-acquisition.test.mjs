import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireChangeDependencies,changeToolchainSearchPath,compose} from '../scripts/test-change.mjs';
import {realizeToolchain} from '../scripts/qualify-toolchain.mjs';

const service=fileURLToPath(new URL('../',import.meta.url));
const toolchain='/gnu/store/'+'a'.repeat(32)+'-machine-dependency-toolchain';
const received={lockState:'frozen',pnpmVersion:'10.34.6'};
const temp=t=>{const path=mkdtempSync(join(tmpdir(),'change-frozen-'));t.after(()=>rmSync(path,{recursive:true,force:true}));return path;};
function put(path,text){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof text==='string'?text:JSON.stringify(text));}
function fixture(t){
  const root=temp(t),snapshot=join(root,'snapshot'),workspace=join(root,'head');
  put(join(snapshot,'channels.scm'),'; inert source identity\n');
  put(join(snapshot,'dependencies.lock.yaml'),{lockfileVersion:'9.0',importers:{'.':{}},packages:{},snapshots:{}});
  return {service,spec:{repositories:[],entries:[]},snapshot,repositories:[],owners:{},buildEntries:[],workspace,work:root};
}

test('the ordinary adapter delegates once through exact Guix Node with no ambient package configuration',()=>{
  const calls=[];
  const result=acquireChangeDependencies({service:'/controller',toolchain,workspace:'/workspace',work:'/results',execute:(program,args,options)=>{
    calls.push({program,args,options});return {status:0,stdout:JSON.stringify(received)};
  }});
  assert.deepEqual(result,received);assert.equal(calls.length,1);
  assert.equal(calls[0].program,toolchain+'/bin/node');
  assert.deepEqual(calls[0].args,['--no-addons','--no-global-search-paths','/controller/scripts/design-rules.mjs','--acquire-guix-frozen',toolchain,'/workspace','/results']);
  assert.deepEqual(calls[0].options.env,{HOME:'/results',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',NODE_DISABLE_COMPILE_CACHE:'1'});
});

test('invalid toolchain paths refuse before the adapter can execute',()=>{
  for(const value of [undefined,'/usr/bin/node','/tmp/toolchain',toolchain+'\n',toolchain+'/other',toolchain+' '+toolchain]){
    let calls=0;assert.throws(()=>acquireChangeDependencies({toolchain:value,execute:()=>{calls++;}}),/one exact Guix toolchain/);assert.equal(calls,0);
  }
});

test('provider failure and mismatched receipts never trigger bootstrap or resolution retries',()=>{
  for(const result of [{status:1,stderr:'source lock refused'},{status:0,stdout:'not JSON'},
    {status:0,stdout:JSON.stringify({...received,lockState:'re-resolved'})},
    {status:0,stdout:JSON.stringify({...received,pnpmVersion:'11.9.0'})}]){
    let calls=0;
    assert.throws(()=>acquireChangeDependencies({service:'/controller',toolchain,workspace:'/workspace',work:'/results',execute:()=>{calls++;return result;}}));
    assert.equal(calls,1);
  }
});

test('fixed qualification and ordinary composition share the same installed-only realization command',t=>{
  const root=temp(t),calls=[];
  assert.equal(realizeToolchain({service:'/controller',snapshot:'/snapshot',home:join(root,'home'),path:'/selected/bin',
    query:(...args)=>{calls.push(args);return toolchain;}}),toolchain);
  assert.deepEqual(calls,[['guix',['repl','--','/controller/scripts/pinned-guix.scm','/snapshot/channels.scm','--require-installed','build','--no-grafts','-L','/controller/src','-e','((@ (guix-deployment) dependency-toolchain))'],
    '/snapshot',{HOME:join(root,'home'),PATH:'/selected/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8'}]]);
  assert.throws(()=>realizeToolchain({service:'/controller',snapshot:'/snapshot',home:join(root,'other'),path:'/selected/bin',query:()=>toolchain+'\n'+toolchain}),/unique toolchain/);
});

test('composition preserves an existing executable home-profile Guix ahead of PATH',t=>{
  const home=temp(t),profile=join(home,'.config/guix/current/bin/guix');
  assert.equal(changeToolchainSearchPath({HOME:home,PATH:'/node/bin:/usr/bin'}),'/node/bin:/usr/bin');
  put(profile,'#!/bin/sh\nexit 99\n');chmodSync(profile,0o644);
  assert.equal(changeToolchainSearchPath({HOME:home,PATH:'/node/bin:/usr/bin'}),'/node/bin:/usr/bin');
  chmodSync(profile,0o755);
  assert.equal(changeToolchainSearchPath({HOME:home,PATH:'/node/bin:/usr/bin'}),dirname(profile)+':/node/bin:/usr/bin');
});

test('composition retains source preparation but removes npmrc, npm bootstrap and resolution fallback',t=>{
  const options=fixture(t),calls=[];
  const result=compose({...options,execute:(program,args,options)=>{
    calls.push({program,args,options});
    return program==='guix'?{status:0,stdout:toolchain+'\n'}:{status:0,stdout:JSON.stringify(received)};
  }});
  assert.equal(result.toolchain,toolchain);assert.equal(result.lockState,'frozen');assert.equal(calls.length,2);
  assert.equal(calls[0].program,'guix');assert.equal(calls[1].program,toolchain+'/bin/node');
  assert.equal(existsSync(join(options.workspace,'.npmrc')),false);
  assert.equal(JSON.parse(readFileSync(join(options.workspace,'package.json'),'utf8')).packageManager,'pnpm@10.34.6');
  assert.equal(readFileSync(join(options.workspace,'pnpm-lock.yaml'),'utf8'),readFileSync(join(options.snapshot,'dependencies.lock.yaml'),'utf8'));
  assert.equal(readFileSync(join(options.workspace,'.composed'),'utf8'),'frozen\n');
  assert.deepEqual(JSON.parse(readFileSync(options.workspace+'.prepare.json','utf8')).repositories,[]);
});

test('missing reviewed lock stops composition before any Guix or provider call',t=>{
  const options=fixture(t);rmSync(join(options.snapshot,'dependencies.lock.yaml'));let calls=0;
  assert.throws(()=>compose({...options,execute:()=>{calls++;}}),/reviewed dependency lock is missing/);
  assert.equal(calls,0);assert.equal(existsSync(join(options.workspace,'.composed')),false);
});

test('Guix failure, malformed output and provider refusal leave no success marker or fallback',t=>{
  for(const failure of ['guix','multiple','provider']){
    const options=fixture(t),calls=[];
    assert.throws(()=>compose({...options,execute:(program,args)=>{
      calls.push({program,args});
      if(program==='guix')return failure==='guix'?{status:1,stderr:'missing exact prerequisite'}:
        {status:0,stdout:failure==='multiple'?toolchain+'\n'+toolchain:toolchain};
      return {status:1,stderr:'DRC-3 SQLite admission refused: synthetic lock carrier'};
    }}));
    assert.equal(calls.length,failure==='provider'?2:1);
    assert.equal(existsSync(join(options.workspace,'.composed')),false);
    assert.equal(existsSync(join(options.workspace,'.npmrc')),false);
  }
});

test('actual committed-source SQLite preflight refuses before tooling and preserves exact repair evidence',t=>{
  const options=fixture(t),repository=join(options.work,'source');
  put(join(repository,'package.json'),{name:'@fixture/refused',version:'1.0.0',exports:'./index.mjs',sqlAdmissionPaths:['index.mjs']});
  put(join(repository,'index.mjs'),"import {DatabaseSync} from 'node:sqlite';\nexport const retained = true;\n");
  const git=(...args)=>{const r=spawnSync('git',args,{cwd:repository,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git('init','-q');git('add','.');git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','inert refused source');
  const source={repository:'fixture/refused',directory:repository,commit:git('rev-parse','HEAD')};
  let calls=0;
  assert.throws(()=>compose({...options,spec:{repositories:[source],entries:['@fixture/refused']},repositories:[source],execute:()=>{calls++;}}),/DRC-3 SQLite admission refused/);
  assert.equal(calls,0);
  assert.deepEqual(JSON.parse(readFileSync(options.workspace+'.prepare.json','utf8')).repositories,[source]);
  assert.match(readFileSync(options.workspace+'.prepare.stderr','utf8'),/drc-3:@fixture\/refused:index\.mjs:node:sqlite/);
  assert.match(readFileSync(join(repository,'index.mjs'),'utf8'),/DatabaseSync/);
  assert.equal(existsSync(join(options.workspace,'.composed')),false);
  // A later corrected attempt must not pair the old error with a new plan.
  put(join(repository,'index.mjs'),'export const retained = true;\n');
  git('add','.');git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','corrected source');
  const corrected={...source,commit:git('rev-parse','HEAD')};
  const result=compose({...options,spec:{repositories:[corrected],entries:['@fixture/refused']},repositories:[corrected],toolchain,
    execute:()=>({status:0,stdout:JSON.stringify(received)})});
  assert.equal(result.lockState,'frozen');
  assert.deepEqual(JSON.parse(readFileSync(options.workspace+'.prepare.json','utf8')).repositories,[corrected]);
  assert.equal(existsSync(options.workspace+'.prepare.stderr'),false);
  assert.equal(existsSync(options.workspace+'.prepare.stdout'),false);
});

test('a retained mutable workspace and old marker never bypass fresh preparation or frozen acquisition',t=>{
  const options=fixture(t);let calls=0;
  for(const marker of ['', 'frozen\n', 'old-provider']){
    put(join(options.workspace,'.composed'),marker);
    put(join(options.workspace,'.npmrc'),'unqualified old configuration');
    put(join(options.workspace,'untrusted-old-output'),'stale');
    assert.throws(()=>compose({...options,toolchain,execute:(program,args)=>{
      calls++;assert.equal(program,toolchain+'/bin/node');
      assert.ok(args.includes('--acquire-guix-frozen'));
      return {status:1,stderr:'fresh provider admission refused'};
    }}),/fresh provider admission refused/);
    assert.equal(existsSync(join(options.workspace,'.composed')),false);
    assert.equal(existsSync(join(options.workspace,'.npmrc')),false);
    assert.equal(existsSync(join(options.workspace,'untrusted-old-output')),false);
  }
  assert.equal(calls,3);
});

test('head and lazily composed base use the same toolchain without a second acquisition mechanism',t=>{
  const options=fixture(t),calls=[];
  const execute=(program,args)=>{calls.push({program,args});return program==='guix'?{status:0,stdout:toolchain}:{status:0,stdout:JSON.stringify(received)};};
  const head=compose({...options,execute});
  const base=compose({...options,workspace:join(options.work,'base'),toolchain:head.toolchain,execute});
  assert.equal(base.toolchain,head.toolchain);assert.equal(calls.length,3);
  assert.equal(calls.filter(call=>call.program==='guix').length,1);
  assert.equal(calls.filter(call=>call.args.includes('--acquire-guix-frozen')).length,2);
});

test('the production adapter uses the existing exact inventory and frozen guard before provider execution',()=>{
  const source=readFileSync(new URL('../scripts/design-rules.mjs',import.meta.url),'utf8');
  const adapter=source.slice(source.indexOf('export function acquireGuixFrozenDependencies'),source.indexOf('\nif (isCliEntry'));
  assert.match(adapter,/verifyFrozenToolchain\(root\)/u);
  assert.match(adapter,/controller must run through the toolchain Node interpreter/u);
  assert.match(adapter,/return acquireFrozenDependencies\(/u);
  const change=readFileSync(new URL('../scripts/test-change.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(change,/pnpm@11|npm.*exec|--no-frozen-lockfile|re-resolved|registry-cache|HOUSE_SCOPES/u);
  assert.match(change,/toolchain=composedHead\.toolchain/u);
  assert.match(change,/baseComposed=false/u);
  assert.doesNotMatch(change,/readFileSync\(join\(.*['"]\.composed|existsSync\(join\(baseWorkspace,['"]\.composed/u);
});
