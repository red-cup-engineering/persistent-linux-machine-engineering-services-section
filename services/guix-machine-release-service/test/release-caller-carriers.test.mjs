import test from 'node:test';
import {verifyCommittedSource} from '../scripts/verify-release-source.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,cpSync,symlinkSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {projectReleaseCaller,admitReviewedChangeEvent,admitReviewedChangePullRequest,verifyReviewedChangePullRequestCarrier,verifyTrustedSource,verifyTrustedWorkflowCarrier} from '../scripts/project-release-caller.mjs';
const bindings=JSON.parse(readFileSync(new URL('./fixtures/release-consumer-bindings.json',import.meta.url)));
const binding=bindings['cold-red-gate'];
const hash=n=>String(n).repeat(40),controllerRepository='red-cup-engineering/guix-machine-release-service';
const identity=(repository,n)=>({repository,commit:hash(n),tree:hash(n+1)});
const request=()=>({kind:'guix.reviewed-change-request.v2',controller:identity(controllerRepository,1),snapshot:{...identity(binding.repository,3),definition:binding.definition},changes:[identity(controllerRepository,1),identity('coesite-operations/operations-services-section',5)]});
const project=(r=request(),options={pullRequestHeadRef:prBinding.headRef})=>projectReleaseCaller(binding,{receiving:r,...options})['.github/workflows/release.yml'];
function root(t){const path=mkdtempSync(join(tmpdir(),'exact-caller-'));t.after(()=>rmSync(path,{recursive:true,force:true}));return path;}
const realGit=execFileSync('sh',['-c','command -v git'],{encoding:'utf8'}).trim();
const receivingJob=out=>out.slice(out.indexOf('  change-receiving:\n'),out.indexOf('  release:\n'));
const shell=job=>job.slice(job.indexOf('        run: |\n')+'        run: |\n'.length).split('\n').map(line=>line.replace(/^          /u,'')).join('\n');
function gates(out,name='change-receiving'){const source=shell(out.slice(out.indexOf('  '+name+':\n'),out.indexOf('  release:\n'))),start=source.indexOf('event_digest='),end=source.indexOf('\nQUALIFICATION_WORKFLOW',start)+'\nQUALIFICATION_WORKFLOW'.length;assert.ok(end>start);return 'set -euo pipefail\n'+source.slice(start,end)+'\nprintf "identity-admitted\\n"\n';}

const prBinding={headRef:'review/guix-exact-receiving-20261011',snapshotCommit:hash(3)};
function prEvent(){
  const repository=binding.repository,repo={full_name:repository,id:binding.repositoryId,fork:false};
  return {eventName:'pull_request',actor:'emsenn',triggeringActor:'emsenn',repository,ref:'refs/pull/12/merge',sha:hash(8),event:{
    action:'opened',number:12,repository:{...repo,default_branch:'main'},sender:{login:'emsenn'},
    pull_request:{number:12,state:'open',merged:false,user:{login:'emsenn'},head:{repo:{...repo},ref:prBinding.headRef,sha:hash(7)},base:{repo:{...repo},ref:'main',sha:prBinding.snapshotCommit}},
  }};
}
test('opt-in PR receiving admits only exact bounded event and fixed branch identities',()=>{
  const good=prEvent();
  for(const action of ['opened','synchronize','reopened'])assert.deepEqual(admitReviewedChangePullRequest({...good,event:{...good.event,action}},binding,prBinding),{head:hash(7),base:hash(3),merge:hash(8)});
  // The potentially stale payload merge_commit_sha is not the runner merge identity.
  assert.doesNotThrow(()=>admitReviewedChangePullRequest({...good,event:{...good.event,pull_request:{...good.event.pull_request,merge_commit_sha:null}}},binding,prBinding));
  assert.throws(()=>admitReviewedChangeEvent(good,binding),/refused/);
  const changes=[
    x=>x.eventName='push',x=>x.eventName='pull_request_target',x=>x.eventName='merge_group',x=>x.event.action='closed',x=>x.event.action='edited',
    x=>x.actor='other',x=>x.triggeringActor='other',x=>x.event.sender.login='other',x=>x.event.pull_request.user.login='other',
    x=>x.actor='Emsenn',x=>x.triggeringActor='EMSENN',x=>x.event.sender.login='EMSENN',x=>x.event.pull_request.user.login='EMSENN',
    x=>x.repository='other/machine',x=>x.event.repository.full_name='EMSENN/cold-red-gate',x=>x.event.repository.default_branch='other',x=>x.event.repository.id=0,
    x=>x.event.number=0,x=>x.event.number=1.5,x=>x.event.pull_request.number=13,x=>x.event.pull_request.state='closed',x=>x.event.pull_request.merged=true,
    x=>x.ref='refs/heads/main',x=>x.ref='refs/pull/13/merge',x=>x.sha='main',x=>x.sha=hash(0),x=>x.sha=x.event.pull_request.head.sha,
    x=>x.event.pull_request.base.ref='other',x=>x.event.pull_request.base.sha=hash(9),x=>x.event.pull_request.base.repo.full_name='other/machine',x=>x.event.pull_request.base.repo.id=456,
    x=>x.event.pull_request.head.ref='review/other',x=>x.event.pull_request.head.repo.full_name='other/machine',x=>x.event.pull_request.head.repo.id=456,x=>x.event.pull_request.head.repo.fork=true,
    x=>x.event.pull_request.head.sha='main',x=>x.event.pull_request.head.sha=hash(0),x=>x.event.pull_request.head.sha=prBinding.snapshotCommit,
  ];
  for(const mutate of changes){const bad=structuredClone(good);mutate(bad);assert.throws(()=>admitReviewedChangePullRequest(bad,binding,prBinding),/refused/);}
});


