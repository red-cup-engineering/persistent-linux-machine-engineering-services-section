import assert from 'node:assert/strict';
import {readFile,realpath,lstat,mkdir,open,rm,rmdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {join,resolve,relative,dirname,isAbsolute,sep,posix} from 'node:path';
import {pathToFileURL} from 'node:url';
import {workspaceSelectionSources,readCommittedSourceFile} from './workspace-selection-sources.mjs';
import {admittedRuntimeFile,selectedPackageDirectory} from './package-receiving.mjs';
import {materializeOwnerSources} from './materialize-sources.mjs';
import {mountedSourceClosure,gitlinks} from './source-pins.mjs';
import {treeFiles,prefetch,decodeGitBlobBatch} from './prepare-sources.mjs';
import {projectLspaceCorpus} from './lspace-corpus.mjs';

const PACKAGE='@lenticule-science/l-space';
const inside=(root,path)=>{const offset=relative(root,path);return !isAbsolute(offset)&&offset!=='..'&&!offset.startsWith('..'+sep);};
const portable=path=>path.split(sep).join('/');
const canonical=path=>typeof path==='string'&&path&&path.split('/').every(p=>p&&p!=='.'&&p!=='..')&&!isAbsolute(path)&&!/[\\\0]/u.test(path);

// Re-derive the complete owner graph from its exact carriers. This reading has
// no package selection, source replacement, checkout, or transport fallback.
function receiveOwnerGraph(preparation,carrier){
  const repositories=preparation.repositories;
  const roots=repositories.filter(row=>row.path==='.');
  if(roots.length!==1||roots[0].repository!==carrier.repository||roots[0].commit!==carrier.commit)
    throw new Error('corpus owner root differs from the selected Code carrier');
  const root=roots[0],mounts=[...gitlinks(root.directory,root.commit,{requireAll:true})].map(([repository,mount])=>({repository,...mount}));
  const spec={machine:null,repositories:[{repository:root.repository,commit:root.commit,path:'.'},...mounts],entries:[],buildEntries:[],receivingPackages:[]};
  const reading=mountedSourceClosure(spec,source=>{
    const found=repositories.filter(row=>row.repository===source.repository&&row.commit===source.commit);
    if(found.length!==1)throw new Error('corpus descendant lacks its exact source carrier');
    return found[0].directory;
  });
  if(reading.graphSha256!==preparation.graphSha256||JSON.stringify(reading.graph)!==JSON.stringify(preparation.graph)||reading.repositories.length!==repositories.length)
    throw new Error('corpus carriers differ from their complete owner graph');
  return reading;
}

/** Enroll the existing reader data occurrence after Code's portable packaging
 * and the committed envelope. The enclosing caller owns the fresh stage and
 * lease, and removes it on any failure. MATERIALIZE is the existing acquisition
 * port; the CLI exposes no override. No application factory is evaluated here.
 */
export async function assembleWorkspaceCorpus({selection,snapshot,target,runtime,softwareRoot=runtime,sourceWork,materialize=materializeOwnerSources}){
  const root=resolve(runtime),software=resolve(softwareRoot);
  if(await realpath(root)!==root||!(await lstat(root)).isDirectory())throw new Error('portable corpus runtime is redirected');
  const projection=await workspaceSelectionSources({selection,snapshot,target});
  const sources=JSON.parse(await readFile(join(root,'.metadata/sources.json'),'utf8'));
  for(const row of sources.packages){
    const exact=projection.sources.packages.find(p=>p.name===row.name);
    if(!exact||['version','repository','commit','path','sourceManifestSha256'].some(key=>row[key]!==exact[key]))
      throw new Error('portable corpus provider differs from authenticated Code selection');
  }
  if(new Set(sources.packages.map(row=>row.name)).size!==sources.packages.length)throw new Error('portable corpus provider is duplicated');
  const require=createRequire(join(software,'package.json'));
  const installedExport=async specifier=>{
    const parts=specifier.split('/'),name=parts.slice(0,2).join('/'),key='./'+parts.slice(2).join('/');
    const source=sources.packages.find(row=>row.name===name),carrier=projection.carriers.find(row=>row.package===name);
    if(!source||!carrier)throw new Error('corpus reader is outside selected runtime: '+name);
    const prefix=carrier.packagePath==='.'?'':carrier.packagePath+'/';
    const manifest=JSON.parse(readCommittedSourceFile(carrier,prefix+'package.json').bytes),target=manifest.exports?.[key];
    if(typeof target!=='string'||!target.startsWith('./')||!canonical(target.slice(2)))throw new Error('corpus reader lacks its selected bounded export: '+specifier);
    const expected=resolve(selectedPackageDirectory(software,source),target),installed=admittedRuntimeFile(software,require.resolve(specifier));
    if(installed!==expected)throw new Error('corpus reader differs from selected installed location');
    const bytes=readCommittedSourceFile(carrier,prefix+target.slice(2)).bytes;
    assert.deepEqual(await readFile(installed),bytes,'corpus reader differs from committed provider bytes');
    return import(pathToFileURL(installed).href);
  };
  const readDeclaration=async(path,encoding)=>{
    const absolute=resolve(path);
    if(encoding!=='utf8'||!absolute.endsWith('.json')||!inside(root,absolute)&&!inside(software,absolute))throw new Error('corpus declaration is outside admitted JSON scope');
    let carrierRoot=inside(root,absolute)?root:software;
    const file=portable(relative(carrierRoot,absolute));
    if(root!==software&&carrierRoot===root){
      // Readers retain their ordinary relative URLs in the future composite
      // root. Resolve its top-level namespace before acquiring JSON bytes.
      const entry=file.split('/')[0];
      const present=async base=>lstat(join(base,entry)).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      const [local,shared]=await Promise.all([present(root),present(software)]);
      if(local&&shared)throw new Error('target declaration namespace overlaps shared software');
      if(shared)carrierRoot=software;
    }
    const admitted=admittedRuntimeFile(carrierRoot,join(carrierRoot,file));
    // Fixed snapshot deployment records retain their original relative layout.
    // Other packed public JSON is joined to its received provider source before
    // bytes reach the genuine owner reader, never interpreted a second time.
    const provider=sources.packages.filter(row=>inside(resolve(software,row.installationPath),admitted))
      .sort((a,b)=>b.installationPath.length-a.installationPath.length)[0];
    let expected;
    if(carrierRoot===root&&/^(deployment|deployments)\//u.test(file)){
      const carrier=projection.targetCarrier;
      expected=readCommittedSourceFile(carrier,(projection.identity.definition==='.'?'':projection.identity.definition+'/')+file).bytes;
    }else{
      if(!provider)throw new Error('corpus declaration has no received source provider');
      const carrier=projection.carriers.find(row=>row.package===provider.name);
      const path=portable(relative(resolve(software,provider.installationPath),admitted));
      expected=readCommittedSourceFile(carrier,(carrier.packagePath==='.'?'':carrier.packagePath+'/')+path).bytes;
    }
    assert.deepEqual(await readFile(admitted),expected,'corpus declaration differs from committed source');
    return expected.toString('utf8');
  };
  const {readEnterpriseWeb}=await installedExport('@red-cup-engineering/feltos/server/installed-web');
  const {readInstanceDefinition}=await installedExport('@red-cup-engineering/metroplat/instance');
  if(typeof readEnterpriseWeb!=='function'||typeof readInstanceDefinition!=='function')throw new Error('portable reader suppliers lack the qualified data-only API');
  const host=await readEnterpriseWeb(join(root,'deployment/host.json'),{readFile:readDeclaration});
  const instance=await readInstanceDefinition(host.instancePath,{readFile:readDeclaration});
  if(instance.applications!==undefined&&!Array.isArray(instance.applications))throw new Error('instance applications must be an array');
  const applications=(instance.applications??[]).filter(row=>row?.module==='@lenticule-science/l-space/metroplat'&&row.export==='lSpaceMetroplat');
  if(!applications.length)return null;
  if(applications.length!==1)throw new Error('instance declares multiple L-Space readers');
  const configuration=applications[0].configuration,source=sources.packages.find(row=>row.name===PACKAGE),carrier=projection.carriers.find(row=>row.package===PACKAGE);
  if(!source||!carrier||carrier.repository!=='lenticule-science/science-services-section'||carrier.path==='.'||!canonical(configuration?.root)||!canonical(configuration?.sciencePrefix)||configuration.sciencePrefix.includes('/'))
    throw new Error('L-Space needs its genuine selected Science source occurrence');
  const sourceOccurrence={repository:carrier.repository,commit:carrier.commit,path:carrier.path};
  if(sourceOccurrence.path!==posix.join(configuration.root,configuration.sciencePrefix))throw new Error('L-Space configuration differs from selected Science occurrence');
  if(typeof sourceWork!=='string'||!isAbsolute(sourceWork))throw new Error('corpus acquisition needs an explicit absolute staging directory');
  const work=resolve(sourceWork);
  if(dirname(work)!==dirname(root)||work===root||inside(carrier.directory,work)||inside(work,carrier.directory))
    throw new Error('corpus acquisition needs its exclusive sibling staging directory');
  const {lSpaceReaderPolicy}=await installedExport(PACKAGE+'/reader-policy');
  const {readMarkdownDocument}=await installedExport('@red-cup-engineering/markdown-engineering-services-section/read-markdown-document');
  const {parseBody}=await installedExport('@red-cup-engineering/markdown-engineering-services-section/relational-markdown');
  const preparation=materialize(carrier,work);
  const reading=receiveOwnerGraph(preparation,carrier),trees=new Map();
  const carrierFor=source=>{const found=reading.repositories.find(row=>row.repository===source.repository&&row.commit===source.commit);if(!found)throw new Error('missing owner data carrier');return found;};
  const listTree=source=>{const c=carrierFor(source);if(!trees.has(c.repository))trees.set(c.repository,treeFiles(c.directory,c.commit));return trees.get(c.repository);};
  const readBlobs=(source,rows)=>{
    const c=carrierFor(source);prefetch(c.directory,c.commit,rows.map(row=>row.oid));
    const result=spawnSync('git',['cat-file','--batch'],{cwd:c.directory,input:rows.map(row=>row.oid+'\n').join(''),maxBuffer:256*1024*1024});
    if(result.error||result.status!==0)throw result.error??new Error('cannot read selected committed corpus blobs');
    return decodeGitBlobBatch(result.stdout,rows).map(row=>row.bytes);
  };
  const files=[],directories=[];
  const writeBlob=async row=>{
    const file=resolve(root,row.path);if(!inside(root,file)||file===root)throw new Error('corpus output escapes unpublished runtime');
    let parent=root;
    for(const part of relative(root,dirname(file)).split(sep).filter(Boolean)){
      parent=join(parent,part);
      try{if(!(await lstat(parent)).isDirectory())throw new Error('corpus output ancestor is redirected');}
      catch(error){if(error.code!=='ENOENT')throw error;await mkdir(parent);directories.push(parent);}
    }
    const output=await open(file,'wx',row.mode==='100755'?0o755:0o644);files.push(file);
    try{await output.writeFile(row.bytes);}finally{await output.close();}
  };
  try{
    const result=await projectLspaceCorpus({graph:reading.graph,graphSha256:reading.graphSha256,packageSource:source,sourceOccurrence,configuration,
      readerPolicy:lSpaceReaderPolicy,parseDocumentBody:markdown=>parseBody(readMarkdownDocument(markdown,{onInvalidFrontmatter:'diagnose'}).body),listTree,readBlobs,writeBlob});
    receiveOwnerGraph(preparation,carrier);
    await workspaceSelectionSources({selection,snapshot,target});
    await writeFile(join(root,'.metadata/corpus-source.json'),JSON.stringify({sourceOccurrence,graph:reading.graph,graphSha256:reading.graphSha256,projection:result},null,2)+'\n',{flag:'wx'});
    return result;
  }catch(error){
    const failures=[];for(const file of files.reverse())try{await rm(file);}catch(e){failures.push(e);}
    for(const path of directories.reverse())try{await rmdir(path);}catch(e){failures.push(e);}
    if(failures.length)throw new AggregateError([error,...failures],'corpus projection cleanup incomplete');throw error;
  }
}
