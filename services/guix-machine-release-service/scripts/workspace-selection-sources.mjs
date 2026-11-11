import assert from 'node:assert/strict';
import {readFile,realpath,readdir,lstat,readlink} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {verifyWorkspaceSelection} from '@red-cup-engineering/node-runtime-release-promotion-service/install-workspace-selection';
import {gitlinks,machineSourceIdentity,CONTROLLER_REPOSITORY} from './source-pins.mjs';
import {receiveGeneratedWorkspaceAssets} from './generated-workspace-assets.mjs';
import {manifestIdentity,receivingPackageNames,receivingTestPaths,sha256} from './package-receiving.mjs';

const portable=path=>path.split(sep).join('/');
const relativePath=value=>typeof value==='string'&&(value==='.'||value.split('/').every(part=>part&&part!=='.'&&part!=='..'))&&!isAbsolute(value)&&!/[\\\0]/u.test(value);
const within=(root,path)=>{const offset=relative(root,path);return !isAbsolute(offset)&&offset!=='..'&&!offset.startsWith('..'+sep);};

const offlineEnvironment=()=>({...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',
  GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_ALLOW_PROTOCOL:'',GIT_OPTIONAL_LOCKS:'0'});
const git=(directory,...args)=>{
    const result=spawnSync('git',['-c','core.hooksPath=/dev/null','-C',directory,...args],{env:offlineEnvironment(),maxBuffer:64*1024*1024});
    if(result.error||result.status!==0)throw result.error??new Error('selected committed source unavailable');
    return result.stdout;
  };
export const committedSourceObject=(source,path)=>{
    if(!relativePath(path)||path==='.')throw new Error('committed source object must be relative');
    const row=git(source.directory,'ls-tree','-z',source.commit,'--',path).toString('utf8');
    if(!row)return null;
    const match=/^(\d{6}) (blob|tree|commit) ([a-f0-9]{40})\t([^\0]+)\0$/u.exec(row);
    if(!match||match[4]!==path)throw new Error('selected source object differs from its exact path');
    return {mode:match[1],kind:match[2],gitObject:match[3],path,commit:source.commit};
  };
export const readCommittedSourceFile=(source,path)=>{
    const object=committedSourceObject(source,path);
    if(!object||object.kind!=='blob'||!['100644','100755'].includes(object.mode))throw new Error('selected source file is not a committed regular carrier: '+path);
    return {bytes:git(source.directory,'cat-file','blob',object.gitObject),gitBlob:object.gitObject,mode:object.mode};
  };

/** Project existing selected-source facts for the receiver, without selecting or
 * installing a second package graph. Code owns receipt verification; committed
 * Gitlinks own repository identity. Package paths remain source-relative, never
 * the portable installation location. This is not a full mounted-source graph.
 */
