import {readFile,writeFile,mkdir,cp,rm,lstat,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';

/** Fabricate the ingress asset from the target's authenticated declaration.
 * The source caller admits its committed bytes before invoking this writer. */
export async function writeTargetIngress(closure,bytes){
  const ingress=JSON.parse(bytes);
  if(typeof ingress.caddyConfiguration!=='string'||!ingress.caddyConfiguration.length)
    throw new TypeError('target ingress must retain its authored Caddy configuration');
  const file=join(resolve(closure),'deployment/Caddyfile');
  await writeFile(file,ingress.caddyConfiguration,{flag:'wx',mode:0o644});
  return {path:'deployment/Caddyfile',source:'deployment/ingress.json',sha256:createHash('sha256').update(ingress.caddyConfiguration).digest('hex')};
}

/** Carry the existing receiver envelope around an already admitted closure.
 * This phase neither selects/installs dependencies nor admits source identities.
 * The caller owns the unpublished closure and source/build lease, authenticates
 * its controller/snapshot/provenance inputs, and seals the result with LAGOON.
 * Generated metadata preserves the caller's actual dependency/source carriers.
 */
export async function writeReleaseEnvelope({closure,snapshot,controller,lock,sources,sourceImports,
  dependencyEvidence,machineCommit,machineRepository,software}){
  const destination=resolve(closure);
  if(await realpath(destination)!==destination||!(await lstat(destination)).isDirectory())
    throw new Error('release envelope requires an unredirected unpublished closure');
  if(!Buffer.isBuffer(lock)||(sourceImports!==undefined&&!Buffer.isBuffer(sourceImports)))
    throw new TypeError('release envelope requires original lock and source-import bytes');
  // All fixed declaration inputs are read before creating receiver-owned output.
  // Private runtime environment files are not among these source declarations.
  const declarations=new Map();
  for(const name of ['machine.scm','channels.scm'])
    declarations.set(name,await readFile(join(snapshot,name)));
  const release={machineCommit,machineRepository,dependencyLockSha256:createHash('sha256').update(lock).digest('hex'),
    ...(software===undefined?{}:{software})};
  const metadata=new Map([
    ['dependencies.lock.yaml',lock],
    ['runtime-dependencies.json',JSON.stringify(dependencyEvidence,null,2)+'\n'],
    ['sources.json',JSON.stringify(sources,null,2)+'\n'],
    ...(sourceImports===undefined?[]:[['source-imports.json',sourceImports]]),
    ['release.json',JSON.stringify(release,null,2)+'\n'],
  ]);
  const names=['.metadata','.controller'];
  // No existing receiver output may be replaced. A later stage cannot silently
  // relabel or partially amend an earlier envelope in this portable tree.
  for(const name of names){
    try{await lstat(join(destination,name));throw new Error('release envelope destination already exists: '+name);}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const owned=[];
  try{
    for(const name of names){const directory=join(destination,name);await mkdir(directory);owned.push(directory);}
    for(const [name,body] of metadata)await writeFile(join(destination,'.metadata',name),body,{flag:'wx'});
    // Keep the controller's source layout; its package-local install links have
    // the old producer depth and are not runtime inputs. The receiver uses the
    // same sealed root package namespace as the application.
    const controllerModules=join(controller,'node_modules');
    await cp(controller,join(destination,'.controller'),{recursive:true,filter:path=>path!==controllerModules});
    for(const [name,body] of declarations)await writeFile(join(destination,'.controller',name),body,{flag:'wx'});
    return release;
  }catch(error){
    const failures=[];
    for(const directory of owned.reverse())try{await rm(directory,{recursive:true});}catch(cause){failures.push(cause);}
    if(failures.length)throw new AggregateError([error,...failures],'release envelope refused; owned output cleanup incomplete');
    throw error;
  }
}
