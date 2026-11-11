import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const guix=spawnSync('guix',['--version'],{encoding:'utf8'});
const available=!guix.error&&guix.status===0;
const software={storePath:'/gnu/store/fixture-unrealized-software',root:'/fixture-held-root',narSha256:'a'.repeat(64)};
for(const [name,binding,supplied=software] of [
  ['another store output',{...software,storePath:'/gnu/store/another-software'}],
  ['another held root',{...software,root:'/another-held-root'}],
  ['another NAR digest',{...software,narSha256:'b'.repeat(64)}],
  ['a missing software binding',undefined],
  ['a malformed software binding','not-an-object'],
  ['a missing receipt field',{storePath:software.storePath,root:software.root}],
  ...Object.keys(software).map(key=>{const missing={...software};delete missing[key];return ['both receipts missing '+key,missing,missing];}),
  ['both receipts with a malformed NAR digest',{...software,narSha256:'invalid'},{...software,narSha256:'invalid'}],
  ['both receipts with an empty held root',{...software,root:''},{...software,root:''}],
  ['both receipts with a non-string digest',{...software,narSha256:0},{...software,narSha256:0}],
])test('target build refuses '+name+' before invoking Guix build or hash',{skip:!available},t=>{
  const base=mkdtempSync(join(tmpdir(),'guix-target-receipt-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
  const envelope=join(base,'envelope');mkdirSync(join(envelope,'.metadata'),{recursive:true});
  writeFileSync(join(envelope,'.metadata/release.json'),JSON.stringify({software:binding}));
  const receipt=join(base,'software.json');writeFileSync(receipt,JSON.stringify(supplied));
  const result=spawnSync('guix',['repl','--',fileURLToPath(new URL('../scripts/guix-deployment.scm',import.meta.url)),
    'build-target',envelope,receipt,join(base,'target-root')],{encoding:'utf8'});
  assert.ifError(result.error);assert.notEqual(result.status,0);assert.doesNotMatch(result.stderr,/Guix deployment:/);
  // The sentinel store/root do not exist. A receipt mismatch must be refused
  // before canonicalization, any NAR reading, or an attempted build.
  assert.match(result.stderr,/target envelope differs|Wrong type argument|wrong type argument/);
});
