import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {controllerTestEnvironment,controllerSourceAssays,qualifyControllerSources} from '../scripts/qualify-controller-sources.mjs';
const tools={guile:'/gnu/store/'+ 'a'.repeat(32)+'-guile-3.0.11',json:'/gnu/store/'+ 'b'.repeat(32)+'-guile-json-4.7.3'};
const nodeExecutable='/gnu/store/'+ 'c'.repeat(32)+'-node-24.18.0/bin/node';
const input={tools,nodeExecutable,home:'/inert/home',tmp:'/inert/tmp'};

test('fixed source assay uses only exact pinned interpreter paths and no ambient environment',()=>{
  const env=controllerTestEnvironment(input);
  assert.equal(env.PATH,join(nodeExecutable,'..')+':'+join(tools.guile,'bin')+':/usr/bin:/bin');
  assert.equal(env.GUILE_LOAD_PATH,join(tools.json,'share/guile/site/3.0'));
  assert.equal(env.GUILE_AUTO_COMPILE,'0');
  for(const key of ['NODE_OPTIONS','NODE_PATH','GUILE_LOAD_COMPILED_PATH','GH_TOKEN','GITHUB_TOKEN','GITHUB_EVENT_PATH'])assert.equal(key in env,false);
  assert.equal(env.GIT_CONFIG_GLOBAL,'/dev/null');assert.equal(env.GIT_CONFIG_NOSYSTEM,'1');
});
for(const [name,amend] of [
  ['ambient Guile',x=>({...x,tools:{...tools,guile:'/usr/bin'}})],
  ['wrong Guile derivation version',x=>({...x,tools:{...tools,guile:tools.guile.replace('3.0.11','3.0.9')}})],
  ['wrong JSON version',x=>({...x,tools:{...tools,json:tools.json.replace('4.7.3','3.5.0')}})],
  ['additional provider field',x=>({...x,tools:{...tools,command:'anything'}})],
  ['wrong Node version',x=>({...x,nodeExecutable:nodeExecutable.replace('24.18.0','24.19.0')})],
  ['profile Node alias',x=>({...x,nodeExecutable:'/profile/bin/node'})],
])test('fixed source assay refuses '+name,()=>assert.throws(()=>controllerTestEnvironment(amend(input)),/exact installed/));

test('assay enrollment is fixed and retains the original controller suite',()=>{
  assert.ok(Object.isFrozen(controllerSourceAssays));
  assert.ok(controllerSourceAssays.includes('test/test-controller.test.mjs'));
  assert.ok(controllerSourceAssays.includes('test/frozen-workspace-reading.test.mjs'));
  assert.equal(new Set(controllerSourceAssays).size,controllerSourceAssays.length);
  for(const file of controllerSourceAssays)assert.match(file,/^test\/[a-z-]+\.test\.mjs$/u);
});

test('installed query refusal precedes every source test and invokes only the pinned fixed script',t=>{
  const configs=mkdtempSync(join(tmpdir(),'controller-source-qualification-'));t.after(()=>rmSync(configs,{recursive:true,force:true}));
  const stages=[],calls=[];
  assert.throws(()=>qualifyControllerSources({service:'/inert/service',snapshot:'/inert/snapshot',configs,path:'/selected/profile/bin',toolchain:{nodeExecutable},
    onStage:s=>stages.push(s),execute:()=>{throw Error('must not execute a test');},query:(program,args,cwd,env)=>{
      calls.push({program,args,cwd,env});throw Error('exact installed output is missing');
    }}),/exact installed output is missing/);
  assert.deepEqual(stages,['controller-test-prerequisites']);assert.equal(calls.length,1);
  assert.equal(calls[0].program,'guix');assert.deepEqual(calls[0].args,['repl','--','/inert/service/scripts/pinned-guix.scm','/inert/snapshot/channels.scm','--require-installed','repl','--','/inert/service/scripts/installed-controller-test-tools.scm']);
  assert.equal(calls[0].env.PATH,'/selected/profile/bin');assert.equal(calls[0].cwd,'/inert/snapshot');
});

test('Scheme resolver derives exact Guix self-build providers ungrafted and cannot acquire them',()=>{
  const source=readFileSync(new URL('../scripts/installed-controller-test-tools.scm',import.meta.url),'utf8');
  assert.match(source,/guile-3\.0\.11 guile-json-4/u);assert.match(source,/parameterize \(\(%graft\? #f\)\)/u);
  assert.match(source,/package-derivation store package #:graft\? #f/u);assert.match(source,/valid-path\? store path/u);
  assert.doesNotMatch(source,/\((?:build-derivations|ensure-path|substitute|system\*|canonical-package|specification->package)\b/u);
});

test('candidate source execution follows full toolchain verification and precedes re-verification',()=>{
  const source=readFileSync(new URL('../scripts/qualify-candidate-toolchain.mjs',import.meta.url),'utf8');
  assert.ok(source.indexOf('toolchain=qualifyToolchain(')<source.indexOf('controllerSources=qualifyControllerSources('));
  assert.ok(source.indexOf('controllerSources=qualifyControllerSources(')<source.indexOf("stage='source-integrity'"));
  assert.match(source,/fixed-toolchain-and-controller-source/u);
  assert.match(source,/'controller-source-assays','toolchain-workspace-reading','source-integrity'/u);
});

test('selected native provider identity is recorded before any source assay can fail',()=>{
 const helper=readFileSync(new URL('../scripts/qualify-controller-sources.mjs',import.meta.url),'utf8');
 assert.ok(helper.indexOf('onReading(reading)')<helper.indexOf("onStage('controller-source-assays')"));
 assert.ok(helper.indexOf('realpathSync(node)')<helper.indexOf('onReading(reading)'));
 const candidate=readFileSync(new URL('../scripts/qualify-candidate-toolchain.mjs',import.meta.url),'utf8');
 assert.match(candidate,/onReading:value=>\{controllerSources=value;\}/u);
 assert.match(candidate,/\.\.\.\(controllerSources\?\{controllerSources\}:\{\}\)/u);
});

test('the real fixed package-test command disables npm network features through immutable CLI flags',()=>{
 const source=readFileSync(new URL('../scripts/test-controller.mjs',import.meta.url),'utf8');
 const command=source.slice(source.indexOf("['package-tests','npm'"),source.indexOf("['health-reading'"));
 for(const flag of ['--offline','--no-audit','--no-fund','--no-update-notifier','--ignore-scripts'])assert.ok(command.includes(JSON.stringify(flag).replaceAll('"',"'")),flag);
 assert.match(command,/--userconfig=\$\{userConfig\}/u);assert.match(command,/--globalconfig=\$\{globalConfig\}/u);
 assert.match(command,/'--script-shell=\/bin\/sh'/u);assert.match(command,/'test'/u);
 assert.doesNotMatch(command,/'install'|'exec'|'npx'|--if-present/u);
 assert.match(source,/if\(\/\^npm_config_\/i\.test\(key\)\)delete env\[key\]/u);
});

test('the actual Guix receiver isolates native and historical probe custody and identity', () => {
  const received=spawnSync('guile',['--no-auto-compile',new URL('./probe-custody.scm',import.meta.url).pathname],
    {encoding:'utf8',timeout:15_000,maxBuffer:64*1024,env:{...process.env,GUILE_AUTO_COMPILE:'0'}});
  assert.equal(received.status,0,received.stderr);
  assert.match(received.stdout,/Actual probe storage representation and private identity isolation passed/);
});
