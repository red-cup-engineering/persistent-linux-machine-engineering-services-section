#!/usr/bin/env node
// Preserve a run observation before reporting or disposing of build scratch.
import {spawnSync} from 'node:child_process';
import {appendFileSync,readFileSync,rmSync,openSync,writeFileSync,fsyncSync,closeSync,linkSync,unlinkSync,mkdirSync,lstatSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isCliEntry} from './cli-entry.mjs';
import {releaseOutcome,retainOutcome,observedJson} from './release-outcome.mjs';

const readOptional=path=>{try{return readFileSync(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const syncDirectory=path=>{const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}};

/** Existing work directory is run/attempt-scoped. Preserve-before-cleanup,
 * exclusive installation and fsync follow source-admission receipt custody. */
export function saveOutcome(work,outcome){
  // Its existing runner-cache parent is the custody boundary. Do not create a
  // new hierarchy whose own parent entries have not been synchronized.
  try{mkdirSync(work,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  if(!lstatSync(work).isDirectory()||lstatSync(work).isSymbolicLink())throw new Error('Invalid outcome custody.');
  syncDirectory(dirname(work));
  const file=join(work,'release-outcome.json');
  try{if(!lstatSync(file).isFile())throw new Error('Invalid retained outcome.');}catch(error){if(error.code!=='ENOENT')throw error;}
  const existing=readOptional(file),bytes=retainOutcome(existing===null?null:existing.toString('utf8'),outcome);
  // A prior attempt may have linked successfully and then failed directory
  // synchronization. Retry that durability boundary before declaring success.
  if(existing!==null){syncDirectory(work);return file;}
  const temporary=join(work,`.release-outcome-${randomUUID()}`),fd=openSync(temporary,'wx',0o600);
  try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
  try{linkSync(temporary,file);}
  catch(error){if(error.code!=='EEXIST')throw error;retainOutcome(readFileSync(file,'utf8'),outcome);}
  finally{unlinkSync(temporary);}
  syncDirectory(work);return file;
}

const readReceipt=config=>{
  const status=join(config.receiptRoot,'latest.json');
  return config.receiverHost?spawnSync('ssh',[config.receiverHost,'cat',status],{timeout:15000,maxBuffer:1048576}):spawnSync('cat',[status],{timeout:15000,maxBuffer:1048576});
};
const readRollbackTarget=(config,env)=>{
  if(!/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID??'')||!/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT??''))
    return {status:null,stdout:null};
  const file=join(config.receiptRoot,`rollback-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}.json`);
  return config.receiverHost?spawnSync('ssh',[config.receiverHost,'cat',file],{timeout:15000,maxBuffer:1048576})
    :spawnSync('cat',[file],{timeout:15000,maxBuffer:1048576});
};

export function recordOutcome(work,env=process.env,{snapshot='.',native=false,readLatest=readReceipt,writeLog=line=>process.stdout.write(line)}={}){
  if(!work)throw new Error('usage: record-outcome.mjs <run work directory>');
  const invocationText=readOptional(join(work,'release-invocation.json'));
  const rollback=native&&observedJson(invocationText).value?.mode==='rollback';
  const preparedTargetText=rollback?readOptional(join(work,'prepared-target.json')):null;
  let candidateText=readOptional(join(work,'candidate.json'));
  const candidateStore=observedJson(rollback?preparedTargetText:candidateText).value?.storePath;
  const config=native
    ?(typeof candidateStore==='string'&&/^\/gnu\/store\/[^/]+$/.test(candidateStore)
      ?JSON.parse(readFileSync(join(candidateStore,'.controller','machine.json'),'utf8')):null)
    :JSON.parse(readFileSync(join(snapshot,'machine.json'),'utf8'));
  // This is the pre-existing read-only receipt port, not a receiving action.
  // A refused native build has no generated machine policy or host receipt to read.
  const read=config?readLatest(config):{status:null,stdout:null};
  if(rollback){const selected=config?readRollbackTarget(config,env):null;candidateText=selected?.status===0&&!selected.error?selected.stdout:null;}
  let assemblyBreakText=readOptional(join(work,'workspace','assembly-break.json'));
  if(assemblyBreakText===null){
    // A successful earlier recording removed workspace. Reuse its original
    // assembly reading on replay, rather than inventing a changed observation.
    const prior=readOptional(join(work,'release-outcome.json'));
    const retained=prior===null?null:JSON.parse(prior).assemblyBreak?.bytesBase64;
    if(typeof retained==='string')assemblyBreakText=Buffer.from(retained,'base64');
  }
  const outcome=releaseOutcome({run:{repository:env.GITHUB_REPOSITORY,id:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT},
    machine:config?.name,jobOutcome:env.JOB_OUTCOME,
    invocationText,candidateText,...(rollback?{preparedTargetText}:{}),
    receiptText:read.status===0&&!read.error?read.stdout:null,assemblyBreakText});
  const file=saveOutcome(work,outcome);
  // Existing Actions logs provide machine-readable delivery even when the job
  // summary cannot be retrieved. Local evidence stays at this exact run path.
  writeLog(JSON.stringify(outcome)+'\n');
  if(env.GITHUB_OUTPUT)appendFileSync(env.GITHUB_OUTPUT,`release_outcome_path=${file}\n`);
  const lines=[`Machine snapshot: \`${outcome.invocation.value?.revision??'unattributed'}\`\n`,`Job outcome: ${outcome.jobOutcome}\n`,
    `Retained outcome: \`${file}\`\n`,`Candidate attributed: ${outcome.candidate.attributed}; receipt attributed: ${outcome.receipt.attributed}\n`];
  for(const [name,evidence] of [['Candidate',outcome.candidate],['Assembly break',outcome.assemblyBreak],['Latest release-writer observation',outcome.receipt]])
    lines.push(`${name} (${evidence.state}${evidence.reason?`; ${evidence.reason}`:''}):\n\n\`\`\`json\n${JSON.stringify(evidence.value??null,null,2)}\n\`\`\`\n`);
  if(env.GITHUB_STEP_SUMMARY)appendFileSync(env.GITHUB_STEP_SUMMARY,lines.join('\n'));
  // Retained invocation/candidate/outcome remain outside these disposable roots.
  for(const name of ['sources','workspace','artifacts','registry-cache'])rmSync(join(work,name),{recursive:true,force:true});
  return outcome;
}

if(isCliEntry(import.meta.url)){
  const [work,option,...extra]=process.argv.slice(2);
  if(extra.length||option!==undefined&&option!=='--native')throw new Error('usage: record-outcome.mjs WORK [--native]');
  recordOutcome(work,process.env,{native:option==='--native'});
}
