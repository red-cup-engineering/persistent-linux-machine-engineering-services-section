#!/usr/bin/env node
// Receive changes before they merge. For every repository a machine pins, read the open pull requests into the
// ref the machine tracks; for each head commit the change test has not yet reported on, fetch that commit, run
// scripts/test-change.mjs against the machine's snapshot, and record the verdict on the pull request. It runs on
// the machine's own runner with the GitHub credential that runner already holds for releasing.
//
//   node scripts/receive-pull-requests.mjs SNAPSHOT WORK [--limit N] [--dry-run]
//
// Reads go through GraphQL and git, never the shared REST budget. Completed receiving is scoped to the exact
// head and machine snapshot; attempts that cannot execute remain retryable. Drafts and forks are not received.
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {verifyCandidateSource,verifySnapshotSource,verifyMachineSnapshot,qualifyCandidateToolchain} from './qualify-candidate-toolchain.mjs';
import {controllerTestEnvironment} from './qualify-controller-sources.mjs';
import {dirname,join,resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isCliEntry} from './cli-entry.mjs';
import {machineSources,mountedSourceClosure,gitlinks,directMountsOnly,CONTROLLER_REPOSITORY} from './source-pins.mjs';
import {materializeSources,sourceGraphDelta,nativeComparisonSources} from './materialize-sources.mjs';

const credentials=['-c','credential.helper=','-c','credential.helper=!gh auth git-credential'];
export const marker=(sha,snapshot='')=>`<!-- house-change-test:${sha}${snapshot?':'+snapshot:''} -->`;
export const retryMarker=(sha,snapshot,retryAt)=>marker(sha,snapshot).replace('house-change-test:','house-change-retry:').replace(' -->',`:${retryAt} -->`);

/** The repositories a snapshot pins, each with the ref its machine tracks. */
export function trackedSources(spec){
  const seen=new Map();
  // The machine's own repository is its definition, released by its own workflow; the repositories it mounts are received.
  for(const source of spec.repositories??[])if(source.path!=='.'&&!seen.has(source.repository))seen.set(source.repository,source.ref??'main');
  return [...seen].map(([repository,ref])=>({repository,ref}));
}

/** The pull requests still to receive, oldest work first after the limit is applied per run. */
export function pending(sources,openPulls,limit,snapshotCommit='',now=Date.now()){
  const queue=[];
  for(const {repository,ref} of sources){
    let pulls;
    try{pulls=openPulls(repository,ref,sha=>marker(sha,snapshotCommit));}catch(error){queue.push({repository,ref,unreadable:error.message});continue;}
    for(const pr of pulls)if(!pr.draft&&!pr.fork&&!pr.received&&!(pr.retryAt>now))queue.push({repository,ref,pr});
  }
  const unreadable=queue.filter(item=>item.unreadable),work=queue.filter(item=>item.pr);
  work.sort((a,b)=>String(a.pr.createdAt??'').localeCompare(String(b.pr.createdAt??''))||a.repository.localeCompare(b.repository)||a.pr.number-b.pr.number);
  return {unreadable,work:work.slice(0,limit),deferred:Math.max(0,work.length-limit)};
}

/** The comment that records a verdict on the pull request. */
export function verdictComment({machine,repository,pr,snapshotCommit,result,error,now=Date.now()}){
  const verdict=error?'not-run':result.verdict;
  const lines=[`### Change test: \`${verdict}\``,'',
    `Commit \`${pr.head.sha}\` of ${repository}, composed into ${machine}'s snapshot \`${snapshotCommit}\` and tested the way the machine receives it.`];
  if(error)lines.push('',`The change test could not run: ${error.slice(-1500)}`);
  else{
    if(result.verdict==='not-composed')lines.push('',`The change cannot be assembled${result.break?`: assembly break \`${result.break.class}\`${result.break.package?` (${result.break.package})`:''}`:''}.`,'',
      '```',String(result.reason??'').slice(-1500),'```');
    for(const p of result.packages){
      if(p.status)lines.push(`- \`${p.name}\`: ${p.status}${p.reason?` (${p.reason})`:''}`);
      else lines.push(`- \`${p.name}\`: ${p.passed}/${p.tests} test files pass`+
        (p.regressions.length?`; regressions: ${p.regressions.map(f=>`\`${f}\``).join(', ')}`:'')+
        (p.preexisting.length?`; already failing without this change: ${p.preexisting.map(f=>`\`${f}\``).join(', ')}`:''));
    }
    for(const v of result.designRules?.added??[])lines.push(`- design rule \`${v.rule}\` added: \`${v.key}\``);
    if(result.designRules?.removed?.length)lines.push(`- design-rule violations removed: ${result.designRules.removed.length}`);
    if(!result.packages.length&&result.verdict!=='not-composed')lines.push('- No package of the machine\'s closure changed.');
  }
  const completed=!error&&['no-regression','regression'].includes(result.verdict);
  lines.push('','Observed by the release controller before merge (`scripts/receive-pull-requests.mjs`).',
    completed?marker(pr.head.sha,snapshotCommit):retryMarker(pr.head.sha,snapshotCommit,now+3600_000));
  return lines.join('\n');
}

