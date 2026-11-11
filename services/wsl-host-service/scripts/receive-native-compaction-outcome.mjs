#!/usr/bin/env node
// Builtins only until the complete original owner receiver closure is qualified.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readSync,readFileSync,lstatSync,realpathSync } from 'node:fs';
import { dirname,join } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
const chunks=[];let size=0;
for(;;){const chunk=Buffer.alloc(8192),n=readSync(0,chunk,0,chunk.length,null);if(!n)break;size+=n;if(size>131072)throw Error('bounded modern outcome stdin');chunks.push(chunk.subarray(0,n))}
const payload=new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks,size));
const value=JSON.parse(payload);assert.equal(value.type,'WslNativeCompactionOutcomeTransfer');assert.equal(value.version,1);
const parameters=JSON.parse(value.parameterText),admission=JSON.parse(value.admissionText),reentry=JSON.parse(value.reentryText),declaration=parameters.windows.nativeCompaction.reentry;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(value.parameterText),admission.parameterSha256);assert.equal(hash(value.parameterText),reentry.parameterSha256);assert.equal(hash(value.admissionText),reentry.maintenanceAdmissionSha256);
assert.equal(process.getuid(),declaration.ownerUid);const receiver=fileURLToPath(import.meta.url);assert.equal(declaration.receiver,receiver);assert.equal(realpathSync(receiver),receiver);
const closure=['scripts/receive-native-compaction-outcome.mjs','src/native-maintenance-caller.mjs','src/native-compaction.mjs','src/backing-capacity.mjs','assets/native-compact.ps1','assets/native-compaction-outcome.ps1','assets/native-maintenance-caller.ps1','assets/observe-backing-capacity.ps1','assets/receive-backing-target.ps1'];
assert.deepEqual(Object.keys(declaration.receiverClosure).sort(),[...closure].sort(),'exact original receiver closure required');
const root=dirname(dirname(receiver));
function qualify(){let total=0;for(const relative of closure){const path=join(root,relative);assert.equal(realpathSync(path),path,'receiver source redirected');const s=lstatSync(path);assert.ok(s.isFile()&&!s.isSymbolicLink()&&s.uid===declaration.ownerUid&&(s.mode&0o022)===0&&s.size<=1048576,'private bounded original receiver source');total+=s.size;assert.ok(total<=2097152,'receiver closure allocation');assert.equal(hash(readFileSync(path)),declaration.receiverClosure[relative],'receiver closure changed: '+relative)}assert.equal(declaration.receiverClosure[closure[0]],declaration.receiverSha256);assert.equal(value.receiverSha256,declaration.receiverSha256)}
qualify();
const {persistNativeCompactionOutcome}=await import(pathToFileURL(join(root,'src/native-maintenance-caller.mjs')).href);
qualify(); // Detect concurrent source drift before the first owner-data write.
console.log(JSON.stringify(persistNativeCompactionOutcome(payload)));
