#!/usr/bin/env node
/** Exact native systemd user-manager maintenance. Existing unit files and
 * application state remain with their owners. Completed invocations are fenced
 * throughout ordinary-service restoration; future jobs retain their own law.
 * Each effect has a durable preceding phase and a separately observed outcome.
 */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,realpathSync,readlinkSync,existsSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync} from 'node:fs';
import {dirname,join,resolve,basename} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';

const hash=x=>createHash('sha256').update(x).digest('hex');
const fail=message=>{throw Error('user-manager maintenance: '+message)};
const equal=(a,b,message)=>{if(JSON.stringify(a)!==JSON.stringify(b))fail(message)};
const service=name=>/^[A-Za-z0-9_][A-Za-z0-9_.@\\:-]*\.service$/.test(name);
const properties='Id,LoadState,ActiveState,SubState,FreezerState,MainPID,ControlPID,ControlGroup,Job,InvocationID,FragmentPath,DropInPaths,Type,RemainAfterExit,Restart,ExecCondition';
const parse=text=>Object.fromEntries(text.trim().split('\n').filter(x=>x.includes('=')).map(x=>{const i=x.indexOf('=');return[x.slice(0,i),x.slice(i+1)]}));
const terminal=u=>['inactive','failed'].includes(u.ActiveState)&&['dead','failed'].includes(u.SubState)&&u.MainPID==='0'&&u.ControlPID==='0'&&!u.Job;
const empty=u=>u.MainPID==='0'&&u.ControlPID==='0'&&!u.Job&&!u.ControlGroup;

