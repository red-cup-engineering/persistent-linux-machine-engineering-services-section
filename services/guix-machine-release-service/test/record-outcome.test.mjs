import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {recordOutcome,saveOutcome} from '../scripts/record-outcome.mjs';

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'release-outcome-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const work=join(root,'work');mkdirSync(work);
  const invocation={repository:'test/machine',revision:'a'.repeat(40),run:'https://github.com/test/machine/actions/runs/123',runAttempt:'2',mode:'build'};
  const candidate={...invocation,storePath:'/gnu/store/example-release',narSha256:'b'.repeat(64)};
  const receipt={...invocation,machine:'machine',storePath:candidate.storePath,outcome:'staged',stage:'pre-switch-check'};
  const assembly={kind:'561-group.assembly-break',class:'repository-formation-unavailable'};
  writeFileSync(join(root,'machine.json'),JSON.stringify({name:'machine',receiptRoot:'/never-read-this-host-path',receiverHost:'never-connect.invalid'}));
  writeFileSync(join(work,'release-invocation.json'),JSON.stringify(invocation));writeFileSync(join(work,'candidate.json'),JSON.stringify(candidate));
  for(const name of ['sources','workspace','artifacts','registry-cache'])mkdirSync(join(work,name));
  writeFileSync(join(work,'workspace','assembly-break.json'),JSON.stringify(assembly));
  const env={GITHUB_REPOSITORY:'test/machine',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'2',JOB_OUTCOME:'success',GITHUB_OUTPUT:join(root,'outputs'),GITHUB_STEP_SUMMARY:join(root,'summary')};
  const logs=[],options={snapshot:root,readLatest:()=>({status:0,stdout:Buffer.from(JSON.stringify(receipt))}),writeLog:line=>logs.push(line)};
  return {root,work,env,options,logs,receipt,assembly};
}

test('recorder retains evidence before cleanup and replay reuses removed PR39 assembly bytes',t=>{
  const f=fixture(t),first=recordOutcome(f.work,f.env,f.options),file=join(f.work,'release-outcome.json'),bytes=readFileSync(file);
  assert.equal(first.receipt.attributed,true);assert.equal(existsSync(join(f.work,'workspace')),false);
  assert.deepEqual(first.assemblyBreak.value,f.assembly);assert.equal(JSON.parse(f.logs[0]).receipt.attributed,true);
  assert.match(readFileSync(f.env.GITHUB_OUTPUT,'utf8'),/release_outcome_path=/);
  assert.deepEqual(recordOutcome(f.work,f.env,f.options),first);assert.deepEqual(readFileSync(file),bytes);
});

test('report failure preserves original scratch and retained bytes for retry',t=>{
  const f=fixture(t);assert.throws(()=>recordOutcome(f.work,f.env,{...f.options,writeLog:()=>{throw new Error('log unavailable');}}),/log unavailable/);
  assert.equal(existsSync(join(f.work,'workspace','assembly-break.json')),true);
  const before=readFileSync(join(f.work,'release-outcome.json'));recordOutcome(f.work,f.env,f.options);
  assert.deepEqual(readFileSync(join(f.work,'release-outcome.json')),before);
});

test('conflicting later receipt does not overwrite retained evidence or remove new scratch',t=>{
  const f=fixture(t);recordOutcome(f.work,f.env,f.options);const file=join(f.work,'release-outcome.json'),before=readFileSync(file);
  mkdirSync(join(f.work,'workspace'));
  assert.throws(()=>recordOutcome(f.work,f.env,{...f.options,readLatest:()=>({status:0,stdout:Buffer.from(JSON.stringify({...f.receipt,runAttempt:'3'}))})}),/conflicts/);
  assert.deepEqual(readFileSync(file),before);assert.equal(existsSync(join(f.work,'workspace')),true);
});

test('unavailable host observation is unknown without copying transport diagnostics',t=>{
  const f=fixture(t);const result=recordOutcome(f.work,f.env,{...f.options,readLatest:()=>({status:255,stderr:Buffer.from('secret-like diagnostic')})});
  assert.equal(result.receipt.state,'unavailable');assert.equal(result.receipt.attributed,false);assert.equal(f.logs.join('').includes('secret-like'),false);
});

test('missing build work can retain an unattributed observation without inventing invocation',t=>{
  const f=fixture(t);rmSync(f.work,{recursive:true});const result=recordOutcome(f.work,f.env,f.options);
  assert.equal(result.invocation.attributed,false);assert.equal(result.receipt.attributed,false);assert.equal(existsSync(join(f.work,'release-outcome.json')),true);
});

test('symlink custody refuses without writing its destination',t=>{
  const f=fixture(t),alias=join(f.root,'alias');symlinkSync(f.work,alias);
  assert.throws(()=>saveOutcome(alias,{kind:'fixture'}),/custody/);assert.equal(existsSync(join(f.work,'release-outcome.json')),false);
});
