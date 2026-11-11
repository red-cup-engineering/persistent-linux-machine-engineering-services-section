#!/usr/bin/env node
// Test a change the way a machine will receive it. Two workspaces are composed, installed and built the
// way assemble.mjs builds a release: the machine exactly as pinned (the base, composed when needed), and the
// machine with each changed repository at its checkout's commit (the head). The tests of every package
// the change touches run in the head; a file that fails there is a regression when it passes in the
// base or the base has no such package, and belongs to the base when it fails there too.
//
//   node scripts/test-change.mjs SNAPSHOT WORK OWNER/REPO=PATH [OWNER/REPO=PATH ...]
//
// PATH is a git checkout whose HEAD is the commit to test; every other repository is cloned at its pin.
// Prints a JSON verdict and exits 1 on a regression or when the change cannot be composed.
import {comparisonSources} from './materialize-sources.mjs';
import {packageReceivingChecks,packageReceivingEnvironment,receivingTestPaths,manifestIdentity,sha256,gitBlobIdentity} from './package-receiving.mjs';
import {spawnSync} from 'node:child_process';
import {accessSync,constants,cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,relative,resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isCliEntry} from './cli-entry.mjs';
import {classifyBreak} from './assembly-breaks.mjs';
import {sourcedPackageManifest,packageSources,selectedSources} from './prepare-sources.mjs';
import {FROZEN_PNPM_VERSION,entryGuardReader,legacyKept,misfoldReader,ratchet,readDesignRules,wiringReader} from './design-rules.mjs';
import {realizeToolchain} from './qualify-toolchain.mjs';
import {hasTypeScriptBuild} from './typescript-build.mjs';

const TEST_TIMEOUT_MS=180_000;

function run(program,args,options={}){
  const r=spawnSync(program,args,{encoding:'utf8',maxBuffer:256*1024*1024,...options});
  if(r.error||r.status!==0)throw Object.assign(r.error??new Error(`${program} ${args[0]} failed (${r.status}): ${(r.stderr||r.stdout||'').slice(-3000)}`),
    {commandStderr:r.stderr??'',commandStdout:r.stdout??''});
  return r.stdout.trim();
}
const sourceReadEnvironment=()=>({PATH:process.env.PATH,LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',
  GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_ALLOW_PROTOCOL:'file',GIT_OPTIONAL_LOCKS:'0'});
const git=(directory,...args)=>run('git',['-c','core.hooksPath=/dev/null',...args],{cwd:directory,env:sourceReadEnvironment()});
const slug=repository=>repository.replaceAll('/','_');
const packageDirectory=(workspace,name)=>join(workspace,'packages',name.replaceAll('/','__'));

/** Each changed file's nearest enclosing package, read from the changed commit's tree. */
export function changedPackages(manifests,files){
  const roots=[...manifests.keys()].sort((a,b)=>b.length-a.length);
  const touched=new Map();
  for(const file of files){
    const root=roots.find(r=>r===''?true:file===r||file.startsWith(r+'/'));
    if(root!==undefined)touched.set(root,manifests.get(root));
  }
  return touched;
}

/** A file is a regression when it fails with the change and passes at the base, or has no base. */
export function verdictOf(head,base){
  const regressions=[],preexisting=[];
  for(const [file,ok] of head)if(!ok)(base.get(file)===false?preexisting:regressions).push(file);
  return {regressions,preexisting};
}

/** The pinned commits a changed commit lacks, or null when it descends from the pin. A change that does not
 *  descend from the machine's pin would be compared against a newer machine: every commit the pin carries and
 *  the change lacks would read as the change reverting it, so there is nothing honest to compare. */
export function behindPin(directory,pin,commit,origin){
  const has=c=>{try{git(directory,'cat-file','-e',`${c}^{commit}`);return true;}catch{return false;}};
  // The pin's history is needed to answer, not just its tree.
  if(!has(pin)&&origin)try{git(directory,'fetch','-q','--filter=blob:none',origin,pin);}catch{}
  if(!has(pin))return {missing:[],count:null,reason:`the pinned commit ${pin} is not reachable from the change's repository`};
  const ancestor=spawnSync('git',['-C',directory,'merge-base','--is-ancestor',pin,commit],{env:sourceReadEnvironment()});
  if(ancestor.status===0)return null;
  const missing=git(directory,'log','--format=%H %s',pin,`^${commit}`).split('\n').filter(Boolean);
  return {missing:missing.slice(0,20).map(line=>({commit:line.slice(0,40),subject:line.slice(41)})),count:missing.length};
}

export function packageManifests(directory,commit,mountedPath='.'){
  const manifests=new Map();
  for(const file of git(directory,'ls-tree','-r','--name-only',commit).split('\n')){
    // Attribute changes only to the executable owners preparation admits.
    if(!sourcedPackageManifest(file,mountedPath))continue;
    try{const m=JSON.parse(git(directory,'show',`${commit}:${file}`));if(m.name)manifests.set(file==='package.json'?'':file.slice(0,-'/package.json'.length),m.name);}catch{}
  }
  return manifests;
}

