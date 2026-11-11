// Explicit single-root maintenance. Ordinary health/configuration never calls it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as C, openSync, closeSync, readSync, fstatSync, lstatSync, realpathSync, readlinkSync, fsyncSync, fchownSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { observeBackingVolumeCapacity, validateBackingStorage } from './backing-capacity.mjs';

export const mountedDiscardQualification = Object.freeze({
  adapter: 'util-linux-2.39.3-selected-root-fitrim', executable: '/usr/sbin/fstrim',
  sha256: '000943de62b2ca1c7e2adba6bd22c4e8e491c6ae05ff43408f5aef29c15f8fe4',
  sourceBlob: '96b7d2d484657b388e73d922376e7b5efc9456c3'
});
const hash = b => createHash('sha256').update(b).digest('hex');
const exactInstant = s => typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const json = (text, label) => { assert.equal(typeof text, 'string'); assert.ok(Buffer.byteLength(text) <= 131072, label + ' exceeds evidence budget'); return JSON.parse(text); };
const identity = st => [String(st.dev), String(st.ino), String(st.size), String(st.mtimeNs), String(st.ctimeNs)];
const same = (a, b, label) => assert.deepEqual(a, b, label + ' changed');
function readDescriptor(fd, max) {
  const chunks = []; let size = 0;
  for (;;) { const buffer = Buffer.alloc(Math.min(16384, max + 1 - size)); const n = readSync(fd, buffer, 0, buffer.length, null); if (!n) break; chunks.push(buffer.subarray(0,n)); size += n; assert.ok(size <= max, 'native input exceeds evidence budget'); }
  return Buffer.concat(chunks);
}
function boundedFile(path, max = 131072) {
  const fd = openSync(path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try { const before = fstatSync(fd, { bigint:true }); assert.ok(before.isFile(), 'original regular file required'); const bytes = readDescriptor(fd,max); same(identity(fstatSync(fd,{bigint:true})),identity(before),'original input'); same(identity(lstatSync(path,{bigint:true})),identity(before),'named original input'); return bytes; }
  finally { closeSync(fd); }
}
function proc(path) { const fd=openSync(path,C.O_RDONLY|C.O_NOFOLLOW); try {return readDescriptor(fd,131072).toString('utf8');} finally {closeSync(fd);} }
export function parseMountedRoot(mountinfo) {
  assert.ok(Buffer.byteLength(mountinfo) <= 131072, 'mount evidence exceeds allocation');
  const roots=mountinfo.trim().split('\n').map(line=>line.split(' ')).filter(fields=>fields[4]==='/');
  assert.equal(roots.length,1,'one native root mount required');
  const fields=roots[0], sep=fields.indexOf('-');
  assert.ok(sep>=6 && /^\d+$/.test(fields[0]) && /^\d+:\d+$/.test(fields[2]),'invalid native root mount');
  assert.equal(fields[3],'/','whole selected filesystem required');
  assert.equal(fields[sep+1],'ext4','only selected ext4 root qualified');
  assert.ok(fields[5].split(',').includes('rw'),'writable selected root required');
  return { mountId:fields[0], device:fields[2], root:fields[3], mount:'/', filesystem:fields[sep+1], source:fields[sep+2], options:fields[5], superOptions:fields[sep+3] };
}
export function mountedDiscardAdmission(parameterText, admissionText, now = Date.now()) {
  const p=json(parameterText,'parameter record'), target=validateBackingStorage(p), q=p.linux?.mountedDiscard;
  assert.equal(q?.adapter,mountedDiscardQualification.adapter,'explicit qualified mounted-discard declaration required');
  assert.ok(typeof q.sectionRoot==='string' && resolve(q.sectionRoot)===q.sectionRoot && basename(q.sectionRoot).endsWith('-services-section') && !q.sectionRoot.split('/').some(x=>['.local','node_modules'].includes(x)) && !q.sectionRoot.startsWith('/gnu/store/'),'canonical original sectionRoot required');
  assert.ok(typeof q.custodyDirectory==='string' && resolve(q.custodyDirectory)===q.custodyDirectory && q.custodyDirectory.startsWith(q.sectionRoot+'/data/'),'explicit original data custody required');
  assert.ok(Number.isSafeInteger(q.ownerUid) && q.ownerUid>=0,'actual custody owner required');
  assert.ok(Number.isSafeInteger(q.deadlineMs) && q.deadlineMs>=1000 && q.deadlineMs<=3600000,'finite maintenance deadline required');
  assert.ok(Number.isSafeInteger(q.maxOutputBytes) && q.maxOutputBytes>=1024 && q.maxOutputBytes<=131072,'bounded maintenance output required');
  assert.ok(BigInt(target.policy.minFreeBytes)>=100000000000n,'original 100 GB floor must remain');
  const a=json(admissionText,'maintenance admission');
  assert.equal(a.type,'WslMountedDiscardAdmission'); assert.equal(a.version,1);
  assert.match(a.request??'',/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  assert.equal(a.parameterSha256,hash(parameterText),'original parameter bytes changed');
  assert.ok(exactInstant(a.notBefore)&&exactInstant(a.expiresAt),'exact UTC admission interval required');
  assert.ok(Date.parse(a.expiresAt)>Date.parse(a.notBefore)&&Date.parse(a.expiresAt)-Date.parse(a.notBefore)<=600000,'current bounded checkpoint required');
  assert.ok(now>=Date.parse(a.notBefore)&&now<Date.parse(a.expiresAt),'maintenance admission is not current');
  assert.match(a.bootId??'',/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  assert.match(a.mountNamespace??'',/^mnt:\[\d+\]$/);
  assert.ok(Array.isArray(a.resources)&&a.resources.length===3,'three original authority/checkpoint/receiving Resources required');
  same(a.resources.map(r=>r.role).sort(),['authority','checkpoint','independent-receiving'],'Resource roles');
  for(const r of a.resources) assert.ok(typeof r.path==='string'&&resolve(r.path)===r.path&&r.path.startsWith(q.custodyDirectory+'/')&&/^[a-f0-9]{64}$/.test(r.sha256),'original custody Resource required');
  assert.equal(new Set(a.resources.map(r=>r.path)).size,3,'distinct original Resources required');
  return {parameters:p,declaration:q,admission:a};
}
function custodyPath(q, path, directory=false) {
  assert.ok(path===q.sectionRoot||path.startsWith(q.sectionRoot+'/'),'outside original custody');
  const parts=path.slice(q.sectionRoot.length).split('/').filter(Boolean); let current=q.sectionRoot;
  for(const part of [null,...parts]) { if(part)current+='/'+part; const st=lstatSync(current); assert.ok(!st.isSymbolicLink()&&realpathSync(current)===current&&st.uid===q.ownerUid&&!(st.mode&0o022),'unsafe original custody path'); if(current===q.custodyDirectory||current.startsWith(q.custodyDirectory+'/'))assert.equal(st.mode&0o077,0,'private original custody required'); if(current!==path||directory)assert.ok(st.isDirectory(),'custody directory required'); else assert.ok(st.isFile()&&!(st.mode&0o077),'private original Resource required'); }
}
function durable(path, bytes, ownerUid) {
  const fd=openSync(path,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);
  try { fchownSync(fd,ownerUid,-1); writeFileSync(fd,bytes); fsyncSync(fd); } finally {closeSync(fd);}
  // Preserve the declared original holder's private data custody.
  assert.equal(lstatSync(path).uid,ownerUid,'maintenance custody writer differs');
}
function syncDirectory(fd) { fsyncSync(fd); }
export function claimMountedDiscard(directoryFd, intent, ownerUid) {
  // Fixed name: an unreceived earlier UUID cannot be bypassed by a fresh UUID.
  durable('/proc/self/fd/'+directoryFd+'/mounted-discard.claim.json',JSON.stringify(intent),ownerUid);
  syncDirectory(directoryFd);
}

/** Await the same child without timeout kill/retry. Output continues draining
 * after its bounded retained prefix; allocation failure never means success. */
export async function awaitMountedDiscard(child, {deadlineMs,maxOutputBytes}, started=performance.now()) {
  const capture=stream=>{const chunks=[];let length=0,overflow=false,error=null;stream.on('data',b=>{const remaining=maxOutputBytes-length;if(b.length>remaining)overflow=true;if(remaining>0){const part=b.subarray(0,remaining);chunks.push(part);length+=part.length;}});stream.on('error',e=>{error=e.code??'STREAM_ERROR';});return()=>({text:Buffer.concat(chunks).toString('utf8'),overflow,error});};
  const stdout=capture(child.stdout),stderr=capture(child.stderr);
  const terminal=await new Promise(resolve=>{let error=null;child.once('error',e=>{error=e.code??'SPAWN_ERROR';});child.once('close',(code,signal)=>resolve({code,signal,error}));});
  const elapsedMs=performance.now()-started;
  return {...terminal,pid:child.pid??null,elapsedMs,stdout:stdout(),stderr:stderr(),withinDeadline:elapsedMs<=deadlineMs};
}
export function receiveMountedDiscardOutcome(outcome,{pidRecorded,unchanged}) {
  const count=/^\/: [^\r\n]+ \(([0-9]{1,24}) bytes\) trimmed\n$/.exec(outcome.stdout.text);
  const received=pidRecorded===true&&unchanged===true&&outcome.code===0&&outcome.signal===null&&outcome.error===null&&outcome.withinDeadline===true&&!outcome.stdout.overflow&&!outcome.stderr.overflow&&!outcome.stdout.error&&!outcome.stderr.error&&outcome.stderr.text===''&&count!==null;
  return {status:received?'native-terminal-success':'unreceived',discardedRangeBytes:received?count[1]:null,physicalReclaimedBytes:null,capacityReopened:false};
}

/** Invoke only after original holder/caller receiving. No implicit health,
 * timer hook, privilege escalation, stop/restart or fabrication admission. */
export async function discardMountedRoot(parameterText, admissionText) {
  const selected=mountedDiscardAdmission(parameterText,admissionText),{parameters,declaration:q,admission:a}=selected;
  assert.equal(process.getuid(),0,'native root owner required; no automatic elevation');
  assert.equal(process.geteuid(),0,'native effective root required');
  const capabilities=/^CapEff:\s*([a-f0-9]+)$/mi.exec(proc('/proc/self/status'));
  assert.ok(capabilities&&(BigInt('0x'+capabilities[1])&(1n<<21n))!==0n,'actual CAP_SYS_ADMIN required');
  const boot=()=>proc('/proc/sys/kernel/random/boot_id').trim(),namespace=()=>readlinkSync('/proc/self/ns/mnt');
  same(boot(),a.bootId,'current boot'); same(namespace(),a.mountNamespace,'current mount namespace');
  const root=()=>parseMountedRoot(proc('/proc/self/mountinfo')),before=root();
  const capacity=observeBackingVolumeCapacity(parameters,['/']);
  custodyPath(q,q.custodyDirectory,true);
  const resources=a.resources.map(r=>{custodyPath(q,r.path);const bytes=boundedFile(r.path);assert.equal(hash(bytes),r.sha256,'original Resource bytes changed');return {...r,base64:bytes.toString('base64')};});
  const descriptors=[];
  let claimed=false;
  try {
    const keep=fd=>{descriptors.push(fd);return fd;};
    const rootFd=keep(openSync('/',C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW)),toolFd=keep(openSync(mountedDiscardQualification.executable,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK)),directoryFd=keep(openSync(q.custodyDirectory,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW));
    const directoryIdentity=identity(fstatSync(directoryFd,{bigint:true})).slice(0,2);
    const sameDirectory=()=>same(identity(lstatSync(q.custodyDirectory,{bigint:true})).slice(0,2),directoryIdentity,'original custody directory');
    const tool=fstatSync(toolFd,{bigint:true});assert.ok(tool.isFile()&&(tool.mode&0o111n)!==0n,'qualified executable required');
    assert.equal(hash(readDescriptor(toolFd,1048576)),mountedDiscardQualification.sha256,'installed FITRIM provider changed');
    same(identity(fstatSync(toolFd,{bigint:true})),identity(tool),'qualified provider');
    const rootIdentity=String(fstatSync(rootFd,{bigint:true}).dev);
    sameDirectory();custodyPath(q,q.custodyDirectory,true);
    same(root(),before,'native root'); same(namespace(),a.mountNamespace,'mount namespace'); same(boot(),a.bootId,'boot');
    mountedDiscardAdmission(parameterText,admissionText);
    const area='/proc/self/fd/'+directoryFd;
    claimed=true;
    claimMountedDiscard(directoryFd,{type:'WslMountedDiscardIntent',version:1,parameterText,admissionText,resources,capacity,root:before,rootDevice:rootIdentity,qualification:mountedDiscardQualification,invocation:{executable:mountedDiscardQualification.executable,args:['--verbose','--','/']},at:new Date().toISOString()},q.ownerUid);
    const started=performance.now();
    const child=spawn('/proc/self/fd/3',['--verbose','--','/'],{cwd:'/',env:{PATH:'/usr/sbin:/usr/bin',LC_ALL:'C'},stdio:['ignore','pipe','pipe',toolFd,rootFd]});
    let pidRecorded=false;
    // PID persistence failure must still await this same native process.
    try { assert.ok(Number.isSafeInteger(child.pid)&&child.pid>0,'native PID unavailable');durable(area+'/mounted-discard.pid.json',JSON.stringify({request:a.request,pid:child.pid,at:new Date().toISOString()}),q.ownerUid);syncDirectory(directoryFd);pidRecorded=true;} catch {}
    const outcome=await awaitMountedDiscard(child,q,started);
    let unchanged=true;try {sameDirectory();same(root(),before,'terminal root');same(namespace(),a.mountNamespace,'terminal mount namespace');same(boot(),a.bootId,'terminal boot');assert.equal(String(fstatSync(rootFd,{bigint:true}).dev),rootIdentity);assert.equal(String(lstatSync('/').dev),rootIdentity);} catch {unchanged=false;}
    const result={type:'WslMountedDiscardOutcome',version:1,request:a.request,pidRecorded,unchanged,...outcome,...receiveMountedDiscardOutcome(outcome,{pidRecorded,unchanged}),at:new Date().toISOString()};
    durable(area+'/mounted-discard.outcome.json',JSON.stringify(result),q.ownerUid);syncDirectory(directoryFd);return result;
  } catch(error) { if(claimed)error.message='Original mounted-discard custody requires reconciliation; no retry: '+error.message;throw error; }
  finally {for(const fd of descriptors.reverse())closeSync(fd);}
}
