import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {dirname,resolve,relative} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {reviewedChangeRequest} from './receive-pull-requests.mjs';
import {controllerBootstrap,releaseSourceReaderShell} from './project-controller-bootstrap.mjs';
import {isCliEntry} from './cli-entry.mjs';
import {trustedSourceVerifierSource} from './verify-release-source.mjs';
export {verifyTrustedSource} from './verify-release-source.mjs';

const workflowPath='.github/workflows/release.yml';
const controllerRepository='red-cup-engineering/guix-machine-release-service';
const checkout='actions/checkout@11d5960a326750d5838078e36cf38b85af677262';
const exact=value=>typeof value==='string'&&value.length===40&&/^[a-f0-9]{40}$/.test(value)&&!/^0+$/.test(value);
const keys=(value,required,optional=[])=>value&&typeof value==='object'&&!Array.isArray(value)
  &&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>[...required,...optional].includes(key));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const canonical=value=>value==='.'||typeof value==='string'&&!/[\u0000-\u001f\u007f\u2028\u2029]/.test(value)&&/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value)
  &&value.split('/').every(part=>!['.','..','.git'].includes(part));

/** Committed consumer data selects typed owner effects, never shell or a catalog. */
export function releaseConsumerBinding(binding){
  const fields=['kind','repository','repositoryId','definition','workflow','actor','channelsBlob','runner','lease','concurrency','runDirectory','events','modes','defaultMode','sourcePolicy','activationHeld','effects'];
  const safe=(value,pattern,max=256)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u001f\u007f\u2028\u2029]/.test(value)&&pattern.test(value);
  const ordered=(values,allowed)=>Array.isArray(values)&&values.length>0&&same(values,allowed.filter(value=>values.includes(value)));
  const effects=binding?.effects;
  if(!keys(binding,fields,['nativeController','nativeInputs'])||binding.kind!=='guix.release-consumer-binding.v2'
    ||!safe(binding.repository,/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/,200)
    ||!Number.isSafeInteger(binding.repositoryId)||binding.repositoryId<1
    ||!canonical(binding.definition)||binding.definition.length>512||binding.workflow!==workflowPath
    ||!safe(binding.actor,/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/,39)||!exact(binding.channelsBlob)
    ||!Array.isArray(binding.runner)||binding.runner.length<4||binding.runner.length>8
    ||!same(binding.runner.slice(0,4),['self-hosted','Linux','X64','guix'])
    ||new Set(binding.runner).size!==binding.runner.length||binding.runner.some(label=>!safe(label,/^[A-Za-z0-9][A-Za-z0-9_.-]*$/,64))
    ||!safe(binding.lease,/^[.]cache\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*[.]lease$/)||!canonical(binding.lease)
    ||!safe(binding.runDirectory,/^[.]cache\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/)||!canonical(binding.runDirectory)
    ||!safe(binding.concurrency,/^[A-Za-z0-9][A-Za-z0-9_.-]*$/,100)
    ||!ordered(binding.events,['push','pull_request','workflow_dispatch','issue_comment'])
    ||!binding.events.includes('push')||!binding.events.includes('workflow_dispatch')
    ||!ordered(binding.modes,['build','deploy','check-failure','rollback'])||binding.modes[0]!=='build'||binding.defaultMode!=='build'
    ||typeof binding.activationHeld!=='boolean'||binding.activationHeld&&!same(binding.modes,['build'])
    ||!['controller-admission-v1','refuse-declared-sql-before-bootstrap-v1'].includes(binding.sourcePolicy)
    ||!keys(effects,['deinitializeSubmodules','prepareBuildSwap','queuedHeadCheck','rebuildOutcomeCache','cpuWeight'])
    ||['deinitializeSubmodules','prepareBuildSwap','queuedHeadCheck','rebuildOutcomeCache'].some(key=>typeof effects[key]!=='boolean')
    ||effects.cpuWeight!==null&&(!keys(effects.cpuWeight,['unit','weight'])
      ||!safe(effects.cpuWeight.unit,/^[A-Za-z0-9][A-Za-z0-9_.@-]*[.]service$/,128)
      ||!Number.isInteger(effects.cpuWeight.weight)||effects.cpuWeight.weight<1||effects.cpuWeight.weight>10000))
    throw new Error('invalid trusted consumer binding or effect policy');
  if(binding.nativeController!==undefined){
    fixedIdentity(binding.nativeController);
    if(!ordered(binding.nativeInputs,['GUIX_COMMON_ASSEMBLY_RECEIPT','GUIX_COMMON_SOFTWARE_RECEIPT','GUIX_COMMON_SOURCE_SNAPSHOT','GUIX_ONE_TIME_CUSTODY_SOURCE'])
      ||!same(binding.nativeInputs.slice(0,3),['GUIX_COMMON_ASSEMBLY_RECEIPT','GUIX_COMMON_SOFTWARE_RECEIPT','GUIX_COMMON_SOURCE_SNAPSHOT'])
      ||effects.prepareBuildSwap||effects.deinitializeSubmodules)
      throw new Error('native receiving requires explicit common inputs and no legacy machine effects');
  }else if(binding.nativeInputs!==undefined)throw new Error('native inputs require their reviewed controller');
  return binding;
}

/**
 * Read a historical Guix consumer declaration directly out of an exact Git
 * commit, without checking out the archived branch or projecting a runnable
 * workflow. The real Git Source Reading service supplies the one source read.
 * The trusted caller establishes repository/name-to-ID association and owns
 * the reader's acquisition bounds and child-repository policy. This adapter
 * checks the supplied identity against the declaration and exact provenance.
 *
 * A historical "activationHeld:false" is old source testimony, NEVER current
 * permission to run a self-hosted release or to reanimate bare-cedar-fog.
 * The result is typed source evidence for the original Guix/Coesite receiving
 * Work; it is deliberately not a current releaseConsumerBinding for the
 * effectful projectReleaseCaller entrance.
 */
