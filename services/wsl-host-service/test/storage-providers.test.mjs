import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { observeStorageProviders, planStorageProviders, storageProviderChecks } from '../src/storage-providers.mjs';

function fixture() {
  const volumeId='\\\\?\\Volume{22222222-2222-2222-2222-222222222222}\\';
  const p={schema:'wsl-host-parameters@1',windows:{profileWindowsPath:'C:\\Users\\example',backingStorage:{distributionName:'Example',registryKey:'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{11111111-1111-1111-1111-111111111111}',basePath:'C:\\distros\\example',vhdFileName:'ext4.vhdx',volumeId,powershell:'/mnt/c/Windows/WindowsPowerShell/powershell.exe',wslpath:'/usr/bin/wslpath',linuxMount:'/',timeoutMs:1000,maxAgeMs:2000,policy:{minFreeBytes:'100000000000',minFreePercent:3,growthBytes:'2147483648',overheadBytes:'67108864',basis:'Original reserve unchanged'}},storageProviders:{wslinfo:'/usr/bin/wslinfo',wslExecutableWindowsPath:'C:\\Program Files\\WSL\\wsl.exe',wslVersion:'3.0.3.0',rule:'wsl-3.0.3-user-temp-vm-id',timeoutMs:15000}}};
  const vmId='85B102AD-7E18-4553-8419-04CB9DD1BEAA',nonce='ab'.repeat(32),at='2026-10-27T15:54:18.430Z';
  const result={requestNonce:nonce,vmId,wslVersion:'3.0.3.0',at,providers:[{id:'wsl-swap',status:'received',source:'GetFileInformationByHandleEx/FileCompressionInfo',path:`C:\\Users\\example\\AppData\\Local\\temp\\${vmId}\\swap.vhdx`,volumeId,allocatedBytes:'2285895680',logicalBytes:'2285895680',fileIdentity:'1234abcd:0000000000001234'},{id:'pagefiles',status:'received',source:'Win32_PageFileUsage/MiB',items:[{path:'C:\\pagefile.sys',allocatedMiB:'27179',currentUsageMiB:'4716',peakUsageMiB:'12734'}]},{id:'shadow-storage',status:'unknown',source:'Win32_ShadowStorage/bytes',error:{message:'Initialization failure',code:'HRESULT0x80041014'}},{id:'shadow-copies',status:'unknown',source:'Win32_ShadowCopy/exact-volume',error:{message:'Initialization failure'}},{id:'docker-data',status:'unknown',source:'original owner location',error:{message:'No original source-owned path declared'}}]};
  const calls=[],ports={nonce:()=>nonce,monotonic:()=>100,run:(program,args,timeout)=>{calls.push({program,args,timeout});return program===p.windows.storageProviders.wslinfo?(args[0]==='--version'?'3.0.3.0\n':vmId+'\n'):JSON.stringify(result);}};
  return {p,result,ports,calls,vmId};
}
test('a qualified native point receives swap identity, native MiB and explicit provider errors with zero authority/credit',()=>{
  const f=fixture(),r=observeStorageProviders(f.p,f.ports);
  assert.equal(r.providers[0].allocatedBytes,'2285895680');assert.equal(r.providers[1].items[0].allocatedMiB,'27179');
  assert.equal(r.providers[2].status,'unknown');assert.equal(r.providers[2].error.code,'HRESULT0x80041014');
  assert.equal(r.physicalCapacityCreditBytes,'0');assert.equal(r.historicalAttribution,'unreceived');
  assert.deepEqual(f.calls.map(c=>c.args[0]),['--version','--vm-id','-NoLogo','--vm-id']);
  assert.ok(f.calls.every(c=>c.timeout<=15000));assert.equal('admitted' in r,false);
});
test('native failures remain unknown rows and cannot become zero usage/current',()=>{
  const f=fixture(),r=planStorageProviders(f.p,f.ports);assert.equal(r.current,false);
  assert.deepEqual(r.checks.map(x=>x.ok),[true,true,false,false,false]);assert.match(r.checks[2].have,/unknown: Initialization failure/);
  f.ports.run=()=>{throw new Error('native provider unavailable')};const missing=planStorageProviders(f.p,f.ports);assert.equal(missing.current,false);assert.match(missing.checks[0].have,/unknown: native storage provider wslinfo failed.*native provider unavailable/);
});
test('VM replacement after the Windows point refuses the entire swap join',()=>{
  const f=fixture(),old=f.ports.run;let ids=0;f.ports.run=(p,a,t)=>a[0]==='--vm-id'&&++ids===2?'11111111-1111-1111-1111-111111111111':old(p,a,t);
  assert.throws(()=>observeStorageProviders(f.p,f.ports),/VM changed/);assert.equal(f.calls.filter(c=>c.program===f.p.windows.backingStorage.powershell).length,1);
});
test('unsupported installed version, malformed native VM ID and changed response identity refuse',()=>{
  for(const mutate of [f=>{f.ports.run=()=> '3.0.4.0'},f=>{const old=f.ports.run;f.ports.run=(p,a,t)=>a[0]==='--vm-id'?'not-vm':old(p,a,t)},f=>f.result.vmId='foreign',f=>f.result.wslVersion='3.0.4.0',f=>f.result.requestNonce='cd'.repeat(32)]){
    const f=fixture();mutate(f);assert.throws(()=>observeStorageProviders(f.p,f.ports));
  }
});
test('wrong swap volume, malformed allocations and incomplete provider sets refuse rather than infer',()=>{
  for(const mutate of [f=>f.result.providers[0].volumeId='other',f=>f.result.providers[0].allocatedBytes='unknown',f=>delete f.result.providers[0].fileIdentity,f=>f.result.providers.pop(),f=>delete f.result.at,f=>f.result.providers[1].items[0].allocatedMiB=27179]){
    const f=fixture();mutate(f);assert.throws(()=>observeStorageProviders(f.p,f.ports));
  }
});
test('native received zero shadow rows is distinct from an unreadable shadow provider',()=>{
  const f=fixture();f.result.providers[2]={id:'shadow-storage',source:'Win32_ShadowStorage/bytes',status:'received',items:[]};
  const r=observeStorageProviders(f.p,f.ports);assert.equal(r.providers[2].status,'received');assert.deepEqual(r.providers[2].items,[]);
  assert.equal(storageProviderChecks(r)[2].ok,true);assert.equal(storageProviderChecks(r)[3].ok,false);
});
test('an empty received Docker row cannot assert an undeclared source-owned location',()=>{
  const f=fixture();Object.assign(f.result.providers[4],{status:'received',items:[]});assert.throws(()=>observeStorageProviders(f.p,f.ports),/undeclared Docker/);
});
function dockerFixture() {
  const f=fixture(),volumeId=f.p.windows.backingStorage.volumeId;
  const artifacts=[{name:'boot',path:String.raw`C:\Docker\boot.vhdx`,volumeId},{name:'data',path:String.raw`C:\Docker\data.vhdx`,volumeId}];
  f.p.windows.storageProviders.dockerData={rule:'declared-native-docker-artifacts-v1',artifacts};
  Object.assign(f.result.providers[4],{status:'received',scope:'selected-declared-artifacts-only',items:artifacts.map((a,i)=>({...a,fileIdentity:'1234abcd:000000000000123'+i,logicalBytes:'4096',allocatedBytes:'4096',attributes:32}))});
  return f;
}
test('declared Docker artifacts expose fresh native allocations with explicit selected scope and zero authority',()=>{
  const f=dockerFixture(),point=observeStorageProviders(f.p,f.ports);
  assert.equal(point.providers[4].items.length,2);
  assert.match(storageProviderChecks(point)[4].have,/selected declared artifact.*scope=selected-declared-artifacts-only/);
  assert.equal(point.physicalCapacityCreditBytes,'0');assert.equal('admitted' in point,false);
});
test('invalid and duplicate Docker selections refuse before any native observation',()=>{
  for(const mutate of [f=>f.p.windows.storageProviders.dockerData.rule='guess',f=>f.p.windows.storageProviders.dockerData.artifacts[0].path='relative.vhdx',f=>f.p.windows.storageProviders.dockerData.artifacts[0].volumeId='foreign',f=>f.p.windows.storageProviders.dockerData.artifacts.push({...f.p.windows.storageProviders.dockerData.artifacts[0]})]){
    const f=dockerFixture();mutate(f);assert.throws(()=>observeStorageProviders(f.p,f.ports));assert.equal(f.calls.length,0);
  }
});
test('native extended drive and volume-GUID artifact paths preserve the exact selected spelling',()=>{
  for(const path of [String.raw`\\?\C:\Docker\boot.vhdx`,String.raw`\\?\Volume{22222222-2222-2222-2222-222222222222}\Docker\boot.vhdx`]){
    const f=dockerFixture();f.p.windows.storageProviders.dockerData.artifacts[0].path=path;f.result.providers[4].items[0].path=path;
    assert.equal(observeStorageProviders(f.p,f.ports).providers[4].items[0].path,path);
  }
  for(const path of [String.raw`\\remote\share\boot.vhdx`,String.raw`Volume{22222222-2222-2222-2222-222222222222}\boot.vhdx`,String.raw`\\?\C:\Docker\..\boot.vhdx`,String.raw`\\?\C:\Docker\*.vhdx`,String.raw`C:\Docker\boot.vhdx:stream`,String.raw`C:\Docker/../outside.vhdx`,String.raw`C:\Docker/boot.vhdx`]){
    const f=dockerFixture();f.p.windows.storageProviders.dockerData.artifacts[0].path=path;assert.throws(()=>observeStorageProviders(f.p,f.ports));assert.equal(f.calls.length,0);
  }
});
test('Docker points cannot replace selected paths, borrow volumes, omit observations or double count hardlinks',()=>{
  for(const mutate of [f=>f.result.providers[4].items[0].path=String.raw`C:\other.vhdx`,f=>f.result.providers[4].items[0].volumeId='foreign',f=>f.result.providers[4].items.pop(),f=>f.result.providers[4].items[1].fileIdentity=f.result.providers[4].items[0].fileIdentity,f=>delete f.result.providers[4].scope,f=>f.result.providers[4].items[0].attributes=1024,f=>f.result.providers[4].items[0].allocatedBytes='unknown']){
    const f=dockerFixture();mutate(f);assert.throws(()=>observeStorageProviders(f.p,f.ports));
  }
});
test('missing or inaccessible selected Docker artifacts remain unknown without a fabricated zero',()=>{
  const f=dockerFixture();f.result.providers[4]={id:'docker-data',source:'native declared artifacts',status:'unknown',error:{message:'Native file not found'}};
  const point=observeStorageProviders(f.p,f.ports);assert.equal(point.providers[4].status,'unknown');assert.equal('items' in point.providers[4],false);
  assert.equal(storageProviderChecks(point)[4].ok,false);assert.equal(point.physicalCapacityCreditBytes,'0');
});
test('shadow storage and copies cannot borrow another native volume',()=>{
  for(const id of ['shadow-storage','shadow-copies']){
    const f=fixture(),row=f.result.providers.find(x=>x.id===id);Object.assign(row,{status:'received',items:[id==='shadow-storage'?{volume:'foreign',diffVolume:'foreign',usedBytes:'0',allocatedBytes:'0',maxBytes:'0'}:{id:'copy',volume:'foreign'}]});
    assert.throws(()=>observeStorageProviders(f.p,f.ports),/target changed/);
  }
});
test('configuration and observation clocks are bounded before dependent native calls',()=>{
  for(const change of [f=>f.p.windows.storageProviders.rule='guess-temp',f=>f.p.windows.storageProviders.wslVersion='3.0.4.0',f=>f.p.windows.storageProviders.timeoutMs=99999,f=>f.p.windows.storageProviders.wslinfo='wslinfo',f=>f.p.windows.storageProviders.mutation=true]){
    const f=fixture();change(f);assert.throws(()=>observeStorageProviders(f.p,f.ports));assert.equal(f.calls.length,0);
  }
  const f=fixture();let reads=0;f.ports.monotonic=()=>reads++?15101:100;assert.throws(()=>observeStorageProviders(f.p,f.ports),/deadline/);assert.equal(f.calls.length,0);
});
test('native Windows argument limit and error output remain bounded without another dispatch',()=>{
  const f=fixture();observeStorageProviders(f.p,f.ports);const native=f.calls.find(c=>c.program===f.p.windows.backingStorage.powershell);assert.ok(native.args.at(-1).length+f.p.windows.backingStorage.powershell.length+128<32767);const launcher=Buffer.from(native.args.at(-1),'base64').toString('utf16le'),packed=/FromBase64String\('([^']+)'\)/.exec(launcher)[1],source=inflateRawSync(Buffer.from(packed,'base64'));assert.ok(launcher.includes(createHash('sha256').update(source).digest('hex')));assert.ok(launcher.includes(source.length.toString()));
  const bad=fixture();bad.p.windows.profileWindowsPath='C:\\'+ 'a'.repeat(4200);assert.throws(()=>observeStorageProviders(bad.p,bad.ports),/Windows profile/);assert.equal(bad.calls.length,0);
  const g=fixture();g.ports.run=()=>{throw Object.assign(new Error('secret command arguments'),{status:1,stderr:'native refusal '+ 'x'.repeat(10000)})};
  let received;try{observeStorageProviders(g.p,g.ports)}catch(e){received=e;}
  assert.ok(received.message.length<2200);assert.doesNotMatch(received.message,/secret command/);assert.equal(received.cause.status,1);
});
test('PowerShell receives exact configured profile/record and original helper, not a directory search or mutable operation',()=>{
  const f=fixture();observeStorageProviders(f.p,f.ports);const c=f.calls.find(c=>c.program===f.p.windows.backingStorage.powershell);
  const launcher=Buffer.from(c.args.at(-1),'base64').toString('utf16le');const script=inflateRawSync(Buffer.from(/FromBase64String\('([^']+)'\)/.exec(launcher)[1],'base64')).toString();
  assert.match(script,/class WslBackingFileAllocation/);assert.match(script,/-ClassName Win32_ShadowStorage/);assert.match(script,/Original distribution registration changed/);
  assert.match(script,/configured absolute swapFile/);assert.match(script,/LocalApplicationData/);assert.match(script,/WSL configuration changed/);
  assert.doesNotMatch(script,/Get-ChildItem|Remove-Item|Set-Item|Start-Service|Stop-Service|wsl\.exe --|compact|fstrim|Get-Volume/);
  assert.ok(script.includes(readFileSync(new URL('../assets/observe-storage-providers.ps1',import.meta.url),'utf8')));
});
test('ordinary and selected plan expose provider observations while capacity producer has no provider call',()=>{
  const cli=readFileSync(new URL('../scripts/wsl-host.mjs',import.meta.url),'utf8');assert.match(cli,/component === 'storage-providers'/);assert.match(cli,/params\.windows\?\.storageProviders/);assert.match(cli,/\.\.\.storageProviders/);
  const capacity=readFileSync(new URL('../src/backing-capacity.mjs',import.meta.url),'utf8');assert.doesNotMatch(capacity,/storage-providers|ShadowStorage|PageFileUsage|wslinfo/);
});
test('actual PowerShell same resolver receives default/explicit/native suffix and refuses unsafe configured paths without file effects', {skip:!existsSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')},()=>{
  const vmId='85B102AD-7E18-4553-8419-04CB9DD1BEAA', appData='C:\\Users\\fixture\\AppData\\Local';
  const cases=[
    {id:'default-live-guid-rule',config:'[wsl2]\nmemory=12GB',expected:`${appData}\\temp\\${vmId}\\swap.vhdx`},
    {id:'explicit-vhdx',config:'[wsl2]\nswapFile=C:\\Data\\custom.vhdx',expected:'C:\\Data\\custom.vhdx'},
    {id:'escaped-config-path',config:'[wsl2]\nswapFile=C:\\\\Data\\\\custom.vhdx',expected:'C:\\Data\\custom.vhdx'},
    {id:'native-appended-suffix',config:'[wsl2]\nswapFile=C:\\Data\\custom.img',expected:'C:\\Data\\custom.img.vhdx'},
    {id:'relative',config:'[wsl2]\nswapFile=relative.vhdx'},
    {id:'wildcard',config:'[wsl2]\nswapFile=C:\\Data\\*.vhdx'},
    {id:'parent-traversal',config:'[wsl2]\nswapFile=C:\\Data\\..\\custom.vhdx'},
    {id:'duplicate',config:'[wsl2]\nswapFile=C:\\a.vhdx\nswapFile=C:\\b.vhdx'},
    {id:'empty',config:'[wsl2]\nswapFile='}
  ];
  const script=String.raw`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$j=[Console]::In.ReadToEnd()|ConvertFrom-Json;$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($j.asset,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Original asset parser refusal'}
$f=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Resolve-WslSwapPath'},$true)
if(-not $f){throw 'Original resolver missing'}
. ([scriptblock]::Create($f.Extent.Text))
$received=@(foreach($case in $j.cases){
 $thrown=$false;$value=$null;try{$value=Resolve-WslSwapPath $case.config $j.appData $j.vmId}catch{$thrown=$true}
 if($null -ne $case.expected){if($thrown -or $value.path -cne $case.expected){throw ('Resolver failed '+$case.id)}}elseif(-not $thrown){throw ('Unsafe path accepted '+$case.id)}
 @{id=$case.id;passed=$true}
})
$received|ConvertTo-Json -Compress`;
  const r=spawnSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{input:JSON.stringify({asset:readFileSync(new URL('../assets/observe-storage-providers.ps1',import.meta.url),'utf8'),cases,vmId,appData}),encoding:'utf8',cwd:'/',timeout:10000,maxBuffer:16384});
  assert.ifError(r.error);assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),cases.map(x=>({id:x.id,passed:true})));
});

