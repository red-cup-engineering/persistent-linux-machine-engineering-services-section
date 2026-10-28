import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {planUserManagerMaintenance,advanceUserManagerMaintenance} from '../scripts/user-manager-maintenance.mjs';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'linux-manager-source-')),runtime=join(root,'runtime'),work=join(root,'work');
 mkdirSync(runtime,{mode:0o700});mkdirSync(work,{mode:0o700});t.after(()=>rmSync(root,{recursive:true,force:true}));
 const id='native-receiving',request={type:'LinuxUserManagerMaintenance',version:1,id,work,inputs:[],environment:[],managerUnit:'user@'+process.getuid()+'.service',runtimeDirectory:runtime},calls=[];
 const original=join(root,'original.conf');writeFileSync(original,'[Service]\nExecStart=/immutable/original\n',{mode:0o600});
 const marker=join(root,'original-hold.json');writeFileSync(marker,'ORIGINAL HOLD\n',{mode:0o600});
 const units=new Map();
 const base=name=>({Id:name,LoadState:'loaded',ActiveState:'active',SubState:'running',FreezerState:'running',MainPID:'201',ControlPID:'0',ControlGroup:'/app',Job:'',InvocationID:'a'.repeat(32),FragmentPath:original,DropInPaths:'',Restart:'always',Type:'simple'});
 units.set('app.service',base('app.service'));
 units.set('job.service',{...base('job.service'),SubState:'exited',MainPID:'0',ControlGroup:'',Type:'oneshot',InvocationID:'b'.repeat(32)});
 units.set('held.service',{...base('held.service'),ActiveState:'activating',SubState:'auto-restart-queued',FreezerState:'frozen',MainPID:'0',ControlGroup:'',InvocationID:'c'.repeat(32)});
 units.set('clock.timer',{...base('clock.timer'),SubState:'waiting',MainPID:'0',ControlGroup:''});
 let manager={Id:'user@'+process.getuid()+'.service',ActiveState:'active',SubState:'running',MainPID:'90',InvocationID:'d'.repeat(32),OwnerUid:process.getuid(),SystemdUser:true,RuntimeDirectory:runtime,ControlGroup:'/user.slice/user-'+process.getuid()+'.slice/user@'+process.getuid()+'.service'};
 let outside=true,keyCount=0,reloadFault=false,restartFault=false;
 const guard=name=>join(runtime,'systemd/user',name+'.d','99-persistent-linux-manager-maintenance-'+id+'.conf');
 const port={
  uid:()=>process.getuid(),boot:()=> 'original-boot',runtime:()=>runtime,manager:()=>({...manager}),
  apiManagerPid:()=>manager.MainPID,
  environmentDigests:()=>[],
  controllerGroup:()=>outside?'0::/system.slice/original-controller.service':'0::/user.slice/user-'+process.getuid()+'.slice/user@'+process.getuid()+'.service/app.slice/controller.service',
  processAbsent:pid=>!([...units.values()].some(x=>x.MainPID===pid&&pid!=='0')||manager.MainPID===pid),
  unit:name=>{const u=units.get(name);assert.ok(u,'unexpected unit '+name);const held=existsSync(guard(name));return{...u,DropInPaths:held?guard(name):u.DropInPaths,Restart:held?'no':u.Restart,ExecCondition:held?'{ path=/usr/bin/false ; argv[]=/usr/bin/false ; }':''}},
  active:()=>[{unit:'init.scope',active:'active',sub:'running'},...[...units.values()].filter(x=>!['inactive','failed'].includes(x.ActiveState)).map(x=>({unit:x.Id,active:x.ActiveState,sub:x.SubState}))],
  files:()=>['app.service','job.service','held.service','worker@.service'],jobs:()=>'',keys:()=>keyCount,
  bindings:name=>({unit:name,inputFiles:[],profiles:[],startCommandsSha256:'0'.repeat(64),conditionSha256:existsSync(guard(name))?[createHash('sha256').update(JSON.stringify(['/usr/bin/false',['/usr/bin/false'],false])).digest('hex')]:[],environmentSha256:'1'.repeat(64),inlineCredentialsSha256:'2'.repeat(64)}),
  reload:()=>{calls.push(['reload']);if(reloadFault){reloadFault=false;throw Error('unreceived reload reply')}},
  stop:names=>{calls.push(['stop',names]);for(const name of names)Object.assign(units.get(name),{ActiveState:'inactive',SubState:'dead',MainPID:'0',ControlPID:'0',ControlGroup:'',Job:''})},
  start:names=>{calls.push(['start',names]);for(const name of names)Object.assign(units.get(name),name.endsWith('.service')?{ActiveState:'active',SubState:'running',MainPID:'301',ControlGroup:'/app',FreezerState:'running'}:{ActiveState:'active',SubState:'waiting'})},
  restartManager:()=>{calls.push(['restart']);manager={...manager,MainPID:'900',InvocationID:'e'.repeat(32)};for(const u of units.values())Object.assign(u,{ActiveState:'inactive',SubState:'dead',MainPID:'0',ControlGroup:'',FreezerState:'running'});if(restartFault)throw Error('unreceived restart reply')},
  listeners:()=>{const app=units.get('app.service');return app.MainPID==='0'?'':'tcp LISTEN 0 511 127.0.0.1:8080 0.0.0.0:* users:(("node",pid='+app.MainPID+',fd=20))\n'},
  pids:group=>[...units.values()].filter(x=>group&&x.ControlGroup===group&&x.MainPID!=='0').map(x=>Number(x.MainPID))
 };
 const act=action=>advanceUserManagerMaintenance(request,action,port);
 return {root,runtime,work,request,calls,units,port,original,marker,guard,act,
  setup:()=>planUserManagerMaintenance(request,port),
  setInside:()=>{outside=false},setKeys:x=>{keyCount=x},failReload:()=>{reloadFault=true},failRestart:()=>{restartFault=true},
  outcome:()=>JSON.parse(readFileSync(join(work,id+'.json'),'utf8'))};
}

