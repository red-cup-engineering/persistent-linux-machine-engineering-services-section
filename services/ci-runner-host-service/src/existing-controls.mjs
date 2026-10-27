// Controls-only receiving for the original CI owner's retained flat installations.
// This never installs, registers, moves, cleans, starts, stops or thaws a runner.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, writeFileSync, unlinkSync, chmodSync, linkSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalPath, inspectOwnedFile, readOwnedFile, admissionDeclaration } from './host-admission.mjs';
import {unitName} from './runner-layout.mjs';
import {pathToFileURL} from 'node:url';

const safeName = value => assert.match(value, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const shell = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const unitQuote = value => '"' + String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$') + '"';
const optional = path => { try { return readOwnedFile(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

export function readNativeRunnerUnit(unit) {
  safeName(unit);
  const out = execFileSync('/usr/bin/systemctl', ['--user', 'show', unit, '--no-pager',
    '--property=Id,LoadState,FragmentPath,WorkingDirectory,ExecStart,DropInPaths,ExecCondition'],
  { encoding: 'utf8', timeout: 10000, maxBuffer: 65536, stdio: ['ignore','pipe','ignore'] });
  return Object.fromEntries(out.trimEnd().split('\n').map(line => { const n = line.indexOf('='); return [line.slice(0,n), line.slice(n+1)]; }));
}
function ownedDirectory(path, uid, { privateMode = false } = {}) {
  canonicalPath(path);
  // Reading one regular directory does not enumerate it. Reject redirected ancestry.
  for (let p = path;; p = dirname(p)) {
    const st = lstatSync(p);
    assert.ok(st.isDirectory() && !st.isSymbolicLink(), 'canonical controls directory required');
    assert.ok(st.uid === uid || st.uid === 0, 'foreign controls directory refused');
    assert.equal(st.mode & 0o022, 0, 'writable-by-others controls directory refused');
    if (p === path && privateMode) { assert.equal(st.uid, uid); assert.equal(st.mode & 0o077, 0, 'private controls directory required'); }
    if (dirname(p) === p) break;
  }
}
function newDirectory(path, uid, privateMode = false) {
  let st;try{st=lstatSync(path);}catch(error){if(error.code!=='ENOENT')throw error;}
  if (st) ownedDirectory(path,uid,{privateMode});
  else { ownedDirectory(dirname(path),uid); }
}
function validateRuntime(controls) {
  const node=inspectOwnedFile(controls.runtime.node);
  assert.ok(node.mode&0o111,'original Node runtime must be executable');
  const files = controls.runtime.files;
  assert.ok(Array.isArray(files) && files.length >= 5 && files.length <= 8, 'complete original CI runtime file pins required');
  assert.equal(new Set(files.map(item=>item.path)).size,files.length,'duplicate runtime source');
  const expected = [controls.runtime.cli,
    join(dirname(dirname(controls.runtime.cli)), 'src/ci-runner-host.mjs'),
    join(dirname(dirname(controls.runtime.cli)), 'src/host-admission.mjs'),
    join(dirname(dirname(controls.runtime.cli)), 'src/existing-controls.mjs'),
    join(dirname(dirname(controls.runtime.cli)), 'src/runner-layout.mjs')];
  assert.ok(expected.every(path=>files.some(item=>item.path===path)), 'original CLI and all admission runtime sources must be pinned');
  return files.map(item=>readOwnedFile(item.path,{sha256:item.sha256}));
}
function hookText(controls, runner) {
  return ['#!/bin/sh', '# Owned by original ci-runner-host-service. No materialization or runner lifecycle effects.', 'set -eu',
    'case "${1:-job}" in startup|job) ;; *) exit 64 ;; esac',
    ...controls.runtime.files.map(item => `/usr/bin/test ! -L ${shell(item.path)} && /usr/bin/printf '%s  %s\\n' ${shell(item.sha256)} ${shell(item.path)} | /usr/bin/sha256sum --check --status || exit 1`),
    `exec ${shell(controls.runtime.node)} ${shell(controls.runtime.cli)} "\${1:-job}-admit" ${shell('--parameters='+controls.parametersPath)} ${shell('--runner='+runner.name)}`, ''].join('\n');
}
function dropinText(controls, hook) {
  return ['# Owned by original ci-runner-host-service. Retains existing unit/quarantine declarations.', '[Service]',
    `ExecCondition=${unitQuote(hook)} startup`,
    `Environment=${unitQuote('ACTIONS_RUNNER_HOOK_JOB_STARTED='+hook)}`, ''].join('\n');
}
const sameReceipt = receipt => {
  const next=readOwnedFile(receipt.path,{sha256:receipt.sha256});
  assert.equal(next.dev,receipt.dev,'controls input device changed');assert.equal(next.ino,receipt.ino,'controls input inode changed');
};
function nativeCgroup(group){
  assert.ok(/^\/[A-Za-z0-9_./@:-]+$/.test(group)&&!group.includes('..'),'invalid original cgroup');
  const root='/sys/fs/cgroup'+group;
  assert.ok(!readdirSync(root,{withFileTypes:true}).some(entry=>entry.isDirectory()),'unexpected nested runner cgroup; custody unknown');
  return {freeze:readFileSync(join(root,'cgroup.freeze'),'utf8').trim(),events:readFileSync(join(root,'cgroup.events'),'utf8').trim(),
    pids:readFileSync(join(root,'cgroup.procs'),'utf8').trim().split(/\s+/).filter(Boolean).map(Number).sort((a,b)=>a-b)};
}
async function receivePause(record,runner,ports){
  const source=readOwnedFile(record.controls.pauseProvider?.module,{sha256:record.controls.pauseProvider?.sha256});
  const original=await import(pathToFileURL(source.path).href+'?sha256='+source.sha256);sameReceipt(source);
  const host=readOwnedFile(record.hostAdmission.hostParametersPath),parameters=JSON.parse(host.bytes),pause=runner.existing.pause;
  assert.ok(pause&&typeof pause.id==='string','original retained runner quarantine required');
  const q=original.quarantineDeclaration(parameters,pause.id);
  assert.equal(q.unit,unitName(runner));assert.equal(q.uid,record.controls.uid);assert.equal(q.home,record.controls.home);assert.equal(q.releasePolicy,'hold-only','original preventive hold-only quarantine required');
  const native=ports.pauseNative??original.nativeQuarantinePort();
  const held=original.planQuarantine(parameters,native,pause.id);
  assert.equal(held.status,'held','original native pause is unreceived');assert.equal(held.markerSha256,pause.markerSha256,'original pause marker drift');
  const marker=readOwnedFile(q.marker,{sha256:pause.markerSha256}),guard=readOwnedFile(q.guard,{sha256:pause.guardSha256});
  let cohort=[];
  if(q.captureMode==='frozen-resident'){
    const kernel=(ports.readCgroup??nativeCgroup)(held.original.controlGroup);
    assert.equal(kernel.freeze,'1','actual native runner cgroup is not frozen');
    assert.match(kernel.events,/(?:^|\n)frozen 1(?:\n|$)/);assert.match(kernel.events,/(?:^|\n)populated 1(?:\n|$)/);
    assert.ok(kernel.pids.length>0&&kernel.pids.length<=64&&kernel.pids.every(Number.isSafeInteger),'bounded original runner cohort required');
    cohort=kernel.pids.map(pid=>{const p=native.process(pid);assert.equal(p.cgroup,'0::'+held.original.controlGroup,'runner cohort cgroup differs');return{pid,startTime:p.startTime};});
    assert.deepEqual(cohort,pause.cohort,'original frozen process cohort changed');
    assert.deepEqual((ports.readCgroup??nativeCgroup)(held.original.controlGroup),kernel,'frozen native cohort changed during receiving');
  }else{assert.deepEqual(pause.cohort,[],'stopped original pause must have no resident cohort');assert.equal(native.boot(),q.expected.bootId,'original stopped boot differs');}
  const final=original.planQuarantine(parameters,native,pause.id);assert.deepEqual(final,held,'original pause changed during receiving');
  [source,host,marker,guard].forEach(sameReceipt);
  return {value:{id:pause.id,markerSha256:marker.sha256,guardSha256:guard.sha256,original:held.original,cohort},receipts:[source,host,marker,guard]};
}

/** Full-set read-only preflight. Native registration observation is supplied by the original owner. */
export async function planExistingControls(record, { registration, unit = readNativeRunnerUnit,...ports } = {}) {
  assert.equal(record.schema,'ci-runner-host-parameters@1');
  const c=record.controls;
  assert.equal(c?.mode,'existing-flat','explicit controls-only flat layout required');
  assert.equal(c.uid,process.getuid(),'controls owner differs from current user');
  assert.ok(typeof registration==='function','original scope-bound registration reader required');
  ownedDirectory(c.home,c.uid);assert.equal(c.home,process.env.HOME,'controls home differs from current native user');
  const source=readOwnedFile(c.parametersPath);assert.deepEqual(JSON.parse(source.bytes),record,'canonical CI record differs from requested controls');
  const runtime=validateRuntime(c), capacity=admissionDeclaration(record);
  newDirectory(c.directory,c.uid,true);
  assert.ok(c.directory!==c.home && !record.runners.some(r=>c.directory===r.root || c.directory.startsWith(r.root+'/')),'controls must be outside runner application roots');
  assert.ok(Array.isArray(record.runners)&&record.runners.length>0&&record.runners.length<=16,'bounded selected runners required');
  assert.equal(new Set(record.runners.map(r=>r.name)).size,record.runners.length,'duplicate selected runner');
  assert.equal(new Set(record.runners.map(r=>r.root)).size,record.runners.length,'duplicate selected runner root');
  const receipts=[source,...runtime,...capacity.receipts], files=[], units=[];
  for(const r of record.runners){
    safeName(r.name);canonicalPath(r.root);ownedDirectory(r.root,c.uid);
    const local=readOwnedFile(join(r.root,'.runner'));
    const identity=JSON.parse(local.bytes.toString('utf8').replace(/^\uFEFF/,''));
    assert.ok(Number.isSafeInteger(r.existing?.id)&&r.existing.id>0,'received existing registration id required');
    assert.equal(identity.agentId,r.existing.id,'retained registration id differs');
    assert.equal(identity.agentName,r.name,'retained registration name differs');
    assert.equal(identity.gitHubUrl,r.scope,'retained registration scope differs');
    assert.equal(identity.workFolder,'_work','retained work folder differs');
    const remote=registration(r);
    assert.ok(['current','drift'].includes(remote.state)&&remote.id===r.existing.id&&remote.scope===r.scope&&remote.name===r.name,'original native remote registration is unreceived');
    // Busy is a remote mutable sample, not pause authority. The original native
    // quarantine below preserves an exact frozen raced-in job rather than killing it.
    const unitPath=join(c.home,'.config/systemd/user',unitName(r));
    assert.equal(r.existing.unitFragment,unitPath,'original user-unit fragment required');
    const fragment=readOwnedFile(unitPath,{sha256:r.existing.unitFragmentSha256});
    const native=unit(unitName(r));
    assert.equal(native.Id,unitName(r));assert.equal(native.LoadState,'loaded');assert.equal(native.FragmentPath,unitPath,'native fragment differs');
    assert.equal(native.WorkingDirectory,r.root,'native working directory differs');
    const exec=/^\{ path=([^;]+) ; argv\[\]=([^;]+) ;/.exec(native.ExecStart??'');
    assert.ok(exec && !native.ExecStart.slice(1).includes('{'),'one original native runner command required');
    assert.equal(exec[1],join(r.root,'run.sh'),'native runner executable differs');
    assert.equal(exec[2],join(r.root,'run.sh'),'native runner arguments differ');
    const dotEnv=optional(join(r.root,'.env'));
    assert.ok(!dotEnv || !/^ACTIONS_RUNNER_HOOK_JOB_STARTED=/m.test(dotEnv.bytes.toString()),'runner .env competes with original job admission control');
    const hook=join(c.directory,r.name+'-admit.sh'), dropin=join(unitPath+'.d','80-ci-runner-host-admission.conf');
    newDirectory(dirname(dropin),c.uid);
    for(const [path,content,mode] of [[hook,hookText(c,r),0o700],[dropin,dropinText(c,hook),0o600]]){
      assert.ok(!optional(path+'.pending'),'interrupted controls staging custody requires receiving before successor writes');
      const current=optional(path);
      // Existing competing bytes are never silently taken over, even with an ownership comment.
      assert.ok(!current || (current.bytes.toString()===content && current.mode===mode && current.uid===c.uid),'competing controls file/mode refused');
      files.push({path,content,mode,current:!!current});
    }
    const pause=await receivePause(record,r,ports);
    receipts.push(local,fragment,...(dotEnv?[dotEnv]:[]),...pause.receipts);units.push({name:unitName(r),hook,dropin,native,pause:pause.value});
  }
  return {type:'CiRunnerExistingControlsPlan',changed:files.some(f=>!f.current),files,units,receipts};
}

/** Apply only declared tiny refusal controls; no service state transition is a supported effect. */
export async function applyExistingControls(record, ports={}){
  const plan=await planExistingControls(record,ports), c=record.controls;
  plan.receipts.forEach(sameReceipt);
  if(!plan.changed)return {changed:false,writes:[],reloaded:false};
  // Re-observe whole selection immediately before effects; this never thaws a frozen resident.
  const again=await planExistingControls(record,ports);again.receipts.forEach(sameReceipt);
  assert.deepEqual(again.units.map(u=>u.pause),plan.units.map(u=>u.pause),'original retained pause changed before controls');
  if(!existsSync(c.directory))mkdirSync(c.directory,{mode:0o700});
  ownedDirectory(c.directory,c.uid,{privateMode:true});
  const writes=[];
  for(const f of again.files){
    if(f.current)continue;
    if(!existsSync(dirname(f.path)))mkdirSync(dirname(f.path),{mode:0o700});
    ownedDirectory(dirname(f.path),c.uid);
    const temp=f.path+'.pending';let owned;
    try{writeFileSync(temp,f.content,{flag:'wx',mode:f.mode});owned=lstatSync(temp);chmodSync(temp,f.mode);
      assert.ok(!existsSync(f.path),'controls target appeared before commit');
      // link-like exclusive receive avoids replacing a raced target; no unrelated file is removed.
      linkSync(temp,f.path);
      writes.push(f.path);
    }finally{if(owned){const current=lstatSync(temp);assert.ok(current.dev===owned.dev&&current.ino===owned.ino,'controls staging identity unknown; custody retained');unlinkSync(temp);}}
  }
  (ports.reload ?? (()=>execFileSync('/usr/bin/systemctl',['--user','daemon-reload'],{stdio:'ignore',timeout:10000})))();
  const loaded=await planExistingControls(record,ports);
  assert.deepEqual(loaded.units.map(u=>u.pause),again.units.map(u=>u.pause),'original retained pause changed after reload');
  assert.equal(loaded.changed,false,'installed controls not received');
  for(const u of loaded.units){
    assert.ok((u.native.DropInPaths??'').split(' ').includes(u.dropin),'native manager did not load admission drop-in');
    assert.ok((u.native.ExecCondition??'').includes('path='+u.hook+' ;'),'native manager did not load startup admission condition');
  }
  return {changed:true,writes,reloaded:true,residentEnvironment:'unchanged; job hook applies to future native starts only'};
}

