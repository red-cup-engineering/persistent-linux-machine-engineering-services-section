import {createHash} from 'node:crypto';
import {posix} from 'node:path';
import {isPromise} from 'node:util/types';

const PACKAGE='@lenticule-science/l-space';
const REGULAR=new Set(['100644','100755']);
const MARKDOWN=/\.(?:md|markdown)$/iu;
const ABSOLUTE_OR_FRAGMENT=/^(?:[a-z][a-z0-9+.-]*:|\/|#)/iu;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function canonical(path,label){
  if(typeof path!=='string'||!path||path.startsWith('/')||path.includes('\\')||path.includes('\0')
    ||path.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error(`${label} must be a canonical relative path`);
  return path;
}
function decision(value){
  if(typeof value!=='boolean'){
    if(isPromise(value))Promise.prototype.then.call(value,undefined,()=>{});
    throw new TypeError('L-Space reader admission must return a boolean');
  }
  return value;
}
function images(value,found=[]){
  if(Array.isArray(value)){for(const item of value)images(item,found);return found;}
  if(!value||typeof value!=='object')return found;
  if(value.kind==='image'&&typeof value.src==='string'&&!ABSOLUTE_OR_FRAGMENT.test(value.src))found.push(value.src);
  for(const child of Object.values(value))images(child,found);
  return found;
}

/** Project the installed reader's source occurrence, never a package-relative corpus.
 * The caller has re-derived GRAPH with validatePreparationGraph and selected PACKAGE_SOURCE
 * with the existing package-source reader. READER_POLICY and PARSE_DOCUMENT_BODY are the
 * genuine selected owner exports, not a new policy declaration. Source callbacks read exact
 * committed tree metadata/blobs; WRITE_BLOB receives the original occurrence-relative path.
 * A portable caller may instead supply the complete owner-rooted graph (machine:null)
 * and SOURCE_OCCURRENCE, authenticated from its selected source carrier. Graph coordinates
 * then remain owner-relative while admission/output coordinates remain machine-relative.
 * This helper neither selects another revision nor acquires a repository or deployment.
 */
export async function projectLspaceCorpus({graph,graphSha256,packageSource,configuration,
  sourceOccurrence,readerPolicy,parseDocumentBody,listTree,readBlobs,writeBlob}){
  if(graph?.kind!=='guix.resolved-source-graph.v1'||digest(graph)!==graphSha256)
    throw new Error('L-Space projection needs its authenticated preparation graph');
  if(packageSource?.name!==PACKAGE)throw new Error('L-Space projection needs its selected package supplier');
  for(const [name,fn] of Object.entries({readerPolicy,parseDocumentBody,listTree,readBlobs,writeBlob}))
    if(typeof fn!=='function')throw new TypeError(`${name} must be a function`);
  const root=canonical(configuration?.root,'L-Space reader root');
  const policy=readerPolicy({sciencePrefix:configuration?.sciencePrefix,excludes:configuration?.excludes});
  if(typeof policy?.admitPath!=='function'||!Array.isArray(policy.excludes))throw new TypeError('invalid selected L-Space reader policy');
  // Requiring a declared section prevents an empty or widened prefix from promoting siblings.
  const section=canonical(configuration?.sciencePrefix,'L-Space Science section');
  if(section.includes('/'))throw new Error('L-Space Science section must be one path segment');
  const occurrence=posix.join(root,section);
  const owners=graph.repositories.filter(source=>source.repository===packageSource.repository&&source.commit===packageSource.commit);
  if(owners.length!==1)
    throw new Error('L-Space reader occurrence differs from its selected package repository and commit');
  let graphRoot=occurrence;
  if(sourceOccurrence!==undefined){
    const roots=graph.repositories.filter(source=>source.paths?.includes('.'));
    if(graph.machine!==null||roots.length!==1||roots[0]!==owners[0]||owners[0].paths.length!==1
      ||sourceOccurrence?.repository!==packageSource.repository||sourceOccurrence?.commit!==packageSource.commit
      ||canonical(sourceOccurrence?.path,'L-Space source occurrence')!==occurrence)
      throw new Error('L-Space owner graph differs from its authenticated source occurrence');
    graphRoot='.';
  }else if(!owners[0].paths?.includes(occurrence))
    throw new Error('L-Space reader occurrence differs from its selected package repository and commit');
  const byOwner=new Map(graph.repositories.map(source=>[source.repository,source]));
  if(byOwner.size!==graph.repositories.length)throw new Error('ambiguous source owner in L-Space preparation graph');
  const admitted=path=>{
    const relative=posix.relative(root,path);
    if(relative.startsWith('../')||relative==='..'||posix.isAbsolute(relative))return false;
    return !relative.split('/').some(part=>policy.excludes.includes(part))&&decision(policy.admitPath(relative));
  };
  const occurrences=[],occupied=new Set();
  function visit(source,path,coordinate,ancestors=new Set()){
    if(ancestors.has(source.repository))throw new Error('cyclic L-Space source occurrence');
    if(occupied.has(path))throw new Error('ambiguous L-Space source occurrence');
    occupied.add(path);
    const edges=graph.edges.filter(edge=>edge.from===source.repository),children=[];
    for(const edge of edges){
      const child=byOwner.get(edge.to),mount=canonical(edge.path,'source mount');
      const at=posix.join(path,mount),childCoordinate=posix.join(coordinate,mount);
      if(!child||child.commit!==edge.selectedCommit||!child.paths?.includes(childCoordinate))
        throw new Error('unresolved L-Space descendant source identity');
      children.push({edge,source:child,path:at,coordinate:childCoordinate});
    }
    occurrences.push({source,path,children});
    const next=new Set([...ancestors,source.repository]);
    for(const child of children)visit(child.source,child.path,child.coordinate,next);
  }
  visit(owners[0],occurrence,graphRoot);
  const files=new Map();
  // Read all relevant immutable tree metadata and verify child mounts before any data blob.
  for(const item of occurrences){
    if(posix.relative(root,item.path).split('/').some(part=>policy.excludes.includes(part)))continue;
    const rows=await listTree(item.source);
    if(!Array.isArray(rows))throw new TypeError('source tree reader must return entries');
    const mounts=new Map();
    for(const row of rows){
      canonical(row.file,'source tree path');
      const path=posix.join(item.path,row.file);
      if(row.mode==='160000'){
        if(mounts.has(row.file))throw new Error('duplicate L-Space source mount');
        mounts.set(row.file,row.oid);
        const matches=item.children.filter(child=>child.edge.path===row.file&&child.edge.commit===row.oid);
        if(matches.length!==1)throw new Error('unresolved committed L-Space child mount');
        continue;
      }
      if(!REGULAR.has(row.mode)||row.type!=='blob'||!admitted(path))continue;
      if(!/^[a-f0-9]{40}$/u.test(row.oid??''))throw new Error('source file needs an exact Git blob identity');
      if(files.has(path))throw new Error('overlapping L-Space source file occurrences');
      files.set(path,{...row,path,source:item.source});
    }
    if(item.children.some(child=>mounts.get(child.edge.path)!==child.edge.commit))
      throw new Error('L-Space source graph child is missing from its committed tree');
  }
  const documents=[...files.values()].filter(row=>MARKDOWN.test(row.file)).sort((a,b)=>a.path.localeCompare(b.path));
  if(!documents.length)throw new Error('L-Space occurrence has no admitted Markdown documents');
  const wantedAssets=new Map(),written=new Set();
  async function receive(rows,document){
    // Each provider is asked only for already-admitted rows from its exact immutable commit.
    const groups=new Map();
    for(const row of rows){const key=row.source.repository; if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
    for(const group of groups.values()){
      const blobs=await readBlobs(group[0].source,group);
      if(!Array.isArray(blobs)||blobs.length!==group.length)throw new Error('L-Space blob batch differs from selected files');
      for(let index=0;index<group.length;index++){
        const row=group[index],bytes=blobs[index];
        if(!Buffer.isBuffer(bytes)||createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')!==row.oid)
          throw new Error('L-Space source blob identity differs');
        if(document){
          const parsed=await parseDocumentBody(bytes.toString('utf8'));
          for(const image of images(parsed)){
            let decoded;
            try{decoded=decodeURIComponent(image.replace(/[?#].*$/u,''));}catch{continue;}
            if(!decoded||decoded.includes('\\')||decoded.includes('\0')||ABSOLUTE_OR_FRAGMENT.test(decoded))continue;
            const target=posix.normalize(posix.join(posix.dirname(row.path),decoded));
            if(!target.startsWith(occurrence+'/')||!admitted(target))continue;
            const asset=files.get(target);
            // Missing/excluded/redirected embeds remain unavailable to the existing reader.
            if(asset&&!MARKDOWN.test(asset.file))wantedAssets.set(target,asset);
          }
        }
        await writeBlob({path:row.path,bytes,mode:row.mode,repository:row.source.repository,
          commit:row.source.commit,sourcePath:row.file,oid:row.oid});
        written.add(row.path);
      }
    }
  }
  await receive(documents,true);
  const assets=[...wantedAssets.values()].filter(row=>!written.has(row.path)).sort((a,b)=>a.path.localeCompare(b.path));
  await receive(assets,false);
  return Object.freeze({root,occurrence,repository:packageSource.repository,commit:packageSource.commit,
    sourceGraphSha256:graphSha256,documents:documents.length,assets:assets.length});
}
