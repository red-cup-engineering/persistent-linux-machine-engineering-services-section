#!/usr/bin/env node
// Materialize the sources a machine releases from: the repository holding its definition, read in place at the
// release commit, and every repository mounted by gitlink, recursively, each fetched at the commit its gitlink records.
// A repository mounted inside another repository is a source as much as one the machine mounts directly; the closure
// is complete when every mounted repository's own gitlinks have been read.
//
//   materialize-sources.mjs SNAPSHOT WORK
//
// Prints the machine's sources (machine-sources.mjs's reading) with each repository's local directory. Source
// extraction reads committed Git blobs, not a checkout: every repository but the release controller is left with an
// empty working tree, so a second full source tree never lands on the machine's bounded disk.
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,lstatSync,realpathSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,join,resolve,relative} from 'node:path';
import {isCliEntry} from './cli-entry.mjs';
import {verifySnapshotSource} from './qualify-candidate-toolchain.mjs';
import {CONTROLLER_REPOSITORY,gitlinks,machineSources,mountedSourceClosure,repositoryOfUrl,directMountsOnly,commonSourceIdentity,commonSoftwareSources,nativeTargetSourceIdentity,committedSourceFileIdentity,registryConsumerSourceIdentity} from './source-pins.mjs';

const defaultRun=(program,args,input)=>{
  const r=spawnSync(program,args,{encoding:'utf8',input,maxBuffer:64*1024*1024});
  if(r.error||r.status!==0)throw r.error??new Error(`${program} ${args.join(' ')} failed (${r.status}): ${r.stderr.trim()}`);
  return r.stdout.trim();
};
const slug=repository=>encodeURIComponent(repository);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

function sourceInventory(root,path=''){
  const rows=[];
  for(const name of readdirSync(join(root,path)).sort()){
    const file=path?path+'/'+name:name,stat=lstatSync(join(root,file));
    if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile()))throw new Error(`source carrier is not regular: ${file}`);
    if(stat.isDirectory())rows.push(...sourceInventory(root,file));
    else{
      if(stat.nlink!==1)throw new Error(`source carrier shares file storage: ${file}`);
      rows.push({path:file,mode:stat.mode&0o777,bytes:stat.size,sha256:digest(readFileSync(join(root,file)))});
    }
  }
  return rows;
}

/** Export complete inert carriers for both exact source graphs. Generic mounted
 * inputs obey the same byte and custody law as their owning repositories. */
