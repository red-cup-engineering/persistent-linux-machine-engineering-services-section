import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,rmSync,readdirSync,existsSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {admittedRuntimeFile} from '../scripts/package-receiving.mjs';

const controller=fileURLToPath(new URL('../scripts/check-host.mjs',import.meta.url));
function fixture(t,layout='portable'){
  const root=mkdtempSync(join(tmpdir(),'installed-driver-layout-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const artifact=join(root,'artifact'),log=join(root,'receiving.jsonl');
  const write=(path,body)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,body);};
  write(join(artifact,'deployment/host.json'),'{}\n');
  write(join(artifact,'deployment/instance.json'),'{}\n');
  const driver=layout==='prepared'?join(artifact,'packages/@red-cup-engineering__feltos'):join(artifact,'node_modules/@red-cup-engineering/feltos');
  const manifest={name:'@red-cup-engineering/feltos',type:'module',bin:{feltos:'feltos.mjs'},
    exports:{'./package.json':'./package.json','./server/installed-web':'./installed-web.mjs'}};
  write(join(driver,'package.json'),JSON.stringify(manifest));
  // --check must parse this canonical driver without executing it.
  write(join(driver,'feltos.mjs'),'throw new Error("driver must never execute during structural receiving");\n');
  write(join(driver,'installed-web.mjs'),`import {appendFileSync} from 'node:fs';
export async function installedEnterpriseWeb(path,readerOptions){
 if(path!==${JSON.stringify(join(artifact,'deployment/host.json'))})throw Error('wrong host declaration');
 appendFileSync(${JSON.stringify(log)},'"installed-web"\\n');
 await readerOptions.readFile(path,'utf8');
 return {instancePath:${JSON.stringify(join(artifact,'deployment/instance.json'))}};
}\n`);
  const world=join(artifact,'node_modules/@red-cup-engineering/metroplat');
  write(join(world,'package.json'),JSON.stringify({name:'@red-cup-engineering/metroplat',type:'module',exports:{'.':'./metroplat.mjs','./instance':'./instance.mjs'}}));
  write(join(world,'metroplat.mjs'),'export default {kind:"feltos.world-library",modules:{}};\n');
  write(join(world,'instance.mjs'),`import {appendFileSync} from 'node:fs';
export async function installedMetroplatInstance(path,state,options,host,readerOptions){
 if(path!==${JSON.stringify(join(artifact,'deployment/instance.json'))}||state!==null||Object.keys(options).length!==0||host!==${JSON.stringify(join(artifact,'deployment/host.json'))})throw Error('wrong installed instance arguments');
 await readerOptions.readFile(path,'utf8');
 appendFileSync(${JSON.stringify(log)},'"installed-instance"\\n');
}\n`);
  if(layout==='prepared')symlinkSync(relative(join(artifact,'node_modules/@red-cup-engineering'),driver),join(artifact,'node_modules/@red-cup-engineering/feltos'));
  const run=(target=artifact)=>spawnSync(process.execPath,[controller,target],{cwd:root,env:{PATH:''},encoding:'utf8',timeout:15000});
  return {root,artifact,driver,world,manifest,write,run,log};
}
function received(f){
  const result=f.run();assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{kind:'guix.driver-library-receiving',sourceInterfacesReceived:true,instanceDeclarationsReceived:true,operatingReceiving:false});
  assert.equal(readFileSync(f.log,'utf8'),'"installed-web"\n"installed-instance"\n');
}
test('portable installed namespace reaches the same structural receiver without a packages directory',t=>received(fixture(t)));
test('existing prepared package namespace remains received',t=>received(fixture(t,'prepared')));
test('receiving refuses stale snapshot arguments and extra build-only arguments before provider use',t=>{
  const f=fixture(t);
  for(const extra of [[join(f.root,'snapshot')],['--build-only',join(f.root,'snapshot')]]){
    const result=spawnSync(process.execPath,[controller,f.artifact,...extra],{cwd:f.root,env:{PATH:''},encoding:'utf8',timeout:15000});
    assert.equal(result.status,1);assert.match(result.stderr,/unknown structural receiving argument/);
    assert.equal(existsSync(f.log),false);
  }
});
test('wrong exported package identity is refused before instance receiving',t=>{
  const f=fixture(t);f.write(join(f.driver,'package.json'),JSON.stringify({...f.manifest,name:'@unrelated/driver'}));
  const r=f.run();assert.equal(r.status,1);assert.match(r.stderr,/names another package/u);assert.equal(r.stdout,'');
});
test('held FeltOS 0.18.4 old driver bin remains refused',t=>{
  const f=fixture(t);f.write(join(f.driver,'package.json'),JSON.stringify({...f.manifest,version:'0.18.4',bin:{feltos:'scripts/feltos.mjs'}}));
  const r=f.run();assert.equal(r.status,1);assert.match(r.stderr,/canonical FeltOS driver/u);assert.equal(r.stdout,'');
});
test('canonical driver syntax still must pass without running the application',t=>{
  const f=fixture(t);f.write(join(f.driver,'feltos.mjs'),'export const = ;');
  const r=f.run();assert.equal(r.status,1);assert.match(r.stderr,/not valid for its Guix Node interpreter/u);
});
test('installed manifest cannot fall back to a provider outside the artifact',t=>{
  const f=fixture(t);const outside=join(f.root,'node_modules/@red-cup-engineering/feltos');
  f.write(join(outside,'package.json'),JSON.stringify(f.manifest));
  rmSync(f.driver,{recursive:true,force:true});
  const r=f.run();assert.equal(r.status,1);assert.match(r.stderr,/outside its artifact/u);assert.equal(r.stdout,'');
});
test('canonical driver symlink cannot escape the artifact',t=>{
  const f=fixture(t);const outside=join(f.root,'outside.mjs');f.write(outside,'export {};');
  rmSync(join(f.driver,'feltos.mjs'));symlinkSync(outside,join(f.driver,'feltos.mjs'));
  const r=f.run();assert.equal(r.status,1);assert.match(r.stderr,/outside its artifact/u);assert.equal(r.stdout,'');
});
test('installed world library contract is still required',t=>{
  const f=fixture(t);f.write(join(f.world,'metroplat.mjs'),'export default {kind:"other",modules:{}};');
  const r=f.run();assert.equal(r.status,1);assert.match(r.stderr,/world declaration/u);assert.equal(r.stdout,'');
});

