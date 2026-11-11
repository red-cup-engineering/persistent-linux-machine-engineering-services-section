import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderNativeCompaction, nativeCompactionQualification } from '../src/native-compaction.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
function fixture() {
  const p = { schema: 'wsl-host-parameters@1', windows: { backingStorage: {
    distributionName: 'Example', registryKey: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{11111111-1111-1111-1111-111111111111}',
    basePath: 'D:\\distros\\example', vhdFileName: 'ext4.vhdx', volumeId: '\\\\?\\Volume{22222222-2222-2222-2222-222222222222}\\',
    powershell: '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', wslpath: '/usr/bin/wslpath', linuxMount: '/', timeoutMs: 1000, maxAgeMs: 2000,
    policy: { minFreeBytes: '100000000000', minFreePercent: 3, growthBytes: '2147483648', overheadBytes: '67108864', basis: 'Original absolute physical floor plus estimated growth and metadata' }
  }, nativeCompaction: { adapter: nativeCompactionQualification.adapter, ownerSid: 'S-1-5-21-1-2-3-999999', custodyDirectory: 'C:\\Users\\Example\\maintenance', deadlineMs: 3600000, maxOutputBytes: 131072 } } };
  const admission = { type: 'WslNativeCompactionAdmission', version: 1, request: '11111111-1111-1111-1111-111111111111',
    parameterSha256: '', notBefore: '2026-10-23T00:00:00.000Z', expiresAt: '2026-10-23T00:10:00.000Z', concurrentPeakBytes: '4563402752',
    resources: ['authority','checkpoint','independent-receiving'].map(role => ({ role, path: 'C:\\Users\\Example\\maintenance\\'+role+'.json', sha256: hash(role) })) };
  const render = () => { const text = JSON.stringify(p); admission.parameterSha256 = hash(text); return renderNativeCompaction(text, JSON.stringify(admission)); };
  return { p, admission, render };
}
test('received adapter renders exact selected native invocation without executing or reopening capacity', () => {
  const f = fixture(), result = f.render();
  assert.equal(result.effectsExecuted, false); assert.equal(result.capacityReopened, false);
  assert.equal(result.scriptSha256, hash(result.script));
  const encoded = /FromBase64String\('([^']+)'\)/.exec(result.script)[1];
  const packet = JSON.parse(Buffer.from(encoded,'base64').toString());
  assert.deepEqual(packet.invocation, { executable: nativeCompactionQualification.executable, arguments: '--manage Example --compact' });
  assert.equal(packet.admission.concurrentPeakBytes, '4563402752');
  assert.equal(hash(packet.admissionText), packet.admissionSha256);
  assert.deepEqual(packet.qualification.sourceBlobs, nativeCompactionQualification.sourceBlobs);
});
test('changed original record refuses even with syntactically complete admission', () => {
  const f = fixture();f.render();f.p.windows.backingStorage.distributionName='Other';
  assert.throws(()=>renderNativeCompaction(JSON.stringify(f.p),JSON.stringify(f.admission)),/changed original parameter/);
});
test('existing low-floor legacy records cannot silently authorize maintenance or weaken fabrication', () => {
  const f = fixture();f.p.windows.backingStorage.policy.minFreeBytes='0';
  assert.throws(f.render,/positive physical reserve/);
});
test('native maintenance preserves the exact declared reserve instead of substituting a housekeeping threshold', () => {
  const f=fixture();f.p.windows.backingStorage.policy.minFreeBytes='30000000000';
  const original=structuredClone(f.p.windows.backingStorage.policy),result=f.render(),packet=JSON.parse(result.packetText);
  assert.deepEqual(packet.target.policy,original);
  assert.equal(packet.admission.concurrentPeakBytes,'4563402752');
  assert.equal(result.capacityReopened,false);
  f.p.windows.backingStorage.policy.growthBytes='2147483649';
  assert.throws(()=>renderNativeCompaction(JSON.stringify(f.p),JSON.stringify(f.admission)),/changed original parameter/);
});
test('parent and reentry receive the exact ordinary capacity producer without an alternate volume lookup', () => {
  const result=fixture().render(),packet=JSON.parse(result.packetText);
  const original=readFileSync(new URL('../assets/observe-backing-capacity.ps1',import.meta.url),'utf8');
  assert.equal(packet.backingObservation.source,original);
  assert.equal(packet.backingObservation.sourceSha256,hash(original));
  assert.doesNotMatch(result.script,/Get-Volume -FilePath/);
  assert.match(result.script,/Receive-MaintenanceBackingTarget \$packet/);
  assert.match(result.script,/Original capacity read deadline/);
});
test('historical provider, booleans and missing checkpoint are insufficient admission', () => {
  for(const mutate of [f=>delete f.p.windows.nativeCompaction,f=>f.p.windows.nativeCompaction.adapter='diskpart',f=>f.admission.resources.pop(),f=>f.admission.resources[1]={role:'checkpoint',approved:true},f=>f.admission.resources[1].role='authority']) {
    const f=fixture();mutate(f);assert.throws(f.render);
  }
});
test('resource aliases, escaped Windows paths and target command injection refuse before rendering', () => {
  for(const mutate of [f=>f.admission.resources[1].path=f.admission.resources[0].path,
    f=>f.admission.resources[1].path='C:\\Users\\Example\\maintenance-other\\checkpoint.json',
    f=>f.admission.resources[1].path='C:\\Users\\Example\\maintenance\\..\\checkpoint.json',
    f=>f.p.windows.nativeCompaction.custodyDirectory='\\\\wsl.localhost\\Example\\root',
    f=>f.p.windows.nativeCompaction.custodyDirectory='C:\\Users\\Example\\maintenance. ',
    f=>f.p.windows.backingStorage.distributionName='Example --shutdown']) {
    const f=fixture();mutate(f);assert.throws(f.render);
  }
});
test('impossible dates, indefinite checkpoints and unbounded evidence or native allocation refuse', () => {
  for(const mutate of [f=>f.admission.notBefore='2026-02-30T00:00:00.000Z',f=>f.admission.expiresAt='2026-10-24T00:00:00.000Z',f=>f.admission.expiresAt=f.admission.notBefore,
    f=>f.p.windows.nativeCompaction.deadlineMs=Infinity,f=>f.p.windows.nativeCompaction.maxOutputBytes=131073,f=>f.admission.concurrentPeakBytes='-1']) {
    const f=fixture();mutate(f);assert.throws(f.render);
  }
});