export async function inspectHistoricalReleaseConsumerBinding({
  readPinnedSourceFiles, repository, repositoryId, commit, path='release-consumer.json',
}={}){
  if(typeof readPinnedSourceFiles!=='function')
    throw new TypeError('original exact-commit Git source reader required');
  if(typeof repository!=='string'||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(repository)||
      !Number.isSafeInteger(repositoryId)||repositoryId<1||
      typeof commit!=='string'||!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commit)||
      /^0+$/u.test(commit)||!canonical(path)||path==='.'||
      !/(?:^|\/)release-consumer\.json$/u.test(path))
    throw new TypeError('historical consumer requires exact repository, ID, commit and original binding path');
  const separator=path.lastIndexOf('/');
  const scope=separator<0?'':path.slice(0,separator),name=path.slice(separator+1);
  // The provider's repository is a Git origin, not the declaration's owner/name.
  const sourceRepository=`https://github.com/${repository}.git`;
  const files=await readPinnedSourceFiles({
    repository:sourceRepository,commit,scope,selectFile:filename=>filename===name,
    enterDirectory:()=>false,
  });
  if(!Array.isArray(files)||files.length!==1)
    throw new Error('exactly one original historical Guix consumer binding must be selected');
  const file=files[0];
  if(file?.mode!=='100644'||file.path!==name||
      file.source?.repository!==sourceRepository||
      file.source?.commit!==commit||file.source?.path!==path||
      typeof file.source?.object!=='string'||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(file.source.object)||
      file.source.object.length!==commit.length||
      !(file.bytes instanceof Uint8Array)||
      file.bytes.byteLength===0||file.bytes.byteLength>65536)
    throw new Error('historical consumer source kind, path, identity or byte limit differs');
  const bytes=Buffer.from(file.bytes);
  const blob=createHash(commit.length===40?'sha1':'sha256')
    .update('blob '+bytes.length+'\0').update(bytes).digest('hex');
  if(blob!==file.source.object)
    throw new Error('historical consumer Git blob identity differs from exact supplied bytes');
  const binding=releaseConsumerBinding(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
  if(binding.repository!==repository||binding.repositoryId!==repositoryId)
    throw new Error('historical consumer binding repository differs from selected original Git source');
  // Never supply the historical binding to projectReleaseCaller as a
  // supposedly current machine; only return the source coordinates and the
  // specific historical, non-authoritative signals a receiving office needs.
  return Object.freeze({
    recordKind:'guix.historical-release-consumer-source-observation/v1',
    source:Object.freeze({
      repositoryFullName:repository,repositoryId,
      commitId:commit,sourcePath:path,gitBlobObjectId:blob,
      contentSha256:createHash('sha256').update(bytes).digest('hex'),
      sourceFormat:'git-committed-json',
    }),
    originalBindingRecordKind:binding.kind,
    historicalConsumer:Object.freeze({
      repositoryFullName:binding.repository,
      repositoryId:binding.repositoryId,
      machineDefinitionPath:binding.definition,
      workflowPath:binding.workflow,
      declaredRunnerLabels:Object.freeze([...binding.runner]),
      declaredActivationHeld:binding.activationHeld,
      declaredSourcePolicy:binding.sourcePolicy,
      declaredOperationModes:Object.freeze([...binding.modes]),
    }),
    sourceReceiving:'original-commit-and-blob-observed',
    operationalInstallation:'not-observed',
    originalWorkReceiving:'not-observed',
    independentConsumerReceiving:'not-observed',
    authorizedEffects:Object.freeze([]),
    nextReceivingAction:'reconcile-historical-consumer-with-current-guix-owner-and-independent-coesite-receiver',
  });
}

/** Source transformation reads a committed consumer input; no selected code runs. */
export function readCommittedConsumerBinding(file){
  const path=resolve(file),stat=lstatSync(path);
  if(realpathSync(path)!==path||!stat.isFile()||stat.mode&0o111||stat.size>65536)throw new Error('consumer binding input is redirected or oversized');
  const bytes=readFileSync(path);
  const query=args=>{
    const result=spawnSync('git',['-C',dirname(path),...args],{maxBuffer:1024*1024,
      env:{PATH:process.env.PATH??'',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_ALLOW_PROTOCOL:''}});
    if(result.error||result.status!==0)throw new Error('consumer binding must be committed source');return result.stdout;
  };
  const root=query(['rev-parse','--show-toplevel']).toString().trim(),name=relative(root,path);
  if(!canonical(name)||name==='.')throw new Error('consumer binding path is not canonical');
  const commit=query(['rev-parse','HEAD']).toString().trim();if(!exact(commit))throw new Error('consumer binding has no exact source commit');
  const entry=query(['ls-tree','--full-tree','-z',commit,'--',name]).toString(),tab=entry.indexOf('\t');
  if(!/^100644 blob [a-f0-9]{40}$/.test(entry.slice(0,tab))||entry.slice(tab+1)!==name+'\0')throw new Error('consumer binding must be a committed regular data file');
  const committed=query(['show',`${commit}:${name}`]);
  if(!committed.equals(bytes))throw new Error('consumer binding differs from its committed bytes');
  return {binding:releaseConsumerBinding(JSON.parse(bytes)),source:{path:name,commit,
    tree:query(['rev-parse',`${commit}^{tree}`]).toString().trim(),blob:query(['rev-parse',`${commit}:${name}`]).toString().trim(),sha256:createHash('sha256').update(bytes).digest('hex')}};
}
export function projectCommittedReleaseCaller(file,diagnostics={}){
  const {binding,source}=readCommittedConsumerBinding(file),output=projectReleaseCaller(binding,diagnostics);
  return Object.freeze({[workflowPath]:`# Committed consumer input: ${JSON.stringify(source)}\n`+output[workflowPath]});
}

/** Exact immutable diagnostics have no ordinary build/deploy admission branch. */
export function admitDiagnosticEvent(context,binding,mode){
  const {eventName,actor,triggeringActor,repository,event,ref,sha}=context;
  const refuse=()=>{throw new Error('release caller event refused');};
  if(!['qualify-toolchain','receive-changes'].includes(mode)||repository!==binding.repository
    ||event?.repository?.full_name!==repository||event.repository.id!==binding.repositoryId
    ||!binding.events.includes(eventName)||ref!=='refs/heads/main'||!/^[a-f0-9]{40}$/.test(sha??'')||/^0+$/.test(sha)
    ||actor!==binding.actor||triggeringActor!==binding.actor||event.sender?.login!==binding.actor)refuse();
  if(eventName==='workflow_dispatch'){
    if(event.inputs?.mode!==mode||Object.keys(event.inputs).some(key=>key!=='mode'))refuse();
    return;
  }
  const number=event.issue?.number;
  if(eventName!=='issue_comment'||event.action!=='created'||event.comment?.user?.login!==binding.actor
    ||!Number.isSafeInteger(number)||number<1
    ||event.issue?.pull_request?.url!==`https://api.github.com/repos/${repository}/pulls/${number}`
    ||event.comment?.issue_url!==`https://api.github.com/repos/${repository}/issues/${number}`
    ||event.comment?.body!==`/release ${mode}`)refuse();
}