test('pending swap activation is declaration-bound and never grants new admission or capacity credit',()=>{
 const f=fixture(),toWindowsPath=String.raw`C:\Users\example\AppData\Local\wsl\swap.vhdx`;f.p.windows.storageProviders.swapFileTransition={fromVmId:f.vmId,fromFileIdentity:f.result.providers[0].fileIdentity,toWindowsPath};Object.assign(f.result.providers[0],{activation:'pending-next-VM',configuredPath:toWindowsPath});const point=observeStorageProviders(f.p,f.ports);assert.match(storageProviderChecks(point)[0].have,/pending-next-VM; configured/);assert.equal(point.physicalCapacityCreditBytes,'0');assert.equal('admitted'in point,false);
 for(const change of [g=>g.p.windows.storageProviders.swapFileTransition.fromVmId='bad',g=>g.p.windows.storageProviders.swapFileTransition.toWindowsPath='relative.vhdx',g=>g.p.windows.storageProviders.swapFileTransition.extra=true]){const g=fixture();g.p.windows.storageProviders.swapFileTransition={...f.p.windows.storageProviders.swapFileTransition};change(g);assert.throws(()=>observeStorageProviders(g.p,g.ports));assert.equal(g.calls.length,0);}
 for(const change of [g=>g.result.providers[0].fileIdentity='1234abcd:0000000000009999',g=>g.result.providers[0].activation='configured-new-VM',g=>g.result.providers[0].configuredPath=String.raw`C:\Other.vhdx`]){const g=fixture();g.p.windows.storageProviders.swapFileTransition={...f.p.windows.storageProviders.swapFileTransition};Object.assign(g.result.providers[0],{activation:'pending-next-VM',configuredPath:toWindowsPath});change(g);assert.throws(()=>observeStorageProviders(g.p,g.ports));}
});
test('actual PowerShell SAME activation selector distinguishes current live swap from future config and replacement VM', {skip:!existsSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')},()=>{
 const vm='85B102AD-7E18-4553-8419-04CB9DD1BEAA',next='11111111-1111-1111-1111-111111111111',appData=String.raw`C:\Users\fixture\AppData\Local`,stable=[appData,'wsl','swap.vhdx'].join(String.fromCharCode(92)),active=[appData,'temp',vm,'swap.vhdx'].join(String.fromCharCode(92)),transition={fromVmId:vm,fromFileIdentity:'1234abcd:0000000000001234',toWindowsPath:stable},config='[wsl2]\nmemory=12GB\nswapFile='+stable.replaceAll('\\','\\\\');
 const cases=[{id:'before-config-write',vm,config:'[wsl2]\nmemory=12GB',path:active,activation:'configuration-staged'}, {id:'same-live-vm-after-config-write',vm,config,path:active,activation:'pending-next-VM'}, {id:'new-native-vm',vm:next,config,path:stable,activation:'configured-new-VM'}, {id:'same-vm-unexpected-config',vm,config:'[wsl2]\nswapFile='+String.raw`C:\Other.vhdx`}, {id:'new-vm-missing-config',vm:next,config:'[wsl2]\nmemory=12GB'}];
 const script=String.raw`$ErrorActionPreference='Stop';$j=[Console]::In.ReadToEnd()|ConvertFrom-Json;$t=$null;$e=$null;$a=[Management.Automation.Language.Parser]::ParseInput($j.asset,[ref]$t,[ref]$e);if($e.Count){throw($e|Out-String)};foreach($name in @('Resolve-WslSwapPath','Resolve-ActiveWslSwapPath')){$f=$a.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true);. ([scriptblock]::Create($f.Extent.Text))};$rows=@(foreach($case in $j.cases){$ok=$false;$value=$null;try{$value=Resolve-ActiveWslSwapPath $case.config $j.appData $case.vm $j.transition;$ok=$true}catch{};if($null -ne $case.path){if(-not $ok -or $value.path -cne $case.path -or $value.activation -cne $case.activation -or $value.configuredPath -cne $j.transition.toWindowsPath){throw('Activation mismatch '+$case.id)};if($case.vm -ceq $j.transition.fromVmId -and $value.expectedFileIdentity -cne $j.transition.fromFileIdentity){throw 'Original live identity not bound'}}elseif($ok){throw('Unreceived config accepted '+$case.id)};@{id=$case.id;received=$value}});$rows|ConvertTo-Json -Depth 8 -Compress`;
 const r=spawnSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{input:JSON.stringify({asset:readFileSync(new URL('../assets/observe-storage-providers.ps1',import.meta.url),'utf8'),cases,transition,appData}),encoding:'utf8',cwd:'/',timeout:10000,maxBuffer:16384});assert.ifError(r.error);assert.equal(r.status,0,r.stderr);const rows=JSON.parse(r.stdout);assert.deepEqual(rows.map(x=>x.id),cases.map(x=>x.id));assert.equal(rows[1].received.expectedFileIdentity,transition.fromFileIdentity);assert.equal('expectedFileIdentity'in rows[2].received,false);
});