// Native qualification parses the actual entire parent and compiles its actual
// C# await/identity helper; a deliberately wrong holder must refuse before any
// path, custody, WSL child or maintenance effect. No simulated Windows actuator.
const powershell='/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
test('actual Windows metadata receiver rejects changed identity, stale challenge, overflow and late reads without a maintenance child', {skip:!existsSync(powershell)}, () => {
  const helper=readFileSync(new URL('../assets/receive-backing-target.ps1',import.meta.url),'utf8');
  // This producer is a controlled metadata port, not a WSL actuator. The
  // ordinary capacity suite separately qualifies the real registry/handle API.
  const producer=`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$sample=@{requestNonce=$expected.requestNonce;at=[DateTime]::UtcNow.ToString('o');distribution=@{name=$expected.distributionName;basePath=$expected.basePath;vhdFileName=$expected.vhdFileName};volume=@{id=$expected.volumeId;totalBytes='100000';availableBytes='1500';volumeFreeBytes='1500';callerAvailableBytes='2000';allocationUnitBytes='4096'};vhd=@{path=[IO.Path]::Combine($expected.basePath,$expected.vhdFileName);lengthBytes='50000';allocatedBytes='40960';allocationSource='GetFileInformationByHandleEx/FileCompressionInfo';fileIdentity='1234abcd:0000000000001234';attributes=32;sparse=$false;compressed=$false}}
VARIATION
$sample|ConvertTo-Json -Depth 5 -Compress`;
  const cases=[
    ['received','',null],
    ['diagnostic',"[Console]::Error.Write('bounded metadata diagnostic')",null],
    ['different-volume',"$sample.volume.id='wrong'",'registered backing target'],
    ['wrong-challenge',"$sample.requestNonce='0'*64",'another request'],
    ['invalid-producer-time',"$sample.at='not a timestamp'",'producer timestamp'],
    ['quota-drift',"$sample.volume.availableBytes='2000'",'capacity is inconsistent'],
    ['redirected-file',"$sample.vhd.attributes=1024",'native VHD identity'],
    ['overflow',"[Console]::Out.Write(('x'*40000))",'evidence exceeded'],
    ['late-read','[Threading.Thread]::Sleep(2000)','capacity read deadline'],
    ['changed-source','', 'observer source changed'],
    ['allocated-changed',"$sample.vhd.allocatedBytes='32768'",null],
  ].map(([name,variation,error])=>{
    const target=fixture().p.windows.backingStorage;target.timeoutMs=name==='late-read'?100:10000;target.maxAgeMs=30000;
    const source=producer.replace('VARIATION',variation);
    return {name,error,selected:{target,backingObservation:{source,sourceSha256:name==='changed-source'?'0'.repeat(64):hash(source)}}};
  });
  const script="$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';$qualificationFixture=[Console]::In.ReadToEnd()|ConvertFrom-Json;Invoke-Expression $qualificationFixture.helper;$results=@();foreach($case in $qualificationFixture.cases){try{$received=Receive-MaintenanceBackingTarget $case.selected;$results+=@{name=$case.name;ok=$true;received=$received}}catch{$results+=@{name=$case.name;ok=$false;error=$_.Exception.Message}}};ConvertTo-Json -InputObject $results -Depth 10 -Compress";
  const raw=execFileSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{input:JSON.stringify({helper,cases}),encoding:'utf8',cwd:'/',timeout:60000,maxBuffer:32768});
  const results=JSON.parse(raw);assert.equal(results.length,cases.length);
  for(let i=0;i<cases.length;i++){
    assert.equal(results[i].name,cases[i].name);
    assert.equal(results[i].ok,cases[i].error===null,JSON.stringify(results[i]));
    if(cases[i].error)assert.match(results[i].error,new RegExp(cases[i].error));
    else {
      assert.equal(results[i].received.FileIdentity,'1234abcd:0000000000001234');
      assert.equal(results[i].received.LengthBytes,'50000');
      assert.equal(results[i].received.AllocatedBytes,cases[i].name==='allocated-changed'?'32768':'40960');
      assert.equal(results[i].received.AllocationSource,'GetFileInformationByHandleEx/FileCompressionInfo');
      assert.equal(results[i].received.Attributes,32);
      assert.equal(results[i].received.Sparse,false);
      assert.equal(results[i].received.Compressed,false);
      assert.ok(Date.parse(results[i].received.ObservedAt)>0);
      assert.match(results[i].received.RequestNonce,/^[a-f0-9]{64}$/);
      assert.equal(results[i].received.ObserverSourceSha256,cases[i].selected.backingObservation.sourceSha256);
    }
  }
});
test('actual pre-dispatch receiving refuses when target observation crosses admission expiry', {skip:!existsSync(powershell)}, () => {
  const source=readFileSync(new URL('../assets/native-compact.ps1',import.meta.url),'utf8');
  const script="$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';$source=[Console]::In.ReadToEnd();$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Native parent parse failed'};$guard=$ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Receive-DispatchTarget'},$true);if($guard.Count -ne 1){throw 'Original dispatch guard is unavailable'};Invoke-Expression $guard[0].Extent.Text;$script:expired=$false;$script:receivings=0;$script:dispatches=0;function Receive-Resources{$script:receivings++;if($script:expired){throw 'Original fresh maintenance admission expired'}};function Receive-Target{$script:expired=$true;return @{FileIdentity='1234abcd:0000000000001234'}};try{Receive-DispatchTarget @{FileIdentity='1234abcd:0000000000001234'};$script:dispatches++;throw 'Unexpected maintenance dispatch'}catch{if($_.Exception.Message -cne 'Original fresh maintenance admission expired'){throw}};@{receivings=$script:receivings;dispatches=$script:dispatches}|ConvertTo-Json -Compress";
  const raw=execFileSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{input:source,encoding:'utf8',cwd:'/',timeout:30000,maxBuffer:32768});
  assert.deepEqual(JSON.parse(raw),{receivings:2,dispatches:0});
});
test('actual Windows parser, native helper compilation and wrong-holder refusal', {skip:!existsSync(powershell)}, () => {
  const source=fixture().render().script;
  const prefix="$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';";
  const parse=prefix+"$text=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));$tokens=$null;$errors=$null;$null=[Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors);if($errors.Count){$errors|ForEach-Object {Write-Output $_.Message};exit 1};try {Invoke-Expression $text;throw 'Unexpected maintenance dispatch'}catch {if($_.Exception.Message -notlike '*Actual Windows holder identity differs*'){throw};Write-Output 'Actual native parent parsed, helper compiled, holder refused before effects'}";
  const output=execFileSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(parse,'utf16le').toString('base64')],{input:Buffer.from(source).toString('base64'),encoding:'utf8',cwd:'/',timeout:30000,maxBuffer:32768});
  assert.match(output,/holder refused before effects/);
});
test('actual native await retains terminal failure after deadline and drains overflowing streams without killing or retrying', {skip:!existsSync(powershell)}, () => {
  const logs=fileURLToPath(new URL('../data/logs/',import.meta.url));mkdirSync(logs,{recursive:true});
  const directory=mkdtempSync(logs+'native-compaction-await-');
  try {
    const nativeDirectory=execFileSync('/usr/bin/wslpath',['-w',directory],{encoding:'utf8',cwd:'/'}).trim();
    const source=readFileSync(new URL('../assets/native-compact.ps1',import.meta.url),'utf8');
    const helper=/Add-Type -TypeDefinition @'\n([\s\S]+?)\n'@/.exec(source)[1];
    const child="[Console]::Out.Write(('x'*8192));[Console]::Error.Write(('e'*8192));Start-Sleep -Milliseconds 250;exit 17";
    const input=JSON.stringify({helper,directory:nativeDirectory,args:'-NoLogo -NoProfile -NonInteractive -EncodedCommand '+Buffer.from(child,'utf16le').toString('base64')});
    const script="$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';$test=[Console]::In.ReadToEnd()|ConvertFrom-Json;Add-Type -TypeDefinition $test.helper;$outcome=[WslMaintenanceNative]::Await('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',$test.args,$test.directory,1,1024);$outcome|ConvertTo-Json -Depth 8 -Compress";
    const output=execFileSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{input,encoding:'utf8',cwd:'/',timeout:30000,maxBuffer:32768});
    const outcome=JSON.parse(output);
    assert.equal(outcome.Exit,17);assert.equal(outcome.WithinDeadline,false);
    assert.ok(Date.parse(outcome.TerminalAt)-Date.parse(outcome.StartedAt)>=250);
    assert.equal(outcome.Stdout.Overflow,true);assert.equal(outcome.Stderr.Overflow,true);
    assert.equal(outcome.Stdout.Error,null);assert.equal(outcome.Stderr.Error,null);assert.equal(outcome.PidError,null);
    assert.equal(readFileSync(directory+'/stdout.bin').length,1024);assert.equal(readFileSync(directory+'/stderr.bin').length,1024);
    assert.equal(JSON.parse(readFileSync(directory+'/native-pid.json')).pid,outcome.Pid);
  } finally {rmSync(directory,{recursive:true,force:true});}
});
