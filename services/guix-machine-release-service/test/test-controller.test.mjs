import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';

function fixture(change={}){
  const root=mkdtempSync(join(tmpdir(),'fixed-controller-test-'));
  const sourceRoot=join(root,'controller'),ownerPath=change.nested?'software/controller':'.';
  const service=join(sourceRoot,ownerPath),snapshot=join(root,'machine'),bin=join(root,'bin');
  const work=change.workInSource?join(service,'results'):join(root,'results');
  const run=(program,args,options={})=>{
    const r=spawnSync(program,args,{encoding:'utf8',...options});assert.equal(r.status,0,r.stderr);return r.stdout.trim();
  };
  const git=(dir,...args)=>run('git',['-C',dir,...args]);
  for(const dir of [sourceRoot,service,snapshot,bin])mkdirSync(dir,{recursive:true});
  for(const dir of [sourceRoot,snapshot]){
    run('git',['init','--initial-branch=main',dir]);
    git(dir,'config','user.name','Fixture');git(dir,'config','user.email','fixture@example.invalid');git(dir,'config','commit.gpgsign','false');
  }
  for(const path of ['scripts/cli-entry.mjs','scripts/qualify-toolchain.mjs','scripts/machine-directory.mjs','scripts/test-controller.mjs','scripts/controller-bootstrap.sh','scripts/source-pins.mjs','scripts/github-reads.mjs',
    'scripts/receive.scm','scripts/github-machine-release.scm','src/controller-owner.scm','test/health-reading.scm','test/credential-unit-receiving.scm','test/media-dependency-observation.scm','test/pre-activation.scm','test/controller-owner.scm','test/fixtures/controller-owner.json']){
    const target=join(service,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,readFileSync(new URL('../'+path,import.meta.url)));
  }
  writeFileSync(join(service,'package.json'),JSON.stringify({name:'@red-cup-engineering/guix-machine-release-service',type:'module',scripts:{test:change.command??'node --test test/*.test.mjs'}}));
  writeFileSync(join(service,'test/canary.test.mjs'),`import test from 'node:test';import {appendFileSync} from 'node:fs';test('declared fixture test',()=>{appendFileSync(process.env.CONTROLLER_EFFECTS,'package-tests\\n');${change.failTest?"throw new Error('fixture failure');":''}});\n`);
  if(change.failGuile)writeFileSync(join(service,'test/health-reading.scm'),'(error "fixture native failure")\n');
  const bootstrapCanary='echo "unadmitted bootstrap executed" >> "$CONTROLLER_FORBIDDEN"\n';
  if(change.bootstrapCanary){const p=join(service,'scripts/controller-bootstrap.sh');writeFileSync(p,bootstrapCanary+readFileSync(p,'utf8'));}
  if(change.nested)writeFileSync(join(sourceRoot,'outside.txt'),'outside the selected controller');
  git(sourceRoot,'add','.');git(sourceRoot,'commit','-m','exact controller source');const commit=git(service,'rev-parse','HEAD');
  if(change.nested){git(sourceRoot,'update-index','--skip-worktree','outside.txt');rmSync(join(sourceRoot,'outside.txt'));}
  // The machine mounts the controller by gitlink, and its definition names what it runs.
  writeFileSync(join(snapshot,'machine.json'),JSON.stringify({repository:'fixture/machine',run:{entries:['@red-cup-engineering/guix-machine-release-service']}}));
  writeFileSync(join(snapshot,'.gitmodules'),'[submodule "controller"]\n\tpath = controller\n\turl = https://github.com/red-cup-engineering/guix-machine-release-service.git\n');
  writeFileSync(join(snapshot,'README.md'),'initial');git(snapshot,'add','.');
  git(snapshot,'update-index','--add','--cacheinfo',`160000,${change.wrongCommit?'a'.repeat(40):commit},controller`);git(snapshot,'commit','-m','baseline');
  mkdirSync(join(snapshot,'controller')); // an uninitialized submodule is checked out as an empty directory
  writeFileSync(join(snapshot,'README.md'),'reviewed candidate');git(snapshot,'add','README.md');git(snapshot,'commit','-m','admitted snapshot');const revision=git(snapshot,'rev-parse','HEAD');
  git(snapshot,'remote','add','origin',snapshot);
  const effects=join(root,'effects'),forbidden=join(root,'forbidden');
  for(const command of ['guix','ssh','scp','systemctl','install'])writeFileSync(join(bin,command),
    `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(process.env.CONTROLLER_FORBIDDEN,${JSON.stringify(command+'\n')});process.exit(99);\n`,{mode:0o755});
  // Admission reads pull requests through GraphQL (github-reads.mjs); any other gh use is forbidden.
  const pulls=change.noAdmission?[]:[{number:1,url:'https://example.invalid/reviewed-machine',mergedAt:'2026-10-08T00:00:00Z',mergeCommit:{oid:revision},baseRefName:'main',mergedBy:null}];
  writeFileSync(join(bin,'gh'),`#!/usr/bin/env node\nconst fs=require('node:fs');if(process.argv[2]!=='api'||process.argv[3]!=='graphql'){fs.appendFileSync(process.env.CONTROLLER_FORBIDDEN,'gh nonread\\n');process.exit(99);}const q=JSON.parse(fs.readFileSync(0,'utf8')).query,nodes=${JSON.stringify(pulls)};console.log(JSON.stringify({data:{repository:q.includes('associatedPullRequests')?{object:{associatedPullRequests:{nodes}}}:q.includes('pullRequests(')?{pullRequests:{nodes}}:{pullRequest:nodes[0]?{...nodes[0],state:'MERGED',headRefOid:nodes[0].mergeCommit.oid}:null}}}));\n`,{mode:0o755});
  if(change.dirty)writeFileSync(join(service,'package.json'),'{}');
  if(change.dirtyBootstrap){const p=join(service,'scripts/controller-bootstrap.sh');writeFileSync(p,bootstrapCanary+readFileSync(p,'utf8'));}
  if(change.untracked)writeFileSync(join(service,'test/unreviewed.test.mjs'),'throw new Error("must not execute");');
  if(change.ignored){
    writeFileSync(join(sourceRoot,'.git/info/exclude'),'test/unreviewed.test.mjs\n');
    writeFileSync(join(service,'test/unreviewed.test.mjs'),'throw new Error("must not execute ignored file");');
  }
  if(change.snapshotUntracked)writeFileSync(join(snapshot,'unreviewed.json'),'{}');
  if(change.snapshotIgnored){
    writeFileSync(join(snapshot,'.git/info/exclude'),'unreviewed.json\n');writeFileSync(join(snapshot,'unreviewed.json'),'{}');
  }
  if(change.assumeUnchanged||change.skipWorktree){
    git(service,'update-index',change.assumeUnchanged?'--assume-unchanged':'--skip-worktree','test/canary.test.mjs');
    writeFileSync(join(service,'test/canary.test.mjs'),'throw new Error("unreviewed tracked bytes must not execute");');
  }
  if(change.snapshotAssume){git(snapshot,'update-index','--assume-unchanged','machine.json');writeFileSync(join(snapshot,'machine.json'),'{}');}
  const env={...process.env,PATH:bin+':'+process.env.PATH,HOME:root,GITHUB_REF:change.wrongRef?'refs/heads/unreviewed':'refs/heads/main',
    GITHUB_SHA:revision,GITHUB_REPOSITORY:'fixture/machine',CONTROLLER_EFFECTS:effects,CONTROLLER_FORBIDDEN:forbidden,
    GITHUB_STEP_SUMMARY:join(root,'summary')};
  if(change.filterTests)env.NODE_OPTIONS='--test-name-pattern=^no_such_test$';
  if(change.npmNodeOptions)env.npm_config_node_options='--test-name-pattern=^no_such_test$';
  if(change.npmShell||change.npmUserConfig){
    const shell=join(bin,'unreviewed-shell');writeFileSync(shell,'#!/bin/sh\necho npm-shell >> "$CONTROLLER_FORBIDDEN"\nexit 99\n',{mode:0o755});
    if(change.npmShell)env.npm_config_script_shell=shell;
    if(change.npmUserConfig)writeFileSync(join(root,'.npmrc'),'script-shell='+shell+'\nnode-options=--test-name-pattern=^no_such_test$\n');
  }
  if(change.receiptSymlink){mkdirSync(work);writeFileSync(join(root,'outside-result'),'untouched');symlinkSync(join(root,'outside-result'),join(work,'controller-test.json'));}
  return {root,service,snapshot,work,commit,revision,effects,forbidden,env};
}

