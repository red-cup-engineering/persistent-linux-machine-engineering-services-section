#!/usr/bin/env node
/** Run only as the exclusively test-owned SYSTEM controller unit. The real
 * user manager is never selected; a separate bounded manager uses private state.
 */
import assert from'node:assert/strict';
import{execFileSync}from'node:child_process';
import{createHash}from'node:crypto';
import{mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,readdirSync,lstatSync,chmodSync,symlinkSync}from'node:fs';
import{join,resolve}from'node:path';
import{tmpdir}from'node:os';
import{setTimeout as pause}from'node:timers/promises';
import{fileURLToPath}from'node:url';
import{nativeUserManagerPort,planUserManagerMaintenance,advanceUserManagerMaintenance}from'../scripts/user-manager-maintenance.mjs';
import{importUserManagerEnvironment}from'../scripts/import-user-manager-environment.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const[base,managerUnit,controllerUnit,...extra]=process.argv.slice(2);
if(extra.length||!base||resolve(base)!==base||![managerUnit,controllerUnit].every(x=>/^linux-manager-maintenance-fixture-[a-z0-9-]+\.service$/.test(x)))throw Error('exact exclusively owned native fixture required');
const run=(file,args,env)=>execFileSync(file,args,{env:env||process.env,encoding:'utf8',timeout:15000,maxBuffer:1048576});
const sys=(...args)=>run('/usr/bin/sudo',['-n','/usr/bin/systemctl',...args]);
const root=mkdtempSync(join(base,'native-')),runtime=mkdtempSync(join(tmpdir(),'linux-manager-fixture-'));
const units=join(root,'units'),work=join(root,'work'),configuration=join(root,'config');
for(const p of [units,work,configuration,join(runtime,'systemd/user')])mkdirSync(p,{recursive:true,mode:0o700});
const write=(name,text)=>writeFileSync(join(units,name),text,{mode:0o600});
const credentialFile=join(base,'credential.env'),credential=join(base,'native-credential');
const expected=hash(process.env.FIXTURE_SOURCE||'');
assert.ok(process.env.FIXTURE_SOURCE,'native system controller EnvironmentFile input absent');
const appCount=join(root,'app.count'),onceCount=join(root,'once.count'),heldCount=join(root,'held.count'),portFile=join(root,'app.port'),marker=join(root,'original.pending');
writeFileSync(join(root,'once.mjs'),`import{existsSync,readFileSync,writeFileSync}from'node:fs';const p=process.argv[2];writeFileSync(p,String((existsSync(p)?Number(readFileSync(p,'utf8')):0)+1),{mode:0o600});\n`,{mode:0o600});
writeFileSync(join(root,'held.mjs'),`import{existsSync,readFileSync,writeFileSync}from'node:fs';const p=process.argv[2];writeFileSync(p,String((existsSync(p)?Number(readFileSync(p,'utf8')):0)+1),{mode:0o600});setInterval(()=>{},1000);\n`,{mode:0o600});
writeFileSync(join(root,'app.mjs'),`import{existsSync,readFileSync,writeFileSync}from'node:fs';import{createServer}from'node:http';import{createHash}from'node:crypto';import{join}from'node:path';const h=x=>createHash('sha256').update(x).digest('hex');if(h(process.env.FIXTURE_KEY||'')!==${JSON.stringify(expected)}||h(readFileSync(join(process.env.CREDENTIALS_DIRECTORY,'fixture')))!==${JSON.stringify(expected)})throw Error('normal credential reconstruction absent');const[c,p]=process.argv.slice(2);writeFileSync(c,String((existsSync(c)?Number(readFileSync(c,'utf8')):0)+1),{mode:0o600});const server=createServer((_,r)=>r.end('original programme\\n'));server.listen(existsSync(p)?Number(readFileSync(p,'utf8')):0,'127.0.0.1',()=>{if(!existsSync(p))writeFileSync(p,String(server.address().port),{mode:0o600})});\n`,{mode:0o600});
write('fixture.target','[Unit]\nDefaultDependencies=no\nWants=dbus.socket\nAfter=dbus.socket\n');
write('dbus.socket','[Unit]\nDefaultDependencies=no\n[Socket]\nListenStream=%t/bus\nSocketMode=0600\n');
write('dbus.service','[Unit]\nDefaultDependencies=no\nRequires=dbus.socket\nAfter=dbus.socket\n[Service]\nType=notify\nNotifyAccess=main\nExecStart=/usr/bin/dbus-daemon --session --address=systemd: --nofork --nopidfile --systemd-activation --syslog-only\n');
write('app.service',`[Unit]\nDefaultDependencies=no\nRequires=once.service\nAfter=once.service\n[Service]\nType=simple\nEnvironmentFile=${credentialFile}\nLoadCredential=fixture:${credential}\nExecStart=${process.execPath} --max-old-space-size=24 ${join(root,'app.mjs')} ${appCount} ${portFile}\nRestart=on-failure\nRestartSec=1\n`);
write('once.service',`[Unit]\nDefaultDependencies=no\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=${process.execPath} --max-old-space-size=24 ${join(root,'once.mjs')} ${onceCount}\n`);
write('held.service',`[Unit]\nDefaultDependencies=no\nConditionPathExists=!${marker}\n[Service]\nExecCondition=/usr/bin/test ! -e ${marker}\nExecStart=${process.execPath} --max-old-space-size=24 ${join(root,'held.mjs')} ${heldCount}\nRestart=always\nRestartSec=1\nRuntimeMaxSec=45\n`);
write('clock.service','[Unit]\nDefaultDependencies=no\n[Service]\nType=oneshot\nExecStart=/usr/bin/true\n');
write('clock.timer','[Unit]\nDefaultDependencies=no\n[Timer]\nOnActiveSec=1h\nUnit=clock.service\n');
const input={type:'LinuxUserManagerMaintenance',version:1,id:'whole-native-receiving',work,managerUnit,runtimeDirectory:runtime,inputs:[],environment:[{name:'FIXTURE_KEY',sha256:expected}]};
const port=nativeUserManagerPort(input),environment={...process.env,XDG_RUNTIME_DIR:runtime,DBUS_SESSION_BUS_ADDRESS:'unix:path='+runtime+'/bus'};
const user=(...args)=>run('/usr/bin/systemctl',['--user',...args],environment);
async function waitFor(label,fn){const until=Date.now()+15000;let last;while(Date.now()<until){try{const result=await fn();if(result)return result}catch(e){last=e.message}await pause(100)}throw Error(label+' deadline'+(last?': '+last.split('\n')[0]:''))}
const received={type:'LinuxUserManagerNativeMaintenanceQualification',version:1,managerUnit,controllerUnit,root,runtime,source:{maintenance:hash(readFileSync(fileURLToPath(new URL('../scripts/user-manager-maintenance.mjs',import.meta.url)))),importer:hash(readFileSync(fileURLToPath(new URL('../scripts/import-user-manager-environment.mjs',import.meta.url)))),bindingObserver:hash(readFileSync(fileURLToPath(new URL('../scripts/user-manager-binding-observation.py',import.meta.url))))},phases:[]};
const importer={type:'LinuxUserManagerEnvironmentImport',version:1,id:'native-credential-reconstruction',work,managerUnit,runtimeDirectory:runtime,importerUnit:controllerUnit,environmentFile:{path:credentialFile,sha256:hash(readFileSync(credentialFile))},bindings:[{from:'FIXTURE_SOURCE',to:'FIXTURE_KEY',sha256:expected}]};
let managerCreated=false;
try{
 run('/usr/bin/sudo',['-n','/usr/bin/systemd-run','--unit='+managerUnit,'--collect','--property=User='+process.getuid(),'--property=Delegate=yes','--property=DelegateSubgroup=init.scope','--property=RuntimeMaxSec=90','--property=TimeoutStopSec=5','--property=KillMode=control-group','--property=MemoryMax=192M','--property=MemorySwapMax=0','--property=TasksMax=96','--setenv=XDG_RUNTIME_DIR='+runtime,'--setenv=XDG_CONFIG_HOME='+configuration,'--setenv=SYSTEMD_UNIT_PATH='+runtime+'/systemd/user:'+units,'--setenv=DBUS_SESSION_BUS_ADDRESS=unix:path='+runtime+'/bus','/usr/lib/systemd/systemd','--user','--log-target=journal','--unit=fixture.target']);
 managerCreated=true;
 await waitFor('private native manager',()=>existsSync(runtime+'/systemd/private')&&port.manager().ActiveState==='active');
 user('start','dbus.service');await waitFor('private API owner',()=>port.apiManagerPid()===port.manager().MainPID);
 assert.deepEqual(port.aliases(),[]);received.emptyAliasSelectionReceived=true;
 symlinkSync('app.service',join(units,'app-alias.service'));user('daemon-reload');
 assert.deepEqual(port.aliases(),['app-alias.service']);
 received.initialEnvironment=importUserManagerEnvironment(importer);
 user('start','app.service','once.service','held.service','clock.timer');
 await waitFor('original app endpoint',()=>existsSync(portFile)&&port.unit('app.service').ActiveState==='active');
 assert.equal(readFileSync(onceCount,'utf8'),'1');assert.equal(readFileSync(heldCount,'utf8'),'1');
 writeFileSync(marker,'test-owned original hold\n',{mode:0o600});
 user('freeze','held.service');const old=port.unit('held.service');assert.equal(old.FreezerState,'frozen');
 user('kill','--signal=KILL','--kill-whom=all','held.service');
 await waitFor('exact frozen queued empty state',()=>{const u=port.unit('held.service');return u.MainPID==='0'&&u.ControlPID==='0'&&!u.ControlGroup&&!u.Job&&u.SubState==='auto-restart-queued'&&u.FreezerState==='frozen'});
 received.captured=old;received.originalMarker=hash(readFileSync(marker));
 input.inputs=[marker,portFile,credential].map(path=>({path,sha256:hash(readFileSync(path))}));
 received.plan=planUserManagerMaintenance(input);
 const act=action=>{const result=advanceUserManagerMaintenance(input,action);received.phases.push(result);console.log(JSON.stringify({phase:result.phase}));return result};
 act('fence');act('stop');
 await waitFor('all ordinary original cohorts stopped',()=>['app.service','dbus.service','once.service'].every(name=>{const u=port.unit(name);return u.MainPID==='0'&&u.ControlPID==='0'&&!u.ControlGroup&&!u.Job&&['inactive','failed'].includes(u.ActiveState)}));
 act('restart');await waitFor('new real system manager',()=>{const m=port.manager();return m.ActiveState==='active'&&m.SystemdUser&&m.MainPID!==JSON.parse(readFileSync(join(work,input.id+'.json'),'utf8')).manager.MainPID});
 await waitFor('replacement terminal receiving',()=>{try{return act('receive-restart').phase==='restarted'}catch{return false}});
 assert.throws(()=>act('restore'),/environment not reconstructed/);
 assert.equal(readFileSync(appCount,'utf8'),'1');
 received.reconstructedEnvironment=importUserManagerEnvironment(importer);
 act('restore');
 await waitFor('restored original API',()=>port.apiManagerPid()===port.manager().MainPID);
 await waitFor('restored original programme',()=>port.unit('app.service').SubState==='running'&&existsSync(portFile));
 await waitFor('original services and TCP receiving',()=>{try{act('receive');return true}catch{return false}});
 await waitFor('original activation receiving',()=>{try{act('receive-activation');return true}catch{return false}});
 received.counters={app:readFileSync(appCount,'utf8'),completed:readFileSync(onceCount,'utf8'),held:readFileSync(heldCount,'utf8')};
 assert.deepEqual(received.counters,{app:'2',completed:'1',held:'1'});assert.equal(hash(readFileSync(marker)),received.originalMarker);
 const held=port.unit('held.service');assert.equal(held.MainPID,'0');assert.equal(held.ActiveState,'inactive');assert.equal(held.FreezerState,'running');
 received.normalNativeCredentialInputVerified=true;received.completedCounterNotReplayed=true;received.heldEntryNotRestarted=true;received.originalMarkerUnchanged=true;received.qualified=true;
}catch(e){received.qualified=false;received.error=e.message;received.failureUnits=['app.service','app-alias.service','once.service','dbus.service'].map(name=>{try{return port.unit(name)}catch{return{Id:name,observation:'unavailable'}}});process.exitCode=1}
finally{
 if(managerCreated){try{sys('stop',managerUnit)}catch(e){received.managerStopError=e.message;received.qualified=false;process.exitCode=1}}
 const status=run('/usr/bin/systemctl',['show',managerUnit,'--property=LoadState,MainPID,ControlGroup']);
 received.managerCleanup=status;
 if(!status.includes('MainPID=0')||!status.includes('ControlGroup=\n')){received.qualified=false;process.exitCode=1}else{
  const writable=path=>{const s=lstatSync(path);if(s.isDirectory()){chmodSync(path,0o700);for(const n of readdirSync(path))writable(join(path,n))}};
  writable(runtime);rmSync(runtime,{recursive:true,force:true});
 }
 received.runtimeAbsent=!existsSync(runtime);
 const target=join(base,managerUnit+'.receiving.json');writeFileSync(target,JSON.stringify(received,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({qualified:received.qualified,runtimeAbsent:received.runtimeAbsent,counters:received.counters,outcome:target,error:received.error}));
}
