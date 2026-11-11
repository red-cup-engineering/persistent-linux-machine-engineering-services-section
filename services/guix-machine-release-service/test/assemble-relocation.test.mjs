import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,existsSync,cpSync,renameSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const controllerName='@red-cup-engineering/guix-machine-release-service';
const parserName='@red-cup-engineering/javascript-node-services-section';
const assemble=fileURLToPath(new URL('../scripts/assemble.mjs',import.meta.url));
const guard=fileURLToPath(new URL('../scripts/guix-deployment.scm',import.meta.url));
const scheme=`(use-modules (ice-9 ftw) (ice-9 match) (srfi srfi-1))
(call-with-input-file (cadr (command-line))
 (lambda (port) (let loop ((form (read port)))
  (unless (eof-object? form)
   (match form (('define ('assert-closed . arguments) . body) (eval form (current-module))) (_ #f))
   (loop (read port))))))
(assert-closed (caddr (command-line)))`;
const closed=path=>spawnSync('guile',['--no-auto-compile','-c',scheme,guard,path],{encoding:'utf8'});
function put(path,content){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,content);}
function fixture(context){
  const root=mkdtempSync(join(tmpdir(),'controller-assembly-relocation-'));
  context.after(()=>rmSync(root,{recursive:true,force:true}));
  const workspace=join(root,'workspace'),snapshot=join(root,'snapshot'),output=join(root,'output');
  const names=[controllerName,parserName,'@red-cup-engineering/metroplat','@red-cup-engineering/feltos-enterprise-host'];
  const providers=Object.fromEntries(names.map(name=>[name,join(workspace,'packages',name.replaceAll('/','__'))]));
  const packages=names.map(name=>({name,version:'0.0.0-fixture',repository:'fixture/source',commit:'a'.repeat(40)}));
  for(const name of names)put(join(providers[name],'package.json'),JSON.stringify({name,version:'0.0.0-fixture',type:'module',
    ...(name===parserName?{exports:{'./javascript-parser':'./parser.mjs'}}:{}),
    ...(name===controllerName?{dependencies:{[parserName]:'workspace:*'}}:{})}));
  put(join(providers[parserName],'parser.mjs'),'export const parseJavaScript = source => ({source,fixture:true});\n');
  put(join(providers[controllerName],'src/receiver.mjs'),`import {parseJavaScript} from '${parserName}/javascript-parser';\nexport const reading=parseJavaScript('relocated');\n`);
  put(join(providers[controllerName],'test/fixtures/node_modules/authored.txt'),'nested source fixture\n');
  put(join(providers[controllerName],'node_modules-not-installation/authored.txt'),'other source directory\n');
  const alias=join(providers[controllerName],'node_modules',parserName);
  mkdirSync(dirname(alias),{recursive:true});symlinkSync(relative(dirname(alias),providers[parserName]),alias);
  put(join(providers['@red-cup-engineering/metroplat'],'scripts/generate-operation-family-descriptors.mjs'),'// Inert generator fixture: no operations or external state.\n');
  // JSON is a YAML subset. This fixture port isolates the actual assembler's
  // link behavior; it does not qualify registry parsing or machine installation.
  put(join(workspace,'node_modules/yaml/package.json'),JSON.stringify({name:'yaml',version:'0.0.0-fixture',main:'index.cjs'}));
  put(join(workspace,'node_modules/yaml/index.cjs'),'exports.parse = JSON.parse;\n');
  const lock=JSON.stringify({lockfileVersion:'9.0',packages:{},importers:{}})+'\n';
  put(join(workspace,'package.json'),'{}\n');
  put(join(workspace,'pnpm-lock.yaml'),lock);put(join(workspace,'node_modules/.pnpm/lock.yaml'),lock);
  put(join(workspace,'sources.json'),JSON.stringify({packages})+'\n');
  put(join(workspace,'source-imports.json'),JSON.stringify({fixture:true,declarationFindings:[]})+'\n');
  for(const directory of ['deployment','deployments'])mkdirSync(join(snapshot,directory),{recursive:true});
  for(const file of ['machine.json','machine.scm','channels.scm','sources.json','dependencies.lock.yaml'])put(join(snapshot,file),file==='dependencies.lock.yaml'?lock:'{}\n');
  return {root,workspace,snapshot,output,providers,lock};
}
function assembled(f){
  const result=spawnSync(process.execPath,[assemble,f.workspace,f.snapshot,f.output],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1)).closure;
}

