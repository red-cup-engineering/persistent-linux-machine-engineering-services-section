import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {observedJson,releaseOutcome,retainOutcome} from '../scripts/release-outcome.mjs';

const run={repository:'test/machine',id:'123',attempt:'2'};
const invocation={repository:run.repository,revision:'a'.repeat(40),run:'https://github.com/test/machine/actions/runs/123',runAttempt:'2',mode:'build'};
const candidate={storePath:'/gnu/store/example-release',root:'/retained/root',narSha256:'b'.repeat(64),...invocation};
const receipt={outcome:'staged',storePath:candidate.storePath,machine:'machine',revision:invocation.revision,repository:run.repository,run:invocation.run,runAttempt:'2',stage:'pre-switch-check',retained:'/gnu/store/older',at:'2026-10-10T00:00:00Z'};
const args=()=>({run:{...run},machine:'machine',jobOutcome:'success',invocationText:JSON.stringify(invocation),candidateText:JSON.stringify(candidate),receiptText:JSON.stringify(receipt)});
const withReceipt=change=>releaseOutcome({...args(),receiptText:JSON.stringify({...receipt,...change})});

test('staging remains staging and preserves exact bytes and Guix digest without claiming verification',()=>{
  const input=args(),result=releaseOutcome(input);
  assert.equal(result.invocation.attributed,true);assert.equal(result.candidate.attributed,true);assert.equal(result.receipt.attributed,true);
  assert.equal(result.receipt.value.outcome,'staged');assert.equal(result.candidate.value.narSha256,candidate.narSha256);
  assert.equal(Buffer.from(result.receipt.bytesBase64,'base64').toString(),input.receiptText);
  assert.equal(result.receipt.sha256,createHash('sha256').update(input.receiptText).digest('hex'));
  assert.equal('healthy' in result,false);
});

test('promotion is a separate exact deploy receipt, independent of job completion status',()=>{
  const input=args();input.invocationText=JSON.stringify({...invocation,mode:'deploy'});input.candidateText=JSON.stringify({...candidate,mode:'deploy'});
  input.receiptText=JSON.stringify({...receipt,outcome:'success',stage:'live-check'});input.jobOutcome='failure';
  const result=releaseOutcome(input);assert.equal(result.receipt.attributed,true);assert.equal(result.receipt.value.outcome,'success');assert.equal(result.jobOutcome,'failure');
});

for(const [field,value] of [['repository','other/machine'],['revision','c'.repeat(40)],['run','https://github.com/test/machine/actions/runs/124'],['runAttempt','1'],['machine','other'],['storePath','/gnu/store/other']])
  test(`unrelated latest receipt cannot match changed ${field}`,()=>{const result=withReceipt({[field]:value});assert.equal(result.receipt.attributed,false);assert.equal(result.receipt.value[field],value);assert.equal(result.receipt.state,'read');});

for(const value of [undefined,null,false,'',0,'0','-1','1.5','02',2])
  test(`missing or noncanonical receipt attempt ${String(value)} stays unattributed`,()=>{
    const result=withReceipt({runAttempt:value});assert.equal(result.receipt.attributed,false);assert.equal(result.receipt.reason,'receipt-attempt-unattributed');
  });

test('receipt without candidate cannot establish candidate receiving',()=>{
  const result=releaseOutcome({...args(),candidateText:null});assert.equal(result.receipt.attributed,false);assert.equal(result.receipt.reason,'candidate-unattributed');assert.equal(result.receipt.value.outcome,'staged');
});

test('legacy candidate and legacy receipt remain historical readable observations',()=>{
  const input=args();const {repository,revision,run,runAttempt,mode,...legacy}=candidate;input.candidateText=JSON.stringify(legacy);
  const result=releaseOutcome(input);assert.equal(result.candidate.attributed,false);assert.equal(result.receipt.attributed,false);assert.equal(result.candidate.value.storePath,candidate.storePath);
});

test('invocation absent or belonging to another attempt cannot lend identity',()=>{
  for(const invocationText of [null,'{',JSON.stringify({...invocation,runAttempt:'1'})]){
    const result=releaseOutcome({...args(),invocationText});assert.equal(result.invocation.attributed,false);assert.equal(result.candidate.attributed,false);assert.equal(result.receipt.attributed,false);
  }
});

