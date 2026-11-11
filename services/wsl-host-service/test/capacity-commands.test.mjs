import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {renderCapacityGuard,capacityCommandDeclaration,planCapacityCommands,applyCapacityCommands,restoreCapacityCommands} from '../src/capacity-commands.mjs';

test('filesystem stat modes cannot hide inside grouped or abbreviated options',()=>{
  for(const args of [['-f','/'],['-Lf','/'],['-tf','/'],['/','-f'],['--file-system','/'],['--file-s','/'],['--fi','/']]) assert.equal(run('stat',args).status,78,JSON.stringify(args));
});
test('ordinary file formats, literal operands and consumed -f remain file stat',()=>{
  for(const args of [['-c','%f','/'],['-c','-f','/'],['-Lc-f','/'],['--format=-f','/'],['--fo','-f','/'],['--printf','-f','/'],['--pri=-f','/'],['--','-f']]) assert.notEqual(run('stat',args).status,78,JSON.stringify(args));
});
const d={shell:'/bin/bash',capacityCommand:['/native-capacity','--record=/original'],commands:[]};
function run(kind,args){
  const code=renderCapacityGuard(d,{kind,guestPath:'/usr/bin/'+kind});
  return spawnSync('/bin/bash',['-s','--',...args],{input:code,encoding:'utf8'});
}
test('df free-space query refuses without emitting misleading machine-readable stdout',()=>{
  const r=run('df',['--output=avail','-B1','/']);assert.equal(r.status,78);assert.equal(r.stdout,'');assert.match(r.stderr,/native-capacity/);assert.match(r.stderr,/not Windows-backed/);
});
test('df filenames after -- cannot masquerade as help or version options',()=>{
  for(const args of [['--','--help'],['--','--version'],['/','--help']]){
    const r=run('df',args);assert.equal(r.status,78);assert.equal(r.stdout,'');
  }
});
test('filesystem stat free blocks refuse without stdout',()=>{
  const r=run('stat',['-Lf','-c','%a %S','/']);assert.equal(r.status,78);assert.equal(r.stdout,'');
});
test('ordinary file metadata remains byte-identical to native stat',()=>{
  for(const args of [['-c','%d:%i:%a','/'],['--format=-f','/'],['-c','-f','/'],['--fo','%a','/']]){
    const native=spawnSync('/usr/bin/stat',args,{encoding:'utf8'});const guarded=run('stat',args);
    assert.equal(guarded.status,native.status);assert.equal(guarded.stdout,native.stdout);assert.equal(guarded.stderr,native.stderr);
  }
});
test('legacy undeclared records keep their command lifecycle',()=>{
  assert.equal(capacityCommandDeclaration({linux:{}}),null);assert.equal(planCapacityCommands({linux:{}}).current,true);
});
test('ambiguous or malformed declared command tuples refuse before effects',()=>{
  assert.throws(()=>capacityCommandDeclaration({linux:{capacityCommands:{...d,mode:'refuse-guest-capacity',dpkgDivert:'/dpkg-divert',dpkgQuery:'/dpkg-query',basis:'test',commands:[]}}}));
});

test('native isolated dpkg lifecycle receives preparation, guards, no-write reentry and exact rollback',{skip:process.getuid()!==0},()=>{
  const root=fs.mkdtempSync('/run/wsl-capacity-native-'), originalRoot=fs.statSync(root);
  try {
    const db=path.join(root,'dpkg'), bin=path.join(root,'bin'), guest=path.join(root,'guest');
    fs.mkdirSync(path.join(db,'info'),{recursive:true});fs.mkdirSync(bin);
    fs.writeFileSync(path.join(db,'status'),'Package: wsl-capacity-fixture\nStatus: install ok installed\nPriority: optional\nSection: misc\nInstalled-Size: 1\nMaintainer: Native test\nArchitecture: all\nVersion: 1.0\nDescription: exact isolated test images\n');
    const commands=['df','stat'].map(kind=>{
      const file=path.join(bin,kind),bytes='#!/bin/sh\nprintf "%s\\n" original-'+kind+'\n';
      fs.writeFileSync(file,bytes,{mode:0o755});
      return {kind,path:file,guestPath:path.join(guest,kind),package:'wsl-capacity-fixture',originalSha256:createHash('sha256').update(bytes).digest('hex')};
    });
    fs.writeFileSync(path.join(db,'info/wsl-capacity-fixture.list'),commands.map(c=>c.path).join('\n')+'\n');
    const p={linux:{capacityCommands:{...d,mode:'refuse-guest-capacity',dpkgDivert:'/usr/bin/dpkg-divert',dpkgQuery:'/usr/bin/dpkg-query',basis:'native isolated package database, never system metadata',commands}}};
    let mutations=0;
    const ports={run:(program,args)=>{if(args.includes('--add')||args.includes('--remove'))mutations++;return execFileSync(program,['--admindir='+db,...args],{encoding:'utf8'}).trim();}};
    const original=commands.map(c=>fs.statSync(c.path));
    // Actual partial native preparation: retain the exact image before diversion.
    fs.mkdirSync(guest);fs.linkSync(commands[0].path,commands[0].guestPath);
    assert.equal(planCapacityCommands(p,ports).current,false);
    assert.equal(applyCapacityCommands(p,ports).converged,true);assert.equal(mutations,2);
    const selected=commands.map(c=>fs.statSync(c.path));
    for(let n=0;n<commands.length;n++)assert.equal(fs.statSync(commands[n].guestPath).ino,original[n].ino,'hard-link custody creates no binary copy');
    assert.equal(applyCapacityCommands(p,ports).changed.length,0);assert.equal(mutations,2);
    assert.deepEqual(commands.map(c=>fs.statSync(c.path).ino),selected.map(x=>x.ino));
    const interrupt={run:(program,args)=>{
      if(args.includes('--remove')&&args.at(-1)===commands[1].path)throw new Error('native second-removal boundary interrupted');
      return ports.run(program,args);
    }};
    assert.throws(()=>restoreCapacityCommands(p,interrupt),/second-removal boundary/);
    assert.equal(restoreCapacityCommands(p,ports).restored.length,1);assert.equal(mutations,4);
    assert.equal(restoreCapacityCommands(p,ports).restored.length,0);assert.equal(mutations,4);
    for(let n=0;n<commands.length;n++){assert.equal(fs.statSync(commands[n].path).ino,original[n].ino);assert.equal(fs.existsSync(commands[n].guestPath),false);}
    assert.equal(planCapacityCommands(p,ports).current,false);
  } finally {
    const now=fs.statSync(root);assert.equal(now.ino,originalRoot.ino);assert.equal(now.dev,originalRoot.dev);
    fs.rmSync(root,{recursive:true}); // only this test's exclusive native fixture
  }
});