/** Exact equality is authoritative. GitHub expression equality is only an early filter. */
export function admitReleaseEvent(context,binding,mode){
  if(['qualify-toolchain','receive-changes'].includes(mode))return admitDiagnosticEvent(context,binding,mode);
  const {eventName,actor,triggeringActor,repository,event,ref,sha}=context;
  const refuse=()=>{throw new Error('release caller event refused');};
  const exact=value=>typeof value==='string'&&value.length===40&&/^[a-f0-9]{40}$/.test(value)&&!/^0+$/.test(value);
  if(![...binding.modes,'qualify-toolchain','receive-changes'].includes(mode))refuse();
  if(repository!==binding.repository||event?.repository?.full_name!==repository||event.repository.id!==binding.repositoryId
    ||!binding.events.includes(eventName))refuse();
  if(eventName==='workflow_dispatch'){
    if(actor!==binding.actor||triggeringActor!==binding.actor||event.sender?.login!==binding.actor
      ||event.inputs?.mode!==mode||Object.keys(event.inputs).some(key=>key!=='mode')||ref!=='refs/heads/main'||!exact(sha))refuse();
    return;
  }
  if(mode!=='build')refuse();
  if(eventName==='push'){
    if(ref!=='refs/heads/main'||event.ref!==ref||event.deleted!==false||event.after!==sha||!exact(sha))refuse();
    return;
  }
  const pull=event.pull_request,number=event.number;
  if(eventName!=='pull_request'||!['opened','synchronize','reopened'].includes(event.action)||actor!==binding.actor||triggeringActor!==binding.actor
    ||event.sender?.login!==binding.actor||pull?.user?.login!==binding.actor||!Number.isSafeInteger(number)||number<1||pull.number!==number
    ||pull.state!=='open'||pull.merged!==false||ref!==`refs/pull/${number}/merge`||!exact(sha)||!exact(pull.head?.sha)
    ||pull.base?.ref!=='main'||pull.base?.repo?.full_name!==repository||pull.base?.repo?.id!==binding.repositoryId
    ||pull.head?.repo?.full_name!==repository||pull.head?.repo?.id!==binding.repositoryId||pull.head?.repo?.fork!==false)refuse();
}
export function admitToolchainQualificationEvent(context,binding){admitDiagnosticEvent(context,binding,'qualify-toolchain');}
export function admitReviewedChangeEvent(context,binding){admitDiagnosticEvent(context,binding,'receive-changes');}