test('mode and receipt stage cannot turn preview success into promotion',()=>{
  for(const change of [{outcome:'success',stage:'live-check'},{stage:'live-check'},{outcome:'healthy'}])assert.equal(withReceipt(change).receipt.attributed,false);
});

test('failed receiving preserves original failure and incomplete recovery separately',()=>{
  const recovery={status:'incomplete',failedSteps:['probe-stop'],liveCheck:'not-attempted',expectedArtifact:'/gnu/store/older'};
  for(const outcome of ['failure','recovery-failure']){
    const result=withReceipt({outcome,stage:outcome==='failure'?'pre-switch-check':'probe-stop',...(outcome==='recovery-failure'?{originalStage:'pre-switch-check'}:{}),recovery});
    assert.equal(result.receipt.attributed,true);assert.equal(result.receipt.value.outcome,outcome);assert.deepEqual(result.receipt.value.recovery,recovery);
  }
});

test('unknown failure or recovery stages and impossible preview stages remain unattributed',()=>{
  for(const change of [{outcome:'failure',stage:'unknown'}, {outcome:'failure',stage:'switch'},
    {outcome:'recovery-failure',stage:'switch',originalStage:'pre-switch-check'},
    {outcome:'recovery-failure',stage:'probe-stop',originalStage:'unknown'}])assert.equal(withReceipt(change).receipt.attributed,false);
});

test('actual native custody and activation failures retain exact attribution without widening preview',()=>{
  const project=(mode,change)=>releaseOutcome({...args(),
    invocationText:JSON.stringify({...invocation,mode}),candidateText:JSON.stringify({...candidate,mode}),
    receiptText:JSON.stringify({...receipt,...change})});
  for(const stage of ['pre-activation','custody-prepare','custody-bind','custody-receive']){
    assert.equal(project('deploy',{outcome:'failure',stage}).receipt.attributed,true,stage);
    for(const mode of ['build','check-failure'])assert.equal(project(mode,{outcome:'failure',stage}).receipt.reason,'receipt-mode-mismatch');
  }
  for(const stage of ['restore-main-stop','restore-custody-stop','restore-custody','restore-first-install-stop','restore-main-activation','restore-first-install-reload']){
    const change={outcome:'recovery-failure',stage,originalStage:'custody-bind'};
    assert.equal(project('deploy',change).receipt.attributed,true,stage);
    assert.equal(project('build',change).receipt.reason,'receipt-mode-mismatch');
  }
  assert.equal(project('deploy',{outcome:'failure',stage:'custody-arbitrary'}).receipt.reason,'receipt-stage-unrecognized');
  assert.equal(project('deploy',{outcome:'recovery-failure',stage:'restore-arbitrary',originalStage:'custody-bind'}).receipt.reason,'receipt-stage-unrecognized');
});

function retainedRollbackEvidence(){
  const context={...invocation,mode:'rollback'};
  const restored={repository:run.repository,revision:'c'.repeat(40),storePath:'/gnu/store/retained-release',narSha256:'d'.repeat(64)};
  const selected={kind:'guix.rollback-target.v1',...context,storePath:restored.storePath,narSha256:restored.narSha256,selectedRelease:restored};
  const received={...receipt,revision:restored.revision,storePath:restored.storePath,outcome:'success',stage:'live-check'};
  const prepared={...candidate,...context};
  return {context,restored,selected,received,prepared,
    project:(selectedValue=selected,receivedValue=received)=>releaseOutcome({...args(),
      invocationText:JSON.stringify(context),candidateText:selectedValue===null?null:JSON.stringify(selectedValue),
      receiptText:JSON.stringify(receivedValue),preparedTargetText:JSON.stringify(prepared)})};
}

test('retained rollback binds original artifact revision separately from invoking policy source',()=>{
  const f=retainedRollbackEvidence(),result=f.project();
  assert.equal(result.invocation.attributed,true);assert.equal(result.candidate.attributed,true);assert.equal(result.receipt.attributed,true);
  assert.equal(result.invocation.value.revision,f.context.revision);
  assert.equal(result.candidate.value.selectedRelease.revision,f.restored.revision);
  assert.notEqual(result.invocation.value.revision,result.receipt.value.revision);
  assert.deepEqual(result.preparedTarget.value,f.prepared);
});