export async function workspaceSelectionSources({selection,snapshot,target}){
  const environment=offlineEnvironment();
  const root=await verifyWorkspaceSelection(selection,{environment});
  const rootManifest=JSON.parse(readCommittedSourceFile({directory:root,commit:selection.commit},'package.json').bytes);
  const repository=/github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(rootManifest.repository?.url??'')?.[1];
  const softwareIdentity={repository,commit:selection.commit,definition:'.',tree:git(root,'rev-parse',selection.commit+'^{tree}').toString('utf8').trim()};
  if(resolve(snapshot)!==root)throw new Error('software snapshot must be its selected source repository root');
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(softwareIdentity.repository??''))
    throw new Error('receiver definition needs its authored repository identity');
  const occurrences=[{repository:softwareIdentity.repository,commit:selection.commit,path:'.',directory:root}];
  for(const mount of [...selection.sourceMounts].sort((a,b)=>a.path.split('/').length-b.path.split('/').length||a.path.localeCompare(b.path))){
    if(!relativePath(mount.path)||mount.path==='.')throw new Error('selected mount needs a canonical relative occurrence');
    const parent=occurrences.filter(row=>row.path==='.'||mount.path.startsWith(row.path+'/')).sort((a,b)=>(b.path==='.'?-1:b.path.length)-(a.path==='.'?-1:a.path.length))[0];
    const local=parent.path==='.'?mount.path:mount.path.slice(parent.path.length+1);
    const matches=[...gitlinks(parent.directory,parent.commit,{requireAll:true})].filter(([,row])=>row.path===local&&row.commit===mount.revision);
    if(matches.length!==1)throw new Error('selected mount has no unique committed repository edge');
    const [repository]=matches[0],directory=resolve(root,mount.path);
    if(!within(root,directory)||await realpath(directory)!==directory)throw new Error('selected mount is redirected');
    occurrences.push({repository,commit:mount.revision,path:mount.path,directory});
  }
  const repositories=[];
  for(const occurrence of occurrences){
    const known=repositories.find(row=>row.repository===occurrence.repository);
    if(known){
      if(known.commit!==occurrence.commit)throw new Error('one selected repository has conflicting revisions');
      known.paths.push(occurrence.path);
    }else repositories.push({repository:occurrence.repository,commit:occurrence.commit,path:occurrence.path,paths:[occurrence.path]});
  }
  const receiver=target===undefined
    ?{identity:softwareIdentity,carrier:occurrences[0]}
    :committedTargetSource(target);
  const {identity,carrier:targetCarrier}=receiver;
  const machine={}; // Native Guix construction derives receiving configuration.
  // The target supplies identity, credentials, state and supervisor bindings.
  // Its retired run inventory cannot select or gate the common software graph;
  // installed selection and packed compilation receipts own that graph.
  const receivingPackages=[];
  const packages=[],carriers=[];
  for(const importer of selection.importerIds){
    if(!relativePath(importer))throw new Error('selected importer is not a canonical occurrence');
    const source=occurrences.filter(row=>row.path==='.'||importer===row.path||importer.startsWith(row.path+'/')).sort((a,b)=>(b.path==='.'?-1:b.path.length)-(a.path==='.'?-1:a.path.length))[0];
    const path=source.path==='.'?importer:importer===source.path?'.':importer.slice(source.path.length+1);
    const prefix=path==='.'?'':path+'/';
    const {bytes}=readCommittedSourceFile(source,prefix+'package.json'),manifest=JSON.parse(bytes);
    assert.deepEqual(await readFile(join(root,importer,'package.json')),bytes,'selected manifest differs from committed owner bytes');
    if(typeof manifest.name!=='string'||typeof manifest.version!=='string'||packages.some(row=>row.name===manifest.name))
      throw new Error('selected packages require unique declared names and versions');
    const entry={name:manifest.name,version:manifest.version,repository:source.repository,commit:source.commit,path,
      sourceManifestSha256:manifestIdentity(manifest)};
    packages.push(entry);carriers.push({...source,package:manifest.name,packagePath:path,importer});
  }
  await verifyWorkspaceSelection(selection,{environment});
  return {sources:{repositories,packages,receivingPackages},machine,identity,softwareIdentity,targetCarrier,carriers};
}

/** The authenticated portable deploy owner supplies common receiving enrollment.
 * Call only after receiving its actual root and exact selected deploy command.
 * Read policy and tests from existing committed carriers; this cannot select
 * dependencies, accept caller manifests, or consult a target's retired entries.
 */
export function workspaceReceivingSources(projection,consumer){
  if(!projection.carriers.includes(consumer))throw new Error('common receiving consumer is not an admitted source carrier');
  const manifestFor=carrier=>{
    const matches=projection.sources.packages.filter(source=>source.name===carrier.package);
    if(matches.length!==1)throw new Error('common receiving provider is not uniquely selected: '+carrier.package);
    const source=matches[0];
    if(source.repository!==carrier.repository||source.commit!==carrier.commit||source.path!==carrier.packagePath)
      throw new Error('common receiving carrier differs from selected source: '+carrier.package);
    const path=carrier.packagePath==='.'?'package.json':carrier.packagePath+'/package.json';
    const manifest=JSON.parse(readCommittedSourceFile(carrier,path).bytes);
    if(!Object.hasOwn(manifest,'name')||!Object.hasOwn(manifest,'version')||
        manifest.name!==source.name||manifest.version!==source.version||manifestIdentity(manifest)!==source.sourceManifestSha256)
      throw new Error('common receiving manifest differs from selected source: '+carrier.package);
    return {source,manifest};
  };
  const {manifest}=manifestFor(consumer);
  const names=receivingPackageNames(Object.hasOwn(manifest,'receivingPackages')?manifest.receivingPackages:[]);
  const receipts=new Map();
  for(const name of names){
    const matches=projection.carriers.filter(carrier=>carrier.package===name);
    if(matches.length!==1)throw new Error('common receiving provider is not uniquely selected: '+name);
    const carrier=matches[0],{manifest}=manifestFor(carrier);
    if(!Object.hasOwn(manifest,'receivingTests'))throw new Error('common receiving provider lacks its own receivingTests: '+name);
    const tests=receivingTestPaths(manifest).map(path=>{
      const file=carrier.packagePath==='.'?path:carrier.packagePath+'/'+path;
      const {bytes,gitBlob}=readCommittedSourceFile(carrier,file);
      return {path,gitBlob,sha256:sha256(bytes)};
    });
    receipts.set(name,{version:1,manifest,tests});
  }
  return {...projection.sources,receivingPackages:names,
    packages:projection.sources.packages.map(source=>receipts.has(source.name)?{...source,receiving:receipts.get(source.name)}:source)};
}