function prCarrier(t){
  const path=root(t),repo=join(path,'source');mkdirSync(repo);
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:path,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}}).trim();
  git('init','-q');mkdirSync(join(repo,'.github/workflows'),{recursive:true});writeFileSync(join(repo,'.github/workflows/release.yml'),'original\n');writeFileSync(join(repo,'machine.json'),'frozen source\n');writeFileSync(join(repo,'dependencies.lock.yaml'),'frozen lock\n');
  git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD');
  writeFileSync(join(repo,'.github/workflows/release.yml'),'diagnostic\n');git('add','.');git('commit','-qm','head');const head=git('rev-parse','HEAD');
  const merge=git('commit-tree',git('rev-parse','HEAD^{tree}'),'-p',base,'-p',head,'-m','synthetic merge');
  return {path,repo,git,identity:{base,head,merge},renew(){git('add','-A');git('commit','--amend','--no-edit','-q');this.identity.head=git('rev-parse','HEAD');this.identity.merge=git('commit-tree',git('rev-parse','HEAD^{tree}'),'-p',base,'-p',this.identity.head,'-m','synthetic merge');}};
}
test('genuine Git carrier binds event head, fixed-base ancestry and synthetic merge parents',async t=>{
  const f=prCarrier(t),result=await verifyReviewedChangePullRequestCarrier(f.repo,f.identity);
  assert.deepEqual({...result,workflowBlob:undefined},{...f.identity,workflowBlob:undefined});
  for(const identity of [{...f.identity,head:f.identity.merge},{...f.identity,base:hash(1)},{...f.identity,merge:f.identity.head},{...f.identity,head:'main'}])
    await assert.rejects(verifyReviewedChangePullRequestCarrier(f.repo,identity),/refused/);
  for(const parents of [[f.identity.head,f.identity.base],[f.identity.base],[f.identity.base,f.identity.head,f.identity.merge]]){
    const merge=f.git('commit-tree',f.git('rev-parse','HEAD^{tree}'),...parents.flatMap(p=>['-p',p]),'-m','wrong merge');
    await assert.rejects(verifyReviewedChangePullRequestCarrier(f.repo,{...f.identity,merge}),/refused/);
  }
});

test('raw parent evidence works with a genuine shallow synthetic merge object',async t=>{
  const f=prCarrier(t);f.git('branch','synthetic',f.identity.merge);
  const clone=join(f.path,'shallow');execFileSync('git',['clone','-q','--depth=1','--branch=synthetic','file://'+f.repo,clone]);
  const git=(...args)=>execFileSync('git',['-C',clone,...args],{encoding:'utf8'}).trim();
  assert.equal(git('rev-list','--parents','-n1','HEAD'),f.identity.merge);
  git('fetch','-q','--depth=2','origin',f.identity.head);git('checkout','-q','--detach',f.identity.head);
  assert.equal((await verifyReviewedChangePullRequestCarrier(clone,f.identity)).head,f.identity.head);
});

