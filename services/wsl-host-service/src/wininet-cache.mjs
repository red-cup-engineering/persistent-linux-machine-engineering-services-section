// Exact original WinINet-owner entry release; ordinary plan/apply never calls it.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {win32} from 'node:path';
import {execFileSync} from 'node:child_process';
import {validateBackingStorage} from './backing-capacity.mjs';
import {nativeFileSource} from './derived-code-cache.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const hash=x=>assert.match(x,/^[0-9a-f]{64}$/);
const id=x=>assert.match(x,/^[0-9a-f]{8}:[0-9a-f]{16}$/);
const literal=x=>JSON.stringify(x).replace(/[\u0085\u2028\u2029]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
const path=x=>assert.ok(typeof x==='string'&&/^[A-Za-z]:\\/.test(x)&&!/[/?*\x00-\x1f]/.test(x)&&!x.split('\\').some(x=>x==='.'||x==='..'),'explicit unredirected native file required');
export function winInetCacheDeclaration(parameters,{action}={}){
 assert.ok(['observe','retire'].includes(action));const b=validateBackingStorage(parameters),q=parameters.windows?.winInetCacheRetirement;
 assert.equal(q?.schema,'wsl-wininet-duplicate-installer@1');assert.match(q.ownerSid,/^S-1-5-21-\d+-\d+-\d+-\d+$/);assert.match(q.machineName,/^[A-Z0-9-]+$/);
 path(q.localAppDataWindowsPath);path(parameters.windows.profileWindowsPath);
 assert.equal(q.owner.kind,'powertoys-ready-to-install');path(q.owner.updateStatePath);hash(q.owner.updateStateSha256);assert.equal(q.owner.pendingFilename,win32.basename(q.pending.path));assert.equal(q.owner.state,3);
 for(const f of [q.cache,q.pending]){path(f.path);id(f.fileIdentity);assert.match(f.logicalBytes,/^[1-9][0-9]*$/);assert.match(f.allocatedBytes,/^[1-9][0-9]*$/);if(action==='retire'||f.sha256!=null)hash(f.sha256);if(action==='retire'||f.sddlSha256!=null)hash(f.sddlSha256);if(action==='retire'||f.parentFileIdentity!=null)id(f.parentFileIdentity);if(action==='retire'||f.parentSddlSha256!=null)hash(f.parentSddlSha256);}
 assert.notEqual(q.cache.path.toLowerCase(),q.pending.path.toLowerCase());assert.notEqual(q.cache.fileIdentity,q.pending.fileIdentity);assert.equal(q.cache.sha256,q.pending.sha256);
 assert.equal(q.pending.attributes,32);assert.equal(q.cache.attributes,8224,'received ordinary WinINet Archive|NotContentIndexed attributes required');
 assert.ok(q.cache.path.toLowerCase().startsWith(win32.join(q.localAppDataWindowsPath,'Microsoft','Windows','INetCache').toLowerCase()+'\\'));
 assert.equal(q.pending.path.toLowerCase(),win32.join(q.localAppDataWindowsPath,'Microsoft','PowerToys','Updates',q.owner.pendingFilename).toLowerCase());
 assert.equal(q.owner.updateStatePath.toLowerCase(),win32.join(q.localAppDataWindowsPath,'Microsoft','PowerToys','UpdateState.json').toLowerCase());
 hash(q.cache.sourceUrlSha256);assert.equal(q.cache.sourceHost,'release-assets.githubusercontent.com');assert.equal(q.cache.entryType,65);
 return {...q,profile:parameters.windows.profileWindowsPath,volumeId:b.volumeId};
}
export function renderWinInetCacheRequest(parameterText,{action,nonce}={}){
 assert.match(nonce,/^[0-9a-f]{64}$/);const q=winInetCacheDeclaration(JSON.parse(parameterText),{action}),expected={...q,action,nonce,parameterSha256:sha(parameterText)};
 const owner=readFileSync(new URL('../assets/wininet-cache-owner.cs',import.meta.url),'utf8'),template=readFileSync(new URL('../assets/retire-wininet-cache.ps1',import.meta.url),'utf8'),native=nativeFileSource();
 assert.ok(!native.source.includes("\n'@")&&!owner.includes("\n'@"));
 const script="$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n$expected=@'\n"+literal(expected)+"\n'@|ConvertFrom-Json\n$nativeSource=@'\n"+native.source+"\n'@\n$cacheOwnerSource=@'\n"+owner+"\n'@\n"+template;
 const packed=deflateRawSync(Buffer.from(script),{level:9}).toString('base64'),digest=sha(script);
 const launcher="$ErrorActionPreference='Stop';$m=[IO.MemoryStream]::new([Convert]::FromBase64String('"+packed+"'));$d=[IO.Compression.DeflateStream]::new($m,[IO.Compression.CompressionMode]::Decompress);$r=[IO.StreamReader]::new($d,[Text.Encoding]::UTF8);try{$s=$r.ReadToEnd()}finally{$r.Dispose();$d.Dispose();$m.Dispose()};$b=[Text.Encoding]::UTF8.GetBytes($s);$h=([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b))).Replace('-','').ToLowerInvariant();if($b.Length -ne "+Buffer.byteLength(script)+" -or $h -cne '"+digest+"'){throw 'Original WinINet source changed'};&([scriptblock]::Create($s))";
 const encodedCommand=Buffer.from(launcher,'utf16le').toString('base64');assert.ok(encodedCommand.length+256<32767);
 return {type:'WslWinInetCacheRequest',action,nonce,parameterSha256:sha(parameterText),script,scriptSha256:digest,launcher,launcherSha256:sha(launcher),encodedCommand,resultWindowsPath:win32.join(q.localAppDataWindowsPath,'Temp','561-wsl-wininet-cache-'+nonce+'.jsonl'),effectsExecuted:false};
}
export function receiveWinInetCacheNativeOutput(parameterText,request,{nativeProcessId,outputSha256}={}){
 // Receiving a historical refusal must survive a corrected effect producer.
 // This is a closed read-only file receiver, never an effect admission issuer.
 const p=JSON.parse(parameterText),b=validateBackingStorage(p),q=p.windows.winInetCacheRetirement;hash(outputSha256);assert.ok(Number.isSafeInteger(nativeProcessId)&&nativeProcessId>0);
 assert.equal(request.parameterSha256,sha(parameterText));assert.equal(request.scriptSha256,sha(request.script));
 const match=/\$expected=@'\n([^\r\n]+)\n'@\|ConvertFrom-Json/.exec(request.script);assert.ok(match);const actual=JSON.parse(match[1]);
 assert.deepEqual(actual,{...q,profile:p.windows.profileWindowsPath,volumeId:b.volumeId,action:request.action,nonce:request.nonce,parameterSha256:request.parameterSha256});
 path(q.localAppDataWindowsPath);assert.match(q.ownerSid,/^S-1-5-21-\d+-\d+-\d+-\d+$/);assert.match(request.nonce,/^[0-9a-f]{64}$/);assert.equal(request.resultWindowsPath,win32.join(q.localAppDataWindowsPath,'Temp','561-wsl-wininet-cache-'+request.nonce+'.jsonl'));
 const expected={path:request.resultWindowsPath,finalPath:b.volumeId+request.resultWindowsPath.slice(win32.parse(request.resultWindowsPath).root.length),ownerSid:q.ownerSid,nonce:request.nonce,parameterSha256:request.parameterSha256,nativeProcessId,sha256:outputSha256};
 const script="$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n$expected=@'\n"+literal(expected)+"\n'@|ConvertFrom-Json\n$nativeSource=@'\n"+nativeFileSource().source+"\n'@\n"+readFileSync(new URL('../assets/receive-derived-code-outcome.ps1',import.meta.url),'utf8');
 const runner="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);&([scriptblock]::Create([Console]::In.ReadToEnd()))";
 const r=JSON.parse(execFileSync(b.powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(runner,'utf16le').toString('base64')],{input:script,encoding:'utf8',cwd:'/'}));
 const raw=Buffer.from(r.rawBase64,'base64').toString('utf8');delete r.rawBase64;assert.equal(sha(raw),outputSha256);
 const lines=raw.trim().split('\n').map(x=>JSON.parse(x));assert.ok(lines.every(x=>x.nonce===request.nonce&&x.parameterSha256===request.parameterSha256&&x.nativeProcessId===nativeProcessId));const terminal=lines.at(-1);assert.equal(terminal.phase,'terminal');assert.ok(['native-terminal-success','native-observed-without-disposition','refused-before-owner-call','partial-or-pending'].includes(terminal.status));
 return {file:r,lines,raw,capacityReopened:false,effectsExecuted:false};
}

