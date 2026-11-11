// Genuine committed source graphs; only source acquisition and Guix execution
// are injected. No network, external package, controller or application executes.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {comparisonSources} from '../../scripts/materialize-sources.mjs';
export const controllerRepository='red-cup-engineering/guix-machine-release-service';
export const nativeReading=()=>({nodeExecutable:'/gnu/store/'+('a'.repeat(32))+'-node-24.18.0/bin/node',guileExecutable:'/gnu/store/'+('b'.repeat(32))+'-guile-3.0.11/bin/guile',jsonModule:'/gnu/store/'+('c'.repeat(32))+'-guile-json-4.7.3/share/guile/site/3.0/json.scm'});
export function exactFixture(t,{duplicate=false,unmounted=false}={}){
  const path=mkdtempSync(join(tmpdir(),'exact-receiving-'));t.after(()=>rmSync(path,{recursive:true,force:true}));
  const env={PATH:process.env.PATH,HOME:path,LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ALLOW_PROTOCOL:'file',GIT_TERMINAL_PROMPT:'0'};
  const git=(directory,...args)=>{const r=spawnSync('git',['-c','core.hooksPath=/dev/null',...directory?['-C',directory]:[],...args],{encoding:'utf8',env,timeout:10000});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  const put=(directory,file,bytes)=>{mkdirSync(dirname(join(directory,file)),{recursive:true});writeFileSync(join(directory,file),bytes);};
  const commit=(directory,files={},mounts)=>{
    for(const [file,bytes] of Object.entries(files))put(directory,file,bytes);
    if(mounts){
      for(const row of git(directory,'ls-files','--stage').split('\n'))if(row.startsWith('160000 '))git(directory,'update-index','--force-remove',row.split('\t')[1]);
      put(directory,'.gitmodules',mounts.map(row=>`[submodule "${row.path}"]\n path = ${row.path}\n url = https://github.com/${row.repository}.git\n branch = ${row.ref??'main'}\n`).join(''));
    }
    git(directory,'add','.');for(const row of mounts??[]){mkdirSync(join(directory,row.path),{recursive:true});git(directory,'update-index','--add','--cacheinfo',`160000,${row.commit},${row.path}`);}
    git(directory,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','fixture','--allow-empty');
    return {commit:git(directory,'rev-parse','HEAD'),tree:git(directory,'rev-parse','HEAD^{tree}')};
  };
  const make=(name,repository,files,mounts)=>{const directory=join(path,name);mkdirSync(directory);git(directory,'init','-q','-b','main');git(directory,'remote','add','origin',`https://github.com/${repository}.git`);return {directory,repository,...commit(directory,files,mounts)};};
  const controller=make('controller',controllerRepository,{'package.json':'{"name":"@red-cup-engineering/guix-machine-release-service","version":"0.1.0"}\n'});
  const source=make('source','coesite-operations/operations-services-section',{'package.json':'{"name":"@fixture/app","version":"1.0.0"}\n','index.mjs':'export const version=1;\n'});
  const baseline={...source};Object.assign(source,commit(source.directory,{'index.mjs':'export const version=2;\n'}));
  const definition='machines/cold-red-gate',repo='561-group/cold-red-gate';
  const mounts=[{...controller,path:'controller'},...unmounted?[]:[{...baseline,path:'source'}],...duplicate?[{...baseline,path:'source-again'}]:[]];
  const machine=make('machine',repo,{[`${definition}/machine.json`]:JSON.stringify({repository:repo,run:{entries:['@fixture/app']}}),[`${definition}/machine.scm`]:'(fixture)\n',[`${definition}/channels.scm`]:'(fixed channels)\n',[`${definition}/dependencies.lock.yaml`]:'reviewed fixture lock\n'},mounts);
  const identity=({repository,commit,tree})=>({repository,commit,tree});
  const request={kind:'guix.reviewed-change-request.v2',controller:identity(controller),snapshot:{...identity(machine),definition},changes:[identity(controller),identity(source)]};
  const requestFile=join(path,'request.json'),calls=[],sources=new Map([[controller.repository,controller],[source.repository,source]]);
  const save=()=>{const bytes=JSON.stringify(request)+'\n';writeFileSync(requestFile,bytes);return createHash('sha256').update(bytes).digest('hex');};
  const options={snapshot:machine.directory,service:controller.directory,work:join(path,'result'),requestFile,requestSha256:save(),environment:env,
    qualify:()=>{calls.push(['qualify']);return {toolchain:{storePath:'/gnu/store/qualified-toolchain',nodeExecutable:nativeReading().nodeExecutable},controllerSources:nativeReading()};},
    fetch:(work,pin,change,declarations=[])=>{
      calls.push(['fetch',pin.repository,change?.commit,declarations]);const source=sources.get(pin.repository);assert.ok(source,`fixture source ${pin.repository}`);
      const directory=join(work,pin.repository.replace('/','_'));mkdirSync(dirname(directory),{recursive:true});assert.equal(existsSync(directory),false);
      git(null,'clone','-q','--no-hardlinks','--dissociate','--no-checkout',source.directory,directory);
      git(directory,'remote','set-url','origin',`https://github.com/${pin.repository}.git`);git(directory,'read-tree','--empty');git(directory,'update-ref','--no-deref','HEAD',change?.commit??pin.commit);
      const reading=commit=>({repository:pin.repository,commit,tree:git(directory,'rev-parse',`${commit}^{tree}`)});
      return {directory,pin:reading(pin.commit),selected:reading(change?.commit??pin.commit)};
    },
    testChange:options=>{
      calls.push(['test',options]);
      const pair=comparisonSources(options.snapshot,join(options.work,'source-graphs'),new Map(options.changes.map(row=>[row.repository,row.directory])),
        {candidateSnapshot:options.candidateSnapshot??options.snapshot,localSources:new Map(options.localSources)});
      return {kind:'change-test',snapshot:pair.base.machine.commit,changes:pair.plan.delta.map(({repository,candidate})=>({repository,commit:candidate?.commit??null})),
        sourcePlan:pair.plan,sourcePlanSha256:pair.planSha256,packages:[],verdict:'not-composed',reason:'inert fixture stops before Guix acquisition'};
    }};
  return {path,root:path,request,calls,options,sources,source,baseline,controller,machine,definition,git,put,commit,make,mounts,identity,save:()=>{options.requestSha256=save();},rebuild:(rows=mounts,run={entries:['@fixture/app']})=>{
    Object.assign(machine,commit(machine.directory,{[`${definition}/machine.json`]:JSON.stringify({repository:repo,run})},rows));Object.assign(request.snapshot,identity(machine));options.requestSha256=save();
  }};
}