export function exportChangeSources(snapshot,work,changes=new Map(),{candidateSnapshot=snapshot,localSources,run=defaultRun,maxBytes=536870912,maxFiles=100000}={}){
  if(!(changes instanceof Map))throw new Error('source changes must name local committed carriers');
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||!Number.isSafeInteger(maxFiles)||maxFiles<1)throw new Error('source export limits must be positive integer bounds');
  const sourceRun=run;run=(program,args,input)=>sourceRun(program,program==='git'?['-c','core.hooksPath=/dev/null',...args]:args,input);
  work=resolve(work);
  if(existsSync(work))throw new Error('source export needs a fresh output directory');
  for(const input of [snapshot,candidateSnapshot,...changes.values(),...(localSources?.values()??[])]){
    const path=realpathSync(input);if(work===path||work.startsWith(path+'/')||path.startsWith(work+'/'))throw new Error('source export must be outside its input repositories');
  }
  mkdirSync(work,{recursive:true});if(realpathSync(work)!==work)throw new Error('source export output is redirected');
  const pair=comparisonSources(snapshot,join(work,'graphs'),changes,{candidateSnapshot,localSources,run});
  const git=(directory,...args)=>run('git',['-C',directory,...args]);
  const complete=(directory,commit)=>{
    const missing=git(directory,'rev-list','--objects','--missing=print','--no-object-names',commit).split('\n').filter(row=>row.startsWith('?')).map(row=>row.slice(1));
    for(let at=0;at<missing.length;at+=128)git(directory,'fetch','--quiet','--no-tags','--no-write-fetch-head','--recurse-submodules=no','--filter=blob:none','origin',...missing.slice(at,at+128));
    if(git(directory,'rev-list','--objects','--missing=print','--no-object-names',commit).split('\n').some(row=>row.startsWith('?')))
      throw new Error(`source carrier has missing objects: ${commit}`);
    return {commit,tree:git(directory,'rev-parse',`${commit}^{tree}`)};
  };
  const before=new Map(pair.base.repositories.map(source=>[source.repository,source])),after=new Map(pair.head.repositories.map(source=>[source.repository,source]));
  const sources=[];
  for(const repository of [...new Set([...before.keys(),...after.keys()])].sort()){
    const base=before.get(repository),head=after.get(repository),source=head??base,directory=join(work,'carriers',slug(repository));mkdirSync(dirname(directory),{recursive:true});
    run('git',['clone','-q','--no-hardlinks','--dissociate','--no-checkout',source.directory,directory]);
    if(base&&head&&base.commit!==head.commit)git(directory,'fetch','-q','--no-tags',base.directory,base.commit);
    git(directory,'remote','set-url','origin',`https://github.com/${repository}.git`);
    const pin=base?complete(directory,base.commit):null,selected=head?complete(directory,head.commit):null;
    git(directory,'read-tree','--empty');git(directory,'hash-object','-t','tree','-w','--stdin');git(directory,'update-ref','--no-deref','HEAD',(selected??pin).commit);
    // Source acquisition ends here. Artifact custody has no helper, credential,
    // promisor, local checkout origin, reflog, alternate object store or hook.
    writeFileSync(join(directory,'.git','config'),`[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfilemode = true\n[remote "origin"]\n\turl = https://github.com/${repository}.git\n`);
    rmSync(join(directory,'.git','logs'),{recursive:true,force:true});rmSync(join(directory,'.git','FETCH_HEAD'),{force:true});rmSync(join(directory,'.git','hooks'),{recursive:true,force:true});
    sources.push({repository,changed:changes.has(repository),path:source.path,...source.ref?{ref:source.ref}:{},directory:relative(work,directory),pin,selected});
  }
  // Only canonical independent carriers cross the job boundary, never mutable
  // preparation clones or source-reader acquisition configuration.
  rmSync(join(work,'graphs'),{recursive:true,force:true});
  const inventory=sourceInventory(work),bytesTotal=inventory.reduce((total,row)=>total+row.bytes,0);
  if(inventory.length>maxFiles||bytesTotal>maxBytes)throw new Error('source export exceeds its declared artifact size or file limit');
  const receipt={kind:'guix.change-source-carriers.v2',snapshot:pair.base.machine,candidateSnapshot:pair.head.machine,
    sourcePlan:pair.plan,sourcePlanSha256:pair.planSha256,baselineGraph:pair.base.graph,candidateGraph:pair.head.graph,
    sources,scope:'complete-code-comparison-carriers',runtimeAcceptance:false,limits:{maxBytes,maxFiles},bytesTotal,inventory};
  const bytes=JSON.stringify(receipt,null,2)+'\n';writeFileSync(join(work,'source-carriers.json'),bytes);
  const sha256=digest(bytes);verifyChangeSources(work,sha256);return {receipt,sha256};
}

/** The receiving job supplies the trusted preparation job's digest separately.
 * The artifact's own identity assertions never authenticate its bytes. */
export function verifyChangeSources(work,expectedSha256){
  work=realpathSync(work);
  if(!/^[a-f0-9]{64}$/u.test(expectedSha256))throw new Error('source export needs the independently retained preparation digest');
  const actual=sourceInventory(work).filter(row=>row.path!=='source-carriers.json');
  const bytes=readFileSync(join(work,'source-carriers.json'));
  if(digest(bytes)!==expectedSha256)throw new Error('source export differs from preparation digest');
  const receipt=JSON.parse(bytes);
  if(receipt.kind!=='guix.change-source-carriers.v2'||receipt.scope!=='complete-code-comparison-carriers'||receipt.runtimeAcceptance!==false||!Array.isArray(receipt.inventory)||!Array.isArray(receipt.sources))
    throw new Error('unsupported source export reading');
  if(JSON.stringify(actual)!==JSON.stringify(receipt.inventory))throw new Error('source export inventory differs from preparation');
  if(actual.length>receipt.limits?.maxFiles||actual.reduce((total,row)=>total+row.bytes,0)!==receipt.bytesTotal||receipt.bytesTotal>receipt.limits?.maxBytes)
    throw new Error('source export exceeds its declared artifact bounds');
  const environment={PATH:process.env.PATH,HOME:work,LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',
    GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_ALLOW_PROTOCOL:'file',GIT_OPTIONAL_LOCKS:'0'};
  for(const source of receipt.sources){
    const directory=resolve(work,source.directory);
    if(directory===work||!directory.startsWith(work+'/'))throw new Error('source export directory escapes its artifact');
    if(existsSync(join(directory,'.git','objects','info','alternates')))throw new Error('source export borrows an external object store');
    const query=(...args)=>{
      const result=spawnSync('git',['-C',directory,...args],{env:environment,encoding:'utf8',maxBuffer:64*1024*1024});
      if(result.error||result.status!==0)throw result.error??new Error(`offline source verification failed (${source.repository}, ${args[0]}): ${result.stderr||result.stdout}`);
      return result.stdout.trim();
    };
    if(query('rev-parse','HEAD')!==(source.selected??source.pin).commit)throw new Error('source export selected commit differs');
    for(const identity of [source.pin,source.selected].filter(Boolean)){
      if(query('rev-parse',`${identity.commit}^{tree}`)!==identity.tree)throw new Error('source export tree differs');
      if(query('rev-list','--objects','--missing=print','--no-object-names',identity.commit).split('\n').some(row=>row.startsWith('?')))
        throw new Error('source export is not independently complete');
    }
    query('fsck','--strict','--no-reflogs');
  }
  return receipt;
}