/** The package names the machine's own entries select from these sources, or null when they cannot be read. */
/** The machine's closure splits a change: packages inside it are composed and compared, packages outside it are
 *  installed on neither side, only reported. Without a readable closure every changed package counts as inside. */
export function splitByClosure(changed,inside){
  if(!inside)return {within:changed,outside:[]};
  return {within:changed.filter(c=>inside.has(c.name)),outside:changed.filter(c=>!inside.has(c.name))};
}
/** What the base is asked to build: the changed packages inside the closure that the pins carry at the same root
 *  (a package the change adds has no base). */
export function baseRequest(within,atPins){return within.filter(c=>atPins.get(c.name)===c.root);}

function machineClosure(spec,repositories){
  try{return new Set(selectedSources(packageSources(repositories),[...(spec.entries??[]),...(spec.buildEntries??[])]).keys());}
  catch{return null;}
}

/** The environment PR-head code runs in (its builds, generators and tests): the runner's GitHub credentials
 * are not handed to it. The token variables are dropped and gh reads an empty configuration directory. */
export const CREDENTIAL_VARIABLES=Object.freeze(['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN']);
export function untrustedEnvironment(environment,emptyConfig){
  const stripped=Object.fromEntries(Object.entries(environment).filter(([name])=>!CREDENTIAL_VARIABLES.includes(name)&&!/^GIT_CONFIG_(?:COUNT|KEY_|VALUE_)/u.test(name)));
  mkdirSync(emptyConfig,{recursive:true});
  return {...stripped,...(environment.HOME?{HOME:emptyConfig}:{}),GH_CONFIG_DIR:emptyConfig};
}

/** Preserve the installed profile choice before isolating Guix's HOME. */
export function changeToolchainSearchPath(environment=process.env){
  const path=environment.PATH??'',profile=environment.HOME&&join(environment.HOME,'.config/guix/current/bin/guix');
  if(profile)try{accessSync(profile,constants.X_OK);return [dirname(profile),path].filter(Boolean).join(':');}catch{}
  return path;
}

/** Delegate only to the reviewed adapter, under the selected store interpreter.
 * The adapter verifies the exact inventory and Node identity before parsing or
 * acquisition; its existing frozen source/lock/configuration guards remain final. */
export function acquireChangeDependencies({service,toolchain,workspace,work,execute=spawnSync}){
  if(typeof toolchain!=='string'||!/^\/gnu\/store\/[0-9a-z]{32}-[^/\s]+$/u.test(toolchain))
    throw new Error('change composition requires one exact Guix toolchain store path');
  const environment={HOME:work,LANG:'C.UTF-8',LC_ALL:'C.UTF-8',NODE_DISABLE_COMPILE_CACHE:'1'};
  const result=execute(join(toolchain,'bin/node'),['--no-addons','--no-global-search-paths',join(service,'scripts/design-rules.mjs'),
    '--acquire-guix-frozen',toolchain,workspace,work],{cwd:workspace,env:environment,encoding:'utf8',maxBuffer:256*1024*1024});
  if(result.error||result.status!==0)throw result.error??new Error(`frozen change acquisition refused: ${String(result.stderr||result.stdout).slice(-4000)}`);
  let receipt;try{receipt=JSON.parse(result.stdout);}catch{throw new Error('frozen change acquisition returned no readable receipt');}
  if(receipt.lockState!=='frozen'||receipt.pnpmVersion!==FROZEN_PNPM_VERSION)
    throw new Error('frozen change acquisition receipt differs from the qualified provider');
  return receipt;
}