export function nativeUserManagerPort(request){
 if(!service(request?.managerUnit)||typeof request.runtimeDirectory!=='string'||resolve(request.runtimeDirectory)!==request.runtimeDirectory)fail('original manager resources required');
 const environment={...process.env,XDG_RUNTIME_DIR:request.runtimeDirectory,DBUS_SESSION_BUS_ADDRESS:'unix:path='+request.runtimeDirectory+'/bus'};
 const run=(file,args)=>execFileSync(file,args,{encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024});
 const user=(...args)=>execFileSync('/usr/bin/systemctl',['--user',...args],{env:environment,encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024});
 const bus=(...args)=>JSON.parse(execFileSync('/usr/bin/busctl',['--user','--json=short',...args],{env:environment,encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024}));
 const connectionPid=name=>{const r=bus('call','org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','GetConnectionUnixProcessID','s',name);if(r.type!=='u'||r.data?.length!==1)fail('native bus PID unread');return String(r.data[0])};
 return {
  uid:()=>process.getuid(),boot:()=>readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),
  runtime:()=>request.runtimeDirectory,
  manager:()=>{const u=parse(run('/usr/bin/systemctl',['show',request.managerUnit,'--property='+properties]));if(u.MainPID&&u.MainPID!=='0'){const p='/proc/'+u.MainPID,argv=readFileSync(p+'/cmdline','utf8').split('\0');u.OwnerUid=lstatSync(p).uid;u.SystemdUser=basename(readlinkSync(p+'/exe'))==='systemd'&&argv.includes('--user')&&!argv.includes('--system');const stat=readFileSync(p+'/stat','utf8');u.ProcessStart=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];u.RuntimeDirectory=readFileSync(p+'/environ','utf8').split('\0').find(x=>x.startsWith('XDG_RUNTIME_DIR='))?.slice(16)}return u},
  apiManagerPid:()=>connectionPid('org.freedesktop.systemd1'),apiBusPid:()=>connectionPid('org.freedesktop.DBus'),
  environmentDigests:names=>{let data;try{data=JSON.parse(user('show-environment','--output=json'))}catch{fail('typed native manager environment unreadable')}return names.map(name=>({name,sha256:typeof data[name]==='string'?hash(data[name]):null}))},
  controllerGroup:()=>readFileSync('/proc/self/cgroup','utf8').trim(),
  processAbsent:pid=>!existsSync('/proc/'+pid),
  unit:name=>parse(user('show',name,'--property='+properties)),
  active:()=>JSON.parse(user('list-units','--all','--type=service,socket,timer,path,scope','--output=json','--no-pager')).filter(x=>!['inactive','failed'].includes(x.active)).map(x=>({unit:x.unit,active:x.active,sub:x.sub})).sort((a,b)=>a.unit.localeCompare(b.unit)),
  files:()=>JSON.parse(user('list-unit-files','--type=service','--output=json','--no-pager')).map(x=>x.unit_file).filter(service).sort(),
  aliases:()=>JSON.parse(user('list-unit-files','--type=service','--output=json','--no-pager')).filter(x=>x.state==='alias').map(x=>x.unit_file).filter(service).sort(),
  bindings:name=>{try{return JSON.parse(execFileSync('/usr/bin/python3',[fileURLToPath(new URL('./user-manager-binding-observation.py',import.meta.url)),name],{env:environment,encoding:'utf8',timeout:15000,maxBuffer:1048576}))}catch{fail('native unit binding observation unread '+name)}},
  jobs:()=>user('list-jobs','--output=json','--no-pager').trim(),
  keys:()=>{try{const text=run('/usr/bin/env',['SSH_AUTH_SOCK='+request.runtimeDirectory+'/openssh_agent','/usr/bin/ssh-add','-l']);return text.trim().split('\n').filter(Boolean).length}catch(e){if(e.status===1&&e.stdout?.includes('The agent has no identities.'))return 0;fail('SSH agent identity custody is unknown')}},
  reload:()=>user('daemon-reload'),
  stop:names=>{if(names.length)user('--no-block','stop',...names)},
  start:names=>{if(names.length)user('--no-block','start',...names)},
  restartManager:()=>run('/usr/bin/sudo',['-n','/usr/bin/systemctl','--no-block','restart',request.managerUnit]),
  listeners:()=>run('/usr/bin/ss',['-H','-lntup']),
  pids:group=>{
   if(!group)return[];
   if(!/^\/[A-Za-z0-9_./@:\\-]+$/.test(group)||group.includes('..'))fail('invalid native cgroup');
   const path='/sys/fs/cgroup'+group+'/cgroup.procs';
   try{return readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(Number)}catch(e){if(e.code==='ENOENT')return[];throw e}
  }
 };
}