/** Restore both exact machine roots and verify that the immutable carrier
 * pair re-derives the same graph plan before handing it to the existing runner. */
export function prepareExportedComparison(work,expectedSha256,comparison){
  const receipt=verifyChangeSources(work,expectedSha256);work=realpathSync(work);comparison=resolve(comparison);
  if(comparison===work||comparison.startsWith(work+'/')||work.startsWith(comparison+'/'))throw new Error('comparison state must be outside the immutable source artifact');
  if(existsSync(comparison))throw new Error('exported comparison needs fresh state');
  mkdirSync(comparison,{recursive:true});if(realpathSync(comparison)!==comparison)throw new Error('comparison state is redirected');
  const machine=receipt.sources.find(source=>source.repository===receipt.snapshot.repository);
  if(!machine||machine.path!=='.'||machine.pin?.commit!==receipt.snapshot.commit||machine.selected?.commit!==receipt.candidateSnapshot.commit)
    throw new Error('source artifact has no matching machine pair');
  const env={PATH:process.env.PATH,HOME:comparison,LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_ALLOW_PROTOCOL:'file',GIT_OPTIONAL_LOCKS:'0'};
  const run=(program,args)=>{
    if(program!=='git')throw new Error('source carrier preparation executes Git only');
    const result=spawnSync('git',['-c','core.hooksPath=/dev/null',...args],{env,encoding:'utf8',maxBuffer:64*1024*1024});
    if(result.error||result.status!==0)throw result.error??new Error(`exported comparison source formation failed: ${result.stderr}`);return result.stdout.trim();
  };
  const restore=(identity,name)=>{
    if(typeof identity.definition!=='string'||!(identity.definition==='.'||/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(identity.definition))||identity.definition.split('/').some(part=>part==='..'||(part==='.'&&identity.definition!=='.')))
      throw new Error('invalid exported machine definition');
    const root=join(comparison,name);run('git',['clone','-q','--no-hardlinks','--dissociate','--no-checkout',join(work,machine.directory),root]);
    run('git',['-C',root,'checkout','-q','--detach',identity.commit]);return join(root,identity.definition);
  };
  const snapshot=restore(receipt.snapshot,'baseline-machine'),candidateSnapshot=restore(receipt.candidateSnapshot,'candidate-machine');
  const localSources=receipt.sources.filter(source=>source.repository!==machine.repository).map(source=>[source.repository,join(work,source.directory)]);
  const changes=receipt.sources.filter(source=>source.changed).map(source=>({repository:source.repository,...source.selected,directory:join(work,source.directory)}));
  const pair=comparisonSources(snapshot,join(comparison,'verified-source-graphs'),new Map(changes.map(source=>[source.repository,source.directory])),{candidateSnapshot,localSources:new Map(localSources),run});
  if(pair.planSha256!==receipt.sourcePlanSha256||JSON.stringify(pair.plan)!==JSON.stringify(receipt.sourcePlan))throw new Error('exported comparison differs from its authenticated graph plan');
  const result={kind:'guix.exported-comparison-inputs.v2',sourceSha256:expectedSha256,snapshot,candidateSnapshot,localSources,changes,sourcePlan:pair.plan,sourcePlanSha256:pair.planSha256};
  writeFileSync(join(comparison,'local-sources.json'),JSON.stringify(localSources)+'\n');verifyChangeSources(work,expectedSha256);return result;
}

/** The machine's sources with a directory for each: its own repository in place, every mounted repository fetched. */
export function materializeSources(snapshot,work,{run=defaultRun,link=gitlinks}={}){
  return materializeGraph(machineSources(snapshot,'HEAD',{mounts:directMountsOnly}),snapshot,work,{run,link});
}

