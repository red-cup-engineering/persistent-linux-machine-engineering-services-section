#!/usr/bin/env node
/** Import same-custody values already parsed by systemd EnvironmentFile.
 * No env codec, secret argv, plaintext backup, provider use or custody grant.
 */
import{execFileSync}from'node:child_process';
import{readFileSync,lstatSync,realpathSync,writeFileSync}from'node:fs';
import{createHash}from'node:crypto';
import{resolve,join}from'node:path';
import{pathToFileURL}from'node:url';
import{nativeUserManagerPort}from'./user-manager-maintenance.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const fail=message=>{throw Error('manager environment import: '+message)};
const equal=(a,b,message)=>{if(JSON.stringify(a)!==JSON.stringify(b))fail(message)};
export function importUserManagerEnvironment(request,{port=nativeUserManagerPort(request),environment=process.env,run=execFileSync,pid=process.pid}={}){
 equal(Object.keys(request).sort(),['bindings','environmentFile','id','importerUnit','managerUnit','runtimeDirectory','type','version','work'],'exact original import required');
 if(request.type!=='LinuxUserManagerEnvironmentImport'||request.version!==1||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(request.id))fail('original import subject refused');
 for(const path of [request.work,request.runtimeDirectory]){const s=lstatSync(path);if(!s.isDirectory()||s.uid!==port.uid()||(s.mode&0o077)||realpathSync(path)!==path)fail('private original owner directory required')}
 equal(Object.keys(request.environmentFile).sort(),['path','sha256'],'exact original environment file required');
 const input=request.environmentFile.path,st=lstatSync(input);
 if(!st.isFile()||st.uid!==port.uid()||(st.mode&0o077)||resolve(input)!==input||realpathSync(input)!==input)fail('private normal environment projection required');
 equal(hash(readFileSync(input)),request.environmentFile.sha256,'normal environment source changed');
 if(!/^[A-Za-z0-9_][A-Za-z0-9_.@-]*\.service$/.test(request.importerUnit))fail('original native importer unit required');
 const call=(file,args)=>run(file,args,{encoding:'utf8',timeout:15000,maxBuffer:1048576});
 const object=JSON.parse(call('/usr/bin/busctl',['--system','--json=short','call','org.freedesktop.systemd1','/org/freedesktop/systemd1','org.freedesktop.systemd1.Manager','GetUnit','s',request.importerUnit]));
 if(object.type!=='o'||object.data?.length!==1)fail('importer object unread');
 const property=name=>JSON.parse(call('/usr/bin/busctl',['--system','--json=short','get-property','org.freedesktop.systemd1',object.data[0],'org.freedesktop.systemd1.Service',name])).data;
 equal(String(property('MainPID')),String(pid),'importer is not this source process');
 const sources=property('EnvironmentFiles');
 if(!sources.some(row=>row[0]===input&&row[1]===false))fail('normal EnvironmentFile parser is not the source');
 const manager=port.manager();
 if(manager.Id!==request.managerUnit||manager.OwnerUid!==port.uid()||manager.SystemdUser!==true||manager.RuntimeDirectory!==request.runtimeDirectory||manager.ActiveState!=='active'||manager.MainPID==='0')fail('original target manager unavailable');
 const group=port.controllerGroup();if(group.includes(manager.ControlGroup+'/')||group.endsWith('::'+manager.ControlGroup))fail('importer is inside affected manager');
 if(!Array.isArray(request.bindings)||!request.bindings.length||request.bindings.length>128)fail('bounded same-custody mappings required');
 const names=new Set(),values={...environment,XDG_RUNTIME_DIR:request.runtimeDirectory,DBUS_SESSION_BUS_ADDRESS:'unix:path='+request.runtimeDirectory+'/bus'},expected=[];
 for(const binding of request.bindings){
  equal(Object.keys(binding).sort(),['from','sha256','to'],'exact original consumer mapping required');
  if(!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(binding.from)||!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(binding.to)||!/^[a-f0-9]{64}$/.test(binding.sha256||'')||names.has(binding.to))fail('consumer mapping refused');
  if(typeof environment[binding.from]!=='string'||!environment[binding.from])fail('original consumer input absent');
  equal(hash(environment[binding.from]),binding.sha256,'original credential value changed');
  names.add(binding.to);values[binding.to]=environment[binding.from];expected.push({name:binding.to,sha256:binding.sha256});
 }
 // Values travel only in this native child environment, never in argv or logs.
 run('/usr/bin/systemctl',['--user','import-environment',...names],{env:values,encoding:'utf8',timeout:15000,maxBuffer:65536});
 equal(port.environmentDigests([...names]),expected,'native manager readback differs');
 equal(port.manager(),manager,'target manager changed during import');
 equal(hash(readFileSync(input)),request.environmentFile.sha256,'normal environment source changed during import');
 const result={type:'LinuxUserManagerEnvironmentReceiving',version:1,id:request.id,managerUnit:manager.Id,managerPid:manager.MainPID,managerProcessStart:manager.ProcessStart,importerUnit:request.importerUnit,sourceEnvironmentFile:request.environmentFile,variables:[...names],hashReadbackMatches:true,providerUsePerformed:false,plaintextBackupCreated:false};
 const path=join(request.work,request.id+'-'+manager.MainPID+'.environment-received.json');
 try{writeFileSync(path,JSON.stringify(result)+'\n',{flag:'wx',mode:0o600})}catch(e){if(e.code!=='EEXIST')throw e;equal(JSON.parse(readFileSync(path,'utf8')),result,'original environment receiving changed')}
 return{...result,outcome:path};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const[path,...extra]=process.argv.slice(2);if(!path||extra.length)fail('exact original input required');console.log(JSON.stringify(importUserManagerEnvironment(JSON.parse(readFileSync(path,'utf8')))))}