function advanceCarrier(f,text='next diagnostic'){
  writeFileSync(join(f.repo,'.github/workflows/release.yml'),text+'\n');f.git('add','.');f.git('commit','-qm','append reviewed workflow');
  f.identity.head=f.git('rev-parse','HEAD');f.identity.merge=f.git('commit-tree',f.git('rev-parse','HEAD^{tree}'),'-p',f.identity.base,'-p',f.identity.head,'-m','synthetic merge');
}
test('workflow-only carrier retains multiple appended commits and superseded intermediate source',async t=>{
  const f=prCarrier(t);writeFileSync(join(f.repo,'intermediate'),'superseded');advanceCarrier(f);
  rmSync(join(f.repo,'intermediate'));advanceCarrier(f,'final diagnostic');
  assert.equal((await verifyReviewedChangePullRequestCarrier(f.repo,f.identity)).head,f.identity.head);
});
test('workflow-only carrier permits merged ancestry with the fixed base as an ancestor',async t=>{
  const f=prCarrier(t),head=f.identity.head,tree=f.git('rev-parse','HEAD^{tree}');
  const side=f.git('commit-tree',tree,'-p',f.identity.base,'-m','side reviewed workflow');
  const combined=f.git('commit-tree',tree,'-p',head,'-p',side,'-m','merged reviewed workflow');
  f.git('checkout','-q','--detach',combined);f.identity.head=combined;f.identity.merge=f.git('commit-tree',tree,'-p',f.identity.base,'-p',combined,'-m','synthetic merge');
  assert.equal((await verifyReviewedChangePullRequestCarrier(f.repo,f.identity)).head,combined);
});
for(const spoof of ['none','graft','replace'])test('unrelated fixed base refuses despite '+spoof+' ancestry',async t=>{
  const f=prCarrier(t),unrelated=f.git('commit-tree',f.git('rev-parse',f.identity.base+'^{tree}'),'-m','unrelated root');
  const identity={...f.identity,base:unrelated,merge:f.git('commit-tree',f.git('rev-parse','HEAD^{tree}'),'-p',unrelated,'-p',f.identity.head,'-m','synthetic merge')};
  if(spoof==='graft'){mkdirSync(join(f.repo,'.git/info'),{recursive:true});writeFileSync(join(f.repo,'.git/info/grafts'),f.identity.head+' '+unrelated+'\n');}
  if(spoof==='replace'){const counterfeit=f.git('commit-tree',f.git('rev-parse','HEAD^{tree}'),'-p',unrelated,'-m','false ancestry');f.git('replace',f.identity.head,counterfeit);}
  if(spoof!=='none')assert.equal(f.git('merge-base','--is-ancestor',unrelated,f.identity.head),'','fixture demonstrates the local false-ancestry shortcut');
  await assert.rejects(verifyReviewedChangePullRequestCarrier(f.repo,identity),/refused/);
});
test('shallow carrier with both endpoints but incomplete ancestry refuses offline',async t=>{
  const f=prCarrier(t);advanceCarrier(f);advanceCarrier(f,'third diagnostic');f.git('branch','carrier-head',f.identity.head);
  const clone=join(f.path,'incomplete');execFileSync(realGit,['clone','-q','--depth=2','--branch=carrier-head','file://'+f.repo,clone]);
  for(const sha of [f.identity.base,f.identity.merge])execFileSync(realGit,['-C',clone,'fetch','-q','--depth=1','origin',sha]);
  assert.equal(execFileSync(realGit,['-C',clone,'cat-file','-t',f.identity.base],{encoding:'utf8'}).trim(),'commit');
  await assert.rejects(verifyReviewedChangePullRequestCarrier(clone,f.identity),/refused/);
});

for(const kind of ['source','lock','added','deleted','renamed','symlink-other','workflow-mode','workflow-symlink'])test(`PR carrier refuses complete-tree ${kind} change`,async t=>{
  const f=prCarrier(t);
  if(kind==='source')writeFileSync(join(f.repo,'machine.json'),'changed');
  else if(kind==='lock')writeFileSync(join(f.repo,'dependencies.lock.yaml'),'changed');
  else if(kind==='added')writeFileSync(join(f.repo,'extra'),'extra');
  else if(kind==='deleted')rmSync(join(f.repo,'machine.json'));
  else if(kind==='renamed')f.git('mv','machine.json','renamed.json');
  else if(kind==='symlink-other')symlinkSync('machine.json',join(f.repo,'other'));
  else if(kind==='workflow-mode')chmodSync(join(f.repo,'.github/workflows/release.yml'),0o755);
  else if(kind==='workflow-symlink'){rmSync(join(f.repo,'.github/workflows/release.yml'));symlinkSync('../../machine.json',join(f.repo,'.github/workflows/release.yml'));}
  f.renew();
  await assert.rejects(verifyReviewedChangePullRequestCarrier(f.repo,f.identity),/refused/);
});

