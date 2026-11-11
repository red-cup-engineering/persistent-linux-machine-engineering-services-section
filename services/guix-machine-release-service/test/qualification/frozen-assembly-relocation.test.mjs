import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,renameSync,rmSync,realpathSync,cpSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {providerFixture,put,controllerName,parserName} from '../fixtures/frozen-provider-fixture.mjs';

// Unchanged reader contract from the owner's assemble-relocation.test.mjs:
// read and evaluate the actual assert-closed definition, never call deployment.
const scheme=`(use-modules (ice-9 ftw) (ice-9 match) (srfi srfi-1))
(call-with-input-file (cadr (command-line))
 (lambda (port) (let loop ((form (read port)))
  (unless (eof-object? form)
   (match form (('define ('assert-closed . arguments) . body) (eval form (current-module))) (_ #f))
   (loop (read port))))))
(assert-closed (caddr (command-line)))`;

test('actual assembly closes and relocates genuine frozen pnpm links with the genuine YAML parser',async t=>{
  const guile=process.env.DRC3_GUILE;
  assert.ok(guile&&guile.startsWith('/'),'DRC3_GUILE must name the already-qualified absolute Guile executable; do not install one for this test');
  const fixture=await providerFixture(t),f=fixture.workspace();
  const acquired=await fixture.acquire(f);assert.equal(acquired.status,0,acquired.stderr);
  const lock=readFileSync(join(f.work,'pnpm-lock.yaml'),'utf8');
  const packages=Object.keys(f.providers).map(name=>({name,version:'0.0.0-fixture',repository:'fixture/source',commit:'a'.repeat(40)}));
  put(join(f.work,'sources.json'),{packages});put(join(f.work,'source-imports.json'),{fixture:true,declarationFindings:[]});
  const snapshot=join(f.caseRoot,'snapshot'),output=join(f.caseRoot,'output');
  for(const directory of ['deployment','deployments'])mkdirSync(join(snapshot,directory),{recursive:true});
  for(const file of ['machine.json','machine.scm','channels.scm','sources.json','dependencies.lock.yaml'])
    put(join(snapshot,file),file==='dependencies.lock.yaml'?lock:'{}\n');
  const assembled=await fixture.runNode([join(fixture.owner,'scripts/assemble.mjs'),f.work,snapshot,output],
    {...f.env,DRC3_FIXTURE_ROLE:'assembler'},f.caseRoot);
  assert.equal(assembled.status,0,assembled.stderr);
  const closure=JSON.parse(assembled.stdout.trim().split('\n').at(-1)).closure;
  const closed=path=>spawnSync(guile,['--no-auto-compile','-c',scheme,join(fixture.owner,'scripts/guix-deployment.scm'),path],
    {encoding:'utf8',timeout:15000,env:{PATH:'/usr/bin:/bin',HOME:f.env.HOME,TMPDIR:f.caseRoot,LANG:'C.UTF-8',LC_ALL:'C.UTF-8'}});
  const first=closed(closure);assert.equal(first.status,0,first.stderr);
  assert.equal(existsSync(join(closure,'.controller/node_modules')),false);
  assert.equal(readFileSync(join(closure,'.metadata/dependencies.lock.yaml'),'utf8'),lock);
  const naive=join(closure,'.naive-controller');cpSync(f.providers[controllerName],naive,{recursive:true,verbatimSymlinks:true});
  assert.notEqual(closed(closure).status,0,'the existing negative old-depth link control must fail');rmSync(naive,{recursive:true});
  const relocated=join(f.caseRoot,'relocated');renameSync(closure,relocated);rmSync(f.work,{recursive:true});
  const after=closed(relocated);assert.equal(after.status,0,after.stderr);
  const probe=await fixture.runNode(['--input-type=module','--eval',"import {reading} from './.controller/src/receiver.mjs'; if(reading.source!=='relocated'||!reading.fixture||reading.inert!=='synthetic-inert')throw new Error('wrong relocated graph');"],
    {...f.env,DRC3_FIXTURE_ROLE:'probe'},relocated);
  assert.equal(probe.status,0,probe.stderr);
  assert.equal(realpathSync(join(relocated,'node_modules',parserName)),join(relocated,'packages',parserName.replaceAll('/','__')));
  assert.deepEqual(fixture.unexpected,[]);
});
