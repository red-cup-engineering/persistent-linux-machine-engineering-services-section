import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, lstatSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderNativeCompaction, nativeCompactionQualification } from './native-compaction.mjs';
import { validateBackingStorage } from './backing-capacity.mjs';

const roles=['authority','checkpoint','independent-receiving'];
export const nativeReceiverClosure=Object.freeze(['scripts/receive-native-compaction-outcome.mjs','src/native-maintenance-caller.mjs','src/native-compaction.mjs','src/backing-capacity.mjs','assets/native-compact.ps1','assets/native-compaction-outcome.ps1','assets/native-maintenance-caller.ps1','assets/observe-backing-capacity.ps1','assets/receive-backing-target.ps1']);
const files=['packet.json','parameters.json','admission.json','started.json','native-pid.json','result.json','stdout.bin','stderr.bin',...roles.map(r=>r+'.resource.json')];
export const maintenanceHash = bytes => createHash('sha256').update(bytes).digest('hex');
const json=(text,label='original JSON')=>{assert.equal(typeof text,'string',label);assert.ok(Buffer.byteLength(text)<=131072,label+' allocation');return JSON.parse(text)};
const text=bytes=>new TextDecoder('utf8',{fatal:true}).decode(bytes);
const decimal=x=>typeof x==='string'&&/^(0|[1-9][0-9]{0,23})$/.test(x);
const instant=x=>{assert.match(x??'',/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,7}Z$/);const t=Date.parse(x);assert.ok(Number.isFinite(t));return t};
const absolute=x=>typeof x==='string'&&x.startsWith('/')&&posix.normalize(x)===x&&!x.split('/').includes('..')&&!/[\x00-\x20"'\\]/.test(x);
const boundedFile=(path,limit=131072)=>{const s=lstatSync(path);assert.ok(s.isFile()&&!s.isSymbolicLink()&&s.size<=limit,'bounded unredirected file');assert.equal(realpathSync(path),path);return readFileSync(path)};

function context(parameterText,admissionText) {
 const rendering=renderNativeCompaction(parameterText,admissionText);
 const packet=JSON.parse(rendering.packetText), callerDirectory=packet.declaration.custodyDirectory+'\\'+packet.admission.request+'.caller';
 return {rendering,packet,callerDirectory};
}
const conditionalAlgorithm='wsl-native-complete-success-v1';
const conditionalMode='one-successful-outcome-transfer';
const exact=(value,keys,label)=>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value),label);assert.deepEqual(Object.keys(value).sort(),[...keys].sort(),label)};
const reference=value=>{exact(value,['path','sha256'],'original Resource reference');assert.ok(absolute(value.path)&&value.path.length<=1024&&/\/data\/(?:records|logs|state)\//.test(value.path),'canonical original owner-data Resource');assert.match(value.sha256??'',/^[a-f0-9]{64}$/)};
const actor=value=>assert.match(value??'',/^https:\/\/[^\s/]+\/actors\/[^\s/]+$/);
const invocation=c=>({executable:nativeCompactionQualification.executable,argv:['--distribution',c.packet.target.distributionName,'--user',c.packet.declaration.reentry.linuxUser,'--exec',c.packet.declaration.reentry.node,c.packet.declaration.reentry.receiver]});
/** Receive scope, not a grant. Original holders independently receive the
 * addressed authority/readiness/hold records before choosing actual launch. */
export function receiveConditionalCompactionScope(parameterText,admissionText,resources,{now=Date.now()}={}) {
 const c=context(parameterText,admissionText),d=c.packet.declaration.reentry,p=d?.continuation;
 validateReentryDeclaration(d);qualifyReceiver(d);
 exact(p,['mode','algorithm','templateSha256','expiresAt','reentryValidityMs','parentDeadlineMs'],'conditional declaration');
 assert.equal(p.mode,conditionalMode);assert.equal(p.algorithm,conditionalAlgorithm);
 assert.equal(p.templateSha256,maintenanceHash(readFileSync(new URL('../assets/native-maintenance-caller.ps1',import.meta.url))),'stable conditional template');
 assert.ok(Number.isSafeInteger(p.reentryValidityMs)&&p.reentryValidityMs>=1&&p.reentryValidityMs<=600000);
 assert.ok(Number.isSafeInteger(p.parentDeadlineMs)&&p.parentDeadlineMs>=c.packet.declaration.deadlineMs&&p.parentDeadlineMs<=3660000);
 const expires=instant(p.expiresAt);assert.ok(now<expires&&expires<=instant(c.packet.admission.expiresAt)+c.packet.declaration.deadlineMs+600000,'conditional authority lifetime');
 resourceBytes(c.packet.admission,resources,role=>c.callerDirectory+'\\'+role+'.resource.json');
 const parsed=Object.fromEntries(roles.map(role=>[role,json(resources[role],'conditional '+role)]));
 const a=parsed.authority,k=parsed.checkpoint,i=parsed['independent-receiving'];
 for(const [role,type] of [['authority','Authority'],['checkpoint','Checkpoint'],['independent-receiving','Receiving']]){const x=parsed[role];assert.equal(x.type,'WslNativeCompactionConditional'+type);assert.equal(x.version,1);assert.equal(x.request,c.packet.admission.request);assert.equal(x.parameterSha256,c.packet.parameterSha256)}
 exact(a,['type','version','request','parameterSha256','holder','expiresAt','scope'],'conditional authority');exact(a.holder,['actor','resource'],'original authority holder');actor(a.holder.actor);reference(a.holder.resource);
 assert.equal(a.expiresAt,p.expiresAt);assert.deepEqual(a.scope,{mode:conditionalMode,ownerSid:c.packet.declaration.ownerSid,target:c.packet.target,invocation:invocation(c),receiverClosure:d.receiverClosure,transferLimit:1});
 exact(k,['type','version','request','parameterSha256','authoritySha256','checkpoint','holds','affectedWork','readiness','unknowns'],'conditional checkpoint');assert.equal(k.authoritySha256,maintenanceHash(resources.authority));reference(k.checkpoint);
 assert.equal(k.holds?.length,4);assert.deepEqual(k.holds.map(x=>x.role).sort(),['composer','host-ingress','host-main','selector']);for(const h of k.holds){exact(h,['role','resource','state'],'original hold receiving');reference(h.resource);assert.equal(h.state,h.role==='selector'?'boot-held':'held-and-terminal')}
 assert.ok(Array.isArray(k.affectedWork)&&k.affectedWork.length>0&&k.affectedWork.length<=64);k.affectedWork.forEach(reference);
 exact(k.readiness,['actor','answer','resource'],'actual other-work readiness');actor(k.readiness.actor);reference(k.readiness.resource);assert.equal(k.readiness.answer,'ready-for-selected-offline-maintenance');assert.ok(Array.isArray(k.unknowns)&&k.unknowns.length<=64&&k.unknowns.every(x=>typeof x==='string'&&x.length>0&&x.length<=2048));
 exact(i,['type','version','request','parameterSha256','authoritySha256','checkpointSha256','algorithm','templateSha256','receiverClosure','receiver'],'conditional independent receiving');assert.equal(i.authoritySha256,maintenanceHash(resources.authority));assert.equal(i.checkpointSha256,maintenanceHash(resources.checkpoint));assert.equal(i.algorithm,p.algorithm);assert.equal(i.templateSha256,p.templateSha256);assert.deepEqual(i.receiverClosure,d.receiverClosure);exact(i.receiver,['actor','resource'],'original independent receiver');actor(i.receiver.actor);reference(i.receiver.resource);
 return {context:c,policy:p,prior:parsed};
}
function conditionalDerived(c,received,resources,notBefore,expiresAt) {
 return Object.fromEntries(roles.map(role=>[role,{type:'WslNativeCompactionDerivedReentryResource',version:1,role,request:received.request,parameterSha256:received.parameterSha256,maintenanceAdmissionSha256:received.admissionSha256,outcomeSha256:received.outcomeSha256,
 originalResource:c.packet.admission.resources.find(x=>x.role===role),priorResourceSha256:Object.fromEntries(roles.map(r=>[r,maintenanceHash(resources[r])])),algorithm:conditionalAlgorithm,observedAt:notBefore,expiresAt,
 invocation:invocation(c),receiverClosure:c.packet.declaration.reentry.receiverClosure,capacityReopened:false,holdsReleased:false,chatResumed:false,applicationDrained:false}]));
}
export function deriveConditionalCompactionReentry(parameterText,admissionText,bundle,{now=Date.now()}={}) {
 const original=Object.fromEntries(roles.map(role=>[role,text(Buffer.from(bundle[role+'.resource.json'],'base64'))]));
 const {context:c,policy}=receiveConditionalCompactionScope(parameterText,admissionText,original,{now});
 const received=receiveNativeCompactionOutcome(parameterText,admissionText,bundle,{now});
 const notBefore=new Date(now).toISOString(),expiresAt=new Date(Math.min(now+policy.reentryValidityMs,instant(policy.expiresAt))).toISOString();
 assert.ok(instant(expiresAt)>now);const derived=conditionalDerived(c,received,original,notBefore,expiresAt),resources=Object.fromEntries(roles.map(role=>[role,JSON.stringify(derived[role])]));
 const reentry={type:'WslNativeCompactionReentryAdmission',version:1,request:received.request,outcomeSha256:received.outcomeSha256,parameterSha256:received.parameterSha256,maintenanceAdmissionSha256:received.admissionSha256,notBefore,expiresAt,invocation:invocation(c),resources:roles.map(role=>({role,path:c.callerDirectory+'\\reentry-'+role+'.resource.json',sha256:maintenanceHash(resources[role])}))};
 return {reentryText:JSON.stringify(reentry),resources,receiving:{type:'WslNativeCompactionConditionalOutcomeReceiving',version:1,request:received.request,outcomeSha256:received.outcomeSha256,algorithm:conditionalAlgorithm,observedAt:notBefore,priorResourceSha256:derived.authority.priorResourceSha256,priorFacts:'original-pre-offline-receiving',capacityReopened:false,holdsReleased:false,chatResumed:false,applicationDrained:false}};
}
function resourceBytes(admission,resources,expectedPaths) {
 assert.ok(resources&&typeof resources==='object'&&!Array.isArray(resources));assert.deepEqual(Object.keys(resources).sort(),[...roles].sort());
 const result={};for(const role of roles){const r=admission.resources.find(r=>r.role===role);assert.equal(r.path,expectedPaths(role),'carrier Resource path');const raw=Buffer.from(resources[role],'utf8');assert.ok(raw.length<=131072);assert.equal(maintenanceHash(raw),r.sha256,'original Resource digest');result[role]=raw.toString('base64')}
 return result;
}
function script(action,payload) {
 payload={...payload,templateSha256:maintenanceHash(readFileSync(new URL('../assets/native-maintenance-caller.ps1',import.meta.url)))};
 const encoded=Buffer.from(JSON.stringify({...payload,action})).toString('base64');
 return "$ProgressPreference='SilentlyContinue'\n$ErrorActionPreference='Stop'\n$inputPacket=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+encoded+"'))|ConvertFrom-Json\n"+
 readFileSync(new URL('../assets/receive-backing-target.ps1',import.meta.url),'utf8')+'\n'+readFileSync(new URL('../assets/native-compaction-outcome.ps1',import.meta.url),'utf8')+'\n'+readFileSync(new URL('../assets/native-maintenance-caller.ps1',import.meta.url),'utf8');
}
function invoke(parameterText,source,{run=execFileSync,awaitTerminal=false}={}) {
 const p=json(parameterText);const executable=p.windows.backingStorage.powershell;
 const loader="$ErrorActionPreference='Stop';$s=[Text.UTF8Encoding]::new($false,$true).GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));Invoke-Expression $s";
 const output=run(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(loader,'utf16le').toString('base64')],{input:Buffer.from(source).toString('base64'),cwd:'/',encoding:'utf8',timeout:awaitTerminal?0:30000,maxBuffer:4*1024*1024});
 return JSON.parse(output);
}
/** Current native identity only. No admission, hold, custody preparation,
 * lifecycle operation, compaction or guest reentry follows from this read. */
export function observeNativeCompactionPrerequisites(parameterText,ports) {
 const target=validateBackingStorage(json(parameterText,'original host parameters'));
 assert.ok(/^[A-Za-z]:\\/.test(target.basePath),'native Windows backing path required');
 const source=readFileSync(new URL('../assets/observe-backing-capacity.ps1',import.meta.url),'utf8');
 const packet={target,qualification:nativeCompactionQualification,backingObservation:{source,sourceSha256:maintenanceHash(source)}};
 const encoded=Buffer.from(JSON.stringify(packet)).toString('base64');
 const script="$ProgressPreference='SilentlyContinue'\n$ErrorActionPreference='Stop'\n$selected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+encoded+"'))|ConvertFrom-Json\n"+
 readFileSync(new URL('../assets/receive-backing-target.ps1',import.meta.url),'utf8')+`\n
$holder=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
Receive-MaintenanceNativePath ([IO.Path]::Combine($selected.target.basePath,$selected.target.vhdFileName))
$target=Receive-MaintenanceBackingTarget $selected
$providers=@();$qualified=$true
foreach($expected in @(@{role='executable';path=$selected.qualification.executable;sha256=$selected.qualification.executableSha256},@{role='service';path=$selected.qualification.service;sha256=$selected.qualification.serviceSha256})) {
 Receive-MaintenanceNativePath $expected.path
 $file=Get-Item -LiteralPath $expected.path -Force
 if($file.PSIsContainer){throw 'Native provider is not a file'}
 $actual=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
 $providerReceived=$actual -ceq $expected.sha256 -and $file.VersionInfo.ProductVersion -ceq $selected.qualification.version
 $qualified=$qualified -and $providerReceived
 $providers+=@{role=$expected.role;path=$file.FullName;version=$file.VersionInfo.ProductVersion;sha256=$actual;qualified=$providerReceived}
}
@{type='WslNativeCompactionPrerequisites';version=1;ownerSid=$holder;target=$target;providers=$providers;qualified=$qualified;effectsExecuted=$false;capacityReopened=$false}|ConvertTo-Json -Depth 10 -Compress`;
 const observation=invoke(parameterText,script,ports);
 assert.equal(observation.type,'WslNativeCompactionPrerequisites');assert.equal(observation.version,1);
 assert.match(observation.ownerSid??'',/^S-1-5-21-\d+-\d+-\d+-\d+$/);
 assert.equal(observation.effectsExecuted,false);assert.equal(observation.capacityReopened,false);
 assert.equal(typeof observation.qualified,'boolean');
 return {...observation,parameterSha256:maintenanceHash(parameterText),backingSourceSha256:packet.backingObservation.sourceSha256};
}
export function renderNativeCompactionFilePreparation(parameterText,admissionText,resources) {
 const c=context(parameterText,admissionText);
 if(c.packet.declaration.reentry?.continuation)receiveConditionalCompactionScope(parameterText,admissionText,resources);
 const resourceData=resourceBytes(c.packet.admission,resources,role=>c.callerDirectory+'\\'+role+'.resource.json');
 const base={parameterText,admissionText,packetText:c.rendering.packetText,parentSha256:c.rendering.scriptSha256,callerDirectory:c.callerDirectory};
 const payload={...base,parent:c.rendering.script,parentSha256:c.rendering.scriptSha256,resources:resourceData,reader:script('read',base),reentryPreparer:script('prepare-reentry',base),transfer:script('transfer',base),continuation:c.packet.declaration.reentry?.continuation?script('continue',base):null};
 return {script:script('prepare',payload),scriptSha256:maintenanceHash(script('prepare',payload)),parentSha256:c.rendering.scriptSha256,callerDirectory:c.callerDirectory,effectsExecuted:false};
}
export function prepareNativeCompactionFiles(parameterText,admissionText,resources,ports) {
 if(context(parameterText,admissionText).packet.declaration.reentry?.continuation){const {prior}=receiveConditionalCompactionScope(parameterText,admissionText,resources);const refs=[prior.authority.holder.resource,prior.checkpoint.checkpoint,...prior.checkpoint.holds.map(x=>x.resource),...prior.checkpoint.affectedWork,prior.checkpoint.readiness.resource,prior['independent-receiving'].receiver.resource];let total=0;for(const r of refs){const bytes=boundedFile(r.path);total+=bytes.length;assert.ok(total<=2097152,'bounded original prior receiving');const s=lstatSync(r.path);assert.ok(s.uid===process.getuid()&&(s.mode&0o022)===0,'original prior record owner');assert.equal(maintenanceHash(bytes),r.sha256,'actual original prior Resource changed')}}
 return invoke(parameterText,renderNativeCompactionFilePreparation(parameterText,admissionText,resources).script,ports);
}
function custodyDeclaration(parameterText){
 const p=json(parameterText),d=p.windows?.nativeCompaction,c=d?.custodyPreparation;
 exact(c,['existingParent','components'],'declared custody hierarchy');assert.match(d.ownerSid??'',/^S-1-5-21-\d+-\d+-\d+-\d+$/);
 assert.equal(typeof c.existingParent,'string');assert.match(c.existingParent,/^[A-Za-z]:\\[A-Za-z0-9 ._{}()@+\\-]+$/);assert.equal(win32.normalize(c.existingParent),c.existingParent);assert.ok(!c.existingParent.split('\\').some(x=>x==='.'||x==='..'||/[. ]$/.test(x)));
 assert.ok(Array.isArray(c.components)&&c.components.length>=1&&c.components.length<=8);for(const name of c.components)assert.match(name,/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/);assert.ok(c.components.every(x=>!/[.]$/.test(x)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.]|$)/i.test(x)));
 assert.equal(win32.join(c.existingParent,...c.components),d.custodyDirectory,'exact declared custody join');return c;
}
export function observeNativeCompactionCustody(parameterText,ports){custodyDeclaration(parameterText);return invoke(parameterText,script('observe-custody',{parameterText}),ports)}
export function prepareNativeCompactionCustody(parameterText,receivingText,ports){custodyDeclaration(parameterText);const r=json(receivingText,'original custody parent receiving');exact(r,['type','version','parent','parameterSha256','custodyDirectory','templateSha256','receiver'],'original custody receiving');assert.equal(r.type,'WslNativeCompactionCustodyParentReceiving');assert.equal(r.version,1);assert.equal(r.parameterSha256,maintenanceHash(parameterText));assert.equal(r.custodyDirectory,json(parameterText).windows.nativeCompaction.custodyDirectory);assert.equal(r.templateSha256,maintenanceHash(readFileSync(new URL('../assets/native-maintenance-caller.ps1',import.meta.url))));exact(r.receiver,['actor','resource'],'custody independent receiver');actor(r.receiver.actor);reference(r.receiver.resource);return invoke(parameterText,script('prepare-custody',{parameterText,receivingText}),ports)}
export function launchNativeCompactionFile(parameterText,admissionText,reviewText,ports) {
 const c=context(parameterText,admissionText),review=json(reviewText,'independent exact-file receiving');
 assert.equal(review.type,'WslNativeCompactionFileReceiving');assert.equal(review.request,c.packet.admission.request);assert.equal(review.parentSha256,c.rendering.scriptSha256);assert.equal(review.admissionSha256,c.rendering.admissionSha256);
 if(c.packet.declaration.reentry?.continuation)assert.equal(review.continuationSha256,maintenanceHash(script('continue',{parameterText,admissionText,packetText:c.rendering.packetText,parentSha256:c.rendering.scriptSha256,callerDirectory:c.callerDirectory})),'independent actual conditional file receiving');
 // Original authority/checkpoints remain the admitted Resource bytes. This
 // additional exact-file receiving is a correlation input, never a grant.
 return invoke(parameterText,script('launch',{parameterText,admissionText,packetText:c.rendering.packetText,parentSha256:c.rendering.scriptSha256,callerDirectory:c.callerDirectory,reviewText}),ports);
}
export function receiveNativeCompactionOutcome(parameterText,admissionText,bundle,{now=Date.now()}={}) {
 const c=context(parameterText,admissionText);assert.ok(bundle&&typeof bundle==='object');assert.deepEqual(Object.keys(bundle).sort(),[...files].sort());
 let total=0;const raw={};for(const name of files){assert.equal(typeof bundle[name],'string');assert.ok(bundle[name].length<=(name==='packet.json'?1398104:174764),'encoded custody allocation');assert.match(bundle[name],/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);raw[name]=Buffer.from(bundle[name],'base64');total+=raw[name].length;assert.ok(raw[name].length<=(name==='packet.json'?1048576:131072)&&total<=2097152,'custody allocation')}
 assert.equal(text(raw['packet.json']),c.rendering.packetText,'exact original packet');assert.equal(text(raw['parameters.json']),parameterText);assert.equal(text(raw['admission.json']),admissionText);
 for(const r of c.packet.admission.resources)assert.equal(maintenanceHash(raw[r.role+'.resource.json']),r.sha256,'original Resource bytes');
 const intent=json(text(raw['started.json'])),pid=json(text(raw['native-pid.json'])),result=json(text(raw['result.json']));const n=result.Native,a=c.packet.admission;
 assert.equal(intent.Type,'WslNativeCompactionIntent');assert.equal(intent.Request,a.request);assert.equal(intent.AdmissionSHA256,c.rendering.admissionSha256);assert.equal(intent.WindowsOwnerSID,c.packet.declaration.ownerSid);assert.ok(Number.isSafeInteger(intent.WindowsParentPID)&&intent.WindowsParentPID>0);assert.deepEqual(intent.Invocation,c.packet.invocation);
 assert.equal(result.Type,'WslNativeCompactionOutcome');assert.equal(result.Status,'terminal-confirmed');assert.equal(result.Request,a.request);assert.equal(result.AdmissionSHA256,c.rendering.admissionSha256);assert.equal(result.Success,true);assert.equal(result.CapacityReopened,false);assert.equal(result.GuestReentryAdmitted,false);
 assert.ok(Number.isSafeInteger(n?.Pid)&&n.Pid>0);assert.equal(pid.pid,n.Pid);assert.equal(pid.startedAt,n.StartedAt);assert.equal(n.Exit,0);assert.equal(n.WithinDeadline,true);assert.equal(n.PidError,null);
 const start=instant(n.StartedAt),terminal=instant(n.TerminalAt),intentAt=instant(intent.At),at=instant(result.At);
 assert.ok(intentAt>=instant(a.notBefore)&&start>=intentAt&&start<instant(a.expiresAt)&&terminal>=start&&terminal-start<=c.packet.declaration.deadlineMs&&at>=terminal&&at<=now,'native elapsed deadline/clock');
 const targetPath=win32.join(c.packet.target.basePath,c.packet.target.vhdFileName);
 for(const observation of [intent.Before,result.Before,result.After]){assert.equal(observation?.Path?.toLowerCase(),targetPath.toLowerCase());assert.equal(observation.Volume?.toLowerCase(),c.packet.target.volumeId.toLowerCase());assert.match(observation.FileIdentity??'',/^[a-f0-9]{8}:[a-f0-9]{16}$/);assert.equal(observation.FileIdentity,intent.Before.FileIdentity);for(const field of ['LengthBytes','VolumeFreeBytes','CallerAvailableBytes'])assert.ok(decimal(observation[field]))}
 assert.deepEqual(result.Before,intent.Before);
 for(const [key,name] of [['Stdout','stdout.bin'],['Stderr','stderr.bin']]){const s=n[key];assert.equal(s?.Overflow,false);assert.equal(s.Error,null);assert.ok(Number.isSafeInteger(s.TotalBytes)&&s.TotalBytes>=0&&s.TotalBytes<=c.packet.declaration.maxOutputBytes);assert.equal(s.TotalBytes,raw[name].length)}
 return {type:'WslNativeCompactionOutcomeReceiving',request:a.request,outcomeSha256:maintenanceHash(raw['result.json']),parameterSha256:c.rendering.parameterSha256,admissionSha256:c.rendering.admissionSha256,result,effectsExecuted:false,guestReentryAdmitted:false,capacityReopened:false};
}
export function readNativeCompactionOutcome(parameterText,admissionText,ports) {
 const c=context(parameterText,admissionText);const bundle=invoke(parameterText,script('read',{parameterText,admissionText,packetText:c.rendering.packetText,parentSha256:c.rendering.scriptSha256,callerDirectory:c.callerDirectory}),ports);
 return {bundle,receiving:receiveNativeCompactionOutcome(parameterText,admissionText,bundle)};
}
function reentryContext(parameterText,admissionText,bundle,reentryText,resources) {
 const c=context(parameterText,admissionText),received=receiveNativeCompactionOutcome(parameterText,admissionText,bundle),r=json(reentryText,'reentry admission'),d=c.packet.declaration.reentry;
 validateReentryDeclaration(d);
 assert.equal(r.type,'WslNativeCompactionReentryAdmission');assert.equal(r.version,1);assert.equal(r.request,received.request);assert.equal(r.outcomeSha256,received.outcomeSha256);assert.equal(r.parameterSha256,received.parameterSha256);assert.equal(r.maintenanceAdmissionSha256,received.admissionSha256);assert.deepEqual(r.invocation,invocation(c));
 const before=instant(r.notBefore),expires=instant(r.expiresAt);assert.ok(expires>before&&expires-before<=600000&&Date.now()>=before&&Date.now()<expires,'fresh reentry admission');
 assert.equal(r.resources?.length,3);assert.deepEqual(r.resources.map(x=>x.role).sort(),[...roles].sort());
 const resourceData=resourceBytes(r,resources,role=>c.callerDirectory+'\\reentry-'+role+'.resource.json');
 if(d.continuation){const original=Object.fromEntries(roles.map(role=>[role,text(Buffer.from(bundle[role+'.resource.json'],'base64'))]));const scope=receiveConditionalCompactionScope(parameterText,admissionText,original);assert.ok(expires<=instant(scope.policy.expiresAt)&&expires-before<=scope.policy.reentryValidityMs&&before>=instant(received.result.At),'conditional post-outcome receiving interval');const expected=conditionalDerived(c,received,original,r.notBefore,r.expiresAt);for(const role of roles)assert.deepEqual(json(resources[role]),expected[role],'actual conditional derivation '+role)}
 return {...c,received,reentry:r,declaration:d,resourceData};
}
function validateReentryDeclaration(d){
 assert.ok(d,'explicit reentry declaration required');assert.match(d.linuxUser??'',/^[a-z_][a-z0-9_-]{0,31}$/);for(const field of ['node','receiver','outputDirectory','sectionRoot'])assert.ok(absolute(d[field]),'canonical Linux '+field);
 assert.match(d.node,/^\/gnu\/store\/[a-z0-9]+-node-[0-9.]+\/bin\/node$/);assert.equal(posix.basename(d.receiver),'receive-native-compaction-outcome.mjs');assert.match(d.receiverSha256??'',/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(d.ownerUid)&&d.ownerUid>=1000);assert.ok(d.outputDirectory.startsWith(d.sectionRoot+'/data/logs/'),'declared owner-data output');
 assert.deepEqual(Object.keys(d.receiverClosure??{}).sort(),[...nativeReceiverClosure].sort(),'exact original receiver closure');for(const value of Object.values(d.receiverClosure))assert.match(value,/^[a-f0-9]{64}$/);assert.equal(d.receiverSha256,d.receiverClosure[nativeReceiverClosure[0]]);
}
function qualifyReceiver(declaration) {
 const root=posix.dirname(posix.dirname(declaration.receiver));
 for(const relative of nativeReceiverClosure)assert.equal(maintenanceHash(boundedFile(root+'/'+relative,1048576)),declaration.receiverClosure[relative],'original receiver closure changed: '+relative);
}
export function transferNativeCompactionOutcome(parameterText,admissionText,bundle,reentryText,resources,ports) {
 const c=reentryContext(parameterText,admissionText,bundle,reentryText,resources);
 // Verify the exact installed guest receiver while the original guest caller
 // is available; the receiver repeats its own hash/uid/custody before writes.
 qualifyReceiver(c.declaration);
 const payload=formNativeCompactionOutcomeTransfer(parameterText,admissionText,bundle,reentryText,resources);
 // Transfer is normally run through the prepared Windows transfer.ps1 after
 // offline outcome receiving. This port never kills an in-flight guest child.
 return invoke(parameterText,script('transfer',{...payload,packetText:c.rendering.packetText,parentSha256:c.rendering.scriptSha256,callerDirectory:c.callerDirectory,resourceData:c.resourceData,payload:JSON.stringify(payload)}),{...ports,awaitTerminal:true});
}
export function formNativeCompactionOutcomeTransfer(parameterText,admissionText,bundle,reentryText,resources) {
 const c=reentryContext(parameterText,admissionText,bundle,reentryText,resources),custody={...bundle};
 // Three repeated exact texts are represented once, with the original packet
 // digest. Both sides derive them through the original renderer, never through
 // an alternate packet parser or a status-only assertion.
 for(const name of ['packet.json','parameters.json','admission.json'])delete custody[name];
 const payload={type:'WslNativeCompactionOutcomeTransfer',version:1,parameterText,admissionText,packetSha256:maintenanceHash(c.rendering.packetText),custody,reentryText,resources,receiverSha256:c.declaration.receiverSha256};
 assert.ok(Buffer.byteLength(JSON.stringify(payload))<=131072,'bounded modern outcome stdin');return payload;
}
export function prepareNativeCompactionReentry(parameterText,admissionText,bundle,reentryText,resources,ports) {
 const c=reentryContext(parameterText,admissionText,bundle,reentryText,resources);
 qualifyReceiver(c.declaration);
 return invoke(parameterText,script('prepare-reentry',{parameterText,admissionText,packetText:c.rendering.packetText,parentSha256:c.rendering.scriptSha256,callerDirectory:c.callerDirectory,reentryText,resources}),ports);
}
export function persistNativeCompactionOutcome(payloadText,{uid=process.getuid(),receiverPath=fileURLToPath(new URL('../scripts/receive-native-compaction-outcome.mjs',import.meta.url))}={}) {
 const payload=json(payloadText,'bounded modern outcome stdin');assert.equal(payload.type,'WslNativeCompactionOutcomeTransfer');assert.equal(payload.version,1);
 const original=context(payload.parameterText,payload.admissionText);assert.equal(payload.packetSha256,maintenanceHash(original.rendering.packetText));
 assert.deepEqual(Object.keys(payload.custody).sort(),files.filter(name=>!['packet.json','parameters.json','admission.json'].includes(name)).sort());
 const bundle={...payload.custody,'packet.json':Buffer.from(original.rendering.packetText).toString('base64'),'parameters.json':Buffer.from(payload.parameterText).toString('base64'),'admission.json':Buffer.from(payload.admissionText).toString('base64')};
 const c=reentryContext(payload.parameterText,payload.admissionText,bundle,payload.reentryText,payload.resources),d=c.declaration;
 assert.equal(uid,d.ownerUid,'guest receiver UID');assert.equal(d.receiver,receiverPath);assert.equal(maintenanceHash(boundedFile(receiverPath)),d.receiverSha256);assert.equal(payload.receiverSha256,d.receiverSha256);
 qualifyReceiver(d);
 for(const path of [d.sectionRoot,d.outputDirectory]){assert.equal(realpathSync(path),path);const s=lstatSync(path);assert.ok(s.isDirectory()&&s.uid===uid&&(s.mode&0o022)===0,'private canonical owner-data custody')}
 const output=d.outputDirectory+'/'+c.received.request+'.windows-outcome.json';const fd=openSync(output,'wx',0o600);try{writeFileSync(fd,payloadText);fsyncSync(fd)}finally{closeSync(fd)}
 const directory=openSync(d.outputDirectory,'r');try{fsyncSync(directory)}finally{closeSync(directory)}
 return {type:'WslNativeCompactionOutcomePersisted',request:c.received.request,outcomeSha256:c.received.outcomeSha256,path:output,capacityReopened:false,holdsReleased:false,chatResumed:false};
}