/** Prepare, install and build a workspace the way a release is assembled (scripts/assemble.mjs). */
export function compose({service,spec,snapshot,repositories,buildEntries,workspace,work=dirname(workspace),formerNames=[],toolchain,comparison,execute=spawnSync}){
  rmSync(workspace,{recursive:true,force:true});
  const plan={...spec,repositories,buildEntries,formerNames,output:workspace,...comparison?{comparison}:{}};
  for(const stream of ['stderr','stdout'])rmSync(`${workspace}.prepare.${stream}`,{force:true});
  writeFileSync(`${workspace}.prepare.json`,JSON.stringify(plan));
  const sourceEnvironment=untrustedEnvironment({...process.env,...sourceReadEnvironment(),GIT_ALLOW_PROTOCOL:''},`${workspace}.source-config`);
  try{run(process.execPath,[join(service,'scripts/prepare-sources.mjs'),`${workspace}.prepare.json`],{env:sourceEnvironment});}
  catch(error){
    // Keep the exact committed-source plan and complete refusal evidence for
    // the owning source repair, even when the public verdict is bounded.
    writeFileSync(`${workspace}.prepare.stderr`,error.commandStderr??error.message);
    writeFileSync(`${workspace}.prepare.stdout`,error.commandStdout??'');
    throw error;
  }
  const lock=join(snapshot,'dependencies.lock.yaml');
  if(!existsSync(lock))throw new Error('reviewed dependency lock is missing; resolution remains unqualified');
  cpSync(lock,join(workspace,'pnpm-lock.yaml'));
  if(!toolchain){
    const configs=mkdtempSync(join(work,'.change-toolchain-'));
    try{toolchain=realizeToolchain({service,snapshot,home:join(configs,'home'),path:changeToolchainSearchPath(),
      query:(program,args,cwd,env)=>{
        const result=execute(program,args,{cwd,env,encoding:'utf8',maxBuffer:32*1024*1024});
        if(result.error||result.status!==0)throw result.error??new Error(`change toolchain realization refused: ${String(result.stderr||result.stdout).slice(-4000)}`);
        return result.stdout.trim();
      }});}finally{rmSync(configs,{recursive:true,force:true});}
  }
  const acquisition=acquireChangeDependencies({service,toolchain,workspace,work,execute}),nodeExecutable=join(toolchain,'bin/node');
  const buildNode=(args,options)=>{
    const result=execute(nodeExecutable,args,{encoding:'utf8',maxBuffer:256*1024*1024,...options});
    if(result.error||result.status!==0)throw result.error??new Error(`qualified change build failed: ${(result.stderr||result.stdout||'').slice(-3000)}`);
  };
  const sources=JSON.parse(readFileSync(join(workspace,'sources.json'),'utf8'));
  const providers=Object.fromEntries(sources.packages.map(p=>[p.name,packageDirectory(workspace,p.name)]));
  for(const [name,directory] of Object.entries(providers)){
    const link=join(workspace,'node_modules',name);
    if(existsSync(link))continue;
    mkdirSync(dirname(link),{recursive:true});symlinkSync(relative(dirname(link),directory),link);
  }
  const environment=untrustedEnvironment({...process.env,NODE_OPTIONS:'--max-old-space-size=384',GUIX_MACHINE_SNAPSHOT:snapshot},`${workspace}.gh-config`);
  const compiled=new Set(),building=new Set();
  const buildTypes=name=>{
    if(compiled.has(name)||building.has(name))return;
    const directory=providers[name];if(!directory)return;
    const manifest=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'));
    if(!hasTypeScriptBuild(manifest))return;
    building.add(name);
    for(const dependency of Object.keys(manifest.dependencies??{}))buildTypes(dependency);
    buildNode([join(workspace,'node_modules/typescript/bin/tsc'),'-p',join(directory,'tsconfig.build.json')],{env:environment,cwd:directory});
    building.delete(name);compiled.add(name);
  };
  for(const name of Object.keys(providers))buildTypes(name);
  const metroplat=providers['@red-cup-engineering/metroplat'];
  if(metroplat&&existsSync(join(metroplat,'scripts/generate-operation-family-descriptors.mjs')))
    buildNode([join(metroplat,'scripts/generate-operation-family-descriptors.mjs')],{env:environment,cwd:workspace});
  writeFileSync(join(workspace,'.composed'),'frozen\n');
  return {lockState:acquisition.lockState,environment,toolchain,nodeExecutable};
}

function testFiles(directory){
  const test=join(directory,'test');
  if(!existsSync(test))return [];
  return readdirSync(test,{recursive:true}).map(String).filter(f=>f.endsWith('.test.mjs')&&!f.includes('node_modules')).sort().map(f=>join('test',f));
}
function runTests(directory,files,environment,node=process.execPath){
  const results=new Map();
  for(const file of files){
    const r=spawnSync(node,['--test','--test-reporter=tap',file],{cwd:directory,env:environment,encoding:'utf8',timeout:TEST_TIMEOUT_MS,maxBuffer:64*1024*1024});
    if(r.error||r.signal||!Number.isInteger(r.status))
      throw Object.assign(new Error(`package test measurement unavailable: ${file}`),
        {code:'ERR_TEST_MEASUREMENT_UNAVAILABLE',file,executable:node,cause:r.error,
          processErrorCode:r.error?.code??null,signal:r.signal??null,status:r.status??null,
          completedResults:results});
    results.set(file,r.status===0);
  }
  return results;
}

/** Tests execute in their genuine prepared package, including authored mounts. */
export function runPackageTests({files,directory,environment,node=process.execPath}){
  return runTests(directory,files,environment,node);
}

/** Machine receiving uses its authored file inventory and byte admission,
 * not the changed-package test-directory convention. Validate all before any run. */
export function runDeclaredReceiving(workspace,environment,execute=runTests,node=process.execPath){
  const sources=JSON.parse(readFileSync(join(workspace,'sources.json'),'utf8'));
  const checks=packageReceivingChecks(workspace,sources),results=[];
  const env=packageReceivingEnvironment(node,environment);
  for(const {name,directory,tests} of checks){
    const reading=execute(directory,tests,env,node);
    const source=sources.packages.find(source=>source.name===name);
    results.push({name,repository:source.repository,commit:source.commit,path:source.path,manifestSha256:source.sourceManifestSha256,
      tests:source.receiving.tests.map(test=>({...test})),results:[...reading].map(([file,passed])=>({file:relative(directory,file),passed}))});
  }
  return results;
}