// A target declaration is an independently authenticated committed source. Its
// expected repository and commit are supplied by the existing release caller;
// they cannot be borrowed from the shared software selection or relabeled.
function committedTargetSource(target){
  if(!target||typeof target.snapshot!=='string'||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(target.repository??'')||
      !/^[a-f0-9]{40}$/u.test(target.commit??''))
    throw new Error('target receiver needs its exact repository, commit and snapshot');
  const snapshot=resolve(target.snapshot),identity=machineSourceIdentity(snapshot,target.commit,{repository:target.repository});
  if(identity.repository!==target.repository||identity.commit!==target.commit)
    throw new Error('target receiver differs from its expected source identity');
  const directory=identity.definition==='.'?snapshot:resolve(snapshot,...identity.definition.split('/').map(()=>'..'));
  if(resolve(directory,identity.definition)!==snapshot)
    throw new Error('target receiver definition is outside its source carrier');
  return {identity,carrier:{repository:identity.repository,commit:identity.commit,path:'.',directory}};
}

/** Read only the receiver's declared package files and fixed public snapshot
 * records from committed objects. No checkout metadata, install directory or
 * private environment file can enter this source export. */
export async function workspaceReceiverInputs(options){
  const projection=await workspaceSelectionSources(options);
  if(options.target===undefined)return {...projection,controllerFiles:[],declarationFiles:[],deploymentFiles:[]};
  const source=projection.carriers.find(row=>row.package==='@red-cup-engineering/guix-machine-release-service');
  if(!source||source.repository!==CONTROLLER_REPOSITORY||source.packagePath!=='.')
    throw new Error('receiver controller must be the selected owning repository root');
  const manifest=JSON.parse(readCommittedSourceFile(source,'package.json').bytes);
  assert.deepEqual(manifest.files,['src','scripts'],'receiver package files changed; receive its declared layout explicitly');
  const rows=git(source.directory,'ls-tree','-rz',source.commit,'--','package.json','src','scripts').toString('utf8').split('\0').filter(Boolean);
  const controllerFiles=rows.map(row=>{
    const match=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(row);
    if(!match||!relativePath(match[3])||match[3].split('/').some(part=>part==='.git'||part==='node_modules'))
      throw new Error('receiver package contains a nonregular or redirected source carrier');
    return {path:match[3],mode:match[1],gitBlob:match[2],bytes:git(source.directory,'cat-file','blob',match[2])};
  });
  for(const path of ['package.json','scripts/receive.scm','scripts/check-host.mjs'])
    if(!controllerFiles.some(row=>row.path===path))throw new Error('selected receiver lacks its required source entrance: '+path);
  const root=projection.targetCarrier;
  if(!root||root.repository!==projection.identity.repository||root.commit!==projection.identity.commit)
    throw new Error('receiver definition has no exact target carrier');
  const prefix=projection.identity.definition==='.'?'':projection.identity.definition+'/';
  const declarationFiles=['machine.scm','channels.scm']
    .map(path=>({path,...readCommittedSourceFile(root,prefix+path)}));
  const deploymentFiles=git(root.directory,'ls-tree','-rz',root.commit,'--',prefix+'deployment',prefix+'deployments').toString('utf8').split('\0').filter(Boolean).map(row=>{
    const match=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(row);
    if(!match||!relativePath(match[3])||match[3].split('/').some(part=>part==='.git'||part==='node_modules'))throw new Error('deployment source is not a committed regular carrier');
    return {path:match[3].slice(prefix.length),mode:match[1],gitBlob:match[2],bytes:git(root.directory,'cat-file','blob',match[2])};
  });
  if(!deploymentFiles.some(row=>row.path==='deployment/host.json'))throw new Error('receiver snapshot lacks its committed deployment host');
  if(projection.machine.agency!==undefined)throw new Error('portable agency projection requires its existing committed receiving contract');
  await verifyWorkspaceSelection(options.selection,{environment:offlineEnvironment()});
  return {...projection,controllerFiles,declarationFiles,deploymentFiles};
}