for(const relative of ['.','.github','.github/workflows','.github/workflows/release.yml'])test(`working PR carrier symlink ${relative} refuses`,async t=>{
  const f=prCarrier(t),target=relative==='.'?f.repo:join(f.repo,relative),outside=join(f.path,'outside');
  cpSync(target,outside,{recursive:true});rmSync(target,{recursive:true});symlinkSync(outside,target);
  await assert.rejects(verifyReviewedChangePullRequestCarrier(f.repo,f.identity),/refused/);
});
test('dirty working workflow refuses even when its index hides the mutation',async t=>{
  const f=prCarrier(t);f.git('update-index','--assume-unchanged','.github/workflows/release.yml');writeFileSync(join(f.repo,'.github/workflows/release.yml'),'dirty');
  await assert.rejects(verifyReviewedChangePullRequestCarrier(f.repo,f.identity),/refused/);
});
test('actual generated PR event gate refuses before all source and lease effects',t=>{
  const job=receivingJob(project()),source=shell(job),start=source.indexOf('event_digest='),end=source.indexOf('\nQUALIFICATION_EVENT',start)+'\nQUALIFICATION_EVENT'.length+3;
  const gate=source.slice(start,end),path=root(t),eventPath=join(path,'event.json');
  assert.ok(source.indexOf('QUALIFICATION_EVENT')<source.indexOf('fetch --no-tags'));
  assert.ok(source.indexOf('QUALIFICATION_WORKFLOW')<source.indexOf('flock --exclusive'));
  for(const [bad,eventName]of [[false,'pull_request'],[true,'pull_request'],[false,'push'],[false,'pull_request_target']]){
    const value=prEvent();if(bad)value.event.sender.login='EMSENN';writeFileSync(eventPath,JSON.stringify(value.event));
    const result=spawnSync('bash',['-c',gate],{env:{PATH:process.env.PATH,node:process.execPath,GITHUB_EVENT_NAME:eventName,GITHUB_ACTOR:value.actor,GITHUB_TRIGGERING_ACTOR:value.triggeringActor,GITHUB_REPOSITORY:value.repository,GITHUB_REF:value.ref,GITHUB_SHA:value.sha,GITHUB_EVENT_PATH:eventPath},encoding:'utf8'});
    assert.equal(result.status===0,!bad&&eventName==='pull_request',result.stderr);
  }
});
function eventEnvironment(f,workflowSource=f.identity.merge){
  const value=prEvent();value.sha=f.identity.merge;value.event.pull_request.head.sha=f.identity.head;value.event.pull_request.base.sha=f.identity.base;
  const eventPath=join(f.path,'event.json');writeFileSync(eventPath,JSON.stringify(value.event));
  return {PATH:process.env.PATH,HOME:f.path,node:process.execPath,git_reader:realGit,GIT_ALLOW_PROTOCOL:'file',GITHUB_EVENT_NAME:value.eventName,GITHUB_ACTOR:value.actor,GITHUB_TRIGGERING_ACTOR:value.triggeringActor,GITHUB_REPOSITORY:value.repository,GITHUB_REF:value.ref,GITHUB_SHA:value.sha,GITHUB_EVENT_PATH:eventPath,GITHUB_WORKSPACE:f.repo,GITHUB_WORKFLOW_SHA:workflowSource};
}
function fixtureWorkflow(f){const r=request();r.snapshot.commit=f.identity.base;r.snapshot.tree=f.git('rev-parse',f.identity.base+'^{tree}');return project(r);}

test('actual serialized carrier and workflow gates execute without source acquisition',t=>{
  const f=prCarrier(t),workflow=fixtureWorkflow(f),job=receivingJob(workflow),script=gates(workflow);
  for(const fn of [admitReviewedChangePullRequest,verifyReviewedChangePullRequestCarrier,verifyTrustedWorkflowCarrier])assert.ok(job.includes(fn.toString().split('\n').map(line=>'          '+line).join('\n')));
  assert.equal(spawnSync('bash',['-n'],{input:script,encoding:'utf8'}).status,0);
  const env=eventEnvironment(f),run=overrides=>spawnSync('bash',['-s'],{cwd:f.repo,env:{...env,...overrides},input:script,encoding:'utf8',timeout:15000});
  const good=run({});assert.equal(good.status,0,good.stderr);assert.equal(good.stdout,'identity-admitted\n');
  assert.equal(run({GITHUB_WORKFLOW_SHA:f.identity.head}).status,0);
  for(const change of [{GITHUB_WORKFLOW_SHA:f.identity.base},{GITHUB_SHA:f.identity.head},{GITHUB_REF:'refs/heads/main'},{GITHUB_ACTOR:'EMSENN'},{GITHUB_EVENT_NAME:'push'},{GITHUB_WORKFLOW_SHA:'main'}]){
    const bad=run(change);assert.notEqual(bad.status,0);assert.equal(bad.stdout,'');
  }
  writeFileSync(join(f.repo,'.github/workflows/release.yml'),'dirty');const dirty=run({});assert.notEqual(dirty.status,0);assert.equal(dirty.stdout,'');
});

