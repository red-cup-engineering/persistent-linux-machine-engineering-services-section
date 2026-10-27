import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {admissionFixture,sha} from './fixtures/host-admission.mjs';
import {apply,observe,configureRunner,registerRunner} from '../src/ci-runner-host.mjs';
import {planExistingControls} from '../src/existing-controls.mjs';
async function fixture(){
 const f=admissionFixture(),oldHome=process.env.HOME;try{const home=path.join(f.root,'home'),root=path.join(f.root,'retained-flat');
 fs.mkdirSync(home,{mode:0o700});fs.mkdirSync(root,{mode:0o700});fs.mkdirSync(path.join(home,'.config/systemd/user'),{recursive:true});
 process.env.HOME=home;
 const name='retained-fixture',unit='ci-runner-'+name+'.service',fragment=path.join(home,'.config/systemd/user',unit);
 fs.writeFileSync(fragment,`[Service]\nWorkingDirectory=${root}\nExecStart=${root}/run.sh\n`,{mode:0o600});
 fs.writeFileSync(path.join(root,'.runner'),JSON.stringify({agentId:42,agentName:name,gitHubUrl:'https://github.com/group/repo',workFolder:'_work'}),{mode:0o600});
 fs.writeFileSync(path.join(root,'.env'),'ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/original/completed.sh\n',{mode:0o600});
 fs.writeFileSync(path.join(root,'.credentials'),'PRIVATE-FIXTURE-DO-NOT-READ',{mode:0o600});
 fs.mkdirSync(path.join(root,'_work'));fs.writeFileSync(path.join(root,'_work/sentinel'),'retained-work');fs.writeFileSync(path.join(root,'run.sh'),'#!/bin/sh\nexit 77\n',{mode:0o700});
 const source=fileURLToPath(new URL('../',import.meta.url));
 const files=['scripts/ci-runner-host.mjs','src/ci-runner-host.mjs','src/host-admission.mjs','src/existing-controls.mjs','src/runner-layout.mjs'].map(p=>({path:path.join(source,p),sha256:sha(fs.readFileSync(path.join(source,p)))}));
 const record={...f.record,controls:{mode:'existing-flat',uid:process.getuid(),home,directory:path.join(f.root,'controls'),parametersPath:path.join(f.root,'ci.json'),runtime:{node:process.execPath,cli:path.join(source,'scripts/ci-runner-host.mjs'),files}},runners:[{name,root,scope:'https://github.com/group/repo',labels:['fixture'],registration:{executable:'/usr/bin/gh'},existing:{id:42,unitFragment:fragment,unitFragmentSha256:sha(fs.readFileSync(fragment))}}]};
 let reloads=0,gets=0;const dropin=fragment+'.d/80-ci-runner-host-admission.conf',hook=path.join(record.controls.directory,name+'-admit.sh');
 const native=()=>({Id:unit,LoadState:'loaded',FragmentPath:fragment,WorkingDirectory:root,ExecStart:`{ path=${root}/run.sh ; argv[]=${root}/run.sh ; ignore_errors=no ; start_time=[n/a] ; pid=0 }`,DropInPaths:reloads?dropin:'',ExecCondition:reloads?`{ path=${hook} ; argv[]=${hook} startup ; ignore_errors=no }`:''});
 const registrationRun=(_exe,args)=>{gets++;assert.ok(args.includes('GET'));assert.ok(!args.includes('POST'));return JSON.stringify({total_count:1,runners:[{id:42,name,status:'online',busy:false,labels:[{name:'fixture'}]}]});};
 const controlsPorts={unit:native,reload:()=>{reloads++;}};
 const originalPause=process.env.WSL_QUARANTINE_SOURCE??fileURLToPath(new URL('../../wsl-host-service/src/user-unit-quarantine.mjs',import.meta.url));
 const pauseSource=fs.readFileSync(originalPause),pausePath=path.join(path.dirname(record.hostAdmission.provider.module),'user-unit-quarantine.mjs');fs.writeFileSync(pausePath,pauseSource,{mode:0o400});record.controls.pauseProvider={module:pausePath,sha256:sha(pauseSource)};
 const original=await import(new URL('file://'+pausePath).href);
 const expected={pid:101,invocationId:'a'.repeat(32),controlGroup:'/user.slice/fixture.service',bootId:'fixture-boot',process:{pid:101,startTime:'1234',argv:[root+'/run.sh'],cwd:root,cgroup:'0::/user.slice/fixture.service'}};
 const section=path.join(f.root,'fixture-operations-services-section');fs.mkdirSync(section,{mode:0o700});
 f.host.linux={userUnitQuarantines:[{id:'fixture-pause',unit,uid:process.getuid(),home,sectionRoot:section,origin:'https://github.com/fixture/owner/issues/4',captureMode:'frozen-resident',releasePolicy:'hold-only',expected}]};f.saveHost();
 const q=original.quarantineDeclaration(f.host,'fixture-pause'),pauseState={MainPID:'101',ControlPID:'0',InvocationID:expected.invocationId,ControlGroup:expected.controlGroup,ActiveState:'active',SubState:'running',FreezerState:'frozen',Job:''};let held=false;
 const processOf=pid=>pid===101?structuredClone(expected.process):{...expected.process,pid,startTime:String(1234+pid-101)};
 const pauseNative={uid:()=>process.getuid(),unit:()=>({...native(),...pauseState,DropInPaths:[held?q.guard:'',native().DropInPaths].filter(Boolean).join(' '),conditions:held?[['ConditionPathExists',false,true,q.marker,0]]:[]}),boot:()=>expected.bootId,process:processOf,reload:()=>{held=true;}};
 original.holdQuarantine(f.host,pauseNative,'fixture-pause');
 record.runners[0].existing.pause={id:'fixture-pause',markerSha256:sha(fs.readFileSync(q.marker)),guardSha256:sha(fs.readFileSync(q.guard)),cohort:[101,102,103].map(pid=>({pid,startTime:processOf(pid).startTime}))};
 const kernel={freeze:'1',events:'populated 1\nfrozen 1',pids:[101,102,103]};Object.assign(controlsPorts,{pauseNative,readCgroup:()=>structuredClone(kernel)});
 const save=()=>fs.writeFileSync(record.controls.parametersPath,JSON.stringify(record),{mode:0o600});save();
 return {...f,record,home,pauseState,kernel,q,pauseNative,runner:record.runners[0],root,fragment,dropin,hook,registrationRun,controlsPorts,native,save,get reloads(){return reloads;},get gets(){return gets;},cleanup:()=>{process.env.HOME=oldHome;f.cleanup();}};
 }catch(error){process.env.HOME=oldHome;f.cleanup();throw error;}
}
const run=fn=>async()=>{const f=await fixture();try{await fn(f);}finally{f.cleanup();}};
test('controls-only original apply receives retained flat registration and preserves all original artifacts',run(async f=>{
 const retained=['.runner','.env','.credentials','_work/sentinel','run.sh'].map(p=>[p,sha(fs.readFileSync(path.join(f.root,p)))]),fragment=sha(fs.readFileSync(f.fragment));
 const oldGuard=f.fragment+'.d/90-wsl-host-quarantine-owned.conf';fs.mkdirSync(path.dirname(oldGuard),{recursive:true});fs.writeFileSync(oldGuard,'[Unit]\nConditionPathExists=!/owned/held-marker\n',{mode:0o600});const guard=sha(fs.readFileSync(oldGuard));
 const items=await observe(f.record,{registrationRun:f.registrationRun,...f.controlsPorts}); // public observer must avoid legacy du/pgrep.
 assert.equal(items[0].status,'drift');
 const log=await apply(f.record,{registrationRun:f.registrationRun,controlsPorts:f.controlsPorts});
 assert.equal(log.length,3);assert.equal(f.reloads,1);assert.ok(f.gets>=3);
 assert.equal(fs.statSync(f.hook).mode&0o777,0o700);assert.equal(fs.statSync(f.dropin).mode&0o777,0o600);
 assert.match(fs.readFileSync(f.dropin,'utf8'),/ExecCondition=.*startup/);assert.match(fs.readFileSync(f.dropin,'utf8'),/ACTIONS_RUNNER_HOOK_JOB_STARTED=/);
 assert.match(fs.readFileSync(f.hook,'utf8'),/sha256sum --check --status/);
 for(const [p,hash] of retained)assert.equal(sha(fs.readFileSync(path.join(f.root,p))),hash);
 assert.equal(sha(fs.readFileSync(f.fragment)),fragment);assert.equal(sha(fs.readFileSync(oldGuard)),guard);
 assert.ok(!fs.existsSync(path.join(f.root,'runner'))&&!fs.existsSync(path.join(f.root,'versions')));
 assert.deepEqual(await apply(f.record,{registrationRun:f.registrationRun,controlsPorts:f.controlsPorts}),[]);assert.equal(f.reloads,1);
}));
test('alternate organization scope binds same exact public registration without token acquisition',run(async f=>{
 f.runner.scope='https://github.com/another-group';const p=path.join(f.root,'.runner');const j=JSON.parse(fs.readFileSync(p));j.gitHubUrl=f.runner.scope;fs.writeFileSync(p,JSON.stringify(j));f.save();
 await apply(f.record,{registrationRun:f.registrationRun,controlsPorts:f.controlsPorts});assert.equal(f.reloads,1);
}));
test('wrong id scope root fragment loaded command or source pins refuse before owned output',run(async f=>{
 const variants=[()=>{f.runner.existing.id=41;},()=>{f.runner.scope='https://github.com/foreign';},()=>{f.runner.root=path.join(f.root,'missing');},()=>{f.runner.existing.unitFragmentSha256='0'.repeat(64);},()=>{f.record.controls.runtime.files[0].sha256='0'.repeat(64);}];
 const pristine=JSON.stringify(f.record);
 for(const change of variants){Object.assign(f.record,JSON.parse(pristine));f.runner=f.record.runners[0];change();f.save();await assert.rejects(apply(f.record,{registrationRun:f.registrationRun,controlsPorts:f.controlsPorts}));assert.ok(!fs.existsSync(f.record.controls.directory));assert.equal(f.reloads,0);}
 Object.assign(f.record,JSON.parse(pristine));f.save();await assert.rejects(apply(f.record,{registrationRun:f.registrationRun,controlsPorts:{...f.controlsPorts,unit:()=>({...f.native(),ExecStart:'{ path=/bin/false ; argv[]=/bin/false ; }'})}}),/executable differs/);assert.equal(f.reloads,0);
}));
test('whole selected set preflight prevents first-runner effects on later invalid registration',run(async f=>{
 f.record.runners.push({...f.runner,name:'second-fixture'});f.save();
 await assert.rejects(apply(f.record,{registrationRun:f.registrationRun,controlsPorts:f.controlsPorts}));assert.ok(!fs.existsSync(f.record.controls.directory));assert.equal(f.reloads,0);
}));
test('competing job hook files redirected output and foreign bytes are never taken over',run(async f=>{
 fs.appendFileSync(path.join(f.root,'.env'),'ACTIONS_RUNNER_HOOK_JOB_STARTED=/foreign/hook\n');
 await assert.rejects(apply(f.record,{registrationRun:f.registrationRun,controlsPorts:f.controlsPorts}),/competes/);assert.equal(f.reloads,0);
 fs.writeFileSync(path.join(f.root,'.env'),'original\n');fs.mkdirSync(f.record.controls.directory,{mode:0o700});fs.writeFileSync(f.hook,'foreign',{mode:0o700});
 await assert.rejects(apply(f.record,{registrationRun:f.registrationRun,controlsPorts:f.controlsPorts}),/competing/);assert.equal(fs.readFileSync(f.hook,'utf8'),'foreign');assert.equal(f.reloads,0);
 fs.unlinkSync(f.hook);fs.symlinkSync(f.root,f.hook);
 await assert.rejects(apply(f.record,{registrationRun:f.registrationRun,controlsPorts:f.controlsPorts}),/redirected/);assert.equal(f.reloads,0);
}));
test('unadmitted direct registration/configuration and legacy apply refuse before mutable native or download path',run(async f=>{
 let commands=0;assert.throws(()=>configureRunner(f.runner,'fixture-token',{run:()=>commands++}),/issued original host admission/);
 const legacy={...f.runner,root:path.join(f.root,'legacy'),version:'2.338.2',existing:undefined};
 assert.throws(()=>registerRunner(legacy,[],{run:()=>{commands++;return JSON.stringify({total_count:0,runners:[]});}}),/issued original host admission/);assert.equal(commands,1,'only native GET is permitted');
 await assert.rejects(apply({schema:f.record.schema,runners:[legacy]},{registrationRun:()=>JSON.stringify({total_count:0,runners:[]})}),/hostAdmission declaration required/);
 assert.ok(!fs.existsSync(legacy.root));
}));
test('interrupted exclusive staging custody blocks successor allocation and preserves unrelated content',run(async f=>{
 fs.mkdirSync(f.record.controls.directory,{mode:0o700});const pending=f.hook+'.pending';fs.writeFileSync(pending,'owned interrupted source bytes',{mode:0o600});
 await assert.rejects(apply(f.record,{registrationRun:f.registrationRun,controlsPorts:f.controlsPorts}),/interrupted controls staging/);
 assert.equal(fs.readFileSync(pending,'utf8'),'owned interrupted source bytes');assert.ok(!fs.existsSync(f.hook));assert.equal(f.reloads,0);
}));
test('original native pause and exact frozen cohort are required before any control write',async()=>{
 for(const change of [f=>{f.pauseState.MainPID='102';},f=>{f.pauseState.InvocationID='b'.repeat(32);},f=>{f.pauseState.Job='17';},f=>{f.pauseState.FreezerState='running';},f=>{f.kernel.freeze='0';},f=>{f.kernel.pids.push(104);},f=>{f.pauseNative.unit=()=>({...f.native(),...f.pauseState,conditions:[],DropInPaths:''});}]){
  const f=await fixture();try{change(f);await assert.rejects(apply(f.record,{registrationRun:f.registrationRun,controlsPorts:f.controlsPorts}));assert.ok(!fs.existsSync(f.record.controls.directory));assert.equal(f.reloads,0);}finally{f.cleanup();}
 }
});
test('a raced replacement after reload refuses protection claim and preserves original pause custody',run(async f=>{
 const old=f.controlsPorts.reload,marker=sha(fs.readFileSync(f.q.marker)),guard=sha(fs.readFileSync(f.q.guard));
 f.controlsPorts.reload=()=>{old();f.pauseState.InvocationID='b'.repeat(32);};
 await assert.rejects(apply(f.record,{registrationRun:f.registrationRun,controlsPorts:f.controlsPorts}),/invocation/);
 assert.equal(sha(fs.readFileSync(f.q.marker)),marker);assert.equal(sha(fs.readFileSync(f.q.guard)),guard);assert.equal(f.kernel.freeze,'1');assert.ok(fs.existsSync(f.hook));
}));
