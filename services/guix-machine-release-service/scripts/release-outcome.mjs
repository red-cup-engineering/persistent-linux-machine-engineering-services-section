import {createHash} from 'node:crypto';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const attempt=value=>typeof value==='string'&&/^[1-9][0-9]*$/.test(value)?value:null;
const revision=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const repository=value=>typeof value==='string'&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
const outcomes=new Set(['staged','success','failure','recovery-failure']);
// These are the actual writer's primary and recovery stage names, not health
// assertions. An unfamiliar future stage remains readable but unattributed.
const primaryStages=new Set(['host-check','staging','auxiliary-check','pre-switch-check','pre-activation','switch','custody-prepare','custody-bind','custody-receive','credential-baseline','credential-unit-check','configuration-reload','live-check']);
const recoveryStages=new Set(['probe-stop','probe-environment-cleanup','restore-main-stop','restore-custody-stop','restore-custody','restore-auxiliary-stop','restore-managed-files','restore-generation-unavailable','restore-generation','restore-main-unit','restore-first-install-stop','restore-main-activation','restore-daemon-reload','restore-configuration-reload','restore-auxiliary-restart','restore-main-restart','restore-live-check','restore-first-install-reload']);
const previewStages=new Set(['host-check','staging','auxiliary-check','pre-switch-check']);

/** Exact observed bytes remain evidence even when they cannot be attributed.
 * This digest is not a NAR check, receipt signature or JSON canonicalization. */