test('isolated carrier gate uses the selected absolute Git, without reader credential context',t=>{
  const f=prCarrier(t),module=new URL('../scripts/project-release-caller.mjs',import.meta.url).href;
  for(const explicit of [false,true]){
    const code=`import {verifyReviewedChangePullRequestCarrier as verify} from ${JSON.stringify(module)}; await verify(${JSON.stringify(f.repo)},${JSON.stringify(f.identity)}${explicit?','+JSON.stringify(realGit):''});`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',code],{env:{PATH:'',HOME:f.path},encoding:'utf8'});
    assert.equal(result.status===0,explicit,result.stderr);
  }
  const workflow=project();assert.ok(workflow.includes('git_reader="$(command -v git)"'));
  const isolated=workflow.split('\n').find(line=>line.includes('env -i RECEIVING_GIT='));
  assert.doesNotMatch(isolated,/GH_TOKEN|GITHUB_TOKEN|GH_CONFIG_DIR|credential.helper/);
});

test('missing workflow and synthetic merge use only fixed event identities and per-command reader',t=>{
  const f=prCarrier(t);f.git('branch','carrier-head',f.identity.head);f.git('branch','synthetic-merge',f.identity.merge);
  const workflowSource=f.git('commit-tree',f.git('rev-parse','HEAD^{tree}'),'-p',f.identity.head,'-m','separate workflow source');f.git('branch','workflow-source',workflowSource);
  const script=gates(fixtureWorkflow(f));
  const trusted="git -c core.hooksPath=/dev/null -c credential.helper= -c 'credential.helper=!gh auth git-credential' fetch --no-tags";
  assert.equal(script.split(trusted).length-1,1);assert.ok(script.indexOf('if(context.eventName')<script.indexOf(trusted));
  const bin=join(f.path,'bin'),calls=join(f.path,'fetch-calls');mkdirSync(bin);
  const prefix=['-c','core.hooksPath=/dev/null','-c','credential.helper=','-c','credential.helper=!gh auth git-credential','fetch','--no-tags','--depth=1','origin'];
  const ancestryPrefix=prefix.map(value=>value==='--depth=1'?'--unshallow':value);
  const wrapper=`#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const {appendFileSync}=require('node:fs');const args=process.argv.slice(2);if(args.includes('fetch')){const prefix=${JSON.stringify(prefix)};const ancestryPrefix=${JSON.stringify(ancestryPrefix)};if(!((JSON.stringify(args.slice(0,-1))===JSON.stringify(prefix)&&${JSON.stringify([workflowSource,f.identity.merge])}.includes(args.at(-1)))||(JSON.stringify(args.slice(0,-1))===JSON.stringify(ancestryPrefix)&&args.at(-1)===${JSON.stringify(f.identity.head)}))){process.stderr.write('trusted-source-reader-required\\n');process.exit(99);}appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');}const result=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(result.status??1);\n`;
  writeFileSync(join(bin,'git'),wrapper,{mode:0o755});
  for(const [name,source,expected,extra]of [['wrong-event',script,false,{GITHUB_EVENT_NAME:'push'}],['wrong-merge-sha',script,false,{GITHUB_SHA:'not-a-sha'}],['wrong-workflow-sha',script,false,{GITHUB_WORKFLOW_SHA:'not-a-sha'}],['missing-helper',script.replaceAll(trusted,'git fetch --no-tags'),false,{}],['trusted-reader',script,true,{}]]){
    const clone=join(f.path,name);execFileSync(realGit,['clone','-q','--single-branch','--depth=2','--branch=carrier-head','file://'+f.repo,clone]);
    for(const commit of [workflowSource,f.identity.merge])assert.notEqual(spawnSync(realGit,['-C',clone,'cat-file','-e',commit],{encoding:'utf8'}).status,0);
    writeFileSync(calls,'');const env={...eventEnvironment(f,workflowSource),PATH:bin+':'+process.env.PATH,GITHUB_WORKSPACE:clone};
    const result=spawnSync('bash',['-s'],{cwd:clone,env:{...env,...extra},input:source,encoding:'utf8',timeout:15000});
    assert.equal(result.status===0,expected,result.stderr);
    if(expected){assert.equal(result.stdout,'identity-admitted\n');assert.deepEqual(readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse).map(x=>x.at(-1)),[workflowSource,f.identity.head,f.identity.merge]);}
    else{if(name==='missing-helper')assert.match(result.stderr,/trusted-source-reader-required/);assert.equal(result.stdout,'');assert.equal(readFileSync(calls,'utf8'),'');}
  }
});

