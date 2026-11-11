import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {projectControllerBootstrap,controllerBootstrap} from '../scripts/project-controller-bootstrap.mjs';

// The workflow bootstrap is shell and git: it reads the controller from the machine repository's gitlink. Each case
// is a real machine repository; the fixture git passes every call to Git but records clone and fetch and stops there.
const bootstrap=fileURLToPath(new URL('../scripts/controller-bootstrap.sh',import.meta.url));
const CONTROLLER='red-cup-engineering/guix-machine-release-service';
const realGit=spawnSync('sh',['-c','command -v git'],{encoding:'utf8'}).stdout.trim();
// A gitlink always records a full commit, so only the cases a repository can carry are run here; the Guile reader
// covers the rest (test/controller-owner.scm).
const cases=JSON.parse(readFileSync(new URL('./fixtures/controller-owner.json',import.meta.url)))
  .filter((fixture)=>(fixture.spec.repositories??[]).every((source)=>/^[0-9a-f]{40}$/u.test(source.commit??'')));
const machineRepository=(cwd,repositories)=>{
  const run=(...args)=>{const r=spawnSync(realGit,['-C',cwd,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
  run('init','-q','--initial-branch=main','.');run('config','user.name','Fixture');run('config','user.email','fixture@example.invalid');run('config','commit.gpgsign','false');
  const mounted=repositories.filter((source)=>source.repository!=='561-group/bare-cedar-fog');
  writeFileSync(join(cwd,'.gitmodules'),mounted.map((source,k)=>`[submodule "m${k}"]\n\tpath = m${k}\n\turl = https://github.com/${source.repository}.git\n`).join(''));
  run('add','.gitmodules');
  mounted.forEach((source,k)=>run('update-index','--add','--cacheinfo',`160000,${source.commit},m${k}`));
  run('commit','-q','--allow-empty','-m','machine');
};

// Real Git handles every operation; this trusted fixture reader rewrites only
// the fixed clone URL to its disposable file-only repository.
function fixtureReader(root,source){
  const bin=join(root,'reader-bin');mkdirSync(bin);
  writeFileSync(join(bin,'git'),`#!${process.execPath}\nconst a=process.argv.slice(2).map(x=>x===${JSON.stringify('https://github.com/'+CONTROLLER+'.git')}?${JSON.stringify('file://'+source)}:x);if(a.includes('clone')&&(process.env.GH_TOKEN!=='inert-gh-token'||process.env.GITHUB_TOKEN!=='inert-github-token'||process.env.GH_CONFIG_DIR!==${JSON.stringify(join(root,'gh-config'))}))process.exit(91);const r=require('node:child_process').spawnSync(${JSON.stringify(realGit)},['-c','protocol.file.allow=always',...a],{stdio:'inherit'});process.exit(r.status??1);\n`,{mode:0o755});
  return bin+':'+process.env.PATH;
}

for(const fixture of cases)test(`bootstrap owner: ${fixture.name}`,()=>{
  const cwd=mkdtempSync(join(tmpdir(),'controller-owner-'));
  try{
    machineRepository(cwd,fixture.spec.repositories??[]);
    const bin=join(cwd,'.bin'),marker=join(cwd,'.git','fixture-calls');mkdirSync(bin);
    writeFileSync(join(bin,'git'),`#!/usr/bin/env node\nconst fs=require('node:fs'),a=process.argv.slice(2);if(a.includes('clone')||a.includes('fetch')){fs.appendFileSync(${JSON.stringify(marker)},a.join(' ')+'\\n');if(a.includes('clone')){fs.mkdirSync(a.at(-1)+'/.git',{recursive:true});process.exit(0)}process.exit(98)}const r=require('node:child_process').spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});process.exit(r.status??1);\n`,{mode:0o755});
    const env={...process.env,HOME:cwd,PATH:bin+':'+process.env.PATH,CONTROLLER_TEST_MARKER:marker,GITHUB_ENV:join(cwd,'github-env'),
      GITHUB_REPOSITORY:'fixture/machine',GITHUB_SHA:'b'.repeat(40)};
    const result=spawnSync('bash',['-e','-s'],{cwd,encoding:'utf8',env,input:controllerBootstrap()});
    assert.notEqual(result.status,0,'the fixture git stops every run at its fetch');
    if(fixture.accepted){
      const commit=fixture.spec.repositories.find((source)=>source.repository===CONTROLLER).commit;
      const calls=readFileSync(marker,'utf8');
      assert.match(calls,new RegExp(`clone -q --filter=blob:none --no-checkout https://github\\.com/${CONTROLLER.replace(/[.]/gu,'\\.')}\\.git `),result.stderr);
      assert.match(calls,new RegExp(`fetch -q --depth=1 origin ${commit}`));
    }else{
      assert.ok(!existsSync(marker),'refusal occurs before clone/fetch');
    }
  }finally{rmSync(cwd,{recursive:true,force:true});}
});

test('current bootstrap projection retains effects and refuses retired or ambiguous carriers',()=>{
  const shell=readFileSync(bootstrap,'utf8');
  const block=shell.trimEnd().split('\n').map(line=>'          '+line).join('\n');
  const before='name: retained\n'+block+'\n          following command\n';
  const after=projectControllerBootstrap(before);
  assert.ok(after.startsWith('name: retained\n'));assert.ok(after.endsWith('\n          following command\n'));
  assert.ok(after.includes('RELEASE_CONTROLLER="$service"'));assert.equal(projectControllerBootstrap(after),after);
  for(const text of ['no bootstrap here','          bootstrap="old"\n          service="$bootstrap/computer/old-path"\n',
    '          service="$(python3 - <<\'PYCODE\'\n          print("x")\n          PYCODE\n          )"\n',
    before+before,before.replace('# End controller bootstrap.','missing terminator'),
    before.replace('controller_repository=','\n      - name: another step\n          controller_repository=')])
    assert.throws(()=>projectControllerBootstrap(text),/exactly one current/);
});

test('bootstrap materializes the exact commit the machine mounts, using Git',()=>{
  const root=mkdtempSync(join(tmpdir(),'controller-bootstrap-'));
  const run=(program,args,options={})=>{
    const result=spawnSync(program,args,{encoding:'utf8',...options});
    assert.equal(result.status,0,result.stderr);return result.stdout.trim();
  };
  try{
    const source=join(root,'source'),snapshot=join(root,'snapshot');
    for(const directory of [source,snapshot])mkdirSync(directory);
    run('git',['init','--initial-branch=main',source]);
    const git=(...args)=>run('git',['-C',source,...args]);
    git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('config','commit.gpgsign','false');
    writeFileSync(join(source,'package.json'),JSON.stringify({name:'@red-cup-engineering/guix-machine-release-service'}));
    writeFileSync(join(source,'owned.txt'),'exact reviewed source');
    git('add','.');git('commit','-m','reviewed controller');const commit=git('rev-parse','HEAD');
    git('config','uploadpack.allowAnySHA1InWant','true');
    writeFileSync(join(source,'owned.txt'),'uncommitted material must not arrive');
    machineRepository(snapshot,[{repository:'red-cup-engineering/guix-machine-release-service',commit}]);
    // Only the fixed clone URL is redirected by the explicit fixture reader; acquisition and checkout are real Git.
    const env={...process.env,HOME:root,GITHUB_REPOSITORY:'fixture/machine',GITHUB_SHA:'b'.repeat(40),GITHUB_ENV:join(root,'github-env'),GH_TOKEN:'inert-gh-token',GITHUB_TOKEN:'inert-github-token',GH_CONFIG_DIR:join(root,'gh-config'),
      PATH:fixtureReader(root,source)};
    run('bash',['-e','-s'],{cwd:snapshot,env,input:controllerBootstrap()});
    const service=readFileSync(join(root,'github-env'),'utf8').match(/^RELEASE_CONTROLLER=(.*)$/mu)[1];
    assert.equal(readFileSync(join(service,'owned.txt'),'utf8'),'exact reviewed source');
    assert.equal(run('git',['-C',service,'rev-parse','HEAD']),commit);
    assert.equal(JSON.parse(readFileSync(join(service,'package.json'))).name,'@red-cup-engineering/guix-machine-release-service');
  }finally{rmSync(root,{recursive:true,force:true});}
});


test('raw bootstrap is a refused template even with an ambient weaker gate',()=>{
  const root=mkdtempSync(join(tmpdir(),'unprojected-controller-'));
  try{
    const marker=join(root,'effect');
    const result=spawnSync('bash',['-e','-s'],{cwd:root,encoding:'utf8',input:
      `verify_release_source() { touch "${marker}"; }; export -f verify_release_source\n`+readFileSync(bootstrap,'utf8')});
    assert.notEqual(result.status,0);assert.match(result.stderr,/Unprojected controller bootstrap refused/);
    assert.ok(!existsSync(marker));
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('bootstrap generation has a strict deferred invocation contract',()=>{
  const deferred=controllerBootstrap(undefined,{defer:true});
  assert.match(deferred,/# Invocation: deferred/);
  assert.ok(!deferred.includes('\nresolve_release_controller\n'));
  const workflow=deferred.split('\n').map(line=>'          '+line).join('\n');
  assert.equal(projectControllerBootstrap(workflow),workflow);
  assert.throws(()=>projectControllerBootstrap(workflow.replace('Invocation: deferred','Invocation: unknown')),/invocation contract/);
  assert.throws(()=>projectControllerBootstrap(workflow.replace('Invocation: deferred','Invocation: deferred\n          # Invocation: immediate')),/invocation contract/);
  for(const options of [{defer:'true'},{command:'anything'},null])assert.throws(()=>controllerBootstrap(undefined,options),/option/);
  assert.throws(()=>controllerBootstrap(readFileSync(bootstrap,'utf8').replace('Unprojected controller bootstrap refused','changed template')),/current unprojected/);
});

for(const mutation of ['clean reuse','clean filtered reuse','dirty tracked bytes','untracked module','ignored module','assume-unchanged bytes','skip-worktree bytes','hidden executable mode','hidden verifier replacement','dirty cache fsmonitor','dirty clean filter','dirty process filter','staged-only edit','nested git directory'])
  test(`projected owner bootstrap gates reused cache: ${mutation}`,()=>{
    const root=mkdtempSync(join(tmpdir(),'controller-cache-'));
    const run=(program,args,options={})=>{
      const result=spawnSync(program,args,{encoding:'utf8',...options});assert.equal(result.status,0,result.stderr);return result.stdout.trim();
    };
    try{
      const source=join(root,'source'),snapshot=join(root,'snapshot');
      mkdirSync(source);mkdirSync(snapshot);
      const git=(directory,...args)=>run(realGit,['-C',directory,...args]);
      git(source,'init','-q','--initial-branch=main');git(source,'config','user.name','Fixture');git(source,'config','user.email','fixture@example.invalid');git(source,'config','commit.gpgsign','false');
      writeFileSync(join(source,'package.json'),JSON.stringify({name:'@red-cup-engineering/guix-machine-release-service'}));
      const canary='const accepted=true; import {appendFileSync} from "node:fs"; appendFileSync(process.env.CONTROLLER_EFFECT,"executed\\n");\n';
      writeFileSync(join(source,'selected.mjs'),canary);
      writeFileSync(join(source,'.gitattributes'),'selected.mjs filter=fixture\n');
      mkdirSync(join(source,'scripts'));writeFileSync(join(source,'scripts','verify-release-source.mjs'),'throw new Error("Cache verifier must never be imported");\n');
      git(source,'add','.');git(source,'commit','-qm','reviewed controller');const commit=git(source,'rev-parse','HEAD');
      git(source,'config','uploadpack.allowAnySHA1InWant','true');
      machineRepository(snapshot,[{repository:CONTROLLER,commit}]);
      const envFile=join(root,'github-env'),effect=join(root,'executed'),exitState=join(root,'exit-state');
      const env={...process.env,HOME:root,GITHUB_REPOSITORY:'fixture/machine',GITHUB_SHA:'b'.repeat(40),GITHUB_ENV:envFile,GH_TOKEN:'inert-gh-token',GITHUB_TOKEN:'inert-github-token',GH_CONFIG_DIR:join(root,'gh-config'),GIT_CONFIG_SYSTEM:join(root,'git-system-config'),CONTROLLER_EFFECT:effect,CONTROLLER_EXIT_STATE:exitState,RELEASE_CONTROLLER:'/stale/ambient/controller',
        PATH:fixtureReader(root,source),GIT_CONFIG_COUNT:'2',GIT_CONFIG_KEY_0:'filter.fixture.process',GIT_CONFIG_VALUE_0:join(root,'ambient-filter'),GIT_CONFIG_KEY_1:'filter.fixture.required',GIT_CONFIG_VALUE_1:'true'};
      const filter=join(root,'ambient-filter');writeFileSync(filter,`#!/bin/sh\necho ambient-filter >> "${effect}"\nexit 1\n`,{mode:0o755});
      for(const file of ['.gitconfig','git-system-config'])writeFileSync(join(root,file),`[filter "fixture"]\n  process = ${filter}\n  required = true\n`);
      const script=controllerBootstrap();
      run('bash',['-e','-s'],{cwd:snapshot,env,input:script});assert.ok(!existsSync(effect),'fresh acquisition does not execute ambient global/environment filters');
      const service=readFileSync(envFile,'utf8').match(/^RELEASE_CONTROLLER=(.*)$/mu)[1];
      const selected=join(service,'selected.mjs');
      if(mutation==='dirty tracked bytes')writeFileSync(selected,canary+'// dirty\n');
      if(mutation==='untracked module')writeFileSync(join(service,'untracked.mjs'),canary);
      if(mutation==='ignored module'){
        writeFileSync(join(service,'.git','info','exclude'),'ignored.mjs\n');writeFileSync(join(service,'ignored.mjs'),canary);
      }
      if(mutation==='assume-unchanged bytes'||mutation==='skip-worktree bytes'){
        git(service,'update-index',mutation==='assume-unchanged bytes'?'--assume-unchanged':'--skip-worktree','selected.mjs');
        writeFileSync(selected,canary+'// hidden changed bytes\n');
      }
      if(mutation==='hidden executable mode'){
        git(service,'config','core.filemode','false');git(service,'update-index','--assume-unchanged','selected.mjs');chmodSync(selected,0o755);
      }
      if(mutation==='clean filtered reuse'||mutation==='dirty clean filter'||mutation==='dirty process filter'){
        const filter=join(root,'filter');writeFileSync(filter,`#!/bin/sh\necho unverified-filter >> "${effect}"\ncat\n`,{mode:0o755});
        git(service,'config',mutation==='dirty clean filter'?'filter.fixture.clean':'filter.fixture.process',filter);
        if(mutation==='clean filtered reuse')git(service,'config','remote.origin.url','file://'+join(root,'absent-remote'));
        else writeFileSync(selected,canary.replace('true','null')); // Same size forces Git's conversion path.
      }
      if(mutation==='staged-only edit'){
        writeFileSync(selected,canary+'// staged\n');git(service,'add','selected.mjs');writeFileSync(selected,canary);
      }
      if(mutation==='nested git directory'){
        mkdirSync(join(service,'scripts','.git'));writeFileSync(join(service,'scripts','.git','hidden.mjs'),canary);
      }
      if(mutation==='dirty cache fsmonitor'){
        const hook=join(root,'fsmonitor');writeFileSync(hook,`#!/bin/sh\necho unverified-hook > "${effect}"\n`,{mode:0o755});
        git(service,'config','core.fsmonitor',hook);writeFileSync(selected,canary+'// dirty\n');
      }
      if(mutation==='hidden verifier replacement'){
        git(service,'update-index','--assume-unchanged','scripts/verify-release-source.mjs');
        writeFileSync(join(service,'scripts','verify-release-source.mjs'),canary+'export const verifyTrustedSource=()=>true;\n');
      }
      writeFileSync(envFile,'');
      // Refusal must not depend on the consumer remembering shell errexit.
      const result=spawnSync('bash',['-s'],{cwd:snapshot,env,encoding:'utf8',input:'trap \'printf "%s" "${RELEASE_CONTROLLER-unset}" > "$CONTROLLER_EXIT_STATE"\' EXIT\n'+script+'\nnode "$RELEASE_CONTROLLER/selected.mjs"\n'});
      if(mutation==='clean reuse'||mutation==='clean filtered reuse'){
        assert.equal(result.status,0,result.stderr);assert.equal(readFileSync(effect,'utf8'),'executed\n');
        assert.match(readFileSync(envFile,'utf8'),/^RELEASE_CONTROLLER=/);assert.equal(readFileSync(exitState,'utf8'),service);
      }else{
        assert.notEqual(result.status,0,mutation+' must refuse');assert.match(result.stderr,/trusted source identity or bytes refused|would be overwritten/);
        assert.equal(readFileSync(envFile,'utf8'),'','no execution path published');assert.equal(readFileSync(exitState,'utf8'),'unset','stale ambient controller path is cleared');assert.ok(!existsSync(effect),'selected or cache-verifier code never executes');
      }
    }finally{rmSync(root,{recursive:true,force:true});}
  });
