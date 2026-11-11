import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {admittedRuntimeCarriers,admittedRuntimeFile,selectedPackageDirectory} from '../scripts/package-receiving.mjs';

// These are filesystem-carrier controls, not a Guix build or NAR verification.
// Map only the store coordinate to this fixture's temporary directory; the
// production admission functions and ordinary filesystem operations are real.
function fixture(t){
  const base=fs.mkdtempSync(join(tmpdir(),'shared-runtime-carriers-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const store=join(base,'store');fs.mkdirSync(store);
  const physical=p=>typeof p==='string'&&(p==='/gnu/store'||p.startsWith('/gnu/store/'))?store+p.slice('/gnu/store'.length):p;
  const logical=p=>typeof p==='string'&&(p===store||p.startsWith(store+'/'))?'/gnu/store'+p.slice(store.length):p;
  const put=(path,bytes)=>{const at=physical(path);fs.mkdirSync(dirname(at),{recursive:true});fs.writeFileSync(at,bytes);};
  const link=(target,path)=>{fs.mkdirSync(dirname(physical(path)),{recursive:true});fs.symlinkSync(physical(target),physical(path));};
  const software='/gnu/store/fixture-software',runtime='/gnu/store/fixture-runtime';
  const source={name:'@red-cup-engineering/feltos',installationPath:'packages/feltos'};
  put(runtime+'/package.json','{"name":"fixture"}');
  put(runtime+'/packages/feltos/package.json','{"name":"@red-cup-engineering/feltos"}');
  put(runtime+'/packages/feltos/feltos.mjs','export const fixture = true;\n');
  const modulePath=physical(runtime+'/node_modules/@red-cup-engineering/feltos');
  fs.mkdirSync(dirname(modulePath),{recursive:true});
  fs.symlinkSync(relative(dirname(modulePath),physical(runtime+'/packages/feltos')),modulePath);
  fs.symlinkSync('packages/feltos',physical(runtime+'/app'));
  link(runtime,software+'/share/runtime');
  function target(name){
    const receiver='/gnu/store/fixture-envelope-'+name,outer='/gnu/store/fixture-target-'+name;
    fs.mkdirSync(physical(outer));
    put(receiver+'/.metadata/sources.json',JSON.stringify({packages:[source],repositories:[]}));
    put(receiver+'/.metadata/release.json',JSON.stringify({machineRepository:'561-group/'+name,software:{storePath:software,narSha256:'a'.repeat(64),sourceCommit:'b'.repeat(40)}}));
    put(receiver+'/.controller/package.json','{"name":"@red-cup-engineering/guix-machine-release-service"}');
    put(receiver+'/.controller/scripts/check-host.mjs','// exact inert controller source\n');
    put(receiver+'/.controller/machine.scm','; authenticated target declaration\n');
    fs.mkdirSync(physical(receiver+'/.controller/empty'));
    fs.cpSync(physical(receiver+'/.controller'),physical(outer+'/.controller'),{recursive:true});
    put(outer+'/.controller/machine.json',JSON.stringify({repository:'561-group/'+name,stateCompatibility:'preserve-existing'}));
    put(receiver+'/deployment/host.json',JSON.stringify({instance:name+'.json'}));
    link(software,outer+'/.software');
    for(const entry of ['.metadata','deployment'])link(receiver+'/'+entry,outer+'/'+entry);
    for(const entry of ['node_modules','package.json','packages','app'])link(software+'/share/runtime/'+entry,outer+'/'+entry);
    return {outer,receiver};
  }
  const first=target('first'),second=target('second'),reads=[];
  for(const method of ['lstatSync','readFileSync','readlinkSync','realpathSync','readdirSync']){
    const native=fs[method];
    t.mock.method(fs,method,(path,...args)=>{
      if(method==='readFileSync')reads.push(path);
      const result=native(physical(path),...args);
      return method==='readlinkSync'||method==='realpathSync'?logical(result):result;
    });
  }
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  const replaceLink=(path,target)=>{fs.unlinkSync(physical(path));link(target,path);};
  return {base,software,runtime,source,first,second,put,link,physical,replaceLink,reads};
}

test('two admitted target envelopes use the same software without exchanging declarations',t=>{
  const f=fixture(t);
  for(const target of [f.first,f.second]){
    assert.deepEqual(admittedRuntimeCarriers(target.outer),{runtime:f.runtime,receiver:target.receiver});
    assert.equal(selectedPackageDirectory(target.outer,f.source),f.runtime+'/packages/feltos');
    assert.equal(admittedRuntimeFile(target.outer,target.outer+'/app/feltos.mjs'),f.runtime+'/packages/feltos/feltos.mjs');
    assert.equal(admittedRuntimeFile(target.outer,target.outer+'/deployment/host.json'),target.receiver+'/deployment/host.json');
    assert.equal(admittedRuntimeFile(target.outer,target.outer+'/.controller/scripts/check-host.mjs'),target.outer+'/.controller/scripts/check-host.mjs');
    assert.equal(admittedRuntimeFile(target.outer,target.outer+'/.controller/machine.json'),target.outer+'/.controller/machine.json');
  }
  assert.throws(()=>admittedRuntimeFile(f.first.outer,f.second.receiver+'/deployment/host.json'),/outside/);
});

test('shared store wrapper cannot admit a mutable external runtime',t=>{
  const f=fixture(t),external=join(f.base,'mutable-runtime');
  fs.cpSync(f.physical(f.runtime),external,{recursive:true,verbatimSymlinks:true});
  f.replaceLink(f.software+'/share/runtime',external);
  assert.throws(()=>admittedRuntimeCarriers(f.first.outer),/immutable store-held/);
  assert.equal(f.reads.length,0);
});

test('target metadata cannot select a mutable external envelope',t=>{
  const f=fixture(t),external=join(f.base,'mutable-envelope');
  fs.cpSync(f.physical(f.first.receiver),external,{recursive:true,verbatimSymlinks:true});
  for(const entry of ['.metadata','deployment'])f.replaceLink(f.first.outer+'/'+entry,external+'/'+entry);
  assert.throws(()=>admittedRuntimeCarriers(f.first.outer),/target envelope/);
  assert.equal(f.reads.length,0);
});

test('mixed envelope entries and swapped software receipt are refused',t=>{
  const f=fixture(t);
  f.replaceLink(f.first.outer+'/deployment',f.second.receiver+'/deployment');
  assert.throws(()=>admittedRuntimeCarriers(f.first.outer),/entries disagree/);
  f.replaceLink(f.first.outer+'/deployment',f.first.receiver+'/deployment');
  f.put(f.first.receiver+'/.metadata/release.json',JSON.stringify({software:{storePath:'/gnu/store/other-software',narSha256:'a'.repeat(64),sourceCommit:'b'.repeat(40)}}));
  assert.throws(()=>admittedRuntimeCarriers(f.first.outer),/differs from its shared software receipt/);
});

test('internal aliases stay valid while external package hops refuse',t=>{
  const f=fixture(t),external=join(f.base,'external');f.put(external+'/outside.mjs','unadmitted fixture');
  f.link(external,f.runtime+'/packages/feltos/escape');
  assert.throws(()=>admittedRuntimeFile(f.first.outer,f.first.outer+'/app/escape/outside.mjs'),/outside/);
  assert.equal(admittedRuntimeFile(f.first.outer,f.first.outer+'/app/feltos.mjs'),f.runtime+'/packages/feltos/feltos.mjs');
});

for(const mutation of ['bytes','executable','missing','extra-file','extra-directory','missing-directory','source-link','copy-link','controller-link','authored-policy'])
test('native copied controller refuses '+mutation,t=>{
  const f=fixture(t),source=f.first.receiver+'/.controller',copy=f.first.outer+'/.controller';
  if(mutation==='bytes')f.put(copy+'/scripts/check-host.mjs','// changed controller source\n');
  if(mutation==='executable')fs.chmodSync(f.physical(copy+'/scripts/check-host.mjs'),0o755);
  if(mutation==='missing')fs.unlinkSync(f.physical(copy+'/scripts/check-host.mjs'));
  if(mutation==='extra-file')f.put(copy+'/extra.mjs','unadmitted');
  if(mutation==='extra-directory')fs.mkdirSync(f.physical(copy+'/extra'));
  if(mutation==='missing-directory')fs.rmdirSync(f.physical(copy+'/empty'));
  if(mutation==='source-link'||mutation==='copy-link'){
    const file=(mutation==='source-link'?source:copy)+'/scripts/check-host.mjs';
    fs.unlinkSync(f.physical(file));f.link(f.second.outer+'/.controller/scripts/check-host.mjs',file);
  }
  if(mutation==='controller-link'){
    fs.rmSync(f.physical(copy),{recursive:true});f.link(source,copy);
  }
  if(mutation==='authored-policy')f.put(source+'/machine.json','{}');
  assert.throws(()=>admittedRuntimeCarriers(f.first.outer),/controller|authored machine/);
});

for(const [label,body] of [['null','null'],['array','[]'],['malformed','{'],
  ['foreign',JSON.stringify({repository:'561-group/second',stateCompatibility:'preserve-existing'})],
  ['state-change',JSON.stringify({repository:'561-group/first',stateCompatibility:'replace'})]])
test('generated native policy refuses '+label,t=>{
  const f=fixture(t);f.put(f.first.outer+'/.controller/machine.json',body);
  assert.throws(()=>admittedRuntimeCarriers(f.first.outer));
});

test('generated native policy must be a direct nonexecutable regular file',t=>{
  const f=fixture(t),file=f.first.outer+'/.controller/machine.json';
  fs.chmodSync(f.physical(file),0o755);
  assert.throws(()=>admittedRuntimeCarriers(f.first.outer),/policy is executable/);
  fs.unlinkSync(f.physical(file));f.link(f.second.outer+'/.controller/machine.json',file);
  assert.throws(()=>admittedRuntimeCarriers(f.first.outer),/regular file without symlinks/);
});

test('native target controller cannot be admitted from a mutable outer copy',t=>{
  const f=fixture(t),outside=join(f.base,'mutable-target');
  fs.cpSync(f.physical(f.first.outer),outside,{recursive:true,verbatimSymlinks:true});
  assert.throws(()=>admittedRuntimeCarriers(outside),/direct sealed source copy/);
});