function fetchHead(work,repository,pr){
  const directory=join(work,'pull-requests',repository.replace('/','_'));
  const git=(...args)=>{const r=spawnSync('git',[...credentials,...args],{cwd:existsSync(directory)?directory:undefined,encoding:'utf8'});
    if(r.status!==0)throw new Error(`git ${args[0]} failed: ${r.stderr.slice(-800)}`);return r.stdout.trim();};
  if(!existsSync(join(directory,'.git'))){mkdirSync(dirname(directory),{recursive:true});git('clone','-q','--filter=blob:none','--no-checkout',`https://github.com/${repository}.git`,directory);}
  git('-C',directory,'fetch','-q','origin',`pull/${pr.number}/head`);
  git('-C',directory,'checkout','-q','--detach',pr.head.sha);
  return directory;
}

export function receive({snapshot,work,limit=2,dryRun=false,github,testChange,fetch=fetchHead,sources=materializeSources,mounts}){
  const spec=mounts===undefined?sources(snapshot,join(work,'mounted-sources')):machineSources(snapshot,'HEAD',{mounts});
  const snapshotCommit=spawnSync('git',['-C',snapshot,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
  const {unreadable,work:queue,deferred}=pending(trackedSources(spec),github.openPulls,limit,snapshotCommit);
  const received=[];
  for(const {repository,pr} of queue){
    if(dryRun){received.push({repository,number:pr.number,head:pr.head.sha,verdict:'dry-run'});continue;}
    let result=null,error=null;
    try{result=testChange(snapshot,join(work,'change-test'),repository,fetch(work,repository,pr));}catch(e){error=e.message;}
    const report=github.commentOnPull(pr.id,verdictComment({machine:spec.repositories[0].repository,repository,pr,snapshotCommit,result,error}));
    if(report?.received!==true)throw new Error('PR receiving result has no independent original-thread receiving');
    received.push({repository,number:pr.number,head:pr.head.sha,verdict:error?'not-run':result.verdict,report:report.url});
  }
  return {kind:'pull-request-receiving',snapshot:snapshotCommit,received,deferred,unreadable:unreadable.map(({repository,unreadable:reason})=>({repository,reason}))};
}

/** Both receiving routes consume the same process/verdict agreement contract. */
function changeTestReading(result){
  if(result.error)throw result.error;
  if(result.signal)throw new Error(`change test terminated: ${result.signal}`);
  let reading;try{reading=JSON.parse(result.stdout);}catch{throw new Error(`change test returned no verdict: ${(result.stderr??'').slice(-4000)}`);}
  if(reading?.kind!=='change-test'||!['no-regression','regression','incomplete','not-composed'].includes(reading.verdict)
    ||result.status!==(reading.verdict==='no-regression'?0:1))throw new Error('change test returned an inconsistent verdict');
  return reading;
}

export function runChangeTest(snapshot,work,repository,checkout,execute=spawnSync){
  const script=join(dirname(fileURLToPath(import.meta.url)),'test-change.mjs');
  const result=execute(process.execPath,[script,snapshot,work,`${repository}=${checkout}`],{encoding:'utf8',maxBuffer:64*1024*1024});
  return changeTestReading(result);
}

const exactRepository=/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/u;
const exactIdentity=value=>value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).sort().join(',')==='commit,repository,tree'
  &&['repository','commit','tree'].every(key=>typeof value[key]==='string')
  &&exactRepository.test(value.repository)&&/^[a-f0-9]{40}$/u.test(value.commit)&&/^[a-f0-9]{40}$/u.test(value.tree);
const exactMachine=value=>value&&Object.keys(value).sort().join(',')==='commit,definition,repository,tree'
  &&exactIdentity({repository:value.repository,commit:value.commit,tree:value.tree})&&typeof value.definition==='string'
  &&(value.definition==='.'||/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(value.definition))
  &&!value.definition.split('/').some(part=>part==='..'||(part==='.'&&value.definition!=='.'));

/** A workflow-fixed request binds both repository roots and their definitions.
 * It names no executable, environment, branch, runner or activation mode. */
export function reviewedChangeRequest(value){
  if(value?.kind==='guix.reviewed-change-request.v4'){
    const fields=(object,names)=>object&&typeof object==='object'&&!Array.isArray(object)
      &&Object.keys(object).sort().join(',')===names.sort().join(',');
    const target=object=>fields(object,['repository','commit','tree','definition','coordinate'])
      &&exactMachine({repository:object.repository,commit:object.commit,tree:object.tree,definition:object.definition})
      &&!object.definition.split('/').includes('.git')&&typeof object.coordinate==='string'
      &&(object.coordinate==='.'||/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(object.coordinate))
      &&object.coordinate.split('/').every(part=>part!=='.git'&&part!=='..'&&(part!=='.'||object.coordinate==='.'));
    const side=object=>fields(object,['software','targets'])&&exactIdentity(object.software)
      &&Array.isArray(object.targets)&&object.targets.length>0&&object.targets.length<=8&&object.targets.every(target)
      &&new Set(object.targets.map(row=>row.repository)).size===object.targets.length;
    if(!fields(value,['kind','controller','baseline','candidate','changes'])||!exactIdentity(value.controller)
      ||value.controller.repository!==CONTROLLER_REPOSITORY||!side(value.baseline)||!side(value.candidate)
      ||value.baseline.software.repository!==value.candidate.software.repository||!Array.isArray(value.changes)
      ||value.changes.length>8||value.changes.some(change=>!exactIdentity(change)||change.repository===value.candidate.software.repository)
      ||new Set(value.changes.map(change=>change.repository)).size!==value.changes.length)
      throw new Error('registry change receiving requires exact roots and committed consumer coordinates');
    return value;
  }
  if(value?.kind==='guix.reviewed-change-request.v3'){
    const fields=(object,names)=>object&&typeof object==='object'&&!Array.isArray(object)
      &&Object.keys(object).sort().join(',')===names.sort().join(',');
    const recipe=object=>fields(object,['path','gitBlob'])&&typeof object.path==='string'
      &&/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(object.path)
      &&object.path.split('/').every(part=>!['.','..','.git'].includes(part))&&/^[a-f0-9]{40}$/u.test(object.gitBlob);
    const side=object=>fields(object,['software','recipe','targets'])&&exactIdentity(object.software)&&recipe(object.recipe)
      &&Array.isArray(object.targets)&&object.targets.length>0&&object.targets.length<=8&&object.targets.every(exactMachine)
      &&object.targets.every(target=>!target.definition.split('/').includes('.git'))
      &&new Set(object.targets.map(target=>target.repository+':'+target.definition)).size===object.targets.length;
    if(!fields(value,['kind','controller','baseline','candidate','changes'])||!exactIdentity(value.controller)
      ||value.controller.repository!==CONTROLLER_REPOSITORY||!side(value.baseline)||!side(value.candidate)
      ||value.baseline.software.repository!==value.candidate.software.repository||!Array.isArray(value.changes)
      ||value.changes.length>8||value.changes.some(change=>!exactIdentity(change)||change.repository===value.candidate.software.repository)
      ||new Set(value.changes.map(change=>change.repository)).size!==value.changes.length)
      throw new Error('native change receiving requires exact common sources, fabrication interfaces and independent targets');
    return value;
  }
  const keys=value&&Object.keys(value).sort().join(',');
  if(!value||Array.isArray(value)||!['changes,controller,kind,snapshot','candidateSnapshot,changes,controller,kind,snapshot'].includes(keys)
    ||value.kind!=='guix.reviewed-change-request.v2'||!exactMachine(value.snapshot)||!exactIdentity(value.controller)
    ||value.controller.repository!==CONTROLLER_REPOSITORY
    ||(value.candidateSnapshot!==undefined&&(!exactMachine(value.candidateSnapshot)||value.candidateSnapshot.repository!==value.snapshot.repository))
    ||!Array.isArray(value.changes)||(!value.changes.length&&!value.candidateSnapshot)||value.changes.length>8
    ||value.changes.some(change=>!exactIdentity(change)||change.repository===value.snapshot.repository)
    ||new Set(value.changes.map(change=>change.repository)).size!==value.changes.length)
    throw new Error('reviewed change receiving requires an exact complete source request');
  return value;
}

export function validateChangeSources(request,base,head=base){
  reviewedChangeRequest(request);
  for(const [side,identity] of [[base,request.snapshot],[head,request.candidateSnapshot??request.snapshot]]){
    const roots=side.repositories.filter(source=>source.path==='.');
    if(roots.length!==1||roots[0].repository!==identity.repository||roots[0].commit!==identity.commit
      ||side.machine?.definition!==identity.definition||side.machine?.tree!==identity.tree)
      throw new Error('source graph differs from its exact machine definition');
    if(new Set(side.repositories.map(source=>source.repository)).size!==side.repositories.length)throw new Error('source graph has ambiguous owners');
  }
  for(const change of request.changes){
    const selected=head.repositories.find(source=>source.repository===change.repository);
    if(!selected||selected.commit!==change.commit||selected.tree!==change.tree)throw new Error(`reviewed change is outside or differs from the candidate source graph: ${change.repository}`);
  }
  const controller=head.repositories.find(source=>source.repository===CONTROLLER_REPOSITORY);
  if(controller?.commit!==request.controller.commit||controller.tree!==request.controller.tree)throw new Error('complete change request must compose the selected controller');
  return request;
}

function sourceQuery(directory,args,input,credentialsEnabled=false){
  const result=spawnSync('git',[...credentialsEnabled?['-c','core.hooksPath=/dev/null',...credentials]:[],...directory?['-C',directory]:[],...args],
    {encoding:'utf8',input,maxBuffer:64*1024*1024,env:{...process.env,GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',...credentialsEnabled?{}:{GIT_ALLOW_PROTOCOL:''}}});
  if(result.error||result.status!==0)throw result.error??new Error(`reviewed source formation failed: ${(result.stderr??'').slice(-2000)}`);
  return result.stdout.trim();
}

/** Committed source carriers may contain inert Git links; unlike controller
 * execution, their working tree is never an authority or recursively checked out. */
export function verifySourceCarrier(directory,identity,requireHead=true){
  if((requireHead&&sourceQuery(directory,['rev-parse','HEAD'])!==identity.commit)
    ||sourceQuery(directory,['rev-parse',`${identity.commit}^{commit}`])!==identity.commit
    ||sourceQuery(directory,['rev-parse',`${identity.commit}^{tree}`])!==identity.tree)
    throw new Error(`reviewed source carrier identity differs: ${identity.repository}`);
  const records=sourceQuery(directory,['ls-tree','-r','-z',identity.commit]).split('\0').filter(Boolean);
  let blobs=records.filter(row=>row.split(' ')[1]==='blob').map(row=>row.slice(row.indexOf(' ',row.indexOf(' ')+1)+1,row.indexOf('\t')));
  if(blobs.length){
    const read=sourceQuery(directory,['cat-file','--batch-check'],blobs.join('\n')+'\n');
    if(read.split('\n').length!==blobs.length||read.split('\n').some(row=>!/^([a-f0-9]{40}) blob [0-9]+$/u.test(row)))
      throw new Error(`reviewed source carrier is incomplete: ${identity.repository}`);
  }
  return directory;
}

export function fetchSourceCarrier(work,pin,change){
  const directory=join(work,'source-carriers',pin.repository.replace('/','_'));
  mkdirSync(dirname(directory),{recursive:true});
  if(existsSync(directory))throw new Error('reviewed source carrier already exists');
  sourceQuery(null,['clone','-q','--filter=blob:none','--no-checkout',`https://github.com/${pin.repository}.git`,directory],undefined,true);
  for(const commit of new Set([pin.commit,...change?[change.commit]:[]])){
    // Fetch history for honest ancestry, and hydrate only this exact tree's
    // blob carriers. No source program is loaded under the reader credential.
    sourceQuery(directory,['fetch','-q','--filter=blob:none','origin',commit],undefined,true);
    const rows=sourceQuery(directory,['ls-tree','-r','-z',commit]).split('\0').filter(Boolean);
    let blobs=rows.filter(row=>row.split(' ')[1]==='blob').map(row=>row.slice(row.indexOf(' ',row.indexOf(' ')+1)+1,row.indexOf('\t')));
    if(blobs.length){
      const missing=sourceQuery(directory,['cat-file','--batch-check'],blobs.join('\n')+'\n').split('\n').filter(row=>row.endsWith(' missing')).map(row=>row.split(' ')[0]);
      if(missing.length)sourceQuery(directory,['-c','fetch.negotiationAlgorithm=noop','fetch','--quiet','--no-tags','--no-write-fetch-head','--recurse-submodules=no','--filter=blob:none','origin','--stdin'],missing.join('\n')+'\n',true);
    }
  }
  sourceQuery(directory,['update-ref','--no-deref','HEAD',change?.commit??pin.commit]);
  const pinned={repository:pin.repository,commit:pin.commit,tree:sourceQuery(directory,['rev-parse',`${pin.commit}^{tree}`])};
  const selected=change?{...change,tree:change.tree??sourceQuery(directory,['rev-parse',`${change.commit}^{tree}`])}:pinned;
  verifySourceCarrier(directory,pinned,!change);
  if(change)verifySourceCarrier(directory,selected);
  return {directory,pin:pinned,selected};
}

/** Carry only the exact prerequisite reading returned by the fixed qualification.
 * Parent GUILE_* and loader variables do not select comparison interpreters. */
export function qualifiedChangeTestEnvironment({controllerSources,nodeExecutable,home,tmp,path}){
  if(!controllerSources||controllerSources.nodeExecutable!==nodeExecutable||
    typeof controllerSources.guileExecutable!=='string'||!controllerSources.guileExecutable.endsWith('/bin/guile')||
    typeof controllerSources.jsonModule!=='string'||!controllerSources.jsonModule.endsWith('/share/guile/site/3.0/json.scm'))
    throw new Error('change tests require the qualified controller interpreter reading');
  const tools={guile:controllerSources.guileExecutable.slice(0,-'/bin/guile'.length),
    json:controllerSources.jsonModule.slice(0,-'/share/guile/site/3.0/json.scm'.length)};
  const env=controllerTestEnvironment({tools,nodeExecutable,home,tmp});
  // Preserve the trusted workflow's existing Guix search path for composition;
  // the already-qualified native interpreters always precede it.
  return {...env,PATH:[dirname(nodeExecutable),dirname(controllerSources.guileExecutable),path??''].filter(Boolean).join(':')};
}

export function runExactChangeTest({service,snapshot,candidateSnapshot,work,changes,node,localSources,controllerSources,execute=spawnSync,environment=process.env}){
  const home=join(work,'isolated-home'),tmp=join(work,'isolated-tmp');
  const native=qualifiedChangeTestEnvironment({controllerSources,nodeExecutable:node,home,tmp,path:environment.PATH});
  mkdirSync(home,{recursive:true});mkdirSync(tmp,{recursive:true});
  const env={HOME:home,GH_CONFIG_DIR:home,TMPDIR:tmp,PATH:native.PATH,
    GUILE_AUTO_COMPILE:native.GUILE_AUTO_COMPILE,GUILE_LOAD_PATH:native.GUILE_LOAD_PATH,LANG:'C.UTF-8',LC_ALL:'C.UTF-8',
    GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_ALLOW_PROTOCOL:'file',
    NODE_DISABLE_COMPILE_CACHE:'1'};
  const carriers=join(work,'local-source-carriers.json');writeFileSync(carriers,JSON.stringify(localSources));
  const result=execute(node,['--no-addons','--no-global-search-paths',join(service,'scripts/test-change.mjs'),snapshot,join(work,'workspaces'),`--local-sources=${carriers}`,
    ...candidateSnapshot?[`--candidate-snapshot=${candidateSnapshot}`]:[],...changes.map(({repository,directory})=>`${repository}=${directory}`)],{encoding:'utf8',maxBuffer:64*1024*1024,env});
  return changeTestReading(result);
}

/** Fixed receiving on the existing runner. No PR discovery/comment, source pin
 * update, lock generation, assembly activation or deployment is performed. */
export function receiveReviewedChanges({snapshot,candidateRoot,work,requestFile,requestSha256,service=resolve(dirname(fileURLToPath(import.meta.url)),'..'),
  verifyMachine=verifyMachineSnapshot,verifyController=verifyCandidateSource,qualify=qualifyCandidateToolchain,
  fetch=fetchSourceCarrier,verifyCarrier=verifySourceCarrier,readLinks=gitlinks,testChange=runExactChangeTest,environment=process.env}){
  if(typeof requestSha256!=='string'||!/^[a-f0-9]{64}$/u.test(requestSha256))throw new Error('receiving request needs its workflow-fixed digest');
  const bytes=readFileSync(requestFile);
  if(createHash('sha256').update(bytes).digest('hex')!==requestSha256)throw new Error('receiving request differs from reviewed workflow bytes');
  const request=reviewedChangeRequest(JSON.parse(bytes));
  if(['guix.reviewed-change-request.v3','guix.reviewed-change-request.v4'].includes(request.kind))return receiveNativeReviewedChanges({snapshot,candidateRoot,work,requestFile,requestSha256,request,
    service,verifyController,fetch,verifyCarrier,environment});
  if(Boolean(candidateRoot)!==Boolean(request.candidateSnapshot))throw new Error('candidate root must match the complete fixed request');
  const env={PATH:environment.PATH??'',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_ALLOW_PROTOCOL:''};
  service=verifyController(service,request.controller.commit,request.controller.tree,env);
  const baseBinding=verifyMachine(snapshot,request.snapshot,env),headBinding=request.candidateSnapshot?verifyMachine(candidateRoot,request.candidateSnapshot,env):baseBinding;
  const baseDeclaration=machineSources(baseBinding.snapshot,'HEAD',{mounts:directMountsOnly}),headDeclaration=machineSources(headBinding.snapshot,'HEAD',{mounts:directMountsOnly});
  work=resolve(work);
  let ancestor=dirname(work);const suffix=[basename(work)];
  while(!existsSync(ancestor)){suffix.unshift(basename(ancestor));ancestor=dirname(ancestor);}
  if(join(realpathSync(ancestor),...suffix)!==work)throw new Error('receiving work path is redirected');
  for(const input of [service,baseBinding.root,headBinding.root])if(work===input||work.startsWith(input+'/')||input.startsWith(work+'/'))throw new Error('receiving work must be outside immutable sources');
  if(existsSync(work))throw new Error('reviewed change receiving needs a fresh work directory');
  mkdirSync(work,{recursive:true});
  const identity={kind:'guix.reviewed-change-receiving.v2',requestSha256,request,baselineMachine:baseBinding.identity,candidateMachine:headBinding.identity};
  const receipt=join(work,'reviewed-change-receiving.json');
  let stage='exact-change-sources',toolchain,controllerSources,result,baseGraph,headGraph;const sourceCarriers=[],changes=[];
  const requested=new Map(request.changes.map(change=>[change.repository,change]));
  const baseCarriers=new Map(),headCarriers=new Map();
  const tree=(directory,commit)=>{
    for(const binding of [baseBinding,headBinding])if(directory===binding.root&&commit===binding.identity.commit)return binding.identity.tree;
    for(const carrier of sourceCarriers)if(carrier.directory===directory){for(const reading of [carrier.pin,carrier.selected])if(reading.commit===commit)return reading.tree;}
    throw new Error('source graph tree has no verified carrier');
  };
  const record=(where,pin,change)=>{
    const carrier=fetch(where,pin,change);
    if(carrier.pin.repository!==pin.repository||carrier.pin.commit!==pin.commit||carrier.selected.repository!==pin.repository
      ||carrier.selected.commit!==(change?.commit??pin.commit)||(change?.tree&&carrier.selected.tree!==change.tree))throw new Error('source carrier differs from the exact request');
    verifyCarrier(carrier.directory,carrier.pin,false);verifyCarrier(carrier.directory,carrier.selected);
    carrier.acquisition='complete-source-objects';
    sourceCarriers.push(carrier);return carrier;
  };
  try{
    // Acquire only source objects under the reader's custody. Candidate programs
    // do not run here. Both walks preserve every authored edge, including edges
    // introduced by a reviewed parent's candidate topology.
    baseGraph=mountedSourceClosure(baseDeclaration,pin=>{
      if(pin.path==='.')return baseBinding.root;
      const carrier=record(join(work,'baseline'),pin,requested.get(pin.repository));baseCarriers.set(pin.repository,carrier);return carrier.directory;
    },{link:readLinks,tree});
    const prior=new Map(baseGraph.repositories.map(source=>[source.repository,source.commit]));
    headGraph=mountedSourceClosure(headDeclaration,selected=>{
      if(selected.path==='.')return headBinding.root;
      let carrier=baseCarriers.get(selected.repository);
      if(!carrier||carrier.selected.commit!==selected.commit){
        const pin=baseGraph.repositories.find(source=>source.repository===selected.repository)??selected;
        const change=requested.get(selected.repository)??(pin.commit!==selected.commit?{repository:selected.repository,commit:selected.commit}:undefined);
        carrier=record(join(work,'candidate'),pin,change);
      }
      headCarriers.set(selected.repository,carrier);return carrier.directory;
    },{link:readLinks,tree,baseline:prior,replacements:new Map(request.changes.map(change=>[change.repository,change.commit]))});
    validateChangeSources(request,baseGraph,headGraph);
    const carriers=new Map([...baseCarriers,...headCarriers]);
    for(const change of request.changes){const carrier=carriers.get(change.repository);if(!carrier||carrier.selected.commit!==change.commit||carrier.selected.tree!==change.tree)throw new Error('requested source has no exact selected carrier');changes.push({...change,directory:carrier.directory});}
    stage='toolchain-qualification';
    const qualified=qualify(service,headBinding.snapshot,join(work,'provider'),request.controller.commit,request.controller.tree);
    toolchain=qualified.toolchain;controllerSources=qualified.controllerSources;
    qualifiedChangeTestEnvironment({controllerSources,nodeExecutable:toolchain.nodeExecutable,
      home:join(work,'comparison','isolated-home'),tmp:join(work,'comparison','isolated-tmp'),path:environment.PATH});
    stage='change-composition';
    result=testChange({service,snapshot:baseBinding.snapshot,candidateSnapshot:request.candidateSnapshot?headBinding.snapshot:undefined,
      work:join(work,'comparison'),changes,localSources:[...carriers].map(([repository,carrier])=>[repository,carrier.directory]),node:toolchain.nodeExecutable,controllerSources,environment});
    const expectedDelta=sourceGraphDelta(baseGraph,headGraph);
    if(result.snapshot!==request.snapshot.commit||result.sourcePlan?.kind!=='guix.comparison-source-plan.v1'||result.sourcePlan.scope!=='comparison-only'
      ||result.sourcePlan.baseline!==baseGraph.graphSha256||result.sourcePlan.candidate!==headGraph.graphSha256
      ||result.sourcePlanSha256!==createHash('sha256').update(JSON.stringify(result.sourcePlan)).digest('hex')
      ||JSON.stringify(result.sourcePlan.delta)!==JSON.stringify(expectedDelta)
      ||JSON.stringify(result.sourcePlan.requested)!==JSON.stringify(request.changes.map(({repository,commit,tree})=>({repository,commit,tree})).sort((a,b)=>a.repository.localeCompare(b.repository,'en'))))
      throw new Error('change verdict does not bind the complete reviewed graphs and request');
    stage='source-integrity';
    verifyController(service,request.controller.commit,request.controller.tree,env);
    verifyMachine(baseBinding.root,request.snapshot,env);if(request.candidateSnapshot)verifyMachine(headBinding.root,request.candidateSnapshot,env);
    for(const carrier of sourceCarriers){verifyCarrier(carrier.directory,carrier.pin,false);verifyCarrier(carrier.directory,carrier.selected);}
    const reading={...identity,outcome:result.verdict,baselineGraph:baseGraph.graph,candidateGraph:headGraph.graph,
      sourceCarriers:sourceCarriers.map(({directory,...identities})=>identities),toolchain,controllerSources,result};
    writeFileSync(receipt,JSON.stringify(reading,null,2)+'\n');return reading;
  }catch(error){
    writeFileSync(receipt,JSON.stringify({...identity,outcome:'not-run',stage,error:error.message,
      ...baseGraph?{baselineGraph:baseGraph.graph}:{},...headGraph?{candidateGraph:headGraph.graph}:{},
      sourceCarriers:sourceCarriers.map(({directory,...identities})=>identities),...toolchain?{toolchain}:{},...controllerSources?{controllerSources}:{},...result?{result}:{}},null,2)+'\n');throw error;
  }
}

/** Source admission for the current native contract. It shares the existing
 * receiver's request, custody, acquisition and failure receipt; it cannot turn
 * source proof into native product qualification or a no-regression verdict. */
function receiveNativeReviewedChanges({snapshot,candidateRoot,work,requestFile,requestSha256,request,service,verifyController,fetch,verifyCarrier,environment}){
  if(!candidateRoot)throw new Error('native comparison requires both independently selected common source roots');
  const env={PATH:environment.PATH??'',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_ALLOW_PROTOCOL:''};
  service=verifyController(service,request.controller.commit,request.controller.tree,env);
  const roots=[snapshot,candidateRoot].map(directory=>{
    if(typeof directory!=='string'||resolve(directory)!==directory||realpathSync(directory)!==directory)
      throw new Error('native common source roots must be canonical');
    return directory;
  });
  work=resolve(work);let ancestor=dirname(work);const suffix=[basename(work)];
  while(!existsSync(ancestor)){suffix.unshift(basename(ancestor));ancestor=dirname(ancestor);}
  if(join(realpathSync(ancestor),...suffix)!==work||existsSync(work))throw new Error('native receiving requires fresh unredirected work custody');
  for(const input of [service,...roots])if(work===input||work.startsWith(input+'/')||input.startsWith(work+'/'))
    throw new Error('native receiving work must be outside immutable source custody');
  mkdirSync(work,{recursive:true});
  const receipt=join(work,'reviewed-change-receiving.json'),carriers=new Map();
  const identity={kind:request.kind==='guix.reviewed-change-request.v4'?'guix.reviewed-change-receiving.v4':'guix.reviewed-change-receiving.v3',requestSha256,request};
  let stage='native-source-plan',pair;
  const key=source=>source.repository+'@'+source.commit;
  const read=(source,side,role)=>{
    let directory=role==='software'?roots[side==='baseline'?0:1]:carriers.get(key(source))?.directory;
    if(role==='software'){
      verifyCarrier(directory,source);
      carriers.set(key(source),{...source,directory});
      return directory;
    }
    if(!directory){
      const carrier=fetch(join(work,'sources',String(carriers.size)),source);
      if(carrier.pin.repository!==source.repository||carrier.pin.commit!==source.commit
        ||carrier.selected.repository!==source.repository||carrier.selected.commit!==source.commit
        ||(source.tree!==undefined&&carrier.selected.tree!==source.tree))throw new Error('native source acquisition differs from the reviewed source');
      directory=carrier.directory;
      const tree=sourceQuery(directory,['rev-parse',`${source.commit}^{tree}`]);
      if(source.tree!==undefined&&tree!==source.tree)throw new Error('native source tree differs from reviewed identity');
      const retained={repository:source.repository,commit:source.commit,tree};
      verifyCarrier(directory,retained);carriers.set(key(source),{...retained,directory});
    }
    return directory;
  };
  try{
    pair=nativeComparisonSources(request,read);
    stage='native-source-integrity';
    if(createHash('sha256').update(readFileSync(requestFile)).digest('hex')!==requestSha256)
      throw new Error('native request changed during source acquisition');
    verifyController(service,request.controller.commit,request.controller.tree,env);
    for(const carrier of carriers.values())verifyCarrier(carrier.directory,carrier);
    const repeated=nativeComparisonSources(request,(source,side,role)=>{
      const directory=role==='software'?roots[side==='baseline'?0:1]:carriers.get(key(source))?.directory;
      if(!directory)throw new Error('native source verification cannot acquire an unretained carrier');
      verifyCarrier(directory,source.tree?source:carriers.get(key(source)));
      return directory;
    });
    if(repeated.planSha256!==pair.planSha256)throw new Error('native comparison source plan changed during acquisition');
    if(createHash('sha256').update(readFileSync(requestFile)).digest('hex')!==requestSha256)
      throw new Error('native request changed during final source verification');
    const reading={...identity,outcome:'incomplete',stage:'native-product-receiving',sourcePlan:pair.plan,sourcePlanSha256:pair.planSha256,
      baselineGraph:pair.base.graph,candidateGraph:pair.head.graph,
      sourceCarriers:[...carriers.values()].map(({directory,...source})=>source),
      reason:'Native base/candidate fabrication, original engineering obligations and target interfaces have not been received.',runtimeAcceptance:false};
    writeFileSync(receipt,JSON.stringify(reading,null,2)+'\n');return reading;
  }catch(error){
    writeFileSync(receipt,JSON.stringify({...identity,outcome:'not-run',stage,error:error.message,
      ...pair?{sourcePlan:pair.plan,sourcePlanSha256:pair.planSha256}:{},runtimeAcceptance:false},null,2)+'\n');throw error;
  }
}

if(isCliEntry(import.meta.url)&&process.argv[4]==='--exact'){
  if(process.argv.length!==7&&!(process.argv.length===8&&process.argv[7].startsWith('--candidate-root=')))throw new Error('usage: receive-pull-requests.mjs ROOT WORK --exact REQUEST_FILE REQUEST_SHA256 [--candidate-root=ROOT]');
  const reading=receiveReviewedChanges({snapshot:process.argv[2],work:process.argv[3],requestFile:process.argv[5],requestSha256:process.argv[6],candidateRoot:process.argv[7]?.slice('--candidate-root='.length)});
  process.stdout.write(JSON.stringify(reading,null,2)+'\n');process.exitCode=reading.outcome==='no-regression'?0:1;
}else if(isCliEntry(import.meta.url)){
  const args=process.argv.slice(2),[snapshot,work]=args.filter(a=>!a.startsWith('--')&&!/^\d+$/.test(a));
  const at=args.indexOf('--limit'),limit=at>=0?Number(args[at+1]):2;
  if(!snapshot||!work||!Number.isSafeInteger(limit)||limit<1){process.stderr.write('usage: receive-pull-requests.mjs SNAPSHOT WORK [--limit N] [--dry-run]\n');process.exit(1);}
  const github=await import('./github-reads.mjs');
  const outcome=receive({snapshot:resolve(snapshot),work:resolve(work),limit,dryRun:args.includes('--dry-run'),github,testChange:runChangeTest});
  process.stdout.write(JSON.stringify(outcome,null,2)+'\n');
}