test('generated PR gate acquires only admitted immutable head ancestry and rechecks event bytes',t=>{
  const f=prCarrier(t);advanceCarrier(f);advanceCarrier(f,'third diagnostic');f.git('branch','carrier-head',f.identity.head);
  const script=gates(fixtureWorkflow(f)),bin=join(f.path,'ancestry-bin'),calls=join(f.path,'ancestry-calls');mkdirSync(bin);
  const eventPath=join(f.path,'event.json'),prefix=['-c','core.hooksPath=/dev/null','-c','credential.helper=','-c','credential.helper=!gh auth git-credential','fetch','--no-tags','--unshallow','origin',f.identity.head];
  const wrapper=`#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const {appendFileSync,readFileSync,writeFileSync}=require('node:fs');const args=process.argv.slice(2);if(args.includes('fetch')){if(JSON.stringify(args)!==JSON.stringify(${JSON.stringify(prefix)})){process.stderr.write('wrong-ancestry-reader\\n');process.exit(99);}appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');if(process.env.OMIT_HISTORY==='1')process.exit(0);}const result=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});if(args.includes('fetch')&&process.env.CHANGE_EVENT==='1'){const file=${JSON.stringify(eventPath)},event=JSON.parse(readFileSync(file));event.sender.login='changed';writeFileSync(file,JSON.stringify(event));}process.exit(result.status??1);\n`;
  writeFileSync(join(bin,'git'),wrapper,{mode:0o755});
  for(const [name,expected,flags]of [['complete',true,{}],['incomplete',false,{OMIT_HISTORY:'1'}],['changed-event',false,{CHANGE_EVENT:'1'}],['wrong-actor',false,{GITHUB_ACTOR:'other'}]]){
    const clone=join(f.path,name);execFileSync(realGit,['clone','-q','--depth=2','--branch=carrier-head','file://'+f.repo,clone]);
    for(const sha of [f.identity.base,f.identity.merge])execFileSync(realGit,['-C',clone,'fetch','-q','--depth=1','origin',sha]);
    writeFileSync(calls,'');const env={...eventEnvironment(f),PATH:bin+':'+process.env.PATH,GITHUB_WORKSPACE:clone,...flags};
    const result=spawnSync('bash',['-s'],{cwd:clone,env,input:script,encoding:'utf8',timeout:15000});
    assert.equal(result.status===0,expected,result.stderr);assert.equal(result.stdout,expected?'identity-admitted\n':'');
    const recorded=readFileSync(calls,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);assert.deepEqual(recorded,name==='wrong-actor'?[]:[prefix]);
    if(name==='changed-event')assert.match(result.stderr,/admitted event bytes changed/);
    if(name==='incomplete')assert.match(result.stderr,/carrier refused/);
  }
});

function sourceCarrier(t,{controller=false,definition='machines/unit'}={}){
  const path=root(t),repo=join(path,'source');mkdirSync(repo);
  const git=(...args)=>execFileSync(realGit,['-C',repo,...args],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:path,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}}).trim();
  git('init','-q');const channelBytes=Buffer.from('(inert reviewed channels)\n'),channelsBlob=createHash('sha1').update(`blob ${channelBytes.length}\0`).update(channelBytes).digest('hex');
  if(controller)writeFileSync(join(repo,'package.json'),JSON.stringify({name:'@red-cup-engineering/guix-machine-release-service'}));
  else{
    mkdirSync(join(repo,definition),{recursive:true});writeFileSync(join(repo,definition,'machine.json'),JSON.stringify({repository:binding.repository,run:{entries:['@fixture/app']}}));
    writeFileSync(join(repo,definition,'machine.scm'),'(inert machine)\n');writeFileSync(join(repo,definition,'channels.scm'),channelBytes);writeFileSync(join(repo,definition,'dependencies.lock.yaml'),'lockfileVersion: 9\n');
    writeFileSync(join(repo,'.gitmodules'),'[submodule "source"]\n\tpath = source\n\turl = https://github.com/fixture/source.git\n');
    git('update-index','--add','--cacheinfo',`160000,${hash(5)},source`);
  }
  writeFileSync(join(repo,'owned.txt'),'committed source\n');git('add','.');git('commit','-qm','exact source');
  return {path,repo,git,identity:{repository:controller?controllerRepository:binding.repository,commit:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),...(!controller?{definition}:{})},options:{gitExecutable:realGit,channelsBlob,controller}};
}

