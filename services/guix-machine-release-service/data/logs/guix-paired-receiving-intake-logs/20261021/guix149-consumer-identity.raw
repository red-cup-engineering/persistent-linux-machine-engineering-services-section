#!/usr/bin/env node
// A machine releases from the repository that holds its definition: that repository at the release commit, and
// every repository it mounts by gitlink at that commit. Nothing else names a source or pins a commit. What the
// common software runs from Code's separately received selection, and each selected provider has
// exactly one home among those sources.
import {spawnSync} from 'node:child_process';
import {join,relative,posix,resolve} from 'node:path';
import {realpathSync,existsSync,mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {isCliEntry} from './cli-entry.mjs';

const git=(directory,...args)=>{
  const r=spawnSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:directory,encoding:'utf8',maxBuffer:64*1024*1024,
    env:{PATH:process.env.PATH,LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_ALLOW_PROTOCOL:'',GIT_OPTIONAL_LOCKS:'0'}});
  if(r.error||r.status!==0)throw r.error??new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr.trim()}`);
  return r.stdout;
};
const COMMIT=/^[0-9a-f]{40}$/u;
const repositoryOf=url=>/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(url)?.[1];

/** repository (owner/name) -> { path, commit, ref } for every submodule of the repository at `directory`, at `ref`. */
export function gitlinks(directory,ref='HEAD',{requireAll=false}={}){
  let top;
  try{top=git(directory,'rev-parse','--show-toplevel').trim();}catch(error){if(requireAll)throw error;return new Map();}
  const links=new Map();
  for(const line of git(top,'ls-tree','-rz',ref).split('\0')){
    const m=/^160000 commit ([0-9a-f]{40})\t(.+)$/u.exec(line);
    if(m)links.set(m[2],m[1]);
  }
  const modules=new Map();
  let text='';
  try{text=git(top,'show',`${ref}:.gitmodules`);}catch(error){if(requireAll&&links.size)throw new Error('mounted source has no readable .gitmodules',{cause:error});return new Map();}
  for(const block of text.split(/^\[submodule /mu).slice(1)){
    const path=/^\s*path\s*=\s*(.+?)\s*$/mu.exec(block)?.[1],url=/^\s*url\s*=\s*(.+?)\s*$/mu.exec(block)?.[1],branch=/^\s*branch\s*=\s*(.+?)\s*$/mu.exec(block)?.[1];
    const repository=url&&repositoryOf(url);
    if(requireAll&&path&&links.has(path)&&(!repository||path==='.'||posix.isAbsolute(path)||posix.normalize(path)!==path||path.startsWith('../')))
      throw new Error(`mounted source has an unsupported URL or path: ${path}`);
    if(path&&repository&&links.has(path)){
      if(modules.has(repository))throw new Error(`${repository} is mounted at two paths: ${modules.get(repository).path} and ${path}`);
      modules.set(repository,Object.freeze({path,commit:links.get(path),ref:branch??'main'}));
    }
  }
  if(requireAll)for(const path of links.keys())if(![...modules.values()].some(m=>m.path===path))
    throw new Error(`gitlink has no declared source URL: ${path}`);
  return modules;
}

/** The repository (owner/name) a GitHub remote URL names. */
export function repositoryOfUrl(url){
  const repository=repositoryOf(url);
  if(!repository)throw new Error(`not a GitHub repository URL: ${url}`);
  return repository;
}

const RUN_FIELDS=['entries','buildEntries','receivingPackages'];

/** Native common software has its own committed repository root. A target's
 * machine definition is not that root's package or dependency selection. */
export function commonSourceIdentity(directory,commit,{repository}={}){
  if(typeof directory!=='string'||resolve(directory)!==directory||realpathSync(directory)!==directory
    ||!COMMIT.test(commit??''))throw new Error('common source requires a canonical root and exact commit');
  if(realpathSync(git(directory,'rev-parse','--show-toplevel').trim())!==directory
    ||git(directory,'rev-parse',`${commit}^{commit}`).trim()!==commit)
    throw new Error('common source differs from its exact repository root');
  const actual=repositoryOfUrl(git(directory,'remote','get-url','origin').trim());
  if(repository!==undefined&&repository!==actual)throw new Error('common source differs from its admitted repository');
  return {repository:actual,commit,tree:git(directory,'rev-parse',`${commit}^{tree}`).trim()};
}

/** Read identity from committed regular bytes, never working files or filters.
 * The byte digest is evidence under the caller's independently fixed commit. */
export function committedSourceFileIdentity(directory,commit,path,{optional=false}={}){
  if(typeof path!=='string'||!path||posix.isAbsolute(path)||posix.normalize(path)!==path
    ||path.split('/').some(part=>['.','..','.git'].includes(part))||/[\\\0]/u.test(path))
    throw new Error('native source interface requires a canonical relative file');
  const row=git(directory,'ls-tree','-z',commit,'--',path);
  if(!row&&optional)return null;
  const match=/^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0$/u.exec(row);
  if(!match||match[3]!==path)throw new Error(`native source interface is not a committed regular file: ${path}`);
  const bytes=git(directory,'cat-file','blob',match[2]);
  if(createHash('sha1').update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest('hex')!==match[2])
    throw new Error('native source interface is not exact UTF-8 text');
  return {path,mode:match[1],gitBlob:match[2],sha256:createHash('sha256').update(bytes).digest('hex')};
}

/** Declaration only. The shared graph walker remains the sole recursive owner
 * reader; native PNPM/Code retain package selection and fabrication authority. */
export function commonSoftwareSources(directory,commit,{repository}={}){
  const software=commonSourceIdentity(directory,commit,{repository});
  const files=['package.json','pnpm-workspace.yaml','pnpm-lock.yaml'].map(path=>committedSourceFileIdentity(directory,commit,path));
  const npmrc=committedSourceFileIdentity(directory,commit,'.npmrc',{optional:true});
  const mounts=[...gitlinks(directory,commit,{requireAll:true})].map(([repository,mount])=>({repository,...mount}));
  if(mounts.some(source=>source.repository===software.repository))throw new Error('common software mounts itself');
  return {declarationOnly:true,machine:null,software:{...software,configuration:[...files,...npmrc?[npmrc]:[]],
    npmrcPresent:Boolean(npmrc),lock:files.find(file=>file.path==='pnpm-lock.yaml')},
    repositories:[{...software,path:'.'},...mounts],entries:[],buildEntries:[],receivingPackages:[]};
}

/** Registry consumers are selected by their committed package exports. This is
 * source admission only: it does not parse a PNPM lock or claim installation. */
export function registryConsumerSourceIdentity(directory,identity){
  const target=nativeTargetSourceIdentity(directory,identity);
  const manifest=committedSourceFileIdentity(directory,identity.commit,'package.json');
  const declaration=JSON.parse(git(directory,'cat-file','blob',manifest.gitBlob));
  const prefix=identity.definition==='.'?'./':'./'+identity.definition+'/';
  if(declaration.exports?.['./machine']!==prefix+'machine.scm'
    ||declaration.exports?.['./channels']!==prefix+'channels.scm')
    throw new Error('registry consumer exports do not select the admitted target');
  if(typeof declaration.name!=='string'||!declaration.name||typeof declaration.version!=='string'||!declaration.version)
    throw new Error('registry consumer has no package identity');
  const lock=committedSourceFileIdentity(directory,identity.commit,'pnpm-lock.yaml');
  const configuration=['pnpm-workspace.yaml','.npmrc'].map(path=>({path,
    identity:committedSourceFileIdentity(directory,identity.commit,path,{optional:true})}));
  return {target,name:declaration.name,version:declaration.version,manifest,lock,configuration,
    // Absence is an unmet engineering obligation, never an empty passing suite.
    receivingDeclared:Object.hasOwn(declaration,'receivingTests')};
}

/** A native target is independently authenticated source, not a second common
 * package inventory. Its definition tree binds all authored interface bytes. */
export function nativeTargetSourceIdentity(directory,identity){
  const source=commonSourceIdentity(directory,identity.commit,{repository:identity.repository});
  if(source.tree!==identity.tree)throw new Error('native target source tree differs');
  const definition=identity.definition;
  if(typeof definition!=='string'||!(definition==='.'||/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(definition))
    ||definition.split('/').some(part=>part==='..'||part==='.git'||(part==='.'&&definition!=='.')))
    throw new Error('native target requires its canonical definition coordinate');
  const prefix=definition==='.'?'':definition+'/';
  const machine=committedSourceFileIdentity(directory,identity.commit,prefix+'machine.scm');
  const channels=committedSourceFileIdentity(directory,identity.commit,prefix+'channels.scm');
  const definitionTree=definition==='.'?source.tree:git(directory,'rev-parse',`${identity.commit}:${definition}`).trim();
  if(git(directory,'cat-file','-t',definitionTree).trim()!=='tree')throw new Error('native target definition is not a committed directory');
  return {...source,definition,definitionTree,machine,channels};
}

/** Read one graph for preparation, comparison and release. Origin edges remain
 * evidence even when a repository's immutable objects are acquired only once.
 * A prospective replacement is explicit input, never a floating branch. */
export function mountedSourceClosure(spec,receive,{link=gitlinks,replacements=new Map(),baseline=new Map(),tree=(directory,commit)=>git(directory,'rev-parse',`${commit}^{tree}`).trim()}={}){
  if(!(replacements instanceof Map)||!(baseline instanceof Map))throw new Error('source replacements and baseline identities must be maps');
  const roots=spec.repositories.filter(source=>source.path==='.');
  if(roots.length!==1||spec.repositories[0]!==roots[0])throw new Error('source graph needs one first machine root');
  const root=roots[0],held=new Map(),resolved=[],edges=[],adjacency=new Map(),queue=[{source:root,from:null,mount:'.'}];
  const selected=source=>{
    const replacement=replacements.get(source.repository);
    if(replacement===undefined)return source.commit;
    if(typeof replacement!=='string'||!COMMIT.test(replacement))throw new Error(`source replacement needs an exact commit: ${source.repository}`);
    if(source.path==='.')throw new Error('machine changes require an explicit candidate definition');
    const prior=baseline.get(source.repository);
    if(!(prior===undefined?[replacement]:[prior,replacement]).includes(source.commit))
      throw new Error(`candidate edge conflicts with its reviewed baseline and replacement: ${source.repository}`);
    return replacement;
  };
  while(queue.length){
    const item=queue.shift(),{from,mount}=item;
    if(Object.hasOwn(item.source,'purpose'))throw new Error('source roles are not part of the committed mount contract');
    if(item.source.ref!==undefined&&(typeof item.source.ref!=='string'||!item.source.ref||item.source.ref.trim()!==item.source.ref||/[\s\x00-\x1f\x7f]/u.test(item.source.ref)))
      throw new Error(`source edge has an invalid tracked ref: ${item.source.repository}`);
    const source={...item.source},commit=selected(source);
    if(typeof source.repository!=='string'||!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/u.test(source.repository)||!COMMIT.test(source.commit??''))
      throw new Error('source graph needs an exact repository and commit');
    if(from!==null){
      const edge={from,to:source.repository,path:mount,commit:source.commit,selectedCommit:commit,ref:source.ref??'main'};
      edges.push(edge);if(!adjacency.has(from))adjacency.set(from,[]);adjacency.get(from).push(source.repository);
    }
    const known=held.get(source.repository);
    if(known){
      if(known.commit!==commit)throw new Error(`${source.repository} is mounted at ${known.path} (${known.commit}) and at ${source.path} (${commit}); one repository has one commit in a release`);
      if((known.ref??'main')!==(source.ref??'main'))
        throw new Error(`${source.repository} has conflicting mounted ref metadata`);
      continue;
    }
    const selectedSource={...source,commit},directory=receive(selectedSource),treeId=tree===null?null:tree(directory,commit);
    if(tree!==null&&!COMMIT.test(treeId??''))throw new Error(`source has no exact committed tree: ${source.repository}`);
    const record={...selectedSource,...tree===null?{}:{tree:treeId},...directory===undefined?{}:{directory}};held.set(source.repository,record);resolved.push(record);
    const mounts=source.path==='.'?spec.repositories.slice(1).map(row=>[row.repository,row]):link(directory,commit,{requireAll:true,source:selectedSource});
    for(const [repository,mounted] of mounts)queue.push({from:source.repository,mount:mounted.path,
      source:{repository,commit:mounted.commit,path:source.path==='.'?mounted.path:`${source.path}/${mounted.path}`,ref:mounted.ref===undefined?'main':mounted.ref,...(Object.hasOwn(mounted,'purpose')?{purpose:mounted.purpose}:{})}});
  }
  const active=new Set(),completed=new Set();
  const visit=repository=>{
    if(active.has(repository))throw new Error(`mounted source cycle: ${repository}`);
    if(completed.has(repository))return;
    active.add(repository);for(const child of adjacency.get(repository)??[])visit(child);active.delete(repository);completed.add(repository);
  };
  visit(root.repository);
  for(const repository of replacements.keys())if(!held.has(repository))throw new Error(`unused source replacement outside candidate graph: ${repository}`);
  // An immutable owner can occur at several committed coordinates. Propagate
  // every root-to-owner path before package authority is evaluated, including
  // descendants of owners reached through more than one parent.
  const coordinates=new Map([[root.repository,new Set(['.'])]]);
  const pathsOf=repository=>{
    if(coordinates.has(repository))return coordinates.get(repository);
    const paths=new Set();
    for(const edge of edges.filter(edge=>edge.to===repository))for(const parent of pathsOf(edge.from))
      paths.add(parent==='.'?edge.path:posix.join(parent,edge.path));
    coordinates.set(repository,paths);return paths;
  };
  for(const record of resolved)record.paths=[...pathsOf(record.repository)].sort();
  // Declaration readers may inject mount metadata without local object stores.
  // Such a reading has no authenticated tree graph or graph digest.
  if(tree===null)return {...spec,declarationOnly:true,repositories:resolved,edges};
  const order=(a,b)=>{const left=JSON.stringify(a),right=JSON.stringify(b);return left<right?-1:left>right?1:0;};
  const graph={kind:'guix.resolved-source-graph.v1',machine:spec.machine??null,
    entries:[...(spec.entries??[])],buildEntries:[...(spec.buildEntries??[])],receivingPackages:[...(spec.receivingPackages??[])],
    repositories:resolved.map(({repository,commit,tree,paths})=>({repository,commit,tree,paths})).sort(order),edges:edges.sort(order)};
  const graphSha256=createHash('sha256').update(JSON.stringify(graph)).digest('hex');
  const {declarationOnly,...exactSpec}=spec;
  return {...exactSpec,repositories:resolved,graph,graphSha256};
}

/** Root source identity and its selected definition are distinct committed
 * objects. Missing lock/channel files remain visible until execution admission. */
export function machineSourceIdentity(snapshot,ref='HEAD',{repository:expectedRepository}={}){
  if(typeof snapshot!=='string'||snapshot.includes('\\')||snapshot.split('/').some(part=>part==='.'||part==='..')||snapshot.includes('//'))
    throw new Error('machine definition path must have a canonical spelling');
  const path=resolve(snapshot);
  if(realpathSync(path)!==path)throw new Error('machine definition path is redirected');
  const top=realpathSync(git(path,'rev-parse','--show-toplevel').trim());
  const definition=relative(top,path).split('\\').join('/')||'.';
  if(definition!=='.'&&(posix.isAbsolute(definition)||posix.normalize(definition)!==definition||definition.split('/').some(part=>!part||part==='..'||part==='.')))
    throw new Error('machine definition is outside its exact repository root');
  const commit=git(top,'rev-parse',`${ref}^{commit}`).trim(),prefix=definition==='.'?'':definition+'/';
  const blob=name=>{try{return git(top,'rev-parse',`${commit}:${prefix}${name}`).trim();}catch{return null;}};
  const machineBlob=blob('machine.scm');
  if(!COMMIT.test(commit)||!COMMIT.test(machineBlob??''))throw new Error('machine definition has no exact committed Guix identity');
  // A target has no authored package inventory. The caller's admitted canonical
  // owner must match the actual Git acquisition endpoint for this source root.
  const origin=git(top,'remote','get-url','origin').trim();
  const repository=repositoryOf(origin);
  if(!repository||(expectedRepository!==undefined&&repository!==expectedRepository))
    throw new Error('target source differs from its admitted canonical repository');
  return {repository,commit,tree:git(top,'rev-parse',`${commit}^{tree}`).trim(),definition,
    definitionTree:definition==='.'?git(top,'rev-parse',`${commit}^{tree}`).trim():git(top,'rev-parse',`${commit}:${definition}`).trim(),
    machineBlob,channelsBlob:blob('channels.scm'),lockBlob:null};
}

/** The release controller's own repository: its package is that repository's root. */
export const CONTROLLER_REPOSITORY='red-cup-engineering/guix-machine-release-service';

/** A reader that follows no mount below the machine repository's own: only what the machine repository mounts. */
export const directMountsOnly=()=>new Map();

/** The default reader of what a mounted repository mounts: its exact commit, fetched without blobs into the
 *  house source cache, then read as gitlinks. */
export function fetchedMounts(source){
  const acquire=(directory,...args)=>{const r=spawnSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:directory,encoding:'utf8',maxBuffer:64*1024*1024});
    if(r.error||r.status!==0)throw r.error??new Error(`mounted source acquisition failed: ${r.stderr}`);return r.stdout;};
  const root=join(process.env.XDG_CACHE_HOME??join(homedir(),'.cache'),'561-group','mounted-sources');
  const directory=join(root,encodeURIComponent(source.repository));
  if(!existsSync(join(directory,'.git'))){
    mkdirSync(directory,{recursive:true});
    acquire(directory,'init','-q');
    acquire(directory,'remote','add','origin',`https://github.com/${source.repository}.git`);
    acquire(directory,'config','remote.origin.promisor','true');
    acquire(directory,'config','remote.origin.partialclonefilter','blob:none');
  }
  try{git(directory,'rev-parse','--verify',`${source.commit}^{commit}`);}
  catch{acquire(directory,'fetch','-q','--depth=1','--no-tags','--filter=blob:none','origin',source.commit);}
  // Hydrate only the authored mount declaration through the explicit ordinary
  // acquisition port. The shared graph reader itself never invokes a promisor.
  const declaration=git(directory,'ls-tree',source.commit,'--','.gitmodules').trim();
  if(declaration){
    const match=/^100(?:644|755) blob ([0-9a-f]{40})\t\.gitmodules$/u.exec(declaration);
    if(!match)throw new Error('mounted declaration is not a committed regular file');
    try{git(directory,'cat-file','-e',match[1]);}
    catch{acquire(directory,'fetch','-q','--no-tags','--no-write-fetch-head','--recurse-submodules=no','--filter=blob:none','origin',match[1]);}
  }
  return gitlinks(directory,source.commit,{requireAll:true});
}

