import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {controllerBootstrap,projectControllerBootstrap} from '../scripts/project-controller-bootstrap.mjs';
import {verifyCommittedSource,verifyTrustedSource} from '../scripts/verify-release-source.mjs';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {releaseConsumerBinding,projectReleaseCaller,projectCommittedReleaseCaller,readCommittedConsumerBinding,inspectHistoricalReleaseConsumerBinding,
  projectReleaseDiagnosticJobs,projectCommittedReleaseDiagnosticJobs,
  admitReleaseEvent,admitToolchainQualificationEvent,admitReviewedChangeEvent} from '../scripts/project-release-caller.mjs';
const bindings=JSON.parse(readFileSync(new URL('./fixtures/release-consumer-bindings.json',import.meta.url)));
const binding=bindings['cold-red-gate'];
const hash=n=>String(n).repeat(40),identity={repository:'red-cup-engineering/guix-machine-release-service',commit:hash(1),tree:hash(2)};
const fixed=(b=binding)=>({snapshot:{repository:b.repository,definition:b.definition,commit:hash(3),tree:hash(4)},controller:identity});
const request=(b=binding)=>({kind:'guix.reviewed-change-request.v2',...fixed(b),changes:[identity,{repository:'coesite-operations/operations-services-section',commit:hash(5),tree:hash(6)}]});
const project=(b=binding,r=fixed(b))=>projectReleaseCaller(b,{qualification:r})['.github/workflows/release.yml'];
const receiving=(b=binding,r=request(b),o={})=>projectReleaseCaller(b,{receiving:r,...o})['.github/workflows/release.yml'];
const job=(out,name)=>out.slice(out.indexOf('  '+name+':\n'),out.indexOf('  release:\n'));
const shell=job=>job.slice(job.indexOf('        run: |\n')+'        run: |\n'.length).split('\n').map(line=>line.replace(/^          /u,'')).join('\n');
function root(t){const path=mkdtempSync(join(tmpdir(),'release-caller-'));t.after(()=>rmSync(path,{recursive:true,force:true}));return path;}
function context(mode='qualify-toolchain',b=binding){return {eventName:'workflow_dispatch',actor:b.actor,triggeringActor:b.actor,repository:b.repository,ref:'refs/heads/main',sha:hash(7),event:{repository:{full_name:b.repository,id:b.repositoryId},sender:{login:b.actor},inputs:{mode}}};}
function comment(mode='qualify-toolchain',b=binding){return {...context(mode,b),eventName:'issue_comment',event:{repository:{full_name:b.repository,id:b.repositoryId},action:'created',sender:{login:b.actor},issue:{number:96,pull_request:{url:`https://api.github.com/repos/${b.repository}/pulls/96`}},comment:{body:`/release ${mode}`,user:{login:b.actor},issue_url:`https://api.github.com/repos/${b.repository}/issues/96`}}};}

test('complete reviewed binding and schema agree, with no unvalidated extension surface',()=>{
  const schema=JSON.parse(readFileSync(new URL('../specifications/release-consumer-binding.schema.json',import.meta.url)));
  for(const b of Object.values(bindings)){
    assert.equal(releaseConsumerBinding(b),b);assert.equal(schema.additionalProperties,false);assert.deepEqual([...schema.required].sort(),Object.keys(b).sort());assert.equal(schema.properties.kind.const,b.kind);
    for(const mutate of [x=>x.command='anything',x=>x.mode='deploy',x=>x.version=2,x=>x.kind='unknown',x=>x.policy='hidden-catalog',
      x=>x.repository='other/machine;command',x=>x.repositoryId=0,x=>x.actor='bad actor',x=>x.runner.push('run: command'),x=>x.runner[0]='ubuntu-latest',x=>x.lease='/other',x=>x.concurrency+='${{ anything }}',
      x=>x.events.push('schedule'),x=>x.events.push('pull_request_target'),x=>x.modes.push('advance'),x=>x.defaultMode='deploy',x=>x.channelsBlob=hash(0),
      x=>x.channelsBlob=null,x=>x.workflow='.github/workflows/other.yml',x=>x.runDirectory='../escape',x=>x.sourcePolicy='anything',
      ...['repository','actor','definition','lease','runDirectory','concurrency','channelsBlob'].flatMap(key=>['\n','\r','\u2028','\u2029'].map(suffix=>x=>x[key]+=suffix)),
      x=>x.effects.cpuWeight={unit:'review.service\n',weight:1000},x=>x.effects.command='arbitrary',x=>x.effects.prepareBuildSwap='true',x=>x.effects.cpuWeight={unit:'bad; command.service',weight:1000},
      x=>x.effects.cpuWeight={unit:'review.service',weight:10001},x=>x.effects.cpuWeight={unit:'review.service',weight:1000,command:'anything'},
      x=>{x.activationHeld=true;x.modes=['build','deploy'];},
      ...['../escape','./machines/unit','machines//unit','/absolute','machines/link/..','.git','machines/../unit'].map(path=>x=>x.definition=path)]){
      const changed=structuredClone(b);mutate(changed);assert.throws(()=>releaseConsumerBinding(changed),/binding|policy/);
    }
    for(const key of Object.keys(b)){const changed=structuredClone(b);delete changed[key];assert.throws(()=>releaseConsumerBinding(changed));}
  }
  const old=readFileSync(new URL('./fixtures/toolchain-qualification-release.yml',import.meta.url),'utf8');
  assert.throws(()=>projectReleaseCaller(old,{qualification:identity}),/binding/);
  assert.throws(()=>projectReleaseCaller(binding,{workflow:old}),/option/);
});