/** Until a Code command supplies received derived-output identities, every
 * packed workspace file must be an exact committed source carrier. Unknown
 * generated/untracked payloads fail closed; no hand-authored dist allowlist.
 */
export async function receiveCommittedPortableFiles(projection,runtime,sources,{generation,selection}={}){
  let files=0,derivedFiles=0;
  const derived=await receiveGeneratedWorkspaceAssets({generation,selection,projection,readCommittedSourceFile,committedSourceObject});
  const root=resolve(runtime);
  for(const provider of sources.packages){
    const carrier=projection.carriers.find(row=>row.package===provider.name);
    if(!carrier)throw new Error('packed provider lacks its selected source carrier');
    const directory=resolve(root,provider.installationPath);
    const original=JSON.parse(readCommittedSourceFile(carrier,(carrier.packagePath==='.'?'':carrier.packagePath+'/')+'package.json').bytes);
    const packed=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));
    const manifestBody=value=>Object.fromEntries(Object.entries(value).filter(([key])=>!['dependencies','devDependencies','optionalDependencies'].includes(key)));
    assert.deepEqual(provider.installationPath==='.'?manifestBody(packed):packed,provider.installationPath==='.'?manifestBody(original):original,'portable manifest body differs from committed source');
    async function walk(current,offset=''){
      for(const entry of await readdir(current,{withFileTypes:true})){
        if(entry.name==='node_modules')continue;
        if(entry.name==='.git')throw new Error('checkout metadata cannot enter a portable provider');
        const path=offset?offset+'/'+entry.name:entry.name,file=join(current,entry.name),stat=await lstat(file);
        if(provider.installationPath==='.'&&path==='app'&&stat.isSymbolicLink()){
          const drivers=sources.packages.filter(row=>row.name==='@red-cup-engineering/feltos');
          if(drivers.length!==1||await readlink(file)!==relative(root,resolve(root,drivers[0].installationPath))||
              await realpath(file)!==resolve(root,drivers[0].installationPath))throw new Error('portable driver alias differs from received software');
          continue;
        }
        if(stat.isDirectory()){await walk(file,path);continue;}
        if(!stat.isFile())throw new Error('workspace payload is not a regular source carrier');
        // pnpm normalizes dependency fields; the compiler checks the owning
        // manifest's unchanged exports/bin/files/name/version contract.
        if(path==='package.json')continue;
        // pnpm deployFromSharedLockfile writes these exact root metadata
        // carriers from its selected lock/policy, separately hashed below.
        if(provider.installationPath==='.'&&['pnpm-lock.yaml','pnpm-workspace.yaml'].includes(path))continue;
        const machinePath=carrier.importer==='.'?path:carrier.importer+'/'+path;
        const occurrence=projection.carriers.filter(row=>row.path==='.'||machinePath.startsWith(row.path+'/'))
          .sort((a,b)=>(b.path==='.'?-1:b.path.length)-(a.path==='.'?-1:a.path.length))[0];
        const sourcePath=occurrence.path==='.'?machinePath:machinePath.slice(occurrence.path.length+1);
        let expected;
        try{expected=readCommittedSourceFile(occurrence,sourcePath);}catch(cause){
          const product=derived.get(provider.name+':'+path),bytes=await readFile(file);
          if(!product)throw new Error('portable payload requires received source or derived-output attribution: '+provider.name+':'+path,{cause});
          if(bytes.length!==product.bytes||sha256(bytes)!==product.sha256||Boolean(stat.mode&0o111)!==product.executable)throw new Error('portable compiler product differs from its received emission: '+provider.name+':'+path);
          derivedFiles++;continue;
        }
        assert.deepEqual(await readFile(file),expected.bytes,'portable payload differs from committed source: '+provider.name+':'+path);
        if(Boolean(stat.mode&0o111)!==(expected.mode==='100755'))throw new Error('portable source executable mode differs');
        files++;
      }
    }
    await walk(directory);
  }
  return {committedFiles:files,derivedFiles};
}