/** Materialize the complete data-owner closure authenticated by the caller's
 * selected source occurrence. Package selection remains with that caller. Even
 * the root is received into fresh, isolated object storage: only mount metadata
 * is hydrated here, and no source working tree or full-object export is made.
 */
export function materializeOwnerSources(source,work,{run=defaultRun,link=gitlinks}={}){
  if(!source||typeof source.repository!=='string'||!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/u.test(source.repository)||
      !/^[a-f0-9]{40}$/u.test(source.commit??'')||typeof source.directory!=='string')
    throw new Error('owner materialization requires an authenticated exact source carrier');
  const directory=resolve(source.directory);
  if(realpathSync(directory)!==directory||!lstatSync(directory).isDirectory()||
      run('git',['-C',directory,'rev-parse','--show-toplevel'])!==directory||
      run('git',['-C',directory,'rev-parse','HEAD'])!==source.commit)
    throw new Error('owner materialization carrier differs from its selected commit');
  const tree=run('git',['-C',directory,'rev-parse',`${source.commit}^{tree}`]);
  const mounts=[...link(directory,source.commit,{requireAll:true})].map(([repository,mount])=>({repository,...mount}));
  const spec={machine:null,repositories:[{repository:source.repository,commit:source.commit,path:'.'},...mounts],entries:[],buildEntries:[],receivingPackages:[]};
  work=resolve(work);
  if(work===directory||work.startsWith(directory+'/')||directory.startsWith(work+'/'))
    throw new Error('owner materialization must be outside its selected carrier');
  if(existsSync(work)||realpathSync(dirname(work))!==dirname(work))
    throw new Error('owner materialization requires a fresh canonical staging path');
  mkdirSync(work);
  try{
    const result=materializeGraph(spec,directory,work,{run,link,isolateRoot:true});
    if(result.graph.repositories.find(row=>row.repository===source.repository)?.tree!==tree||
        run('git',['-C',directory,'rev-parse','HEAD'])!==source.commit)
      throw new Error('owner materialization differs from its authenticated carrier');
    return result;
  }catch(error){rmSync(work,{recursive:true,force:true});throw error;}
}

