import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {existsSync,mkdirSync,mkdtempSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {baseRequest,behindPin,changeVerdict,changedPackages,compareNativeDeclaredReceiving,packageManifests,runPackageTests,splitByClosure,testChange,untrustedEnvironment,verdictOf} from '../scripts/test-change.mjs';
import {UNSOURCED_DIRECTORIES} from '../scripts/prepare-sources.mjs';

test('a changed file belongs to its nearest enclosing package', () => {
  const manifests = new Map([['', '@x/root'], ['apps/host', '@x/host'], ['apps/host/lib/inner', '@x/inner'], ['services/knowing', '@x/knowing']]);
  const touched = changedPackages(manifests, ['apps/host/src/a.mjs', 'apps/host/lib/inner/b.mjs', 'services/knowing/test/c.test.mjs', 'README.md', 'apps/hostess/x.mjs']);
  assert.deepEqual([...touched.values()].sort(), ['@x/host', '@x/inner', '@x/knowing', '@x/root']);
});

test('original package runner distinguishes completed tests from unavailable processes',t=>{
  const root=mkdtempSync(join(tmpdir(),'test-measurement-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const pass=join(root,'pass.test.mjs'),fail=join(root,'fail.test.mjs');
  writeFileSync(pass,'');writeFileSync(fail,"throw new Error('measured failure');\n");
  const run=node=>runPackageTests({directory:root,files:[pass,fail],environment:{PATH:process.env.PATH},node});
  assert.deepEqual([...run(process.execPath)],[[pass,true],[fail,false]]);
  assert.throws(()=>run(join(root,'missing-node')),error=>{
    assert.equal(error.code,'ERR_TEST_MEASUREMENT_UNAVAILABLE');assert.equal(error.processErrorCode,'ENOENT');
    assert.equal(error.file,pass);assert.equal(error.status,null);assert.equal(error.signal,null);return true;
  });
  const interrupted=join(root,'interrupted');
  writeFileSync(interrupted,'#!/bin/sh\nkill -TERM $$\n',{mode:0o755});
  assert.throws(()=>run(interrupted),error=>{
    assert.equal(error.code,'ERR_TEST_MEASUREMENT_UNAVAILABLE');assert.equal(error.signal,'SIGTERM');
    assert.equal(error.status,null);return true;
  });
});

test('unread native sides stay unavailable instead of becoming empty passing inventories',async()=>{
  const result=await compareNativeDeclaredReceiving({baseline:{},candidate:{}});
  assert.equal(result.verdict,'incomplete');assert.equal(result.runtimeAcceptance,false);
  assert.deepEqual(result.receiving.unread.map(row=>row.side),['baseline','candidate']);
  assert.equal(result.receiving.baseline,undefined);assert.equal(result.receiving.candidate,undefined);
  assert.equal(result.receiving.regressions,undefined);assert.equal(result.receiving.removedTests,undefined);
});

test('a file that fails with the change and passes at the base, or has no base, is a regression; one that fails at both is the base\'s', () => {
  const head = new Map([['test/a.test.mjs', true], ['test/b.test.mjs', false], ['test/c.test.mjs', false], ['test/new.test.mjs', false]]);
  const base = new Map([['test/b.test.mjs', true], ['test/c.test.mjs', false]]);
  assert.deepEqual(verdictOf(head, base), {regressions: ['test/b.test.mjs', 'test/new.test.mjs'], preexisting: ['test/c.test.mjs']});
  assert.deepEqual(verdictOf(new Map([['test/a.test.mjs', true]]), new Map()), {regressions: [], preexisting: []});
});

test('the change test refuses without a snapshot, work directory and change before any effect', () => {
  const script = fileURLToPath(new URL('../scripts/test-change.mjs', import.meta.url));
  for (const args of [[], ['snapshot', 'work'], ['snapshot', 'work', 'not-a-repo=path']]) {
    const r = spawnSync(process.execPath, [script, ...args], {encoding: 'utf8', env: {PATH: ''}});
    assert.equal(r.status, 1);
    assert.match(r.stderr, /usage: test-change\.mjs SNAPSHOT WORK OWNER\/REPO=PATH/);
  }
});

test('PR-head code runs without the runner\'s GitHub tokens or gh configuration', t => {
  const root = mkdtempSync(join(tmpdir(), 'untrusted-env-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const config = join(root, 'workspace.gh-config');
  const environment = untrustedEnvironment({PATH: '/bin', GH_TOKEN: 'a', GITHUB_TOKEN: 'b', GH_ENTERPRISE_TOKEN: 'c', GITHUB_ENTERPRISE_TOKEN: 'd', GH_CONFIG_DIR: '/home/runner/.config/gh', NODE_OPTIONS: '--no-warnings'}, config);
  assert.deepEqual(environment, {PATH: '/bin', NODE_OPTIONS: '--no-warnings', GH_CONFIG_DIR: config});
  assert.ok(existsSync(config));assert.deepEqual(readdirSync(config), []);
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify([process.env.GH_TOKEN ?? null, process.env.GITHUB_TOKEN ?? null, process.env.GH_CONFIG_DIR]))'], {env: environment, encoding: 'utf8'});
  assert.deepEqual(JSON.parse(child.stdout), [null, null, config]);
});

test('a change touches only the packages prepare-sources would discover, never legacy or vendored copies', t => {
  const root = mkdtempSync(join(tmpdir(), 'manifests-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const git = (...args) => spawnSync('git', args, {cwd: root, encoding: 'utf8'});
  git('init', '-q');
  for (const [path, name] of [['package.json', '@x/root'], ['services/a/package.json', '@x/a'], ['lib/legacy/restored/old/package.json', '@x/old'],
    ['vendor/dep/package.json', '@x/dep'], ['services/a/test/fixture/package.json', '@x/fixture']]) {
    mkdirSync(join(root, path, '..'), {recursive: true});
    writeFileSync(join(root, path), JSON.stringify({name}));
  }
  git('add', '.');git('-c', 'user.name=f', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'f');
  assert.deepEqual([...packageManifests(root, git('rev-parse', 'HEAD').stdout.trim())].sort(), [['', '@x/root'], ['services/a', '@x/a']]);
});

function repository(t){
  const root=mkdtempSync(join(tmpdir(),'head-behind-pin-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const git=(...args)=>spawnSync('git',['-c','user.name=t','-c','user.email=t@t',...args],{cwd:root,encoding:'utf8'}).stdout.trim();
  const commit=(name)=>{writeFileSync(join(root,name),name);git('add',name);git('commit','-qm',name);return git('rev-parse','HEAD');};
  git('init','-q','-b','main');
  return {root,git,commit};
}

test('a change that does not descend from the pin lists the pinned commits it lacks; one that does is not behind', (t) => {
  const {root,git,commit}=repository(t);
  const fork=commit('a');
  const pin=commit('b'),later=commit('c');
  git('checkout','-q','-b','old',fork);
  const old=commit('d');
  assert.equal(behindPin(root,pin,later),null);
  assert.equal(behindPin(root,pin,pin),null);
  const lag=behindPin(root,pin,old);
  assert.equal(lag.count,1);
  assert.deepEqual(lag.missing,[{commit:pin,subject:'b'}]);
  assert.match(behindPin(root,'1'.repeat(40),old).reason,/not reachable/);
});

test('the change test compares no suites for a change behind its pin, and says to merge the pin', async (t) => {
  const {root,git,commit}=repository(t);
  const fork=commit('a'),pin=commit('b');
  git('checkout','-q','-b','old',fork);
  const old=commit('d');
  const snapshot=mkdtempSync(join(tmpdir(),'head-behind-pin-snapshot-'));
  t.after(()=>rmSync(snapshot,{recursive:true,force:true}));
  // The machine mounts the section at its pin by gitlink.
  writeFileSync(join(snapshot,'machine.json'),JSON.stringify({repository:'house/machine',run:{entries:['@house/app']}}));
  writeFileSync(join(snapshot,'.gitmodules'),'[submodule "sources/section"]\n\tpath = sources/section\n\turl = https://github.com/house/section.git\n');
  spawnSync('git',['init','-q'],{cwd:snapshot});
  writeFileSync(join(snapshot,'machine.scm'),'(fixture)\n');
  spawnSync('git',['remote','add','origin','https://github.com/house/machine.git'],{cwd:snapshot});
  spawnSync('git',['add','machine.json','machine.scm','.gitmodules'],{cwd:snapshot});
  mkdirSync(join(snapshot,'sources/section'),{recursive:true});spawnSync('git',['update-index','--add','--cacheinfo',`160000,${pin},sources/section`],{cwd:snapshot});
  spawnSync('git',['-c','user.name=t','-c','user.email=t@t','commit','-q','-m','snapshot'],{cwd:snapshot});
  const work=mkdtempSync(join(tmpdir(),'head-behind-pin-work-'));
  t.after(()=>rmSync(work,{recursive:true,force:true}));
  const result=await testChange({snapshot,work,changes:new Map([['house/section',root]])});
  assert.equal(result.verdict,'incomplete');
  assert.equal(result.break.class,'head-behind-pin');
  assert.deepEqual(result.break.repositories.map(r=>[r.repository,r.pin,r.commit,r.count]),[['house/section',pin,old,1]]);
  assert.deepEqual(result.packages,[]);
  assert.match(result.reason,/does not descend from the pinned .* merge the pinned commit into it/);
});

test('only a complete reading is no-regression: an unread deck or an uncomposed package makes it incomplete', () => {
  const clean=[{name:'@x/a',tests:2,passed:2,regressions:[],preexisting:[]}];
  assert.equal(changeVerdict(clean,{added:[],removed:[],misfold:'read'}).verdict,'no-regression');
  // DRC-6 alone unread is informational.
  assert.equal(changeVerdict(clean,{added:[],removed:[],misfold:'unread'}).verdict,'no-regression');
  assert.equal(changeVerdict(clean,{unread:'cannot read the deck'}).verdict,'incomplete');
  assert.equal(changeVerdict([...clean,{name:'@x/out',status:'outside-machine-closure-not-composed'}],{added:[]}).verdict,'incomplete');
  assert.deepEqual(changeVerdict(clean,{unread:'x',added:undefined}),{regressions:0,verdict:'incomplete'});
  assert.deepEqual(changeVerdict(clean,{added:[{key:'drc-3:@x/a:src/s.mjs:node:sqlite'}]}),{regressions:1,verdict:'regression'});
});

test('the change test discovers packages under the same unsourced directories prepare-sources skips', t => {
  const root = mkdtempSync(join(tmpdir(), 'unsourced-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const git = (...args) => spawnSync('git', args, {cwd: root, encoding: 'utf8'});
  git('init', '-q');
  for (const directory of UNSOURCED_DIRECTORIES) {
    mkdirSync(join(root, 'lib', directory, 'pkg'), {recursive: true});
    writeFileSync(join(root, 'lib', directory, 'pkg', 'package.json'), JSON.stringify({name: `@x/${directory}`}));
  }
  for(const path of ['content/text/evidence/stage','data/records/machine-deployment-service-records/previous']){
    mkdirSync(join(root,path),{recursive:true});
    writeFileSync(join(root,path,'package.json'),JSON.stringify({name:'@x/copied'}));
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({name: '@x/root'}));
  git('add', '.'); git('-c', 'user.name=f', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'f');
  assert.deepEqual([...packageManifests(root, git('rev-parse', 'HEAD').stdout.trim())], [['', '@x/root']]);
});

test('a changed package outside the machine\'s closure is installed on neither side; the base asks only for those inside it', () => {
  // The requirement team's run: ops and web changed, and with them packages the machine never builds, one of which
  // depends on a package the registry does not serve. Asked of the base, it failed the whole base composition.
  const inside=new Set(['@red-cup-engineering/metroplat','@coesite-operations/operations-services-section','@x/new-inside']);
  const changed=[
    {repository:'coesite-operations/operations-services-section',root:'',name:'@coesite-operations/operations-services-section'},
    {repository:'coesite-operations/operations-services-section',root:'services/contract-pursuit',name:'@coesite-operations/contract-pursuit-services-section'},
    {repository:'red-cup-engineering/web-engineering-services-section',root:'apps/shadow',name:'@rsc-quiescent/institutional-investment-shadow-deployment'},
    {repository:'red-cup-engineering/web-engineering-services-section',root:'apps/new',name:'@x/new-inside'},
  ];
  const atPins=new Map([
    ['@coesite-operations/operations-services-section',''],
    ['@coesite-operations/contract-pursuit-services-section','services/contract-pursuit'],
    ['@rsc-quiescent/institutional-investment-shadow-deployment','apps/shadow'],
  ]);
  const {within,outside}=splitByClosure(changed,inside);
  assert.deepEqual(within.map(c=>c.name),['@coesite-operations/operations-services-section','@x/new-inside']);
  assert.deepEqual(outside.map(c=>c.name),['@coesite-operations/contract-pursuit-services-section','@rsc-quiescent/institutional-investment-shadow-deployment']);
  // The base carries both outside packages at their pins, and is asked for neither; a package the change adds has no base.
  assert.deepEqual(baseRequest(within,atPins).map(c=>c.name),['@coesite-operations/operations-services-section']);
  // A package that moved within its repository is not the one the pin carries.
  assert.deepEqual(baseRequest([{...within[0],root:'moved'}],atPins),[]);
  // With no readable closure, every changed package is composed as before.
  assert.deepEqual(splitByClosure(changed,null),{within:changed,outside:[]});
});
