import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,symlinkSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {verifyCandidateSource,verifyQualificationChannels,verifySnapshotSource} from '../scripts/qualify-candidate-toolchain.mjs';
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'candidate-source-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const env={PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'};
  const git=(...args)=>execFileSync('git',['-C',root,...args],{env,encoding:'utf8'}).trim();
  git('init','--quiet');
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'@red-cup-engineering/guix-machine-release-service'}));
  git('add','package.json');git('-c','user.name=Source Fixture','-c','user.email=source@example.invalid','commit','--quiet','-m','inert source fixture');
  return {root,env,git,commit:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}')};
}
test('candidate identity rejects symbolic refs before source or provider access',()=>{
  assert.throws(()=>verifyCandidateSource('/unused','main','HEAD',{}),/exact commit and tree/);
});
test('exact inert Git bytes are accepted as source evidence only',t=>{
  const f=fixture(t);assert.equal(verifyCandidateSource(f.root,f.commit,f.tree,f.env),f.root);
});
test('candidate mismatch refuses without provider execution',t=>{
  const f=fixture(t);assert.throws(()=>verifyCandidateSource(f.root,'0'.repeat(40),f.tree,f.env),/source identity or bytes refused/);
});
test('assume-unchanged cannot conceal modified candidate bytes',t=>{
  const f=fixture(t);f.git('update-index','--assume-unchanged','package.json');
  writeFileSync(join(f.root,'package.json'),'{}');
  assert.throws(()=>verifyCandidateSource(f.root,f.commit,f.tree,f.env),/source identity or bytes refused/);
});
test('untracked files refuse even with unchanged committed bytes',t=>{
  const f=fixture(t);writeFileSync(join(f.root,'untracked'),'inert');
  assert.throws(()=>verifyCandidateSource(f.root,f.commit,f.tree,f.env),/source identity or bytes refused/);
});
test('unreviewed channels refuse before Scheme evaluation',t=>{
  const f=fixture(t);writeFileSync(join(f.root,'channels.scm'),'inert unreviewed bytes');
  assert.throws(()=>verifyQualificationChannels(f.root),/channels differ/);
});
test('candidate scope has distinct evidence and shares the fixed assay',()=>{
  const candidate=readFileSync(new URL('../scripts/qualify-candidate-toolchain.mjs',import.meta.url),'utf8');
  const admitted=readFileSync(new URL('../scripts/test-controller.mjs',import.meta.url),'utf8');
  assert.match(candidate,/guix-candidate-toolchain-qualification\.v1/u);
  assert.match(candidate,/candidate-toolchain-qualification\.json/u);
  assert.match(candidate,/qualifyToolchain\(/u);assert.match(admitted,/qualifyToolchain\(/u);
  assert.match(admitted,/exact admitted main snapshot/u);
  // The admitted controller is the commit the machine mounts (its gitlink), checked before any test runs.
  assert.match(admitted,/controller identity differs from the commit the machine mounts/u);
  assert.doesNotMatch(candidate,/verify-release-admission|npm|prepare-sources|assemble\.mjs/u);
});

for(const driver of ['clean','process'])test(`direct candidate custody never invokes a configured ${driver} filter`,t=>{
  const f=fixture(t),effect=join(f.root,'.git','filter-executed'),program=join(f.root,'.git','filter.mjs');
  writeFileSync(join(f.root,'.gitattributes'),'guarded.txt filter=fixture\n');
  writeFileSync(join(f.root,'guarded.txt'),'before\n');
  f.git('add','.gitattributes','guarded.txt');
  f.git('-c','user.name=Source Fixture','-c','user.email=source@example.invalid','commit','--quiet','-m','genuine filter declaration');
  const commit=f.git('rev-parse','HEAD'),tree=f.git('rev-parse','HEAD^{tree}');
  writeFileSync(program,`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(effect)},'unexpected execution'); process.exit(77);\n`);
  f.git('config',`filter.fixture.${driver}`,`${JSON.stringify(process.execPath)} ${JSON.stringify(program)}`);
  assert.equal(verifyCandidateSource(f.root,commit,tree,f.env),f.root,'exact source is readable without invoking its filter');
  writeFileSync(join(f.root,'guarded.txt'),'after!\n');
  assert.throws(()=>verifyCandidateSource(f.root,commit,tree,f.env),/source identity or bytes refused/);
  assert.throws(()=>readFileSync(effect),{code:'ENOENT'},'neither acceptance nor refusal executes local configured code');
});


test('machine custody delegates only authored Gitlinks and admits empty retired directories, while stray carriers refuse',t=>{
  const f=fixture(t),child=fixture(t);
  f.git('update-index','--add','--cacheinfo',`160000,${child.commit},mounted`);
  f.git('-c','user.name=Source Fixture','-c','user.email=source@example.invalid','commit','--quiet','-m','authored inert mount');
  const commit=f.git('rev-parse','HEAD'),tree=f.git('rev-parse','HEAD^{tree}');
  mkdirSync(join(f.root,'mounted'));writeFileSync(join(f.root,'mounted','not-a-source-input.mjs'),'throw new Error("inert mount worktree must not execute");\n');
  mkdirSync(join(f.root,'retired','empty'),{recursive:true});
  assert.equal(verifySnapshotSource(f.root,commit,tree,f.env),f.root,'mount content belongs to separate graph receiving');
  assert.throws(()=>verifyCandidateSource(f.root,commit,tree,f.env),/source identity or bytes refused/,'controller source itself cannot hide behind a Gitlink');
  writeFileSync(join(f.root,'retired','stray.mjs'),'untracked bytes');
  assert.throws(()=>verifySnapshotSource(f.root,commit,tree,f.env),/source identity or bytes refused/);
  rmSync(join(f.root,'retired','stray.mjs'));symlinkSync(child.root,join(f.root,'retired','redirected'));
  assert.throws(()=>verifySnapshotSource(f.root,commit,tree,f.env),/source identity or bytes refused/);
});