test('actual Guix top-level carrier receives the same admitted driver namespace',t=>{
  const f=fixture(t),sealed=join(f.root,'sealed');
  f.write(join(f.artifact,'.metadata/sources.json'),'{}');mkdirSync(join(f.artifact,'.controller'));
  mkdirSync(sealed);for(const entry of readdirSync(f.artifact))symlinkSync(join(f.artifact,entry),join(sealed,entry));
  // The pure structural reader sees the sealed host path; these synthetic
  // providers record receiving only and never execute the FeltOS program.
  for(const path of [join(f.driver,'installed-web.mjs'),join(f.world,'instance.mjs')])
    f.write(path,readFileSync(path,'utf8').replaceAll(JSON.stringify(join(f.artifact,'deployment/host.json')),JSON.stringify(join(sealed,'deployment/host.json'))).replaceAll(JSON.stringify(join(f.artifact,'deployment/instance.json')),JSON.stringify(join(sealed,'deployment/instance.json'))));
  const result=f.run(sealed);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).operatingReceiving,false);
});
test('legacy sealed app alias keeps its confined internal FeltOS target',t=>{
  const f=fixture(t),sealed=join(f.root,'sealed');
  f.write(join(f.artifact,'.metadata/sources.json'),'{}');mkdirSync(join(f.artifact,'.controller'));
  symlinkSync(relative(f.artifact,f.driver),join(f.artifact,'app'));
  mkdirSync(sealed);for(const entry of readdirSync(f.artifact))symlinkSync(join(f.artifact,entry),join(sealed,entry));
  assert.equal(admittedRuntimeFile(sealed,join(sealed,'app/feltos.mjs')),join(f.driver,'feltos.mjs'));
});
test('sealed carrier cannot relabel a split metadata/controller runtime',t=>{
  const f=fixture(t),sealed=join(f.root,'sealed'),outside=join(f.root,'outside');
  f.write(join(f.artifact,'.metadata/sources.json'),'{}');mkdirSync(join(f.artifact,'.controller'));mkdirSync(outside);mkdirSync(sealed);
  for(const entry of readdirSync(f.artifact))symlinkSync(entry==='.controller'?outside:join(f.artifact,entry),join(sealed,entry));
  const result=f.run(sealed);assert.equal(result.status,1);assert.match(result.stderr,/carrier entries disagree/);
});

test('missing local world cannot import a parent package',t=>{
  const f=fixture(t),outside=join(f.root,'node_modules/@red-cup-engineering/metroplat');
  mkdirSync(dirname(outside),{recursive:true});cpSync(f.world,outside,{recursive:true});rmSync(f.world,{recursive:true});
  f.write(join(outside,'metroplat.mjs'),'throw new Error("UNADMITTED_IMPORT_EXECUTED");');
  const result=f.run();assert.equal(result.status,1);assert.match(result.stderr,/outside its artifact admitted runtime/);assert.doesNotMatch(result.stderr,/UNADMITTED_IMPORT_EXECUTED/);assert.equal(existsSync(f.log),false);
});
for(const [label,relativeFile] of [['host','installed-web.mjs'],['instance','instance.mjs']])test('outside '+label+' provider entrance refuses before any provider import',t=>{
  const f=fixture(t),base=label==='host'?f.driver:f.world,outside=join(f.root,'outside-reader.mjs'),file=join(base,relativeFile);
  f.write(outside,'throw new Error("UNADMITTED_IMPORT_EXECUTED");');rmSync(file);symlinkSync(outside,file);
  const result=f.run();assert.equal(result.status,1);assert.match(result.stderr,/outside its artifact admitted runtime/);assert.doesNotMatch(result.stderr,/UNADMITTED_IMPORT_EXECUTED/);assert.equal(existsSync(f.log),false);
});
test('split sealed deployment is refused before direct provider import',t=>{
  const f=fixture(t),sealed=join(f.root,'sealed'),outside=join(f.root,'outside-deployment');
  f.write(join(f.artifact,'.metadata/sources.json'),'{}');mkdirSync(join(f.artifact,'.controller'));mkdirSync(outside);f.write(join(outside,'host.json'),'{}');mkdirSync(sealed);
  for(const entry of readdirSync(f.artifact))symlinkSync(entry==='deployment'?outside:join(f.artifact,entry),join(sealed,entry));
  const result=f.run(sealed);assert.equal(result.status,1);assert.match(result.stderr,/carrier entry differs/);assert.equal(existsSync(f.log),false);
});
test('installed reader must actually consume the admitted read port',t=>{
  const f=fixture(t);f.write(join(f.driver,'installed-web.mjs'),`export async function installedEnterpriseWeb(){return {instancePath:${JSON.stringify(join(f.artifact,'deployment/instance.json'))}};}`);
  const result=f.run();assert.equal(result.status,1);assert.match(result.stderr,/did not receive the admitted read port/);
});