/** Metadata-only ownership of the authenticated target source and its mounts.
 * Common software selection belongs to Code's independently received roots;
 * a target declaration never supplies another entry/package inventory. */
export function machineSources(snapshot,ref='HEAD',{mounts=fetchedMounts}={}){
  const identity=machineSourceIdentity(snapshot,ref);
  const top=git(snapshot,'rev-parse','--show-toplevel').trim();
  const commit=identity.commit;
  const self={repository:identity.repository,commit,path:'.'};
  const mounted=[...gitlinks(top,commit,{requireAll:true})].map(([repository,link])=>({repository,commit:link.commit,path:link.path,ref:link.ref}));
  if(mounted.some(source=>source.repository===self.repository))throw new Error(`${self.repository} mounts itself`);
  const declaration={declarationOnly:true,machine:identity,repositories:[self,...mounted],entries:[],buildEntries:[],receivingPackages:[]};
  if(mounts===directMountsOnly)return declaration;
  return mountedSourceClosure(declaration,()=>undefined,{tree:null,link:(_directory,_commit,{source})=>mounts(source)});
}

if(isCliEntry(import.meta.url)){
  const [snapshot,ref='HEAD']=process.argv.slice(2);
  if(!snapshot){console.error('usage: source-pins.mjs SNAPSHOT [REF]');process.exit(1);}
  try{process.stdout.write(JSON.stringify(machineSources(snapshot,ref),null,2)+'\n');}
  catch(error){console.error(error.message);process.exit(1);}
}