test('native binding schema mirrors its exact controller, inputs and effects',()=>{
  const schema=JSON.parse(readFileSync(new URL('../specifications/release-consumer-binding.schema.json',import.meta.url)));
  const inputs=['GUIX_COMMON_ASSEMBLY_RECEIPT','GUIX_COMMON_SOFTWARE_RECEIPT','GUIX_COMMON_SOURCE_SNAPSHOT'];
  const native=()=>({...structuredClone(binding),nativeController:{...identity},nativeInputs:[...inputs]});
  const controller=schema.properties.nativeController;
  assert.equal(schema.additionalProperties,false);assert.equal(controller.additionalProperties,false);
  assert.deepEqual(controller.required,['repository','commit','tree']);
  assert.equal(controller.properties.repository.const,identity.repository);
  for(const name of ['commit','tree'])assert.deepEqual(controller.properties[name],{$ref:'#/properties/channelsBlob'});
  assert.deepEqual(schema.properties.nativeInputs.enum,[inputs,[...inputs,'GUIX_ONE_TIME_CUSTODY_SOURCE']]);
  assert.deepEqual(schema.dependentRequired,{nativeController:['nativeInputs'],nativeInputs:['nativeController']});
  const conditional=schema.allOf.find(rule=>rule.if.required?.includes('nativeController'));
  assert.deepEqual(conditional.then.properties.effects.properties,{deinitializeSubmodules:{const:false},prepareBuildSwap:{const:false}});
  for(const value of [native(),{...native(),nativeInputs:[...inputs,'GUIX_ONE_TIME_CUSTODY_SOURCE']}])
    assert.equal(releaseConsumerBinding(value),value);
  for(const mutate of [x=>delete x.nativeController,x=>delete x.nativeInputs,x=>x.nativeController.repository='other/controller',
    x=>x.nativeController.commit=hash(0),x=>x.nativeController.tree='main',x=>x.nativeController.command='anything',
    x=>x.nativeInputs.reverse(),x=>x.nativeInputs.push(inputs[0]),x=>x.nativeInputs.push('UNREVIEWED_INPUT'),
    x=>x.effects.prepareBuildSwap=true,x=>x.effects.deinitializeSubmodules=true]){
    const value=native();mutate(value);assert.throws(()=>releaseConsumerBinding(value));
  }
  // Schema repair preserves the concurrent native retained-target contract.
  const rollback={...native(),activationHeld:false,modes:['build','rollback']};
  assert.equal(releaseConsumerBinding(rollback),rollback);
  assert.equal(releaseConsumerBinding(bindings['bare-cedar-fog']),bindings['bare-cedar-fog']);
});

test('one owner template isolates ordinary and immutable diagnostic jobs and queues',()=>{
  for(const b of Object.values(bindings)){
    const plain=projectReleaseCaller(b)['.github/workflows/release.yml'];
    const combined=projectReleaseCaller(b,{qualification:fixed(b),receiving:request(b)})['.github/workflows/release.yml'];
    const ordinary=combined.slice(combined.indexOf('  release:\n')).split('\n').slice(2).join('\n');
    assert.equal(ordinary,plain.slice(plain.indexOf('  release:\n')).split('\n').slice(2).join('\n'));
    assert.match(combined,/default: build/);assert.match(combined,/cancel-in-progress: false/);
    for(const name of ['toolchain-qualification','change-receiving']){
      const selected=job(combined,name).split('  change-receiving:\n')[0]||job(combined,name);
      assert.ok(combined.includes("&& '"+name+"' || "));assert.ok(combined.includes('runs-on: '+JSON.stringify(b.runner)));
      assert.match(selected,/github-guix-build\.lease|Receive only/);
    }
    for(const name of ['toolchain-qualification','change-receiving']){
      const block=job(combined,name).split(name==='toolchain-qualification'?'  change-receiving:\n':'\0')[0];
      for(const effect of ['systemctl','guix shell','guix gc','prepare-build-swap','github-machine-release.scm','advance-reviewed-sources','gh workflow run','RELEASE_MODE:'])assert.equal(block.includes(effect),false,effect);
      assert.ok(block.indexOf('function admitDiagnosticEvent')<block.indexOf('flock --exclusive 9'));
      assert.ok(block.indexOf('QUALIFICATION_WORKFLOW')<block.indexOf('source_git=(env -i'));
    }
  }
});

test('BCF preserves the actual adopted source policy and CRG explicitly holds migration activation',()=>{
  const original=readFileSync(new URL('./fixtures/bare-cedar-fog-release.yml',import.meta.url),'utf8');
  const bcf=projectReleaseCaller(bindings['bare-cedar-fog'])['.github/workflows/release.yml'];
  for(const effect of ["git submodule status | awk '$1 !~ /^-/ {print $2}' | xargs -r git submodule deinit --force --",
    'guix shell node -- node "$service/scripts/prepare-build-swap.mjs" machine.json',
    'guix repl -- "$service/scripts/pinned-guix.scm" channels.scm shell guile guile-json node -- \\',
    'guile --no-auto-compile "$service/scripts/github-machine-release.scm" "$GITHUB_WORKSPACE/$MACHINE_SOURCE_DIRECTORY" "$work" "$RELEASE_MODE"',
    'guix shell node -- node "$RELEASE_CONTROLLER/scripts/record-outcome.mjs" "$work"']){
    assert.ok(original.includes(effect),effect);assert.ok(bcf.includes(effect),effect);
  }
  assert.match(original,/    paths:/);assert.doesNotMatch(bcf.slice(bcf.indexOf('on:'),bcf.indexOf('  workflow_dispatch:')),/paths:/);
  assert.ok(bcf.includes(bindings['bare-cedar-fog'].definition));assert.match(bcf,/options: \[build, deploy, check-failure, rollback\]/);
  assert.equal(bcf.includes('schedule:'),false);
  const crg=projectReleaseCaller(binding)['.github/workflows/release.yml'];
  assert.match(crg,/options: \[build\]/);assert.match(crg,/Explicit migration hold/);assert.ok(crg.includes('machines/cold-red-gate'));
  assert.match(crg,/refuse-declared-sql-before-bootstrap-v1/);assert.match(crg,/Snapshot superseded before build admission/);assert.match(crg,/Preview closed or superseded before build admission/);
  assert.ok(crg.includes("systemctl --user set-property --runtime 'github-cold-red-gate-cloud-build.service' CPUWeight=1000"));
  for(const retired of ['sources.json','sourceAcquisitionPreflight','project-release-request','advance-reviewed-sources','gh workflow run','cron:'])assert.equal(crg.includes(retired),false,retired);
});