// Source acquisition is shared; only the explicitly comparative entry below can
// supply a replacement plan. Ordinary release has no override argument.
function materializeGraph(spec,snapshot,work,{run=defaultRun,link=gitlinks,carriers,sourceDirectories,replacements,baseline,comparison=false,isolateRoot=false}={}){

  const top=run('git',['-C',snapshot,'rev-parse','--show-toplevel']);
  return mountedSourceClosure(spec,source=>{
    let directory;
    if(source.path==='.'&&!isolateRoot){
      directory=top;
      if(run('git',['-C',directory,'rev-parse','HEAD'])!==source.commit)throw new Error(`the machine's repository is not checked out at the release commit: ${source.repository}`);
    }else{
      directory=join(work,'sources',slug(source.repository));
      let origin=sourceDirectories?.get(source.repository)??'origin';
      if(carriers){
        origin=carriers.get(source.repository);
        if(typeof origin!=='string'||!origin.startsWith('/')||realpathSync(origin)!==resolve(origin))
          throw new Error(`complete local source carrier is missing or redirected: ${source.repository}`);
      }
      const local=origin!=='origin';
      if(local)verifyLocalSourceObjects(origin,source.commit);
      if(!existsSync(join(directory,'.git'))){
        if(existsSync(directory))throw new Error(`source output already holds non-Git content: ${source.repository}`);
        mkdirSync(dirname(directory),{recursive:true});
        if(local){
          // Copy the already verified object store without hardlinks or borrowed
          // alternates. Fetching a partial clone's whole history would silently
          // ask its promisor for unrelated historical blobs.
          run('git',['-c','core.hooksPath=/dev/null','clone','-q','--no-hardlinks','--dissociate','--no-checkout',origin,directory]);
          run('git',['-C',directory,'remote','set-url','origin',`https://github.com/${source.repository}.git`]);
        }else{
          run('git',['init','-q',directory]);
          run('git',['-C',directory,'remote','add','origin',`https://github.com/${source.repository}.git`]);
        }
      }
      const stat=lstatSync(directory);
      if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(directory)!==resolve(directory))
        throw new Error(`source output is not an unlinked directory: ${source.repository}`);
      const metadata=lstatSync(join(directory,'.git'));
      if(!metadata.isDirectory()||metadata.isSymbolicLink())
        throw new Error(`source output shares foreign Git custody: ${source.repository}`);
      if(repositoryOfUrl(run('git',['-C',directory,'config','--get','remote.origin.url']))!==source.repository)
        throw new Error(`source origin differs from its Gitlink owner: ${source.repository}`);
      run('git',['-C',directory,'config','remote.origin.promisor','true']);
      run('git',['-C',directory,'config','remote.origin.partialclonefilter','blob:none']);
      // A completed exact receive is retained by this isolated source's HEAD.
      // Replaying the graph checks that immutable commit and its custody again;
      // it does not spend the receiving budget re-fetching every earlier owner.
      let received=false;
      try{received=run('git',['-C',directory,'rev-parse','--verify','HEAD^{commit}'])===source.commit;}catch{}
      if(local)received=run('git',['-C',directory,'rev-parse',`${source.commit}^{commit}`])===source.commit;
      if(!received)run('git',['-C',directory,'fetch','-q',...(comparison?[]:['--depth=1']),'--no-tags','--filter=blob:none',origin,source.commit]);
      if(comparison&&!local){
        const rows=run('git',['-C',directory,'ls-tree','-r','-z',source.commit]).split('\0').filter(Boolean);
        const blobs=rows.filter(row=>row.split(' ')[1]==='blob').map(row=>row.slice(row.indexOf(' ',row.indexOf(' ')+1)+1,row.indexOf('\t')));
        if(blobs.length){
          const missing=run('git',['-C',directory,'cat-file','--batch-check'],blobs.join('\n')+'\n').split('\n').filter(row=>row.endsWith(' missing')).map(row=>row.split(' ')[0]);
          for(let at=0;at<missing.length;at+=128)run('git',['-C',directory,'fetch','-q','--no-tags','--no-write-fetch-head','--recurse-submodules=no','--filter=blob:none','origin',...missing.slice(at,at+128)]);
        }
        verifyLocalSourceObjects(directory,source.commit);
      }
      if(run('git',['-C',directory,'rev-parse',`${source.commit}^{commit}`])!==source.commit)
        throw new Error(`source did not receive the exact Gitlink commit: ${source.repository}`);
      if(source.repository===CONTROLLER_REPOSITORY&&!comparison&&!isolateRoot){
        run('git',['-C',directory,'sparse-checkout','disable']);
        run('git',['-C',directory,'checkout','-q','--detach',source.commit]);
      }else{
        run('git',['-C',directory,'read-tree','--empty']);
        run('git',['-C',directory,'update-ref','--no-deref','HEAD',source.commit]);
        run('git',['-C',directory,'clean','-qfdx']);
      }
    }
    // Explicit acquisition may hydrate mount metadata, but the shared graph
    // reader itself has no network or credential fallback.
    const metadata=run('git',['-C',directory,'ls-tree',source.commit,'--','.gitmodules']);
    if(metadata)run('git',['-C',directory,'cat-file','-p',`${source.commit}:.gitmodules`]);
    return directory;
  },{link,replacements,baseline});
}

/** Verify local committed objects without any lazy remote transport. The
 * controller's receiving layer separately binds the carrier's exact identity
 * independently. This checks the objects graph reading and
 * code preparation actually need; it does not claim arbitrary history bytes. */
