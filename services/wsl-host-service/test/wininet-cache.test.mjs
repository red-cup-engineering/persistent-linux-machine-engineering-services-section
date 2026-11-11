import test from 'node:test';
import assert from 'node:assert/strict';
import {inflateRawSync} from 'node:zlib';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {renderWinInetCacheRequest,winInetCacheDeclaration} from '../src/wininet-cache.mjs';
function fixture(){
 const local='C:\\Users\\fixture\\AppData\\Local',target=(path,i)=>({path,attributes:i===1?8224:32,fileIdentity:'1234abcd:'+String(i).padStart(16,'0'),logicalBytes:'4',allocatedBytes:'4096',sha256:'11'.repeat(32),sddlSha256:'22'.repeat(32),parentFileIdentity:'1234abcd:'+String(i+2).padStart(16,'0'),parentSddlSha256:'33'.repeat(32)});
 return {schema:'wsl-host-parameters@1',windows:{profileWindowsPath:'C:\\Users\\fixture',backingStorage:{distributionName:'Example',registryKey:'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{11111111-1111-1111-1111-111111111111}',basePath:'C:\\distros\\example',vhdFileName:'ext4.vhdx',volumeId:'\\\\?\\Volume{22222222-2222-2222-2222-222222222222}\\',powershell:'/mnt/c/Windows/powershell.exe',wslpath:'/usr/bin/wslpath',linuxMount:'/',timeoutMs:1000,maxAgeMs:2000,policy:{minFreeBytes:'100000000000',minFreePercent:3,growthBytes:'2147483648',overheadBytes:'67108864',basis:'Original reserve'}},winInetCacheRetirement:{schema:'wsl-wininet-duplicate-installer@1',ownerSid:'S-1-5-21-1-2-3-1001',machineName:'EXAMPLE',localAppDataWindowsPath:local,owner:{kind:'powertoys-ready-to-install',updateStatePath:local+'\\Microsoft\\PowerToys\\UpdateState.json',updateStateSha256:'44'.repeat(32),state:3,pendingFilename:'powertoysusersetup.exe'},cache:{...target(local+'\\Microsoft\\Windows\\INetCache\\IE\\owned\\installer.exe',1),sourceUrlSha256:'55'.repeat(32),sourceHost:'release-assets.githubusercontent.com',entryType:65},pending:target(local+'\\Microsoft\\PowerToys\\Updates\\powertoysusersetup.exe',2)}}};
}
const nonce='ab'.repeat(32),render=(p=fixture(),action='retire')=>renderWinInetCacheRequest(JSON.stringify(p),{action,nonce});
test('exact immutable transport and one-line literal bind source without effects',()=>{
 const p=fixture();p.windows.winInetCacheRetirement.machineName='EXAMPLE';const r=render(p),launcher=Buffer.from(r.encodedCommand,'base64').toString('utf16le'),packed=/FromBase64String\('([^']+)'\)/.exec(launcher)[1];assert.equal(inflateRawSync(Buffer.from(packed,'base64')).toString(),r.script);assert.ok(r.encodedCommand.length+256<32767);assert.equal(r.effectsExecuted,false);
});
test('pending installer, native owner and complete exact retirement binding are mandatory',()=>{
 for(const mutate of [q=>q.owner.state=0,q=>q.pending.path=q.cache.path,q=>q.pending.sha256='66'.repeat(32),q=>delete q.cache.sddlSha256,q=>delete q.pending.parentFileIdentity,q=>q.cache.sourceHost='untrusted.invalid',q=>q.cache.entryType=1,q=>q.cache.path='C:\\unowned\\installer.exe',q=>q.pending.path='C:\\unowned\\pending.exe',q=>q.owner.updateStatePath='C:\\unowned\\state.json']){const p=fixture();mutate(p.windows.winInetCacheRetirement);assert.throws(()=>render(p));}
 assert.throws(()=>winInetCacheDeclaration(fixture(),{action:'clear-all'}));
 const p=fixture();delete p.windows.winInetCacheRetirement.cache.sddlSha256;assert.equal(render(p,'observe').action,'observe');assert.throws(()=>render(p));
});
test('native parser and actual original file/cache-owner classes compile without owner release',{skip:!existsSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')},()=>{
 const r=render(),native=/\$nativeSource=@'\n([\s\S]+?)\n'@/.exec(r.script)[1],owner=/\$cacheOwnerSource=@'\n([\s\S]+?)\n'@/.exec(r.script)[1];
 const ps="$ErrorActionPreference='Stop';$j=[Console]::In.ReadToEnd()|ConvertFrom-Json;$t=$null;$e=$null;$null=[Management.Automation.Language.Parser]::ParseInput($j.script,[ref]$t,[ref]$e);if($e.Count){throw($e|Out-String)};Add-Type -TypeDefinition $j.native;Add-Type -TypeDefinition $j.owner;@{parserErrors=0;fileCompiled=$true;cacheOwnerCompiled=$true;effectsExecuted=$false}|ConvertTo-Json -Compress";
 const x=spawnSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')],{cwd:'/',input:JSON.stringify({script:r.script,native,owner}),encoding:'utf8'});assert.ifError(x.error);assert.equal(x.status,0,x.stderr);assert.deepEqual(JSON.parse(x.stdout),{parserErrors:0,fileCompiled:true,cacheOwnerCompiled:true,effectsExecuted:false});
});

