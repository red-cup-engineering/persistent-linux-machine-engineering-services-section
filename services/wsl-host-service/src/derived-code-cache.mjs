// Explicit original-owner retirement of the superseded Windows plugin Code cache.
// Rendering is not native observation, permission, launch or physical recovery.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {win32} from 'node:path';
import {execFileSync} from 'node:child_process';
import {validateBackingStorage} from './backing-capacity.mjs';

const sha = x => createHash('sha256').update(x).digest('hex');
const names = ['codex.exe','codex-code-mode-host.exe','codex-command-runner.exe','codex-windows-sandbox-setup.exe'];
const hash = x => assert.match(x,/^[0-9a-f]{64}$/);
const id = x => assert.match(x,/^[0-9a-f]{8}:[0-9a-f]{16}$/);
const absolute = x => {assert.equal(typeof x,'string');assert.ok(win32.isAbsolute(x)&&!/[\x00-\x1f]/.test(x)&&!x.split(/[\\/]/).some(y=>y==='..'||y==='.'||/[?*]/.test(y)),'unredirected explicit Windows path required');};
const decimal = x => assert.match(x,/^[1-9][0-9]{0,23}$/);
function oneLineJson(value){const json=JSON.stringify(value).replace(/[\u0085\u2028\u2029]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));assert.ok(!/[\r\n]/.test(json));return json;}

export function derivedCodeCacheDeclaration(parameters,{action}={}) {
  assert.ok(['observe','retire'].includes(action),'explicit observe/retire action required');
  const backing=validateBackingStorage(parameters),q=parameters.windows?.derivedCodeCacheRetirement;
  assert.equal(q?.schema,'wsl-derived-code-cache-retirement@1');
  assert.match(q.id,/^[a-z0-9][a-z0-9-]+$/);assert.match(q.ownerSid,/^S-1-5-21-\d+-\d+-\d+-\d+$/);assert.match(q.machineName,/^[A-Z0-9-]+$/);
  absolute(q.cacheParentWindowsPath);assert.ok(q.cacheParentWindowsPath.toLowerCase().endsWith('\\plugins\\.plugin-appserver'));
  absolute(q.localAppDataWindowsPath);absolute(parameters.windows.profileWindowsPath);
  assert.equal(q.producer.kind,'codex-plugin-appserver-v1');absolute(q.producer.installLocation);absolute(q.producer.makerPath);
  assert.equal(q.producer.makerPath.toLowerCase(),win32.join(q.producer.installLocation,'app','resources','app.asar').toLowerCase());
  assert.match(q.producer.packageFullName,/^OpenAI\.Codex_[A-Za-z0-9_.]+$/);hash(q.producer.makerSha256);
  assert.ok(Number.isSafeInteger(q.producer.makerOffset)&&q.producer.makerOffset>=0&&Number.isSafeInteger(q.producer.makerBytes)&&q.producer.makerBytes>0);
  absolute(q.producer.liveCliWindowsPath);assert.ok(!q.producer.liveCliWindowsPath.toLowerCase().startsWith(q.cacheParentWindowsPath.toLowerCase()+'\\'));
  assert.deepEqual(q.producer.replacements.map(t=>t.name).sort(),[...names].sort());
  for(const f of q.producer.replacements){assert.equal(f.path.toLowerCase(),win32.join(q.producer.installLocation,'app','resources',f.name).toLowerCase());hash(f.sha256);}
  assert.ok(Array.isArray(q.configGuards)&&q.configGuards.length>0);for(const f of q.configGuards){absolute(f.path);hash(f.sha256);}
  assert.deepEqual(q.targets.map(t=>t.name).sort(),[...names].sort());
  for(const t of q.targets){id(t.fileIdentity);decimal(t.allocatedBytes);decimal(t.logicalBytes);assert.equal(t.links,1);assert.equal(t.attributes,32);if(action==='retire'||t.sha256!=null)hash(t.sha256);if(action==='retire'||t.sddlSha256!=null)hash(t.sddlSha256);}
  assert.equal(new Set(q.targets.map(t=>t.fileIdentity)).size,4,'duplicate native target');
  if(action==='retire'||q.parentFileIdentity!=null)id(q.parentFileIdentity);
  if(action==='retire'||q.parentSddlSha256!=null)hash(q.parentSddlSha256);
  return {...q,volumeId:backing.volumeId,profile:parameters.windows.profileWindowsPath};
}

