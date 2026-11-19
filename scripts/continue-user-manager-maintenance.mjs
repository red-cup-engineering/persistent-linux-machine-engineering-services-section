#!/usr/bin/env node
/** One bounded original-owner continuation for an outside native controller.
 * A caller's existing deployment lease can span the entire operation.
 */
import{readFileSync}from'node:fs';
import{createHash}from'node:crypto';
import{resolve}from'node:path';
import{pathToFileURL}from'node:url';
import{setTimeout as pause}from'node:timers/promises';
import{advanceUserManagerMaintenance,nativeUserManagerPort}from'./user-manager-maintenance.mjs';
import{importUserManagerEnvironment}from'./import-user-manager-environment.mjs';
const fail=message=>{throw Error('manager continuation: '+message)};
export async function continueUserManagerMaintenance(request,importer,{port=nativeUserManagerPort(request),receiveInterruption=false,deadlineMs=120000,onPhase=()=>{}}={}){
 if(!Number.isInteger(deadlineMs)||deadlineMs<1000||deadlineMs>300000)fail('bounded native deadline required');
 if(request.environment.length){
  if(!importer||importer.managerUnit!==request.managerUnit||importer.runtimeDirectory!==request.runtimeDirectory)fail('original environment reconstruction required');
  const expected=request.environment.map(x=>[x.name,x.sha256]),actual=importer.bindings.map(x=>[x.to,x.sha256]);
  if(JSON.stringify(actual)!==JSON.stringify(expected))fail('environment reconstruction does not cover original bindings');
 }
 const until=Date.now()+deadlineMs,path=resolve(request.work,request.id+'.json');
 let lastPhase,phaseSince=Date.now(),lastError,interruption=receiveInterruption;
 while(Date.now()<until){
  const before=JSON.parse(readFileSync(path,'utf8')).phase;
  if(before!==lastPhase){lastPhase=before;phaseSince=Date.now();lastError=undefined;onPhase({phase:before,outcome:path})}
  if(before==='completed')return{phase:before,outcome:path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')};
  let action;
  if(before==='stopping'&&interruption){action='recover';interruption=false}
  else if(before==='recovering-management')action='receive-recovery';
  else if(before==='observed'||before==='fencing')action='fence';
  else if(before==='fenced')action='stop';
  else if(before==='stopping')action='restart';
  else if(['restarting','stopping-replacement-activation','restoring-management','management-starting'].includes(before))action='receive-restart';
  else if(['restarted','unfencing'].includes(before)){
   if(request.environment.length)importUserManagerEnvironment(importer);
   action='restore';
  }else if(['restoring','releasing-completed'].includes(before))action='receive';
  else if(before==='restoring-activation')action='receive-activation';
  else fail('unknown original phase '+before);
  try{advanceUserManagerMaintenance(request,action,port)}catch(e){
   // Re-read the durable phase after an unknown reply. Never issue the old
   // restart again after its preceding restarting record has been written.
   lastError=String(e.message).split('\n')[0];
   const after=JSON.parse(readFileSync(path,'utf8')).phase;
   if(action==='recover'&&after==='stopping')throw e;
   if(!['restart','receive-recovery','receive-restart','receive','receive-activation'].includes(action))throw e;
   if(after===before&&Date.now()-phaseSince>20000)fail(before+' not received: '+lastError);
   await pause(100);
  }
 }
 fail(lastPhase+' exceeded native deadline'+(lastError?': '+lastError:''));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const[parameters,environmentParameters,mode,...extra]=process.argv.slice(2);
 if(!parameters||!environmentParameters||extra.length||![undefined,'receive-interruption'].includes(mode))fail('original parameters and import parameters required');
 const request=JSON.parse(readFileSync(parameters,'utf8')),bytes=readFileSync(environmentParameters),input=request.inputs.find(x=>x.path===resolve(environmentParameters));
 if(!input||input.sha256!==createHash('sha256').update(bytes).digest('hex'))fail('import parameters are not bound by original maintenance');
 console.log(JSON.stringify(await continueUserManagerMaintenance(request,JSON.parse(bytes),{receiveInterruption:mode==='receive-interruption'})));
}
