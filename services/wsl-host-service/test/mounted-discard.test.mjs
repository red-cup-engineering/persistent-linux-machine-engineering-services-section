import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, openSync, closeSync, constants as C } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mountedDiscardAdmission, parseMountedRoot, awaitMountedDiscard, receiveMountedDiscardOutcome, discardMountedRoot, claimMountedDiscard } from '../src/mounted-discard.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture() {
  const p={schema:'wsl-host-parameters@1',linux:{mountedDiscard:{adapter:'util-linux-2.39.3-selected-root-fitrim',sectionRoot:'/original/host-services-section',custodyDirectory:'/original/host-services-section/data/state/mounted-discard',ownerUid:1000,deadlineMs:60000,maxOutputBytes:1024}},windows:{backingStorage:{distributionName:'Example',registryKey:'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{11111111-1111-1111-1111-111111111111}',basePath:'C:\\example',vhdFileName:'ext4.vhdx',volumeId:'\\\\?\\Volume{22222222-2222-2222-2222-222222222222}\\',powershell:'/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',wslpath:'/usr/bin/wslpath',linuxMount:'/',timeoutMs:1000,maxAgeMs:2000,policy:{minFreeBytes:'100000000000',minFreePercent:3,growthBytes:'0',overheadBytes:'0',basis:'original floor'}}}};
  const a={type:'WslMountedDiscardAdmission',version:1,request:'11111111-1111-1111-1111-111111111111',parameterSha256:'',notBefore:'2026-10-23T01:00:00.000Z',expiresAt:'2026-10-23T01:10:00.000Z',bootId:'22222222-2222-2222-2222-222222222222',mountNamespace:'mnt:[123]',resources:['authority','checkpoint','independent-receiving'].map(role=>({role,path:p.linux.mountedDiscard.custodyDirectory+'/'+role+'.json',sha256:hash(role)}))};
  const receive=()=>{const text=JSON.stringify(p);a.parameterSha256=hash(text);return mountedDiscardAdmission(text,JSON.stringify(a),Date.parse('2026-10-23T01:01:00.000Z'));};
  return {p,a,receive};
}
test('original selected root and current digest-bound Resources receive without claiming authority',()=>{
  const f=fixture(),selected=f.receive();assert.equal(selected.parameters.windows.backingStorage.linuxMount,'/');assert.equal(selected.admission.resources.length,3);
});
test('expired, future, impossible or indefinite maintenance admission refuses before native access',()=>{
  for(const mutate of [f=>f.a.notBefore='2026-10-23T01:02:00.000Z',f=>f.a.expiresAt='2026-10-23T01:01:00.000Z',f=>f.a.notBefore='2026-02-30T01:00:00.000Z',f=>f.a.expiresAt='2026-10-24T01:00:00.000Z']){const f=fixture();mutate(f);assert.throws(f.receive);}
});
test('changed record, weak floor and alternate provider/mount/custody refuse',()=>{
  const f=fixture();f.receive();f.p.linux.mountedDiscard.deadlineMs=1000;assert.throws(()=>mountedDiscardAdmission(JSON.stringify(f.p),JSON.stringify(f.a)),/parameter bytes changed/);
  for(const mutate of [f=>f.p.windows.backingStorage.linuxMount='/other',f=>f.p.windows.backingStorage.policy.minFreeBytes='99999999999',f=>f.p.linux.mountedDiscard.adapter='all-filesystems',f=>f.p.linux.mountedDiscard.custodyDirectory='/tmp/maintenance',f=>f.p.linux.mountedDiscard.sectionRoot='/gnu/store/unsafe-services-section',f=>f.p.linux.mountedDiscard.deadlineMs=Infinity,f=>f.p.linux.mountedDiscard.maxOutputBytes=131073]){const f=fixture();mutate(f);assert.throws(f.receive);}
});
test('booleans, redirected Resource syntax, duplicate roles or alias paths cannot replace original evidence',()=>{
  for(const mutate of [f=>f.a.resources=[{approved:true}],f=>f.a.resources[0].path+='/../authority.json',f=>f.a.resources[0].role='checkpoint',f=>f.a.resources[1].path=f.a.resources[0].path,f=>f.a.bootId='old',f=>f.a.mountNamespace='other']){const f=fixture();mutate(f);assert.throws(f.receive);}
});
const mount='42 1 8:32 / / rw,relatime - ext4 /dev/sdc rw,discard';
test('native mount receiving rejects overlays, subvolume/other roots, readonly and ambiguous roots',()=>{
  assert.deepEqual(parseMountedRoot(mount),{mountId:'42',device:'8:32',root:'/',mount:'/',filesystem:'ext4',source:'/dev/sdc',options:'rw,relatime',superOptions:'rw,discard'});
  for(const input of [mount.replace('ext4','overlay'),mount.replace('8:32 / /','8:32 /other /'),mount.replace('rw,relatime','ro,relatime'),mount+'\n'+mount,mount.replace(' / rw,',' /other rw,')])assert.throws(()=>parseMountedRoot(input));
});
function success(){return {code:0,signal:null,error:null,withinDeadline:true,stdout:{text:'/: 128 GiB (137438953472 bytes) trimmed\n',overflow:false,error:null},stderr:{text:'',overflow:false,error:null}};}
test('successful single-root count remains a range count, with physical capacity unknown',()=>{
  assert.deepEqual(receiveMountedDiscardOutcome(success(),{pidRecorded:true,unchanged:true}),{status:'native-terminal-success',discardedRangeBytes:'137438953472',physicalReclaimedBytes:null,capacityReopened:false});
});
test('unsupported/failure, omitted PID, changed mount, delayed/overflowed evidence and malformed count all remain unreceived',()=>{
  const mutations=[o=>o.code=1,o=>o.signal='SIGTERM',o=>o.error='EACCES',o=>o.withinDeadline=false,o=>o.stdout.overflow=true,o=>o.stderr.overflow=true,o=>o.stdout.error='EIO',o=>o.stderr.error='EIO',o=>o.stderr.text='discard failed\n',o=>o.stdout.text='operation complete\n',o=>o.stdout.text='/: 0 B (dry run) trimmed\n',o=>o.stdout.text+='/other: 1 B (1 bytes) trimmed\n'];
  for(const mutate of mutations){const o=success();mutate(o);assert.equal(receiveMountedDiscardOutcome(o,{pidRecorded:true,unchanged:true}).status,'unreceived');}
  for(const status of [{pidRecorded:false,unchanged:true},{pidRecorded:true,unchanged:false}])assert.equal(receiveMountedDiscardOutcome(success(),status).status,'unreceived');
});
test('actual harmless child is awaited beyond deadline, both streams drained and failure retained without kill/retry',async()=>{
  const child=spawn(process.execPath,['-e',"process.stdout.write('x'.repeat(200000));process.stderr.write('e'.repeat(200000));setTimeout(()=>process.exit(17),150)"],{stdio:['ignore','pipe','pipe']});
  const result=await awaitMountedDiscard(child,{deadlineMs:1,maxOutputBytes:1024});
  assert.equal(result.code,17);assert.equal(result.signal,null);assert.equal(result.withinDeadline,false);assert.ok(result.elapsedMs>=150);assert.equal(result.stdout.text.length,1024);assert.equal(result.stderr.text.length,1024);assert.equal(result.stdout.overflow,true);assert.equal(result.stderr.overflow,true);
});
test('actual failed child launch reaches an unreceived terminal instead of an unhandled event or retry',async()=>{
  const child=spawn('/no/such/qualified-provider',[],{stdio:['ignore','pipe','pipe']});
  const result=await awaitMountedDiscard(child,{deadlineMs:1000,maxOutputBytes:1024});assert.equal(result.error,'ENOENT');assert.equal(result.pid,null);
});
test('actual native entrance refuses invalid admission before privilege, probes, custody or effects',async()=>{
  const f=fixture();f.receive();f.a.parameterSha256='0'.repeat(64);
  await assert.rejects(discardMountedRoot(JSON.stringify(f.p),JSON.stringify(f.a)),/parameter bytes changed/);
});
test('actual CLI refuses staging before touching the maintenance dispatcher',()=>{
  const logs=fileURLToPath(new URL('../data/logs/',import.meta.url));mkdirSync(logs,{recursive:true});const directory=mkdtempSync(logs+'mounted-discard-cli-');
  try {const f=fixture();writeFileSync(directory+'/parameters.json',JSON.stringify(f.p));
    assert.throws(()=>execFileSync(process.execPath,[fileURLToPath(new URL('../scripts/wsl-host.mjs',import.meta.url)),'mounted-discard','--parameters='+directory+'/parameters.json','--root='+directory,'--admission='+directory+'/absent-admission.json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}),error=>error.status===2&&/without staging/.test(error.stderr));
  }finally {rmSync(directory,{recursive:true,force:true});}
});
test('actual native durable claim preserves exact intent and refuses old and fresh UUID replay',()=>{
  const logs=fileURLToPath(new URL('../data/logs/',import.meta.url));mkdirSync(logs,{recursive:true});const directory=mkdtempSync(logs+'mounted-discard-custody-');const fd=openSync(directory,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
  try {const intent={request:'original',parameterText:'exact\nrecord',resources:[{base64:Buffer.from([0,255,42]).toString('base64')}]};claimMountedDiscard(fd,intent,process.getuid());assert.deepEqual(JSON.parse(readFileSync(directory+'/mounted-discard.claim.json')),intent);
    assert.throws(()=>claimMountedDiscard(fd,intent,process.getuid()),{code:'EEXIST'});assert.throws(()=>claimMountedDiscard(fd,{request:'new'},process.getuid()),{code:'EEXIST'});
  }finally {closeSync(fd);rmSync(directory,{recursive:true,force:true});}
});