// The original qualified file handle primitive remains one source. Do not copy
// its VM/HCS admission policy into this different derived-Code operation.
export function nativeFileSource() {
  const original=readFileSync(new URL('../assets/retire-orphan-swap.ps1',import.meta.url),'utf8');
  const start=original.indexOf("Add-Type -TypeDefinition @'\n"),end=original.indexOf("\n'@",start);
  assert.ok(start>=0&&end>start,'original native file primitive unavailable');
  const base=original.slice(start+"Add-Type -TypeDefinition @'\n".length,end);
  const methods=String.raw`
 [StructLayout(LayoutKind.Sequential)]struct TrustFile {public uint Size;public IntPtr Path,Handle,Subject;}
 [StructLayout(LayoutKind.Sequential)]struct TrustData {public uint Size;public IntPtr Callback,Sip;public uint Ui,Revocation,Choice;public IntPtr File;public uint StateAction;public IntPtr State,Url;public uint Flags,UiContext;public IntPtr SignatureSettings;}
 public sealed class SignerSnapshot {public string Subject,Thumbprint;}
 [DllImport("wintrust.dll",ExactSpelling=true)]static extern int WinVerifyTrust(IntPtr window,ref Guid action,ref TrustData data);
 [DllImport("wintrust.dll",ExactSpelling=true)]static extern IntPtr WTHelperProvDataFromStateData(IntPtr state);
 [DllImport("wintrust.dll",ExactSpelling=true)]static extern IntPtr WTHelperGetProvSignerFromChain(IntPtr data,uint signer,[MarshalAs(UnmanagedType.Bool)]bool counter,uint counterIndex);
 [DllImport("wintrust.dll",ExactSpelling=true)]static extern IntPtr WTHelperGetProvCertFromChain(IntPtr signer,uint certificate);
 public static SignerSnapshot Verify(SafeFileHandle h){if(IntPtr.Size!=8)throw new Exception("Unqualified native trust layout");var path=Read(h).FinalPath;var name=Marshal.StringToHGlobalUni(path);var f=new TrustFile{Size=(uint)Marshal.SizeOf(typeof(TrustFile)),Path=name,Handle=h.DangerousGetHandle()};var fp=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(TrustFile)));Marshal.StructureToPtr(f,fp,false);var d=new TrustData{Size=(uint)Marshal.SizeOf(typeof(TrustData)),Ui=2,Choice=1,File=fp,StateAction=1,Flags=0x1000};var action=new Guid("00aac56b-cd44-11d0-8cc2-00c04fc295ee");try{int result=WinVerifyTrust(new IntPtr(-1),ref action,ref d);if(result!=0)throw new System.Security.Cryptography.CryptographicException(result);var provider=WTHelperProvDataFromStateData(d.State);if(provider==IntPtr.Zero)throw new Exception("Native signer provider absent");var signer=WTHelperGetProvSignerFromChain(provider,0,false,0);if(signer==IntPtr.Zero)throw new Exception("Native signer absent");var cert=WTHelperGetProvCertFromChain(signer,0);if(cert==IntPtr.Zero||Marshal.ReadInt32(cert)<16)throw new Exception("Native signer certificate absent");var context=Marshal.ReadIntPtr(cert,8);if(context==IntPtr.Zero)throw new Exception("Native certificate context absent");using(var x=new System.Security.Cryptography.X509Certificates.X509Certificate2(context))return new SignerSnapshot{Subject=x.Subject,Thumbprint=x.Thumbprint};}finally{d.StateAction=2;WinVerifyTrust(new IntPtr(-1),ref action,ref d);Marshal.FreeHGlobal(fp);Marshal.FreeHGlobal(name);}}
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool SetFilePointerEx(SafeFileHandle h,long offset,out long next,uint method);
 [DllImport("kernel32.dll",EntryPoint="GetFileInformationByHandleEx",SetLastError=true)]static extern bool RawInfo(SafeFileHandle h,int kind,IntPtr value,uint bytes);
 public static string Hash(SafeFileHandle h){long next;Need(SetFilePointerEx(h,0,out next,0));using(var hash=System.Security.Cryptography.SHA256.Create()){byte[] b=new byte[65536];uint n;while(true){Need(ReadFile(h,b,(uint)b.Length,out n,IntPtr.Zero));if(n==0)break;hash.TransformBlock(b,0,(int)n,null,0);}hash.TransformFinalBlock(new byte[0],0,0);return BitConverter.ToString(hash.Hash).Replace("-","").ToLowerInvariant();}}
 public static string[] Streams(SafeFileHandle h){int size=4096;while(true){IntPtr b=Marshal.AllocHGlobal(size);try{if(!RawInfo(h,7,b,(uint)size)){int e=Marshal.GetLastWin32Error();if(e==234||e==122){size=checked(size*2);continue;}throw new System.ComponentModel.Win32Exception(e);}var rows=new System.Collections.Generic.List<string>();int at=0;while(true){if(at<0||at>size-24)throw new Exception("Native stream bounds");int next=Marshal.ReadInt32(b,at),bytes=Marshal.ReadInt32(b,at+4);if(bytes<0||bytes%2!=0||at+24+bytes>size||(next!=0&&(next<24+bytes||at+next>size-24)))throw new Exception("Native stream shape");rows.Add(Marshal.PtrToStringUni(IntPtr.Add(b,at+24),bytes/2)+"|"+Marshal.ReadInt64(b,at+8).ToString());if(next==0)break;at+=next;}return rows.ToArray();}finally{Marshal.FreeHGlobal(b);}}}
`;
  assert.equal(base.split(' public static string Header(').length,2);
  // This subcase has no HCS capability: retain only the original file methods.
  // Their source bytes remain unchanged; the existing swap owner keeps HCS.
  const fileBase=base.split('\n').filter(line=>!line.includes('Hcs')).join('\n');
  return {source:fileBase.replace(' public static string Header(',methods+' public static string Header('),baseSha256:sha(base)};
}