for(const change of [{},{nested:true},{filterTests:true},{npmNodeOptions:true},{npmShell:true},{npmUserConfig:true},{workInSource:true},{receiptSymlink:true},{wrongRef:true},{wrongCommit:true},{wrongCommit:true,bootstrapCanary:true},{dirty:true},{dirtyBootstrap:true},{untracked:true},{ignored:true},{snapshotUntracked:true},{snapshotIgnored:true},{assumeUnchanged:true},{skipWorktree:true},{snapshotAssume:true},{command:'node arbitrary.mjs'},{failTest:true},{failGuile:true}]){
  test(`fixed controller test mode: ${JSON.stringify(change)}`,()=>{
    const f=fixture(change);
    try{
      const r=spawnSync(process.execPath,[join(f.service,'scripts/test-controller.mjs'),f.snapshot,f.work],{env:f.env,encoding:'utf8',timeout:30000});
      assert.equal(existsSync(f.forbidden),false,'no Guix assembly, transfer, service or promotion commands');
      const rejected=change.nested||change.workInSource||change.receiptSymlink||change.wrongRef||change.wrongCommit||change.dirty||change.dirtyBootstrap||change.untracked||change.ignored||change.snapshotUntracked||change.snapshotIgnored||change.assumeUnchanged||change.skipWorktree||change.snapshotAssume||change.noAdmission||change.command;
      if(rejected){
        assert.notEqual(r.status,0);assert.equal(existsSync(f.effects),false,'rejected before declared tests');
        assert.equal(existsSync(f.work),Boolean(change.receiptSymlink),'no new receipt-area creation');
        if(change.receiptSymlink)assert.equal(readFileSync(join(f.root,'outside-result'),'utf8'),'untouched');return;
      }
      assert.equal(existsSync(join(f.work,'controller-test.json')),true,r.stderr);
      const receipt=JSON.parse(readFileSync(join(f.work,'controller-test.json')));
      assert.equal(readFileSync(f.effects,'utf8'),'package-tests\n','the declared test body actually ran');
      assert.equal(receipt.machineCommit,f.revision);assert.equal(receipt.controllerCommit,f.commit);
      assert.equal(receipt.controllerRepository,'red-cup-engineering/guix-machine-release-service');
      if(change.failTest||change.failGuile){
        assert.notEqual(r.status,0,r.stdout+'\n'+r.stderr);assert.equal(receipt.outcome,'failed');assert.equal(receipt.stage,change.failTest?'package-tests':'health-reading');
      }else{
        assert.equal(r.status,0,r.stderr);assert.equal(receipt.outcome,'passed');
        assert.deepEqual(receipt.checks,['package-tests','health-reading','controller-owner']);
      }
    }finally{rmSync(f.root,{recursive:true,force:true});}
  });
}

