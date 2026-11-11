import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {guardStorage,reserveBytes,storageUnits,collectionTarget} from '../scripts/release-storage.mjs';

test('the generation-linked controller executes the actual guard instead of silently succeeding',()=>{
  const root=mkdtempSync(join(tmpdir(),'storage-generation-'));
  try {
    symlinkSync(dirname(fileURLToPath(new URL('../scripts/release-storage.mjs',import.meta.url))),join(root,'.controller'),'dir');
    const configuration=join(root,'machine.json');
    writeFileSync(configuration,JSON.stringify({releaseRoot:root}));
    const received=spawnSync(process.execPath,[join(root,'.controller/release-storage.mjs'),configuration],{encoding:'utf8'});
    // No lease is admitted in this fixture: executing the real CLI must refuse.
    // The former lexical path comparison returned success without doing anything.
    assert.equal(received.status,1);
    assert.match(received.stderr,/existing release writer lease required/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('the collector target includes blocks unavailable to the service account',()=>{
  assert.equal(collectionTarget({bfree:100n,bavail:80n,bsize:4096n}),reserveBytes+81920n);
  assert.throws(()=>collectionTarget({bfree:1n,bavail:2n,bsize:4096n}),/invalid filesystem/);
});

test('adequate reserve never collects or edits roots',()=>{
  assert.equal(guardStorage({readFree:()=>reserveBytes,collect:()=>assert.fail('collection unnecessary')}).admitted,true);
});
test('pressure collects then independently receives the actual remaining bytes',()=>{
  let collected=false;
  const observed=guardStorage({readFree:()=>collected?reserveBytes:1n,collect:n=>{assert.equal(n,reserveBytes);collected=true;}});
  assert.equal(observed.collected,true);assert.equal(observed.availableBytes,String(reserveBytes));
});
test('a successful collector cannot admit insufficient physical space',()=>{
  assert.throws(()=>guardStorage({readFree:()=>1n,collect:()=>{}}),error=>error.observation?.admitted===false);
});
test('collector refusal and unavailable storage block admission',()=>{
  assert.throws(()=>guardStorage({readFree:()=>0n,collect:()=>{throw new Error('GC unavailable');}}),/GC unavailable/);
  assert.throws(()=>guardStorage({readFree:()=>-1n,collect:()=>assert.fail()}),/invalid available/);
});
test('a real systemd receiver accepts the generation-bound units',()=>{
  const root=mkdtempSync(join(tmpdir(),'storage-units-'));
  // Verifying unit files needs a user runtime directory, not a running user manager: a receiver supervised by
  // GNU Shepherd (an ephemeral colony) has none, so the check gets its own.
  const runtime=mkdtempSync(join(tmpdir(),'storage-units-runtime-'));
  try {
    const units=storageUnits('cold-red-gate',process.execPath,'/RELEASE/.controller/scripts/release-storage.mjs','/RELEASE/.controller/machine.json');
    for(const [name,body] of Object.entries(units))writeFileSync(join(root,name),body);
    const received=spawnSync('systemd-analyze',['--user','verify',...Object.keys(units).map(name=>join(root,name))],{encoding:'utf8',env:{...process.env,XDG_RUNTIME_DIR:runtime}});
    assert.equal(received.status,0,received.stderr);
    assert.match(units['cold-red-gate-storage.timer'],/OnUnitInactiveSec=15min/);
    assert.match(units['cold-red-gate-storage.service'],/\/RELEASE\/\.controller\/machine.json/);
  } finally {rmSync(root,{recursive:true,force:true});rmSync(runtime,{recursive:true,force:true});}
});
test('unit injection and invalid reserve never become commands',()=>{
  assert.throws(()=>storageUnits('x\nExecStart=bad','/node','/script','/config'),/invalid machine/);
  assert.throws(()=>storageUnits('machine','/node','/script%h','/config'),/literal unit path/);
  assert.throws(()=>guardStorage({readFree:()=>0n,collect:()=>assert.fail(),reserve:0n}),/reserve required/);
});
