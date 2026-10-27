// Explicit native qualification only: one unique harmless unit and owned RAM files.
// No production unit, registration, key, download, cleanup hook or worker is touched.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {admissionFixture,sha} from './fixtures/host-admission.mjs';
import {apply,observeExistingControls} from '../src/ci-runner-host.mjs';

const output=process.argv[2],expectedFixtureSha256=process.argv[3],scenario=process.argv[4];
assert.ok(output&&path.isAbsolute(output),'explicit qualification receipt required');
const fixtureSha256=sha(fs.readFileSync(fileURLToPath(import.meta.url)));
assert.match(expectedFixtureSha256??'',/^[a-f0-9]{64}$/,'explicit received fixture SHA256 required');
assert.equal(fixtureSha256,expectedFixtureSha256,'native fixture source changed before effects');
assert.equal(scenario,'frozen-resident-reload-v1','only the received frozen-case scenario is admitted');
assert.ok(!fs.existsSync(output)&&!fs.existsSync(output+'.intent.json'),'unique receipt required');
const f=admissionFixture(),root=f.root,uid=process.getuid(),name='admission-fixture-'+randomBytes(8).toString('hex');
const unit='ci-runner-'+name+'.service',fragment=path.join(os.homedir(),'.config/systemd/user',unit),dropdir=fragment+'.d';
assert.ok(!fs.existsSync(fragment)&&!fs.existsSync(dropdir),'native fixture namespace collision');
const systemctl=(...args)=>execFileSync('/usr/bin/systemctl',['--user',...args],{encoding:'utf8',timeout:15000,maxBuffer:65536,stdio:['ignore','pipe','pipe']});
const native=()=>Object.fromEntries(systemctl('show',unit,'--no-pager','--property=Id,ActiveState,SubState,MainPID,ControlPID,Job,ControlGroup,ExecCondition,Result').trimEnd().split('\n').map(line=>{const n=line.indexOf('=');return[line.slice(0,n),line.slice(n+1)];}));
const intent={scope:'original CI owner own native preventive controls qualification only',fixtureSha256,scenario,uid,root,rootInode:fs.statSync(root).ino,unit,fragment,dropdir,receipt:output,
 effects:['one harmless sleep resident: original owner start/freeze/frozen90hold then exact own stop','original controls-only apply interrupted before reload then native reload-only reentry','terminal fixture90retirement then separate80startup assay and job/source refusal','daemon-reload','exact fixture cleanup after received terminal'],
 exclusions:'no production runner state/registration/key/download/POST/thaw/restart or original completion hook'};
