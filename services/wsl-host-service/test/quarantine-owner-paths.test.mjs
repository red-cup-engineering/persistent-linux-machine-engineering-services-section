import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareQuarantineOwnerPaths } from '../src/user-unit-quarantine.mjs';
import { receiveQuarantineReadRecord } from '../src/quarantine-read-record.mjs';
import { createHash } from 'node:crypto';

const helper = fileURLToPath(new URL('../assets/prepare-quarantine-owner-paths.py', import.meta.url));
const facts = path => { const s=statSync(path);return { device:s.dev,inode:s.ino,uid:s.uid,gid:s.gid,mode:s.mode&0o7777 }; };
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'quarantine-owner-paths-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const home=join(root,'home'), area=join(root,'receipts');
  mkdirSync(home,{mode:0o700});mkdirSync(area,{mode:0o700});
  mkdirSync(join(home,'.config/systemd/user'),{recursive:true,mode:0o700});
  for(const n of ['.config','.config/systemd'])chmodSync(join(home,n),0o775);
  writeFileSync(join(home,'.config/systemd/user/keep'),'unrelated application content',{mode:0o600});
  return {root,home,area,packet:{home,area,id:'exact-owned-fixture',directories:['.config','.config/systemd'].map(n=>facts(join(home,n))),binding:{source:'fixture syscall assay, not native pause authority',marker:'fixed original subject'}}};
}
function run(packet, code) {
  const result=spawnSync('/usr/bin/python3',code?['-c',code,helper]:[helper],{input:JSON.stringify(packet),encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},maxBuffer:65536,timeout:15000});
  assert.equal(result.error,undefined);return result;
}