test('trusted source reader binds a genuine root, nested definition, complete bytes and inert gitlinks',async t=>{
  const f=sourceCarrier(t);mkdirSync(join(f.repo,'retired','empty-mount'),{recursive:true});
  assert.equal(await verifyTrustedSource(f.repo,f.identity,f.options),f.repo,'empty retired mount directories contain no untracked source');
  await assert.rejects(verifyTrustedSource(join(f.repo,f.identity.definition),f.identity,f.options),/refused/);
  for(const amend of [x=>x.commit=hash(1),x=>x.tree=hash(2),x=>x.repository='other/machine',x=>x.definition='.',x=>x.definition='../escape',x=>x.definition='machines/./unit']){
    const identity=structuredClone(f.identity);amend(identity);await assert.rejects(verifyTrustedSource(f.repo,identity,f.options));
  }
  await assert.rejects(verifyTrustedSource(f.repo,f.identity,{...f.options,channelsBlob:hash(1)}),/refused/);
});
for(const kind of ['hidden-blob','hidden-mode','untracked','ignored','symlink','ancestor-symlink','missing-definition','dirty-channels','gitlink-controller'])test('trusted authority refuses '+kind+' before executing selected code',async t=>{
  const f=sourceCarrier(t,{controller:kind==='gitlink-controller'});
  if(kind==='hidden-blob'||kind==='hidden-mode'){
    f.git('update-index','--assume-unchanged','owned.txt');
    if(kind==='hidden-blob')writeFileSync(join(f.repo,'owned.txt'),'concealed change');else chmodSync(join(f.repo,'owned.txt'),0o755);
  }else if(kind==='untracked')writeFileSync(join(f.repo,'untracked'),'extra');
  else if(kind==='ignored'){writeFileSync(join(f.repo,'.git/info/exclude'),'ignored\n');writeFileSync(join(f.repo,'ignored'),'extra');}
  else if(kind==='symlink'){rmSync(join(f.repo,'owned.txt'));symlinkSync('../outside',join(f.repo,'owned.txt'));}
  else if(kind==='ancestor-symlink'){const target=join(f.repo,'machines'),outside=join(f.path,'outside');cpSync(target,outside,{recursive:true});rmSync(target,{recursive:true});symlinkSync(outside,target);}
  else if(kind==='missing-definition')rmSync(join(f.repo,f.identity.definition,'machine.json'));
  else if(kind==='dirty-channels')writeFileSync(join(f.repo,f.identity.definition,'channels.scm'),'other');
  else{f.git('update-index','--add','--cacheinfo',`160000,${hash(5)},source`);f.git('commit','-qm','unsupported executable carrier');f.identity.commit=f.git('rev-parse','HEAD');f.identity.tree=f.git('rev-parse','HEAD^{tree}');}
  await assert.rejects(verifyTrustedSource(f.repo,f.identity,f.options));
});

test('CRG conservative pre-bootstrap policy refuses actual committed current declarations only one way',async t=>{
  for(const relative of ['.gitmodules','machine.json','dependencies.lock.yaml']){
    const f=sourceCarrier(t),options={...f.options,sourcePolicy:'refuse-declared-sql-before-bootstrap-v1'};
    assert.equal(await verifyTrustedSource(f.repo,f.identity,options),f.repo);
    const file=join(f.repo,relative==='.gitmodules'?relative:f.identity.definition+'/'+relative);
    if(relative==='.gitmodules')writeFileSync(file,readFileSync(file,'utf8').replace('fixture/source','fixture/sqlite-provider'));
    else if(relative==='machine.json')writeFileSync(file,JSON.stringify({repository:binding.repository,run:{entries:['@fixture/sql.js']}}));
    else writeFileSync(file,'lockfileVersion: 9\npackages:\n  "@libsql/client": {}\n');
    f.git('add','.');f.git('commit','-qm','declared SQL input');f.identity.commit=f.git('rev-parse','HEAD');f.identity.tree=f.git('rev-parse','HEAD^{tree}');
    await assert.rejects(verifyTrustedSource(f.repo,f.identity,options),/Source acquisition refused: SQLite/);
    // The comparison scope is independently governed by the actual source/provider guard.
    // A raw syntax/source check alone grants no SQL-free acceptance.
    assert.equal(await verifyTrustedSource(f.repo,f.identity,f.options),f.repo);
  }
});