test('fixed request binds both repository root and definition and permits no hidden projection options',()=>{
  const r=request();
  for(const mutate of [x=>x.command='anything',x=>x.snapshot.repository='other/machine',x=>x.snapshot.definition='other',x=>x.controller.commit='main',x=>x.controller.tree=hash(0),x=>x.controller.repository='other/owner',x=>x.changes=[]]){
    const changed=structuredClone(r);mutate(changed);assert.throws(()=>receiving(binding,changed));
  }
  for(const value of [null,[],'branch',false])assert.throws(()=>projectReleaseCaller(binding,value),/option/);
  for(const value of [{headRef:'review/other'},{mode:'deploy'},{runner:['other']}])assert.throws(()=>receiving(binding,r,value),/option/);
  for(const value of ['',"review/quote'",'review/new\nline','review/${{ github.sha }}','refs/heads/main','review/a..b','review/a.lock','review/a/','review/'+('a'.repeat(161)),false,null])assert.throws(()=>receiving(binding,r,{pullRequestHeadRef:value}),/fixed branch/);
  assert.throws(()=>projectReleaseCaller(binding,{pullRequestHeadRef:'review/only'}),/exact receiving/);
  assert.throws(()=>projectReleaseCaller(binding,{qualification:{controller:identity}}),/snapshot/);
  for(const value of [null,false,undefined]){assert.throws(()=>projectReleaseCaller(binding,{qualification:value}));assert.throws(()=>projectReleaseCaller(binding,{receiving:value}));}
  const candidate={...r.snapshot,commit:hash(7),tree:hash(8)};
  const out=receiving(binding,{...r,candidateSnapshot:candidate});
  assert.match(out,/candidate="\$work_root\/candidate"/);
  assert.match(out,/--candidate-root="\$candidate"/);
  assert.equal(receiving().includes('--candidate-root'),false);
  assert.throws(()=>receiving(binding,{...r,candidateSnapshot:{...candidate,definition:'other'}}));
  assert.throws(()=>receiving(binding,{...r,candidateSnapshot:{...candidate,repository:'other/machine'}}));
  const block=job(out,'change-receiving');
  assert.ok(block.indexOf('await verifyTrustedSource(env.CONTROLLER_DIRECTORY')<block.indexOf('"$controller/scripts/receive-pull-requests.mjs"'));
  assert.match(block,/"\$snapshot" "\$work_root\/change" --exact/);
});

test('strict diagnostic event gates retain dispatch/comment identity and exact modes',()=>{
  for(const mode of ['qualify-toolchain','receive-changes']){
    const admit=mode==='qualify-toolchain'?admitToolchainQualificationEvent:admitReviewedChangeEvent;
    for(const good of [context(mode),comment(mode)])assert.doesNotThrow(()=>admit(good,binding));
    for(const mutate of [x=>x.actor='other',x=>x.triggeringActor='EMSENN',x=>x.event.sender.login='other',x=>x.repository='other/machine',x=>x.event.repository.full_name='561-GROUP/cold-red-gate',x=>x.event.repository.id++,x=>x.eventName='schedule',x=>x.ref='refs/heads/other',x=>x.sha='main',x=>x.event.inputs.mode='deploy',x=>x.event.inputs.command='anything']){
      const bad=context(mode);mutate(bad);assert.throws(()=>admit(bad,binding),/event refused/);
    }
    for(const mutate of [x=>x.event.action='edited',x=>x.event.comment.user.login='other',x=>delete x.event.issue.pull_request,x=>x.event.issue.number=0,x=>x.event.issue.number=1.5,x=>x.event.comment.issue_url='https://api.github.com/repos/other/machine/issues/96',x=>x.event.issue.pull_request.url+='0',
      ...[`/release ${mode}\n`,` /release ${mode}`,`/release ${mode} extra`,`/RELEASE ${mode.toUpperCase()}`,'/release advance'].map(body=>x=>x.event.comment.body=body)]){
      const bad=comment(mode);mutate(bad);assert.throws(()=>admit(bad,binding),/event refused/);
    }
    assert.throws(()=>admit(comment(mode,bindings['bare-cedar-fog']),bindings['bare-cedar-fog']),/event refused/);
  }
  assert.throws(()=>admitReleaseEvent(context('advance'),binding,'advance'),/event refused/);
  assert.throws(()=>admitReleaseEvent(context('deploy'),binding,'deploy'),/event refused/);
  assert.doesNotThrow(()=>admitReleaseEvent(context('deploy',bindings['bare-cedar-fog']),bindings['bare-cedar-fog'],'deploy'));
});