/** Consume Code's genuine native workspace reader, not a caller success record.
 * The reader/provider and frozen installation are qualified by the invoking
 * owner. This bounded component executes package declarations only; it neither
 * admits a Guix product nor measures native target/host receiving. */
export async function runNativeDeclaredReceiving({source,graph,work,node=process.execPath,environment=process.env}){
  if(!source||!source.reader||['bytes','object','verify'].some(name=>typeof source.reader[name]!=='function')
    ||!Array.isArray(source.importerIds)||new Set(source.importerIds).size!==source.importerIds.length
    ||!Array.isArray(graph?.repositories))throw new Error('native receiving requires the live owning workspace reading and exact graph');
  const {workspace,reader}=source;
  if(typeof workspace!=='string'||!isAbsolute(workspace)||resolve(workspace)!==workspace||realpathSync(workspace)!==workspace
    ||reader.root!==workspace)throw new Error('native receiving requires canonical source custody');
  const roots=graph.repositories.filter(row=>(row.paths??[row.path]).includes('.'));
  if(roots.length!==1||roots[0].commit!==source.commit||git(workspace,'rev-parse',`${source.commit}^{tree}`)!==roots[0].tree)throw new Error('native receiving source differs from its exact graph root');
  if(typeof work!=='string'||!isAbsolute(work)||resolve(work)!==work||realpathSync(work)!==work
    ||work===workspace||work.startsWith(workspace+'/')||workspace.startsWith(work+'/'))
    throw new Error('native receiving needs separate canonical test work');
  if(typeof node!=='string'||!isAbsolute(node)||realpathSync(node)!==node)throw new Error('native receiving needs the exact qualified Node executable');
  const packages=[],names=new Set();
  const own=file=>{
    const fact=reader.object(file);
    if(!fact||fact.kind!=='blob'||!['100644','100755'].includes(fact.mode))throw new Error('native receiving requires committed regular source');
    const owners=graph.repositories.filter(row=>row.commit===fact.sourceCommit&&(row.paths??[row.path]).includes(fact.sourceRepository));
    if(owners.length!==1)throw new Error('native receiving source coordinate is not uniquely admitted');
    return {fact,owner:owners[0]};
  };
  // Admit every selected declaration before executing any of them.
  for(const id of source.importerIds){
    if(typeof id!=='string'||!(id==='.'||/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(id))
      ||id.split('/').some(part=>part==='..'||part==='.git'||(part==='.'&&id!=='.')))
      throw new Error('native importer leaves its source workspace');
    const directory=join(workspace,id);
    if(realpathSync(directory)!==directory)throw new Error('native importer is redirected');
    const file=join(directory,'package.json'),bytes=reader.bytes(file),{fact,owner}=own(file),manifest=JSON.parse(bytes);
    if(typeof manifest.name!=='string'||!manifest.name||names.has(manifest.name))throw new Error('native package name is missing or duplicated');
    names.add(manifest.name);
    if(manifest.receivingTests===undefined)continue;
    if(id==='.'&&source.filter!==undefined)throw new Error('filtered root receiving membership is unmeasured by the native owner');
    const paths=receivingTestPaths(manifest),tests=paths.map(path=>{
      const target=join(directory,path),content=reader.bytes(target),selected=own(target);
      if(selected.owner.repository!==owner.repository||selected.fact.sourceCommit!==fact.sourceCommit)
        throw new Error('native receiving declaration crosses its source owner');
      if(gitBlobIdentity(content,selected.fact.identity)!==selected.fact.identity)throw new Error('native receiving test differs from its committed source');
      return {path,gitBlob:selected.fact.identity,sha256:sha256(content)};
    });
    if(gitBlobIdentity(bytes,fact.identity)!==fact.identity)throw new Error('native receiving manifest differs from its committed source');
    packages.push({name:manifest.name,directory,repository:owner.repository,commit:fact.sourceCommit,
      path:fact.sourcePath==='package.json'?'':fact.sourcePath.slice(0,-'/package.json'.length),
      manifestSha256:manifestIdentity(manifest),tests});
  }
  await reader.verify();
  const home=mkdtempSync(join(work,'native-package-receiving-'));
  const env={...packageReceivingEnvironment(node,environment),HOME:home,TMPDIR:home,TMP:home,TEMP:home};
  const results=[];let failure;
  for(const {directory,...record} of packages){
    const row=reading=>({...record,results:[...reading].map(([file,passed])=>({file:relative(directory,file),passed}))});
    try{results.push(row(runPackageTests({directory,files:record.tests.map(test=>join(directory,test.path)),environment:env,node})));}
    catch(error){
      if(error.completedResults?.size)results.push(row(error.completedResults));
      failure=error;break;
    }
  }
  // Integrity still runs after an execution failure; mutation invalidates even
  // the partial observations and must never leave them as accepted evidence.
  await reader.verify();
  if(failure){failure.partialReceiving=results;throw failure;}
  return results;
}

