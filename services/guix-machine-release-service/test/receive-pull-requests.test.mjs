import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {marker,retryMarker,pending,receive,trackedSources,verdictComment,runChangeTest} from '../scripts/receive-pull-requests.mjs';
import {openPulls} from '../scripts/github-reads.mjs';
import {directMountsOnly as mounts} from '../scripts/source-pins.mjs';

const sha=n=>String(n).repeat(40).slice(0,40);
const pr=(number,extra={})=>({id:`PR_${number}`,number,head:{sha:sha(number)},draft:false,fork:false,received:false,...extra});

test('each pinned repository is read once, on the ref its machine tracks', ()=>{
  assert.deepEqual(trackedSources({repositories:[{repository:'a/x',ref:'release/cold-red-gate'},{repository:'a/y'},{repository:'a/x',ref:'main'}]}),
    [{repository:'a/x',ref:'release/cold-red-gate'},{repository:'a/y',ref:'main'}]);
});

test('drafts, forks and heads already received are not received again; the rest wait behind the limit', ()=>{
  const pulls={'a/x':[pr(1),pr(2,{draft:true}),pr(3,{fork:true}),pr(4,{received:true}),pr(5)],'a/y':[pr(6)]};
  const asked=[];
  const result=pending([{repository:'a/x',ref:'main'},{repository:'a/y',ref:'main'},{repository:'a/z',ref:'main'}],
    (repository,ref,mark)=>{asked.push([repository,ref,mark(sha(9))]);if(repository==='a/z')throw new Error('not readable');return pulls[repository];},2);
  assert.deepEqual(result.work.map(w=>w.pr.number),[1,5]);
  assert.equal(result.deferred,1);
  assert.deepEqual(result.unreadable,[{repository:'a/z',ref:'main',unreadable:'not readable'}]);
  assert.equal(asked[0][2],marker(sha(9)));
});

test('the verdict comment names the commit, regressions and pre-existing failures, and carries its marker', ()=>{
  const body=verdictComment({repository:'a/x',pr:pr(1),snapshotCommit:'s'.repeat(7),result:{verdict:'regression',packages:[
    {name:'@a/p',tests:3,passed:2,regressions:['test/r.test.mjs'],preexisting:['test/o.test.mjs']},{name:'@a/q',status:'not-composed'}]}});
  assert.match(body,/Change test: `regression`/);assert.match(body,/`test\/r\.test\.mjs`/);assert.match(body,/already failing without this change: `test\/o\.test\.mjs`/);
  assert.match(body,/`@a\/q`: not-composed/);assert.ok(body.endsWith(marker(sha(1),'s'.repeat(7))));
  assert.match(verdictComment({repository:'a/x',pr:pr(1),snapshotCommit:'s',error:'install failed'}),/`not-run`[\s\S]*install failed/);
});

test('an attempt that never ran is retryable after one hour; a changed snapshot is a new assay',()=>{
  const body=verdictComment({repository:'a/x',pr:pr(1),snapshotCommit:sha(9),error:'supplier unavailable',now:1000});
  assert.ok(body.endsWith(retryMarker(sha(1),sha(9),3601000)));
  assert.ok(!body.includes(marker(sha(1),sha(9))));
  assert.notEqual(marker(sha(1),sha(9)),marker(sha(1),sha(8)));
  const queue=pending([{repository:'a/x',ref:'main'}],()=>[pr(1,{retryAt:2000}),pr(2)],2,sha(9),1000);
  assert.deepEqual(queue.work.map(x=>x.pr.number),[2]);
});

test('selection is oldest across repositories, rather than repeatedly favoring the first source',()=>{
  const queue=pending([{repository:'a/x',ref:'main'},{repository:'a/y',ref:'main'}],repo=>repo==='a/x'?
    [pr(1,{createdAt:'2026-10-10T11:00:00Z'})]:[pr(2,{createdAt:'2026-10-09T11:00:00Z'})],1);
  assert.deepEqual(queue.work.map(x=>x.pr.number),[2]);assert.equal(queue.deferred,1);
});

test('original PRs and comments are fully paginated; only exact configured-actor evidence suppresses receiving',()=>{
  const connection=(nodes,hasNextPage=false,endCursor=null)=>({nodes,pageInfo:{hasNextPage,endCursor}});
  const comment=(body,login='runner')=>({body,author:{login}});
  const native=(number,comments)=>({id:'PR_'+number,number,headRefOid:sha(number),isDraft:false,isCrossRepository:false,
    createdAt:'2026-10-09T11:00:00Z',comments});
  const calls=[];
  const query=(text,vars)=>{
    calls.push(vars);
    if(vars.id)return {node:{comments:connection([comment(marker(sha(3),sha(9)))])}};
    if(vars.after)return {viewer:{login:'runner'},repository:{pullRequests:connection([
      native(3,connection(Array.from({length:100},()=>comment('discussion')),true,'comments-next'))])}};
    return {viewer:{login:'runner'},repository:{pullRequests:connection([
      native(1,connection([comment(marker(sha(1),sha(9)),'foreign')])),
      native(2,connection([comment(marker(sha(2))),comment(marker(sha(2),sha(8)))]))],true,'pulls-next')}};
  };
  const read=openPulls('a/x','main',head=>marker(head,sha(9)),30,query,1000);
  assert.equal(read.length,3);assert.deepEqual(read.map(x=>x.received),[false,false,true]);
  assert.equal(calls.length,3);assert.equal(calls[1].after,'pulls-next');assert.equal(calls[2].after,'comments-next');
});

