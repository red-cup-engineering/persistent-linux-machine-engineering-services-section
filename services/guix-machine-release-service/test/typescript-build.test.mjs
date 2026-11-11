import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hasTypeScriptBuild} from '../scripts/typescript-build.mjs';
import {compose} from '../scripts/test-change.mjs';

const recipe='tsc -p tsconfig.build.json';
test('only the exact legacy or Node-only TypeScript recipe is enrolled',()=>{
  for(const scripts of [{build:recipe},{'build:node':recipe},{build:recipe,'build:node':recipe},
    {build:'forge build','build:node':recipe},{build:recipe,'build:node':'forge build'},
    {'build:node':recipe,check:'npm run check:node && forge build --force',test:'npm run test:node && forge test'}])
    assert.equal(hasTypeScriptBuild({scripts}),true,JSON.stringify(scripts));
  for(const manifest of [{},{scripts:null},{scripts:{}},{scripts:{check:recipe,test:recipe,'build:types':recipe}}])
    assert.equal(hasTypeScriptBuild(manifest),false,JSON.stringify(manifest));
});

test('recipe enrollment never parses, trims, expands or coerces script commands',()=>{
  for(const value of [null,true,42,[recipe],{command:recipe},'',` ${recipe}`,`${recipe} `,`${recipe}\n`,
    'tsc  -p tsconfig.build.json','tsc --project tsconfig.build.json','tsc -p ./tsconfig.build.json',
    'tsc -p tsconfig.json','npx tsc -p tsconfig.build.json',`NODE_OPTIONS=x ${recipe}`,`${recipe} --incremental`,
    `${recipe} && forge build`,`${recipe}; forge build`,`${recipe} | sh`,`${recipe} $(touch sentinel)`,
    `sh -c '${recipe}'`]){
    for(const key of ['build','build:node'])assert.equal(hasTypeScriptBuild({scripts:{[key]:value}}),false,`${key}: ${JSON.stringify(value)}`);
  }
});

const service=fileURLToPath(new URL('../',import.meta.url));
const toolchain='/gnu/store/'+'a'.repeat(32)+'-machine-dependency-toolchain';
const controller='@red-cup-engineering/guix-machine-release-service';
const metroplat='@red-cup-engineering/metroplat';
const host='@red-cup-engineering/feltos-enterprise-host';
const manifests=[
  {name:'@fixture/node',scripts:{'build:node':recipe,build:'forge build',prebuild:'forge build',
    'prebuild:node':'forge build',postbuild:'forge build','postbuild:node':'forge build',
    check:'npm run check:node && forge build --force',test:'npm run test:node && forge test'},dependencies:{'@fixture/legacy':'workspace:*'}},
  {name:'@fixture/rejected',scripts:{build:recipe+' && forge build','build:node':recipe+' --incremental'}},
  {name:'@fixture/legacy',scripts:{build:recipe}},
  {name:'@fixture/both',scripts:{build:recipe,'build:node':recipe},dependencies:{'@fixture/legacy':'workspace:*'}},
  {name:controller},{name:metroplat},{name:host},
].map(manifest=>({version:'0.0.0-fixture',type:'module',exports:'./index.mjs',...manifest}));
const packageDirectory=(workspace,name)=>join(workspace,'packages',name.replaceAll('/','__'));
function put(path,content){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof content==='string'?content:JSON.stringify(content));}
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'typescript-build-enrollment-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const workspace=join(root,'workspace'),snapshot=join(root,'snapshot'),output=join(root,'output'),calls=join(root,'calls.jsonl');
  const lock=JSON.stringify({lockfileVersion:'9.0',importers:{'.':{}},packages:{},snapshots:{}})+'\n';
  for(const file of ['machine.json','machine.scm','channels.scm','sources.json','dependencies.lock.yaml'])
    put(join(snapshot,file),file==='dependencies.lock.yaml'?lock:'{}\n');
  for(const directory of ['deployment','deployments'])mkdirSync(join(snapshot,directory),{recursive:true});
  return {root,workspace,snapshot,output,calls,lock,buildInvocations:[]};
}
function packageFiles(directory,manifest){
  put(join(directory,'package.json'),manifest);
  put(join(directory,'index.mjs'),'export const fixture = true;\n');
  put(join(directory,'tsconfig.build.json'),'{}\n');
  if(manifest.name===metroplat)put(join(directory,'scripts/generate-operation-family-descriptors.mjs'),'// Inert descriptor fixture; no operations or external effects.\n');
}
// An inert recorder, never a substitute compiler qualification. The actual
// consumer must call Node directly with the fixed compiler/config argv.
function compilerFixture(f,fail){
  put(join(f.workspace,'node_modules/typescript/bin/tsc'),
    `const {appendFileSync,readFileSync,writeFileSync}=require('node:fs');\n`+
    `const name=JSON.parse(readFileSync('package.json','utf8')).name;\n`+
    `appendFileSync(${JSON.stringify(f.calls)},JSON.stringify({name,program:process.execPath,args:process.argv.slice(2)})+'\\n');\n`+
    (fail?`if(name==='@fixture/node')throw new Error('deliberate compiler refusal');\n`:'')+
    `writeFileSync('fixture-emitted.txt',name+'\\n');\n`);
}
function recorded(f){return readFileSync(f.calls,'utf8').trim().split('\n').map(line=>JSON.parse(line));}
function expected(f){return ['@fixture/legacy','@fixture/node','@fixture/both'].map(name=>({name,program:process.execPath,
  args:['-p',join(packageDirectory(f.workspace,name),'tsconfig.build.json')]}));}