function privateDirectory(path,uid){
 if(resolve(path)!==path||realpathSync(path)!==path)fail('canonical private work directory required');
 const s=lstatSync(path);if(!s.isDirectory()||s.uid!==uid||(s.mode&0o077))fail('private owned work directory required');
}
function fileIdentity(path){
 const st=lstatSync(path),target=realpathSync(path),regular=lstatSync(target);
 if(!regular.isFile()||regular.size>1024*1024)fail('unreadable native configuration '+path);
 return {path,target,link:st.isSymbolicLink()?readlinkSync(path):null,uid:st.uid,mode:st.mode,sha256:hash(readFileSync(target))};
}
function inputIdentity({path,optional=false}){
 if(resolve(path)!==path)fail('canonical original input path required');
 if(!existsSync(path)){if(optional)return {path,absent:true};fail('original input unavailable '+path)}
 return fileIdentity(path);
}
function profileIdentity(path){
 const st=lstatSync(path),target=realpathSync(path);if(!target.startsWith('/gnu/store/'))fail('selected Guix profile is unresolved');
 return {path,target,link:st.isSymbolicLink()?readlinkSync(path):null,uid:st.uid,mode:st.mode};
}
function atomic(path,value,prior){
 const text=JSON.stringify(value)+'\n';
 if(prior!==undefined)equal(readFileSync(path,'utf8'),prior,'outcome changed concurrently');
 const temp=path+'.pending';
 if(existsSync(temp)){const st=lstatSync(temp);if(!st.isFile()||st.uid!==process.getuid()||(st.mode&0o077))fail('unsafe pending outcome');equal(readFileSync(temp,'utf8'),text,'unreceived pending outcome')}
 else{const fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,text);fsyncSync(fd)}finally{closeSync(fd)}}
 renameSync(temp,path);const dir=openSync(dirname(path),'r');try{fsyncSync(dir)}finally{closeSync(dir)}
 return {value,text};
}
function requestContext(request,port){
 equal(Object.keys(request).sort(),['environment','id','inputs','managerUnit','runtimeDirectory','type','version','work'],'exact maintenance input required');
 if(request.type!=='LinuxUserManagerMaintenance'||request.version!==1||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(request.id))fail('maintenance subject refused');
 if(!service(request.managerUnit)||request.runtimeDirectory!==port.runtime())fail('manager resource identity changed');
 if(!Array.isArray(request.environment)||request.environment.length>128)fail('original manager environment bindings required');
 for(const row of request.environment){equal(Object.keys(row).sort(),['name','sha256'],'exact manager environment binding required');if(!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row.name)||!/^[a-f0-9]{64}$/.test(row.sha256||''))fail('manager environment binding refused')}
 if(new Set(request.environment.map(x=>x.name)).size!==request.environment.length)fail('duplicate manager environment binding');
 if(!Array.isArray(request.inputs)||request.inputs.length>256)fail('original owner input bindings required');
 for(const row of request.inputs){equal(Object.keys(row).sort(),['path','sha256'],'exact owner input binding required');if(typeof row.path!=='string'||!/^[a-f0-9]{64}$/.test(row.sha256||''))fail('original owner input refused');equal(inputIdentity(row).sha256,row.sha256,'original owner input digest changed')}
 privateDirectory(request.work,port.uid());
 const runtime=port.runtime();privateDirectory(runtime,port.uid());
 const path=join(request.work,request.id+'.json');if(/[\0\r\n]/.test(path))fail('work path cannot form a native condition');
 return {path,request,uid:port.uid(),runtime,guardText:'[Unit]\nConditionPathExists=!'+path.replaceAll('%','%%')+'\n[Service]\nRestart=no\nExecCondition=/usr/bin/false\n'};
}
function refuseJobs(port){const jobs=port.jobs();if(jobs&&jobs!=='[]')fail('native jobs remain');}
function transientUnit(plan,name){return plan.units.find(u=>u.Id===name&&u.FragmentPath===join(plan.request.runtimeDirectory,'systemd/transient',u.Id))}
function receiveTerminalTransient(plan,name,port){
 const old=transientUnit(plan,name);if(!old)fail('original transient identity absent '+name);
 const u=port.unit(name);if(!terminal(u)||!empty(u)||u.FreezerState!=='running')fail('original transient invocation not terminal '+name);
 if(old.MainPID!=='0'&&!port.processAbsent(old.MainPID))fail('original transient process remains '+name);
 if(old.ControlGroup&&port.pids(old.ControlGroup).length)fail('original transient cohort remains '+name);
 return{unit:name,invocationId:old.InvocationID,mainPid:old.MainPID,controlGroup:old.ControlGroup,fragmentPath:old.FragmentPath,terminalUnit:u};
}
function receiveFileIdentities(plan,port){
 for(const f of plan.configuration){
  const old=plan.units.find(u=>u.FragmentPath===f.path&&transientUnit(plan,u.Id));
  if(old&&!existsSync(f.path)){receiveTerminalTransient(plan,old.Id,port);continue}
  equal(fileIdentity(f.path),f,'original configuration changed: '+f.path);
 }
 for(const f of plan.inputs)equal(inputIdentity({path:f.path,optional:f.absent===true}),f,'original source input changed: '+f.path);
 for(const p of plan.profiles)equal(profileIdentity(p.path),p,'selected profile changed: '+p.path);
}
function receiveBindings(c,plan,port){
 const falseCondition=hash(JSON.stringify(['/usr/bin/false',['/usr/bin/false'],false]));
 const unitCondition=hash(JSON.stringify(['ConditionPathExists',false,true,c.path]));
 const removeOwned=(actual,expected,digest,count)=>{
  if(actual.length!==expected.length+count)fail('native input or credential binding changed');
  const kept=[];let next=0,removed=0;
  for(const value of actual){if(next<expected.length&&value===expected[next]){kept.push(value);next++}else if(value===digest&&removed<count)removed++;else fail('native input or credential binding changed')}
  if(next!==expected.length||removed!==count)fail('native input or credential binding changed');return kept;
 };
 const retained=plan.units.map((unit,index)=>({unit,index})).filter(({unit})=>{
  if(transientUnit(plan,unit.Id)&&!existsSync(unit.FragmentPath)){receiveTerminalTransient(plan,unit.Id,port);return false}return true;
 });
 const current=retained.map(({unit:x,index})=>{
  const observed=port.bindings(x.Id),owned=plan.serviceFiles.filter(name=>observed.dropInPaths.includes(guardPath(c,name)));if(!owned.length)return observed;
  for(const name of owned)receiveOwnGuard(c,name);
  return {...observed,dropInPaths:observed.dropInPaths.filter(path=>!owned.some(name=>guardPath(c,name)===path)),conditionSha256:removeOwned(observed.conditionSha256,plan.bindings[index].conditionSha256,falseCondition,owned.length),unitConditionSha256:removeOwned(observed.unitConditionSha256,plan.bindings[index].unitConditionSha256,unitCondition,owned.length)};
 });
 equal(retained.map(({index})=>plan.bindings[index]),current,'native input or credential binding changed');
}
function receiveManager(plan,port){equal(port.boot(),plan.bootId,'boot changed');equal(port.manager(),plan.manager,'original manager identity changed');}
function receiveReplacement(plan,port){equal(port.boot(),plan.bootId,'boot changed');equal(port.manager(),plan.replacementManager,'received replacement manager changed');}
function receiveEnvironment(request,port){equal(port.environmentDigests(request.environment.map(x=>x.name)),request.environment,'original manager environment not reconstructed')}
function receiveScope(plan,port){
 const selected=new Set(plan.active.map(x=>x.unit));
 for(const row of port.active())if(!selected.has(row.unit))fail('unreceived active consumer '+row.unit);
 for(const row of port.active())if(row.unit.endsWith('.scope')&&row.unit!=='init.scope')fail('foreign execution scope remains '+row.unit);
 refuseJobs(port);
}
function receiveCapturedUnits(plan,port){
 const keys=['Id','MainPID','ControlPID','ControlGroup','InvocationID','ActiveState','SubState','FreezerState','Job'];
 for(const old of plan.units){const current=port.unit(old.Id);equal(keys.map(k=>current[k]),keys.map(k=>old[k]),'captured consumer changed '+old.Id)}
}
function listeningEndpoints(units,port){
 const owners=new Map();for(const u of units)for(const pid of port.pids(u.ControlGroup))owners.set(String(pid),u.Id);
 const found=[];
 for(const line of port.listeners().trim().split('\n').filter(Boolean)){
  const fields=line.trim().split(/\s+/),pids=[...line.matchAll(/pid=(\d+)/g)].map(x=>x[1]);
  if(!['tcp','udp'].includes(fields[0])||fields.length<5)fail('native socket layout unread');
  if(fields[0]!=='tcp')continue;
  for(const pid of pids)if(owners.has(pid))found.push({unit:owners.get(pid),protocol:fields[0],local:fields[4]});
 }
 return [...new Map(found.map(x=>[JSON.stringify(x),x])).values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function guardPath(c,name){return join(c.runtime,'systemd/user',name+'.d','99-persistent-linux-manager-maintenance-'+c.request.id+'.conf')}
function receiveOwnGuard(c,name){const p=guardPath(c,name),st=lstatSync(p);if(!st.isFile()||st.uid!==c.uid||(st.mode&0o077))fail('guard ownership changed');equal(readFileSync(p,'utf8'),c.guardText,'guard bytes changed');return p}
function receiveGuardDirectory(path,uid){
 const st=lstatSync(path);if(!st.isDirectory()||st.uid!==uid||(st.mode&0o022)||realpathSync(path)!==path)fail('unsafe guard directory');
}
function receiveLoadedGuard(c,name,port,{api=true}={}){
 const u=port.unit(name),p=receiveOwnGuard(c,name);
 if(!(u.DropInPaths||'').split(' ').includes(p)||u.Restart!=='no'||!(u.ExecCondition||'').includes('path=/usr/bin/false '))fail('native restart fence not loaded '+name);
 if(api&&!port.bindings(name).unitConditionSha256.includes(hash(JSON.stringify(['ConditionPathExists',false,true,c.path]))))fail('native negative admission condition not loaded '+name);
}

/** Observe native scope before writing any guard. No authority is manufactured
 * by this receipt. The caller must already hold the machine-maintenance work. */
export function planUserManagerMaintenance(request,port=nativeUserManagerPort(request)){
 const c=requestContext(request,port);refuseJobs(port);
 receiveEnvironment(request,port);
 const manager=port.manager(),active=port.active();
 if(manager.Id!==request.managerUnit||manager.ActiveState!=='active'||manager.MainPID==='0'||manager.OwnerUid!==c.uid||manager.SystemdUser!==true||manager.RuntimeDirectory!==c.runtime||!manager.ControlGroup)fail('original user manager unavailable');
 equal(port.apiManagerPid(),manager.MainPID,'API bus belongs to another manager');
 for(const row of active)if(row.unit.endsWith('.scope')&&row.unit!=='init.scope')fail('foreign execution scope remains '+row.unit);
 if(active.some(x=>x.unit==='ssh-agent.service')&&port.keys()!==0)fail('nonempty SSH agent needs original reconstruction custody');
 const aliases=port.aliases().map(name=>({name,unit:port.unit(name).Id}));
 const units=active.filter(x=>x.unit.endsWith('.service')).map(x=>port.unit(x.unit));
 for(const u of units){
  if(u.ControlPID!=='0'||u.Job)fail('consumer control job remains '+u.Id);
  if(u.FreezerState!=='running'&&!empty(u))fail('frozen resident has no terminal receiving '+u.Id);
  if(u.FreezerState==='running'&&u.ActiveState==='active'&&u.SubState==='running'&&u.MainPID==='0')fail('running consumer has no received main PID '+u.Id);
 }
 const busPid=port.apiBusPid(),management=units.filter(u=>port.pids(u.ControlGroup).map(String).includes(busPid));
 if(management.length!==1||!management[0].MainPID||management[0].MainPID==='0')fail('original management transport has no received service');
 const names=[...new Set([...port.files(),...units.map(x=>x.Id)])].sort();
 const activationUnits=active.filter(x=>/\.(timer|socket|path)$/.test(x.unit)).map(x=>port.unit(x.unit));
 const paths=[...new Set([manager,...units,...activationUnits].flatMap(u=>[u.FragmentPath,...(u.DropInPaths||'').split(' ')]).filter(Boolean))].sort();
 const bindings=units.map(x=>port.bindings(x.Id));
 const inputs=[...new Map([...bindings.flatMap(x=>x.inputFiles),...request.inputs].map(x=>[x.path,inputIdentity(x)])).values()];
 const profiles=[...new Set(bindings.flatMap(x=>x.profiles))].map(profileIdentity);
 const value={type:'LinuxUserManagerMaintenanceOutcome',version:1,request,phase:'observed',bootId:port.boot(),manager,active,units,activationUnits,
  serviceFiles:names,aliases,configuration:paths.map(fileIdentity),bindings,inputs,profiles,managementUnit:management[0].Id,held:units.filter(x=>x.FreezerState!=='running').map(x=>x.Id),
  restore:units.filter(x=>x.ActiveState==='active'&&x.SubState==='running'&&x.FreezerState==='running'&&x.MainPID!=='0'&&!transientUnit({units,request},x.Id)).map(x=>x.Id),
  completed:units.filter(x=>x.ActiveState==='active'&&x.SubState==='exited').map(x=>({unit:x.Id,invocationId:x.InvocationID})),
  listeners:listeningEndpoints(units,port),applicationDrained:false,externalEffectsReconciled:false};
 receiveManager(value,port);receiveScope(value,port);receiveFileIdentities(value,port);
 if(existsSync(c.path))fail('original maintenance outcome already exists; observe its phase');
 atomic(c.path,value);return {phase:value.phase,outcome:c.path,sha256:hash(readFileSync(c.path)),running:value.restore,held:value.held,completed:value.completed};
}

/** Advance a known phase once. A failed or unreceived effect is observed before
 * any continuation; a manager restart request is never replayed. */
export function advanceUserManagerMaintenance(request,action,port=nativeUserManagerPort(request)){
 const c=requestContext(request,port),st=lstatSync(c.path);
 if(!st.isFile()||st.uid!==c.uid||(st.mode&0o077))fail('private outcome required');
 let text=readFileSync(c.path,'utf8'),p=JSON.parse(text);
 equal(p.request,request,'original maintenance subject');
 if(p.type!=='LinuxUserManagerMaintenanceOutcome'||p.version!==1)fail('unknown maintenance outcome');
 const save=patch=>{const next=atomic(c.path,{...p,...patch},text);p=next.value;text=next.text};
 const stopped=()=>{
  receiveScope(p,port);receiveFileIdentities(p,port);
  for(const old of p.units){const u=port.unit(old.Id);if(!empty(u)||(!p.held.includes(old.Id)&&!terminal(u)))fail('consumer is not terminal '+old.Id);if(old.MainPID!=='0'&&!port.processAbsent(old.MainPID))fail('captured process remains '+old.Id);if(old.ControlGroup&&port.pids(old.ControlGroup).length)fail('captured cohort remains '+old.Id)}
  for(const row of p.active.filter(x=>/\.(timer|socket|path)$/.test(x.unit))){const u=port.unit(row.unit);if(!['inactive','failed'].includes(u.ActiveState)||u.Job)fail('activation unit not stopped '+row.unit)}
 };
 if(action==='observe')return {phase:p.phase,outcome:c.path,manager:port.manager(),units:p.units.map(x=>port.unit(x.Id)),held:p.held,restore:p.restore,applicationDrained:false,externalEffectsReconciled:false};
 if(action==='fence'){
  if(!['observed','fencing'].includes(p.phase))fail('fence requires original observed/fencing phase');receiveManager(p,port);receiveScope(p,port);receiveFileIdentities(p,port);receiveCapturedUnits(p,port);receiveBindings(c,p,port);receiveEnvironment(request,port);
  if(p.phase==='observed')save({phase:'fencing'});
  for(const name of p.serviceFiles){
   const path=guardPath(c,name);mkdirSync(dirname(path),{recursive:true,mode:0o700});
   receiveGuardDirectory(dirname(path),c.uid);
   if(existsSync(path))receiveOwnGuard(c,name);else{const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,c.guardText);fsyncSync(fd)}finally{closeSync(fd)}}
  }
  port.reload();
  for(const u of p.units)receiveLoadedGuard(c,u.Id,port);
  const loaded=port.unit(p.managementUnit),managementFences=p.serviceFiles.filter(name=>(loaded.DropInPaths||'').split(' ').includes(guardPath(c,name))||p.aliases.some(alias=>alias.name===name&&alias.unit===p.managementUnit));
  if(!managementFences.length)fail('original management service fence unread');
  const restorationFences=[...new Set(p.restore.flatMap(unit=>{const paths=(port.unit(unit).DropInPaths||'').split(' ');return p.serviceFiles.filter(name=>paths.includes(guardPath(c,name))||p.aliases.some(alias=>alias.name===name&&alias.unit===unit))}))];
  if(p.completed.some(x=>restorationFences.includes(x.unit)))fail('completed canonical unit conflicts with ordinary restore');
  save({phase:'fenced',managementFences,restorationFences});
 }else if(action==='stop'){
  if(p.phase!=='fenced')fail('stop requires fenced phase');receiveManager(p,port);receiveScope(p,port);receiveFileIdentities(p,port);receiveCapturedUnits(p,port);receiveBindings(c,p,port);receiveEnvironment(request,port);
  for(const u of p.units)receiveLoadedGuard(c,u.Id,port);
  save({phase:'stopping'});
  port.stop(p.active.filter(x=>!x.unit.endsWith('.scope')&&!p.held.includes(x.unit)).map(x=>x.unit));
 }else if(action==='restart'){
  if(p.phase!=='stopping')fail('restart requires observed stopping phase');receiveManager(p,port);stopped();
  const group=port.controllerGroup();if(group.includes(p.manager.ControlGroup+'/')||group.endsWith('::'+p.manager.ControlGroup))fail('restart controller is inside affected manager subtree');
  for(const name of p.serviceFiles)receiveOwnGuard(c,name);
  const retiredTransientInvocations=p.units.filter(x=>transientUnit(p,x.Id)).map(x=>receiveTerminalTransient(p,x.Id,port));
  const retiredNames=new Set(retiredTransientInvocations.map(x=>x.unit));
  save({phase:'restarting',restartRequestedAt:new Date().toISOString(),retiredTransientInvocations,restore:p.restore.filter(name=>!retiredNames.has(name)),restorationFences:p.restorationFences.filter(name=>!retiredNames.has(name)&&!p.aliases.some(alias=>alias.name===name&&retiredNames.has(alias.unit)))});
  port.restartManager();
 }else if(action==='receive-restart'){
  if(!['restarting','stopping-replacement-activation','restoring-management','management-starting'].includes(p.phase))fail('receiving requires the original restart request');
  if(p.phase==='restarting'){
   equal(port.boot(),p.bootId,'boot changed');const m=port.manager();
   if(m.Id!==p.manager.Id||m.ActiveState!=='active'||m.SubState!=='running'||m.OwnerUid!==c.uid||m.SystemdUser!==true||m.RuntimeDirectory!==c.runtime||m.MainPID==='0'||m.MainPID===p.manager.MainPID||!port.processAbsent(p.manager.MainPID))fail('new original manager not received');
   receiveFileIdentities(p,port);receiveScope(p,port);
   for(const name of p.serviceFiles)receiveOwnGuard(c,name);
   for(const name of p.held){const u=port.unit(name);if(!empty(u)||!terminal(u)||u.FreezerState!=='running')fail('original held unit did not become stopped '+name)}
   for(const u of p.units){if(transientUnit(p,u.Id)&&!existsSync(u.FragmentPath))receiveTerminalTransient(p,u.Id,port);else receiveLoadedGuard(c,u.Id,port,{api:false})}
   save({phase:'stopping-replacement-activation',replacementManager:m});
   port.stop(p.active.filter(x=>/\.(timer|socket|path)$/.test(x.unit)).map(x=>x.unit));
  }
  receiveReplacement(p,port);receiveFileIdentities(p,port);
  if(p.phase==='stopping-replacement-activation'){
   refuseJobs(port);for(const row of p.activationUnits){const u=port.unit(row.Id);if(!['inactive','failed'].includes(u.ActiveState)||u.Job)fail('replacement activation unit not stopped '+row.Id)}
   save({phase:'restoring-management'});
  }
  if(p.phase==='restoring-management'){
   for(const name of p.managementFences){const path=guardPath(c,name);if(existsSync(path)){receiveOwnGuard(c,name);unlinkSync(path)}}
   port.reload();save({phase:'management-starting'});port.start([p.managementUnit]);
  }else{
   const management=port.unit(p.managementUnit);if(management.ActiveState!=='active'||management.SubState!=='running'||management.MainPID==='0'||management.ControlPID!=='0'||management.Job)fail('original management transport not received');
   equal(port.apiManagerPid(),p.replacementManager.MainPID,'replacement API bus belongs to another manager');
   receiveScope(p,port);receiveBindings(c,p,port);save({phase:'restarted'});
  }
 }else if(action==='restore'){
  if(!['restarted','unfencing'].includes(p.phase))fail('restore requires received new manager');receiveReplacement(p,port);receiveFileIdentities(p,port);receiveEnvironment(request,port);
  if(p.phase==='restarted')save({phase:'unfencing'});
  for(const name of p.restorationFences){const path=guardPath(c,name);if(existsSync(path)){receiveOwnGuard(c,name);unlinkSync(path)}}
  for(const name of p.serviceFiles.filter(name=>!p.restorationFences.includes(name)))receiveOwnGuard(c,name);
  port.reload();save({phase:'restoring'});
  port.start(p.restore.filter(name=>name!==p.managementUnit));
 }else if(action==='receive'){
  if(!['restoring','releasing-completed'].includes(p.phase))fail('final receiving requires restoring phase');if(p.phase==='releasing-completed')port.reload();receiveReplacement(p,port);receiveFileIdentities(p,port);refuseJobs(port);receiveEnvironment(request,port);
  const received=p.restore.map(name=>{const u=port.unit(name);if(u.ActiveState!=='active'||u.SubState!=='running'||u.MainPID==='0'||u.ControlPID!=='0'||u.Job||u.FreezerState!=='running')fail('original consumer not received '+name);return u});
  for(const name of p.held){const u=port.unit(name);if(!empty(u)||!terminal(u))fail('held unit was activated '+name)}
  equal(port.apiManagerPid(),p.replacementManager.MainPID,'restored API bus belongs to another manager');receiveBindings(c,p,port);const listeners=listeningEndpoints(received,port);equal(listeners,p.listeners.filter(x=>p.restore.includes(x.unit)),'original listening endpoints not received');
  const timerUnits=p.active.filter(x=>/\.(timer|socket|path)$/.test(x.unit)).map(x=>x.unit);
  save({phase:'releasing-completed',receivedServices:received,receivedListeners:listeners});
  for(const name of p.serviceFiles){const path=guardPath(c,name);if(existsSync(path)){receiveOwnGuard(c,name);unlinkSync(path)}}
  port.reload();save({phase:'restoring-activation'});
  port.start(timerUnits);
 }else if(action==='receive-activation'){
  if(p.phase!=='restoring-activation')fail('activation receiving requires its original restore');receiveReplacement(p,port);receiveFileIdentities(p,port);refuseJobs(port);
  for(const old of p.active.filter(x=>/\.(timer|socket|path)$/.test(x.unit))){const u=port.unit(old.unit);if(u.ActiveState!=='active'||u.Job)fail('original activation unit not received '+old.unit)}
  save({phase:'completed',completedAt:new Date().toISOString(),completedJobsExplicitlyStarted:false});
 }else fail('unknown maintenance action');
 return {phase:p.phase,outcome:c.path,sha256:hash(text),held:p.held,restore:p.restore,applicationDrained:false,externalEffectsReconciled:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [action,path,...extra]=process.argv.slice(2);if(!path||extra.length)fail('ACTION exact-parameters.json required');
 const input=JSON.parse(readFileSync(path,'utf8'));
 console.log(JSON.stringify(action==='plan'?planUserManagerMaintenance(input):advanceUserManagerMaintenance(input,action)));
}