export function renderDerivedCodeCacheRequest(parameterText,{action,nonce}={}) {
  assert.match(nonce,/^[0-9a-f]{64}$/);const q=derivedCodeCacheDeclaration(JSON.parse(parameterText),{action});
  const native=nativeFileSource(),template=readFileSync(new URL('../assets/retire-derived-code-cache.ps1',import.meta.url),'utf8');
  const expected={...q,action,nonce,parameterSha256:sha(parameterText)};
  // Compact JSON is one physical line: no Data can close the literal here-string.
  // The outer original Deflate/SHA transport still binds the entire source.
  const json=oneLineJson(expected);
  assert.ok(!/[\r\n]/.test(json)&&!native.source.includes("\n'@"));
  const script=`$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n$expected=@'\n${json}\n'@|ConvertFrom-Json\n$nativeSource=@'\n${native.source}\n'@\n`+template;
  const packed=deflateRawSync(Buffer.from(script),{level:9}).toString('base64');
  const launcher=`$ErrorActionPreference='Stop';$m=[IO.MemoryStream]::new([Convert]::FromBase64String('${packed}'));$d=[IO.Compression.DeflateStream]::new($m,[IO.Compression.CompressionMode]::Decompress);$r=[IO.StreamReader]::new($d,[Text.Encoding]::UTF8);try{$s=$r.ReadToEnd()}finally{$r.Dispose();$d.Dispose();$m.Dispose()};$b=[Text.Encoding]::UTF8.GetBytes($s);$h=([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b))).Replace('-','').ToLowerInvariant();if($b.Length -ne ${Buffer.byteLength(script)} -or $h -cne '${sha(script)}'){throw 'Original source payload changed'};&([scriptblock]::Create($s))`;
  const encodedCommand=Buffer.from(launcher,'utf16le').toString('base64');assert.ok(encodedCommand.length+256<32767,`native Windows argument too large (${encodedCommand.length} encoded characters)`);
  return {type:'WslDerivedCodeCacheRequest',action,nonce,parameterSha256:sha(parameterText),nativeFilePrimitiveSha256:native.baseSha256,templateSha256:sha(template),scriptSha256:sha(script),script,launcherSha256:sha(launcher),launcher,encodedCommand,resultWindowsPath:win32.join(q.localAppDataWindowsPath,'Temp',`561-wsl-derived-code-${nonce}.jsonl`),targets:q.targets,effectsExecuted:false};
}