test('generated shell syntax and exact request digest retain actual bytes',t=>{
  for(const b of Object.values(bindings))for(const out of [project(b),receiving(b),receiving(b,{...request(b),candidateSnapshot:{...fixed(b).snapshot,commit:hash(7),tree:hash(8)}},{pullRequestHeadRef:'review/'+('a'.repeat(153))})]){
    const blocks=out.split('        run: |\n').slice(1).map(tail=>tail.split('\n').slice(0,tail.split('\n').findIndex(line=>line&&!line.startsWith('          '))).map(line=>line.replace(/^          /u,'')).join('\n'));
    for(const body of blocks){assert.ok(body.length>0);assert.ok(body.length<=21000,`run body exceeds reviewed Actions limit: ${body.length}`);const parsed=spawnSync('bash',['-n'],{input:body,encoding:'utf8'});assert.equal(parsed.status,0,parsed.stderr);}
    for(const name of ['toolchain-qualification','change-receiving'])if(out.includes('  '+name+':\n')){
      const text=shell(job(out,name)),syntax=spawnSync('bash',['-n'],{input:text,encoding:'utf8'});assert.equal(syntax.status,0,syntax.stderr);
    }
  }
  const bytes=JSON.stringify(request())+'\n',out=receiving(),block=job(out,'change-receiving');
  assert.ok(block.includes('RECEIVING_REQUEST_SHA256: '+createHash('sha256').update(bytes).digest('hex')));
  const requestFile=join(root(t),'request.json'),line=shell(block).split('\n').find(line=>line.includes('> "$request_file"'));
  const printed=spawnSync('bash',['-c',line],{env:{request_file:requestFile,RECEIVING_REQUEST:bytes},encoding:'utf8'});
  assert.equal(printed.status,0,printed.stderr);assert.equal(readFileSync(requestFile,'utf8'),bytes);
});

test('profile selection, pure controls and isolated candidate execution preserve existing Guix provenance',()=>{
  const block=job(project(),'toolchain-qualification');
  assert.ok(block.includes('node="$(command -v node)"; guix="$HOME/.config/guix/current/bin/guix"'));
  assert.ok(block.includes('if [ ! -x "$guix" ]; then guix="$(command -v guix)"; fi'));
  assert.ok(block.includes('PATH="$(dirname "$guix"):$(dirname "$node"):/usr/bin:/bin"'));
  assert.equal(block.includes('PATH="$(dirname "$node"):$(dirname "$guix")'),false);
  const control=block.split('\n').find(line=>line.includes('"$guix" repl -- "$controller/test/pinned-guix-diagnostic.scm"'));
  const invocation=block.split('\n').find(line=>line.includes('"$controller/scripts/qualify-candidate-toolchain.mjs"'));
  for(const line of [control,invocation]){
    assert.ok(line.includes('HOME="$work_root/home" TMPDIR="$work_root/tmp"'));
    assert.doesNotMatch(line,/HOME="\$HOME"|GH_TOKEN|GITHUB_TOKEN|GH_CONFIG_DIR|NODE_OPTIONS|time-machine|guix shell/);
  }
  assert.ok(block.lastIndexOf('await verifyTrustedSource')<block.indexOf(control));assert.ok(block.indexOf(control)<block.indexOf(invocation));
  assert.ok(invocation.includes('"$snapshot/'+binding.definition+'"'));
  assert.match(job(receiving(),'change-receiving'),/Retained exact receiving evidence/);
  for(const path of ['change/baseline/source-carriers','change/candidate/source-carriers','change/raw-inputs/source-carriers','change/comparison/workspaces/source-graphs'])assert.ok(job(receiving(),'change-receiving').includes(path));
});

test('actual projected shell selects inert Guix fixtures while retaining isolated HOME and environment',t=>{
  // These are inert shell scripts named node/guix, never the real runtimes or
  // package providers. Only the exact projected selection and env line execute.
  const root=mkdtempSync(join(tmpdir(),'qualification-selection-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const selected=job(project(),'toolchain-qualification'),lines=selected.split('\n').map(line=>line.trim());
  const selection=lines.filter(line=>line.startsWith('node="$(command -v node)"; guix=')
    ||line.startsWith('if [ ! -x "$guix" ];')
    ||line==='[ -x "$node" ] && [ -x "$guix" ]').join('\n');
  assert.equal(selection.split('\n').length,3);
  const invocation=lines.find(line=>line.startsWith('env -i HOME=')&&line.includes('qualify-candidate-toolchain.mjs'));
  assert.ok(invocation);
  for(const profile of ['executable','absent','nonexecutable']){
    const fixture=join(root,profile),home=join(fixture,'runner-home');
    const nodeDir=join(fixture,'node-bin'),guixDir=join(fixture,'path-guix-bin');
    const profileDir=join(home,'.config/guix/current/bin'),isolated=join(fixture,'isolated');
    for(const directory of [nodeDir,guixDir,profileDir,join(isolated,'home'),join(isolated,'tmp'),join(isolated,'results')])
      mkdirSync(directory,{recursive:true});
    const script=(directory,name,body,mode=0o755)=>writeFileSync(join(directory,name),'#!/bin/sh\n'+body,{mode});
    const guix=label=>'printf "guix='+label+'\\n"\nprintf "guix_home=%s\\n" "$HOME"\n';
    script(nodeDir,'guix',guix('wrong-node-directory'));
    script(guixDir,'guix',guix('path-selected'));
    if(profile!=='absent')script(profileDir,'guix',guix('home-profile'),profile==='executable'?0o755:0o644);
    script(nodeDir,'node','printf "node_home=%s\\n" "$HOME"\nprintf "sentinel=%s\\n" "${SELECTION_TEST_SENTINEL-unset}"\nexec guix\n');
    const result=spawnSync('bash',['--noprofile','--norc','-c','set -eu\n'+selection+'\n'+invocation],{
      encoding:'utf8',env:{PATH:guixDir+':'+nodeDir+':/usr/bin:/bin',HOME:home,
        work_root:isolated,controller:'/unused-inert-controller',snapshot:'/unused-inert-snapshot',GITHUB_WORKSPACE:'/unused-inert-snapshot',
        QUALIFICATION_COMMIT:identity.commit,QUALIFICATION_TREE:identity.tree,SELECTION_TEST_SENTINEL:'must-not-be-inherited'},
    });
    assert.ifError(result.error);
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'),[
      'node_home='+join(isolated,'home'),'sentinel=unset',
      'guix='+(profile==='executable'?'home-profile':'path-selected'),
      'guix_home='+join(isolated,'home'),
    ],profile);
  }
});