test('same-incumbent manager recovery conserves holds and never replays completed work',t=>{
 const f=fixture(t);f.setup();for(const action of ['fence','stop','restart','receive-restart','restore','receive','receive-activation'])f.act(action);
 assert.equal(f.outcome().phase,'completed');assert.equal(readFileSync(f.marker,'utf8'),'ORIGINAL HOLD\n');
 assert.equal(readFileSync(f.original,'utf8'),'[Service]\nExecStart=/immutable/original\n');
 assert.deepEqual(f.calls.filter(x=>x[0]==='start').flatMap(x=>x[1]),['app.service','clock.timer']);
 assert.equal(f.calls.filter(x=>x[0]==='restart').length,1);
 assert.equal(f.outcome().completedJobsExplicitlyStarted,false);assert.equal(f.outcome().externalEffectsReconciled,false);
 for(const name of f.port.files())assert.equal(existsSync(f.guard(name)),false);
});
test('foreign execution scope refuses before any control effect',t=>{
 const f=fixture(t),old=f.port.active;f.port.active=()=>[...old(),{unit:'original-work.scope',active:'active',sub:'running'}];
 assert.throws(()=>f.setup(),/foreign execution scope/);assert.deepEqual(f.calls,[]);
});
test('nonempty SSH identity custody refuses before maintenance',t=>{
 const f=fixture(t);f.units.set('ssh-agent.service',{...f.units.get('app.service'),Id:'ssh-agent.service'});f.setKeys(1);
 assert.throws(()=>f.setup(),/SSH agent/);assert.deepEqual(f.calls,[]);
});
test('frozen resident cannot be silently included in manager replacement',t=>{
 const f=fixture(t);Object.assign(f.units.get('held.service'),{MainPID:'444',ControlGroup:'/held'});
 assert.throws(()=>f.setup(),/frozen resident/);assert.deepEqual(f.calls,[]);
});
test('a changed incumbent is received before stop rather than killed',t=>{
 const f=fixture(t);f.setup();f.act('fence');f.units.get('app.service').MainPID='222';
 assert.throws(()=>f.act('stop'),/captured consumer changed/);assert.equal(f.calls.some(x=>x[0]==='stop'),false);
});
test('configuration drift refuses maintenance without restoring obsolete bytes',t=>{
 const f=fixture(t);f.setup();f.act('fence');writeFileSync(f.original,'CHANGED BY ORIGINAL OWNER\n');
 assert.throws(()=>f.act('stop'),/configuration changed/);assert.equal(readFileSync(f.original,'utf8'),'CHANGED BY ORIGINAL OWNER\n');
});
test('restart controller must be outside the affected user-manager subtree',t=>{
 const f=fixture(t);f.setup();f.act('fence');f.act('stop');f.setInside();
 assert.throws(()=>f.act('restart'),/inside affected manager/);assert.equal(f.calls.some(x=>x[0]==='restart'),false);
});
test('an unreceived restart is observed and never replayed',t=>{
 const f=fixture(t);f.setup();f.act('fence');f.act('stop');f.failRestart();
 assert.throws(()=>f.act('restart'),/unreceived restart reply/);assert.equal(f.outcome().phase,'restarting');
 assert.throws(()=>f.act('restart'),/requires observed stopping/);f.act('receive-restart');f.act('restore');f.act('receive');f.act('receive-activation');
 assert.equal(f.calls.filter(x=>x[0]==='restart').length,1);
});
test('interrupted fence resumes its original controls and rejects replaced guard bytes',t=>{
 const f=fixture(t);f.setup();f.failReload();assert.throws(()=>f.act('fence'),/unreceived reload/);
 assert.equal(f.outcome().phase,'fencing');f.act('fence');writeFileSync(f.guard('app.service'),'FOREIGN GUARD\n');
 assert.throws(()=>f.act('stop'),/guard bytes changed/);assert.equal(f.calls.some(x=>x[0]==='stop'),false);
});
test('changed listening endpoint is an unreceived consumer, not a complete operation',t=>{
 const f=fixture(t);f.setup();for(const a of ['fence','stop','restart','receive-restart','restore'])f.act(a);
 f.port.listeners=()=> 'tcp LISTEN 0 511 127.0.0.1:9090 0.0.0.0:* users:(("node",pid=301,fd=20))\n';
 assert.throws(()=>f.act('receive'),/listening endpoints/);assert.equal(f.outcome().phase,'restoring');
});
test('private input bytes are hash-bound without copying values into the outcome',t=>{
 const f=fixture(t),input=join(f.root,'provider-input');writeFileSync(input,'fixture-private-provider-value',{mode:0o600});
 f.request.inputs.push({path:input,sha256:createHash('sha256').update(readFileSync(input)).digest('hex')});f.setup();
 assert.equal(JSON.stringify(f.outcome()).includes('fixture-private-provider-value'),false);
 writeFileSync(input,'rotated-by-original-owner');assert.throws(()=>f.act('fence'),/input digest changed/);
 assert.equal(f.calls.length,0);
});
test('native inline credential or environment drift refuses before stopping',t=>{
 const f=fixture(t);f.setup();f.act('fence');const previous=f.port.bindings;
 f.port.bindings=name=>({...previous(name),environmentSha256:'f'.repeat(64)});
 assert.throws(()=>f.act('stop'),/credential binding changed/);assert.equal(f.calls.some(x=>x[0]==='stop'),false);
});