test('actual descriptors change only both owner group-write bits and repeat without rewriting outcome',t=>{
  const f=fixture(t),keep=join(f.home,'.config/systemd/user/keep'),before=statSync(keep),untargeted=facts(join(f.home,'.config/systemd/user'));
  const result=run(f.packet);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).unchanged,false);
  for(const [i,n] of ['.config','.config/systemd'].entries())assert.deepEqual(facts(join(f.home,n)),{...f.packet.directories[i],mode:0o755});
  assert.deepEqual(facts(join(f.home,'.config/systemd/user')),untargeted);assert.equal(readFileSync(keep,'utf8'),'unrelated application content');assert.equal(statSync(keep).ino,before.ino);assert.equal(statSync(keep).mtimeMs,before.mtimeMs);
  const journal=join(f.area,f.packet.id+'.owner-path-preparation.jsonl'),bytes=readFileSync(journal),st=statSync(journal);
  const again=run(f.packet);assert.equal(again.status,0,again.stderr);assert.equal(JSON.parse(again.stdout).unchanged,true);
  assert.deepEqual(readFileSync(journal),bytes);assert.equal(statSync(journal).mtimeMs,st.mtimeMs);assert.equal(statSync(journal).ino,st.ino);
});
test('both exact native prestates are required before changing the first directory',t=>{
  const f=fixture(t);chmodSync(join(f.home,'.config/systemd'),0o700);
  assert.equal(run(f.packet).status,2);assert.equal(facts(join(f.home,'.config')).mode,0o775);assert.equal(facts(join(f.home,'.config/systemd')).mode,0o700);
});
test('no-follow descriptors reject a redirected config directory without touching its target',t=>{
  const f=fixture(t);renameSync(join(f.home,'.config'),join(f.home,'outside'));symlinkSync(join(f.home,'outside'),join(f.home,'.config'));
  assert.equal(run(f.packet).status,2);assert.equal(facts(join(f.home,'outside')).mode,0o775);assert.equal(facts(join(f.home,'outside/systemd')).mode,0o775);
});
test('replacement inode or changed gid/mode cannot be substituted for the received original',t=>{
  for(const mutate of [f=>{renameSync(join(f.home,'.config/systemd'),join(f.home,'.config/original'));mkdirSync(join(f.home,'.config/systemd'),{mode:0o775});chmodSync(join(f.home,'.config/systemd'),0o775);},f=>f.packet.directories[1].gid++,f=>f.packet.directories[1].mode=0o777]){
    const f=fixture(t);mutate(f);assert.equal(run(f.packet).status,2);assert.equal(facts(join(f.home,'.config')).mode,0o775);
  }
});
test('actual xattrs refuse before permission effects rather than silently altering an ACL context',t=>{
  const f=fixture(t),code="import os,sys;os.setxattr(sys.argv[1],'user.quarantine-fixture',b'preserve')";
  const set=spawnSync('/usr/bin/python3',['-c',code,join(f.home,'.config/systemd')],{encoding:'utf8'});assert.equal(set.status,0,set.stderr);
  assert.equal(run(f.packet).status,2);assert.equal(facts(join(f.home,'.config')).mode,0o775);assert.equal(facts(join(f.home,'.config/systemd')).mode,0o775);
});
test('changed original binding and occupied owner fence never permit another operation',t=>{
  const f=fixture(t);mkdirSync(join(f.area,f.packet.id+'.owner-path-preparation.lock'),{mode:0o700});assert.equal(run(f.packet).status,2);assert.equal(facts(join(f.home,'.config')).mode,0o775);
  rmdirSync(join(f.area,f.packet.id+'.owner-path-preparation.lock'));assert.equal(run(f.packet).status,0);f.packet.binding.marker='different original';assert.equal(run(f.packet).status,2);
});
test('real first chmod survives a second-step failure and only its received step can resume',t=>{
  const f=fixture(t),code=`import importlib.util,json,os,sys
s=importlib.util.spec_from_file_location('owner',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
p=json.load(sys.stdin);real=os.fchmod;calls=[]
def failing(fd,mode):
 calls.append(mode)
 if len(calls)==2: raise OSError('fixture second-step kernel boundary failure')
 return real(fd,mode)
os.fchmod=failing
try: m.run(p);raise AssertionError('failure missing')
except OSError as e: assert 'second-step' in str(e)
finally: os.fchmod=real
assert os.stat(p['home']+'/.config').st_mode&0o777==0o755
assert os.stat(p['home']+'/.config/systemd').st_mode&0o777==0o775
assert len(open(p['area']+'/'+p['id']+'.owner-path-preparation.jsonl').readlines())==2
print(json.dumps(m.run(p)))`;
  const result=run(f.packet,code);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).status,'directories-received');
  assert.equal(facts(join(f.home,'.config')).mode,0o755);assert.equal(facts(join(f.home,'.config/systemd')).mode,0o755);
});
test('an unreceipted changed mode remains unknown and is never reinterpreted as a completed step',t=>{
  const f=fixture(t),code=`import importlib.util,json,os,sys
s=importlib.util.spec_from_file_location('owner',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
p=json.load(sys.stdin);real=os.fchmod
def uncertain(fd,mode):
 real(fd,mode);raise OSError('fixture after-effect failure')
os.fchmod=uncertain
try: m.run(p);raise AssertionError('failure missing')
except OSError: pass
finally: os.fchmod=real
try: m.run(p);raise AssertionError('unreceipted mode accepted')
except ValueError as e: assert 'identity/mode/ACL' in str(e)
print('unknown retained')`;
  const result=run(f.packet,code);assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'unknown retained');assert.equal(facts(join(f.home,'.config/systemd')).mode,0o775);
});
test('the production issuer has no injectable native authority or arbitrary directory list',t=>{
  const f=fixture(t);assert.throws(()=>prepareQuarantineOwnerPaths('unused','0'.repeat(64),'id',{native:{approved:true}}),/exact canonical record digest/);
  f.packet.paths=['/arbitrary'];assert.equal(run(f.packet).status,2);assert.equal(facts(join(f.home,'.config')).mode,0o775);
  assert.equal(existsSync(join(f.area,f.packet.id+'.owner-path-preparation.jsonl')),false);
});
test('actual intent and fence directory fsync precedes the first real chmod',t=>{
  const f=fixture(t),code=`import importlib.util,json,os,sys
s=importlib.util.spec_from_file_location('owner',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
p=json.load(sys.stdin);real_sync=os.fsync;real_chmod=os.fchmod;events=[]
area=os.stat(p['area'])
def sync(fd):
 real_sync(fd);st=os.fstat(fd);events.append((st.st_dev,st.st_ino))
def chmod(fd,mode):
 assert (area.st_dev,area.st_ino) in events,'intent/fence directory entry not durable before effect'
 with open(p['area']+'/'+p['id']+'.owner-path-preparation.jsonl') as j: assert json.loads(j.readline())['event']=='intent'
 assert os.path.isdir(p['area']+'/'+p['id']+'.owner-path-preparation.lock')
 real_chmod(fd,mode)
os.fsync=sync;os.fchmod=chmod
try: print(json.dumps(m.run(p)))
finally: os.fsync=real_sync;os.fchmod=real_chmod`;
  const result=run(f.packet,code);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).status,'directories-received');
});
function records(t) {
 const f=fixture(t),section=join(f.root,'exact-services-section'),parent=join(section,'data/records/owner');
 mkdirSync(parent,{recursive:true,mode:0o775});chmodSync(parent,0o775);
 const parametersPath=join(parent,'canonical.json'),preparationPath=join(parent,'preparation.json');
 writeFileSync(parametersPath,'{"canonical":true}\n',{mode:0o600});writeFileSync(preparationPath,'{"preparation":true}\n',{mode:0o600});
 return {...f,parent,parametersPath,preparationPath,binding:{sectionRoot:section,uid:process.getuid(),parametersPath,preparationPath}};
}
const hashFile=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
test('only the two private hash-bound read slots accept a real0775 read ancestor without changing it',t=>{
 const f=records(t),parent=facts(f.parent);
 for(const slot of ['parametersPath','preparationPath']){
  const received=receiveQuarantineReadRecord(f.binding,slot,hashFile(f[slot]));assert.equal(received.text,readFileSync(f[slot],'utf8'));assert.equal(received.identity[2],String(process.getuid()));
 }
 assert.deepEqual(facts(f.parent),parent);assert.throws(()=>receiveQuarantineReadRecord(f.binding,'arbitraryPath',hashFile(f.parametersPath)),/refused/);
});
test('private record receiving refuses changed content, final symlink, public mode and substituted inode identity',t=>{
 const f=records(t),hash=hashFile(f.parametersPath),before=receiveQuarantineReadRecord(f.binding,'parametersPath',hash);
 writeFileSync(f.parametersPath,'changed');assert.throws(()=>receiveQuarantineReadRecord(f.binding,'parametersPath',hash),/refused/);
 writeFileSync(f.parametersPath,before.text);chmodSync(f.parametersPath,0o644);assert.throws(()=>receiveQuarantineReadRecord(f.binding,'parametersPath',hash),/refused/);chmodSync(f.parametersPath,0o600);
 renameSync(f.parametersPath,f.parametersPath+'.original');symlinkSync(f.parametersPath+'.original',f.parametersPath);assert.throws(()=>receiveQuarantineReadRecord(f.binding,'parametersPath',hash),/refused/);rmSync(f.parametersPath);
 writeFileSync(f.parametersPath,before.text,{mode:0o600});const replaced=receiveQuarantineReadRecord(f.binding,'parametersPath',hash);assert.notDeepEqual(replaced.identity,before.identity,'production recheck must refuse substituted same-byte inode');
});
test('record allocation is bounded before reading and parent redirects/outside slots refuse',t=>{
 const f=records(t);writeFileSync(f.preparationPath,Buffer.alloc(65537));assert.throws(()=>receiveQuarantineReadRecord(f.binding,'preparationPath',hashFile(f.preparationPath)),/refused/);
 const outside=join(f.root,'outside.json');writeFileSync(outside,'outside',{mode:0o600});assert.throws(()=>receiveQuarantineReadRecord({...f.binding,parametersPath:outside},'parametersPath',hashFile(outside)),/refused/);
 renameSync(f.parent,f.parent+'.original');symlinkSync(f.parent+'.original',f.parent);assert.throws(()=>receiveQuarantineReadRecord(f.binding,'parametersPath',hashFile(f.parent+'.original/canonical.json')),/refused/);
});