test('the copied controller uses the closed root dependency namespace after relocation',context=>{
  const f=fixture(context),closure=assembled(f),source=f.providers[controllerName];
  const checked=closed(closure);assert.equal(checked.status,0,checked.stderr);
  assert.equal(existsSync(join(closure,'.controller/node_modules')),false);
  for(const path of ['package.json','src/receiver.mjs','test/fixtures/node_modules/authored.txt','node_modules-not-installation/authored.txt'])
    assert.deepEqual(readFileSync(join(closure,'.controller',path)),readFileSync(join(source,path)),path);
  assert.equal(readFileSync(join(closure,'.metadata/dependencies.lock.yaml'),'utf8'),f.lock);
  assert.equal(readFileSync(join(f.workspace,'pnpm-lock.yaml'),'utf8'),f.lock);
  const relocated=join(f.root,'relocated');renameSync(closure,relocated);rmSync(f.workspace,{recursive:true});
  const after=closed(relocated);assert.equal(after.status,0,after.stderr);
  const probe=spawnSync(process.execPath,['--input-type=module','-e',`import {reading} from './.controller/src/receiver.mjs'; if(reading.source!=='relocated'||!reading.fixture)throw new Error('wrong parser');`],{cwd:relocated,encoding:'utf8'});
  assert.equal(probe.status,0,probe.stderr);
  assert.equal(realpathSync(join(relocated,'node_modules',parserName)),join(relocated,'packages',parserName.replaceAll('/','__')));
});

test('preserving an old package-local relative link is not relocation',context=>{
  const f=fixture(context),closure=assembled(f),naive=join(closure,'.naive-controller');
  cpSync(f.providers[controllerName],naive,{recursive:true,verbatimSymlinks:true});
  const checked=closed(closure);assert.notEqual(checked.status,0,'old relative depth must not pass the real closure guard');
});

test('assembly still refuses a changed installed lock before sealing',context=>{
  const f=fixture(context);put(join(f.workspace,'node_modules/.pnpm/lock.yaml'),JSON.stringify({lockfileVersion:'9.0',changed:true}));
  const result=spawnSync(process.execPath,[assemble,f.workspace,f.snapshot,f.output],{encoding:'utf8',timeout:30000});
  assert.notEqual(result.status,0);assert.match(result.stderr,/Installed dependency graph differs from the reviewed lock/);
});

test('systemd storage receiving is composed into the immutable generation, not private state',context=>{
  const f=fixture(context);
  put(join(f.snapshot,'machine.json'),JSON.stringify({name:'cold-red-gate',supervisor:'systemd-user'}));
  const closure=assembled(f);
  assert.match(readFileSync(join(closure,'.storage-systemd/cold-red-gate-storage.timer'),'utf8'),/OnUnitInactiveSec=15min/);
  assert.match(readFileSync(join(closure,'.storage-systemd/cold-red-gate-storage.service'),'utf8'),/\/RELEASE\/\.controller\/machine.json/);
  assert.equal(closed(closure).status,0);
});

test('Shepherd retains its own supervisor contract without unsupported timers',context=>{
  const f=fixture(context);
  put(join(f.snapshot,'machine.json'),JSON.stringify({name:'container',supervisor:'shepherd'}));
  assert.equal(existsSync(join(assembled(f),'.storage-systemd')),false);
});
