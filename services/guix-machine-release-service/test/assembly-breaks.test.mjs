import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {BREAK_CLASSES,classifyBreak,classOfImportDiagnostic} from '../scripts/assembly-breaks.mjs';

test('each failure the controller raises at assembly is named by its section 8 class', ()=>{
  const cases=[
    ['ambiguous source owner for required package @a/x: a/one:x, a/two:x; pin its owning repository','divergent-copy'],
    ['Selected runtime imports have no exported interface: @a/f:src/m.mjs -> @a/x/missing (a/x@1)','unexported-interface'],
    ['Selected runtime imports lack declarations: @a/f:src/m.mjs -> @a/y','undeclared-import'],
    ['entry or workspace dependency has no home among the machine\'s sources: @a/gone','unpinned-workspace-dependency'],
    ['workspace dependency has no home among the machine\'s sources: @a/f -> @a/gone','unpinned-workspace-dependency'],
    ['unresolved workspace provider: @a/f -> @a/gone','unpinned-workspace-dependency'],
    ['git diff failed (128): fatal: remote error: upload-pack: not our ref 513474bf1f34177533e9a3bceaa3233023a1802c','repository-formation-unavailable'],
  ];
  for(const [message,expected] of cases){const found=classifyBreak(message);assert.equal(found.class,expected,message);assert.equal(found.kind,'561-group.assembly-break');}
  assert.deepEqual([...new Set(cases.map(c=>c[1]))].sort(),BREAK_CLASSES.filter(c=>!['stale-consumer-after-rename','export-target-missing','export-into-retired-tree'].includes(c)).sort());
  assert.equal(classifyBreak('source commit differs: a/x'),null);
});

test('a repository that cannot be formed at its commit is its own break, ahead of what it would have caused', ()=>{
  for(const message of [
    'Ref gone, pin held: a/x@release/github-guix 0123456789abcdef0123456789abcdef01234567',
    'git clone failed (128): fatal: repository \'https://github.com/a/gone.git/\' not found',
    'git fetch failed (128): fatal: could not read from remote repository.',
    "git fetch failed (128): fatal: couldn't find remote ref release/github-guix",
    'fatal: unable to access \'https://github.com/a/x.git/\': Could not resolve host: github.com',
    'git diff failed (128): fatal: remote error: upload-pack: not our ref 0123; entry or workspace dependency has no home among the machine\'s sources: @a/gone',
  ])assert.equal(classifyBreak(message).class,'repository-formation-unavailable',message);
  assert.equal(classifyBreak('Ref gone, pin held: a/x@release/github-guix 0123').repository,'a/x');
});

test('a missing provider that a pinned package carried before the change is a stale consumer of a rename', ()=>{
  const found=classifyBreak('entry or workspace dependency has no home among the machine\'s sources: @a/old-name',{formerNames:new Set(['@a/old-name'])});
  assert.equal(found.class,'stale-consumer-after-rename');assert.equal(found.package,'@a/old-name');
});

test('prepare-sources records the break beside the workspace it could not prepare', t=>{
  const root=mkdtempSync(join(tmpdir(),'assembly-break-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const repo=join(root,'repo');mkdirSync(repo);
  const git=(...a)=>spawnSync('git',a,{cwd:repo,encoding:'utf8'});
  git('init','-q');writeFileSync(join(repo,'package.json'),JSON.stringify({name:'@a/app',version:'1.0.0',dependencies:{'@a/old-name':'workspace:*'}}));
  git('add','.');git('-c','user.name=f','-c','user.email=f@example.invalid','commit','-qm','f');
  const commit=git('rev-parse','HEAD').stdout.trim(),output=join(root,'out');
  writeFileSync(join(root,'spec.json'),JSON.stringify({repositories:[{directory:repo,repository:'a/repo',commit}],entries:['@a/app'],formerNames:['@a/old-name'],output}));
  const r=spawnSync(process.execPath,[resolve('scripts/prepare-sources.mjs'),join(root,'spec.json')],{encoding:'utf8'});
  assert.notEqual(r.status,0);assert.match(r.stderr,/assembly-break: stale-consumer-after-rename/);
  assert.equal(JSON.parse(readFileSync(join(output,'assembly-break.json'),'utf8')).class,'stale-consumer-after-rename');
});

test('the import reader names a missing export target and an export into a retired tree by their break classes',()=>{
  assert.equal(classOfImportDiagnostic({reason:'runtime-target-not-in-committed-source',file:'src/gone.mjs'}),'export-target-missing');
  assert.equal(classOfImportDiagnostic({reason:'runtime-target-not-materialized',file:'lib/legacy/old.mjs'}),'export-into-retired-tree');
  assert.equal(classOfImportDiagnostic({reason:'runtime-target-not-materialized',file:'test/fixtures/x.mjs'}),'export-into-retired-tree');
  assert.equal(classOfImportDiagnostic({reason:'runtime-target-not-materialized',file:'node_modules/x/index.mjs'}),null);
  assert.equal(classOfImportDiagnostic({reason:'runtime-export-not-selected'}),null);
  for(const name of ['export-target-missing','export-into-retired-tree'])assert.ok(BREAK_CLASSES.includes(name),name);
});

// One vocabulary: every class the package-interface checker can emit is a break class here. The checker lives in
// node-js-packages-engineering-services-section; it is read where the composed workspace carries it, and skipped otherwise.
test('every class check-package-interfaces can emit is a break class',async t=>{
  let checker;
  try{checker=await import('@red-cup-engineering/jsnode-package-services-section/workspace/package-interfaces');}
  catch(error){
    if(!['ERR_MODULE_NOT_FOUND','ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error?.code))throw error;
    t.diagnostic('node-js-packages-engineering-services-section is not composed here ('+error.code+'); the shared vocabulary is checked where it is');
    t.skip('package-interface checker not composed');return;
  }
  assert.ok(Array.isArray(checker.PACKAGE_INTERFACE_CLASSES),'the checker exports the classes it can emit');
  for(const name of checker.PACKAGE_INTERFACE_CLASSES)assert.ok(BREAK_CLASSES.includes(name),name);
});