export function verifyLocalSourceObjects(directory,commit){
  const env={PATH:process.env.PATH,LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_ALLOW_PROTOCOL:'',GIT_OPTIONAL_LOCKS:'0'};
  const query=(args,input)=>{
    const result=spawnSync('git',['-c','core.hooksPath=/dev/null','-C',directory,...args],{encoding:'utf8',input,env,maxBuffer:64*1024*1024});
    if(result.error||result.status!==0)throw result.error??new Error(`local source objects unavailable without transport: ${String(result.stderr).slice(-1000)}`);
    return result.stdout;
  };
  const metadata=join(directory,'.git');
  if(!lstatSync(metadata).isDirectory()||lstatSync(metadata).isSymbolicLink()||realpathSync(metadata)!==metadata
    ||existsSync(join(metadata,'commondir'))||existsSync(join(metadata,'objects/info/alternates'))
    ||existsSync(join(metadata,'objects/info/http-alternates')))
    throw new Error('local source carrier borrows foreign Git custody');
  const custody=path=>{
    const stat=lstatSync(path);
    if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile())||(stat.isFile()&&stat.nlink!==1))
      throw new Error('local source carrier borrows foreign Git object custody');
    if(stat.isDirectory())for(const name of readdirSync(path))custody(join(path,name));
  };
  custody(join(metadata,'objects'));
  if(query(['rev-parse',`${commit}^{commit}`]).trim()!==commit)throw new Error('local source commit differs');
  const tree=query(['rev-parse',`${commit}^{tree}`]).trim();
  const records=query(['ls-tree','-r','-t','-z',commit]).split('\0').filter(Boolean);
  const objects=new Map([[commit,'commit'],[tree,'tree']]);
  for(const row of records){const [mode,type,sha]=row.slice(0,row.indexOf('\t')).split(' ');if(type==='tree'||type==='blob')objects.set(sha,type);}
  // Header/type existence alone does not authenticate loose objects whose
  // filenames claim another digest. Hash the selected commit and complete tree
  // bytes, without requiring unrelated or unhydrated historical objects.
  const entries=[...objects];
  for(let start=0;start<entries.length;start+=32){
    const batch=entries.slice(start,start+32),result=spawnSync('git',['-c','core.hooksPath=/dev/null','-C',directory,'cat-file','--batch'],
      {input:batch.map(([sha])=>sha).join('\n')+'\n',env,maxBuffer:64*1024*1024});
    if(result.error||result.status!==0)throw result.error??new Error('local source carrier lacks complete committed code objects');
    let at=0;
    for(const [sha,type] of batch){
      const end=result.stdout.indexOf(10,at),header=result.stdout.subarray(at,end).toString('ascii');
      const match=/^([a-f0-9]{40}) (commit|tree|blob) ([0-9]+)$/u.exec(header),size=Number(match?.[3]);
      if(end<at||!match||match[1]!==sha||match[2]!==type||!Number.isSafeInteger(size)||size<0
        ||end+size+1>=result.stdout.length||result.stdout[end+size+1]!==10)
        throw new Error('local source carrier lacks complete committed code objects');
      const bytes=result.stdout.subarray(end+1,end+1+size);
      if(createHash('sha1').update(`${type} ${size}\0`).update(bytes).digest('hex')!==sha)
        throw new Error('local source carrier object bytes differ from their Git identity');
      at=end+size+2;
    }
    if(at!==result.stdout.length)throw new Error('local source object batch contains unexpected bytes');
  }
  return directory;
}

export function sourceGraphDelta(base,head){
  const baseRows=new Map(base.repositories.map(source=>[source.repository,source])),headRows=new Map(head.repositories.map(source=>[source.repository,source]));
  return [...new Set([...baseRows.keys(),...headRows.keys()])].sort().flatMap(repository=>{
    const before=baseRows.get(repository),after=headRows.get(repository);
    const identity=source=>source?{commit:source.commit,tree:source.tree,paths:source.paths??[source.path??'.']}:null;
    const baseline=identity(before),candidate=identity(after);
    if(JSON.stringify(baseline)===JSON.stringify(candidate))return [];
    return [{repository,baseline,candidate}];
  });
}

/** Current native comparison reads two actual common source compositions and
 * their independent target definitions. It never selects packages, resolves a
 * lock, installs a provider or executes a fabrication recipe. The read port is
 * the exact receiver's existing source-object acquisition boundary. */