fs.writeFileSync(output+'.intent.json',JSON.stringify(intent,null,2)+'\n',{flag:'wx',mode:0o600});
const report={intent,phase:'prepared'};let terminal=false,ownedFragment,ownedDropin,ownedPause;
try{
 const runnerRoot=path.join(root,'flat');fs.mkdirSync(runnerRoot,{mode:0o700});
 const sentinel=path.join(runnerRoot,'sentinel');fs.writeFileSync(path.join(runnerRoot,'run.sh'),'#!/bin/sh\nexec /usr/bin/sleep infinity\n',{mode:0o700});
 fs.writeFileSync(path.join(runnerRoot,'.runner'),JSON.stringify({agentId:42,agentName:name,gitHubUrl:'https://github.com/fixture/owned',workFolder:'_work'}),{mode:0o600});
 fs.writeFileSync(path.join(runnerRoot,'.env'),'ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/fixture/not-executed\n',{mode:0o600});
 const gh=path.join(root,'fixture-gh');
 fs.writeFileSync(gh,'#!'+process.execPath+'\nconst a=process.argv.slice(2);if(!a.includes("GET")||a.includes("POST"))process.exit(19);console.log(JSON.stringify({total_count:1,runners:[{id:42,name:'+JSON.stringify(name)+',status:"offline",busy:false,labels:[]}]}));\n',{mode:0o700});
 fs.writeFileSync(fragment,'[Unit]\nDescription=Owned original CI admission fixture\n[Service]\nType=simple\nWorkingDirectory='+runnerRoot+'\nExecStartPre=/usr/bin/touch '+sentinel+'\nExecStart='+runnerRoot+'/run.sh\n',{flag:'wx',mode:0o600});
 ownedFragment={ino:fs.statSync(fragment).ino,sha256:sha(fs.readFileSync(fragment))};
 const fragmentInode=fs.statSync(fragment).ino;
 systemctl('daemon-reload');systemctl('start',unit);assert.ok(fs.existsSync(sentinel));systemctl('freeze',unit);report.baseline=native();assert.ok(Number(report.baseline.MainPID)>0);fs.unlinkSync(sentinel);
 const runtime=path.join(root,'runtime');fs.mkdirSync(path.join(runtime,'src'),{recursive:true});fs.mkdirSync(path.join(runtime,'scripts'));
 const original=fileURLToPath(new URL('../',import.meta.url));
 const files=['scripts/ci-runner-host.mjs','src/ci-runner-host.mjs','src/host-admission.mjs','src/existing-controls.mjs','src/runner-layout.mjs'].map(p=>{
  const data=fs.readFileSync(path.join(original,p)),target=path.join(runtime,p);fs.writeFileSync(target,data,{mode:0o600});return{path:target,sha256:sha(data)};
 });
 const record={...f.record,controls:{mode:'existing-flat',uid,home:os.homedir(),directory:path.join(root,'controls'),parametersPath:path.join(root,'ci.json'),runtime:{node:process.execPath,cli:path.join(runtime,'scripts/ci-runner-host.mjs'),files}},runners:[{name,root:runnerRoot,scope:'https://github.com/fixture/owned',labels:[],registration:{executable:gh},existing:{id:42,unitFragment:fragment,unitFragmentSha256:sha(fs.readFileSync(fragment))}}]};
 const pauseSource=process.env.WSL_QUARANTINE_SOURCE??fileURLToPath(new URL('../../wsl-host-service/src/user-unit-quarantine.mjs',import.meta.url));
 const pauseBytes=fs.readFileSync(pauseSource),pauseModule=path.join(root,'provider/src/user-unit-quarantine.mjs');fs.writeFileSync(pauseModule,pauseBytes,{mode:0o400});record.controls.pauseProvider={module:pauseModule,sha256:sha(pauseBytes)};
 const originalPause=await import(new URL('file://'+pauseModule).href),section=path.join(root,'ci-native-operations-services-section');fs.mkdirSync(section,{mode:0o700});
 const pausePort=originalPause.nativeQuarantinePort(),resident=pausePort.unit(unit),pid=Number(resident.MainPID),expected={pid,bootId:pausePort.boot(),invocationId:resident.InvocationID,controlGroup:resident.ControlGroup,process:pausePort.process(pid)};
 const declaration={id:'own-native-ci-pause',unit,uid,home:os.homedir(),sectionRoot:section,origin:'https://github.com/fixture/owner/issues/4',captureMode:'frozen-resident',releasePolicy:'hold-only',expected};
 f.host.linux={userUnitQuarantines:[declaration]};f.saveHost();const q=originalPause.quarantineDeclaration(f.host,declaration.id);
 assert.ok(!fs.existsSync(q.marker)&&!fs.existsSync(q.guard),'own pause fixture collision');
 report.pauseHeld=originalPause.holdQuarantine(f.host,undefined,declaration.id);
 ownedPause={marker:q.marker,guard:q.guard,markerInode:fs.statSync(q.marker).ino,guardInode:fs.statSync(q.guard).ino,markerSha256:sha(fs.readFileSync(q.marker)),guardSha256:sha(fs.readFileSync(q.guard))};
 record.runners[0].existing.pause={id:declaration.id,markerSha256:ownedPause.markerSha256,guardSha256:ownedPause.guardSha256,cohort:[{pid,startTime:expected.process.startTime}]};
 record.hostAdmission.phasePeakBytes={materialization:null,startup:null,job:null};fs.writeFileSync(record.controls.parametersPath,JSON.stringify(record),{mode:0o600});
 const installedHook=path.join(record.controls.directory,name+'-admit.sh'),installedDropin=path.join(dropdir,'80-ci-runner-host-admission.conf');
 let interrupted;try{await apply(record,{controlsPorts:{reload:()=>{throw Error('owned fixture interruption before reload');}}});}catch(error){interrupted=error;}
 assert.ok(interrupted&&/interruption before reload/.test(interrupted.message));
 report.interruptedOutcome={message:interrupted.message,controlWrites:interrupted.controlWrites};
 const createdDropin=interrupted.controlWrites.find(item=>item.path===installedDropin);assert.ok(createdDropin);ownedDropin={ino:createdDropin.ino,sha256:createdDropin.sha256};
 const interruptedFiles=[installedHook,installedDropin].map(p=>({path:p,ino:fs.statSync(p).ino,sha256:sha(fs.readFileSync(p))}));
 report.interruptedLoad=await observeExistingControls(record);assert.equal(report.interruptedLoad[0].status,'drift');
 report.application=await apply(record);assert.equal(report.application.length,1);assert.match(report.application[0],/reloaded/);
 for(const file of interruptedFiles){assert.equal(fs.statSync(file.path).ino,file.ino);assert.equal(sha(fs.readFileSync(file.path)),file.sha256);}
 report.reloadRecovery={writes:0,files:interruptedFiles,current:await observeExistingControls(record)};assert.equal(report.reloadRecovery.current[0].status,'current');
 assert.deepEqual(await apply(record),[]);report.loaded=native();
 const installed=path.join(dropdir,'80-ci-runner-host-admission.conf');ownedDropin={ino:fs.statSync(installed).ino,sha256:sha(fs.readFileSync(installed))};
 const hook=path.join(record.controls.directory,name+'-admit.sh');assert.ok(report.loaded.ExecCondition.includes('path='+hook+' ;'));
 report.pauseReceiving=originalPause.planQuarantine(f.host,undefined,declaration.id);assert.equal(report.pauseReceiving.status,'held');
 report.sameFrozenInvocation=originalPause.planQuarantine(f.host,undefined,declaration.id);assert.deepEqual(report.sameFrozenInvocation.original,report.pauseReceiving.original);
 systemctl('stop',unit);
 const pauseTerminal=native();assert.equal(pauseTerminal.ActiveState,'inactive');assert.equal(pauseTerminal.MainPID,'0');assert.equal(pauseTerminal.ControlPID,'0');assert.equal(pauseTerminal.ControlGroup,'');assert.equal(pauseTerminal.Job,'');assert.ok(!fs.existsSync('/proc/'+pid));
 // This disposable frozen90hold experiment is terminal and is retired here
 // as fixture custody, not released through the hold-only policy. Isolate the
 // subsequent80ExecCondition assay so90does not short-circuit its execution.
 assert.equal(fs.statSync(q.guard).ino,ownedPause.guardInode);assert.equal(sha(fs.readFileSync(q.guard)),ownedPause.guardSha256);assert.equal(fs.statSync(q.marker).ino,ownedPause.markerInode);assert.equal(sha(fs.readFileSync(q.marker)),ownedPause.markerSha256);
 fs.unlinkSync(q.guard);fs.unlinkSync(q.marker);systemctl('daemon-reload');report.pauseFixtureRetirement={terminal:pauseTerminal,guardAbsent:!fs.existsSync(q.guard),markerAbsent:!fs.existsSync(q.marker),holdOnlyReleaseInvoked:false,productionHoldChanged:false};
 systemctl('start',unit);report.refused=native();assert.ok(!fs.existsSync(sentinel),'startup refusal must precede original run script');
 // Inactive units may be garbage collected before show and lose transient exit
 // status. Receive the actual unique unit's journal, not a reconstructed status.
 const journal=execFileSync('/usr/bin/journalctl',['--user','--unit='+unit,'--lines=32','--no-pager','--output=json'],{encoding:'utf8',timeout:10000,maxBuffer:65536});
 report.startupJournal=journal.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.USER_UNIT===unit||row._SYSTEMD_USER_UNIT===unit).map(row=>({unit:row.USER_UNIT??row._SYSTEMD_USER_UNIT,pid:row._PID,invocation:row.USER_INVOCATION_ID??row._SYSTEMD_INVOCATION_ID,message:row.MESSAGE,result:row.UNIT_RESULT}));
 assert.ok(report.startupJournal.some(row=>/unknown or zero startup peak/.test(row.message)));
 assert.ok(report.startupJournal.some(row=>row.result==='exec-condition'));
 assert.equal(report.refused.ActiveState,'inactive');assert.equal(report.refused.MainPID,'0');assert.equal(report.refused.ControlPID,'0');assert.equal(report.refused.Job,'');assert.equal(report.refused.ControlGroup,'');
 const job=spawnSync(hook,[],{encoding:'utf8',timeout:15000,maxBuffer:16384});assert.ifError(job.error);assert.equal(job.status,1);assert.match(job.stderr,/unknown or zero job peak/);report.job={status:job.status,stdout:job.stdout,stderr:job.stderr};
 fs.appendFileSync(record.controls.runtime.cli,'\nthrow Error("fixture source must never execute");\n');
 const drift=spawnSync(hook,[],{encoding:'utf8',timeout:15000,maxBuffer:16384});assert.ifError(drift.error);assert.equal(drift.status,1);assert.ok(!drift.stderr.includes('fixture source must never execute'),'source digest guard must precede changed module execution');report.sourceDrift={status:drift.status,stdout:drift.stdout,stderr:drift.stderr};
 assert.equal(fs.statSync(fragment).ino,fragmentInode);assert.equal(sha(fs.readFileSync(fragment)),record.runners[0].existing.unitFragmentSha256);
 report.terminal=native();terminal=report.terminal.ActiveState==='inactive'&&report.terminal.MainPID==='0'&&report.terminal.ControlPID==='0'&&report.terminal.Job===''&&report.terminal.ControlGroup==='';assert.ok(terminal,'native fixture is not terminal; retain custody');
 report.phase='qualified';
}catch(error){report.failure={name:error.name,message:error.message};throw error;}
finally{
 try{
  const current=native();terminal=current.ActiveState==='inactive'&&current.MainPID==='0'&&current.ControlPID==='0'&&current.Job===''&&current.ControlGroup==='';report.cleanupTerminal=current;
  if(terminal){
   const files=[];const walk=dir=>{for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,ent.name),st=fs.lstatSync(p);assert.ok(!st.isSymbolicLink(),'unexpected fixture redirect; custody retained');assert.ok(files.length<128,'unexpected fixture growth; custody retained');if(ent.isDirectory())walk(p);else files.push({path:p,bytes:st.size,sha256:sha(fs.readFileSync(p))});}};walk(root);report.retiredManifest=files;
   if(ownedPause){for(const [p,ino,hash] of [[ownedPause.guard,ownedPause.guardInode,ownedPause.guardSha256],[ownedPause.marker,ownedPause.markerInode,ownedPause.markerSha256]])if(fs.existsSync(p)){assert.equal(fs.statSync(p).ino,ino);assert.equal(sha(fs.readFileSync(p)),hash);fs.unlinkSync(p);}}
   const dropin=path.join(dropdir,'80-ci-runner-host-admission.conf');if(fs.existsSync(dropin)){assert.ok(ownedDropin&&fs.statSync(dropin).ino===ownedDropin.ino&&sha(fs.readFileSync(dropin))===ownedDropin.sha256,'native drop-in custody changed');fs.unlinkSync(dropin);}if(fs.existsSync(dropdir))fs.rmdirSync(dropdir);
   if(fs.existsSync(fragment)){assert.ok(ownedFragment&&fs.statSync(fragment).ino===ownedFragment.ino&&sha(fs.readFileSync(fragment))===ownedFragment.sha256,'native fragment custody changed');fs.unlinkSync(fragment);}systemctl('daemon-reload');
   assert.equal(fs.statSync(root).ino,intent.rootInode);f.cleanup();report.cleanup={unitFragmentAbsent:!fs.existsSync(fragment),dropdirAbsent:!fs.existsSync(dropdir),rootAbsent:!fs.existsSync(root)};
  }else report.cleanup={retained:true,reason:'native fixture state not received terminal; no cleanup'};
 }catch(error){report.cleanup={retained:true,name:error.name,message:error.message};process.exitCode=1;}
 fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
}
assert.equal(report.phase,'qualified');assert.ok(report.cleanup?.rootAbsent,'native fixture cleanup not received');
console.log('native original CI controls passed reload-only recovery, startup refusal and job/source refusal; exact fixture retired');