test('pagination obstruction is an incomplete source, never a partially received queue',()=>{
  assert.throws(()=>openPulls('a/x','main',marker,30,()=>({viewer:{login:'runner'},repository:{pullRequests:{nodes:[],pageInfo:{hasNextPage:true,endCursor:null}}}})),/pagination incomplete/);
});

test('receiving tests each pending head against the snapshot and comments once per head', t=>{
  const root=mkdtempSync(join(tmpdir(),'receive-pr-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  // The machine mounts a/x, tracking main.
  writeFileSync(join(root,'machine.scm'),'; inert committed Guix target fixture\n');
  writeFileSync(join(root,'channels.scm'),'; inert committed channels fixture\n');
  writeFileSync(join(root,'.gitmodules'),'[submodule "x"]\n\tpath = x\n\turl = https://github.com/a/x.git\n\tbranch = main\n');
  spawnSync('git',['init','-q'],{cwd:root});spawnSync('git',['remote','add','origin','https://github.com/a/machine.git'],{cwd:root});
  spawnSync('git',['add','machine.scm','channels.scm','.gitmodules'],{cwd:root});
  spawnSync('git',['update-index','--add','--cacheinfo',`160000,${'a'.repeat(40)},x`],{cwd:root});
  spawnSync('git',['-c','user.name=f','-c','user.email=f@example.invalid','commit','-q','-m','s'],{cwd:root});
  const comments=[],tested=[];
  const github={openPulls:()=>[pr(1),pr(2)],commentOnPull:(id,body)=>{comments.push([id,body]);return {received:true,id,url:'https://example.invalid/'+id};}};
  const outcome=receive({snapshot:root,work:join(root,'work'),limit:5,mounts,github,fetch:(work,repository,p)=>`/checkouts/${p.number}`,
    testChange:(snapshot,work,repository,checkout)=>{tested.push([repository,checkout]);if(checkout.endsWith('2'))throw new Error('compose failed');return {verdict:'no-regression',packages:[]};}});
  assert.deepEqual(tested,[['a/x','/checkouts/1'],['a/x','/checkouts/2']]);
  assert.deepEqual(outcome.received.map(r=>r.verdict),['no-regression','not-run']);
  assert.deepEqual(comments.map(([id])=>id),['PR_1','PR_2']);
  assert.ok(comments[1][1].includes('compose failed'));
  assert.equal(outcome.received[0].report,'https://example.invalid/PR_1');
  assert.throws(()=>receive({snapshot:root,work:join(root,'work'),mounts,github:{...github,commentOnPull:()=>undefined},fetch:()=>'/checkouts/1',
    testChange:()=>({verdict:'no-regression',packages:[]})}),/independent original-thread receiving/);
  const dry=receive({snapshot:root,work:join(root,'work'),dryRun:true,mounts,github,fetch:()=>{throw new Error('no fetch')},testChange:()=>{throw new Error('no test')}});
  assert.deepEqual(dry.received.map(r=>r.verdict),['dry-run','dry-run']);
});

test('a change that cannot be assembled is reported with its break class', ()=>{
  const body=verdictComment({repository:'a/x',pr:{id:'P',number:1,head:{sha:'1'.repeat(40)}},snapshotCommit:'s',
    result:{verdict:'not-composed',packages:[],break:{class:'unexported-interface'},reason:'Selected runtime imports have no exported interface: ...'}});
  assert.match(body,/assembly break `unexported-interface`/);assert.doesNotMatch(body,/No package/);
});

for(const verdict of ['no-regression','regression','incomplete','not-composed']){
  test(`ordinary receiving preserves consistent ${verdict} execution`,()=>{
    const reading={kind:'change-test',verdict,packages:[]};let calls=0;
    const actual=runChangeTest('/snapshot','/work','owner/source','/checkout',(program,args)=>{
      calls++;assert.equal(program,process.execPath);assert.equal(args.at(-1),'owner/source=/checkout');
      return {status:verdict==='no-regression'?0:1,signal:null,stdout:JSON.stringify(reading),stderr:''};
    });
    assert.deepEqual(actual,reading);assert.equal(calls,1);
  });
}
test('ordinary receiving refuses failed, interrupted or inconsistent process evidence',()=>{
  const success=JSON.stringify({kind:'change-test',verdict:'no-regression',packages:[]});
  for(const response of [
    {status:1,stdout:success},{status:null,stdout:success},{status:0,signal:'SIGTERM',stdout:success},
    {status:0,error:new Error('spawn refused'),stdout:success},
    {status:0,stdout:'null'},{status:0,stdout:'{}'},{status:0,stdout:'not-json'},
    {status:0,stdout:JSON.stringify({kind:'change-test',verdict:'regression',packages:[]})},
    {status:1,stdout:JSON.stringify({kind:'other',verdict:'incomplete',packages:[]})},
    {status:1,stdout:JSON.stringify({kind:'change-test',verdict:'unknown',packages:[]})},
  ])assert.throws(()=>runChangeTest('/snapshot','/work','owner/source','/checkout',()=>response));
});
test('a contradictory successful payload cannot produce a completed receiving marker',()=>{
  let error;
  try{runChangeTest('/snapshot','/work','owner/source','/checkout',()=>({
    status:1,stdout:JSON.stringify({kind:'change-test',verdict:'no-regression',packages:[]}),stderr:'process failed'
  }));}catch(caught){error=caught.message;}
  assert.ok(error);
  const body=verdictComment({repository:'a/x',pr:pr(1),snapshotCommit:sha(9),error,now:1000});
  assert.match(body,/Change test: `not-run`/);
  assert.ok(body.endsWith(retryMarker(sha(1),sha(9),3601000)));
  assert.ok(!body.includes(marker(sha(1),sha(9))));
});