export function nativeComparisonSources(request,readSource){
  if(!['guix.reviewed-change-request.v3','guix.reviewed-change-request.v4'].includes(request?.kind)||typeof readSource!=='function')
    throw new Error('native comparison requires its reviewed request and source reader');
  const read=(identity,side,role)=>{
    const directory=readSource(identity,side,role);
    if(typeof directory!=='string'||resolve(directory)!==directory||realpathSync(directory)!==directory)
      throw new Error('native source carrier is missing or redirected');
    verifyLocalSourceObjects(directory,identity.commit);
    const actual=commonSourceIdentity(directory,identity.commit,{repository:identity.repository});
    if(identity.tree!==undefined&&actual.tree!==identity.tree)throw new Error('native source carrier tree differs from its reviewed identity');
    return directory;
  };
  const registry=request.kind==='guix.reviewed-change-request.v4';
  const sides={};
  for(const side of ['baseline','candidate']){
    const selected=request[side],root=read(selected.software,side,'software');
    const declaration=registry?{declarationOnly:true,machine:null,software:commonSourceIdentity(root,selected.software.commit,{repository:selected.software.repository}),
      repositories:[{...selected.software,path:'.'},...[...gitlinks(root,selected.software.commit,{requireAll:true})].map(([repository,mount])=>({repository,...mount}))],
      entries:[],buildEntries:[],receivingPackages:[]}:commonSoftwareSources(root,selected.software.commit,{repository:selected.software.repository});
    const recipe=registry?undefined:committedSourceFileIdentity(root,selected.software.commit,selected.recipe.path);
    if(!registry&&recipe.gitBlob!==selected.recipe.gitBlob)throw new Error('native fabrication interface differs from its reviewed source');
    const graph=mountedSourceClosure(declaration,source=>source.path==='.'?root:read(source,side,'mounted'));
    const targets=selected.targets.map(identity=>nativeTargetSourceIdentity(read(identity,side,'target'),identity));
    const consumers=registry?selected.targets.map(identity=>{
      const owner=graph.repositories.find(row=>row.repository===identity.repository);
      if(!owner||owner.commit!==identity.commit||owner.tree!==identity.tree||!(owner.paths??[owner.path]).includes(identity.coordinate))
        throw new Error('registry consumer coordinate differs from its mounted owner');
      return {coordinate:identity.coordinate,...registryConsumerSourceIdentity(read(identity,side,'target'),identity)};
    }):undefined;
    sides[side]={...graph,software:declaration.software,...registry?{consumers}:{recipe},targets};
  }
  const {baseline:base,candidate:head}=sides;
  if(base.software.repository!==head.software.repository)throw new Error('native candidate changes common software repository');
  const selectedController=head.repositories.find(source=>source.repository===CONTROLLER_REPOSITORY);
  if(selectedController?.commit!==request.controller.commit||selectedController.tree!==request.controller.tree)
    throw new Error('native common composition must contain the exact reviewed controller');
  if(!base.repositories.some(source=>source.repository===CONTROLLER_REPOSITORY))throw new Error('native baseline has no original controller source');
  for(const change of request.changes){
    const selected=head.repositories.find(source=>source.repository===change.repository);
    if(!selected||selected.commit!==change.commit||selected.tree!==change.tree)
      throw new Error(`requested head differs from the native candidate composition: ${change.repository}`);
  }
  const targetKey=target=>target.repository+':'+target.definition;
  const before=new Map(base.targets.map(target=>[targetKey(target),target])),after=new Map(head.targets.map(target=>[targetKey(target),target]));
  const targetDelta=[...new Set([...before.keys(),...after.keys()])].sort().flatMap(key=>{
    const baseline=before.get(key)??null,candidate=after.get(key)??null;
    return JSON.stringify(baseline)===JSON.stringify(candidate)?[]:[{target:key,baseline,candidate}];
  });
  const plan={kind:registry?'guix.comparison-source-plan.v3':'guix.comparison-source-plan.v2',scope:registry?'registry-consumer-source-admission-only':'native-common-software-comparison-only',
    baseline:{graphSha256:base.graphSha256,software:base.software,...registry?{consumers:base.consumers}:{recipe:base.recipe},targets:base.targets},
    candidate:{graphSha256:head.graphSha256,software:head.software,...registry?{consumers:head.consumers}:{recipe:head.recipe},targets:head.targets},
    requested:[...request.changes].sort((a,b)=>a.repository.localeCompare(b.repository,'en')),
    delta:sourceGraphDelta(base,head),targetDelta};
  return {base,head,plan,planSha256:digest(JSON.stringify(plan))};
}

/** Two independently resolved source graphs. This input is for comparison only:
 * it cannot be passed as an ordinary release declaration or promote anything.
 * New/removed topology comes from committed candidate sources, not a source list. */