export function observedJson(text){
  if(text===null||text===undefined)return {state:'unavailable'};
  if(typeof text!=='string'&&!Buffer.isBuffer(text))throw new TypeError('Observation must contain text bytes.');
  const bytes=Buffer.isBuffer(text)?text:Buffer.from(text,'utf8');
  const evidence={bytesBase64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
  const decoded=bytes.toString('utf8');
  if(!Buffer.from(decoded,'utf8').equals(bytes))return {...evidence,state:'invalid'};
  try{const value=JSON.parse(decoded);return {...evidence,state:object(value)?'read':'invalid',...(object(value)?{value}:{})};}
  catch{return {...evidence,state:'invalid'};}
}

function invocationMatches(value,run){
  return object(value)&&repository(run.repository)&&value.repository===run.repository
    &&typeof run.id==='string'&&/^[1-9][0-9]*$/.test(run.id)
    &&value.run===`https://github.com/${run.repository}/actions/runs/${run.id}`
    &&attempt(run.attempt)!==null&&attempt(value.runAttempt)===run.attempt
    &&revision(value.revision)&&['build','deploy','check-failure','rollback','resolve'].includes(value.mode);
}

/** Projection only: no clock, filesystem, host, network or release effects. */
export function releaseOutcome({run={},machine,jobOutcome,invocationText,candidateText,receiptText,assemblyBreakText,preparedTargetText}={}){
  if(!object(run))run={};
  const invocation=observedJson(invocationText),candidate=observedJson(candidateText),receipt=observedJson(receiptText),assemblyBreak=observedJson(assemblyBreakText);
  const context=invocation.value,hasInvocation=invocationMatches(context,run);
  const candidateValue=candidate.value,receiptValue=receipt.value;
  let candidateReason=hasInvocation?'candidate-unavailable':'invocation-unattributed';
  if(hasInvocation&&candidateValue){
    candidateReason=['repository','revision','run','runAttempt','mode'].every(key=>candidateValue[key]===context[key])
      &&typeof candidateValue.storePath==='string'&&candidateValue.storePath.startsWith('/gnu/store/')&&candidateValue.storePath.length>'/gnu/store/'.length
      &&typeof candidateValue.narSha256==='string'&&/^[a-f0-9]{64}$/.test(candidateValue.narSha256)
      ?null:'candidate-binding-mismatch';
    if(candidateReason===null&&context.mode==='rollback'){
      const selected=candidateValue.selectedRelease;
      if(candidateValue.kind!=='guix.rollback-target.v1'||!object(selected)||!repository(selected.repository)||selected.repository!==context.repository&&
          !(object(selected.repositoryIdentity)&&selected.repositoryIdentity.from===selected.repository&&selected.repositoryIdentity.to===context.repository&&Number.isSafeInteger(selected.repositoryIdentity.id)&&selected.repositoryIdentity.id>0&&typeof selected.repositoryIdentity.nodeId==='string'&&selected.repositoryIdentity.nodeId.length>0)
        ||!revision(selected.revision)||selected.storePath!==candidateValue.storePath||selected.narSha256!==candidateValue.narSha256)
        candidateReason='rollback-target-unattributed';
    }
  }
  let receiptReason=hasInvocation?'receipt-unavailable':'invocation-unattributed';
  if(hasInvocation&&receiptValue){
    if(attempt(receiptValue.runAttempt)===null)receiptReason='receipt-attempt-unattributed';
    else if(!['run','runAttempt'].every(key=>receiptValue[key]===context[key])
      ||receiptValue.repository!==(context.mode==='rollback'?candidateValue?.selectedRelease?.repository:context.repository)
      ||receiptValue.revision!==(context.mode==='rollback'?candidateValue?.selectedRelease?.revision:context.revision)
      ||typeof machine!=='string'||machine.length===0||receiptValue.machine!==machine)
      receiptReason='receipt-binding-mismatch';
    else if(!outcomes.has(receiptValue.outcome)||typeof receiptValue.stage!=='string')receiptReason='receipt-kind-unrecognized';
    else if(candidateReason!==null)receiptReason='candidate-unattributed';
    else if(receiptValue.storePath!==candidateValue.storePath)receiptReason='receipt-candidate-mismatch';
    else if(context.mode==='resolve')receiptReason='receipt-mode-mismatch';
    else if(receiptValue.outcome==='staged'&&(context.mode!=='build'||receiptValue.stage!=='pre-switch-check'))receiptReason='receipt-mode-mismatch';
    else if(receiptValue.outcome==='success'&&(!['deploy','rollback'].includes(context.mode)||receiptValue.stage!=='live-check'))receiptReason='receipt-mode-mismatch';
    else if(receiptValue.outcome==='failure'&&!primaryStages.has(receiptValue.stage))receiptReason='receipt-stage-unrecognized';
    else if(receiptValue.outcome==='recovery-failure'&&(!recoveryStages.has(receiptValue.stage)||!primaryStages.has(receiptValue.originalStage)))receiptReason='receipt-stage-unrecognized';
    else if(['failure','recovery-failure'].includes(receiptValue.outcome)&&['build','check-failure'].includes(context.mode)
      &&!previewStages.has(receiptValue.outcome==='failure'?receiptValue.stage:receiptValue.originalStage))receiptReason='receipt-mode-mismatch';
    else receiptReason=null;
  }
  return {kind:'guix-machine-release-outcome',version:1,run:{repository:run.repository??null,id:run.id??null,attempt:run.attempt??null},
    machine:machine??null,jobOutcome:jobOutcome??null,
    invocation:{...invocation,attributed:hasInvocation},
    candidate:{...candidate,attributed:candidateReason===null,reason:candidateReason},
    receipt:{...receipt,attributed:receiptReason===null,reason:receiptReason},assemblyBreak,
    ...(preparedTargetText===undefined?{}:{preparedTarget:observedJson(preparedTargetText)})};
}

/** The first complete observation owns this run's retained file. A changed
 * reading requires reconciliation; it may not erase the original evidence. */
export function retainOutcome(existingText,outcome){
  const proposed=JSON.stringify(outcome,null,2)+'\n';
  if(existingText!==null&&existingText!==proposed)throw new Error('Retained release outcome conflicts; reconcile the original observation.');
  return proposed;
}
