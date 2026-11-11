import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,existsSync,lstatSync,readdirSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {agencyDirectories,carryAgency,declaredAgencyRoot,AGENCY_MARKER} from '../scripts/agency-records.mjs';

const assemble=fileURLToPath(new URL('../scripts/assemble.mjs',import.meta.url));
function put(path,content){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,content);}
function scratch(context,prefix){const root=mkdtempSync(join(tmpdir(),prefix));context.after(()=>rmSync(root,{recursive:true,force:true}));return root;}

// A house tree as organizing reads it: two sections' lib/agency, a section's own skills, and the
// copies organizing passes over (legacy, vendor, a symbolic link).
function house(root){
  put(join(root,'lib/a-section/lib/agency/offices/chief.json'),'{"id":"chief"}\n');
  put(join(root,'lib/a-section/lib/agency/organs/a-sign-in.json'),'{"id":"a-sign-in"}\n');
  put(join(root,'lib/a-section/services/b-section/lib/agency/characters/b.json'),'{"id":"b"}\n');
  put(join(root,'lib/a-section/services/c-service/skills/work/SKILL.md'),'---\nname: work\n---\n');
  put(join(root,'lib/a-section/lib/legacy/old-section/lib/agency/offices/chief.json'),'{"id":"chief"}\n');
  put(join(root,'lib/a-section/vendor/runtime/d-section/lib/agency/offices/copy.json'),'{"id":"copy"}\n');
  put(join(root,'lib/a-section/src/index.mjs'),'export {};\n');
  put(join(root,'outside/lib/agency/offices/elsewhere.json'),'{"id":"elsewhere"}\n');
  symlinkSync(join(root,'outside'),join(root,'lib/a-section/linked-section'));
  symlinkSync(join(root,'outside/lib/agency/offices/elsewhere.json'),join(root,'lib/a-section/lib/agency/offices/linked.json'));
}
const files=(root)=>readdirSync(root,{recursive:true}).map(String).filter(f=>lstatSync(join(root,f)).isFile()).sort();

test('the carried agency is what organizing reads, at the same relative paths',context=>{
  const root=scratch(context,'agency-carry-');house(root);
  assert.deepEqual(agencyDirectories(join(root,'lib')),[
    'a-section/lib/agency','a-section/services/b-section/lib/agency','a-section/services/c-service/skills']);
  const into=join(root,'carried'),marker=carryAgency(join(root,'lib'),into,{root:'lib',machineCommit:'f'.repeat(40)});
  assert.deepEqual(files(into),[AGENCY_MARKER,'a-section/lib/agency/offices/chief.json','a-section/lib/agency/organs/a-sign-in.json',
    'a-section/services/b-section/lib/agency/characters/b.json','a-section/services/c-service/skills/work/SKILL.md'].sort());
  assert.deepEqual(marker,{root:'lib',machineCommit:'f'.repeat(40),directories:3,files:4});
  assert.deepEqual(JSON.parse(readFileSync(join(into,AGENCY_MARKER),'utf8')),marker);
});

test('a declared agency root stays inside the machine repository and must hold agency',context=>{
  const root=scratch(context,'agency-root-');house(root);
  assert.equal(declaredAgencyRoot({},root),null);
  assert.equal(declaredAgencyRoot({agency:{root:'lib'}},root),join(root,'lib'));
  assert.throws(()=>declaredAgencyRoot({agency:{root:'../elsewhere'}},root),/leaves the machine repository/);
  assert.throws(()=>declaredAgencyRoot({agency:{root:''}},root),/non-empty path/);
  assert.throws(()=>carryAgency(join(root,'lib/a-section/src'),join(root,'x')),/holds no agency/);
  assert.throws(()=>carryAgency(join(root,'missing'),join(root,'x')),/not a directory/);
});

