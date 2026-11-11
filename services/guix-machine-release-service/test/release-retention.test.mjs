import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,lstatSync,symlinkSync,utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {planRetention,applyRetention,heldEntries,parseGenerations,generationsToDelete,unitReferences} from '../scripts/release-retention.mjs';

const hex=(c)=>c.repeat(64);
const OLD=Date.now()-48*3600*1000;
const age=(path)=>utimesSync(path,new Date(OLD),new Date(OLD));

// A release root as the controller leaves it: legacy hashed trees, a rollback link to a pre-Guix tree,
// store-path current/previous links, stale scratch, and a unit file naming one old tree.
function fixture(){
  const base=mkdtempSync(join(tmpdir(),'retention-')),root=join(base,'releases'),units=join(base,'units');
  mkdirSync(root);mkdirSync(units);
  for(const c of ['a','b','c','d','e']){mkdirSync(join(root,hex(c)));writeFileSync(join(root,hex(c),'payload'),c.repeat(100));}
  for(const d of ['.staging-1','.probe-OLD','.probe-NEW','jobs','queue','units','.release.lock']){mkdirSync(join(root,d));writeFileSync(join(root,d,'f'),'x');}
  writeFileSync(join(root,'.materialization-x.json'),'');writeFileSync(join(root,'status.json'),'{}');
  age(join(root,'.staging-1'));age(join(root,'.probe-OLD'));age(join(root,'.materialization-x.json'));
  symlinkSync(hex('a'),join(root,'current'));              // relative link to a tree
  symlinkSync('/gnu/store/prev-deployment-1',join(root,'previous'));
  symlinkSync(hex('b'),join(root,'current.before-guix'));
  writeFileSync(join(units,'main.service'),`[Service]\nWorkingDirectory=${root}/${hex('c')}/deployment\nExecStart=/bin/node ${root}/current/bin/x\nEnvironmentFile=/etc/env\n`);
  writeFileSync(join(units,'other.service'),'[Service]\nExecStart=/gnu/store/zzz/bin/y\n');
  return {root,units};
}
const names=(list)=>list.map((i)=>i.name).sort();

test('keeps current, previous, the pre-Guix target and unit-named trees; removes the rest',()=>{
  const {root,units}=fixture();
  assert.deepEqual([...unitReferences(root,[units])].sort(),[hex('a'),hex('c')]);
  const plan=planRetention({root,unitDirs:[units]});
  assert.deepEqual(names(plan.keep),[hex('a'),hex('b'),hex('c'),'.probe-NEW'].sort());
  assert.deepEqual(names(plan.remove),[hex('d'),hex('e'),'.staging-1','.probe-OLD','.materialization-x.json'].sort());
  const kinds=Object.fromEntries(plan.remove.map((i)=>[i.name,i.kind]));
  assert.equal(kinds[hex('d')],'release-tree');assert.equal(kinds['.staging-1'],'staging');assert.equal(kinds['.materialization-x.json'],'materialization');
});

test('applying removes planned entries only and reports bytes; a dry run removes nothing',()=>{
  const {root,units}=fixture();const plan=planRetention({root,unitDirs:[units]});
  const dry=applyRetention(root,plan,{dryRun:true});
  assert.ok(existsSync(join(root,hex('d'))));assert.equal(dry.removed.length,5);
  const done=applyRetention(root,plan);
  assert.equal(done.removed.find((i)=>i.name===hex('d')).bytes,100+0);
  for(const gone of [hex('d'),hex('e'),'.staging-1','.probe-OLD','.materialization-x.json'])assert.ok(!existsSync(join(root,gone)),gone);
  for(const stay of [hex('a'),hex('b'),hex('c'),'.probe-NEW','jobs','queue','units','.release.lock','status.json','current','previous'])assert.ok(existsSync(join(root,stay))||lstatSync(join(root,stay)).isSymbolicLink(),stay);
});

test('a tree a live process holds is not removed',async()=>{
  const {root,units}=fixture();
  const child=spawn('sleep',['30'],{cwd:join(root,hex('d'))});
  try{
    await new Promise((r)=>setTimeout(r,200));
    const held=heldEntries(root);assert.ok(held.has(hex('d')));assert.ok(!held.has(hex('e')));
    const done=applyRetention(root,planRetention({root,unitDirs:[units]}),{held});
    assert.ok(existsSync(join(root,hex('d'))));assert.ok(!existsSync(join(root,hex('e'))));
    assert.deepEqual(done.skipped.map((i)=>i.name),[hex('d')]);
  }finally{child.kill();}
});

test('with no unit files the current and pre-Guix links alone protect their targets',()=>{
  const {root,units}=fixture();
  const plan=planRetention({root,unitDirs:[]});
  assert.ok(plan.remove.every((i)=>i.name!==hex('a')&&i.name!==hex('b')));
});

const LISTING=`Generation 3\tOct 01 2026 10:00:00
  app\t1\tout\t/gnu/store/old-app-1

Generation 17\tOct 08 2026 10:00:00
  app\t1\tout\t/gnu/store/prev-deployment-1

Generation 18\tOct 09 2026 18:40:30\t(current)
  app\t1\tout\t/gnu/store/cur-deployment-1
`;

test('profile generations: all but the current and those holding a kept store path',()=>{
  const generations=parseGenerations(LISTING);
  assert.deepEqual(generations.map((g)=>[g.number,g.current,g.stores.length]),[[3,false,1],[17,false,1],[18,true,1]]);
  assert.equal(generationsToDelete(generations,['/gnu/store/cur-deployment-1','/gnu/store/prev-deployment-1']),'3');
  assert.equal(generationsToDelete(generations,['/gnu/store/cur-deployment-1']),'3,17');
  assert.equal(generationsToDelete(parseGenerations(LISTING.split('\n\n')[2]),[]),'');
});