test('prepared native policy and mismatched retained selections cannot claim restored receiving',()=>{
  const f=retainedRollbackEvidence();
  assert.equal(f.project(f.prepared).candidate.attributed,false);
  assert.equal(f.project(null).candidate.attributed,false);
  assert.equal(f.project(null).receipt.attributed,false);
  for(const change of [{kind:'other'}, {revision:f.restored.revision}, {runAttempt:'1'},
    {selectedRelease:null}, {selectedRelease:{...f.restored,repository:'other/machine'}},
    {selectedRelease:{...f.restored,revision:'main'}}, {selectedRelease:{...f.restored,storePath:f.prepared.storePath}},
    {selectedRelease:{...f.restored,narSha256:'e'.repeat(64)}}]){
    const result=f.project({...f.selected,...change});
    assert.equal(result.candidate.attributed,false);assert.equal(result.receipt.attributed,false);
  }
  for(const change of [{revision:f.context.revision},{storePath:f.prepared.storePath},{runAttempt:'1'}])
    assert.equal(f.project(f.selected,{...f.received,...change}).receipt.attributed,false);
});

test('malformed, missing, scalar and non-UTF8 observations remain unknown with exact available bytes',()=>{
  for(const receiptText of [null,'{','null','true',Buffer.from([0xff,0x7b])]){
    const result=releaseOutcome({...args(),receiptText});assert.equal(result.receipt.attributed,false);
    if(receiptText!==null)assert.deepEqual(Buffer.from(result.receipt.bytesBase64,'base64'),Buffer.from(receiptText));
  }
});

test('byte digest distinguishes equivalent JSON serializations',()=>{
  const first=observedJson('{"a":1,"b":2}'),second=observedJson('{ "b": 2, "a": 1 }');
  assert.deepEqual(first.value,second.value);assert.notEqual(first.sha256,second.sha256);
});

test('PR39 assembly break evidence is preserved without reclassifying the source failure',()=>{
  const assemblyBreakText=JSON.stringify({kind:'561-group.assembly-break',class:'repository-formation-unavailable',message:'Ref gone, pin held: test/source@release abc'});
  const result=releaseOutcome({...args(),assemblyBreakText});assert.equal(result.assemblyBreak.value.class,'repository-formation-unavailable');
  assert.equal(Buffer.from(result.assemblyBreak.bytesBase64,'base64').toString(),assemblyBreakText);
});

test('identical projection and retention are deterministic; conflicts cannot replace original observation',()=>{
  const first=releaseOutcome(args()),second=releaseOutcome(args());assert.deepEqual(first,second);
  const retained=retainOutcome(null,first);assert.equal(retainOutcome(retained,second),retained);
  assert.throws(()=>retainOutcome(retained,withReceipt({runAttempt:'1'})),/conflicts/);
});

test('unknown run attempt is never defaulted to one',()=>{
  const input=args();delete input.run.attempt;const result=releaseOutcome(input);
  assert.equal(result.run.attempt,null);assert.equal(result.invocation.attributed,false);assert.equal(result.receipt.attributed,false);
});

test('absent or malformed caller context remains unknown rather than crashing',()=>{
  for(const value of [undefined,{}, {run:null},{run:false},{run:'123'}]){
    const result=releaseOutcome(value);assert.equal(result.invocation.attributed,false);assert.equal(result.receipt.attributed,false);
    assert.deepEqual(result.run,{repository:null,id:null,attempt:null});
  }
});

test('missing expected and observed machine identities cannot match each other',()=>{
  const input=args();delete input.machine;const value={...receipt};delete value.machine;input.receiptText=JSON.stringify(value);
  assert.equal(releaseOutcome(input).receipt.attributed,false);
});

test('bare store root lacks a candidate identity',()=>{
  const input=args();input.candidateText=JSON.stringify({...candidate,storePath:'/gnu/store/'});
  input.receiptText=JSON.stringify({...receipt,storePath:'/gnu/store/'});
  const result=releaseOutcome(input);assert.equal(result.candidate.attributed,false);assert.equal(result.receipt.attributed,false);
});