test('ordinary cache and diagnostic authority emit one identical trusted verifier before selected execution',()=>{
  for(const b of Object.values(bindings)){
    const out=project(b),ordinary=out.slice(out.indexOf('  release:\n'));
    const serialized=[verifyCommittedSource,verifyTrustedSource].map(fn=>fn.toString().split('\n').map(line=>'          '+line).join('\n'));
    for(const block of [ordinary,job(out,'toolchain-qualification')]){
      for(const source of serialized)assert.equal(block.split(source).length,2,'one exact shared core and owner verifier per job');
      assert.doesNotMatch(block,/import\([^\n]*\$service|import\([^\n]*\$controller/);
    }
    assert.equal(projectControllerBootstrap(out),out,'full workflow retains deferred invocation when reprojected');
    const raw=controllerBootstrap();
    assert.ok(raw.indexOf('verify_controller_checkout || exit $?\nelse')<raw.indexOf('fetch -q --depth=1'));
    assert.ok(raw.lastIndexOf('verify_controller_checkout || exit $?\n')<raw.indexOf('echo "RELEASE_CONTROLLER=$service"'));
    assert.ok(ordinary.indexOf('          resolve_release_controller\n')<ordinary.indexOf('guix repl -- "$service/scripts/pinned-guix.scm"'));
  }
});


test('a third consumer supplies immutable authority without a controller machine catalog',()=>{
  const b=structuredClone(binding);Object.assign(b,{repository:'example/third-machine',repositoryId:9001,definition:'machines/unit',actor:'reviewer',channelsBlob:hash(9),
    runner:['self-hosted','Linux','X64','guix','third-build'],lease:'.cache/review/shared.lease',concurrency:'third-release',runDirectory:'.cache/review/runs'});
  b.effects.cpuWeight={unit:'third-build.service',weight:900};
  assert.equal(releaseConsumerBinding(b),b);
  const out=projectReleaseCaller(b)['.github/workflows/release.yml'],bytes=JSON.stringify(b)+'\n';
  assert.ok(out.includes('# Consumer binding JSON: '+JSON.stringify(b)));
  assert.ok(out.includes('# Consumer binding SHA256: '+createHash('sha256').update(bytes).digest('hex')));
  assert.ok(out.includes(`systemctl --user set-property --runtime 'third-build.service' CPUWeight=900`));
  assert.doesNotThrow(()=>admitToolchainQualificationEvent(context('qualify-toolchain',b),b));
  assert.throws(()=>admitToolchainQualificationEvent(context('qualify-toolchain',binding),b),/event refused/);
  for(const value of ['git clone','${{ inputs.runner }}','unit; command']){const bad=structuredClone(b);bad.runner[4]=value;assert.throws(()=>releaseConsumerBinding(bad));}
});

test('generation CLI reads exact committed consumer data without running selected code',t=>{
  for(const name of ['release-consumer.json','release/consumer.json']){
  const repo=root(t),file=join(repo,name);mkdirSync(join(repo,'release'));
  const git=(...args)=>{const result=spawnSync('git',['-C',repo,...args],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
  git('init','-q','--initial-branch=main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('config','commit.gpgsign','false');
  const bytes=JSON.stringify(binding,null,2)+'\n';writeFileSync(file,bytes);
  assert.throws(()=>readCommittedConsumerBinding(file),/committed/);
  git('add',name);git('commit','-qm','consumer input');
  const selected=readCommittedConsumerBinding(file);assert.deepEqual(selected.binding,binding);
  assert.equal(selected.source.path,name);assert.equal(selected.source.commit,git('rev-parse','HEAD'));assert.equal(selected.source.blob,git('rev-parse','HEAD:'+name));
  assert.equal(selected.source.sha256,createHash('sha256').update(bytes).digest('hex'));
  const output=projectCommittedReleaseCaller(file);assert.ok(output['.github/workflows/release.yml'].includes('# Committed consumer input: '+JSON.stringify(selected.source)));
  const cli=spawnSync(process.execPath,[new URL('../scripts/project-release-caller.mjs',import.meta.url).pathname,file],{cwd:repo,encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);assert.deepEqual(JSON.parse(cli.stdout),output);
  git('update-index','--assume-unchanged',name);writeFileSync(file,bytes+' ');
  assert.throws(()=>readCommittedConsumerBinding(file),/differs from its committed bytes/);
  writeFileSync(file,bytes);const alias=join(repo,'alias.json');symlinkSync(file,alias);
  assert.throws(()=>readCommittedConsumerBinding(alias),/redirected/);
  }
});


test('public diagnostic components validate closed inputs and match whole-caller jobs',()=>{
  for(const b of Object.values(bindings))for(const options of [{},{qualification:fixed(b)},
    {receiving:request(b)},{qualification:fixed(b),receiving:request(b)},
    {receiving:request(b),pullRequestHeadRef:'review/exact-receiving'}]){
    const component=projectReleaseDiagnosticJobs(b,options),full=projectReleaseCaller(b,options)[b.workflow];
    assert.deepEqual(Object.keys(component.jobs),Object.keys(component.conditions));
    assert.deepEqual(component.dispatchModes,[...(options.qualification?['qualify-toolchain']:[]),...(options.receiving?['receive-changes']:[])]);
    assert.equal(component.requiresPullRequest,Boolean(options.pullRequestHeadRef));
    assert.equal(component.concurrencySelectors.length,component.dispatchModes.length);
    for(const [name,bytes] of Object.entries(component.jobs)){
      assert.ok(bytes.startsWith('  '+name+':\n'));assert.ok(full.includes(bytes));
      assert.ok(bytes.includes('if: ${{ '+component.conditions[name]+' }}'));
      assert.ok(full.includes(component.concurrencySelectors[Object.keys(component.jobs).indexOf(name)]));
      for(const forbidden of ['  release:', 'systemctl', 'prepare-build-swap', 'github-machine-release.scm', 'advance-reviewed-sources', 'gh workflow run'])assert.equal(bytes.includes(forbidden),false,forbidden);
    }
    for(const value of [component,component.jobs,component.conditions,component.concurrencySelectors,component.dispatchModes])assert.ok(Object.isFrozen(value));
  }
  for(const options of [null,[],false,{mode:'deploy'},{runner:['other']},{qualification:null},{qualification:{snapshot:fixed().snapshot,controller:{...identity,commit:'main'}}},
    {qualification:{...fixed(),command:'anything'}},{receiving:{...request(),changes:[]}},{pullRequestHeadRef:'review/without-request'}])assert.throws(()=>projectReleaseDiagnosticJobs(binding,options));
  for(const mutate of [b=>b.version=2,b=>b.runner[0]='ubuntu-latest',b=>b.definition='../other',b=>b.events.push('schedule')]){
    const bad=structuredClone(binding);mutate(bad);assert.throws(()=>projectReleaseDiagnosticJobs(bad,{qualification:fixed()}));
  }
});

test('committed diagnostic projection retains exact declaration provenance and refuses dirty or invalid data',t=>{
  const repo=root(t),file=join(repo,'release-consumer.json');
  const git=(...args)=>{const result=spawnSync('git',['-C',repo,...args],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
  git('init','-q','--initial-branch=main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('config','commit.gpgsign','false');
  const bytes=JSON.stringify(binding,null,2)+'\n';writeFileSync(file,bytes);
  assert.throws(()=>projectCommittedReleaseDiagnosticJobs(file,{qualification:fixed()}),/committed/);
  git('add','.');git('commit','-qm','reviewed declaration');
  const result=projectCommittedReleaseDiagnosticJobs(file,{qualification:fixed()});
  assert.deepEqual(result.binding,binding);assert.equal(result.source.commit,git('rev-parse','HEAD'));
  assert.equal(result.source.blob,git('rev-parse','HEAD:release-consumer.json'));
  assert.equal(result.source.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(result.jobs,projectReleaseDiagnosticJobs(binding,{qualification:fixed()}).jobs);
  git('update-index','--assume-unchanged','release-consumer.json');writeFileSync(file,bytes+' ');
  assert.throws(()=>projectCommittedReleaseDiagnosticJobs(file,{qualification:fixed()}),/differs from its committed bytes/);
  git('update-index','--no-assume-unchanged','release-consumer.json');writeFileSync(file,JSON.stringify({...binding,command:'anything'}));git('add','.');git('commit','-qm','invalid committed policy');
  assert.throws(()=>projectCommittedReleaseDiagnosticJobs(file,{qualification:fixed()}),/binding/);
});


test('the explicit owning diagnostic input projects only its declared current consumer',t=>{
 const declared=JSON.parse(readFileSync(new URL('../specifications/release-consumer-cold-red-gate-diagnostic.json',import.meta.url)));
 assert.equal(releaseConsumerBinding(declared),declared);
 assert.equal(declared.repository,'561-group/cold-red-gate');assert.equal(declared.repositoryId,1408796038);
 assert.equal(declared.definition,'.');assert.equal(declared.channelsBlob,'be2ad3e698618dc916fe126880b6ed9573ee1bb3');
 const result=projectReleaseDiagnosticJobs(declared,{qualification:fixed(declared)});
 assert.deepEqual(Object.keys(result.jobs),['toolchain-qualification']);
 assert.deepEqual(result.dispatchModes,['qualify-toolchain']);
 assert.ok(result.jobs['toolchain-qualification'].includes('"$snapshot/."'));
 assert.equal(result.jobs['toolchain-qualification'].includes('  release:'),false);
 assert.throws(()=>projectReleaseDiagnosticJobs(declared,{qualification:fixed(binding)}),/qualification requires fixed trusted source identities/);
 const repo=root(t),name='specifications/release-consumer-cold-red-gate-diagnostic.json',file=join(repo,name);mkdirSync(join(repo,'specifications'));
 const git=(...args)=>{const r=spawnSync('git',['-C',repo,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 git('init','-qb','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('config','commit.gpgsign','false');
 writeFileSync(file,readFileSync(new URL('../'+name,import.meta.url)));git('add','.');git('commit','-qm','explicit producer input');
 const committed=projectCommittedReleaseDiagnosticJobs(file,{qualification:fixed(declared)});
 assert.equal(committed.source.path,name);assert.equal(committed.source.commit,git('rev-parse','HEAD'));
 assert.equal(committed.source.blob,git('rev-parse','HEAD:'+name));assert.deepEqual(committed.jobs,result.jobs);
});


test('fixed qualification opts into the existing reviewed PR carrier without changing manual or receiving semantics',()=>{
  const headRef='review/fixed-qualification',options={qualification:fixed(),pullRequestHeadRef:headRef};
  const component=projectReleaseDiagnosticJobs(binding,options),full=projectReleaseCaller(binding,options)[binding.workflow];
  assert.equal(component.requiresPullRequest,true);assert.deepEqual(Object.keys(component.jobs),['toolchain-qualification']);
  const block=component.jobs['toolchain-qualification'];assert.ok(full.includes(block));
  for(const required of [headRef,fixed().snapshot.commit,'admitReviewedChangePullRequest','verifyReviewedChangePullRequestCarrier','fetch-depth: 2','qualify-candidate-toolchain.mjs'])assert.ok(block.includes(required),required);
  for(const missing of ['RECEIVING_REQUEST','receive-pull-requests.mjs','github-machine-release.scm','advance-reviewed-sources'])assert.equal(block.includes(missing),false,missing);
  const expr=line=>line.slice(line.indexOf('${{ ')+4,line.lastIndexOf(' }}'));
  const ordinary=full.slice(full.indexOf('  release:\n')).split('\n').find(line=>line.startsWith('    if:'));
  const group=full.split('\n').find(line=>line.startsWith('  group:'));
  const evaluate=(code,c)=>runInNewContext(code,c,{timeout:100});
  const c={github:{repository:binding.repository,actor:binding.actor,triggering_actor:binding.actor,event_name:'pull_request',event:{action:'synchronize',repository:{full_name:binding.repository,id:binding.repositoryId},pull_request:{number:12,head:{ref:headRef},base:{sha:fixed().snapshot.commit}}}},inputs:{},fromJSON:JSON.parse,contains:(a,b)=>a.includes(b),format:(s,n)=>s.replace('{0}',n)};
  assert.equal(evaluate(component.conditions['toolchain-qualification'],c),true);assert.equal(evaluate(expr(ordinary),c),false);
  assert.equal(evaluate(expr(group),c),'toolchain-qualification');
  c.github.event.pull_request.head.ref='review/unrelated';assert.equal(evaluate(component.conditions['toolchain-qualification'],c),false);assert.equal(evaluate(expr(ordinary),c),true);
  c.github.event_name='workflow_dispatch';c.inputs.mode='qualify-toolchain';assert.equal(evaluate(component.conditions['toolchain-qualification'],c),true);assert.equal(evaluate(expr(ordinary),c),false);
  const both=projectReleaseDiagnosticJobs(binding,{...options,receiving:request()});
  assert.equal(both.jobs['toolchain-qualification'],projectReleaseDiagnosticJobs(binding,{qualification:fixed()}).jobs['toolchain-qualification']);
  assert.equal(both.jobs['change-receiving'],projectReleaseDiagnosticJobs(binding,{receiving:request(),pullRequestHeadRef:headRef}).jobs['change-receiving']);
  for(const branch of ['main','refs/heads/main','review/../other','review/unsafe\n'])assert.throws(()=>projectReleaseDiagnosticJobs(binding,{qualification:fixed(),pullRequestHeadRef:branch}),/fixed branch/);
  assert.throws(()=>projectReleaseDiagnosticJobs(binding,{pullRequestHeadRef:headRef}),/fixed qualification or exact receiving/);
  const longest=projectReleaseDiagnosticJobs(binding,{qualification:fixed(),pullRequestHeadRef:'review/'+('a'.repeat(153))});
  const body=shell(longest.jobs['toolchain-qualification']);assert.ok(body.length<=21000);const parsed=spawnSync('bash',['-n'],{input:body,encoding:'utf8'});assert.equal(parsed.status,0,parsed.stderr);
});

test('original archive tag carries a read-only, exact Guix binding into its lawful owner',async t=>{
  const root=mkdtempSync(join(tmpdir(),'guix-original-tag-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
  git('init','-q','--initial-branch=main');
  git('config','user.name','Original Source Assayer');
  git('config','user.email','assayer@example.invalid');
  git('config','commit.gpgsign','false');
  const binding=structuredClone(bindings['bare-cedar-fog']);
  binding.effects.deinitializeSubmodules=false;
  binding.effects.prepareBuildSwap=false;
  binding.effects.queuedHeadCheck=true;
  binding.nativeController={repository:'red-cup-engineering/guix-machine-release-service',
    commit:'12dad523875403d6d9eb47177ac9dbf6149150e0',
    tree:'564e064c888f2241b7792d061dab01de9fa4c9e9'};
  binding.nativeInputs=['GUIX_COMMON_ASSEMBLY_RECEIPT','GUIX_COMMON_SOFTWARE_RECEIPT',
    'GUIX_COMMON_SOURCE_SNAPSHOT','GUIX_ONE_TIME_CUSTODY_SOURCE'];
  releaseConsumerBinding(binding);
  writeFileSync(join(root,'release-consumer.json'),JSON.stringify(binding)+'\n');
  git('add','release-consumer.json');
  git('commit','-qm','retained original historical consumer');
  git('tag','archive/codex-unprocessed-release');
  const tag='refs/tags/archive/codex-unprocessed-release',
    commit=git('rev-parse',tag+'^{commit}'),
    blob=git('rev-parse',commit+':release-consumer.json');
  git('rm','-q','release-consumer.json');
  git('commit','-qm','current default no longer carries original file');
  assert.equal(existsSync(join(root,'release-consumer.json')),false);
  const main=git('rev-parse','HEAD');
  const bytes=execFileSync('git',['-C',root,'show',commit+':release-consumer.json']);
  const row={path:'release-consumer.json',mode:'100644',bytes,
    source:{repository:`https://github.com/${binding.repository}.git`,commit,path:'release-consumer.json',object:blob}};
  const queries=[];
  const readPinnedSourceFiles=async selection=>{
    queries.push(selection);
    assert.equal(selection.repository,`https://github.com/${binding.repository}.git`);
    assert.equal(selection.commit,commit);
    assert.equal(selection.scope,'');
    assert.equal(selection.selectFile('release-consumer.json'),true);
    assert.equal(selection.selectFile('MIGRATION.json'),false);
    assert.equal(selection.enterDirectory('other'),false);
    return [row];
  };
  const input={readPinnedSourceFiles,repository:binding.repository,repositoryId:binding.repositoryId,commit};
  const result=await inspectHistoricalReleaseConsumerBinding(input);
  assert.equal(result.recordKind,'guix.historical-release-consumer-source-observation/v1');
  assert.deepEqual(result.source,{
    repositoryFullName:binding.repository,repositoryId:binding.repositoryId,
    commitId:commit,sourcePath:'release-consumer.json',gitBlobObjectId:blob,
    contentSha256:createHash('sha256').update(bytes).digest('hex'),
    sourceFormat:'git-committed-json'
  });
  assert.equal(result.originalBindingRecordKind,binding.kind);
  assert.equal(result.historicalConsumer.machineDefinitionPath,binding.definition);
  assert.equal(result.historicalConsumer.declaredActivationHeld,false);
  assert.equal(result.operationalInstallation,'not-observed');
  assert.equal(result.independentConsumerReceiving,'not-observed');
  assert.deepEqual(result.authorizedEffects,[]);
  assert.equal(Object.hasOwn(result,'binding'),false,'historical binding must not become a runnable caller');
  assert.equal(git('rev-parse',tag+'^{commit}'),commit,'tag was not deleted');
  assert.equal(git('rev-parse','main'),main,'live main was not changed');
  assert.equal(queries.length,1,'source supplier read only once');
});

test('historical source fails closed on altered Git identity, malformed bytes or nonconsumer data',async()=>{
  const binding=structuredClone(bindings['bare-cedar-fog']);
  const bytes=Buffer.from(JSON.stringify(binding),'utf8'),commit='a'.repeat(40);
  const oid=data=>createHash('sha1').update('blob '+data.length+'\0').update(data).digest('hex');
  const row={path:'release-consumer.json',mode:'100644',bytes,
    source:{repository:`https://github.com/${binding.repository}.git`,commit,path:'release-consumer.json',object:oid(bytes)}};
  const input={readPinnedSourceFiles:async()=>[row],
    repository:binding.repository,repositoryId:binding.repositoryId,commit};
  const observed=await inspectHistoricalReleaseConsumerBinding(input);
  assert.equal(observed.historicalConsumer.declaredSourcePolicy,binding.sourcePolicy);
  assert.equal(observed.operationalInstallation,'not-observed');
  assert.deepEqual(observed.authorizedEffects,[]);
  for(const bad of [
    {...input,commit:'refs/tags/archive/codex-unprocessed-release'},
    {...input,commit:'main'},
    {...input,repositoryId:binding.repositoryId+1},
    {...input,path:'MIGRATION.json'},
    {...input,path:'../release-consumer.json'},
    {...input,readPinnedSourceFiles:async()=>[]},
    {...input,readPinnedSourceFiles:async()=>[row,row]},
    {...input,readPinnedSourceFiles:async()=>[{...row,mode:'120000'}]},
    {...input,readPinnedSourceFiles:async()=>[{...row,source:{...row.source,commit:'b'.repeat(40)}}]},
    {...input,readPinnedSourceFiles:async()=>[{...row,source:{...row.source,object:'b'.repeat(40)}}]},
    {...input,readPinnedSourceFiles:async()=>[{...row,bytes:Buffer.from('{"kind":"guix.release-consumer-binding.v2"}')}]},
    {...input,readPinnedSourceFiles:async()=>[{...row,bytes:Buffer.from([0xc3,0x28])}]},
    {...input,readPinnedSourceFiles:async()=>[{...row,bytes:Buffer.alloc(65537)}]},
  ])await assert.rejects(inspectHistoricalReleaseConsumerBinding(bad),
    undefined,'unsafe source cannot be turned into a Guix consumer');
  const changed=structuredClone(binding);
  changed.effects.prepareBuildSwap='permission-unreviewed';
  const wrong=Buffer.from(JSON.stringify(changed),'utf8');
  await assert.rejects(inspectHistoricalReleaseConsumerBinding({
    ...input,readPinnedSourceFiles:async()=>[{
      ...row,bytes:wrong,source:{...row.source,object:oid(wrong)}
    }]
  }),/invalid trusted consumer binding or effect policy/);
});

test('historical decoding refuses malformed bytes after their Git blob is verified',async()=>{
  const binding=structuredClone(bindings['bare-cedar-fog']),commit='a'.repeat(40);
  const input={repository:binding.repository,repositoryId:binding.repositoryId,commit};
  const row=bytes=>({path:'release-consumer.json',mode:'100644',bytes,
    source:{repository:`https://github.com/${binding.repository}.git`,commit,path:'release-consumer.json',
      object:createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex')}});
  for(const [bytes,pattern] of [
    [Buffer.from([0xc3,0x28]),/encoded data was not valid/],
    [Buffer.from('{'),/JSON/],
    [Buffer.from('null'),/invalid trusted consumer binding/],
    [Buffer.from('{}'),/invalid trusted consumer binding/],
  ])await assert.rejects(inspectHistoricalReleaseConsumerBinding({
    ...input,readPinnedSourceFiles:async()=>[row(bytes)],
  }),pattern);
});

test('historical nested paths and SHA-256 retain exact origin and scoped source identity',async()=>{
  const binding=structuredClone(bindings['bare-cedar-fog']),commit='a'.repeat(64);
  const path='machines/original/release-consumer.json',repository=`https://github.com/${binding.repository}.git`;
  const bytes=Buffer.from(JSON.stringify(binding)),object=createHash('sha256').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
  const row={path:'release-consumer.json',mode:'100644',bytes,source:{repository,commit,path,object}};
  const input={repository:binding.repository,repositoryId:binding.repositoryId,commit,path};
  const result=await inspectHistoricalReleaseConsumerBinding({...input,readPinnedSourceFiles:async selection=>{
    assert.equal(selection.repository,repository);assert.equal(selection.scope,'machines/original');
    assert.equal(selection.selectFile('release-consumer.json'),true);
    assert.equal(selection.selectFile('nested/release-consumer.json'),false);
    assert.equal(selection.enterDirectory('nested'),false);return [row];
  }});
  assert.equal(result.source.repositoryFullName,binding.repository);
  assert.equal(result.source.sourcePath,path);assert.equal(result.source.gitBlobObjectId,object);
  for(const source of [{...row.source,repository:binding.repository},
    {...row.source,repository:'https://github.com/foreign/source.git'},
    {...row.source,path:'release-consumer.json'}, {...row.source,object:object.slice(0,40)}])
    await assert.rejects(inspectHistoricalReleaseConsumerBinding({...input,readPinnedSourceFiles:async()=>[{...row,source}]}),/source kind, path, identity/);
  for(const value of [result,result.source,result.historicalConsumer,result.historicalConsumer.declaredRunnerLabels,
    result.historicalConsumer.declaredOperationModes,result.authorizedEffects])assert.equal(Object.isFrozen(value),true);
});
