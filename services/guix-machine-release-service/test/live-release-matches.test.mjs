import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script=resolve(fileURLToPath(new URL('../scripts/live-release-matches.mjs',import.meta.url)));
const machine='a'.repeat(40), source='b'.repeat(40), other='c'.repeat(40), repo='example-org/service';
function fixture(t, rows=[{repository:repo,commit:source}], releaseCommit=machine) {
  const root=mkdtempSync(join(tmpdir(),'live-release-receiving-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'.metadata'));
  writeFileSync(join(root,'.metadata/release.json'),JSON.stringify({machineCommit:releaseCommit}));
  writeFileSync(join(root,'.metadata/sources.json'),JSON.stringify({repositories:rows}));
  return root;
}
const call=(root,...args)=>spawnSync(process.execPath,[script,root,machine,repo,...args],{encoding:'utf8',env:{PATH:process.env.PATH},timeout:5000});

test('backward compatible repository-presence comparison',t=>{
  const root=fixture(t);
  assert.equal(call(root).status,0);
  assert.equal(call(root,'--report').stdout,'match\n');
});

test('exact source and machine identity are both required when requested',t=>{
  const root=fixture(t);
  assert.equal(call(root,'--source-commit',source).status,0);
  assert.equal(call(root,'--report','--source-commit',source).stdout,'match\n');
  assert.equal(call(root,'--source-commit',other,'--report').stdout,'mismatch\n');
  assert.equal(call(root,'--source-commit',other).status,1);
});

test('different live machine is mismatch even when source is exact',t=>{
  const root=fixture(t,[{repository:repo,commit:source}],other);
  assert.equal(call(root,'--source-commit',source,'--report').stdout,'mismatch\n');
});

test('missing source refuses as mismatch; no fabricated acceptance',t=>{
  const root=fixture(t,[{repository:'different-org/service',commit:source}]);
  assert.equal(call(root,'--source-commit',source).status,1);
  assert.equal(call(root,'--source-commit',source,'--report').stdout,'mismatch\n');
});

test('ambiguous duplicate source selection cannot qualify exact-source receiving',t=>{
  const root=fixture(t,[{repository:repo,commit:source},{repository:repo,commit:other}]);
  const r=call(root,'--source-commit',source,'--report');
  assert.notEqual(r.status,0);
  assert.equal(r.stdout,'');
  assert.match(r.stderr,/Ambiguous source identity/);
});

test('malformed live source commit cannot qualify despite a matching repository',t=>{
  const root=fixture(t,[{repository:repo,commit:'not-a-commit'}]);
  assert.equal(call(root).status,0);
  const r=call(root,'--source-commit',source,'--report');
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/Invalid selected source identity/);
});

test('refuses missing metadata in report mode',t=>{
  const root=fixture(t);
  rmSync(join(root,'.metadata/sources.json'));
  assert.equal(call(root).status,1);
  const r=call(root,'--source-commit',source,'--report');
  assert.notEqual(r.status,0);
  assert.equal(r.stdout,'');
});

test('rejects malformed and duplicate CLI arguments',t=>{
  const root=fixture(t);
  for(const args of [['--source-commit'],['--source-commit','bad'],['--other'],['--report','--report'],['--source-commit',source,'--source-commit',other]]) {
    assert.notEqual(call(root,...args).status,0,JSON.stringify(args));
  }
});

test('unrelated legacy rows do not defeat a valid exact selected source',t=>{
  const root=fixture(t,[{repository:repo,commit:source},{repository:'other-org/archive'}]);
  assert.equal(call(root,'--source-commit',source,'--report').stdout,'match\n');
});

test('unqualified extra source matches never substitute for the selected revision',t=>{
  const root=fixture(t,[{repository:repo,commit:other},{repository:'other-org/archive',commit:source}]);
  assert.equal(call(root,'--source-commit',source,'--report').stdout,'mismatch\n');
});
