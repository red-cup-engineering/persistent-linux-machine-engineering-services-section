// Explicit necessary source receiving, not a registry or installed-machine proof.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {prepareCustody,activateCustody,restoreCustody,custodyDigest} from '../../scripts/custody-transition.mjs';
const ap=process.env.AP_RECEIVING_SOURCE,data=process.env.DATA_CONVERTER_SOURCE;
assert.ok(ap&&data,'explicit owning source bindings are required');
const load=relative=>import(pathToFileURL(path.join(ap,relative)));
const {source}=await load('test/fixtures/historical-custody.mjs');
const {custodyTreeSha256,installNativeCutover,nativeCutoverRequestFromSources}=await load('src/receiving/install-native-cutover.mjs');
const {createSemanticRecordJournal}=await import(pathToFileURL(path.join(ap,'node_modules/@red-cup-engineering/semiotic-eavt-services-section/src/record-semantic-record.mjs')));
const {createFileStoreSync}=await import(pathToFileURL(path.join(ap,'node_modules/@red-cup-engineering/immutable-content-custody-service/src/file-store.mjs')));
const after=[];const fixture=source({after:fn=>after.push(fn)},false,true);
try{
 const receivedRoot=path.join(fixture.root,'native'),destination=path.join(fixture.root,'installed');
 const child=(name,args,input)=>{const r=spawnSync(process.execPath,[path.join(ap,name),...args],{input,encoding:'utf8',timeout:10000,maxBuffer:64*1024});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
 const received=child('scripts/receive-historical-custody.mjs',[receivedRoot],fixture.wire);
 const custody=createSemanticRecordJournal({root:path.join(receivedRoot,'journal'),objectKind:'activitypub.custody'}),bodies=createFileStoreSync(path.join(receivedRoot,'journal','bodies'));
 const rows=[];
 for(const category of ['inbox','outbox','followers'])for(const row of custody.query({category})){
  const record={...row.record};
  if(category!=='followers'){record.activity=JSON.parse(bodies.verify(record.bodyReference.key,record.bodyReference.ni,{range:{start:0,end:record.bodyReference.byteLength-1}}).bytes.toString());delete record.bodyReference;}
  rows.push({kind:'native-record',category,record:{...row,record}});
 }
 const originalNative=path.join(fixture.root,'original-native');fs.mkdirSync(originalNative,{mode:0o700});fs.writeFileSync(path.join(originalNative,'witnesses.json'),JSON.stringify(rows),{mode:0o600});
 const sourceTree=custodyTreeSha256(originalNative),wire=[{kind:'native-source',sourceTreeSha256:sourceTree},...rows,{kind:'native-end',counts:{inbox:1,outbox:1,followers:1},legacyFeeds:0}].map(JSON.stringify).join('\n')+'\n';
 const native=child('scripts/compare-native-history.mjs',[receivedRoot,'--retain-history'],wire);
 const proof=installNativeCutover({receivedStateDirectory:receivedRoot,historicalCommitment:received.receivingCommitment,nativeCommitment:native.receivingCommitment,databaseSha256:fixture.digest,nativeTreeSha256:sourceTree,databaseFile:fixture.sourceFile,nativeJournalDirectory:originalNative,destination});
 assert.equal(proof.custodyInstalled,true);
 fs.mkdirSync(path.join(destination,'queue/handling'),{recursive:true,mode:0o700});
 // A finite original plain-EAVT dated feed makes this an actual filing change,
 // not an idempotent converter call. It asserts no handled/customer outcome.
 const dated=path.join(destination,'queue/handling/data/logs/2026/10/11');fs.mkdirSync(dated,{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(dated,'fixture.jsonl'),'{"e":"fixture","a":"retained","v":"source","t":"2026-10-11"}\n',{mode:0o600});
 const converter='services/computer-content-engineering-services-section/services/computer-serialized-content-engineering-services-section/services/json-services-section/services/jsonl-services-section/services/eavt-engineering-services-section/services/semiotic-eavt-services-section/scripts/file-journal-store-by-kind.mjs';
 const config={unit:'fixture.service',stateRoot:fixture.root,stateCompatibility:'preserve-existing',custodyTransition:{directory:'installed',writerUnits:['fixture.service'],settlements:['journal','receiving','queue/handling'],converter,timeoutSeconds:10}};
 const receipt=path.join(fixture.root,'transition.json'),original=custodyDigest(destination),sourceBefore=fs.readFileSync(fixture.sourceFile);
 prepareCustody(config,data,receipt);assert.deepEqual(custodyDigest(destination),original);
 activateCustody(receipt);
 const readback=child('src/receiving/receive-native-cutover.mjs',[receivedRoot,destination,fixture.sourceFile,originalNative]);
 assert.equal(readback.outcome,'retained');assert.equal(readback.verifiedBodies,2);
 // The unchanged receiver must still refuse a lost original body. No verifier
 // is edited, and recovery restores the exact original, readable native state.
 fs.renameSync(path.join(destination,'journal/bodies'),path.join(destination,'body-refusal-fixture'));
 const refused=spawnSync(process.execPath,[path.join(ap,'src/receiving/receive-native-cutover.mjs'),receivedRoot,destination,fixture.sourceFile,originalNative],{encoding:'utf8',timeout:10000,maxBuffer:64*1024});
 assert.notEqual(refused.status,0);
 restoreCustody(receipt);assert.deepEqual(custodyDigest(destination),original);
 const restored=child('src/receiving/receive-native-cutover.mjs',[receivedRoot,destination,fixture.sourceFile,originalNative]);
 assert.equal(restored.outcome,'retained');assert.equal(restored.verifiedBodies,2);
 assert.deepEqual(fs.readFileSync(fixture.sourceFile),sourceBefore);assert.equal(custodyTreeSha256(originalNative),sourceTree);
 console.log(JSON.stringify({kind:'native-custody-transition-source-receiving.v1',convertedSettlements:3,unchangedReceiverRetained:true,refusedMissingBody:true,rollbackNativeReadback:true,originalSourcesUnchanged:true,runtimeActivation:'unobserved'}));
}finally{for(const fn of after.reverse())fn();}