export function receiveDerivedCodeCacheResult(request,raw) {
  const lines=raw.trim().split('\n').map(x=>JSON.parse(x));assert.ok(lines.length&&lines.every(x=>x.nonce===request.nonce&&x.parameterSha256===request.parameterSha256),'foreign native outcome');
  const terminal=lines.at(-1);assert.equal(terminal.phase,'terminal');assert.ok(['native-terminal-success','native-observed-without-disposition','refused-before-disposition','partial-or-unknown'].includes(terminal.status));
  if(terminal.status==='native-terminal-success'){assert.equal(request.action,'retire');const done=lines.filter(x=>x.phase==='file-terminal');assert.equal(done.length,4);assert.equal(new Set(done.map(x=>x.name)).size,4);for(const t of request.targets){const row=done.find(x=>x.name===t.name);assert.ok(row);assert.equal(row.fileIdentity,t.fileIdentity);assert.equal(row.nativeAbsenceCode,2);}}
  return {type:'WslDerivedCodeCacheOutcomeClaims',reportedStatus:terminal.status,resultSha256:sha(raw),lines,nativeEffectReceiving:'requires-original-launch-and-same-handle-private-output-binding',capacityReopened:false};
}

/** Closed read-only native receiving, not an effect/admission capability. The
 * original file primitive binds bytes, ACL and native object on one share-zero
 * handle. No substituted process port or serialized positive flag is accepted. */
export function receiveDerivedCodeCacheNativeOutput(parameterText,request,{nativeProcessId,outputSha256}={}) {
  const p=JSON.parse(parameterText),backing=validateBackingStorage(p);hash(outputSha256);assert.ok(Number.isSafeInteger(nativeProcessId)&&nativeProcessId>0);
  assert.equal(sha(request.script),request.scriptSha256);const match=/\$expected=@'\n([^\r\n]+)\n'@\|ConvertFrom-Json/.exec(request.script);assert.ok(match,'original literal request required');const q=JSON.parse(match[1]);
  assert.equal(q.nonce,request.nonce);assert.equal(q.parameterSha256,request.parameterSha256);assert.equal(q.ownerSid,p.windows.derivedCodeCacheRetirement?.ownerSid??q.ownerSid);
  const path=win32.join(q.localAppDataWindowsPath,'Temp',`561-wsl-derived-code-${q.nonce}.jsonl`);assert.equal(path,request.resultWindowsPath);assert.match(q.nonce,/^[0-9a-f]{64}$/);
  const expected={path,finalPath:q.volumeId+path.slice(win32.parse(path).root.length),ownerSid:q.ownerSid,nonce:q.nonce,parameterSha256:q.parameterSha256,nativeProcessId,sha256:outputSha256};
  const template=readFileSync(new URL('../assets/receive-derived-code-outcome.ps1',import.meta.url),'utf8');
  const script=`$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n$expected=@'\n${oneLineJson(expected)}\n'@|ConvertFrom-Json\n$nativeSource=@'\n${nativeFileSource().source}\n'@\n`+template;
  // Input is sent to the original Windows process, never a helper/payload file.
  const runner="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$s=[Console]::In.ReadToEnd();&([scriptblock]::Create($s))";
  const stdout=execFileSync(backing.powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(runner,'utf16le').toString('base64')],{input:script,encoding:'utf8',cwd:'/'});
  const native=JSON.parse(stdout),raw=Buffer.from(native.rawBase64,'base64').toString('utf8');assert.equal(sha(raw),outputSha256);delete native.rawBase64;
  return {type:'WslDerivedCodeCacheNativeOutcome',file:native,claims:receiveDerivedCodeCacheResult(request,raw),raw,effectsExecuted:false,capacityReopened:false};
}