/** Measured native package comparison; target/product admission is deliberately
 * still unmeasured. This result cannot authorize a machine merge or activation. */
export async function compareNativeDeclaredReceiving({baseline,candidate}){
  const receiving={unmeasured:true},unread=[];
  // Keep each independent observation. An unavailable side is never an empty
  // inventory: it cannot establish added, removed, preexisting or regressed tests.
  for(const [side,input] of [['baseline',baseline],['candidate',candidate]]){
    try{receiving[side]=await runNativeDeclaredReceiving(input);}
    catch(error){unread.push({side,reason:String(error?.message??error).slice(-1000),
      ...(error?.code==='ERR_TEST_MEASUREMENT_UNAVAILABLE'?{code:error.code,file:error.file,
        executable:error.executable,processErrorCode:error.processErrorCode,signal:error.signal,status:error.status}:{})});
      if(error?.partialReceiving?.length)(receiving.partial??={})[side]=error.partialReceiving;
    }
  }
  if(unread.length)receiving.unread=unread;
  else Object.assign(receiving,compareDeclaredReceiving(receiving.baseline,receiving.candidate));
  return {packages:[],receiving,...changeVerdict([],{},receiving),runtimeAcceptance:false};
}

export function receivingObligations(base,head){
  const before=new Set(base.receivingPackages??[]),after=new Set(head.receivingPackages??[]);
  const baseOwners=new Set(base.repositories.map(source=>source.repository)),headOwners=new Set(head.repositories.map(source=>source.repository));
  const definitionChanged=['definition','machineBlob','channelsBlob','lockBlob'].some(key=>base.machine?.[key]!==head.machine?.[key]);
  const topology=side=>side.graph.edges.map(({from,to,path,purpose,ref})=>({from,to,path,purpose,ref}));
  const topologyChanged=JSON.stringify(topology(base))!==JSON.stringify(topology(head));
  const selections=field=>({added:(head[field]??[]).filter(name=>!(base[field]??[]).includes(name)),
    removed:(base[field]??[]).filter(name=>!(head[field]??[]).includes(name))});
  return {entries:selections('entries'),buildEntries:selections('buildEntries'),added:[...after].filter(name=>!before.has(name)),removed:[...before].filter(name=>!after.has(name)),definitionChanged,topologyChanged,
    addedOwners:[...headOwners].filter(name=>!baseOwners.has(name)),removedOwners:[...baseOwners].filter(name=>!headOwners.has(name)),
    unmeasured:(definitionChanged||topologyChanged)&&(!before.size||!after.size)};
}

/** Preserve a removed declared test's exact baseline custody. A candidate may
 * intentionally retire an obligation, but absence cannot measure its receiving. */
export function compareDeclaredReceiving(baseline,candidate){
  const inventory=rows=>new Map(rows.flatMap(row=>row.tests.map(test=>[`${row.name}:${test.path}`,
    {name:row.name,repository:row.repository,commit:row.commit,packagePath:row.path,manifestSha256:row.manifestSha256,...test}])));
  const before=inventory(baseline),after=inventory(candidate);
  const removedTests=[...before].filter(([key])=>!after.has(key)).map(([,test])=>test);
  const addedTests=[...after].filter(([key])=>!before.has(key)).map(([,test])=>test);
  const changedTests=[...after].filter(([key,test])=>before.has(key)&&before.get(key).gitBlob!==test.gitBlob)
    .map(([key,test])=>({baseline:before.get(key),candidate:test}));
  const results=rows=>new Map(rows.flatMap(row=>row.results.map(test=>[`${row.name}:${test.file}`,test.passed])));
  return {...verdictOf(results(candidate),results(baseline)),removedTests,addedTests,changedTests};
}

/** Source ownership includes its complete mounted coordinates. A package can
 * become executable without any change to its repository commit. */
export function changedSourcePackages(base,head,deltas){
  const baseByOwner=new Map(base.map(source=>[source.repository,source])),headByOwner=new Map(head.map(source=>[source.repository,source]));
  const changed=[],atPins=new Map(),headNames=new Set();
  for(const source of base)for(const [root,name] of packageManifests(source.directory,source.commit,source.paths??source.path))atPins.set(name,root);
  for(const source of head)for(const name of packageManifests(source.directory,source.commit,source.paths??source.path).values())headNames.add(name);
  for(const delta of deltas){
    const before=baseByOwner.get(delta.repository),after=headByOwner.get(delta.repository);
    if(!after)continue;
    const manifests=packageManifests(after.directory,after.commit,after.paths??after.path);
    let touched;
    if(!before||JSON.stringify(before.paths??[before.path])!==JSON.stringify(after.paths??[after.path]))touched=manifests;
    else{
      // Read both exact commits from the fresh candidate carrier, including a
      // separately authenticated baseline object when the candidate adds history.
      try{git(after.directory,'cat-file','-e',`${before.commit}^{commit}`);}catch{git(after.directory,'fetch','-q',before.directory,before.commit);}
      touched=changedPackages(manifests,git(after.directory,'diff','--name-only',before.commit,after.commit,'--').split('\n').filter(Boolean));
    }
    for(const [root,name] of touched)changed.push({repository:after.repository,root,name});
  }
  return {changed,atPins,headNames};
}