function composeFixture(f,fail){
  const repository=join(f.root,'repository');
  for(const [index,manifest] of manifests.entries())packageFiles(join(repository,'services',String(index)),manifest);
  const git=(...args)=>{const r=spawnSync('git',args,{cwd:repository,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git('init','-q');git('add','.');git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','inert TypeScript enrollment fixtures');
  const source={repository:'fixture/source',directory:repository,commit:git('rev-parse','HEAD')};
  return compose({service,spec:{entries:manifests.map(m=>m.name)},snapshot:f.snapshot,repositories:[source],owners:{},buildEntries:[],
    workspace:f.workspace,work:f.root,toolchain,execute:(program,args,options)=>{
      assert.equal(program,toolchain+'/bin/node');
      if(args.includes('--acquire-guix-frozen')){
        compilerFixture(f,fail);return {status:0,stdout:JSON.stringify({lockState:'frozen',pnpmVersion:'10.34.6'})};
      }
      const compiler=join(f.workspace,'node_modules/typescript/bin/tsc');
      const descriptor=join(packageDirectory(f.workspace,metroplat),'scripts/generate-operation-family-descriptors.mjs');
      assert.ok(args[0]===compiler||args[0]===descriptor,'only the declared inert build fixtures execute');
      if(args[0]===compiler)assert.deepEqual(args,[compiler,'-p',join(options.cwd,'tsconfig.build.json')]);
      else assert.deepEqual(args,[descriptor]);
      f.buildInvocations.push({program,args:[...args],cwd:options.cwd});
      // The injected port checks the qualified interpreter identity; local Node
      // executes the inert recorder, not a claimed Guix/TypeScript qualification.
      return spawnSync(process.execPath,args,options);
    }});
}
function assembleFixture(f,fail){
  for(const manifest of manifests)packageFiles(packageDirectory(f.workspace,manifest.name),manifest);
  compilerFixture(f,fail);
  put(join(f.workspace,'package.json'),'{}\n');
  put(join(f.workspace,'sources.json'),{packages:manifests.map(m=>({name:m.name,version:m.version,repository:'fixture/source',commit:'a'.repeat(40)}))});
  put(join(f.workspace,'source-imports.json'),{fixture:true});
  put(join(f.workspace,'pnpm-lock.yaml'),f.lock);put(join(f.workspace,'node_modules/.pnpm/lock.yaml'),f.lock);
  // JSON/YAML-subset parser fixture isolates assembly; no dependency install.
  put(join(f.workspace,'node_modules/yaml/package.json'),{name:'yaml',version:'0.0.0-fixture',main:'index.cjs'});
  put(join(f.workspace,'node_modules/yaml/index.cjs'),'exports.parse=JSON.parse;\n');
  return spawnSync(process.execPath,[join(service,'scripts/assemble.mjs'),f.workspace,f.snapshot,f.output],{encoding:'utf8',timeout:30000});
}

test('actual change composition builds Node-only and legacy dependencies directly, once, without lifecycle or Forge',t=>{
  const f=fixture(t),result=composeFixture(f,false);
  assert.equal(result.lockState,'frozen');assert.deepEqual(recorded(f),expected(f));
  assert.equal(result.nodeExecutable,toolchain+'/bin/node');
  assert.equal(f.buildInvocations.length,4,'three compilers and one descriptor, each once');
  for(const {name} of expected(f))assert.equal(readFileSync(join(packageDirectory(f.workspace,name),'fixture-emitted.txt'),'utf8'),name+'\n');
  assert.equal(existsSync(join(packageDirectory(f.workspace,'@fixture/rejected'),'fixture-emitted.txt')),false);
  assert.equal(readFileSync(join(f.workspace,'.composed'),'utf8'),'frozen\n');
});
test('actual release assembly uses the same bounded recipes and fixed interpreter/argv',t=>{
  const f=fixture(t),result=assembleFixture(f,false);
  assert.equal(result.status,0,result.stderr);assert.deepEqual(recorded(f),expected(f));
  const closure=JSON.parse(result.stdout.trim().split('\n').at(-1)).closure;
  assert.equal(readFileSync(join(closure,'.metadata/dependencies.lock.yaml'),'utf8'),f.lock);
});
test('a Node-only compiler failure stops composition without a completion marker',t=>{
  const f=fixture(t);
  assert.throws(()=>composeFixture(f,true),/deliberate compiler refusal/);
  assert.deepEqual(recorded(f),expected(f).slice(0,2));assert.equal(existsSync(join(f.workspace,'.composed')),false);
  assert.equal(f.buildInvocations.length,2,'the nonzero compiler stops later builds and descriptors');
  assert.equal(readFileSync(join(packageDirectory(f.workspace,'@fixture/legacy'),'fixture-emitted.txt'),'utf8'),'@fixture/legacy\n');
  assert.equal(existsSync(join(packageDirectory(f.workspace,'@fixture/node'),'fixture-emitted.txt')),false);
});
test('a Node-only compiler failure stops release assembly before sealing',t=>{
  const f=fixture(t),result=assembleFixture(f,true);
  assert.notEqual(result.status,0);assert.match(result.stderr,/deliberate compiler refusal/);
  assert.deepEqual(recorded(f),expected(f).slice(0,2));assert.equal(existsSync(f.output),false);
});