// The assembler, run on a machine repository whose snapshot declares agency.root: the closure
// carries agency/, which the node reads in place as METROPLAT_AGENCY_ROOT={release}/agency.
function assembly(context,machine){
  const root=scratch(context,'agency-assembly-'),repository=join(root,'repository'),workspace=join(root,'workspace'),output=join(root,'output');
  const snapshot=join(repository,'records/machine');house(repository);
  const controller='@red-cup-engineering/guix-machine-release-service';
  const names=[controller,'@red-cup-engineering/metroplat','@red-cup-engineering/feltos-enterprise-host'];
  const providers=Object.fromEntries(names.map(name=>[name,join(workspace,'packages',name.replaceAll('/','__'))]));
  for(const name of names)put(join(providers[name],'package.json'),JSON.stringify({name,version:'0.0.0-fixture',type:'module'}));
  put(join(providers['@red-cup-engineering/metroplat'],'scripts/generate-operation-family-descriptors.mjs'),'// Inert generator fixture.\n');
  put(join(workspace,'node_modules/yaml/package.json'),JSON.stringify({name:'yaml',version:'0.0.0-fixture',main:'index.cjs'}));
  put(join(workspace,'node_modules/yaml/index.cjs'),'exports.parse = JSON.parse;\n');
  const lock=JSON.stringify({lockfileVersion:'9.0',packages:{},importers:{}})+'\n';
  put(join(workspace,'package.json'),'{}\n');put(join(workspace,'pnpm-lock.yaml'),lock);put(join(workspace,'node_modules/.pnpm/lock.yaml'),lock);
  put(join(workspace,'sources.json'),JSON.stringify({packages:names.map(name=>({name,version:'0.0.0-fixture',repository:'fixture/source',commit:'a'.repeat(40)}))})+'\n');
  put(join(workspace,'source-imports.json'),'{}\n');
  mkdirSync(join(snapshot,'deployment'),{recursive:true});
  for(const file of ['machine.scm','channels.scm','sources.json'])put(join(snapshot,file),'{}\n');
  put(join(snapshot,'dependencies.lock.yaml'),lock);put(join(snapshot,'machine.json'),JSON.stringify(machine)+'\n');
  const git=(...args)=>assert.equal(spawnSync('git',['-C',repository,...args],{encoding:'utf8'}).status,0);
  git('init','-q');
  const run=spawnSync(process.execPath,[assemble,workspace,snapshot,output],{encoding:'utf8',timeout:30000,env:{...process.env,GITHUB_SHA:'e'.repeat(40)}});
  return {root,run,closure:run.status===0?JSON.parse(run.stdout.trim().split('\n').at(-1)).closure:null};
}

test('a machine declaring agency.root carries its agency into the release',context=>{
  const {root,run,closure}=assembly(context,{name:'fixture',agency:{root:'lib'}});
  assert.equal(run.status,0,run.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(closure,'agency',AGENCY_MARKER),'utf8')),{root:'lib',machineCommit:'e'.repeat(40),directories:3,files:4});
  assert.equal(readFileSync(join(closure,'agency/a-section/lib/agency/organs/a-sign-in.json'),'utf8'),'{"id":"a-sign-in"}\n');
  assert.equal(existsSync(join(closure,'agency/a-section/lib/legacy')),false);
  assert.equal(readdirSync(join(closure,'agency'),{recursive:true}).map(String).some(f=>lstatSync(join(closure,'agency',f)).isSymbolicLink()),false);
  // The carried tree is self-contained: it reads the same after the closure moves, as it does once sealed in the store.
  const sealed=join(root,'sealed');renameSync(closure,sealed);
  assert.equal(readFileSync(join(sealed,'agency/a-section/services/b-section/lib/agency/characters/b.json'),'utf8'),'{"id":"b"}\n');
});

test('a machine without agency.root carries none, and a bad root stops assembly',context=>{
  const none=assembly(context,{name:'fixture'});
  assert.equal(none.run.status,0,none.run.stderr);assert.equal(existsSync(join(none.closure,'agency')),false);
  const escaping=assembly(context,{name:'fixture',agency:{root:'..'}});
  assert.notEqual(escaping.run.status,0);assert.match(escaping.run.stderr,/leaves the machine repository/);
});
