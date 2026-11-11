import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeBackingVolumeCapacity, assessBackingVolumeHeadroom } from '../src/backing-capacity.mjs';

const now = Date.parse('2026-10-19T20:00:00.000Z');
const MOUNTINFO = '137 88 0:69 / /mnt/d rw,noatime - 9p D:\\134 rw,aname=drvfs;path=D:\\;uid=1000;gid=1000\n';
function fixture() {
  const p = { schema: 'wsl-host-parameters@1', windows: { backingStorage: {
    distributionName: 'Example', registryKey: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{11111111-1111-1111-1111-111111111111}',
    basePath: 'D:\\distros\\example', vhdFileName: 'ext4.vhdx', volumeId: '\\\\?\\Volume{22222222-2222-2222-2222-222222222222}\\',
    powershell: '/mnt/d/Windows/WindowsPowerShell/powershell.exe', wslpath: '/usr/bin/wslpath', linuxMount: '/', volumeMount: '/mnt/d', timeoutMs: 1000, maxAgeMs: 2000,
    policy: { minFreeBytes: '0', minFreePercent: 3, growthBytes: '2048', overheadBytes: '64', basis: 'Explicit estimated metadata allowance, not reservation' }
  } } };
  const volume = { bsize: 4096n, blocks: 25n, bfree: 1n, bavail: 1n };
  const file = { size: 50000n, blocks: 80n, dev: 69n, ino: 0x1234n, isFile: () => true, isSymbolicLink: () => false };
  const calls = [], stats = [], ports = { now: () => now, monotonic: () => 100, nonce: () => '0a'.repeat(32), osRelease: () => 'microsoft-standard-WSL2', environment: { WSL_DISTRO_NAME: 'Example' },
    deviceOf: path => ({ real: path, device: '77' }), mountinfo: () => MOUNTINFO,
    statfs: path => { stats.push(path); return volume; }, lstat: path => { stats.push(path); return file; },
    run: (program, args) => { calls.push({program,args}); return '\\\\wsl.localhost\\Example\\\n'; } };
  return { p, volume, file, calls, stats, ports };
}
test('drvfs statfs and stat produce physical capacity without any Windows process', () => {
  const f = fixture(), r = observeBackingVolumeCapacity(f.p, ['/gnu/store', '/var/tmp'], f.ports);
  assert.equal(r.type, 'WslBackingVolumeCapacity'); assert.equal(r.at, new Date(now).toISOString());
  assert.equal(r.mappings.length, 2); assert.equal(r.volumes[0].totalBytes, '102400'); assert.equal(r.volumes[0].availableBytes, '4096');
  assert.equal(r.volumes[0].allocationUnitBytes, '4096'); assert.equal(r.volumes[0].policy.minFreePercent, 3);
  assert.equal(r.admissionKind, 'snapshot-not-reservation');
  assert.deepEqual(f.calls.map(c => c.program), ['/usr/bin/wslpath'], 'only the native wslpath runs');
  assert.deepEqual(f.stats, ['/mnt/d', '/mnt/d/distros/example/ext4.vhdx']);
  assert.equal(r.volumes[0].vhd.path, 'D:\\distros\\example\\ext4.vhdx'); assert.equal(r.volumes[0].vhd.fileIdentity, '00000045:0000000000001234');
});
test('caller quota is independently limiting and cannot be replaced by larger volume free space',()=>{
  const f=fixture();f.volume.bfree=10n;f.volume.bavail=2n;
  const v=observeBackingVolumeCapacity(f.p,['/'],f.ports).volumes[0];
  assert.equal(v.availableBytes,'8192');assert.equal(v.volumeFreeBytes,'40960');assert.equal(v.callerAvailableBytes,'8192');
});
test('logical VHD length and actual allocation remain separate snapshot evidence',()=>{
  const f=fixture();f.file.size=900000000000n;f.file.blocks=80n;
  const observed=observeBackingVolumeCapacity(f.p,['/'],f.ports);
  assert.equal(observed.volumes[0].vhd.lengthBytes,'900000000000');assert.equal(observed.volumes[0].vhd.allocatedBytes,'40960');
  assert.equal(observed.volumes[0].vhd.sparse,true);assert.equal(observed.volumes[0].vhd.attributes,512);
  assert.equal(assessBackingVolumeHeadroom(observed)[0].admitted,false,'large sparse length does not supply physical free space');
  f.file.blocks=100n;f.file.size=40960n;assert.equal(observeBackingVolumeCapacity(f.p,['/'],f.ports).volumes[0].vhd.sparse,false);
});
test('impossible volume and VHD observations refuse rather than fabricate free space',()=>{
  for(const change of [f=>f.volume.bsize=0n,f=>f.volume.blocks=0n,f=>f.volume.bavail=26n,f=>f.file.size=0n,f=>f.file.blocks=1000000n,f=>f.file.isFile=()=>false,f=>f.file.isSymbolicLink=()=>true]) {
    const f=fixture();change(f);assert.throws(()=>observeBackingVolumeCapacity(f.p,['/'],f.ports));
  }
});
test('the declared volume mount must be a drvfs mount of the whole volume that holds the VHD',()=>{
  for(const mountinfo of ['', '137 88 0:69 / /mnt/d rw - ext4 /dev/sdb rw\n', '137 88 0:69 / /mnt/d rw - 9p D:\\134sub rw,aname=drvfs;path=D:\\sub;uid=1000\n', MOUNTINFO.replaceAll('D:','E:')]){
    const f=fixture();f.ports.mountinfo=()=>mountinfo;assert.throws(()=>observeBackingVolumeCapacity(f.p,['/'],f.ports));assert.equal(f.stats.length,0);
  }
  const f=fixture();delete f.p.windows.backingStorage.volumeMount;assert.throws(()=>observeBackingVolumeCapacity(f.p,['/'],f.ports),/volumeMount/);
});
test('actual Windows parser and handle-bound allocation helper receive a regular native file without reading its payload', {skip:!existsSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')},()=>{
  const asset=readFileSync(new URL('../assets/observe-backing-capacity.ps1',import.meta.url),'utf8');
  const helper=/Add-Type -TypeDefinition @'\n([\s\S]+?)\n'@/.exec(asset)[1];
  const script="$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';$inputJson=[Console]::In.ReadToEnd()|ConvertFrom-Json;$tokens=$null;$errors=$null;$null=[Management.Automation.Language.Parser]::ParseInput($inputJson.asset,[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Actual capacity asset parse failed'};Add-Type -TypeDefinition $inputJson.helper;[WslBackingFileAllocation]::Observe('C:\\Windows\\System32\\kernel32.dll')|ConvertTo-Json -Compress";
  const r=spawnSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{input:JSON.stringify({asset,helper}),encoding:'utf8',cwd:'/',timeout:30000,maxBuffer:32768});
  assert.ifError(r.error);assert.equal(r.status,0,r.stderr);
  const observed=JSON.parse(r.stdout);assert.match(observed.FileIdentity,/^[a-f0-9]{8}:[a-f0-9]{16}$/);
  assert.ok(BigInt(observed.LengthBytes)>0n);assert.ok(BigInt(observed.AllocatedBytes)>=0n);
  assert.match(observed.VolumeId,/^\\\\\?\\Volume\{[a-f0-9-]{36}\}\\$/i);
  const block=BigInt(observed.AllocationUnitBytes);assert.ok(block>0n&&(block&(block-1n))===0n);
});
test('health retains independent physical percentage, growth and estimated overhead and reports low capacity',()=>{
  const f=fixture(),v=observeBackingVolumeCapacity(f.p,['/'],f.ports);
  const [h]=assessBackingVolumeHeadroom(v);assert.equal(h.requiredBytes,'5184');assert.equal(h.availableBytes,'4096');assert.equal(h.admitted,false);
  v.volumes[0].availableBytes='5184';assert.equal(assessBackingVolumeHeadroom(v)[0].admitted,true);
});