export async function testChange({snapshot,work,changes,localSources,candidateSnapshot=snapshot,service=resolve(dirname(fileURLToPath(import.meta.url)),'..')}){
  let pair;
  try{pair=comparisonSources(snapshot,join(work,'source-graphs'),changes,{candidateSnapshot,localSources});}
  catch(error){return {kind:'change-test',snapshot:git(snapshot,'rev-parse','HEAD'),packages:[],regressions:0,verdict:'not-composed',
    break:classifyBreak(error.message)??{class:'source-graph-unavailable'},reason:error.message.slice(-3000)};}
  const {base:baseSpec,head:spec,plan}=pair,base=baseSpec.repositories,head=spec.repositories;
  const graphEvidence={sourcePlan:plan,sourcePlanSha256:pair.planSha256,baselineGraph:baseSpec.graph,candidateGraph:spec.graph};
  const preparation=side=>({kind:'guix.comparison-preparation.v1',side,plan,planSha256:pair.planSha256,baselineGraph:baseSpec.graph,candidateGraph:spec.graph});
  const baseByOwner=new Map(base.map(source=>[source.repository,source])),headByOwner=new Map(head.map(source=>[source.repository,source]));
  const changeList=plan.delta.map(({repository,candidate})=>({repository,commit:candidate?.commit??null})),behind=[];
  for(const delta of plan.delta){
    if(!delta.baseline||!delta.candidate)continue;
    const before=baseByOwner.get(delta.repository),after=headByOwner.get(delta.repository);
    const lag=behindPin(after.directory,before.commit,after.commit,before.directory);
    if(lag)behind.push({repository:delta.repository,pin:before.commit,commit:after.commit,...lag});
  }
  if(behind.length)return {kind:'change-test',snapshot:baseSpec.machine.commit,changes:changeList,...graphEvidence,
    packages:[],regressions:0,verdict:'incomplete',break:{class:'head-behind-pin',repositories:behind},
    reason:behind.map(b=>`${b.repository}@${b.commit.slice(0,9)} does not descend from the pinned ${b.pin.slice(0,9)}; merge the pinned commit into it and test again`).join('; ')};
  const {changed,atPins,headNames}=changedSourcePackages(base,head,plan.delta);
  // A changed package the machine never builds (outside the closure of its entries) is installed on neither side:
  // its own dependencies may not resolve at the pins, and it cannot regress the machine.
  const {within,outside:excluded}=splitByClosure(changed,machineClosure(spec,head));
  const outside=new Map(excluded.map(c=>[c.name,'outside the closure of the machine\'s entries; installed on neither side']));
  const buildEntries=[...new Set([...(spec.buildEntries??[]),...within.map(c=>c.name)])].sort();
  const headWorkspace=join(work,'head');
  // A name a changed repository carried at its pin and no longer carries was renamed or removed by the change.
  const formerNames=[...atPins.keys()].filter(name=>!headNames.has(name));
  const receiving=receivingObligations(baseSpec,spec),baselineClosure=machineClosure(baseSpec,base);
  receiving.removedPackages=formerNames.map(name=>({name,baselineRoot:atPins.get(name),
    disposition:baselineClosure===null?'baseline-closure-unread':baselineClosure.has(name)?'unmeasured-retired-executable':'outside-baseline-machine-closure'}));
  let composedHead;
  try{composedHead=compose({service,spec,comparison:preparation('candidate'),snapshot:candidateSnapshot,repositories:head,buildEntries,workspace:headWorkspace,work,formerNames});}
  catch(error){
    // The change cannot be assembled: name the break class prepare-sources recorded, or read it from the failure.
    const recorded=join(headWorkspace,'assembly-break.json');
    const found=existsSync(recorded)?JSON.parse(readFileSync(recorded,'utf8')):classifyBreak(error.message,{formerNames:new Set(formerNames)});
    return {kind:'change-test',snapshot:baseSpec.machine.commit,changes:changeList,...graphEvidence,packages:[],regressions:0,
      verdict:'not-composed',receiving,...(found?{break:found}:{}),reason:error.message.slice(-3000)};
  }
  // The base is the machine as pinned, asked for the changed packages it already has (a package the change
  // adds has no base). Compose it lazily once per comparison; prior test runs
  // leave mutable workspaces and cannot authorize reuse or skip source admission.
  const present=baseRequest(within,atPins);
  const baseEntries=[...new Set([...(baseSpec.buildEntries??[]),...present.map(c=>c.name)])].sort();
  const toolchain=composedHead.toolchain;
  const baseWorkspace=join(work,'base');
  let baseEnvironment=untrustedEnvironment({...process.env,GUIX_MACHINE_SNAPSHOT:snapshot},`${baseWorkspace}.gh-config`),
    baseComposed=false,baseNode;
  try{
    receiving.candidate=runDeclaredReceiving(headWorkspace,composedHead.environment,undefined,composedHead.nodeExecutable);
    receiving.candidateNode=composedHead.nodeExecutable;
    // Both side-specific enrolled contracts are observed. Removing enrollment
    // is retained as an explicit incomplete obligation, never erased by a pass.
    if((baseSpec.receivingPackages??[]).length){
      const composedBase=compose({service,spec:baseSpec,comparison:preparation('baseline'),snapshot,repositories:base,buildEntries:baseEntries,workspace:baseWorkspace,work,
        toolchain:baseSpec.machine.channelsBlob===spec.machine.channelsBlob?toolchain:undefined});baseEnvironment=composedBase.environment;baseNode=composedBase.nodeExecutable;receiving.baselineNode=baseNode;baseComposed=true;
      receiving.baseline=runDeclaredReceiving(baseWorkspace,baseEnvironment,undefined,baseNode);
    }else receiving.baseline=[];
    Object.assign(receiving,compareDeclaredReceiving(receiving.baseline,receiving.candidate));
  }catch(error){receiving.unread=error.message.slice(-1000);}
  const packages=[];
  for(const c of changed){
    if(outside.has(c.name)){packages.push({name:c.name,repository:c.repository,status:'outside-machine-closure-not-composed',reason:outside.get(c.name)});continue;}
    const directory=packageDirectory(headWorkspace,c.name);
    if(!existsSync(directory)){packages.push({name:c.name,repository:c.repository,status:'not-composed'});continue;}
    const files=testFiles(directory);let headResults;
    try{
      headResults=runPackageTests({name:c.name,files,workspace:headWorkspace,directory,repositories:head,environment:composedHead.environment,node:composedHead.nodeExecutable});
    }catch(error){packages.push({name:c.name,repository:c.repository,status:'test-prerequisite-failed',reason:error.message.slice(-1000)});continue;}
    const failing=[...headResults].filter(([,ok])=>!ok).map(([file])=>file);
    let baseResults=new Map();
    if(failing.length){
      if(!baseComposed){
        try{const composedBase=compose({service,spec:baseSpec,comparison:preparation('baseline'),snapshot,repositories:base,buildEntries:baseEntries,workspace:baseWorkspace,work,toolchain:baseSpec.machine.channelsBlob===spec.machine.channelsBlob?toolchain:undefined});baseEnvironment=composedBase.environment;baseNode=composedBase.nodeExecutable;baseComposed=true;}
        catch(error){packages.push({name:c.name,repository:c.repository,status:'base-not-composed',failing,reason:error.message.slice(-400)});continue;}
      }
      const baseDirectory=packageDirectory(baseWorkspace,c.name);
      if(existsSync(baseDirectory)){
        const baseFiles=failing.filter(file=>existsSync(join(baseDirectory,file)));
        try{
          baseResults=runPackageTests({name:c.name,files:baseFiles,workspace:baseWorkspace,directory:baseDirectory,repositories:base,environment:baseEnvironment,node:baseNode});
        }catch(error){packages.push({name:c.name,repository:c.repository,status:'base-test-prerequisite-failed',failing,reason:error.message.slice(-1000)});continue;}
      }
    }
    const {regressions,preexisting}=verdictOf(headResults,baseResults);
    packages.push({name:c.name,repository:c.repository,tests:files.length,passed:[...headResults.values()].filter(Boolean).length,regressions,preexisting});
  }
  // The design-rule deck as a ratchet: the machine as pinned is the baseline; the change may not add a violation.
  let designRules;
  try{
    // DRC-6 is read by the owner's misfold reader as the machine composes it; base and head are read by the same one.
    const misfolds=await misfoldReader(name=>packageDirectory(headWorkspace,name));
    // STD-ENTRY likewise: the owner's guard reader from the head composition reads base and head.
    const entryGuards=await entryGuardReader(name=>packageDirectory(headWorkspace,name));
    // PDK-4 is read by the wiring owner's reader as the change carries it, for base and head alike.
    const wiring=await wiringReader(head);
    const reading=(side,repositories,entries)=>readDesignRules({...side,repositories,buildEntries:entries},{misfolds,wiring,entryGuards}).violations;
    const {added,removed}=ratchet(reading(baseSpec,base,baseEntries),reading(spec,head,buildEntries));
    const kept=plan.delta.filter(delta=>delta.baseline&&delta.candidate).flatMap(delta=>{
      const source=headByOwner.get(delta.repository);
      return legacyKept(source.directory,source.repository,delta.baseline.commit,source.commit);
    });
    designRules={added:[...added,...kept],removed,misfold:misfolds?'read':'unread',stdEntry:entryGuards?'read':'unread',wiring:wiring?.owner??'imports-only'};
  }catch(error){designRules={unread:error.message.slice(-600)};}
  const {regressions,verdict}=changeVerdict(packages,designRules,receiving);
  return {kind:'change-test',snapshot:baseSpec.machine.commit,
    changes:changeList,...graphEvidence,
    lock:composedHead.lockState,toolchain:composedHead.toolchain,packages,receiving,designRules,regressions,verdict};
}

