import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderNativeCompaction,nativeCompactionQualification } from '../src/native-compaction.mjs';
import { maintenanceHash,nativeReceiverClosure,renderNativeCompactionFilePreparation,prepareNativeCompactionFiles,launchNativeCompactionFile,readNativeCompactionOutcome,receiveNativeCompactionOutcome,formNativeCompactionOutcomeTransfer,persistNativeCompactionOutcome,receiveConditionalCompactionScope,deriveConditionalCompactionReentry,observeNativeCompactionCustody,prepareNativeCompactionCustody,observeNativeCompactionPrerequisites } from '../src/native-maintenance-caller.mjs';

const powershell='/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const iso=n=>new Date(n).toISOString(), encode=x=>Buffer.from(typeof x==='string'?x:JSON.stringify(x)).toString('base64');
const ownerSource=fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/,'');
const closure=()=>Object.fromEntries(nativeReceiverClosure.map(relative=>[relative,maintenanceHash(readFileSync(ownerSource+'/'+relative))]));
function fixture() {
 const now=Date.now();const request='11111111-1111-1111-1111-111111111111';
 const p={schema:'wsl-host-parameters@1',windows:{backingStorage:{distributionName:'Example',registryKey:'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{11111111-1111-1111-1111-111111111111}',basePath:'D:\\distros\\example',vhdFileName:'ext4.vhdx',volumeId:'\\\\?\\Volume{22222222-2222-2222-2222-222222222222}\\',powershell,wslpath:'/usr/bin/wslpath',linuxMount:'/',timeoutMs:1000,maxAgeMs:2000,policy:{minFreeBytes:'100000000000',minFreePercent:3,growthBytes:'2147483648',overheadBytes:'67108864',basis:'Fixture original physical reserve'}},nativeCompaction:{adapter:nativeCompactionQualification.adapter,ownerSid:'S-1-5-21-1-2-3-999999',custodyDirectory:'C:\\Users\\Example\\maintenance',deadlineMs:1000,maxOutputBytes:1024}}};
 const resources={authority:'{"fixture":"not real authority"}',checkpoint:'{"fixture":"not an actor fence"}','independent-receiving':'{"fixture":"not an actual receiving"}'};
 const a={type:'WslNativeCompactionAdmission',version:1,request,parameterSha256:'',notBefore:iso(now-10000),expiresAt:iso(now+590000),concurrentPeakBytes:'4563402752',resources:[]};
 const form=()=>{
  const parameterText=JSON.stringify(p);a.parameterSha256=maintenanceHash(parameterText);a.resources=Object.keys(resources).map(role=>({role,path:p.windows.nativeCompaction.custodyDirectory+'\\'+request+'.caller\\'+role+'.resource.json',sha256:maintenanceHash(resources[role])}));
  const admissionText=JSON.stringify(a),render=renderNativeCompaction(parameterText,admissionText),packet=JSON.parse(render.packetText);
  const before={Path:'D:\\distros\\example\\ext4.vhdx',FileIdentity:'12345678:0123456789abcdef',Volume:p.windows.backingStorage.volumeId,LengthBytes:'1000',VolumeFreeBytes:'500',CallerAvailableBytes:'500'};
  const intent={Type:'WslNativeCompactionIntent',Request:request,AdmissionSHA256:render.admissionSha256,Invocation:packet.invocation,Before:before,WindowsParentPID:1234,WindowsOwnerSID:p.windows.nativeCompaction.ownerSid,At:iso(now-2000)};
  const native={Pid:4321,Exit:0,WithinDeadline:true,StartedAt:iso(now-1900),TerminalAt:iso(now-1500),PidError:null,Stdout:{TotalBytes:2,Overflow:false,Error:null},Stderr:{TotalBytes:0,Overflow:false,Error:null}};
  const result={Type:'WslNativeCompactionOutcome',Status:'terminal-confirmed',Request:request,AdmissionSHA256:render.admissionSha256,Before:before,After:{...before,LengthBytes:'900'},Native:native,Success:true,CapacityReopened:false,GuestReentryAdmitted:false,At:iso(now-1400)};
  const bundle={'packet.json':encode(render.packetText),'parameters.json':encode(parameterText),'admission.json':encode(admissionText),'started.json':encode(intent),'native-pid.json':encode({pid:4321,startedAt:native.StartedAt}),'result.json':encode(result),'stdout.bin':encode('ok'),'stderr.bin':encode('')};
  for(const [role,value] of Object.entries(resources))bundle[role+'.resource.json']=encode(value);
  return {parameterText,admissionText,render,bundle,result,intent,packet};
 };
 return {p,a,resources,form};
}
function mutateJson(bundle,name,change){const copy=structuredClone(bundle),value=JSON.parse(Buffer.from(copy[name],'base64'));change(value);copy[name]=encode(value);return copy}
test('current native prerequisites can be observed before any maintenance declaration or admission',()=>{
 const f=fixture();delete f.p.windows.nativeCompaction;const parameters=JSON.stringify(f.p);let calls=0;
 const result=observeNativeCompactionPrerequisites(parameters,{run(executable,args,options){
  calls++;assert.equal(executable,powershell);assert.equal(options.timeout,30000);
  const source=Buffer.from(options.input,'base64').toString();
  assert.match(source,/Receive-MaintenanceBackingTarget \$selected/);
  assert.doesNotMatch(source,/--manage|--terminate|--shutdown|Set-Sparse|Start-PrivateMaintenanceFile/);
  return JSON.stringify({type:'WslNativeCompactionPrerequisites',version:1,ownerSid:'S-1-5-21-1-2-3-999999',qualified:false,effectsExecuted:false,capacityReopened:false});
 }});
 assert.equal(calls,1);assert.equal(result.qualified,false);assert.equal(result.parameterSha256,maintenanceHash(parameters));
 assert.equal(result.backingSourceSha256,maintenanceHash(readFileSync(new URL('../assets/observe-backing-capacity.ps1',import.meta.url))));
 assert.equal(JSON.stringify(f.p),parameters);
});
let conditionalReferenceRoot;
process.once('exit',()=>{if(conditionalReferenceRoot)rmSync(conditionalReferenceRoot,{recursive:true,force:true})});
function conditionalFixture(configure=()=>{}){
 const f=fixture(),actor='https://fixture.invalid/actors/holder',ref=name=>{if(!conditionalReferenceRoot){mkdirSync(ownerSource+'/data/logs',{recursive:true});conditionalReferenceRoot=mkdtempSync(ownerSource+'/data/logs/conditional-reference-fixture-')}const path=conditionalReferenceRoot+'/'+name+'.json';writeFileSync(path,name,{mode:0o600});return {path,sha256:maintenanceHash(name)}};
 const d=f.p.windows.nativeCompaction;d.reentry={linuxUser:'emsenn',node:process.execPath,receiver:ownerSource+'/scripts/receive-native-compaction-outcome.mjs',receiverSha256:closure()[nativeReceiverClosure[0]],receiverClosure:closure(),ownerUid:process.getuid(),sectionRoot:ownerSource,outputDirectory:ownerSource+'/data/logs/conditional-fixture-output',continuation:{mode:'one-successful-outcome-transfer',algorithm:'wsl-native-complete-success-v1',templateSha256:maintenanceHash(readFileSync(new URL('../assets/native-maintenance-caller.ps1',import.meta.url))),expiresAt:iso(Date.now()+700000),reentryValidityMs:600000,parentDeadlineMs:2000}};
 configure(f);const initial=f.form(),header={version:1,request:f.a.request,parameterSha256:initial.render.parameterSha256};
 const authority={type:'WslNativeCompactionConditionalAuthority',...header,holder:{actor,resource:ref('authority')},expiresAt:d.reentry.continuation.expiresAt,scope:{mode:d.reentry.continuation.mode,ownerSid:d.ownerSid,target:initial.packet.target,invocation:{executable:nativeCompactionQualification.executable,argv:['--distribution','Example','--user','emsenn','--exec',process.execPath,d.reentry.receiver]},receiverClosure:d.reentry.receiverClosure,transferLimit:1}};
 f.resources.authority=JSON.stringify(authority);
 const checkpoint={type:'WslNativeCompactionConditionalCheckpoint',...header,authoritySha256:maintenanceHash(f.resources.authority),checkpoint:ref('actual-final-checkpoint'),holds:['host-main','host-ingress','composer','selector'].map(role=>({role,resource:ref(role),state:role==='selector'?'boot-held':'held-and-terminal'})),affectedWork:[ref('original-work8')],readiness:{actor,answer:'ready-for-selected-offline-maintenance',resource:ref('actual-human-readiness')},unknowns:['Fixture original provider-close unknown retained']};
 f.resources.checkpoint=JSON.stringify(checkpoint);
 f.resources['independent-receiving']=JSON.stringify({type:'WslNativeCompactionConditionalReceiving',...header,authoritySha256:maintenanceHash(f.resources.authority),checkpointSha256:maintenanceHash(f.resources.checkpoint),algorithm:d.reentry.continuation.algorithm,templateSha256:d.reentry.continuation.templateSha256,receiverClosure:d.reentry.receiverClosure,receiver:{actor:'https://fixture.invalid/actors/independent',resource:ref('actual-independent-algorithm-receiving')}});
 return f;
}
test('conditional scope requires actual semantic roles and exact one-target authority despite matching hashes',()=>{
 const f=conditionalFixture(),v=f.form();assert.equal(receiveConditionalCompactionScope(v.parameterText,v.admissionText,f.resources).policy.mode,'one-successful-outcome-transfer');
 for(const [role,change] of [['authority',a=>a.scope.transferLimit=2],['authority',a=>a.scope.invocation.argv[1]='Other'],['authority',a=>a.holder={approved:true}],['checkpoint',k=>k.readiness.answer='unknown'],['checkpoint',k=>k.holds.pop()],['checkpoint',k=>k.holds[0].state='admission-held'],['independent-receiving',i=>i.algorithm='status-only']]){
  const bad=conditionalFixture(),value=JSON.parse(bad.resources[role]);change(value);bad.resources[role]=JSON.stringify(value);const next=bad.form();assert.throws(()=>receiveConditionalCompactionScope(next.parameterText,next.admissionText,bad.resources),undefined,role+' semantic refusal');
 }
 const opaque=conditionalFixture();opaque.resources.authority='{"approved":true}';const o=opaque.form();assert.throws(()=>renderNativeCompactionFilePreparation(o.parameterText,o.admissionText,opaque.resources));
 const missing=conditionalFixture(),m=missing.form(),prior=JSON.parse(missing.resources.checkpoint).checkpoint;writeFileSync(prior.path,'changed original checkpoint');let portReached=false;assert.throws(()=>prepareNativeCompactionFiles(m.parameterText,m.admissionText,missing.resources,{run(){portReached=true}}),/actual original prior Resource changed/);assert.equal(portReached,false);
});
test('conditional derivation receives actual complete success and cannot extend prior authority or relabel facts',()=>{
 const f=conditionalFixture(),v=f.form(),derived=deriveConditionalCompactionReentry(v.parameterText,v.admissionText,v.bundle),r=JSON.parse(derived.reentryText);
 assert.ok(Date.parse(r.expiresAt)<=Date.parse(f.p.windows.nativeCompaction.reentry.continuation.expiresAt));assert.equal(derived.receiving.priorFacts,'original-pre-offline-receiving');assert.equal(derived.receiving.applicationDrained,false);
 const payload=formNativeCompactionOutcomeTransfer(v.parameterText,v.admissionText,v.bundle,derived.reentryText,derived.resources);assert.equal(payload.type,'WslNativeCompactionOutcomeTransfer');
 const changed=structuredClone(derived.resources),a=JSON.parse(changed.authority);a.holdsReleased=true;changed.authority=JSON.stringify(a);r.resources.find(x=>x.role==='authority').sha256=maintenanceHash(changed.authority);assert.throws(()=>formNativeCompactionOutcomeTransfer(v.parameterText,v.admissionText,v.bundle,JSON.stringify(r),changed));
 for(const [,change] of negatives)assert.throws(()=>deriveConditionalCompactionReentry(v.parameterText,v.admissionText,mutateJson(v.bundle,'result.json',change)));
 assert.throws(()=>deriveConditionalCompactionReentry(v.parameterText,v.admissionText,v.bundle,{now:Date.parse(f.p.windows.nativeCompaction.reentry.continuation.expiresAt)}));
 let launched=false;assert.throws(()=>launchNativeCompactionFile(v.parameterText,v.admissionText,JSON.stringify({type:'WslNativeCompactionFileReceiving',request:f.a.request,parentSha256:v.render.scriptSha256,admissionSha256:v.render.admissionSha256}),{run(){launched=true}}));assert.equal(launched,false);
});
const negatives=[
 ['failed terminal',r=>r.Success=false],['native nonzero',r=>r.Native.Exit=17],['late flag',r=>r.Native.WithinDeadline=false],
 ['late actual elapsed',r=>r.Native.TerminalAt=iso(Date.parse(r.Native.StartedAt)+1001)],['overflow',r=>r.Native.Stdout.Overflow=true],
 ['drain failure',r=>r.Native.Stdout.Error='sink error'],['missing PID evidence',r=>r.Native.PidError='write failed'],
 ['PID mismatch',r=>r.Native.Pid++],['target drift',r=>r.After.FileIdentity='12345678:ffffffffffffffff'],
 ['admission mismatch',r=>r.AdmissionSHA256='0'.repeat(64)],['missing stream bytes',r=>r.Native.Stdout.TotalBytes=3],
 ['status alone',r=>{delete r.Native;delete r.Success}],['string success',r=>r.Success='True'],['string exit',r=>r.Native.Exit='0']
];
test('modern owner receiving binds all original custody and never admits reentry or capacity',()=>{
 const f=fixture().form(),received=receiveNativeCompactionOutcome(f.parameterText,f.admissionText,f.bundle);
 assert.equal(received.outcomeSha256,maintenanceHash(Buffer.from(f.bundle['result.json'],'base64')));assert.equal(received.guestReentryAdmitted,false);assert.equal(received.capacityReopened,false);
});
test('failed/nonzero/late/overflow/PID/identity/admission custody refuses even with terminal-confirmed status',()=>{
 const f=fixture().form();for(const [name,change] of negatives)assert.throws(()=>receiveNativeCompactionOutcome(f.parameterText,f.admissionText,mutateJson(f.bundle,'result.json',change)),undefined,name);
 const missing=structuredClone(f.bundle);delete missing['native-pid.json'];assert.throws(()=>receiveNativeCompactionOutcome(f.parameterText,f.admissionText,missing));
 assert.throws(()=>receiveNativeCompactionOutcome(f.parameterText,f.admissionText,mutateJson(f.bundle,'native-pid.json',p=>p.pid++)));
 assert.throws(()=>receiveNativeCompactionOutcome(f.parameterText,f.admissionText,{...f.bundle,'checkpoint.resource.json':encode('changed checkpoint')}));
});
test('private preparation selects exact immutable role files; no launch and no Resource alias',()=>{
 const f=fixture(),v=f.form();const plan=renderNativeCompactionFilePreparation(v.parameterText,v.admissionText,f.resources);
 assert.equal(plan.effectsExecuted,false);assert.equal(plan.parentSha256,v.render.scriptSha256);assert.equal(plan.scriptSha256,maintenanceHash(plan.script));
 f.a.resources[0].path=f.a.resources[1].path;assert.throws(()=>renderNativeCompactionFilePreparation(v.parameterText,JSON.stringify(f.a),f.resources));
 let invoked=false;assert.throws(()=>launchNativeCompactionFile(v.parameterText,v.admissionText,JSON.stringify({type:'WslNativeCompactionFileReceiving',request:f.a.request,parentSha256:'0'.repeat(64),admissionSha256:v.render.admissionSha256}),{run(){invoked=true}}));assert.equal(invoked,false);
});
test('modern guest result persists exclusively only after separate fresh exact reentry admission',()=>{
 const sectionRoot=fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/,'');mkdirSync(sectionRoot+'/data/logs',{recursive:true});const out=mkdtempSync(sectionRoot+'/data/logs/modern-outcome-');
 try{
  const f=fixture();const receiver=fileURLToPath(new URL('../scripts/receive-native-compaction-outcome.mjs',import.meta.url));f.p.windows.nativeCompaction.reentry={linuxUser:'emsenn',node:'/gnu/store/kba00zrnc1d1cg9bkx0krpvc2sp7wzrh-node-24.18.0/bin/node',receiver,receiverSha256:maintenanceHash(readFileSync(receiver)),receiverClosure:closure(),ownerUid:process.getuid(),sectionRoot,outputDirectory:out};
  const v=f.form(),received=receiveNativeCompactionOutcome(v.parameterText,v.admissionText,v.bundle),resources={authority:'fixture reentry authority',checkpoint:'fixture reentry checkpoint','independent-receiving':'fixture reentry receiving'};
  const r={type:'WslNativeCompactionReentryAdmission',version:1,request:f.a.request,outcomeSha256:received.outcomeSha256,parameterSha256:received.parameterSha256,maintenanceAdmissionSha256:received.admissionSha256,notBefore:iso(Date.now()-1000),expiresAt:iso(Date.now()+590000),invocation:{executable:nativeCompactionQualification.executable,argv:['--distribution','Example','--user','emsenn','--exec',f.p.windows.nativeCompaction.reentry.node,receiver]},resources:Object.entries(resources).map(([role,value])=>({role,path:f.p.windows.nativeCompaction.custodyDirectory+'\\'+f.a.request+'.caller\\reentry-'+role+'.resource.json',sha256:maintenanceHash(value)}))};
  const payload=formNativeCompactionOutcomeTransfer(v.parameterText,v.admissionText,v.bundle,JSON.stringify(r),resources);
  const bad=structuredClone(payload);bad.reentryText=JSON.stringify({...r,outcomeSha256:'0'.repeat(64)});assert.throws(()=>persistNativeCompactionOutcome(JSON.stringify(bad)));assert.equal(existsSync(out+'/'+f.a.request+'.windows-outcome.json'),false);
  for(const change of [r=>r.request='22222222-2222-2222-2222-222222222222',r=>r.expiresAt=iso(Date.now()-1),r=>r.invocation.argv[1]='Other',r=>r.resources[0].sha256='0'.repeat(64)]){const changed=structuredClone(r);change(changed);assert.throws(()=>persistNativeCompactionOutcome(JSON.stringify({...payload,reentryText:JSON.stringify(changed)})))}
  assert.throws(()=>persistNativeCompactionOutcome(JSON.stringify({...payload,packetSha256:'0'.repeat(64)})));
  const receipt=persistNativeCompactionOutcome(JSON.stringify(payload));assert.equal(receipt.chatResumed,false);assert.equal(receipt.holdsReleased,false);assert.equal(receipt.capacityReopened,false);assert.equal(readFileSync(receipt.path,'utf8'),JSON.stringify(payload));assert.throws(()=>persistNativeCompactionOutcome(JSON.stringify(payload)),/EEXIST/);
 }finally{rmSync(out,{recursive:true,force:true})}
});
test('builtin-only guest entry rejects changed imported implementation before import/write, with unchanged entry',()=>{
 mkdirSync(ownerSource+'/data/logs',{recursive:true});const directory=mkdtempSync(ownerSource+'/data/logs/receiver-closure-fixture-');
 try{
  for(const relative of nativeReceiverClosure){const target=directory+'/'+relative;mkdirSync(target.slice(0,target.lastIndexOf('/')),{recursive:true});writeFileSync(target,readFileSync(ownerSource+'/'+relative),{mode:0o600})}
  const output=directory+'/data/logs/outcome';mkdirSync(output,{recursive:true,mode:0o700});const receiver=directory+'/scripts/receive-native-compaction-outcome.mjs';const expectedEntry=maintenanceHash(readFileSync(receiver));
  const f=fixture();f.p.windows.nativeCompaction.reentry={linuxUser:'emsenn',node:process.execPath,receiver,receiverSha256:expectedEntry,receiverClosure:closure(),ownerUid:process.getuid(),sectionRoot:directory,outputDirectory:output};
  const v=f.form(),received=receiveNativeCompactionOutcome(v.parameterText,v.admissionText,v.bundle),resources={authority:'fixture reentry authority',checkpoint:'fixture current checkpoint','independent-receiving':'fixture independent receiving'};
  const r={type:'WslNativeCompactionReentryAdmission',version:1,request:f.a.request,outcomeSha256:received.outcomeSha256,parameterSha256:received.parameterSha256,maintenanceAdmissionSha256:received.admissionSha256,notBefore:iso(Date.now()-1000),expiresAt:iso(Date.now()+590000),invocation:{executable:nativeCompactionQualification.executable,argv:['--distribution','Example','--user','emsenn','--exec',process.execPath,receiver]},resources:Object.entries(resources).map(([role,value])=>({role,path:f.p.windows.nativeCompaction.custodyDirectory+'\\'+f.a.request+'.caller\\reentry-'+role+'.resource.json',sha256:maintenanceHash(value)}))};
  const payload=JSON.stringify(formNativeCompactionOutcomeTransfer(v.parameterText,v.admissionText,v.bundle,JSON.stringify(r),resources));
  const sentinel=directory+'/unqualified-provider-executed';writeFileSync(directory+'/src/native-maintenance-caller.mjs',"import {writeFileSync} from 'node:fs';writeFileSync("+JSON.stringify(sentinel)+",'must never execute');export function persistNativeCompactionOutcome(){throw Error('unqualified provider executed')}\n");
  assert.equal(maintenanceHash(readFileSync(receiver)),expectedEntry);
  assert.throws(()=>execFileSync(process.execPath,[receiver],{input:payload,encoding:'utf8',timeout:5000,stdio:['pipe','pipe','pipe']}),/receiver closure changed: src\/native-maintenance-caller.mjs/);
  assert.equal(existsSync(sentinel),false);assert.equal(existsSync(output+'/'+f.a.request+'.windows-outcome.json'),false);
  writeFileSync(directory+'/src/native-maintenance-caller.mjs',readFileSync(ownerSource+'/src/native-maintenance-caller.mjs'));
  const accepted=JSON.parse(execFileSync(process.execPath,[receiver],{input:payload,encoding:'utf8',timeout:5000,stdio:['pipe','pipe','pipe']}));assert.equal(accepted.type,'WslNativeCompactionOutcomePersisted');assert.equal(accepted.chatResumed,false);assert.equal(existsSync(accepted.path),true);
 }finally{rmSync(directory,{recursive:true,force:true})}
});

