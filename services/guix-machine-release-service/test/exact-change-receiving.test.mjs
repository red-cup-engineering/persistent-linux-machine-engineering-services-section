import {controllerSourceAssays} from '../scripts/qualify-controller-sources.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,cpSync,symlinkSync,chmodSync,renameSync} from 'node:fs';
import {inflateSync,deflateSync} from 'node:zlib';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {reviewedChangeRequest,validateChangeSources,verifySourceCarrier,runExactChangeTest,qualifiedChangeTestEnvironment,receiveReviewedChanges} from '../scripts/receive-pull-requests.mjs';
import {testChange,untrustedEnvironment} from '../scripts/test-change.mjs';
import {verifySnapshotSource,verifySourceTree} from '../scripts/qualify-candidate-toolchain.mjs';
import {exactFixture,nativeReading,controllerRepository} from './fixtures/exact-receiving.mjs';
const hash=n=>String(n).repeat(40);
const identity=(repository,n)=>({repository,commit:hash(n),tree:hash(n+1)});
const request=()=>({kind:'guix.reviewed-change-request.v2',controller:identity(controllerRepository,1),snapshot:{...identity('561-group/cold-red-gate',3),definition:'machines/cold-red-gate'},changes:[identity(controllerRepository,1),identity('coesite-operations/operations-services-section',5)]});
const spec=r=>({machine:{...r.snapshot},repositories:[{...r.snapshot,path:'.'},...r.changes.map(row=>({...row,path:row.repository}))]});
function root(t){const path=mkdtempSync(join(tmpdir(),'exact-receiving-'));t.after(()=>rmSync(path,{recursive:true,force:true}));return path;}
const environment={PATH:process.env.PATH,HOME:'/inert-reader-home',GH_TOKEN:'not-a-real-token',GIT_CONFIG_COUNT:'1',NODE_OPTIONS:'--invalid-inherited-option'};

test('one complete reviewed request accepts only exact identities and no command or floating ref',()=>{
  const r=request();assert.equal(reviewedChangeRequest(r),r);assert.equal(validateChangeSources(r,spec(r)),r);
  for(const change of [r=>r.command='node other.mjs',r=>r.controller.commit='main',r=>r.changes.push(r.changes[0]),r=>r.changes[1].repository='evil/x;touch',r=>r.snapshot.definition='../outside',r=>r.changes=[]]){
    const malformed=request();change(malformed);assert.throws(()=>reviewedChangeRequest(malformed),/exact complete/);
  }
  assert.throws(()=>validateChangeSources(r,{...spec(r),repositories:spec(r).repositories.slice(0,2)}),/outside/);
  assert.throws(()=>validateChangeSources({...r,changes:r.changes.slice(1)},{...spec(r),repositories:spec(r).repositories.map(row=>row.repository===controllerRepository?{...row,commit:hash(9)}:row)}),/selected controller/);
});

test('committed source carriers preserve blobs without controller-only gitlink restrictions',t=>{
  const path=root(t),git=(...args)=>execFileSync('git',['-C',path,...args],{encoding:'utf8'}).trim();git('init','-q');
  writeFileSync(join(path,'inert.mjs'),'export const inert = true;\n');git('add','inert.mjs');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','inert');
  const first=git('rev-parse','HEAD');git('update-index','--add','--cacheinfo',`160000,${first},recorded-gitlink`);git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','inert gitlink');
  const exact={repository:'fixture/source',commit:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}')};assert.equal(verifySourceCarrier(path,exact),path);
  assert.throws(()=>verifySourceCarrier(path,{...exact,tree:hash(0)}),/identity differs/);
  writeFileSync(join(path,'inert.mjs'),'working bytes are not a committed source authority');assert.equal(verifySourceCarrier(path,exact),path);
});

test('exact test-change uses all local carriers under a credential-free environment',t=>{
  const work=join(root(t),'comparison'),changes=request().changes.map((row,i)=>({...row,directory:`/local/${i}`})),localSources=changes.map(row=>[row.repository,row.directory]);let calls=0;
  const result=runExactChangeTest({service:'/controller',snapshot:'/snapshot',work,changes,localSources,node:nativeReading().nodeExecutable,controllerSources:nativeReading(),environment:{...environment,GUILE_LOAD_PATH:'/ambient-forbidden',GUILE_AUTO_COMPILE:'1',GUILE_LOAD_COMPILED_PATH:'/ambient-compiled',NODE_PATH:'/ambient-node',LD_PRELOAD:'/ambient-preload',LD_LIBRARY_PATH:'/ambient-libraries',GITHUB_TOKEN:'fixture-only'},
    execute:(program,args,options)=>{calls++;assert.equal(program,nativeReading().nodeExecutable);assert.deepEqual(args.slice(0,5),['--no-addons','--no-global-search-paths','/controller/scripts/test-change.mjs','/snapshot',join(work,'workspaces')]);
      assert.deepEqual(args.slice(-2),changes.map(row=>`${row.repository}=${row.directory}`));assert.equal(options.env.GIT_NO_LAZY_FETCH,'1');
      assert.equal(options.env.GUILE_AUTO_COMPILE,'0');assert.equal(options.env.GUILE_LOAD_PATH,nativeReading().jsonModule.slice(0,-'/json.scm'.length));
      assert.equal(options.env.PATH,[nativeReading().nodeExecutable.slice(0,-'/node'.length),nativeReading().guileExecutable.slice(0,-'/guile'.length),environment.PATH].join(':'));
      assert.equal(options.env.TMPDIR,join(work,'isolated-tmp'));
      for(const name of ['GH_TOKEN','GITHUB_TOKEN','NODE_OPTIONS','NODE_PATH','GIT_CONFIG_COUNT','GUILE_LOAD_COMPILED_PATH','LD_PRELOAD','LD_LIBRARY_PATH'])assert.equal(options.env[name],undefined);
      assert.equal(options.env.HOME,join(work,'isolated-home'));assert.equal(options.env.GH_CONFIG_DIR,options.env.HOME);assert.deepEqual(JSON.parse(readFileSync(join(work,'local-source-carriers.json'))),localSources);
      return {status:1,stdout:JSON.stringify({kind:'change-test',verdict:'not-composed'}),stderr:''};}});
  assert.equal(calls,1);assert.equal(result.verdict,'not-composed');
});