/** A change regresses when a test file or the design-rule deck says so; it is incomplete when any comparison could
 *  not be made: a package not composed or outside the closure, or a deck that could not be read at all (DRC-6
 *  alone reading `unread` stays informational). Only a complete reading is `no-regression`. */
export function changeVerdict(packages,designRules={},receiving={}){
  const regressions=packages.reduce((n,p)=>n+(p.regressions?.length??0),0)+(designRules.added?.length??0)+(receiving.regressions?.length??0);
  const unknown=packages.some(p=>p.status)||designRules.unread!==undefined||receiving.unread!==undefined||receiving.unmeasured===true||Boolean(receiving.removed?.length)||Boolean(receiving.removedTests?.length)||
    Boolean(receiving.entries?.removed.length)||Boolean(receiving.buildEntries?.removed.length)||
    Boolean(receiving.removedPackages?.some(row=>row.disposition!=='outside-baseline-machine-closure'));
  return {regressions,verdict:regressions?'regression':unknown?'incomplete':'no-regression'};
}

/** Enter the declared installed-channel runtime before source receiving. An ambient Node
 * may launch this command, but never prepares or tests the selected source graph. */
export function enterChangeRuntime({service,snapshot,work,arguments_,execute=spawnSync,currentExecutable=process.execPath,resolveExecutable=realpathSync}){
  mkdirSync(work,{recursive:true});
  const configs=mkdtempSync(join(work,'.change-runtime-'));
  let toolchain;
  try{
    toolchain=realizeToolchain({service,snapshot,home:join(configs,'home'),path:changeToolchainSearchPath(),
      query:(program,args,cwd,env)=>{
        const result=execute(program,args,{cwd,env,encoding:'utf8',maxBuffer:32*1024*1024});
        if(result.error||result.status!==0)throw result.error??new Error(`change runtime selection refused: ${String(result.stderr||result.stdout).slice(-4000)}`);
        return result.stdout.trim();
      }});
  }finally{rmSync(configs,{recursive:true,force:true});}
  const node=join(toolchain,'bin/node');
  if(resolveExecutable(currentExecutable)===resolveExecutable(node))return undefined;
  const result=execute(node,[join(service,'scripts/test-change.mjs'),...arguments_],
    {env:{...process.env,PATH:join(toolchain,'bin')+':'+(process.env.PATH??'')},stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.signal)throw new Error(`selected change runtime terminated by ${result.signal}`);
  if(!Number.isInteger(result.status))throw new Error('selected change runtime returned no exit status');
  return result.status;
}

if(isCliEntry(import.meta.url)){
  const [snapshot,work,...arguments_]=process.argv.slice(2);
  const carrierArguments=arguments_.filter(value=>value.startsWith('--local-sources='));
  if(carrierArguments.length>1)throw new Error('only one complete local source carrier declaration is allowed');
  const candidateArguments=arguments_.filter(value=>value.startsWith('--candidate-snapshot='));
  if(candidateArguments.length>1)throw new Error('only one exact candidate definition is allowed');
  const pairs=arguments_.filter(value=>!value.startsWith('--local-sources=')&&!value.startsWith('--candidate-snapshot='));
  if(!snapshot||!work||(!pairs.length&&!candidateArguments.length)||pairs.some(p=>!/^[^/=\s]+\/[^/=\s]+=.+$/.test(p))){
    process.stderr.write('usage: test-change.mjs SNAPSHOT WORK OWNER/REPO=PATH [OWNER/REPO=PATH ...]\n');process.exit(1);
  }
  try{
    const entered=enterChangeRuntime({service:resolve(dirname(fileURLToPath(import.meta.url)),'..'),snapshot:candidateArguments.length?resolve(candidateArguments[0].slice('--candidate-snapshot='.length)):resolve(snapshot),work:resolve(work),arguments_:process.argv.slice(2)});
    if(entered!==undefined)process.exit(entered);
    const localSources=carrierArguments.length?new Map(JSON.parse(readFileSync(carrierArguments[0].slice('--local-sources='.length),'utf8'))):undefined;
    const result=await testChange({snapshot:resolve(snapshot),work:resolve(work),localSources,candidateSnapshot:candidateArguments.length?resolve(candidateArguments[0].slice('--candidate-snapshot='.length)):resolve(snapshot),changes:new Map(pairs.map(p=>{const i=p.indexOf('=');return [p.slice(0,i),p.slice(i+1)];}))});
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
    if(result.verdict!=='no-regression')process.exitCode=1;
  }catch(error){process.stderr.write(`test-change: ${error.message}\n`);process.exitCode=1;}
}