function windows(script,input=''){
 const loader="$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';$testPacket=[Console]::In.ReadToEnd()|ConvertFrom-Json;[Console]::SetIn([IO.StringReader]::new($testPacket.input));Invoke-Expression $testPacket.script";
 return execFileSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(loader,'utf16le').toString('base64')],{input:JSON.stringify({script,input}),encoding:'utf8',cwd:'/',timeout:30000,maxBuffer:4*1024*1024});
}
const common=()=>readFileSync(new URL('../assets/native-compaction-outcome.ps1',import.meta.url),'utf8');
test('actual Windows shared outcome validator refuses every failed terminal control', {skip:!existsSync(powershell)},()=>{
 const f=fixture().form();const bundles=[f.bundle,...negatives.map(([,change])=>mutateJson(f.bundle,'result.json',change)),mutateJson(f.bundle,'native-pid.json',p=>p.pid++),...[
  p=>p.declaration.ownerSid='S-1-5-21-1-2-3-1000',p=>p.declaration.reentry={receiver:'/unbound-provider'},p=>p.target.policy.minFreeBytes='0',p=>p.admission.concurrentPeakBytes='0',p=>p.qualification.sourceBlobs[0]='0'.repeat(40)
 ].map(change=>mutateJson(f.bundle,'packet.json',change))];
 const code=common()+"\n$rows=[Console]::In.ReadToEnd()|ConvertFrom-Json;$out=@();foreach($bundle in $rows){try{$null=Receive-MaintenanceOutcome $bundle;$out+=@{Accepted=$true}}catch{$out+=@{Accepted=$false;Message=$_.Exception.Message}}};$out|ConvertTo-Json -Compress";
 const output=JSON.parse(windows(code,JSON.stringify(bundles)));assert.equal(output[0].Accepted,true,output[0].Message);for(const row of output.slice(1))assert.equal(row.Accepted,false,row.Message);
});
test('actual Windows private prepare retains complete exact -File parent and helpers without native WSL launch', {skip:!existsSync(powershell)},()=>{
 const info=JSON.parse(windows("[ordered]@{SID=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;Temp=[IO.Path]::GetTempPath()}|ConvertTo-Json -Compress"));
 const sectionRoot=fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/,'');mkdirSync(sectionRoot+'/data/logs',{recursive:true});const outputDirectory=mkdtempSync(sectionRoot+'/data/logs/windows-reentry-fixture-');
 const receiver=fileURLToPath(new URL('../scripts/receive-native-compaction-outcome.mjs',import.meta.url));
 let evidence;
 const f=fixture();f.p.windows.nativeCompaction.ownerSid=info.SID;f.p.windows.nativeCompaction.custodyDirectory=info.Temp.replace(/\\$/,'')+'\\wsl-owner-carrier-test-'+process.pid+'-'+Date.now();
 f.p.windows.nativeCompaction.reentry={linuxUser:'emsenn',node:'/gnu/store/kba00zrnc1d1cg9bkx0krpvc2sp7wzrh-node-24.18.0/bin/node',receiver,receiverSha256:maintenanceHash(readFileSync(receiver)),receiverClosure:closure(),ownerUid:process.getuid(),sectionRoot,outputDirectory};const v=f.form();
 try{
  const prepared=prepareNativeCompactionFiles(v.parameterText,v.admissionText,f.resources);assert.equal(prepared.ParentSHA256,v.render.scriptSha256);assert.equal(prepared.EffectsExecuted,false);
  const caller=f.p.windows.nativeCompaction.custodyDirectory+'\\'+f.a.request+'.caller';
  const check=JSON.parse(windows("$p=[Console]::In.ReadToEnd()|ConvertFrom-Json;$parent=Get-Item -LiteralPath ($p.Caller+'\\parent.ps1');$files=@('read.ps1','prepare-reentry.ps1','transfer.ps1');$errors=@();foreach($file in $files){$tokens=$null;$parseErrors=$null;$null=[Management.Automation.Language.Parser]::ParseFile(($p.Caller+'\\'+$file),[ref]$tokens,[ref]$parseErrors);$errors+=@($parseErrors)};[ordered]@{Hash=(Get-FileHash -LiteralPath $parent.FullName -Algorithm SHA256).Hash.ToLowerInvariant();Errors=@($errors|Where-Object {$null -ne $_}).Count;NativeClaim=(Test-Path -LiteralPath ($p.Root+'\\'+$p.Request+'.claim'));LaunchClaim=(Test-Path -LiteralPath ($p.Caller+'\\launch.claim'))}|ConvertTo-Json -Compress",JSON.stringify({Caller:caller,Root:f.p.windows.nativeCompaction.custodyDirectory,Request:f.a.request})));
  assert.equal(check.Hash,v.render.scriptSha256);assert.equal(check.Errors,0);assert.equal(check.NativeClaim,false);assert.equal(check.LaunchClaim,false);
  assert.throws(()=>prepareNativeCompactionFiles(v.parameterText,v.admissionText,f.resources),/Occupied original caller custody/);
  // Run the exact source-owned ShellExecute helper with a benign private
  // qualification file, never the prepared compactor parent.
  const source=readFileSync(new URL('../assets/native-maintenance-caller.ps1',import.meta.url),'utf8');
  const helpers=common()+'\n'+source.slice(0,source.indexOf('# The transfer helper'));
  const benign="[Console]::Out.Write('must-not-inherit-wsl-pipe');$receipt=[ordered]@{pid=$PID;sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value};[IO.File]::WriteAllText(($PSCommandPath+'.result'),($receipt|ConvertTo-Json -Compress));exit 17";
  const detached=JSON.parse(windows(helpers+"\n$t=[Console]::In.ReadToEnd()|ConvertFrom-Json;$file=$t.Caller+'\\qualification-parent.ps1';[IO.File]::WriteAllText($file,$t.Source);$p=Start-PrivateMaintenanceFile $file;$done=$p.WaitForExit(15000);$r=[ordered]@{Pid=$p.Id;WithinDeadline=$done;Exit=$p.ExitCode;Child=(Get-Content -LiteralPath ($file+'.result') -Raw|ConvertFrom-Json)};$p.Dispose();$r|ConvertTo-Json -Compress",JSON.stringify({Caller:caller,Source:benign})));
  assert.equal(detached.WithinDeadline,true);assert.equal(detached.Exit,17);assert.equal(detached.Child.pid,detached.Pid);assert.equal(detached.Child.sid,info.SID);
  // Qualify the actual bounded transfer awaiter against a native PowerShell
  // child: bounded stdin, concurrent oversized streams, late nonzero terminal.
  const transferHelper=/Add-Type -TypeDefinition @'\n([\s\S]+?)\n'@/.exec(source)[1];
  const child="$ProgressPreference='SilentlyContinue';$value=[Console]::In.ReadToEnd();if($value.Length -ne 4096){exit 19};[Console]::Out.Write(('x'*8192));[Console]::Error.Write(('e'*8192));Start-Sleep -Milliseconds 250;exit 17";
  const awaitProof=JSON.parse(windows("$t=[Console]::In.ReadToEnd()|ConvertFrom-Json;Add-Type -TypeDefinition $t.Helper;[IO.Directory]::CreateDirectory($t.Directory)|Out-Null;$outcome=[WslMaintenanceTransfer]::Await('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',$t.Arguments,([Text.Encoding]::UTF8.GetBytes(('i'*4096))),$t.Directory,1,1024);[ordered]@{Outcome=$outcome;PidRecord=(Get-Content -LiteralPath ($t.Directory+'\\transfer-pid.json') -Raw|ConvertFrom-Json)}|ConvertTo-Json -Depth 8 -Compress",JSON.stringify({Helper:transferHelper,Arguments:'-NoLogo -NoProfile -NonInteractive -EncodedCommand '+Buffer.from(child,'utf16le').toString('base64'),Directory:caller+'\\qualification-await'})));
  const awaited=awaitProof.Outcome;assert.equal(awaitProof.PidRecord.pid,awaited.Pid);assert.equal(awaitProof.PidRecord.startedAt,awaited.StartedAt);
  assert.equal(awaited.Exit,17);assert.equal(awaited.WithinDeadline,false);assert.equal(awaited.InputError,null);assert.equal(awaited.PidError,null);assert.equal(awaited.Stdout.Overflow,true);assert.equal(awaited.Stderr.Overflow,true);assert.equal(awaited.Stdout.TotalBytes,8192);assert.equal(awaited.Stderr.TotalBytes,8192);
  // Materialize only synthetic successful custody for the source reader. No
  // native operation produced this fixture and it is never actual admission.
  windows(helpers+"\n$t=[Console]::In.ReadToEnd()|ConvertFrom-Json;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$directory=$t.Root+'\\'+$t.Request;Private-MaintenanceDirectory $directory $true;foreach($property in $t.Bundle.PSObject.Properties){Durable-MaintenanceBytes ($directory+'\\'+$property.Name) ([Convert]::FromBase64String($property.Value))};Durable-MaintenanceText ($directory+'.claim') $t.AdmissionSHA256",JSON.stringify({Root:f.p.windows.nativeCompaction.custodyDirectory,Request:f.a.request,Bundle:v.bundle,AdmissionSHA256:v.render.admissionSha256}));
  const read=readNativeCompactionOutcome(v.parameterText,v.admissionText);assert.equal(read.receiving.result.Success,true);assert.equal(read.receiving.guestReentryAdmitted,false);
  const standalone=JSON.parse(execFileSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-File',caller+'\\read.ps1'],{encoding:'utf8',cwd:'/',timeout:30000,maxBuffer:1048576}));assert.deepEqual(standalone,v.bundle);
  const resources={authority:'fixture reentry authority',checkpoint:'fixture reentry checkpoint','independent-receiving':'fixture reentry receiving'};
  const reentry={type:'WslNativeCompactionReentryAdmission',version:1,request:f.a.request,outcomeSha256:read.receiving.outcomeSha256,parameterSha256:v.render.parameterSha256,maintenanceAdmissionSha256:v.render.admissionSha256,notBefore:iso(Date.now()-1000),expiresAt:iso(Date.now()+590000),invocation:{executable:nativeCompactionQualification.executable,argv:['--distribution','Example','--user','emsenn','--exec',f.p.windows.nativeCompaction.reentry.node,receiver]},resources:Object.entries(resources).map(([role,value])=>({role,path:caller+'\\reentry-'+role+'.resource.json',sha256:maintenanceHash(value)}))};
  const reentryPrepared=JSON.parse(execFileSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-File',caller+'\\prepare-reentry.ps1'],{input:JSON.stringify({reentryText:JSON.stringify(reentry),resources}),encoding:'utf8',cwd:'/',timeout:30000,maxBuffer:32768}));assert.equal(reentryPrepared.EffectsExecuted,false);assert.equal(reentryPrepared.OutcomeSHA256,read.receiving.outcomeSha256);
  const guest={type:'WslNativeCompactionOutcomePersisted',request:f.a.request,outcomeSha256:read.receiving.outcomeSha256,path:outputDirectory+'/'+f.a.request+'.windows-outcome.json',capacityReopened:false,holdsReleased:false,chatResumed:false};
  const transferNative={Pid:7654,Exit:0,WithinDeadline:true,StartedAt:iso(Date.now()-300),TerminalAt:iso(Date.now()-200),PidError:null,InputError:null,Stdout:{TotalBytes:Buffer.byteLength(JSON.stringify(guest)),Overflow:false,Error:null},Stderr:{TotalBytes:0,Overflow:false,Error:null}};
  const transferred={Type:'WslNativeCompactionTransferOutcome',Status:'terminal-confirmed',Request:f.a.request,OutcomeSHA256:read.receiving.outcomeSha256,ReentryAdmissionSHA256:maintenanceHash(JSON.stringify(reentry)),Native:transferNative,Success:true,At:iso(Date.now()-100)};
  const transferCases=[transferred,...[r=>r.Success=false,r=>r.Native.Exit=17,r=>r.Native.WithinDeadline=false,r=>r.Native.Stdout.Overflow=true,r=>r.Native.Pid++].map(change=>{const r=structuredClone(transferred);change(r);return r})];
  const priorTransfers=JSON.parse(windows(helpers+"\n$t=[Console]::In.ReadToEnd()|ConvertFrom-Json;$files=@{'transfer.claim'=$t.Claim;'transfer-stdout.bin'=$t.Stdout;'transfer-stderr.bin'='';'transfer-pid.json'=$t.Pid};foreach($entry in $files.GetEnumerator()){[IO.File]::WriteAllBytes(($t.Caller+'\\'+$entry.Key),[Convert]::FromBase64String($entry.Value))};$rows=@();foreach($result in $t.Results){[IO.File]::WriteAllBytes(($t.Caller+'\\transfer-result.json'),[Convert]::FromBase64String($result));try{Receive-MaintenancePriorLaunches $t.Root $t.Next;$rows+=@{Accepted=$true}}catch{$rows+=@{Accepted=$false;Message=$_.Exception.Message}}};Remove-Item -LiteralPath ($t.Caller+'\\transfer-result.json');try{Receive-MaintenancePriorLaunches $t.Root $t.Next;$rows+=@{Accepted=$true}}catch{$rows+=@{Accepted=$false;Message=$_.Exception.Message}};foreach($name in $files.Keys){Remove-Item -LiteralPath ($t.Caller+'\\'+$name)};$rows|ConvertTo-Json -Compress",JSON.stringify({Root:f.p.windows.nativeCompaction.custodyDirectory,Caller:caller,Next:'33333333-3333-3333-3333-333333333333',Claim:encode(read.receiving.outcomeSha256),Stdout:encode(guest),Pid:encode({pid:transferNative.Pid,startedAt:transferNative.StartedAt}),Results:transferCases.map(encode)})));
  assert.equal(priorTransfers[0].Accepted,true,priorTransfers[0].Message);for(const row of priorTransfers.slice(1))assert.equal(row.Accepted,false,row.Message);
  // Re-form a new request from the same parameter bytes directly. Prior failure
  // must stop the actual original parent before its missing fake target/Resources.
  const nextAdmission={...f.a,request:'33333333-3333-3333-3333-333333333333'};
  const newParent=renderNativeCompaction(v.parameterText,JSON.stringify(nextAdmission)).script;
  const priorNativeRefusals=[];
  for(const [name,change] of negatives.filter(([name])=>['failed terminal','native nonzero','late flag','overflow','PID mismatch'].includes(name))) {
   const bad=mutateJson(v.bundle,'result.json',change);
   const result=JSON.parse(windows("$t=[Console]::In.ReadToEnd()|ConvertFrom-Json;[IO.File]::WriteAllBytes($t.Result,[Convert]::FromBase64String($t.Bytes));try{Invoke-Expression $t.Parent;throw 'Unexpected parent acceptance'}catch{[ordered]@{Message=$_.Exception.Message}|ConvertTo-Json -Compress}",JSON.stringify({Result:f.p.windows.nativeCompaction.custodyDirectory+'\\'+f.a.request+'\\result.json',Bytes:bad['result.json'],Parent:newParent})));
   assert.match(result.Message,/qualified success|failed\/late|stream missing|PID/,name);
   priorNativeRefusals.push({name,...result});
  }
  const malformed=JSON.parse(windows(helpers+"\n$t=[Console]::In.ReadToEnd()|ConvertFrom-Json;$directory=$t.Root+'\\unknown.caller';[IO.Directory]::CreateDirectory($directory)|Out-Null;[IO.File]::WriteAllText(($directory+'\\launch.claim'),('0'*64));try{Receive-MaintenancePriorLaunches $t.Root $t.Next;throw 'Unexpected ambiguous caller acceptance'}catch{[ordered]@{Message=$_.Exception.Message}|ConvertTo-Json -Compress}",JSON.stringify({Root:f.p.windows.nativeCompaction.custodyDirectory,Next:nextAdmission.request})));assert.match(malformed.Message,/Unrecognized original launch custody/);
  const malformedNative=JSON.parse(windows("$t=[Console]::In.ReadToEnd()|ConvertFrom-Json;Remove-Item -LiteralPath ($t.Root+'\\unknown.caller') -Recurse -Force;[IO.File]::WriteAllBytes(($t.Root+'\\'+$t.Request+'\\result.json'),[Convert]::FromBase64String($t.ValidResult));[IO.File]::WriteAllText(($t.Root+'\\unknown.claim'),('0'*64));try{Invoke-Expression $t.Parent;throw 'Unexpected ambiguous claim acceptance'}catch{[ordered]@{Message=$_.Exception.Message}|ConvertTo-Json -Compress}",JSON.stringify({Root:f.p.windows.nativeCompaction.custodyDirectory,Parent:newParent,Request:f.a.request,ValidResult:v.bundle['result.json']})));assert.match(malformedNative.Message,/Unrecognized original request claim/);
  evidence={type:'NativeMaintenanceFileCallerNonDisruptiveQualification',fixtureOnly:true,maintenanceEffectsExecuted:false,guestStarted:false,target:'synthetic unregistered Example/D: fixture; no native WSL child',prepared,detached,awaitProof,modernPrivateFileRead:true,reentryResourcePreparation:reentryPrepared,priorNativeRefusals,priorTransferControls:priorTransfers,malformedCallerRefusal:malformed,malformedNativeRefusal:malformedNative};
 }finally{windows("$p=[Console]::In.ReadToEnd();if(Test-Path -LiteralPath $p){Remove-Item -LiteralPath $p -Recurse -Force}",f.p.windows.nativeCompaction.custodyDirectory);rmSync(outputDirectory,{recursive:true,force:true})}
 evidence.fixtureCustodyRemoved=true;writeFileSync(sectionRoot+'/data/logs/native-maintenance-file-caller.qualification.json',JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
});
test('actual Windows conditional scope and derivation agree with original receiver; rendered file is independently bound', {skip:!existsSync(powershell)},()=>{
 const info=JSON.parse(windows("[ordered]@{SID=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;Temp=[IO.Path]::GetTempPath()}|ConvertTo-Json -Compress"));
 const f=conditionalFixture(f=>{f.p.windows.nativeCompaction.ownerSid=info.SID;f.p.windows.nativeCompaction.custodyDirectory=info.Temp.replace(/\\$/,'')+'\\wsl-conditional-fixture-'+process.pid+'-'+Date.now()});const v=f.form();let proof;
 try{
  const prepared=prepareNativeCompactionFiles(v.parameterText,v.admissionText,f.resources);assert.equal(prepared.EffectsExecuted,false);assert.match(prepared.ContinuationSHA256,/^[a-f0-9]{64}$/);
  const source=readFileSync(new URL('../assets/native-maintenance-caller.ps1',import.meta.url),'utf8'),helpers=common()+'\n'+source.slice(0,source.indexOf('# The transfer helper'));
  const caller=f.p.windows.nativeCompaction.custodyDirectory+'\\'+f.a.request+'.caller',derived=deriveConditionalCompactionReentry(v.parameterText,v.admissionText,v.bundle),r=JSON.parse(derived.reentryText);
  const code=helpers+"\n$t=[Console]::In.ReadToEnd()|ConvertFrom-Json;$packet=$t.Packet|ConvertFrom-Json;$caller=$t.Caller;$inputPacket=[pscustomobject]@{templateSha256=$t.Template};$scope=Receive-ConditionalScope;$received=Receive-MaintenanceOutcome $t.Bundle;$derived=New-ConditionalResources $scope $received $t.NotBefore $t.ExpiresAt;$errors=$null;$tokens=$null;$file=$caller+'\\continue.ps1';$null=[Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors);[ordered]@{Derived=$derived;ActualFileHash=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant();ParseErrors=@($errors).Count;NativeClaim=(Test-Path -LiteralPath ($t.Root+'\\'+$packet.admission.request+'.claim'));LaunchClaim=(Test-Path -LiteralPath ($caller+'\\launch.claim'))}|ConvertTo-Json -Depth 30 -Compress";
  proof=JSON.parse(windows(code,JSON.stringify({Packet:v.render.packetText,Caller:caller,Root:f.p.windows.nativeCompaction.custodyDirectory,Template:f.p.windows.nativeCompaction.reentry.continuation.templateSha256,Bundle:v.bundle,NotBefore:r.notBefore,ExpiresAt:r.expiresAt})));
  assert.equal(proof.ParseErrors,0);assert.equal(proof.ActualFileHash,prepared.ContinuationSHA256);assert.equal(proof.NativeClaim,false);assert.equal(proof.LaunchClaim,false);for(const role of Object.keys(derived.resources))assert.deepEqual(proof.Derived[role],JSON.parse(derived.resources[role]));
  const late=JSON.parse(windows(helpers+"\n$caller=[Console]::In.ReadToEnd();$file=$caller+'\\qualification-late-parent.ps1';[IO.File]::WriteAllText($file,'Start-Sleep -Milliseconds 250;exit 0');$p=Start-PrivateMaintenanceFile $file;$captured=$p.Id;$refused=$false;try{$null=Await-MaintenanceFileParent $p 1 'qualification-late'}catch{$refused=$true};[ordered]@{Refused=$refused;Captured=$captured;Terminal=(Get-Content -LiteralPath ($caller+'\\qualification-late-terminal.json') -Raw|ConvertFrom-Json);StillPresent=([bool](Get-Process -Id $captured -ErrorAction SilentlyContinue))}|ConvertTo-Json -Depth 8 -Compress",caller));assert.equal(late.Refused,true);assert.equal(late.Terminal.pid,late.Captured);assert.equal(late.Terminal.exit,0);assert.equal(late.Terminal.withinDeadline,false);assert.equal(late.StillPresent,false);proof.ActualLateParentAwait=late;
  const review={type:'WslNativeCompactionFileReceiving',request:f.a.request,parentSha256:v.render.scriptSha256,admissionSha256:v.render.admissionSha256,continuationSha256:prepared.ContinuationSHA256};
  let actualInvocation=0;launchNativeCompactionFile(v.parameterText,v.admissionText,JSON.stringify(review),{run(){actualInvocation++;return '{}'}});assert.equal(actualInvocation,1); // injected port, no launch
 }finally{windows("$p=[Console]::In.ReadToEnd();if(Test-Path -LiteralPath $p){Remove-Item -LiteralPath $p -Recurse -Force}",f.p.windows.nativeCompaction.custodyDirectory)}
 mkdirSync(ownerSource+'/data/logs',{recursive:true});writeFileSync(ownerSource+'/data/logs/conditional-native-caller.qualification.json',JSON.stringify({type:'ConditionalNativeCallerSourceQualification',fixtureOnly:true,maintenanceEffectsExecuted:false,guestStarted:false,proof,fixtureCustodyRemoved:true},null,2)+'\n',{mode:0o600});
});
test('actual Windows custody hierarchy preparation needs no maintenance admission and retains partial custody', {skip:!existsSync(powershell)},()=>{
 const info=JSON.parse(windows("[ordered]@{SID=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;Temp=[IO.Path]::GetTempPath()}|ConvertTo-Json -Compress"));
 const parent=info.Temp.replace(/\\$/,'')+'\\wsl-custody-parent-fixture-'+process.pid+'-'+Date.now(),source=readFileSync(new URL('../assets/native-maintenance-caller.ps1',import.meta.url),'utf8'),helpers=common()+'\n'+source.slice(0,source.indexOf('# The transfer helper'));
 windows(helpers+"\n$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;Private-MaintenanceDirectory ([Console]::In.ReadToEnd()) $true",parent);
 const f=fixture(),d=f.p.windows.nativeCompaction;d.ownerSid=info.SID;d.custodyPreparation={existingParent:parent,components:['fixture-section','data','logs','maintenance']};d.custodyDirectory=parent+'\\'+d.custodyPreparation.components.join('\\');
 const receiving=parameterText=>({type:'WslNativeCompactionCustodyParentReceiving',version:1,parent:observeNativeCompactionCustody(parameterText),parameterSha256:maintenanceHash(parameterText),custodyDirectory:d.custodyDirectory,templateSha256:maintenanceHash(readFileSync(new URL('../assets/native-maintenance-caller.ps1',import.meta.url))),receiver:{actor:'https://fixture.invalid/actors/independent',resource:{path:'/fixture/data/logs/parent-receiving.json',sha256:maintenanceHash('fixture independent receiving')}}});
 let evidence;
 try{
  let parameterText=JSON.stringify(f.p),r=receiving(parameterText);const changed=structuredClone(r);changed.parent.fileIdentity='00000000:0000000000000000';assert.throws(()=>prepareNativeCompactionCustody(parameterText,JSON.stringify(changed)),/identity\/ACL changed/);
  const prepared=prepareNativeCompactionCustody(parameterText,JSON.stringify(r));assert.equal(prepared.status,'completed');assert.equal(prepared.created.length,4);assert.equal(prepared.effectsExecuted,false);
  const privateClaim=JSON.parse(windows("$t=[Console]::In.ReadToEnd()|ConvertFrom-Json;$claim=$t.Parent+'\\.wsl-maintenance-custody-'+$t.Hash+'.claim';$a=Get-Acl -LiteralPath $claim;[ordered]@{Owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;Protected=$a.AreAccessRulesProtected}|ConvertTo-Json -Compress",JSON.stringify({Parent:parent,Hash:maintenanceHash(d.custodyDirectory)})));assert.equal(privateClaim.Owner,info.SID);assert.equal(privateClaim.Protected,true);
  const before=observeNativeCompactionCustody(parameterText);assert.deepEqual(before,r.parent);const received=prepareNativeCompactionCustody(parameterText,JSON.stringify(r));assert.equal(received.status,'received-without-writes');assert.deepEqual(observeNativeCompactionCustody(parameterText),before);
  // Deliberately invalid ACL belongs only to this benign private fixture.
  // Delete-child rights are writes even without the ordinary Write bit.
  const badParent=parent+'\\untrusted-parent';windows("$path=[Console]::In.ReadToEnd();$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$a=[Security.AccessControl.DirectorySecurity]::new();$a.SetOwner([Security.Principal.SecurityIdentifier]::new($sid));$a.SetAccessRuleProtection($true,$false);foreach($id in @($sid,'S-1-5-18','S-1-5-32-544')){$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($id),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))};$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,'Allow'));[IO.Directory]::CreateDirectory($path,$a)|Out-Null",badParent);
  d.custodyPreparation.existingParent=badParent;d.custodyPreparation.components=['unreceived-writer','data'];d.custodyDirectory=badParent+'\\unreceived-writer\\data';parameterText=JSON.stringify(f.p);r=receiving(parameterText);assert.ok(r.parent.effectiveWriterSids.includes('S-1-1-0'));assert.throws(()=>prepareNativeCompactionCustody(parameterText,JSON.stringify(r)),/Unreceived existing ancestor writer/);
  d.custodyPreparation.existingParent=parent;
  // The declared original owner encounters a file where a directory is required.
  // Its partial claim remains; another call cannot silently clear/retry it.
  windows("$p=[Console]::In.ReadToEnd();[IO.File]::WriteAllText(($p+'\\blocked'),'fixture held file')",parent);
  d.custodyPreparation.components=['blocked','data'];d.custodyDirectory=parent+'\\blocked\\data';parameterText=JSON.stringify(f.p);r=receiving(parameterText);
  assert.throws(()=>prepareNativeCompactionCustody(parameterText,JSON.stringify(r)),/not a directory/);
  assert.throws(()=>prepareNativeCompactionCustody(parameterText,JSON.stringify(r)),/Partial original custody preparation remains held/);
  const bad=structuredClone(f.p);bad.windows.nativeCompaction.custodyPreparation.components=['..'];assert.throws(()=>observeNativeCompactionCustody(JSON.stringify(bad),{run(){assert.fail('invalid hierarchy reached Windows')}}));
  const policies=JSON.parse(windows(helpers+"\n$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$t=[Console]::In.ReadToEnd()|ConvertFrom-Json;$rows=@();foreach($owner in @('S-1-5-18','S-1-5-32-544','S-1-5-21-1-2-3-987654')){$t.parentOwnerSid=$owner;try{Receive-MaintenanceTrustedParent $t;$rows+=@{Owner=$owner;Accepted=$true}}catch{$rows+=@{Owner=$owner;Accepted=$false}}};$rows|ConvertTo-Json -Compress",JSON.stringify(before)));assert.deepEqual(policies.map(x=>x.Accepted),[true,true,false]);
  evidence={parent:before,prepared,received,privateClaim,ancestorOwnerControls:policies,unreceivedDeleteChildWriterRefused:true,partialPreparationRetained:true,maintenanceAdmissionUsed:false,maintenanceEffectsExecuted:false,guestStarted:false};
 }finally{windows("$p=[Console]::In.ReadToEnd();if(Test-Path -LiteralPath $p){Remove-Item -LiteralPath $p -Recurse -Force}",parent)}
 mkdirSync(ownerSource+'/data/logs',{recursive:true});writeFileSync(ownerSource+'/data/logs/native-custody-preparation.qualification.json',JSON.stringify({...evidence,fixtureOnly:true,fixtureCustodyRemoved:true},null,2)+'\n',{mode:0o600});
});
test('finite original Windows holder survives its initiating process and derives one transfer with injected native ports', {skip:!existsSync(powershell)},()=>{
 const info=JSON.parse(windows("[ordered]@{SID=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;Temp=[IO.Path]::GetTempPath()}|ConvertTo-Json -Compress"));
 const f=conditionalFixture(f=>{f.p.windows.nativeCompaction.ownerSid=info.SID;f.p.windows.nativeCompaction.custodyDirectory=info.Temp.replace(/\\$/,'')+'\\wsl-surviving-holder-fixture-'+process.pid+'-'+Date.now();f.p.windows.nativeCompaction.reentry.continuation.parentDeadlineMs=10000});const v=f.form(),root=f.p.windows.nativeCompaction.custodyDirectory,caller=root+'\\'+f.a.request+'.caller';
 const source=readFileSync(new URL('../assets/native-maintenance-caller.ps1',import.meta.url),'utf8'),helpers=common()+'\n'+source.slice(0,source.indexOf('# The transfer helper'));
 const parentChild=String.raw`$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';$t=Get-Content -LiteralPath ($PSScriptRoot+'\fixture-input.json') -Raw|ConvertFrom-Json;$directory=$t.Root+'\'+$t.Request;[IO.Directory]::CreateDirectory($directory)|Out-Null;foreach($property in $t.Bundle.PSObject.Properties){[IO.File]::WriteAllBytes(($directory+'\'+$property.Name),[Convert]::FromBase64String($property.Value))};$path=$directory+'\started.json';$intent=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json;$intent.WindowsParentPID=$PID;[IO.File]::WriteAllText($path,($intent|ConvertTo-Json -Depth 30 -Compress),[Text.UTF8Encoding]::new($false));exit 0`;
 const transferChild=String.raw`$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';$t=Get-Content -LiteralPath ($PSScriptRoot+'\fixture-input.json') -Raw|ConvertFrom-Json;$caller=$t.Caller;$rText=Get-Content -LiteralPath ($caller+'\reentry-admission.json') -Raw;$r=$rText|ConvertFrom-Json;$start=[DateTime]::UtcNow.ToString('o');$utf8=[Text.UTF8Encoding]::new($false);$sha=[Security.Cryptography.SHA256]::Create();$hash=([BitConverter]::ToString($sha.ComputeHash($utf8.GetBytes($rText)))).Replace('-','').ToLowerInvariant();$sha.Dispose();$file=[IO.FileStream]::new(($caller+'\transfer.claim'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write);$bytes=$utf8.GetBytes($r.outcomeSha256);$file.Write($bytes,0,$bytes.Length);$file.Flush($true);$file.Dispose();$guest=[ordered]@{type='WslNativeCompactionOutcomePersisted';request=$r.request;outcomeSha256=$r.outcomeSha256;path=$t.Output+'/'+$r.request+'.windows-outcome.json';capacityReopened=$false;holdsReleased=$false;chatResumed=$false};$stdout=$utf8.GetBytes(($guest|ConvertTo-Json -Compress));[IO.File]::WriteAllBytes(($caller+'\transfer-stdout.bin'),$stdout);[IO.File]::WriteAllBytes(($caller+'\transfer-stderr.bin'),[byte[]]@());[IO.File]::WriteAllText(($caller+'\transfer-pid.json'),(@{pid=$PID;startedAt=$start}|ConvertTo-Json -Compress),$utf8);$terminal=[DateTime]::UtcNow.ToString('o');$native=[ordered]@{Pid=$PID;Exit=0;WithinDeadline=$true;StartedAt=$start;TerminalAt=$terminal;PidError=$null;InputError=$null;Stdout=@{TotalBytes=$stdout.Length;Overflow=$false;Error=$null};Stderr=@{TotalBytes=0;Overflow=$false;Error=$null}};$result=[ordered]@{Type='WslNativeCompactionTransferOutcome';Status='terminal-confirmed';Request=$r.request;OutcomeSHA256=$r.outcomeSha256;ReentryAdmissionSHA256=$hash;Native=$native;Success=$true;At=[DateTime]::UtcNow.ToString('o')};[IO.File]::WriteAllText(($caller+'\transfer-result.json'),($result|ConvertTo-Json -Depth 20 -Compress),$utf8);exit 0`;
 let evidence;
 try{
  const prepared=prepareNativeCompactionFiles(v.parameterText,v.admissionText,f.resources);assert.match(prepared.ContinuationSHA256,/^[a-f0-9]{64}$/);
  const input={Root:root,Caller:caller,Request:f.a.request,Output:f.p.windows.nativeCompaction.reentry.outputDirectory,Bundle:v.bundle,Packet:v.render.packetText,Parameters:v.parameterText,Admission:v.admissionText,ParentSHA:v.render.scriptSha256,Template:f.p.windows.nativeCompaction.reentry.continuation.templateSha256};
  const holder=helpers+String.raw`
$fixture=Get-Content -LiteralPath ($PSScriptRoot+'\fixture-input.json') -Raw|ConvertFrom-Json
$packet=$fixture.Packet|ConvertFrom-Json;$parameters=$fixture.Parameters|ConvertFrom-Json;$root=$fixture.Root;$caller=$fixture.Caller;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$inputPacket=[pscustomobject]@{packetText=$fixture.Packet;parameterText=$fixture.Parameters;admissionText=$fixture.Admission;parentSha256=$fixture.ParentSHA;templateSha256=$fixture.Template;callerDirectory=$caller}
# Entry-file receiving and actual target/guest ports are separately qualified.
# This fixture executes the original finite controller with benign Windows
# processes at its two native dispatch ports; no real WSL provider is reached.
Set-Item function:Start-FixturePrivateFile (Get-Item function:Start-PrivateMaintenanceFile).ScriptBlock
$script:portCalls=@()
function Receive-Caller {return (Maintenance-Json (Read-MaintenanceFile (Join-Path $caller 'manifest.json')))}
function Receive-CurrentMaintenanceTarget($received){Maintenance-Assert ($received.Packet.target.distributionName -ceq 'Example') 'Fixture target drift'}
function Receive-CurrentMaintenanceProvider {Maintenance-Assert ($packet.qualification.version -ceq '3.0.3.0') 'Fixture provider drift'}
function Start-PrivateMaintenanceFile([string]$file){$script:portCalls+=,[IO.Path]::GetFileName($file);if($file -ceq (Join-Path $caller 'parent.ps1')){return (Start-FixturePrivateFile (Join-Path $caller 'qualification-native-parent.ps1'))};if($file -ceq (Join-Path $caller 'transfer.ps1')){return (Start-FixturePrivateFile (Join-Path $caller 'qualification-transfer.ps1'))};throw 'Unexpected native dispatch'}
try{
 Durable-MaintenanceText (Join-Path $caller 'launch.claim') $packet.admissionSha256
 Durable-MaintenanceText (Join-Path $caller 'launch-acknowledgement.json') ([ordered]@{Type='WslNativeCompactionFileLaunch';Request=$packet.admission.request;WindowsParentPID=$PID;AdmissionSHA256=$packet.admissionSha256;ParentSHA256=$inputPacket.parentSha256}|ConvertTo-Json -Compress)
 Invoke-ConditionalMaintenance
 $before=$script:portCalls.Count;$refused=$false;try{Invoke-ConditionalMaintenance}catch{$refused=$true};Maintenance-Assert ($refused -and $before -eq 2 -and $script:portCalls.Count -eq 2) 'Duplicate conditional dispatch'
 $result=[ordered]@{Success=$true;HolderPID=$PID;PortCalls=$script:portCalls;DuplicateRefused=$refused;Receiving=(Get-Content -LiteralPath ($caller+'\conditional-outcome-receiving.json') -Raw|ConvertFrom-Json);Reentry=(Get-Content -LiteralPath ($caller+'\reentry-admission.json') -Raw|ConvertFrom-Json);ParentTerminal=(Get-Content -LiteralPath ($caller+'\conditional-parent-terminal.json') -Raw|ConvertFrom-Json);TransferTerminal=(Get-Content -LiteralPath ($caller+'\conditional-transfer-terminal.json') -Raw|ConvertFrom-Json)}
}catch{$result=[ordered]@{Success=$false;Error=$_.Exception.Message;Detail=$_.ScriptStackTrace;PortCalls=$script:portCalls;DerivedCustodyPresent=(Test-Path -LiteralPath ($caller+'\conditional-outcome-receiving.json'))}}
finally{foreach($stream in $held){$stream.Dispose()}}
[IO.File]::WriteAllText(($caller+'\qualification-holder-result.json'),($result|ConvertTo-Json -Depth 30 -Compress),[Text.UTF8Encoding]::new($false))
`;
  const launch=helpers+"\n$t=[Console]::In.ReadToEnd()|ConvertFrom-Json;foreach($pair in @(@{Name='fixture-input.json';Text=$t.Input},@{Name='qualification-native-parent.ps1';Text=$t.Parent},@{Name='qualification-transfer.ps1';Text=$t.Transfer},@{Name='qualification-holder.ps1';Text=$t.Holder})){[IO.File]::WriteAllText(($t.Caller+'\\'+$pair.Name),$pair.Text,[Text.UTF8Encoding]::new($false))};$p=Start-PrivateMaintenanceFile ($t.Caller+'\\qualification-holder.ps1');[ordered]@{HolderPID=$p.Id;LauncherPID=$PID}|ConvertTo-Json -Compress;$p.Dispose()";
  const started=JSON.parse(windows(launch,JSON.stringify({Caller:caller,Input:JSON.stringify(input),Parent:parentChild,Transfer:transferChild,Holder:holder})));
  // The launching PowerShell invocation is terminal before this new reader.
  const reader="$p=[Console]::In.ReadToEnd()|ConvertFrom-Json;$deadline=[Diagnostics.Stopwatch]::StartNew();$file=$p.Caller+'\\qualification-holder-result.json';while(-not (Test-Path -LiteralPath $file) -and $deadline.ElapsedMilliseconds -lt 25000){Start-Sleep -Milliseconds 50};$result=Get-Content -LiteralPath $file -Raw|ConvertFrom-Json;$result|Add-Member -NotePropertyName LauncherStillPresent -NotePropertyValue ([bool](Get-Process -Id $p.Launcher -ErrorAction SilentlyContinue));$result|ConvertTo-Json -Depth 30 -Compress";
  evidence=JSON.parse(windows(reader,JSON.stringify({Caller:caller,Launcher:started.LauncherPID})));
  assert.equal(evidence.Success,true,JSON.stringify(evidence));assert.equal(evidence.HolderPID,started.HolderPID);assert.equal(evidence.LauncherStillPresent,false);assert.deepEqual(evidence.PortCalls,['parent.ps1','transfer.ps1']);assert.equal(evidence.DuplicateRefused,true);assert.equal(evidence.Receiving.priorFacts,'original-pre-offline-receiving');assert.equal(evidence.Receiving.applicationDrained,false);assert.equal(evidence.ParentTerminal.exit,0);assert.equal(evidence.TransferTerminal.exit,0);
  const n=conditionalFixture(f=>{f.p.windows.nativeCompaction.ownerSid=info.SID;f.p.windows.nativeCompaction.custodyDirectory=root+'\\negative';f.p.windows.nativeCompaction.reentry.continuation.parentDeadlineMs=10000}),nv=n.form(),nc=n.p.windows.nativeCompaction.custodyDirectory+'\\'+n.a.request+'.caller';prepareNativeCompactionFiles(nv.parameterText,nv.admissionText,n.resources);
  const negativeInput={...input,Root:n.p.windows.nativeCompaction.custodyDirectory,Caller:nc,Bundle:mutateJson(nv.bundle,'result.json',r=>r.Native.Exit=17),Packet:nv.render.packetText,Parameters:nv.parameterText,Admission:nv.admissionText,ParentSHA:nv.render.scriptSha256};
  const ns=JSON.parse(windows(launch,JSON.stringify({Caller:nc,Input:JSON.stringify(negativeInput),Parent:parentChild,Transfer:transferChild,Holder:holder}))),negative=JSON.parse(windows(reader,JSON.stringify({Caller:nc,Launcher:ns.LauncherPID})));
  assert.equal(negative.Success,false);assert.deepEqual(negative.PortCalls,['parent.ps1']);assert.equal(negative.DerivedCustodyPresent,false);assert.equal(negative.LauncherStillPresent,false);evidence.FailedNativeOutcomeRefusedBeforeDerivation=negative;
  const prior=JSON.parse(windows(helpers+"\n$t=[Console]::In.ReadToEnd()|ConvertFrom-Json;$root=$t.Root;$caller=$t.Caller;$rows=@();foreach($file in @('transfer-result.json','transfer.claim')){Remove-Item -LiteralPath ($caller+'\\'+$file);try{Receive-MaintenancePriorLaunches $root '33333333-3333-3333-3333-333333333333';$rows+=@{Accepted=$true}}catch{$rows+=@{Accepted=$false;Message=$_.Exception.Message}}};$rows|ConvertTo-Json -Compress",JSON.stringify({Root:root,Caller:caller})));for(const row of prior)assert.equal(row.Accepted,false);evidence.InterruptedConditionalRefusals=prior;
 }finally{windows("$p=[Console]::In.ReadToEnd();if(Test-Path -LiteralPath $p){Remove-Item -LiteralPath $p -Recurse -Force}",root)}
 mkdirSync(ownerSource+'/data/logs',{recursive:true});writeFileSync(ownerSource+'/data/logs/conditional-surviving-holder.qualification.json',JSON.stringify({fixtureOnly:true,nativeObservationPortsInjected:true,maintenanceEffectsExecuted:false,guestStarted:false,evidence,fixtureCustodyRemoved:true},null,2)+'\n',{mode:0o600});
});