function assertNativeTestPhaseOrder(source){
  const dispatch=source.indexOf('(match (cdr (command-line))');
  const start=source.indexOf('(when (member mode \'("test" "test-toolchain"))',dispatch);
  const end=source.indexOf('(exit 0))',start);
  assert.ok(dispatch>=0&&start>dispatch&&end>start,'the native test dispatch and successful exit must exist');
  // Bind the boundary to the actual effectful phases, not a local let binding
  // that can be renamed when the source-graph reader changes.
  for(const program of ['materialize-sources.mjs','scripts/prepare-sources.mjs','scripts/assemble.mjs']){
    const phase=source.indexOf('"/'+program+'"',dispatch);
    assert.ok(phase>=0,`the ${program} phase must exist`);
    assert.ok(end<phase,`native tests must exit before ${program}`);
  }
  const branch=source.slice(start,end);
  assert.match(branch,/test-controller\.mjs/);
  assert.doesNotMatch(branch,/receive\.scm|assemble|copy|systemctl|prepare-sources/);
}

test('native test mode branches before assembly and invokes only the fixed test program',()=>{
  assertNativeTestPhaseOrder(readFileSync(new URL('../scripts/github-machine-release.scm',import.meta.url),'utf8'));
});

test('native test phase guard refuses missing and premature assembly phases',()=>{
  const source=readFileSync(new URL('../scripts/github-machine-release.scm',import.meta.url),'utf8');
  for(const program of ['materialize-sources.mjs','scripts/prepare-sources.mjs','scripts/assemble.mjs']){
    const marker='"/'+program+'"';
    assert.throws(()=>assertNativeTestPhaseOrder(source.replaceAll(marker,'"/missing-phase.mjs"')),new RegExp(`the ${program.replaceAll('.', '\\.')} phase must exist`));
    const early=source.replace('(when (member mode \'("test" "test-toolchain"))',`(run "node" ${marker})\n    (when (member mode '("test" "test-toolchain"))`);
    assert.throws(()=>assertNativeTestPhaseOrder(early),new RegExp(`native tests must exit before ${program.replaceAll('.', '\\.')}`));
  }
});
