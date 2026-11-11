#!/usr/bin/env node
// The existing release lease receives finite semantic conversions. Original
// trees are never copied into active custody; exact fabricated tools select it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {StringDecoder} from 'node:string_decoder';
import {fileURLToPath,pathToFileURL} from 'node:url';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const HASH=/^[a-f0-9]{64}$/u,COMMIT=/^[a-f0-9]{40}$/u;
function unlinked(file){
 const absolute=path.resolve(file);
 for(let p=absolute;;p=path.dirname(p)){
  if(fs.existsSync(p))assert.ok(!fs.lstatSync(p).isSymbolicLink(),'custody ancestor is linked');
  if(p===path.dirname(p))break;
 }
 return absolute;
}
function ownedDirectory(directory,{privateMode=false}={}){
 unlinked(directory);const st=fs.lstatSync(directory);
 assert.ok(st.isDirectory()&&st.uid===process.getuid(),'custody directory is not owned');
 if(privateMode)assert.equal(st.mode&0o077,0,'custody carrier is not private');
 return directory;
}
function relative(root,child){
 assert.ok(typeof child==='string'&&child.length>0&&!path.isAbsolute(child));
 const result=path.resolve(root,child);
 assert.ok(result.startsWith(path.resolve(root)+path.sep),'custody path escapes its owner');
 return result;
}
function immutable(file){
 const actual=fs.realpathSync(file);assert.ok(actual.startsWith('/gnu/store/'),'provider is not an immutable Guix input');return actual;
}
function stamp(file){const st=fs.lstatSync(file);assert.ok(!st.isSymbolicLink()&&st.uid===process.getuid(),'original selection is linked or foreign');return [st.dev,st.ino,st.size,st.mtimeMs,st.ctimeMs];}
function* files(root,depth=0){
 assert.ok(depth<=64,'custody depth exceeds its native bound');
 if(!fs.existsSync(root))return;
 const st=fs.lstatSync(root);assert.ok(!st.isSymbolicLink(),'custody entry is linked');
 if(st.isFile()){yield root;return;}
 assert.ok(st.isDirectory(),'custody entry is not ordinary');
 for(const name of fs.readdirSync(root).sort())yield* files(path.join(root,name),depth+1);
}
function streamHash(file){
 const before=fs.lstatSync(file);assert.ok(before.isFile()&&!before.isSymbolicLink(),'custody file is not ordinary');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),hash=createHash('sha256'),buffer=Buffer.alloc(65536);
 try{let n,total=0;while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0){hash.update(buffer.subarray(0,n));total+=n;}
  const after=fs.fstatSync(fd);assert.ok(total===before.size&&after.ino===before.ino&&after.mtimeMs===before.mtimeMs&&after.ctimeMs===before.ctimeMs,'custody file changed while receiving');
  return {sha256:hash.digest('hex'),bytes:total};
 }finally{fs.closeSync(fd);}
}
// Only native output is digested in full. There is no wholesale source copy,
// source-history size cap or in-memory payload table. Reads stay 64 KiB bounded.
export function custodyDigest(root){
 ownedDirectory(root,{privateMode:true});const hash=createHash('sha256');let count=0,bytes=0;
 for(const file of files(root)){const st=fs.lstatSync(file);assert.equal(st.uid,process.getuid());const body=streamHash(file);count++;bytes+=body.bytes;
  hash.update(JSON.stringify([path.relative(root,file),st.mode&0o777,body.bytes,body.sha256])+'\n');}
 return {sha256:hash.digest('hex'),files:count,bytes};
}
function retainReceipt(file,receipt){
 ownedDirectory(path.dirname(file),{privateMode:true});const tmp=file+'.next-'+randomUUID();
 fs.writeFileSync(tmp,JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});const fd=fs.openSync(tmp,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.renameSync(tmp,file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
}
function specOf(config){
 const spec=config.custodyTransition;assert.ok(spec&&Array.isArray(spec.bindings)&&spec.bindings.length>0&&spec.bindings.length<=16,'finite semantic bindings required');
 assert.ok(Array.isArray(spec.writerUnits)&&spec.writerUnits.includes(config.unit),'serving writer absent from custody lease');
 assert.equal(config.stateCompatibility,'preserve-existing');
 const names=new Set(),targets=[],clockRoots=[];
 for(const binding of spec.bindings){
  assert.ok(/^[a-z][a-z0-9-]{0,63}$/u.test(binding.name)&&!names.has(binding.name),'binding identity is not unique');names.add(binding.name);
  assert.ok(['world','activitypub','kalshi'].includes(binding.conversion),'unadmitted conversion meaning');
  assert.ok(path.isAbsolute(binding.source)&&path.isAbsolute(binding.target),'custody binding must be absolute');
  const source=unlinked(binding.source),target=unlinked(binding.target);ownedDirectory(source);
  assert.ok(source===target||(!source.startsWith(target+path.sep)&&!target.startsWith(source+path.sep)),'source/output custody overlaps');
  assert.ok(!targets.some(prior=>target===prior||target.startsWith(prior+path.sep)||prior.startsWith(target+path.sep)),'active bindings overlap');targets.push(target);
  assert.ok(binding.sourceOnlyDisposition==='original-only','uncertain originals need explicit non-active custody');
  if(binding.clockLastSource!==undefined){
   assert.equal(binding.conversion,'world','auxiliary schedule history requires world conversion');
   assert.ok(typeof binding.clockLastSource==='string'&&path.isAbsolute(binding.clockLastSource),'schedule history source must be absolute');
   const clock=unlinked(binding.clockLastSource);ownedDirectory(clock);
   assert.equal(fs.statSync(clock).dev,fs.statSync(source).dev,'schedule history is not on original custody volume');clockRoots.push(clock);
  }
 }
 for(const clock of clockRoots)assert.ok(!targets.some(target=>clock===target||clock.startsWith(target+path.sep)||target.startsWith(clock+path.sep)),'auxiliary original schedule history overlaps active output');
 return spec;
}
function observationRoots(binding){
 const roots=binding.conversion==='kalshi'?['weather-desk','weather','sources','catalog/data/logs']:binding.conversion==='activitypub'?['data/journals','data/logs','bodies']:['data/journals','data/logs','data/state/clock/last'];
 return roots.map(part=>part==='data/state/clock/last'&&binding.clockLastSource!==undefined?binding.clockLastSource:path.join(binding.source,part)).concat(binding.queue?[binding.queue]:[]);
}
function* observeSelection(binding){
 function* visit(file,depth=0){
  assert.ok(depth<=64,'source selection depth exceeds bound');if(!fs.existsSync(file)){yield {file,absent:true};return;}
  const st=fs.lstatSync(file);yield {file,stamp:stamp(file)};
  if(st.isDirectory())for(const name of fs.readdirSync(file).sort())yield* visit(path.join(file,name),depth+1);else assert.ok(st.isFile(),'source selection is not ordinary');
 }
 for(const root of observationRoots(binding))yield* visit(root);
}
function* selectionRows(file){
 const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(65536),decoder=new StringDecoder('utf8');let pending='';
 try{let count;while((count=fs.readSync(fd,buffer,0,buffer.length,null))>0){pending+=decoder.write(buffer.subarray(0,count));let at;while((at=pending.indexOf('\n'))>=0){const row=pending.slice(0,at);pending=pending.slice(at+1);if(row)yield JSON.parse(row);}assert.ok(Buffer.byteLength(pending)<=16384,'selection metadata line exceeds bound');}pending+=decoder.end();assert.equal(pending,'');}finally{fs.closeSync(fd);}
}
function assertSelection(selectionFile,{from=null,to=null}={}){
 for(const item of selectionRows(selectionFile)){const mapping=[...(Array.isArray(from)?from:from?[{from,to}]:[])].find(map=>item.file===map.from||item.file.startsWith(map.from+path.sep));const file=mapping?mapping.to+item.file.slice(mapping.from.length):item.file;
  if(item.absent)assert.ok(!fs.existsSync(file),'original selection appeared during receiving');
  else {const actual=stamp(file);assert.deepEqual(mapping&&item.file===mapping.from?actual.slice(0,4):actual,mapping&&item.file===mapping.from?item.stamp.slice(0,4):item.stamp,'original selected custody changed');}}
}
function providerInput(declaration,originalArtifacts){
 assert.ok(declaration&&typeof declaration.directory==='string'&&typeof declaration.repository==='string'&&COMMIT.test(declaration.commit),'provider lacks exact source identity');
 const directory=immutable(declaration.directory);
 const proof=declaration.sourceReceipt;assert.ok(proof&&HASH.test(proof.sha256)&&typeof proof.name==='string','original provider needs authenticated source receipt');
 const proofFile=immutable(proof.file);assert.ok(originalArtifacts.some(root=>directory.startsWith(root+path.sep)&&proofFile.startsWith(root+path.sep)),'original provider is not retained by the one-time controller derivation');assert.equal(streamHash(proofFile).sha256,proof.sha256);
 const source=JSON.parse(fs.readFileSync(proofFile,'utf8')).packages.filter(row=>row.name===proof.name);assert.equal(source.length,1);assert.equal(source[0].repository,declaration.repository);assert.equal(source[0].commit,declaration.commit);
 const expectedDirectory=path.join(path.dirname(path.dirname(proofFile)),'packages',proof.name.replaceAll('/','__'));assert.equal(directory,fs.realpathSync(expectedDirectory),'provider directory differs from original artifact receipt');
 assert.ok(Array.isArray(declaration.files)&&declaration.files.length>0&&declaration.files.length<=16,'provider lacks finite exact files');
 for(const file of declaration.files){assert.ok(HASH.test(file.sha256));assert.equal(streamHash(relative(directory,file.path)).sha256,file.sha256,'provider bytes differ from admitted source');}
 return directory;
}
function conversionTool(spec,store){
 const root=immutable(path.join(store,'.custody-tool')),receipt=JSON.parse(fs.readFileSync(path.join(root,'source.json'),'utf8'));
 assert.equal(receipt.type,'OneTimeCustodyToolSource');assert.equal(receipt.repository,spec.tool.repository);assert.equal(receipt.commit,spec.tool.commit);
 assert.ok(COMMIT.test(receipt.commit)&&HASH.test(spec.tool.receiptSha256));assert.equal(streamHash(path.join(root,'source.json')).sha256,spec.tool.receiptSha256);
 assert.ok(Array.isArray(receipt.files)&&receipt.files.length>0&&receipt.files.length<=8);
 for(const file of receipt.files)assert.equal(streamHash(relative(root,file.path)).sha256,file.sha256);
 const originals=fs.readdirSync(path.join(root,'original-inputs')).map(name=>immutable(path.join(root,'original-inputs',name)));assert.ok(originals.length>0&&originals.length<=4);return {program:relative(root,'scripts/convert-settlement.mjs'),originals};
}
async function receiveNative(directory,currentStore,report){
 const native=await import(pathToFileURL(path.join(currentStore,'src/store.mjs')).href),require=createRequire(path.join(currentStore,'package.json'));
 const {semanticAddress}=await import(pathToFileURL(require.resolve('@red-cup-engineering/computer-content-address-engineering-services-section/semiotic-content-address')).href);
 for(const [type,expected]of Object.entries(report.types??{})){
  assert.ok(Number.isSafeInteger(expected.written)&&expected.written>=0&&expected.verified===expected.written,'type receipt is not qualified');
  let count=0;for(const {address,record}of native.each(directory,type)){assert.ok(native.get(directory,type,address));assert.equal(semanticAddress(record).id,address);count++;}
  assert.equal(count,expected.written,'current receiver found another record count');
  for(const {head}of native.heads(directory,type))for(const step of native.walk(directory,type,head.frontier,{limit:100000}))assert.ok(!step.missing&&!step.truncated,'current causal head is incomplete');
 }
}
function receiveDispositions(binding,candidate,report){
 const policies=binding.dispositionPolicy??[];assert.ok(Array.isArray(policies)&&policies.length<=32);
 const roles=new Set(['record-reference','named-claim-citation','cause']),reasons=new Set(['original-kind-not-converted','external-or-unresolved-original-reference','original-cause-unavailable']);
 for(const policy of policies){assert.ok(roles.has(policy.role)&&reasons.has(policy.reason)&&Array.isArray(policy.originalKinds)&&policy.originalKinds.length>0&&policy.originalKinds.length<=32);
  assert.equal(policy.disposition,'original-only-noncausal-no-authority');assert.ok(typeof policy.currentConsumer==='string'&&policy.currentConsumer.length>0&&typeof policy.counterevidence==='string'&&policy.counterevidence.length>0,'citation policy lacks consumer semantics or counterevidence');}
 const expected=report.referenceDispositions;if(!expected)return {admitted:true,count:0,unapproved:0,file:null,sha256:null};
 assert.ok(Number.isSafeInteger(expected.count)&&Number.isSafeInteger(expected.unresolvedNamedCitations));
 const file=relative(candidate,expected.file);let count=0,named=0,unapproved=0;const findings={};
 if(fs.existsSync(file))for(const row of selectionRows(file)){
  assert.ok(roles.has(row.role)&&reasons.has(row.reason)&&/^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/u.test(row.original)&&/^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/u.test(row.reference),'reference disposition has no original address/role');
  count++;if(row.role==='named-claim-citation')named++;
  const key=JSON.stringify([row.role,row.reason,row.originalKind]);findings[key]=(findings[key]??0)+1;
  // A genuinely missing named local witness can never be admitted by policy.
  if(row.role==='named-claim-citation'&&row.reason==='original-cause-unavailable')unapproved++;
  else if(!policies.some(policy=>policy.role===row.role&&policy.reason===row.reason&&policy.originalKinds.includes(row.originalKind)))unapproved++;
 }
 assert.equal(count,expected.count);assert.equal(named,expected.unresolvedNamedCitations);
 return {admitted:unapproved===0,count,unapproved,findings,file:expected.file,sha256:fs.existsSync(file)?streamHash(file).sha256:null};
}
function receiveOriginalOnly(candidate,report){
 const expected=report.originalOnlyDispositions;if(!expected)return {count:0,reasons:{},file:null,sha256:null};
 assert.ok(Number.isSafeInteger(expected.count)&&expected.count>=0&&expected.reasons&&typeof expected.reasons==='object');
 const file=relative(candidate,expected.file),reasons={};let count=0;
 if(fs.existsSync(file))for(const row of selectionRows(file)){
  assert.ok(/^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/u.test(row.original)&&typeof row.kind==='string'&&row.kind.length>0);
  assert.equal(row.reason,'legacy-subject-exceeds-current-name-law','unknown original-only disposition');
  count++;reasons[row.reason]=(reasons[row.reason]??0)+1;
 }
 assert.equal(count,expected.count);assert.deepEqual(reasons,expected.reasons);
 return {count,reasons,file:expected.file,sha256:fs.existsSync(file)?streamHash(file).sha256:null,disposition:'original-only-no-current-authority'};
}
function assertNoEscapedWriters(config){
 const spec=config.custodyTransition;assert.ok(spec&&Array.isArray(spec.bindings));
 const retired=spec.retiredExecutableRoots??[];assert.ok(Array.isArray(retired)&&retired.length<=16&&retired.every(root=>typeof root==='string'&&path.isAbsolute(root)));
 const roots=spec.bindings.flatMap(binding=>[...observationRoots(binding),binding.target]);
 const under=(file,root)=>file===root||file.startsWith(root+path.sep);
 for(const name of fs.readdirSync('/proc')){
  if(!/^\d+$/u.test(name)||Number(name)===process.pid)continue;
  const proc='/proc/'+name;try{
   if(fs.statSync(proc).uid!==process.getuid())continue;
   const cwd=fs.readlinkSync(path.join(proc,'cwd')).replace(/ \(deleted\)$/u,'');
   assert.ok(!retired.some(root=>under(cwd,root)),'an escaped process still uses retired mutable source');
   const args=fs.readFileSync(path.join(proc,'cmdline')).toString().split('\0');
   assert.ok(!args.some(arg=>path.isAbsolute(arg)&&retired.some(root=>under(arg,root))),'an escaped process still executes retired mutable source');
   for(const fd of fs.readdirSync(path.join(proc,'fd'))){
    const file=fs.readlinkSync(path.join(proc,'fd',fd)).replace(/ \(deleted\)$/u,'');if(!roots.some(root=>under(file,root)))continue;
    const flags=/^flags:\s*([0-7]+)$/mu.exec(fs.readFileSync(path.join(proc,'fdinfo',fd),'utf8'));assert.ok(flags,'custody descriptor mode is unavailable');
    assert.equal(parseInt(flags[1],8)&3,0,'an escaped process retains a custody write descriptor');
   }
  }catch(error){if(['ENOENT','ESRCH'].includes(error.code))continue;throw error;}
 }
}
export function verifyRetiredFiles(config){
 const rows=config.retiredConfigurationFiles??[];assert.ok(Array.isArray(rows)&&rows.length<=32);
 const root=path.join(process.env.HOME,'.config/systemd/user');
 for(const row of rows){assert.ok(typeof row.path==='string'&&path.resolve(row.path).startsWith(root+path.sep),'retired file is outside managed supervisor custody');unlinked(path.dirname(row.path));
  let st;try{st=fs.lstatSync(row.path);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  assert.equal(st.uid,process.getuid());
  if(row.link!==undefined){assert.ok(st.isSymbolicLink());assert.equal(fs.readlinkSync(row.path),row.link,'retired activation link changed');}
  else{assert.ok(st.isFile()&&!st.isSymbolicLink()&&HASH.test(row.sha256));assert.equal(streamHash(row.path).sha256,row.sha256,'retired mutable source changed');}
 }
 return {kind:'machine-custody-transition.v1',phase:'retirement-qualified',files:rows.length};
}
export async function prepareCustody(config,store,receiptFile,{execute=spawnSync,heldArtifact=null}={}){
 const spec=specOf(config);assertNoEscapedWriters(config);verifyRetiredFiles(config);assert.ok(Number.isSafeInteger(spec.timeoutSeconds??300)&&(spec.timeoutSeconds??300)>0&&(spec.timeoutSeconds??300)<=300,'conversion needs the declared existing bounded time');assert.ok(!fs.existsSync(receiptFile),'fresh custody receipt required');store=immutable(store);
 const receipt={kind:'machine-custody-transition.v1',phase:'preparing',targetArtifact:store,heldArtifact:heldArtifact?immutable(heldArtifact):null,bindings:[]};retainReceipt(receiptFile,receipt);
 const tool=spec.bindings.some(b=>b.conversion!=='kalshi')?conversionTool(spec,store):null,converter=tool?.program;
 const oldStore=converter?providerInput(spec.originalStore,tool.originals):null,currentStore=immutable(relative(store,spec.currentStore));
 const oldActivitypub=spec.bindings.some(b=>b.conversion==='activitypub')?providerInput(spec.originalActivitypub,tool.originals):null;
 for(const binding of spec.bindings){
  const parent=binding.conversion==='activitypub'?path.dirname(path.dirname(binding.target)):path.dirname(binding.target);ownedDirectory(parent,{privateMode:true});assert.equal(fs.statSync(binding.source).dev,fs.statSync(parent).dev,'candidate is not on original custody volume');
  const transaction=fs.mkdtempSync(path.join(parent,'.custody-transition-'));fs.chmodSync(transaction,0o700);
  const entry={name:binding.name,conversion:binding.conversion,source:binding.source,target:binding.target,transaction,candidate:path.join(transaction,'candidate'),retained:path.join(transaction,'retained'),failed:path.join(transaction,'failed'),report:path.join(transaction,'conversion.json'),phase:'preparing',selectionFile:path.join(transaction,'original-selection.jsonl')};
  const selectionFd=fs.openSync(entry.selectionFile,'wx',0o600);try{for(const row of observeSelection(binding))fs.writeSync(selectionFd,JSON.stringify(row)+'\n');fs.fsyncSync(selectionFd);}finally{fs.closeSync(selectionFd);}entry.selectionSha256=streamHash(entry.selectionFile).sha256;
  receipt.bindings.push(entry);retainReceipt(receiptFile,receipt);
  const args=binding.conversion==='kalshi'?[relative(store,spec.kalshiConverter),'--settlement',binding.source,'--output',entry.candidate,'--apply','--writers-stopped']:[converter,'--settlement',binding.source,'--into',entry.candidate,'--old-store',oldStore,'--new-store',currentStore,'--report',entry.report,...(binding.clockLastSource===undefined?[]:['--clock-last',binding.clockLastSource]),...(binding.conversion==='activitypub'?['--activitypub','--old-activitypub',oldActivitypub]:[]),...(binding.queue?['--queue',binding.queue,'--new-activitypub',immutable(relative(store,spec.currentActivitypub))]:[])];
  const result=execute(path.join(store,'bin/node'),args,{encoding:'utf8',timeout:(spec.timeoutSeconds??300)*1000,maxBuffer:1024*1024,env:{HOME:process.env.HOME,PATH:process.env.PATH,LANG:process.env.LANG}});
  assert.equal(result.status,0,'fabricated semantic converter refused');
  let report;
  if(binding.conversion==='kalshi'){
   report=JSON.parse(result.stdout);assert.ok(report.originalsPreserved===true&&report.orderEffect===false&&report.dryRun===false&&Array.isArray(report.conflicts)&&report.conflicts.length===0);
   assert.ok(Array.isArray(report.incompleteOrigins)&&report.incompleteOrigins.every(row=>typeof row.record==='string'&&typeof row.reason==='string'),'unqualified forecasting claims were not named');
   for(const file of report.files){const actual=streamHash(relative(entry.candidate,file.path));assert.equal(actual.sha256,file.sha256);assert.equal(actual.bytes,file.bytes);}
   fs.writeFileSync(entry.report,JSON.stringify(report)+'\n',{flag:'wx',mode:0o600});
  }else{
   report=JSON.parse(fs.readFileSync(entry.report,'utf8'));
   assert.ok(report.type==='OneTimeStoreConversion'&&report.version===1&&report.qualified===true&&report.originalsPreserved===true&&report.ordersExecuted===false&&report.transportActivated===false&&report.mainQualified!==false,'semantic receiving is unqualified');
   assert.equal(report.source,binding.source);assert.equal(report.output,entry.candidate);assert.ok(report.missingBodies.length===0);
   if(binding.clockLastSource!==undefined)assert.equal(report.mainSuppliers?.clockLastSource,binding.clockLastSource,'converter did not receive the authenticated auxiliary schedule history');
   assert.equal(report.suppliers.oldStore,oldStore);assert.equal(report.suppliers.newStore,currentStore);
   if(report.referenceDispositions){assert.ok(Number.isSafeInteger(report.referenceDispositions.unresolvedNamedCitations));assert.ok(typeof report.sourceOnlyDisposition==='string'&&report.sourceOnlyDisposition.length>0);}
   assert.ok(Array.isArray(binding.requiredTypes)&&binding.requiredTypes.length>0&&binding.requiredTypes.length<=32,'current meaningful receiving types must be declared');
   for(const type of binding.requiredTypes)assert.ok(report.types[type]?.written>0,'a required current consumer received no meaningful records');
   await receiveNative(entry.candidate,currentStore,report);entry.dispositions=receiveDispositions(binding,entry.candidate,report);entry.originalOnly=receiveOriginalOnly(entry.candidate,report);
  }
  if(binding.queue){
   assert.equal(binding.conversion,'activitypub');assert.equal(binding.queue,path.join(path.dirname(binding.target),'queue'),'queue must be the actual sibling provider custody');
   const candidate=path.join(transaction,'queue');fs.mkdirSync(path.join(candidate,'ready'),{recursive:true,mode:0o700});fs.mkdirSync(path.join(candidate,'claimed'),{mode:0o700});
   const accepted=binding.acceptedPending??[];assert.ok(Array.isArray(accepted)&&accepted.length<=16);let pending=0,unapproved=0;
   for(const file of files(path.join(candidate,'ready'))){const name=path.basename(file),hash=streamHash(file).sha256;pending++;assert.equal(hash,streamHash(path.join(binding.queue,'ready',name)).sha256);
    if(!accepted.some(row=>row.name===name&&row.sha256===hash&&typeof row.currentConsumer==='string'&&row.currentConsumer.length>0&&typeof row.counterevidence==='string'&&row.counterevidence.length>0))unapproved++;}
   assert.equal(pending,report.queue.retained);assert.equal(report.queue.activated,0);
   entry.queueBinding={source:binding.queue,target:binding.queue,candidate,retained:path.join(transaction,'retained-queue'),failed:path.join(transaction,'failed-queue'),converted:custodyDigest(candidate),phase:'prepared'};entry.queueReceiving={pending,unapproved,admitted:unapproved===0,archivedOriginalOnly:report.queue.archivedOriginalOnly,originalOnly:report.queue.originalOnly.length};
  }
  assertSelection(entry.selectionFile);entry.reportSha256=streamHash(entry.report).sha256;
  entry.receiving={sourceIntegrityReceived:true,nativeReceived:true,dispositionsAdmitted:(entry.dispositions?.admitted??true)&&(entry.queueReceiving?.admitted??true),types:report.types??null,sourceOnly:report.sourceOnly??report.excluded??{},originalOnly:entry.originalOnly??null,referencesLeft:report.referencesLeft??0,causesDropped:report.causesDropped??0,unresolvedNamedCitations:report.referenceDispositions?.unresolvedNamedCitations??0,incompleteForecastOrigins:report.incompleteOrigins?.length??0,queueOriginalOnly:report.queue?.originalOnly?.length??0};
  entry.converted=custodyDigest(entry.candidate);entry.phase='prepared';retainReceipt(receiptFile,receipt);
 }
 receipt.phase='prepared';retainReceipt(receiptFile,receipt);return {kind:receipt.kind,phase:receipt.phase,bindings:receipt.bindings.map(b=>({name:b.name,...b.receiving}))};
}
function readReceipt(file){const receipt=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(receipt.kind,'machine-custody-transition.v1');assert.ok(Array.isArray(receipt.bindings)&&receipt.bindings.length<=16);
 for(const entry of receipt.bindings){assert.equal(path.dirname(entry.transaction),entry.conversion==='activitypub'?path.dirname(path.dirname(entry.target)):path.dirname(entry.target));assert.ok(path.basename(entry.transaction).startsWith('.custody-transition-'));ownedDirectory(entry.transaction,{privateMode:true});for(const key of ['candidate','retained','failed'])assert.equal(entry[key],path.join(entry.transaction,key));assert.equal(entry.selectionFile,path.join(entry.transaction,'original-selection.jsonl'));assert.equal(streamHash(entry.selectionFile).sha256,entry.selectionSha256);unlinked(entry.target);if(entry.queueBinding){const q=entry.queueBinding;assert.equal(q.target,path.join(path.dirname(entry.target),'queue'));for(const key of ['candidate','retained','failed'])assert.equal(q[key],path.join(entry.transaction,key==='candidate'?'queue':key+'-queue'));}}
 return receipt;
}
export function activateCustody(receiptFile,config){
 assertNoEscapedWriters(config);const receipt=readReceipt(receiptFile);assert.ok(['prepared','rollback-prepared'].includes(receipt.phase));
 if(receipt.phase==='prepared')assert.ok(receipt.bindings.every(entry=>entry.receiving?.dispositionsAdmitted===true),'actual citation findings need finite source-owned admission before binding');
 for(const entry of receipt.bindings){
  if(receipt.phase==='rollback-prepared'){
   entry.phase='rollback-binding';retainReceipt(receiptFile,receipt);
   if(fs.existsSync(entry.target)){assert.ok(!fs.existsSync(entry.failed));fs.renameSync(entry.target,entry.failed);}
   if(entry.hadPrior)fs.renameSync(entry.retained,entry.target);if(entry.queueBinding){const q=entry.queueBinding;q.phase='rollback-binding';retainReceipt(receiptFile,receipt);if(fs.existsSync(q.target))fs.renameSync(q.target,q.failed);if(q.hadPrior)fs.renameSync(q.retained,q.target);q.phase='rollback-bound';}entry.phase='rollback-bound';retainReceipt(receiptFile,receipt);continue;
  }
  assertSelection(entry.selectionFile);assert.deepEqual(custodyDigest(entry.candidate),entry.converted);assert.equal(streamHash(entry.report).sha256,entry.reportSha256);
  entry.hadPrior=fs.existsSync(entry.target);entry.phase='binding';retainReceipt(receiptFile,receipt);
  if(entry.hadPrior)fs.renameSync(entry.target,entry.retained);
  fs.renameSync(entry.candidate,entry.target);assert.deepEqual(custodyDigest(entry.target),entry.converted);
  if(entry.queueBinding){const q=entry.queueBinding;assert.deepEqual(custodyDigest(q.candidate),q.converted);q.hadPrior=fs.existsSync(q.target);q.phase='binding';retainReceipt(receiptFile,receipt);if(q.hadPrior)fs.renameSync(q.target,q.retained);fs.renameSync(q.candidate,q.target);assert.deepEqual(custodyDigest(q.target),q.converted);q.phase='bound';retainReceipt(receiptFile,receipt);}
  assertSelection(entry.selectionFile,{from:[...(entry.source===entry.target?[{from:entry.source,to:entry.retained}]:[]),...(entry.queueBinding?[{from:entry.queueBinding.source,to:entry.queueBinding.retained}]:[])]});entry.phase='bound';retainReceipt(receiptFile,receipt);
 }
 receipt.phase=receipt.phase==='rollback-prepared'?'rollback-bound':'bound';retainReceipt(receiptFile,receipt);return {kind:receipt.kind,phase:receipt.phase,bindings:receipt.bindings.length};
}
export async function receiveBoundCustody(config,store,receiptFile){
 assertNoEscapedWriters(config);const receipt=readReceipt(receiptFile);assert.equal(receipt.phase,'bound');assert.equal(receipt.targetArtifact,immutable(store));
 const currentStore=immutable(relative(store,config.custodyTransition.currentStore));
 for(const entry of receipt.bindings){
  assert.equal(entry.phase,'bound');assert.equal(streamHash(entry.report).sha256,entry.reportSha256);assert.deepEqual(custodyDigest(entry.target),entry.converted);
  assertSelection(entry.selectionFile,{from:[...(entry.source===entry.target?[{from:entry.source,to:entry.retained}]:[]),...(entry.queueBinding?[{from:entry.queueBinding.source,to:entry.queueBinding.retained}]:[])]});
  if(entry.queueBinding)assert.deepEqual(custodyDigest(entry.queueBinding.target),entry.queueBinding.converted);
  const report=JSON.parse(fs.readFileSync(entry.report,'utf8'));
  if(entry.conversion==='kalshi'){for(const file of report.files)assert.equal(streamHash(relative(entry.target,file.path)).sha256,file.sha256);}
  else {await receiveNative(entry.target,currentStore,report);const binding=config.custodyTransition.bindings.find(row=>row.name===entry.name);assert.ok(binding);const received=receiveDispositions(binding,entry.target,report);assert.ok(received.admitted);assert.deepEqual(received,entry.dispositions);}
 }
 return {kind:receipt.kind,phase:'received',bindings:receipt.bindings.length,originalsPreserved:true,orderEffect:false};
}
export function prepareRollback(config,targetArtifact,heldArtifact,receiptFile){
 const spec=specOf(config);assert.ok(heldArtifact&&!fs.existsSync(receiptFile));targetArtifact=immutable(targetArtifact);heldArtifact=immutable(heldArtifact);ownedDirectory(config.receiptRoot,{privateMode:true});
 const names=fs.readdirSync(config.receiptRoot);assert.ok(names.length<=4096);const matches=[];
 for(const name of names){if(!/^\d+(?:-\d+)*-success\.json$/u.test(name))continue;const value=JSON.parse(fs.readFileSync(path.join(config.receiptRoot,name),'utf8'));
  if(value.outcome==='success'&&value.storePath===heldArtifact&&value.previousArtifact===targetArtifact&&value.custody?.phase==='bound')matches.push(value.custody);}
 assert.equal(matches.length,1,'rollback lacks one exact state/generation receipt');const receipt=matches[0];
 assert.deepEqual(receipt.bindings.map(b=>b.target).sort(),spec.bindings.map(b=>b.target).sort());
 for(const entry of receipt.bindings){ownedDirectory(entry.transaction,{privateMode:true});assert.ok(!fs.existsSync(entry.failed));assertSelection(entry.selectionFile,{from:[...(entry.source===entry.target?[{from:entry.source,to:entry.retained}]:[]),...(entry.queueBinding?[{from:entry.queueBinding.source,to:entry.queueBinding.retained}]:[])]});entry.phase='rollback-prepared';}
 receipt.phase='rollback-prepared';receipt.rollbackTargetArtifact=targetArtifact;receipt.rollbackHeldArtifact=heldArtifact;retainReceipt(receiptFile,receipt);return {kind:receipt.kind,phase:receipt.phase,bindings:receipt.bindings.length};
}
export function restoreCustody(receiptFile,config){
 assertNoEscapedWriters(config);if(!fs.existsSync(receiptFile))return {kind:'machine-custody-transition.v1',phase:'not-required'};
 const receipt=readReceipt(receiptFile);
 for(const entry of [...receipt.bindings].reverse()){
  if(entry.queueBinding){const q=entry.queueBinding;if(['rollback-binding','rollback-bound'].includes(q.phase)){if(q.hadPrior&&fs.existsSync(q.target)&&!fs.existsSync(q.retained))fs.renameSync(q.target,q.retained);if(fs.existsSync(q.failed))fs.renameSync(q.failed,q.target);q.phase='rollback-cancelled';}else if(['binding','bound'].includes(q.phase)){
    // A durable phase can precede the first rename. Without parked prior custody, the target is still original.
    if(q.hadPrior&&!fs.existsSync(q.retained))assert.ok(fs.existsSync(q.target),'original queue disappeared before parking');
    else{if(fs.existsSync(q.target))fs.renameSync(q.target,q.failed);if(q.hadPrior)fs.renameSync(q.retained,q.target);}
    q.phase='restored';}retainReceipt(receiptFile,receipt);}
  if(['rollback-binding','rollback-bound'].includes(entry.phase)){
   if(entry.hadPrior&&fs.existsSync(entry.target)&&!fs.existsSync(entry.retained))fs.renameSync(entry.target,entry.retained);
   if(fs.existsSync(entry.failed))fs.renameSync(entry.failed,entry.target);entry.phase='rollback-cancelled';
  }else if(['binding','bound'].includes(entry.phase)){
   if(entry.hadPrior&&!fs.existsSync(entry.retained))assert.ok(fs.existsSync(entry.target),'original custody disappeared before parking');
   else{if(fs.existsSync(entry.target)){assert.ok(!fs.existsSync(entry.failed));fs.renameSync(entry.target,entry.failed);}
    if(entry.hadPrior)fs.renameSync(entry.retained,entry.target);}
   entry.phase='restored';
  }else entry.phase='cancelled';
  // Failed successors and isolated reports remain in private custody. No new
  // work or uncertain original is erased by recovery.
  retainReceipt(receiptFile,receipt);
 }
 receipt.phase='restored';retainReceipt(receiptFile,receipt);return {kind:receipt.kind,phase:receipt.phase,failedSuccessorCustodyRetained:true};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [phase,configFile,store,receiptFile,heldArtifact]=process.argv.slice(2);
 try{assert.ok(['prepare','prepare-rollback','activate','restore','retire-check','receive'].includes(phase)&&receiptFile);
  const result=phase==='receive'?await receiveBoundCustody(JSON.parse(fs.readFileSync(configFile,'utf8')),store,receiptFile):phase==='retire-check'?verifyRetiredFiles(JSON.parse(fs.readFileSync(configFile,'utf8'))):phase==='prepare'?await prepareCustody(JSON.parse(fs.readFileSync(configFile,'utf8')),store,receiptFile,{heldArtifact}):phase==='prepare-rollback'?prepareRollback(JSON.parse(fs.readFileSync(configFile,'utf8')),store,heldArtifact,receiptFile):phase==='activate'?activateCustody(receiptFile,JSON.parse(fs.readFileSync(configFile,'utf8'))):restoreCustody(receiptFile,JSON.parse(fs.readFileSync(configFile,'utf8')));
  console.log(JSON.stringify(result));
 }catch(error){try{ownedDirectory(path.dirname(receiptFile),{privateMode:true});fs.writeFileSync(receiptFile+'.refusal.json',JSON.stringify({phase,errorName:String(error?.name).slice(0,80),detail:String(error?.message).slice(0,4000)})+'\n',{mode:0o600});}catch{}
  console.error(JSON.stringify({kind:'machine-custody-transition.v1',phase:'refused'}));process.exitCode=1;}
}
