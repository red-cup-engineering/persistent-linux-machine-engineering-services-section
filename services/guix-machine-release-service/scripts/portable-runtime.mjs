import assert from 'node:assert/strict';
import {lstat,readdir,readlink,realpath,readFile} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,dirname,sep} from 'node:path';

const inside=(root,path)=>{const offset=relative(root,path);return !isAbsolute(offset)&&offset!=='..'&&!offset.startsWith('..'+sep);};

/** Check the complete producer-owned portable tree before any compiler follows
 * its package links. Every immediate symlink target and final target must stay
 * inside this tree; external-and-return chains are not sealed dependencies.
 * The caller's exclusive source/build lease prevents concurrent mutation.
 */
export async function confinePortableRuntime(path){
  const root=resolve(path);
  if(await realpath(root)!==root||!(await lstat(root)).isDirectory())throw new Error('portable runtime root is redirected');
  async function walk(directory){
    for(const entry of await readdir(directory,{withFileTypes:true})){
      const file=join(directory,entry.name),stat=await lstat(file);
      if(stat.isSymbolicLink()){
        const link=await readlink(file);
        if(isAbsolute(link))throw new Error('portable link must remain relative when sealed');
        const target=resolve(dirname(file),link);
        if(!inside(root,target)||!inside(root,await realpath(file)))throw new Error('portable link leaves its admitted closure');
        const targetStat=await lstat(await realpath(file));
        if(!targetStat.isFile()&&!targetStat.isDirectory())throw new Error('portable link selects a nonregular carrier');
      }else if(stat.isDirectory())await walk(file);
      else if(!stat.isFile())throw new Error('portable runtime contains a nonregular carrier');
    }
  }
  await walk(root);
  return root;
}

/** Join genuine compiler observations to selected source identities. This adds
 * only the actual installed location; it does not turn a compilation receipt
 * into package-byte provenance or qualify native execution.
 */
export async function bindPortablePackages(runtime,sources,compilation,commit,observedRoot=runtime){
  const root=await confinePortableRuntime(runtime);
  const origin=resolve(observedRoot);
  if(compilation?.type!=='NodeRuntimeSourceCompilation'||compilation.version!==1||
      compilation.scope!=='packed-selected-packages'||compilation.staticBindingsCompiled!==true||
      compilation.applicationExecuted!==false||compilation.sourceCommit!==commit||!Array.isArray(compilation.inspectedPackages))
    throw new Error('portable source binding requires its exact selected compilation');
  const seen=new Set(),locations=new Set();
  const packages=compilation.inspectedPackages.map(observation=>{
    const matches=sources.packages.filter(source=>source.name===observation.name&&source.version===observation.version);
    if(matches.length!==1||seen.has(observation.name))throw new Error('portable provider is not uniquely selected');
    const observed=resolve(observation.directory);
    if(!inside(origin,observed))throw new Error('portable provider observation is outside the producer root');
    const directory=resolve(root,relative(origin,observed));
    if(!inside(root,directory)||locations.has(directory))throw new Error('portable provider location is not unique inside the closure');
    seen.add(observation.name);locations.add(directory);
    return {...matches[0],installationPath:relative(root,directory).split(sep).join('/')||'.'};
  });
  for(const source of packages){
    const directory=resolve(root,source.installationPath);
    if(await realpath(directory)!==directory)throw new Error('compiler provider location is redirected');
    const manifest=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));
    assert.equal(manifest.name,source.name);assert.equal(manifest.version,source.version);
    const alias=source.installationPath==='.'?root:join(root,'node_modules',source.name);
    if(await realpath(alias)!==directory)throw new Error('portable alias differs from selected provider location');
  }
  for(const name of sources.receivingPackages??[])if(!seen.has(name))throw new Error('portable receiving provider is absent: '+name);
  return {...sources,packages};
}

// Receive the uniquely selected canonical driver programme used by native
// target declarations. A deployment-root compatibility alias is not software.
export async function bindPortableDriver(runtime,sources){
  const root=await confinePortableRuntime(runtime);
  const matches=sources.packages.filter(row=>row.name==='@red-cup-engineering/feltos');
  if(matches.length!==1)throw new Error('shared software needs one selected FeltOS driver');
  const directory=resolve(root,matches[0].installationPath);
  if(!inside(root,directory)||directory===root||await realpath(directory)!==directory)throw new Error('shared driver location is not admitted');
  const manifest=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));
  if(manifest.name!==matches[0].name||manifest.bin?.feltos!=='feltos.mjs')throw new Error('shared software lacks the canonical FeltOS entry');
  const programme=join(directory,manifest.bin.feltos);
  if(await realpath(programme)!==programme||!(await lstat(programme)).isFile())throw new Error('shared driver programme is redirected or absent');
  await confinePortableRuntime(root);
}