test('malformed or inconsistent child verdict cannot become successful receiving',t=>{
  const base=root(t);
  for(const [index,response] of [{status:0,stdout:'{}'},{status:0,stdout:'not-json'},{status:0,stdout:JSON.stringify({kind:'change-test',verdict:'regression'})},{status:1,stdout:JSON.stringify({kind:'change-test',verdict:'no-regression'})}].entries())
    assert.throws(()=>runExactChangeTest({service:'/controller',snapshot:'/snapshot',work:join(base,String(index)),changes:[],localSources:[],node:nativeReading().nodeExecutable,controllerSources:nativeReading(),execute:()=>response}),/verdict/);
});

const fixture=exactFixture;
const gitlinkFixture=exactFixture;

test('exact receiving derives missing commits from genuine snapshot gitlinks without checking them out',t=>{
  const f=gitlinkFixture(t),result=receiveReviewedChanges(f.options);
  assert.equal(result.outcome,'not-composed');assert.deepEqual(result.request,f.request);
  assert.deepEqual(result.sourceCarriers.map(row=>row.pin.commit),[f.controller.commit,f.baseline.commit]);
  assert.equal(f.calls.filter(row=>row[0]==='qualify').length,1);
  assert.throws(()=>verifySourceTree(f.options.snapshot,f.request.snapshot.commit,f.request.snapshot.tree),/trusted source identity or bytes refused/);
});


for(const [name,options,pattern] of [
  ['duplicate repository mounts',{duplicate:true},/mounted at two paths/],
  ['a changed repository the machine does not mount',{unmounted:true},/unused source replacement/],
])test(`exact receiving refuses ${name} before any provider or candidate execution`,t=>{
  const f=gitlinkFixture(t,options);assert.throws(()=>receiveReviewedChanges(f.options),pattern);
  assert.ok(!f.calls.some(row=>['qualify','test'].includes(row[0])));
});

test('snapshot gitlink support does not weaken regular-blob, mode or exact-tree checks',t=>{
  for(const kind of ['hidden-blob','hidden-mode','tree']){
    const f=gitlinkFixture(t),snapshot=f.options.snapshot;
    if(kind==='tree')f.request.snapshot.tree=hash(0);
    else{
      execFileSync('git',['-C',snapshot,'update-index','--assume-unchanged',f.definition+'/machine.json']);
      if(kind==='hidden-blob')writeFileSync(join(snapshot,f.definition,'machine.json'),'{}');
      else execFileSync('chmod',['+x',join(snapshot,f.definition,'machine.json')]);
    }
    assert.throws(()=>verifySnapshotSource(snapshot,f.request.snapshot.commit,f.request.snapshot.tree),/candidate source differs|identity|tree differs/);
  }
});