test('native online allocation remains observable while ordinary file content and length change', {skip:!existsSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')},()=>{
  const asset=readFileSync(new URL('../assets/observe-backing-capacity.ps1',import.meta.url),'utf8');
  const helper=/Add-Type -TypeDefinition @'\n([\s\S]+?)\n'@/.exec(asset)[1];
  const fixture=[
    'public static class OnlineCapacityFixture {',
    ' public static object Run() {',
    '  string dir=System.IO.Path.Combine(System.IO.Path.GetTempPath(),"wsl-capacity-fixture-"+System.Guid.NewGuid().ToString("N"));',
    '  System.IO.Directory.CreateDirectory(dir);string file=System.IO.Path.Combine(dir,"sample");System.IO.File.WriteAllBytes(file,new byte[4096]);',
    '  int stop=0,writes=0,received=0;System.Exception writerError=null;WslBackingFileAllocation.Snapshot last=null;string identity=null;',
    '  var writer=new System.Threading.Thread(()=>{try{while(System.Threading.Interlocked.CompareExchange(ref stop,0,0)==0){using(var f=new System.IO.FileStream(file,System.IO.FileMode.Open,System.IO.FileAccess.Write,System.IO.FileShare.ReadWrite|System.IO.FileShare.Delete)){f.SetLength((writes&1)==0?8192:4096);f.WriteByte((byte)writes);}System.Threading.Interlocked.Increment(ref writes);System.Threading.Thread.Sleep(1);}}catch(System.Exception e){writerError=e;}});',
    '  try {writer.Start();for(int i=0;i<1000&&System.Threading.Interlocked.CompareExchange(ref writes,0,0)==0;i++)System.Threading.Thread.Sleep(1);',
    '   if(writes==0)throw new System.Exception("Writer never started",writerError);',
    '   for(int i=0;i<32;i++){last=WslBackingFileAllocation.Observe(file);if(identity!=null&&identity!=last.FileIdentity)throw new System.Exception("Native identity changed");identity=last.FileIdentity;received++;System.Threading.Thread.Sleep(2);}',
    '   if(writerError!=null)throw writerError;return new {Writes=writes,Received=received,Observation=last};',
    '  } finally {System.Threading.Interlocked.Exchange(ref stop,1);if(!writer.Join(1000))throw new System.Exception("Fixture writer is not terminal");System.IO.File.Delete(file);System.IO.Directory.Delete(dir);}',
    ' }',
    '}'
  ].join('\n');
  const script="$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';$j=[Console]::In.ReadToEnd()|ConvertFrom-Json;Add-Type -TypeDefinition ($j.helper+[Environment]::NewLine+$j.fixture);[OnlineCapacityFixture]::Run()|ConvertTo-Json -Depth 4 -Compress";
  const r=spawnSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{input:JSON.stringify({helper,fixture}),encoding:'utf8',cwd:'/',timeout:30000,maxBuffer:32768});
  assert.ifError(r.error);assert.equal(r.status,0,r.stderr);
  const result=JSON.parse(r.stdout);assert.equal(result.Received,32);assert.ok(result.Writes>0);
  assert.match(result.Observation.FileIdentity,/^[a-f0-9]{8}:[a-f0-9]{16}$/);
  assert.ok(BigInt(result.Observation.AllocatedBytes)>=0n);
});
test('unknown destination device refuses before reading the volume', () => {
  const f=fixture(); f.ports.deviceOf=path=>({real:path,device:path==='/mnt/x'?'88':'77'});
  assert.throws(()=>observeBackingVolumeCapacity(f.p,['/mnt/x'],f.ports),/unknown backing/); assert.equal(f.calls.length,0); assert.equal(f.stats.length,0);
});
test('existing dangling ancestor redirects never borrow root capacity', () => {
  const dir=mkdtempSync(join(tmpdir(),'wsl-backing-link-'));try{
    symlinkSync(join(dir,'missing-volume'),join(dir,'redirect'));
    const f=fixture();delete f.ports.deviceOf;
    assert.throws(()=>observeBackingVolumeCapacity(f.p,[join(dir,'redirect','future')],f.ports),/dangling destination redirect/);
    assert.equal(f.calls.length,0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('current environment and native root witness must both identify the registered distribution', () => {
  const f=fixture(); f.ports.environment.WSL_DISTRO_NAME='Other'; assert.throws(()=>observeBackingVolumeCapacity(f.p,['/'],f.ports),/current WSL/); assert.equal(f.calls.length,0);
  f.ports.environment.WSL_DISTRO_NAME='Example'; f.ports.run=()=> '\\\\wsl.localhost\\Other\\';
  assert.throws(()=>observeBackingVolumeCapacity(f.p,['/'],f.ports),/native WSL root identity/);
});
test('service-manager absence of distro environment still requires the native root identity',()=>{
  const f=fixture();f.ports.environment={};
  assert.equal(observeBackingVolumeCapacity(f.p,['/'],f.ports).type,'WslBackingVolumeCapacity');
  f.ports.run=()=> '\\\\wsl.localhost\\Other\\';assert.throws(()=>observeBackingVolumeCapacity(f.p,['/'],f.ports),/native WSL root identity/);
});
test('invalid request challenge refuses before any observation',()=>{
  const f=fixture();f.ports.nonce=()=> 'not-a-request-challenge';
  assert.throws(()=>observeBackingVolumeCapacity(f.p,['/'],f.ports),/invalid capacity request challenge/);
  assert.equal(f.calls.length,0);assert.equal(f.stats.length,0);
});
test('the whole local observation must remain within its monotonic freshness budget',()=>{
  for(const elapsed of [-1,2001,NaN,Infinity]){
    const f=fixture();let reads=0;f.ports.monotonic=()=> reads++?100+elapsed:100;
    assert.throws(()=>observeBackingVolumeCapacity(f.p,['/'],f.ports),/stale or unknown local/);
  }
  const f=fixture();let reads=0;f.ports.monotonic=()=> reads++?2100:100;
  assert.equal(observeBackingVolumeCapacity(f.p,['/'],f.ports).freshness.elapsedMs,2000);
  f.ports.monotonic=()=>NaN;assert.throws(()=>observeBackingVolumeCapacity(f.p,['/'],f.ports),/unknown local monotonic/);
});
test('late identity rechecks cannot extend the original observation age',()=>{
  const f=fixture();let elapsed=0,deviceReads=0;f.ports.monotonic=()=>elapsed;
  f.ports.deviceOf=path=>{if(++deviceReads>2)elapsed=2001;return{real:path,device:'77'};};
  assert.throws(()=>observeBackingVolumeCapacity(f.p,['/'],f.ports),/stale or unknown local/);
});
test('wslpath timeout cannot become a successful observation', () => {
  const f=fixture();f.ports.run=()=>{throw Object.assign(new Error('native timeout'),{code:'ETIMEDOUT'});};assert.throws(()=>observeBackingVolumeCapacity(f.p,['/'],f.ports),/native timeout/);
});
test('malformed physical policy refuses', () => {
  for(const mutate of [f=>delete f.p.windows.backingStorage.policy.overheadBytes,f=>f.p.windows.backingStorage.policy.minFreePercent=-1]){
    const f=fixture();mutate(f);assert.throws(()=>observeBackingVolumeCapacity(f.p,['/'],f.ports));
  }
});
test('root or destination device drift during observation refuses', () => {
  const f=fixture();let changed=false;f.ports.deviceOf=path=>({real:path,device:changed?'99':'77'});const lstat=f.ports.lstat;f.ports.lstat=path=>{changed=true;return lstat(path);};
  assert.throws(()=>observeBackingVolumeCapacity(f.p,['/gnu/store'],f.ports),/device changed/);
});
test('input paths, distro registry and limits are bounded before any observation', () => {
  for(const mutate of [f=>f.p.windows.backingStorage.registryKey='HKCU:\\Software',f=>f.p.windows.backingStorage.linuxMount='/mnt/other',f=>f.p.windows.backingStorage.timeoutMs=99999,f=>f.p.windows.backingStorage.volumeMount='relative']){
    const f=fixture();mutate(f);assert.throws(()=>observeBackingVolumeCapacity(f.p,['/'],f.ports));assert.equal(f.calls.length,0);
  }
  const f=fixture();for(const paths of [[],['relative'],Array.from({length:33},(_,i)=>'/'+i),['/','/']])assert.throws(()=>observeBackingVolumeCapacity(f.p,paths,f.ports));assert.equal(f.calls.length,0);
});
test('existing capacity CLI refuses absent binding without rendering or writing host files', () => {
  const dir=mkdtempSync(join(tmpdir(),'wsl-capacity-'));try{const parameters=join(dir,'record.json');writeFileSync(parameters,JSON.stringify({schema:'wsl-host-parameters@1'}));
    const r=spawnSync(process.execPath,[new URL('../scripts/wsl-host.mjs',import.meta.url).pathname,'capacity','--parameters='+parameters],{encoding:'utf8'});
    assert.equal(r.status,2);assert.match(r.stderr,/backingStorage is required/);assert.equal(r.stdout,'');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
