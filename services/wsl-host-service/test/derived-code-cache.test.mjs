import test from 'node:test';
import assert from 'node:assert/strict';
import {inflateRawSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {derivedCodeCacheDeclaration,renderDerivedCodeCacheRequest,receiveDerivedCodeCacheResult} from '../src/derived-code-cache.mjs';

const names=['codex.exe','codex-code-mode-host.exe','codex-command-runner.exe','codex-windows-sandbox-setup.exe'];
function fixture(){return {schema:'wsl-host-parameters@1',windows:{profileWindowsPath:'C:\\Users\\fixture',backingStorage:{distributionName:'Example',registryKey:'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{11111111-1111-1111-1111-111111111111}',basePath:'C:\\distros\\example',vhdFileName:'ext4.vhdx',volumeId:'\\\\?\\Volume{22222222-2222-2222-2222-222222222222}\\',powershell:'/mnt/c/Windows/powershell.exe',wslpath:'/usr/bin/wslpath',linuxMount:'/',timeoutMs:1000,maxAgeMs:2000,policy:{minFreeBytes:'100000000000',minFreePercent:3,growthBytes:'2147483648',overheadBytes:'67108864',basis:'Original reserve'}},derivedCodeCacheRetirement:{schema:'wsl-derived-code-cache-retirement@1',id:'fixture-derived-code',ownerSid:'S-1-5-21-1-2-3-1001',machineName:'EXAMPLE',localAppDataWindowsPath:'C:\\Users\\fixture\\AppData\\Local',cacheParentWindowsPath:'C:\\old-home\\plugins\\.plugin-appserver',parentFileIdentity:'1234abcd:0000000000000009',parentSddlSha256:'99'.repeat(32),producer:{kind:'codex-plugin-appserver-v1',packageFullName:'OpenAI.Codex_1.0_x64__example',installLocation:'C:\\retained-package',makerPath:'C:\\retained-package\\app\\resources\\app.asar',makerOffset:1,makerBytes:10,makerSha256:'11'.repeat(32),liveCliWindowsPath:'C:\\Users\\fixture\\AppData\\Local\\OpenAI\\Codex\\bin\\current\\codex.exe',replacements:names.map(name=>({name,path:'C:\\retained-package\\app\\resources\\'+name,sha256:'22'.repeat(32)}))},configGuards:[{path:'C:\\Users\\fixture\\.codex\\config.toml',sha256:'33'.repeat(32)}],targets:names.map((name,i)=>({name,fileIdentity:'1234abcd:'+String(i+1).padStart(16,'0'),allocatedBytes:'4096',logicalBytes:'4',attributes:32,links:1,sha256:'44'.repeat(32),sddlSha256:'55'.repeat(32)}))}}};}
const nonce='ab'.repeat(32);
const render=(p=fixture(),action='retire')=>renderDerivedCodeCacheRequest(JSON.stringify(p),{action,nonce});
test('source request is effect-free and exactly bound through original compressed transport',()=>{
 const r=render(),launcher=Buffer.from(r.encodedCommand,'base64').toString('utf16le'),packed=/FromBase64String\('([^']+)'\)/.exec(launcher)[1];
 assert.equal(inflateRawSync(Buffer.from(packed,'base64')).toString(),r.script);assert.equal(createHash('sha256').update(r.script).digest('hex'),r.scriptSha256);assert.equal(r.effectsExecuted,false);assert.ok(r.encodedCommand.length+256<32767);
});
test('observe may receive unknown content/security but cannot use that declaration to retire',()=>{
 const p=fixture();delete p.windows.derivedCodeCacheRetirement.parentFileIdentity;delete p.windows.derivedCodeCacheRetirement.parentSddlSha256;for(const t of p.windows.derivedCodeCacheRetirement.targets){delete t.sha256;delete t.sddlSha256;}
 assert.equal(render(p,'observe').action,'observe');assert.throws(()=>render(p,'retire'));
});
test('literal Data preserves PowerShell line separators without allowing a here-string terminator',()=>{
 const p=fixture(),value="C:\\fixture\\\u0085'@\u2028Write-Output injected\u2029";p.windows.derivedCodeCacheRetirement.configGuards[0].path=value;
 const r=render(p),literal=/\$expected=@'\n([^\r\n]+)\n'@\|ConvertFrom-Json/.exec(r.script)[1];assert.doesNotMatch(literal,/[\u0085\u2028\u2029\r\n]/);assert.equal(JSON.parse(literal).configGuards[0].path,value);
});
test('exact target, source and path refusals precede native effects',()=>{
 for(const mutate of [q=>q.targets.pop(),q=>q.targets[1].fileIdentity=q.targets[0].fileIdentity,q=>q.targets[0].name='auth.json',q=>q.targets[0].links=2,q=>q.targets[0].attributes=1024,q=>q.targets[0].sha256='changed',q=>q.cacheParentWindowsPath='C:\\ordinary-profile',q=>q.cacheParentWindowsPath='C:\\old\\..\\plugins\\.plugin-appserver',q=>q.producer.replacements[0].path='C:\\different\\codex.exe',q=>q.producer.liveCliWindowsPath=q.cacheParentWindowsPath+'\\codex.exe',q=>q.configGuards=[]]){const p=fixture();mutate(p.windows.derivedCodeCacheRetirement);assert.throws(()=>render(p));}
 assert.throws(()=>derivedCodeCacheDeclaration(fixture(),{action:'sweep'}));assert.throws(()=>renderDerivedCodeCacheRequest(JSON.stringify(fixture()),{action:'retire',nonce:'foreign'}));
});
function outcome(r){return [{phase:'preflight',nonce:r.nonce,parameterSha256:r.parameterSha256},...r.targets.map(t=>({phase:'file-terminal',name:t.name,fileIdentity:t.fileIdentity,nativeAbsenceCode:2,nonce:r.nonce,parameterSha256:r.parameterSha256})),{phase:'terminal',status:'native-terminal-success',nonce:r.nonce,parameterSha256:r.parameterSha256}];}
test('terminal claims bind every exact file; JSON never issues physical recovery',()=>{
 const r=render(),lines=outcome(r),read=x=>receiveDerivedCodeCacheResult(r,x.map(y=>JSON.stringify(y)).join('\n'));assert.equal(read(lines).capacityReopened,false);assert.match(read(lines).nativeEffectReceiving,/same-handle/);
 for(const mutate of [x=>x.splice(1,1),x=>x[1].nativeAbsenceCode=32,x=>x[2].name=x[1].name,x=>x.at(-1).nonce='foreign']){const x=structuredClone(lines);mutate(x);assert.throws(()=>read(x));}
});
test('partial and mark-only results preserve unknown custody without terminal credit',()=>{
 const r=render(),line={phase:'terminal',status:'partial-or-unknown',nonce:r.nonce,parameterSha256:r.parameterSha256};const got=receiveDerivedCodeCacheResult(r,JSON.stringify(line));assert.equal(got.reportedStatus,'partial-or-unknown');assert.equal(got.capacityReopened,false);
 assert.throws(()=>receiveDerivedCodeCacheResult(r,JSON.stringify({...line,phase:'file-marked'})));
});
test('native PowerShell parses full exact leaf and compiles the reused native file primitive', {skip:!existsSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')},()=>{
 const r=render(),native=Buffer.from(/\$nativeSource=@'\n([\s\S]+?)\n'@/.exec(r.script)[1]).toString('base64');
 const ps=String.raw`$ErrorActionPreference='Stop';$j=[Console]::In.ReadToEnd()|ConvertFrom-Json;$tokens=$null;$errors=$null;$null=[Management.Automation.Language.Parser]::ParseInput($j.script,[ref]$tokens,[ref]$errors);if($errors.Count){throw($errors|Out-String)};$native=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($j.native));Add-Type -TypeDefinition $native;@{parserErrors=0;originalNativeClassCompiled=$true;effectsExecuted=$false}|ConvertTo-Json -Compress`;
 const p=spawnSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')],{cwd:'/',input:JSON.stringify({script:r.script,native}),encoding:'utf8'});assert.ifError(p.error);assert.equal(p.status,0,p.stderr);assert.deepEqual(JSON.parse(p.stdout),{parserErrors:0,originalNativeClassCompiled:true,effectsExecuted:false});
});