test('test-change uses the same gitlink-derived pin in its real ancestry refusal',async t=>{
  const path=root(t),source=join(path,'source'),snapshot=join(path,'machine'),work=join(path,'work');
  mkdirSync(source);mkdirSync(snapshot);
  const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8'}).trim();
  const commit=(dir,label)=>git(dir,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm',label);
  git(source,'init','-q');writeFileSync(join(source,'inert'),'first');git(source,'add','inert');commit(source,'first');
  const old=git(source,'rev-parse','HEAD');writeFileSync(join(source,'inert'),'pinned later');git(source,'add','inert');commit(source,'pin');
  const pin=git(source,'rev-parse','HEAD');git(source,'checkout','-q','--detach',old);
  git(snapshot,'init','-q');git(snapshot,'remote','add','origin','https://github.com/fixture/machine.git');
  writeFileSync(join(snapshot,'machine.scm'),'; inert target\n');writeFileSync(join(snapshot,'channels.scm'),'; inert channels\n');
  writeFileSync(join(snapshot,'.gitmodules'),'[submodule "sources/inert"]\n\tpath = sources/inert\n\turl = https://github.com/fixture/source.git\n');
  git(snapshot,'add','.');mkdirSync(join(snapshot,'sources/inert'),{recursive:true});git(snapshot,'update-index','--add','--cacheinfo',`160000,${pin},sources/inert`);commit(snapshot,'machine pin');
  const result=await testChange({snapshot,work,changes:new Map([['fixture/source',source]]),localSources:new Map([['fixture/source',source]])});
  assert.equal(result.verdict,'incomplete');assert.equal(result.break.class,'head-behind-pin');
  assert.deepEqual(result.break.repositories.map(row=>[row.repository,row.pin,row.commit]),[['fixture/source',pin,old]]);
  assert.deepEqual(result.packages,[]);
});

test('exact receiving keeps the complete request and classified refusal without queue discovery',t=>{
  const f=fixture(t),result=receiveReviewedChanges(f.options);assert.equal(result.outcome,'not-composed');assert.deepEqual(result.request,f.request);
  assert.deepEqual(f.calls.filter(row=>row[0]==='fetch').map(row=>row[1]),f.request.changes.map(row=>row.repository));
  assert.deepEqual(f.calls.find(row=>row[0]==='test')[1].changes.map(row=>row.repository),f.request.changes.map(row=>row.repository));assert.deepEqual(JSON.parse(readFileSync(join(f.options.work,'reviewed-change-receiving.json'))),result);
});

test('request digest refuses before acquisition; graph mismatch refuses before provider execution',t=>{
  const f=fixture(t);assert.throws(()=>receiveReviewedChanges({...f.options,requestSha256:'0'.repeat(64)}),/differs/);assert.equal(f.calls.length,0);
  const g=fixture(t,{unmounted:true});assert.throws(()=>receiveReviewedChanges(g.options),/unused source replacement/);assert.ok(!g.calls.some(row=>['qualify','test'].includes(row[0])));
});

test('provider, source and execution refusals retain their exact failed stages',t=>{
  for(const [stage,port,error] of [['toolchain-qualification','qualify',new Error('provider unavailable')],['exact-change-sources','fetch',new Error('source unavailable')],['change-composition','testChange',new Error('inert test refusal')]]){
    const f=fixture(t);assert.throws(()=>receiveReviewedChanges({...f.options,[port]:()=>{throw error;}}),new RegExp(error.message));
    const receipt=JSON.parse(readFileSync(join(f.options.work,'reviewed-change-receiving.json')));assert.equal(receipt.stage,stage);assert.equal(receipt.outcome,'not-run');assert.deepEqual(receipt.request,f.request);
  }
  const f=fixture(t);assert.throws(()=>receiveReviewedChanges({...f.options,testChange:()=>({kind:'change-test',snapshot:f.request.snapshot.commit,changes:[],verdict:'no-regression'})}),/complete reviewed graphs and request/);
});

test('untrusted suite drops reader helpers and ambient HOME',t=>{
  const empty=join(root(t),'empty'),env=untrustedEnvironment({...environment,GIT_CONFIG_KEY_0:'credential.helper',GIT_CONFIG_VALUE_0:'inert'},empty);
  for(const name of ['GH_TOKEN','GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0'])assert.equal(env[name],undefined);assert.equal(env.HOME,empty);assert.equal(env.GH_CONFIG_DIR,empty);
});

test('qualified change interpreter reading refuses absent, mismatched and malformed identities',()=>{
  const reading=nativeReading(),args={controllerSources:reading,nodeExecutable:reading.nodeExecutable,home:'/isolated',tmp:'/tmp/isolated',path:'/trusted-guix:/usr/bin'};
  const env=qualifiedChangeTestEnvironment(args);assert.equal(env.GUILE_AUTO_COMPILE,'0');assert.ok(env.PATH.endsWith(':/trusted-guix:/usr/bin'));
  for(const controllerSources of [null,{}, {...reading,nodeExecutable:reading.nodeExecutable.replace('24.18.0','24.19.0')},
    {...reading,guileExecutable:reading.guileExecutable.replace('3.0.11','3.0.9')}, {...reading,jsonModule:reading.jsonModule+'/extra'},
    {...reading,jsonModule:reading.jsonModule.replace('4.7.3','4.7.4')}, {...reading,guileExecutable:'/usr/bin/guile'}])
    assert.throws(()=>qualifiedChangeTestEnvironment({...args,controllerSources}),/qualified|pinned interpreter/);
});

test('exact receiving refuses missing or mismatched qualified interpreters before executing comparison',t=>{
  for(const wrong of [undefined,{...nativeReading(),nodeExecutable:nativeReading().nodeExecutable.replace('24.18.0','24.19.0')}]){
    const f=fixture(t);f.options.qualify=()=>({toolchain:{storePath:'/gnu/store/qualified-toolchain',nodeExecutable:nativeReading().nodeExecutable},controllerSources:wrong});
    assert.throws(()=>receiveReviewedChanges(f.options),/qualified controller interpreter/);
    assert.ok(f.calls.some(row=>row[0]==='fetch'));assert.ok(!f.calls.some(row=>row[0]==='test'));
    const receipt=JSON.parse(readFileSync(join(f.options.work,'reviewed-change-receiving.json')));
    assert.equal(receipt.stage,'toolchain-qualification');assert.equal(receipt.outcome,'not-run');
  }
});

test('exact receiving passes and records the same qualified interpreter reading',t=>{
  const f=fixture(t),reading=receiveReviewedChanges(f.options),call=f.calls.find(row=>row[0]==='test')[1];
  assert.deepEqual(call.controllerSources,nativeReading());assert.equal(call.node,nativeReading().nodeExecutable);assert.deepEqual(reading.controllerSources,nativeReading());
  assert.equal(reading.outcome,'not-composed');
});


test('fixed source qualification explicitly enrolls all six strict TypeScript controls',()=>{
  assert.equal(controllerSourceAssays.filter(file=>file==='test/typescript-build.test.mjs').length,1);
  assert.equal(controllerSourceAssays.length,24);
  for(const file of ['source-pins','materialize-sources','test-change','nested-mounted-receiving','comparison-source-graph','comparison-receiving','release-caller-carriers'])assert.ok(controllerSourceAssays.includes(`test/${file}.test.mjs`));
  for(const file of ['controller-names-no-machine','package-receiving','mounted-owner-coordinates','comparison-mounted-receiving'])assert.equal(controllerSourceAssays.filter(path=>path===`test/${file}.test.mjs`).length,1);
  assert.ok(controllerSourceAssays.includes('test/test-controller.test.mjs'));
});

test('exact runner rejects a mismatched Node before filesystem or execution effects',t=>{
  const work=join(root(t),'not-created');let calls=0;
  assert.throws(()=>runExactChangeTest({service:'/controller',snapshot:'/snapshot',work,changes:[],localSources:[],
    node:'/unqualified/bin/node',controllerSources:nativeReading(),execute:()=>{calls++;throw new Error('must not execute');}}),/qualified controller interpreter/);
  assert.equal(calls,0);assert.equal(existsSync(work),false);
});


test('v2 identities reject coercion, self-replacements and alternate definitions while binding owner separately',()=>{
  for(const edit of [r=>r.snapshot.commit=[r.snapshot.commit],r=>r.controller.tree=new String(r.controller.tree),r=>r.changes[0].repository=[controllerRepository],
    r=>r.snapshot.definition='machines/./cold-red-gate',r=>r.snapshot.definition='machines\\cold-red-gate',r=>r.snapshot.definition='machines//cold-red-gate',
    r=>r.changes.push(identity(r.snapshot.repository,7)),r=>r.candidateSnapshot={...r.snapshot,repository:'other/machine'}]){
    const r=request();edit(r);assert.throws(()=>reviewedChangeRequest(r),/exact complete/);
  }
  const r=request();r.snapshot.repository='other/machine';assert.equal(reviewedChangeRequest(r),r);
  assert.throws(()=>validateChangeSources(r,spec(request())),/exact machine definition/);
});

test('exact receiving binds a separately authored candidate root and its own channel definition',t=>{
  const f=fixture(t),candidate=join(f.path,'candidate-machine');
  f.git(null,'clone','-q','--no-hardlinks',f.machine.directory,candidate);
  f.git(candidate,'remote','set-url','origin',`https://github.com/${f.machine.repository}.git`);
  const candidateIdentity=f.commit(candidate,{[`${f.definition}/channels.scm`]:'; candidate reviewed channels\n'});
  f.request.changes=[];f.request.candidateSnapshot={repository:f.machine.repository,...candidateIdentity,definition:f.definition};f.save();
  const result=receiveReviewedChanges({...f.options,candidateRoot:candidate});
  assert.equal(result.outcome,'not-composed');assert.equal(result.baselineMachine.commit,f.machine.commit);
  assert.equal(result.candidateMachine.commit,candidateIdentity.commit);assert.notEqual(result.baselineMachine.channelsBlob,result.candidateMachine.channelsBlob);
  assert.equal(result.baselineMachine.channelsBlob,f.git(f.machine.directory,'rev-parse',`${f.machine.commit}:${f.definition}/channels.scm`));
  assert.equal(result.candidateMachine.channelsBlob,f.git(candidate,'rev-parse',`${candidateIdentity.commit}:${f.definition}/channels.scm`));
  assert.equal(result.baselineMachine.lockBlob,null);assert.equal(result.candidateMachine.lockBlob,null);
  assert.deepEqual(result.result.sourcePlan.delta.map(row=>row.repository),[f.machine.repository]);
  assert.equal(f.calls.find(row=>row[0]==='test')[1].candidateSnapshot,join(candidate,f.definition));
});

test('a child cannot omit a resolved graph delta or substitute another plan identity',t=>{
  for(const tamper of [result=>result.sourcePlan.delta=[],result=>result.sourcePlan.candidate='0'.repeat(64),result=>result.sourcePlan.requested=[]]){
    const f=fixture(t),actual=f.options.testChange;
    assert.throws(()=>receiveReviewedChanges({...f.options,testChange:options=>{const result=actual(options);tamper(result);
      result.sourcePlanSha256=createHash('sha256').update(JSON.stringify(result.sourcePlan)).digest('hex');return result;}}),/complete reviewed graphs and request/);
  }
});

// These native fixtures retain the existing genuine Git/source refusal ports.
// Their locks and Scheme are inert source bytes; no provider or app executes.
function nativeFixture(t){
  const f=fixture(t);
  const target=f.make('native-target','fixture/target',{'machine.scm':'(native target)\n','channels.scm':'(native channels)\n','deployment/host.json':'{"host":"fixture"}\n'});
  const common=f.make('native-base','fixture/common',{'package.json':'{"name":"@fixture/common","packageManager":"pnpm@11.28.5"}\n',
    'pnpm-workspace.yaml':"packages: ['owners/*']\n",'pnpm-lock.yaml':'inert baseline source lock\n','justfile':'# inert native fabrication source\n'},
    [{...f.controller,path:'owners/controller'},{...f.baseline,path:'owners/app'}]);
  const candidate=join(f.path,'native-candidate');f.git(null,'clone','-q','--no-hardlinks',common.directory,candidate);
  const head={repository:common.repository,directory:candidate,...f.commit(candidate,{'pnpm-lock.yaml':'inert candidate source lock\n'},
    [{...f.controller,path:'owners/controller'},{...f.source,path:'owners/app'}])};
  for(const source of [common,target,f.controller,f.source])f.git(source.directory,'remote','set-url','origin',`https://github.com/${source.repository}.git`);
  f.git(head.directory,'remote','set-url','origin',`https://github.com/${head.repository}.git`);
  const recipe=source=>({path:'justfile',gitBlob:f.git(source.directory,'rev-parse',source.commit+':justfile')});
  const native={kind:'guix.reviewed-change-request.v3',controller:f.identity(f.controller),
    baseline:{software:f.identity(common),recipe:recipe(common),targets:[{...f.identity(target),definition:'.'}]},
    candidate:{software:f.identity(head),recipe:recipe(head),targets:[{...f.identity(target),definition:'.'}]},changes:[f.identity(f.source)]};
  for(const key of Object.keys(f.request))delete f.request[key];Object.assign(f.request,native);
  f.sources.set(target.repository,target);
  const fetch=f.options.fetch;
  Object.assign(f.options,{snapshot:common.directory,candidateRoot:candidate,
    fetch:(...args)=>{const carrier=fetch(...args);f.git(carrier.directory,'remote','set-url','origin',`https://github.com/${carrier.selected.repository}.git`);return carrier;},
    qualify:()=>assert.fail('source admission must not invoke the legacy provider'),testChange:()=>assert.fail('source admission must not execute candidate code')});
  f.save();
  return {...f,common,head,target,recipe,revise:(files,mounts)=>{Object.assign(head,f.commit(candidate,files,mounts));Object.assign(f.request.candidate.software,f.identity(head));f.request.candidate.recipe=recipe(head);f.save();}};
}

test('native request has closed common-source, interface and target identities',t=>{
  const f=nativeFixture(t);assert.equal(reviewedChangeRequest(f.request),f.request);
  for(const mutate of [r=>r.command='fabricate',r=>r.candidate.software.commit='main',r=>r.candidate.targets=[],
    r=>r.baseline.targets.push(r.baseline.targets[0]),r=>r.candidate.recipe.path='../outside',r=>r.candidate.recipe.gitBlob='HEAD',
    r=>r.candidate.targets[0].definition='.git',r=>r.changes.push(r.changes[0]),r=>r.changes=[r.candidate.software],
    r=>r.candidate.software.repository='foreign/root',r=>r.changes=Array(9).fill(r.changes[0])]){
    const value=structuredClone(f.request);mutate(value);assert.throws(()=>reviewedChangeRequest(value),/native change receiving/);
  }
});

test('native source admission receives independent common roots and a target without machine JSON, but never claims runtime success',t=>{
  const f=nativeFixture(t),result=receiveReviewedChanges(f.options);
  assert.equal(result.outcome,'incomplete');assert.equal(result.stage,'native-product-receiving');assert.equal(result.runtimeAcceptance,false);
  assert.equal(existsSync(join(f.target.directory,'machine.json')),false);
  assert.equal(result.sourcePlan.baseline.software.commit,f.common.commit);assert.equal(result.sourcePlan.candidate.software.commit,f.head.commit);
  assert.notEqual(result.sourcePlan.baseline.software.lock.gitBlob,result.sourcePlan.candidate.software.lock.gitBlob);
  assert.equal(result.sourcePlan.baseline.targets[0].repository,f.target.repository);assert.deepEqual(result.sourcePlan.targetDelta,[]);
  assert.deepEqual(result.sourcePlan.delta.map(row=>row.repository),[f.source.repository,f.common.repository].sort());
  assert.equal(result.sourcePlanSha256,createHash('sha256').update(JSON.stringify(result.sourcePlan)).digest('hex'));
  assert.equal(JSON.parse(readFileSync(join(f.options.work,'reviewed-change-receiving.json'))).outcome,'incomplete');
  assert.equal(f.calls.some(([name])=>['qualify','test'].includes(name)),false);
});

test('native request digest refuses before any source acquisition',t=>{
  const f=nativeFixture(t);writeFileSync(f.options.requestFile,'{}');
  assert.throws(()=>receiveReviewedChanges(f.options),/request differs/);assert.deepEqual(f.calls,[]);
});

test('native candidate must contain every requested exact head and the controlling owner',t=>{
  for(const mutate of [f=>f.request.changes[0].commit=f.baseline.commit,
    f=>f.request.changes[0].repository='fixture/absent',f=>f.request.changes[0].tree='0'.repeat(40)]){
    const f=nativeFixture(t);mutate(f);f.save();assert.throws(()=>receiveReviewedChanges(f.options),/requested head differs/);
    const receipt=JSON.parse(readFileSync(join(f.options.work,'reviewed-change-receiving.json')));assert.equal(receipt.outcome,'not-run');
  }
  const f=nativeFixture(t);f.revise({},[{...f.source,path:'owners/app'}]);
  assert.throws(()=>receiveReviewedChanges(f.options),/exact reviewed controller/);
});

test('native fabrication interface cannot be substituted at a fixed source',t=>{
  const f=nativeFixture(t);f.request.candidate.recipe.gitBlob='0'.repeat(40);f.save();
  assert.throws(()=>receiveReviewedChanges(f.options),/fabrication interface differs/);
});

test('native common source needs its own committed whole lock, not target lock or working bytes',t=>{
  const f=nativeFixture(t);f.git(f.head.directory,'rm','pnpm-lock.yaml');f.revise({});
  writeFileSync(join(f.head.directory,'pnpm-lock.yaml'),'uncommitted substitute');
  assert.throws(()=>receiveReviewedChanges(f.options),/committed regular file: pnpm-lock.yaml/);
});

test('native common root acquisition identity and complete source tree remain exact',t=>{
  for(const tamper of [f=>f.git(f.head.directory,'remote','set-url','origin','https://github.com/foreign/claim.git'),
    f=>f.request.candidate.software.tree='0'.repeat(40),f=>f.options.candidateRoot=f.common.directory]){
    const f=nativeFixture(t);tamper(f);f.save();assert.throws(()=>receiveReviewedChanges(f.options),/admitted repository|identity differs/);
  }
});

test('native target remains independent and cannot borrow a software identity or mutable pin',t=>{
  const f=nativeFixture(t);f.request.candidate.targets[0].tree='0'.repeat(40);f.save();
  assert.throws(()=>receiveReviewedChanges(f.options),/tree differs/);
  const g=nativeFixture(t);g.request.candidate.targets[0]={...g.request.candidate.software,definition:'.'};g.save();
  assert.throws(()=>receiveReviewedChanges(g.options),/committed regular file: machine.scm/);
});

test('native target changes and retirement retain their actual baseline obligations',t=>{
  const f=nativeFixture(t),second=f.make('second-target','fixture/second-target',{'machine.scm':'(second)\n','channels.scm':'(channels)\n'});
  f.git(second.directory,'remote','set-url','origin','https://github.com/fixture/second-target.git');f.sources.set(second.repository,second);
  f.request.baseline.targets.push({...f.identity(second),definition:'.'});f.save();
  const result=receiveReviewedChanges(f.options),retired=result.sourcePlan.targetDelta.find(row=>row.target==='fixture/second-target:.');
  assert.equal(retired.candidate,null);assert.equal(retired.baseline.commit,second.commit);assert.equal(result.outcome,'incomplete');
});

test('native topology keeps retired, introduced and moved common owners without an override graph',t=>{
  const f=nativeFixture(t),added=f.make('added-owner','fixture/added',{'package.json':'{"name":"@fixture/added"}\n'});
  f.git(added.directory,'remote','set-url','origin','https://github.com/fixture/added.git');f.sources.set(added.repository,added);
  f.request.changes=[];f.revise({},[{...f.controller,path:'moved/controller'},{...added,path:'owners/added'}]);
  const result=receiveReviewedChanges(f.options),delta=result.sourcePlan.delta;
  assert.equal(delta.find(row=>row.repository===f.source.repository).candidate,null);
  assert.equal(delta.find(row=>row.repository===added.repository).baseline,null);
  const moved=delta.find(row=>row.repository===controllerRepository);assert.equal(moved.baseline.commit,moved.candidate.commit);
  assert.notDeepEqual(moved.baseline.paths,moved.candidate.paths);assert.equal(result.outcome,'incomplete');
});

test('native source acquisition cannot amend the independently retained request',t=>{
  const f=nativeFixture(t),fetch=f.options.fetch;let changed=false;
  f.options.fetch=(...args)=>{const result=fetch(...args);if(!changed){changed=true;writeFileSync(f.options.requestFile,'{}');}return result;};
  assert.throws(()=>receiveReviewedChanges(f.options),/request changed/);
});

test('native receiving refuses redirected or overlapping work and candidate roots',t=>{
  for(const amend of [f=>f.options.work=join(f.head.directory,'work'),f=>f.options.candidateRoot=undefined,
    f=>{const link=join(f.path,'candidate-link');symlinkSync(f.head.directory,link);f.options.candidateRoot=link;}]){
    const f=nativeFixture(t);amend(f);assert.throws(()=>receiveReviewedChanges(f.options),/outside immutable|both independently|canonical/);
    assert.deepEqual(f.calls,[]);
  }
});

test('native common configuration and fabrication interfaces must be committed regular text',t=>{
  for(const file of ['pnpm-lock.yaml','justfile']){
    const f=nativeFixture(t);f.git(f.head.directory,'rm',file);symlinkSync('package.json',join(f.head.directory,file));f.revise({});
    assert.throws(()=>receiveReviewedChanges(f.options),/committed regular file/);
  }
  const f=nativeFixture(t);f.revise({'pnpm-workspace.yaml':Buffer.from([0xff,0xfe])});
  assert.throws(()=>receiveReviewedChanges(f.options),/exact UTF-8 text/);
});

test('native mounted sources refuse missing committed bytes and borrowed object custody',t=>{
  for(const tamper of [(f,carrier)=>{
    const blob=f.git(carrier.directory,'rev-parse',carrier.pin.commit+':package.json');
    rmSync(join(carrier.directory,'.git','objects',blob.slice(0,2),blob.slice(2)));
  },(f,carrier)=>writeFileSync(join(carrier.directory,'.git','objects','info','alternates'),join(f.source.directory,'.git','objects')+'\n')]){
    const f=nativeFixture(t),fetch=f.options.fetch;let changed=false;
    f.options.fetch=(...args)=>{const carrier=fetch(...args);if(!changed){changed=true;tamper(f,carrier);}return carrier;};
    assert.throws(()=>receiveReviewedChanges(f.options),/incomplete|lacks complete|foreign Git custody/);
  }
});

test('native source integrity rechecks already read carriers after later acquisition',t=>{
  const f=nativeFixture(t),fetch=f.options.fetch;let retained;
  f.options.fetch=(...args)=>{
    const carrier=fetch(...args);
    if(carrier.pin.repository===f.source.repository&&!retained)retained=carrier;
    if(carrier.pin.repository===f.target.repository&&retained)f.git(retained.directory,'update-ref','HEAD',f.source.commit);
    return carrier;
  };
  assert.throws(()=>receiveReviewedChanges(f.options),/identity differs/);
});

test('native nested target definition and changed channels retain each side independently',t=>{
  const f=nativeFixture(t),target=f.make('nested-target','fixture/nested',{'machines/target/machine.scm':'(target)\n','machines/target/channels.scm':'(old channels)\n'});
  f.git(target.directory,'remote','set-url','origin','https://github.com/fixture/nested.git');f.sources.set(target.repository,target);
  f.request.baseline.targets=[{...f.identity(target),definition:'machines/target'}];
  Object.assign(target,f.commit(target.directory,{'machines/target/channels.scm':'(new channels)\n'}));
  f.request.candidate.targets=[{...f.identity(target),definition:'machines/target'}];f.save();
  const result=receiveReviewedChanges(f.options),delta=result.sourcePlan.targetDelta[0];
  assert.equal(delta.target,'fixture/nested:machines/target');
  assert.notEqual(delta.baseline.channels.gitBlob,delta.candidate.channels.gitBlob);
  assert.equal(delta.baseline.machine.gitBlob,delta.candidate.machine.gitBlob);assert.equal(result.outcome,'incomplete');
});

test('native common graph keeps the original conflicting mount and invalid URL refusals',t=>{
  const f=nativeFixture(t),nested=f.make('nested-owner','fixture/nested-owner',{'package.json':'{}\n'},[{...f.baseline,path:'app'}]);
  f.git(nested.directory,'remote','set-url','origin','https://github.com/fixture/nested-owner.git');f.sources.set(nested.repository,nested);
  f.revise({},[{...f.controller,path:'controller'},{...f.source,path:'app'},{...nested,path:'nested'}]);
  assert.throws(()=>receiveReviewedChanges(f.options),/one repository has one commit/);
  const g=nativeFixture(t);g.revise({'.gitmodules':readFileSync(join(g.head.directory,'.gitmodules'),'utf8').replace('https://github.com/','https://untrusted.invalid/')});
  assert.throws(()=>receiveReviewedChanges(g.options),/unsupported URL/);
});

test('native unchanged source pairs never turn empty change or interface execution into success',t=>{
  const f=nativeFixture(t);f.request.candidate=structuredClone(f.request.baseline);f.request.changes=[];
  f.options.candidateRoot=f.common.directory;f.save();
  const result=receiveReviewedChanges(f.options);
  assert.deepEqual(result.sourcePlan.delta,[]);assert.deepEqual(result.sourcePlan.targetDelta,[]);
  assert.equal(result.outcome,'incomplete');assert.equal(result.runtimeAcceptance,false);
});

function corruptNativeObject(f,carrier,type){
  const sha=type==='commit'?carrier.pin.commit:type==='tree'?carrier.pin.tree:f.git(carrier.directory,'rev-parse',carrier.pin.commit+':index.mjs');
  const path=join(carrier.directory,'.git','objects',sha.slice(0,2),sha.slice(2)),bytes=inflateSync(readFileSync(path));
  if(type==='tree'){
    const at=bytes.indexOf(Buffer.from('index.mjs'));assert.ok(at>=0);Buffer.from('other.mjs').copy(bytes,at);
  }else bytes[bytes.length-1]=bytes[bytes.length-1]===10?88:10;
  writeFileSync(path,deflateSync(bytes));
}

test('native custody authenticates actual commit, tree and non-interface blob bytes',t=>{
  for(const type of ['commit','tree','blob']){
    const f=nativeFixture(t),fetch=f.options.fetch;let changed=false;
    f.options.fetch=(...args)=>{const carrier=fetch(...args);
      if(!changed&&carrier.pin.repository===f.source.repository){changed=true;corruptNativeObject(f,carrier,type);}return carrier;};
    assert.throws(()=>receiveReviewedChanges(f.options),/object bytes differ|hash mismatch/);
  }
});

test('native custody refuses redirected object storage and common Git metadata',t=>{
  for(const redirect of [(f,carrier)=>{
    const outside=join(f.path,'borrowed-objects');renameSync(join(carrier.directory,'.git','objects'),outside);
    symlinkSync(outside,join(carrier.directory,'.git','objects'));
  },(f,carrier)=>{
    const outside=join(f.path,'borrowed-common');cpSync(join(carrier.directory,'.git'),outside,{recursive:true});
    writeFileSync(join(carrier.directory,'.git','commondir'),outside+'\n');
  }]){
    const f=nativeFixture(t),fetch=f.options.fetch;let changed=false;
    f.options.fetch=(...args)=>{const carrier=fetch(...args);if(!changed){changed=true;redirect(f,carrier);}return carrier;};
    assert.throws(()=>receiveReviewedChanges(f.options),/foreign Git.*custody/);
  }
});

test('native final custody detects object-byte mutation after initial source reading',t=>{
  const f=nativeFixture(t),fetch=f.options.fetch;let retained;
  f.options.fetch=(...args)=>{const carrier=fetch(...args);
    if(carrier.pin.repository===f.source.repository&&!retained)retained=carrier;
    if(carrier.pin.repository===f.target.repository&&retained)corruptNativeObject(f,retained,'blob');return carrier;};
  assert.throws(()=>receiveReviewedChanges(f.options),/object bytes differ/);
});

test('native source custody authenticates arbitrary binary blobs without text conversion',t=>{
  const f=nativeFixture(t);f.revise({'binary.dat':Buffer.from([0,10,255,128,13,0,10])});
  assert.equal(receiveReviewedChanges(f.options).outcome,'incomplete');
});

test('native selected-tree admission does not require unrelated parent history',t=>{
  const f=nativeFixture(t),fetch=f.options.fetch;let removed=false;
  f.options.fetch=(...args)=>{const carrier=fetch(...args);
    if(carrier.pin.repository===f.source.repository&&carrier.pin.commit===f.source.commit){
      const sha=f.baseline.commit;rmSync(join(carrier.directory,'.git','objects',sha.slice(0,2),sha.slice(2)));removed=true;
    }
    return carrier;
  };
  assert.equal(receiveReviewedChanges(f.options).outcome,'incomplete');assert.equal(removed,true);
});

function registryFixture(t){
  const f=fixture(t);
  const consumer=f.make('registry-consumer','fixture/consumer',{
    'package.json':JSON.stringify({name:'@fixture/consumer',version:'1.0.0',exports:{'./machine':'./machine.scm','./channels':'./channels.scm'},registryConsumption:{minimumReleaseAge:1440}}),
    'pnpm-lock.yaml':'inert committed registry lock\n','pnpm-workspace.yaml':'minimumReleaseAge: 1440\n',
    'machine.scm':'(inert machine)\n','channels.scm':'(inert channels)\n'});
  const mounts=[{...f.controller,path:'owners/controller'},{...consumer,path:'services/consumer'}];
  const inventory=f.make('inventory','fixture/inventory',{'README.md':'Inventory, not a PNPM workspace.\n'},mounts);
  const candidate=join(f.path,'registry-candidate');f.git(null,'clone','-q','--no-hardlinks',inventory.directory,candidate);
  f.git(candidate,'remote','set-url','origin',`https://github.com/${inventory.repository}.git`);
  const head={repository:inventory.repository,directory:candidate,...f.commit(candidate,{'README.md':'Independent candidate inventory.\n'},mounts)};
  const target={...f.identity(consumer),definition:'.',coordinate:'services/consumer'};
  for(const key of Object.keys(f.request))delete f.request[key];
  Object.assign(f.request,{kind:'guix.reviewed-change-request.v4',controller:f.identity(f.controller),
    baseline:{software:f.identity(inventory),targets:[target]},candidate:{software:f.identity(head),targets:[{...target}]},changes:[f.identity(f.controller)]});
  f.sources.set(consumer.repository,consumer);
  Object.assign(f.options,{snapshot:inventory.directory,candidateRoot:candidate,
    qualify:()=>assert.fail('source admission is not provider qualification'),testChange:()=>assert.fail('source admission is not product execution')});
  f.save();return {...f,inventory,head,consumer};
}

test('registry request selects only closed committed consumer coordinates',t=>{
  const f=registryFixture(t);assert.equal(reviewedChangeRequest(f.request),f.request);
  for(const change of [r=>r.candidate.recipe={path:'justfile'},r=>r.candidate.targets[0].coordinate='../outside',
    r=>r.candidate.targets[0].coordinate='.git',r=>r.candidate.targets[0].tests=['arbitrary.mjs'],
    r=>r.baseline.targets=[],r=>r.candidate.targets.push(r.candidate.targets[0]),r=>r.receiving={frozenInstall:true}]){
    const value=structuredClone(f.request);change(value);assert.throws(()=>reviewedChangeRequest(value),/registry change receiving/);
  }
});

test('registry admission binds independent inventory roots and actual consumer policy without a root workspace',t=>{
  const f=registryFixture(t),result=receiveReviewedChanges(f.options);
  assert.equal(result.outcome,'incomplete');assert.equal(result.runtimeAcceptance,false);
  assert.equal(result.sourcePlan.scope,'registry-consumer-source-admission-only');
  assert.equal(existsSync(join(f.inventory.directory,'package.json')),false);
  assert.equal(existsSync(join(f.inventory.directory,'pnpm-lock.yaml')),false);
  const consumer=result.sourcePlan.baseline.consumers[0];
  assert.equal(consumer.coordinate,'services/consumer');assert.equal(consumer.receivingDeclared,false);
  assert.equal(consumer.manifest.gitBlob,f.git(f.consumer.directory,'rev-parse','HEAD:package.json'));
  assert.equal(consumer.lock.gitBlob,f.git(f.consumer.directory,'rev-parse','HEAD:pnpm-lock.yaml'));
  assert.equal(consumer.configuration[0].identity.gitBlob,f.git(f.consumer.directory,'rev-parse','HEAD:pnpm-workspace.yaml'));
  assert.equal(consumer.configuration[1].identity,null);
  assert.notEqual(result.sourcePlan.baseline.software.commit,result.sourcePlan.candidate.software.commit);
  assert.equal(result.sourcePlanSha256,createHash('sha256').update(JSON.stringify(result.sourcePlan)).digest('hex'));
});

test('registry admission refuses a consumer outside its exact mounted coordinate',t=>{
  const f=registryFixture(t);f.request.candidate.targets[0].coordinate='other/consumer';f.save();
  assert.throws(()=>receiveReviewedChanges(f.options),/coordinate differs/);
});

test('registry admission authenticates target exports and requires the native committed lock',t=>{
  for(const fault of ['exports','lock']){
    const f=registryFixture(t);
    if(fault==='lock')f.git(f.consumer.directory,'rm','pnpm-lock.yaml');
    const files=fault==='exports'?{'package.json':JSON.stringify({name:'@fixture/consumer',version:'1.0.0',exports:{'./machine':'./foreign.scm','./channels':'./channels.scm'}})}:{};
    Object.assign(f.consumer,f.commit(f.consumer.directory,files));
    Object.assign(f.head,f.commit(f.head.directory,{},[{...f.controller,path:'owners/controller'},{...f.consumer,path:'services/consumer'}]));
    Object.assign(f.request.candidate.software,f.identity(f.head));Object.assign(f.request.candidate.targets[0],f.identity(f.consumer));f.save();
    assert.throws(()=>receiveReviewedChanges(f.options),fault==='lock'?/committed regular file: pnpm-lock.yaml/:/exports do not select/);
  }
});