test('generated post-fetch workflow gate refuses changed admitted event bytes',t=>{
  const f=prCarrier(t),script=gates(fixtureWorkflow(f));
  const marker='[[ "$GITHUB_SHA" =~';assert.ok(script.includes(marker));
  const amended=script.replace(marker,'printf " " >> "$GITHUB_EVENT_PATH"\n'+marker);
  const result=spawnSync('bash',['-s'],{cwd:f.repo,env:eventEnvironment(f),input:amended,encoding:'utf8',timeout:15000});
  assert.notEqual(result.status,0);assert.match(result.stderr,/admitted event bytes changed/);assert.equal(result.stdout,'');
});

test('trusted read-only Git queries refuse absent promisor objects without transport fallback',async t=>{
  const f=sourceCarrier(t),origin=join(f.path,'origin');cpSync(f.repo,origin,{recursive:true});
  f.git('config','remote.origin.url','file://'+origin);f.git('config','remote.origin.promisor','true');f.git('config','extensions.partialClone','origin');
  const tree=f.identity.tree,object=join(f.repo,'.git','objects',tree.slice(0,2),tree.slice(2));assert.ok(existsSync(object));rmSync(object);
  await assert.rejects(verifyTrustedSource(f.repo,f.identity,f.options),/refused/);
  assert.equal(existsSync(object),false,'verification cannot repair missing source through its promisor remote');
  for(const fn of [verifyCommittedSource,verifyTrustedWorkflowCarrier,verifyReviewedChangePullRequestCarrier]){
    assert.ok(fn.toString().includes("GIT_ALLOW_PROTOCOL:''"));assert.ok(fn.toString().includes("GIT_NO_LAZY_FETCH:'1'"));
  }
});


test('qualification-only PR uses the genuine serialized event and carrier gates before any source acquisition',t=>{
  const f=prCarrier(t),r=request();r.snapshot.commit=f.identity.base;r.snapshot.tree=f.git('rev-parse',f.identity.base+'^{tree}');
  const workflow=projectReleaseCaller(binding,{qualification:{snapshot:r.snapshot,controller:r.controller},pullRequestHeadRef:prBinding.headRef})['.github/workflows/release.yml'];
  const job=workflow.slice(workflow.indexOf('  toolchain-qualification:\n'),workflow.indexOf('  release:\n'));
  const script=gates(workflow,'toolchain-qualification');
  for(const fn of [admitReviewedChangePullRequest,verifyReviewedChangePullRequestCarrier,verifyTrustedWorkflowCarrier])assert.ok(job.includes(fn.toString().split('\n').map(line=>'          '+line).join('\n')));
  assert.equal(job.includes('receive-pull-requests.mjs'),false);assert.ok(job.includes('qualify-candidate-toolchain.mjs'));
  for(const effect of ['github-machine-release.scm','advance-reviewed-sources','prepare-build-swap','systemctl','gh workflow run'])assert.equal(job.includes(effect),false,effect);
  assert.ok(job.indexOf('QUALIFICATION_WORKFLOW')<job.indexOf('source_git=(env -i'));
  const env=eventEnvironment(f),run=overrides=>spawnSync('bash',['-s'],{cwd:f.repo,env:{...env,...overrides},input:script,encoding:'utf8',timeout:15000});
  const good=run({});assert.equal(good.status,0,good.stderr);assert.equal(good.stdout,'identity-admitted\n');
  for(const change of [{GITHUB_WORKFLOW_SHA:f.identity.base},{GITHUB_SHA:f.identity.head},{GITHUB_REF:'refs/heads/main'},{GITHUB_ACTOR:'other'},{GITHUB_EVENT_NAME:'push'},{GITHUB_WORKFLOW_SHA:'main'}]){
    const bad=run(change);assert.notEqual(bad.status,0);assert.equal(bad.stdout,'');
  }
  writeFileSync(join(f.repo,'.github/workflows/release.yml'),'dirty');const dirty=run({});assert.notEqual(dirty.status,0);assert.equal(dirty.stdout,'');
});