export function comparisonSources(snapshot,work,changes=new Map(),{candidateSnapshot=snapshot,localSources,run=defaultRun,link=gitlinks}={}){
  if(!(changes instanceof Map)||(localSources!==undefined&&!(localSources instanceof Map)))throw new Error('comparison requires explicit source maps');
  work=resolve(work);
  if(existsSync(work))throw new Error('comparison source formation needs fresh output');
  const inputs=[snapshot,candidateSnapshot,...changes.values(),...(localSources?.values()??[])].map(path=>realpathSync(path));
  if(inputs.some(path=>work===path||work.startsWith(path+'/')||path.startsWith(work+'/')))throw new Error('comparison output overlaps its source inputs');
  mkdirSync(work,{recursive:true});
  if(realpathSync(work)!==work)throw new Error('comparison source output is redirected');
  const baseDeclaration=machineSources(snapshot,'HEAD',{mounts:directMountsOnly}),headDeclaration=machineSources(candidateSnapshot,'HEAD',{mounts:directMountsOnly});
  const custodyEnvironment={PATH:process.env.PATH,LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_ALLOW_PROTOCOL:''};
  for(const [definition,declaration] of [[snapshot,baseDeclaration],[candidateSnapshot,headDeclaration]]){
    const root=run('git',['-C',definition,'rev-parse','--show-toplevel']);
    verifySnapshotSource(root,declaration.machine.commit,declaration.machine.tree,custodyEnvironment);
  }
  if(baseDeclaration.machine.repository!==headDeclaration.machine.repository)throw new Error('candidate machine changes repository identity');
  const base=materializeGraph(baseDeclaration,snapshot,join(work,'baseline'),{run,link,carriers:localSources,sourceDirectories:changes,comparison:true});
  const baseline=new Map(base.repositories.map(source=>[source.repository,source.commit])),replacements=new Map(),requested=[];
  for(const [repository,directory] of changes){
    if(repository===base.machine.repository)throw new Error('machine changes require an explicit candidate definition');
    if(typeof directory!=='string'||!directory.startsWith('/')||realpathSync(directory)!==resolve(directory))throw new Error('changed source carrier is missing or redirected');
    const commit=run('git',['-C',directory,'rev-parse','HEAD^{commit}']),tree=run('git',['-C',directory,'rev-parse','HEAD^{tree}']);
    replacements.set(repository,commit);requested.push({repository,commit,tree});
  }
  const carriers=localSources?new Map([...localSources,...changes]):undefined;
  const head=materializeGraph(headDeclaration,candidateSnapshot,join(work,'candidate'),{run,link,carriers,sourceDirectories:changes,replacements,baseline,comparison:true});
  if(localSources){
    const expected=new Set([...base.repositories,...head.repositories].filter(source=>source.path!=='.').map(source=>source.repository));
    if(localSources.size!==expected.size||[...expected].some(repository=>!localSources.has(repository)))throw new Error('local carriers must cover exactly both resolved source graphs');
  }
  const delta=sourceGraphDelta(base,head);
  const plan={kind:'guix.comparison-source-plan.v1',scope:'comparison-only',baseline:base.graphSha256,candidate:head.graphSha256,
    requested:requested.sort((a,b)=>a.repository.localeCompare(b.repository,'en')),delta};
  return {base,head,plan,planSha256:digest(JSON.stringify(plan))};
}

if(isCliEntry(import.meta.url)){
  const arguments_=process.argv.slice(2);
  try{
    if(arguments_[0]==='--export-change'){
      const [,snapshot,work,...values]=arguments_;
      const candidate=values.filter(value=>value.startsWith('--candidate-snapshot=')),local=values.filter(value=>value.startsWith('--local-sources='));
      const pairs=values.filter(value=>!value.startsWith('--candidate-snapshot=')&&!value.startsWith('--local-sources='));
      if(!snapshot||!work||(!pairs.length&&!candidate.length)||candidate.length>1||local.length>1||pairs.some(pair=>!/^[^/=\s]+\/[^/=\s]+=.+$/u.test(pair)))throw new Error('usage: materialize-sources.mjs --export-change SNAPSHOT WORK [--candidate-snapshot=PATH] [--local-sources=FILE] OWNER/REPO=PATH ...');
      const changes=new Map(pairs.map(pair=>{const at=pair.indexOf('=');return [pair.slice(0,at),pair.slice(at+1)];}));
      if(changes.size!==pairs.length)throw new Error('duplicate changed source');
      const result=exportChangeSources(snapshot,work,changes,{candidateSnapshot:candidate.length?candidate[0].slice('--candidate-snapshot='.length):snapshot,
        localSources:local.length?new Map(JSON.parse(readFileSync(local[0].slice('--local-sources='.length),'utf8'))):undefined});
      process.stdout.write(JSON.stringify({kind:result.receipt.kind,sha256:result.sha256,snapshot:result.receipt.snapshot,sources:result.receipt.sources})+'\n');
    }else if(arguments_[0]==='--comparison'){
      if(arguments_.length!==4)throw new Error('usage: materialize-sources.mjs --comparison WORK PREPARATION_SHA256 COMPARISON');
      process.stdout.write(JSON.stringify(prepareExportedComparison(arguments_[1],arguments_[2],arguments_[3]))+'\n');
    }else if(arguments_[0]==='--verify-export'){
      if(arguments_.length!==3)throw new Error('usage: materialize-sources.mjs --verify-export WORK PREPARATION_SHA256');
      process.stdout.write(JSON.stringify(verifyChangeSources(arguments_[1],arguments_[2]))+'\n');
    }else{
      const [snapshot,work]=arguments_;
      if(!snapshot||!work||arguments_.length!==2)throw new Error('usage: materialize-sources.mjs SNAPSHOT WORK');
      process.stdout.write(JSON.stringify(materializeSources(snapshot,work))+'\n');
    }
  }catch(error){console.error(error.message);process.exit(1);}
}