/** A diagnostic-only workflow carrier with a fixed reviewed base and branch. */
export function admitReviewedChangePullRequest(context,binding,projection){
  const {eventName,actor,triggeringActor,repository,ref,sha,event}=context;
  const {headRef,snapshotCommit}=projection;
  const refuse=()=>{throw new Error('reviewed change pull request refused');};
  const pull=event?.pull_request,number=event?.number,id=event?.repository?.id;
  if(!/^review\/[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(headRef??'')||headRef.length>160
    ||!/^[a-f0-9]{40}$/.test(snapshotCommit??'')||/^0+$/.test(snapshotCommit))refuse();
  if(eventName!=='pull_request'||!['opened','synchronize','reopened'].includes(event?.action)
    ||repository!==binding.repository||event.repository?.full_name!==repository||id!==binding.repositoryId||event.repository.default_branch!=='main'
    ||actor!==binding.actor||triggeringActor!==binding.actor||event.sender?.login!==binding.actor||pull?.user?.login!==binding.actor
    ||!Number.isSafeInteger(number)||number<1||pull.number!==number||pull.state!=='open'||pull.merged!==false
    ||ref!==`refs/pull/${number}/merge`||!/^[a-f0-9]{40}$/.test(sha??'')||/^0+$/.test(sha)
    ||pull.base?.ref!=='main'||pull.base?.sha!==snapshotCommit||pull.base?.repo?.full_name!==repository||pull.base?.repo?.id!==id
    ||pull.head?.ref!==headRef||pull.head?.repo?.full_name!==repository||pull.head?.repo?.id!==id||pull.head?.repo?.fork!==false
    ||!/^[a-f0-9]{40}$/.test(pull.head?.sha??'')||/^0+$/.test(pull.head.sha)||pull.head.sha===snapshotCommit||pull.head.sha===sha)refuse();
  return {head:pull.head.sha,base:snapshotCommit,merge:sha};
}

async function readWorkflowCarrierBytes(directory){
  const {readFileSync,lstatSync,realpathSync}=await import('node:fs');
  const {resolve,join}=await import('node:path');
  const {createHash}=await import('node:crypto');
  const refuse=()=>{throw new Error('trusted workflow carrier refused');};
  const root=resolve(directory);
  if(realpathSync(root)!==root)refuse();
  let file=root;
  for(const [index,part]of ['.github','workflows','release.yml'].entries()){
    file=join(file,part);const stat=lstatSync(file);
    if(stat.isSymbolicLink()||(index===2?!stat.isFile():!stat.isDirectory()))refuse();
  }
  const bytes=readFileSync(file),blob=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if(lstatSync(file).mode&0o111)refuse();
  return {root,blob};
}

export async function verifyReviewedChangePullRequestCarrier(directory,{head,base,merge},gitExecutable='git'){
  const {spawnSync}=await import('node:child_process');
  const refuse=()=>{throw new Error('reviewed change pull request carrier refused');};
  if([head,base,merge].some(value=>!/^[a-f0-9]{40}$/.test(value??'')||/^0+$/.test(value))||new Set([head,base,merge]).size!==3)refuse();
  const {root,blob}=await readWorkflowCarrierBytes(directory);
  const git=args=>{
    const result=spawnSync(gitExecutable,['-C',root,...args],{encoding:'utf8',timeout:15000,maxBuffer:4*1024*1024,env:{PATH:process.env.PATH??'',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_GRAFT_FILE:'/dev/null',GIT_NO_LAZY_FETCH:'1',GIT_ALLOW_PROTOCOL:''}});
    if(result.error||result.status!==0)refuse();return result.stdout;
  };
  const parents=commit=>git(['cat-file','-p',commit]).split('\n\n',1)[0].split('\n').filter(line=>line.startsWith('parent ')).map(line=>line.slice(7));
  if(git(['rev-parse','HEAD']).trim()!==head)refuse();
  git(['-c','core.commitGraph=false','merge-base','--is-ancestor',base,head]);
  if(JSON.stringify(parents(merge))!==JSON.stringify([base,head])
    ||git(['diff','--name-only','--no-renames','-z',base,head])!=='.github/workflows/release.yml\0')refuse();
  const entry=git(['ls-tree','-z',head,'--','.github/workflows/release.yml']);
  if(entry!==`100644 blob ${blob}\t.github/workflows/release.yml\0`)refuse();
  return {head,base,merge,workflowBlob:blob};
}

export async function verifyTrustedWorkflowCarrier(directory,{workflowSha,checkoutSha,gitExecutable}){
  const {spawnSync}=await import('node:child_process');
  const refuse=()=>{throw new Error('trusted workflow carrier refused');};
  if(!gitExecutable?.startsWith('/')||[workflowSha,checkoutSha].some(value=>!/^[a-f0-9]{40}$/.test(value??'')||/^0+$/.test(value)))refuse();
  const {root,blob}=await readWorkflowCarrierBytes(directory);
  const git=args=>{const result=spawnSync(gitExecutable,['-C',root,...args],{encoding:'utf8',timeout:15000,maxBuffer:4*1024*1024,
    env:{PATH:process.env.PATH??'',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_ALLOW_PROTOCOL:''}});
    if(result.error||result.status!==0)refuse();return result.stdout;};
  if(git(['rev-parse','--show-toplevel']).trim()!==root||git(['rev-parse','HEAD']).trim()!==checkoutSha
    ||git(['ls-tree','-z',workflowSha,'--','.github/workflows/release.yml'])!==`100644 blob ${blob}\t.github/workflows/release.yml\0`)refuse();
  return blob;
}


function fixedIdentity(identity,{machine=false,binding}={}){
  if(!keys(identity,['repository','commit','tree',...(machine?['definition']:[])])||!exact(identity.commit)||!exact(identity.tree)
    ||identity.repository!==(machine?binding.repository:controllerRepository)||machine&&identity.definition!==binding.definition)
    throw new Error('qualification requires fixed trusted source identities');
}
function projectionOptions(options){
  if(!keys(options,[],['pullRequestHeadRef']))throw new Error('unknown reviewed receiving projection option');
  if(options.pullRequestHeadRef!==undefined&&(!/^review\/[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(options.pullRequestHeadRef)
    ||options.pullRequestHeadRef.length>160))throw new Error('reviewed projection requires a fixed branch');
}
function diagnosticCondition(binding,mode,projection){
  const principal=`github.repository == '${binding.repository}' && github.event.repository.full_name == '${binding.repository}' && github.event.repository.id == ${binding.repositoryId} && github.actor == '${binding.actor}' && github.triggering_actor == '${binding.actor}'`;
  let condition=`(${principal} && github.event_name == 'workflow_dispatch' && inputs.mode == '${mode}')`;
  if(binding.events.includes('issue_comment'))condition+=` || (${principal} && github.event_name == 'issue_comment' && github.event.action == 'created' && github.event.issue.pull_request && github.event.comment.body == '/release ${mode}' && github.event.comment.user.login == '${binding.actor}')`;
  if(projection)condition+=` || (${principal} && github.event_name == 'pull_request' && contains(fromJSON('["opened","synchronize","reopened"]'), github.event.action) && github.event.pull_request.head.ref == '${projection.headRef}' && github.event.pull_request.base.sha == '${projection.snapshotCommit}')`;
  return condition;
}
const indent=lines=>{const rows=lines.flatMap(line=>String(line).split('\n'));if(rows.join('\n').length+1>21000)throw new Error(`generated run body exceeds the 21000-character owner limit: ${rows.join('\n').length+1}`);return rows.map(line=>line?'          '+line:'').join('\n');};
const context='eventName:env.GITHUB_EVENT_NAME,actor:env.GITHUB_ACTOR,triggeringActor:env.GITHUB_TRIGGERING_ACTOR,repository:env.GITHUB_REPOSITORY,ref:env.GITHUB_REF,sha:env.GITHUB_SHA,event:JSON.parse(eventBytes)';
const eventEnvironment='GITHUB_REF="$GITHUB_REF" GITHUB_SHA="$GITHUB_SHA" GITHUB_EVENT_NAME="$GITHUB_EVENT_NAME" GITHUB_ACTOR="$GITHUB_ACTOR" GITHUB_TRIGGERING_ACTOR="$GITHUB_TRIGGERING_ACTOR" GITHUB_REPOSITORY="$GITHUB_REPOSITORY" GITHUB_EVENT_PATH="$GITHUB_EVENT_PATH"';
const nodeFlags='--no-addons --no-global-search-paths';
const selectedTools=[
  'node="$(command -v node)"; guix="$HOME/.config/guix/current/bin/guix"',
  'if [ ! -x "$guix" ]; then guix="$(command -v guix)"; fi',
  '[ -x "$node" ] && [ -x "$guix" ]',
  'git_reader="$(command -v git)"; [[ "$git_reader" = /* ]] && [ -x "$git_reader" ]',
];
const lease=binding=>['mkdir -p "$HOME/.cache/561-group"',`exec 9>"$HOME/${binding.lease}"`,'flock --exclusive 9'];
function eventGate(binding,mode,projection){
  return [
    'event_digest="$(' ,
    `env -i ${eventEnvironment} RELEASE_MODE="${mode??'$RELEASE_MODE'}" NODE_DISABLE_COMPILE_CACHE=1 "$node" ${nodeFlags} --input-type=module - <<'QUALIFICATION_EVENT'`,
    'import {readFileSync} from "node:fs";','import {createHash} from "node:crypto";','const env=process.env,eventBytes=readFileSync(env.GITHUB_EVENT_PATH,"utf8");',admitDiagnosticEvent.toString(),...(mode?[]:[admitReleaseEvent.toString()]),
    ...(projection?[admitReviewedChangePullRequest.toString()]:[]),
    `const context={${context}};`,
    `const binding=${JSON.stringify(Object.fromEntries(['repository','repositoryId','actor','events',...(mode?[]:['modes'])].map(key=>[key,binding[key]])))};`,
    ...(projection?[`if(context.eventName==='pull_request')admitReviewedChangePullRequest(context,binding,${JSON.stringify(projection)});else admitDiagnosticEvent(context,binding,env.RELEASE_MODE);`]
      :[`${mode?'admitDiagnosticEvent':'admitReleaseEvent'}(context,binding,env.RELEASE_MODE);`]),
    projection?'process.stdout.write(createHash("sha256").update(eventBytes).digest("hex")+(context.eventName==="pull_request"?" "+context.event.pull_request.head.sha:""));':'process.stdout.write(createHash("sha256").update(eventBytes).digest("hex"));',
    'QUALIFICATION_EVENT',
    ')"',
    ...(projection?['pr_head="${event_digest#* }"; event_digest="${event_digest%% *}"']:[]),
  ];
}
function workflowGate(binding,projection){
  const fetch="git -c core.hooksPath=/dev/null -c credential.helper= -c 'credential.helper=!gh auth git-credential' fetch --no-tags";
  const reader=projection?'fetch_carrier --depth=1':fetch+' --depth=1 origin';
  return [
    ...(projection?[`fetch_carrier() { ${fetch} "$1" origin "$2"; }`]:[]),
    '[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ && "$GITHUB_WORKFLOW_SHA" =~ ^[0-9a-f]{40}$ ]]',
    'if ! git cat-file -e "$GITHUB_WORKFLOW_SHA^{commit}" 2>/dev/null; then',
    `  ${reader} "$GITHUB_WORKFLOW_SHA"`,
    'fi',
    ...(projection?[
      'if [ "$GITHUB_EVENT_NAME" = pull_request ] && [ "$(git rev-parse --is-shallow-repository)" = true ]; then',
      `  fetch_carrier --unshallow "$pr_head"`,
      'fi',
      'if [ "$GITHUB_EVENT_NAME" = pull_request ] && ! git cat-file -e "$GITHUB_SHA^{commit}" 2>/dev/null; then',
      `  ${reader} "$GITHUB_SHA"`,
      'fi',
    ]:[]),
    `env -i RECEIVING_GIT="$git_reader" PATH="$(dirname "$node"):/usr/bin:/bin" GITHUB_SHA="$GITHUB_SHA" GITHUB_EVENT_NAME="$GITHUB_EVENT_NAME" GITHUB_EVENT_PATH="$GITHUB_EVENT_PATH" GITHUB_WORKSPACE="$GITHUB_WORKSPACE" GITHUB_WORKFLOW_SHA="$GITHUB_WORKFLOW_SHA" EXPECTED_EVENT_SHA256="$event_digest" NODE_DISABLE_COMPILE_CACHE=1 "$node" ${nodeFlags} --input-type=module - <<'QUALIFICATION_WORKFLOW'`,
    'import {readFileSync} from "node:fs";','import {createHash} from "node:crypto";',
    'const env=process.env,eventBytes=readFileSync(env.GITHUB_EVENT_PATH,"utf8");',
    'if(createHash("sha256").update(eventBytes).digest("hex")!==env.EXPECTED_EVENT_SHA256)throw new Error("admitted event bytes changed");',
    readWorkflowCarrierBytes.toString(),verifyTrustedWorkflowCarrier.toString(),
    ...(projection?[verifyReviewedChangePullRequestCarrier.toString()]:[]),
    'const context={eventName:env.GITHUB_EVENT_NAME,sha:env.GITHUB_SHA,event:JSON.parse(eventBytes)};',
    'let checkoutSha=context.sha;',
    ...(projection?[`if(context.eventName==='pull_request'){const identity={head:context.event.pull_request.head.sha,base:'${projection.snapshotCommit}',merge:context.sha};await verifyReviewedChangePullRequestCarrier(env.GITHUB_WORKSPACE,identity,env.RECEIVING_GIT);checkoutSha=identity.head;}`]
      :["if(context.eventName==='pull_request')checkoutSha=context.event.pull_request.head.sha;"]),
    'await verifyTrustedWorkflowCarrier(env.GITHUB_WORKSPACE,{workflowSha:env.GITHUB_WORKFLOW_SHA,checkoutSha,gitExecutable:env.RECEIVING_GIT});',
    'QUALIFICATION_WORKFLOW',
  ];
}
function trustedSourceGate(binding,identities){
  return [
    `env -i RECEIVING_GIT="$git_reader" ${identities.map(({variable})=>`${variable.toUpperCase()}_DIRECTORY="$${variable}"`).join(' ')} PATH="$(dirname "$node"):/usr/bin:/bin" NODE_DISABLE_COMPILE_CACHE=1 "$node" ${nodeFlags} --input-type=module - <<'QUALIFICATION_SOURCE'`,
    trustedSourceVerifierSource(),'const env=process.env;',
    `const machineIdentity=${JSON.stringify({repository:binding.repository,definition:binding.definition})};`,
    `const options={gitExecutable:env.RECEIVING_GIT,channelsBlob:${JSON.stringify(binding.channelsBlob)}};`,
    ...identities.map(({variable,identity,controller=false})=>`await verifyTrustedSource(env.${variable.toUpperCase()}_DIRECTORY,${controller?JSON.stringify(identity):'{...machineIdentity,commit:'+JSON.stringify(identity.commit)+',tree:'+JSON.stringify(identity.tree)+'}'},${controller?'{...options,controller:true}':'options'});`),
    'QUALIFICATION_SOURCE',
  ];
}
function cloneFixed(variable,identity){return [
  `${variable}="$work_root/${variable}"`,
  `"\${source_git[@]}" clone -q --no-checkout https://github.com/${identity.repository}.git "$${variable}"`,
  `"\${source_git[@]}" -C "$${variable}" fetch -q origin ${identity.commit}`,
  `"\${source_git[@]}" -C "$${variable}" checkout -q --detach ${identity.commit}`,
];}
function ordinarySourceGate(binding){
  const read='env -i PATH="$(dirname "$git_reader"):/usr/bin:/bin" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1 GIT_ALLOW_PROTOCOL= "$git_reader" -C "$GITHUB_WORKSPACE"';
  return [
    `source_commit="$(${read} rev-parse HEAD)"`,
    `source_tree="$(${read} rev-parse "$source_commit^{tree}")"`,
    `verify_release_source "$GITHUB_WORKSPACE" '${binding.repository}' "$source_commit" "$source_tree" '${binding.definition}' machine '${binding.sourcePolicy}' '${binding.channelsBlob}'`,
  ];
}
function evidenceCleanup(){
  const files=['reviewed-request.json','change/reviewed-change-receiving.json','change/provider/candidate-toolchain-qualification.json',
    'results/candidate-toolchain-qualification.json',...['head','base'].flatMap(side=>[...['json','stdout','stderr'].map(stream=>`change/comparison/workspaces/${side}.prepare.${stream}`),`change/comparison/workspaces/${side}.publication.json`])];
  return [
    'cleanup_receiving() {',
    '  status=$?; set +e; copy_failed=0',
    '  if [ "$status" -ne 0 ]; then',
    '    saved="$(mktemp -d "$RUNNER_TEMP/change-receiving-evidence.XXXXXX")"',
    '    if [ -n "$saved" ]; then',
    '      for relative in '+files.map(file=>`"${file}"`).join(' ')+'; do',
    '        evidence="$work_root/$relative"',
    '        if [ -f "$evidence" ] && [ ! -L "$evidence" ]; then',
    '          dest="$saved/$relative"; mkdir -p "$(dirname "$dest")"',
    '          printf "Receiving evidence: %s\\n" "$relative"; cat -- "$evidence"',
    '          if cp -- "$evidence" "$dest"; then',
    '            (cd "$saved" && sha256sum "$relative") >> "$saved/SHA256SUMS" || copy_failed=1',
    '          else copy_failed=1; fi',
    '        fi',
    '      done',
    '      printf "Retained exact receiving evidence: %s\\n" "$saved" >&2',
    '    else copy_failed=1; fi',
    '  fi',
    '  if [ "$copy_failed" -eq 0 ]; then rm -rf -- "$work_root";',
    '  else',
    '    rm -rf -- "$work_root/controller" "$work_root/snapshot" "$work_root/candidate" "$work_root/change/baseline/source-carriers" "$work_root/change/candidate/source-carriers" "$work_root/change/raw-inputs/source-carriers" "$work_root/change/comparison/workspaces/head" "$work_root/change/comparison/workspaces/base" "$work_root/change/comparison/workspaces/source-graphs"',
    '    printf "Evidence copy incomplete; originals retained: %s\\n" "$work_root" >&2',
    '  fi',
    '  return "$status"',
    '}',
    'trap cleanup_receiving EXIT',
  ];
}
function diagnosticJob(binding,{snapshot,controller,candidateSnapshot,request},projection){
  const mode=request?'receive-changes':'qualify-toolchain',job=request?'change-receiving':'toolchain-qualification';
  const bytes=request?JSON.stringify(request)+'\n':null,digest=bytes?createHash('sha256').update(bytes).digest('hex'):null;
  const run=[
    'set -euo pipefail',
    ...selectedTools,...eventGate(binding,mode,projection),...workflowGate(binding,projection),
    ...(request?[
      `env -i RECEIVING_REQUEST="$RECEIVING_REQUEST" RECEIVING_REQUEST_SHA256="$RECEIVING_REQUEST_SHA256" "$node" ${nodeFlags} --input-type=module - <<'QUALIFICATION_REQUEST'`,
      'import {createHash} from "node:crypto";','const env=process.env;',
      'if(createHash("sha256").update(env.RECEIVING_REQUEST).digest("hex")!==env.RECEIVING_REQUEST_SHA256)throw new Error("reviewed request digest differs");',
      'QUALIFICATION_REQUEST',
    ]:[]),
    ...lease(binding),
    `work_root="$(mktemp -d "$RUNNER_TEMP/${job}.XXXXXX")"`,...evidenceCleanup(),
    releaseSourceReaderShell(),
    ...cloneFixed('controller',controller),...cloneFixed('snapshot',snapshot),
    ...(candidateSnapshot?cloneFixed('candidate',candidateSnapshot):[]),
    ...trustedSourceGate(binding,[{variable:'controller',identity:controller,controller:true},{variable:'snapshot',identity:snapshot},...(candidateSnapshot?[{variable:'candidate',identity:candidateSnapshot}]:[])]),
    'mkdir "$work_root/home" "$work_root/tmp" "$work_root/results"',
    'qualification_status=0',
  ];
  if(request)run.push(
    'request_file="$work_root/reviewed-request.json"',
    'printf \'%s\' "$RECEIVING_REQUEST" > "$request_file"','unset RECEIVING_REQUEST',
    `env -i HOME="$HOME" GH_CONFIG_DIR="\${GH_CONFIG_DIR:-$HOME/.config/gh}" LANG=C.UTF-8 LC_ALL=C.UTF-8 PATH="$(dirname "$guix"):$(dirname "$node"):/usr/bin:/bin" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1 NODE_DISABLE_COMPILE_CACHE=1 "$node" ${nodeFlags} "$controller/scripts/receive-pull-requests.mjs" "$snapshot" "$work_root/change" --exact "$request_file" "$RECEIVING_REQUEST_SHA256"${candidateSnapshot?' --candidate-root="$candidate"':''} || qualification_status=$?`,
  );
  else run.push(
    '# Existing runtimes only. The fixed diagnostic runs after all source checks.',
    'env -i HOME="$work_root/home" TMPDIR="$work_root/tmp" LANG=C.UTF-8 LC_ALL=C.UTF-8 PATH="$(dirname "$guix"):$(dirname "$node"):/usr/bin:/bin" "$guix" repl -- "$controller/test/pinned-guix-diagnostic.scm"',
    `env -i HOME="$work_root/home" TMPDIR="$work_root/tmp" LANG=C.UTF-8 LC_ALL=C.UTF-8 PATH="$(dirname "$guix"):$(dirname "$node"):/usr/bin:/bin" NODE_DISABLE_COMPILE_CACHE=1 "$node" ${nodeFlags} "$controller/scripts/qualify-candidate-toolchain.mjs" "$controller" "$snapshot/${binding.definition}" "$work_root/results" ${controller.commit} ${controller.tree} || qualification_status=$?`,
  );
  run.push('exit "$qualification_status"');
  return [
    `  ${job}:`,`    if: \${{ ${diagnosticCondition(binding,mode,projection)} }}`,
    `    runs-on: ${JSON.stringify(binding.runner)}`,`    timeout-minutes: ${request?90:20}`,
    '    permissions:','      contents: read','    steps:',`      - uses: ${checkout}`,
    '        with:','          persist-credentials: false',
    `          ref: \${{ ${projection?"github.event_name == 'pull_request' && github.event.pull_request.head.sha || ":''}github.sha }}`,
    ...(projection?['          fetch-depth: 2']:[]),
    `      - name: ${request?'Receive only the complete reviewed change request':'Qualify only the reviewed dependency provider'}`,
    ...(request?['        env:','          RECEIVING_REQUEST: |','            '+bytes.trimEnd(),`          RECEIVING_REQUEST_SHA256: ${digest}`]:[]),
    '        run: |',indent(run),'',
  ].join('\n');
}
function ordinaryJob(binding,excluded){
  const effects=binding.effects;
  const allowed=`(github.event_name == 'push'${binding.events.includes('pull_request')?" || github.event_name == 'pull_request'":''} || (github.event_name == 'workflow_dispatch' && contains(fromJSON('${JSON.stringify(binding.modes)}'), inputs.mode)))`;
  const selection="${{ github.event_name == 'workflow_dispatch' && inputs.mode || 'build' }}";
  const run=[
    'set -euo pipefail',...selectedTools,
    controllerBootstrap(undefined,{defer:true,...(binding.nativeController?{controller:binding.nativeController}:{})}),
    'verify_current_workflow() {',...workflowGate(binding),'}',
    'verify_current_source() {',...ordinarySourceGate(binding),'}',
    ...eventGate(binding,null),'verify_current_workflow',
    '# A diagnostic mode cannot select any ordinary release effect.',
    'case "$RELEASE_MODE" in',`  ${binding.modes.join('|')}) ;;`,"  *) printf '%s\\n' 'Ordinary release mode refused.' >&2; exit 1 ;;",'esac',
    ...(effects.deinitializeSubmodules?["git submodule status | awk '$1 !~ /^-/ {print $2}' | xargs -r git submodule deinit --force --"]:[]),
    'verify_current_source',
    ...(binding.nativeController?binding.nativeInputs.map(name=>`[ -n "\${${name}:-}" ] && [ -e "$${name}" ] || { echo 'Common native receiving input unavailable: ${name}.' >&2; exit 1; }`):[]),
    ...(binding.activationHeld?['# Explicit migration hold: build only; activation is not selected.']:[]),
    ...(effects.cpuWeight?[`systemctl --user set-property --runtime '${effects.cpuWeight.unit}' CPUWeight=${effects.cpuWeight.weight}`]:[]),
    ...lease(binding),
    ...(effects.queuedHeadCheck?[
      '# Preserve queued push/PR freshness checks under the existing shared compute lease.',
      'if [ "$GITHUB_EVENT_NAME" = push ]; then',
      "  git -c core.hooksPath=/dev/null -c credential.helper= -c 'credential.helper=!gh auth git-credential' fetch origin main",
      '  if [ "$(git rev-parse HEAD)" != "$(git rev-parse FETCH_HEAD)" ]; then echo "Snapshot superseded before build admission."; exit 0; fi',
      'fi',
      'if [ "$GITHUB_EVENT_NAME" = pull_request ]; then',
      '  release_pull_admission="$(gh api graphql -f query=\'query($o:String!,$n:String!,$x:Int!){repository(owner:$o,name:$n){pullRequest(number:$x){state headRefOid}}}\' -f o="${GITHUB_REPOSITORY%/*}" -f n="${GITHUB_REPOSITORY#*/}" -F x="$RELEASE_PULL_NUMBER" --jq \'(.data.repository.pullRequest.state|ascii_downcase) + " " + .data.repository.pullRequest.headRefOid\')"',
      '  if [ "$release_pull_admission" != "open $(git rev-parse HEAD)" ]; then echo "Preview closed or superseded before build admission."; exit 0; fi',
      'fi',
    ]:[]),
    'verify_current_workflow','verify_current_source',
    'export GITHUB_SHA="$(git rev-parse HEAD)"',
    `MACHINE_SOURCE_DIRECTORY='${binding.definition}'`,
    'cd "$GITHUB_WORKSPACE/$MACHINE_SOURCE_DIRECTORY"',
    'resolve_release_controller',
    ...(effects.prepareBuildSwap?['guix shell node -- node "$service/scripts/prepare-build-swap.mjs" machine.json']:[]),
    `work="$HOME/${binding.runDirectory}/$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"`,
    'guix repl -- "$service/scripts/pinned-guix.scm" channels.scm shell guile guile-json node -- \\',
    '  guile --no-auto-compile "$service/scripts/github-machine-release.scm" "$GITHUB_WORKSPACE/$MACHINE_SOURCE_DIRECTORY" "$work" "$RELEASE_MODE"'+(binding.nativeController?' "$GUIX_COMMON_SOFTWARE_RECEIPT" "$GUIX_COMMON_ASSEMBLY_RECEIPT" "$GUIX_COMMON_SOURCE_SNAPSHOT"':''),
  ];
  const outcome=[
    `work="$HOME/${binding.runDirectory}/$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"`,
    'if [ -n "${RELEASE_CONTROLLER:-}" ]; then',
    `  guix shell ${effects.rebuildOutcomeCache?'--rebuild-cache ':''}node -- node "$RELEASE_CONTROLLER/scripts/record-outcome.mjs" "$work"${binding.nativeController?' --native':''}`,
    'else',
    '  echo "Machine snapshot: \\`$GITHUB_SHA\\`; the release controller was not resolved, so no outcome was recorded." >> "$GITHUB_STEP_SUMMARY"',
    'fi',
  ];
  return [
    '  release:',`    if: \${{ ${excluded.length?'!('+excluded.join(' || ')+') && ':''}${allowed} }}`,
    `    runs-on: ${JSON.stringify(binding.runner)}`,'    timeout-minutes: 90',
    '    steps:',`      - uses: ${checkout}`,'        with:','          persist-credentials: false',
    "          ref: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
    '      - name: Build and receive the selected machine definition','        env:',
    '          NODE_OPTIONS: --max-old-space-size=768',`          RELEASE_MODE: ${selection}`,
    ...(binding.nativeController?binding.nativeInputs.map(name=>`          ${name}: \${{ vars.${name} }}`):[]),
    ...(binding.events.includes('pull_request')?['          RELEASE_PULL_NUMBER: ${{ github.event.pull_request.number }}']:[]),
    '        run: |',indent(run),
    '      - name: Record the outcome for repository readers','        if: always()','        env:','          JOB_OUTCOME: ${{ job.status }}',
    '        run: |',indent(outcome),'',
  ].join('\n');
}

/** Closed diagnostic components share the whole caller's admission and source gates.
 * A consumer still owns and must review the surrounding triggers, concurrency
 * and ordinary-job exclusions; this API does not interpret existing YAML.
 */
export function projectReleaseDiagnosticJobs(binding,diagnostics={}){
  releaseConsumerBinding(binding);
  if(!keys(diagnostics,[],['qualification','receiving','pullRequestHeadRef']))throw new Error('unknown release caller option');
  projectionOptions(diagnostics.pullRequestHeadRef===undefined?{}:{pullRequestHeadRef:diagnostics.pullRequestHeadRef});
  if(diagnostics.pullRequestHeadRef&&!diagnostics.receiving&&!diagnostics.qualification)throw new Error('diagnostic branch requires a fixed qualification or exact receiving request');
  if((diagnostics.qualification||diagnostics.receiving)&&!binding.channelsBlob)throw new Error('diagnostic requires reviewed channel source');
  const jobs={},conditions={},groups=[],modes=[];
  if(Object.hasOwn(diagnostics,'qualification')){
    const request=diagnostics.qualification;
    if(!keys(request,['snapshot','controller']))throw new Error('qualification requires fixed snapshot and controller');
    fixedIdentity(request.snapshot,{machine:true,binding});fixedIdentity(request.controller);
    const projection=diagnostics.pullRequestHeadRef&&!diagnostics.receiving?{headRef:diagnostics.pullRequestHeadRef,snapshotCommit:request.snapshot.commit}:undefined;
    const condition=diagnosticCondition(binding,'qualify-toolchain',projection);
    conditions['toolchain-qualification']=condition;groups.push(`(${condition}) && 'toolchain-qualification' || `);modes.push('qualify-toolchain');
    jobs['toolchain-qualification']=diagnosticJob(binding,request,projection);
  }
  if(Object.hasOwn(diagnostics,'receiving')){
    const request=reviewedChangeRequest(diagnostics.receiving);
    fixedIdentity(request.snapshot,{machine:true,binding});fixedIdentity(request.controller);
    if(request.candidateSnapshot)fixedIdentity(request.candidateSnapshot,{machine:true,binding});
    const projection=diagnostics.pullRequestHeadRef?{headRef:diagnostics.pullRequestHeadRef,snapshotCommit:request.snapshot.commit}:undefined;
    const condition=diagnosticCondition(binding,'receive-changes',projection);
    conditions['change-receiving']=condition;groups.push(`(${condition}) && 'change-receiving' || `);modes.push('receive-changes');
    jobs['change-receiving']=diagnosticJob(binding,{...request,request},projection);
  }
  return Object.freeze({jobs:Object.freeze(jobs),conditions:Object.freeze(conditions),
    concurrencySelectors:Object.freeze(groups),dispatchModes:Object.freeze(modes),
    requiresPullRequest:Boolean(diagnostics.pullRequestHeadRef)});
}

/** Read an actual committed consumer declaration before projecting components. */
export function projectCommittedReleaseDiagnosticJobs(file,diagnostics={}){
  const {binding,source}=readCommittedConsumerBinding(file);
  return Object.freeze({binding,source,...projectReleaseDiagnosticJobs(binding,diagnostics)});
}

/** Generate one complete current caller, rather than interpreting fragments of old YAML. */
export function projectReleaseCaller(binding,diagnostics={}){
  const projected=projectReleaseDiagnosticJobs(binding,diagnostics);
  const jobs=Object.values(projected.jobs),excluded=Object.values(projected.conditions),groups=projected.concurrencySelectors;
  const modes=[...binding.modes,...projected.dispatchModes];
  const pull=binding.events.includes('pull_request')||projected.requiresPullRequest;
  const header=[
    'name: GitHub Guix machine release','# Generated by guix-machine-release-service from a reviewed trusted consumer binding.',
    `# Consumer binding JSON: ${JSON.stringify(binding)}`,
    `# Consumer binding SHA256: ${createHash('sha256').update(JSON.stringify(binding)+'\n').digest('hex')}`,
    '# Generation and diagnostics do not grant activation.',
    'on:','  push:','    branches: [main]',
    ...(pull?['  pull_request:','    branches: [main]','    types: [opened, synchronize, reopened]']:[]),
    ...(binding.events.includes('issue_comment')?['  issue_comment:','    types: [created]']:[]),
    '  workflow_dispatch:','    inputs:','      mode:','        type: choice',`        options: [${modes.join(', ')}]`,'        default: build',
    'concurrency:',`  group: ${binding.concurrency}-\${{ ${groups.join('')}${pull?"github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || ":''}'production' }}`,
    '  cancel-in-progress: false','permissions:','  contents: read','jobs:',
  ];
  return Object.freeze({[workflowPath]:header.join('\n')+'\n'+jobs.join('')+ordinaryJob(binding,excluded)});
}
if(isCliEntry(import.meta.url)){
  const [bindingFile,diagnosticsFile,...extra]=process.argv.slice(2);
  if(!bindingFile||extra.length)throw new Error('usage: project-release-caller.mjs COMMITTED_CONSUMER_BINDING_JSON [FIXED_DIAGNOSTICS_JSON]');
  const read=file=>JSON.parse(readFileSync(file,'utf8'));
  process.stdout.write(JSON.stringify(projectCommittedReleaseCaller(bindingFile,diagnosticsFile?read(diagnosticsFile):{}),null,2)+'\n');
}
