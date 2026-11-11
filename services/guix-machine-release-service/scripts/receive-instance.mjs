import {readFile,lstat} from 'node:fs/promises';
import {readFileSync,realpathSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isCliEntry} from './cli-entry.mjs';
import {admittedRuntimeFile,admittedRuntimeDirectory,admittedRuntimeCarriers,resolveAdmittedRuntimeModule} from './package-receiving.mjs';
import {confinePortableRuntime} from './portable-runtime.mjs';

// The build-only structural caller binds GroupOperations' existing declaration
// discovery before importing any provider. Its schedule factory reads release
// and job JSON, but does not run jobs or read their host-state receipts.
export async function prepareBuildInstanceDiscovery(artifact){
  const root=resolve(artifact),carriers=admittedRuntimeCarriers(root);
  for(const carrier of new Set(Object.values(carriers)))await confinePortableRuntime(carrier);
  for(const entry of ['deployments','services']){
    const path=join(root,entry);
    const stat=await lstat(path).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(stat)admittedRuntimeDirectory(root,path);
  }
  process.env.METROPLAT_DEPLOYMENTS_ROOT=join(root,'deployments');
}

export function installedInstanceProviderPaths(artifact) {
  const hostPath=join(resolve(artifact),'deployment/host.json');
  admittedRuntimeFile(artifact,hostPath);
  return {hostPath,
    hostReader:resolveAdmittedRuntimeModule(artifact,'@red-cup-engineering/feltos/server/installed-web'),
    instanceReader:resolveAdmittedRuntimeModule(artifact,'@red-cup-engineering/metroplat/instance')};
}

// Use the real installed readers with one admitted, pre-I/O data-read boundary.
// Source composition must receive the owners' qualified readFile-port revisions.
// No operation, application, clock, listener or companion is started here.
export async function receiveInstalledInstance(artifact) {
  const {hostPath,hostReader,instanceReader}=installedInstanceProviderPaths(artifact);
  const {installedEnterpriseWeb}=await import(pathToFileURL(hostReader).href);
  const {installedMetroplatInstance}=await import(pathToFileURL(instanceReader).href);
  const counts=new Map();
  const readerOptions={readFile:async(path,encoding)=>{
    if(encoding!=='utf8')throw new Error('installed declaration requires its UTF-8 read port');
    const file=admittedRuntimeFile(artifact,path);
    counts.set(file,(counts.get(file)??0)+1);
    return readFile(file,encoding);
  }};
  const hostFile=admittedRuntimeFile(artifact,hostPath);
  const web=await installedEnterpriseWeb(hostPath,readerOptions);
  if(!counts.has(hostFile))throw new Error('installed host provider did not receive the admitted read port');
  const instanceFile=admittedRuntimeFile(artifact,web.instancePath),before=counts.get(instanceFile)??0;
  await installedMetroplatInstance(web.instancePath,null,{},hostPath,readerOptions);
  if((counts.get(instanceFile)??0)<=before)throw new Error('installed instance provider did not receive the admitted read port');
}


// Retained generations are received against their authenticated original
// programme/declarations, not eligibility for a successor's driver contract.
// This reads bytes only. The receiver's existing isolated boot/live receiving
// still owns useful-operation proof; no original checker or provider is run.
export function receiveRetainedInstance(artifact,policy){
  const root=realpathSync(artifact);
  if(root!==resolve(artifact)||!/^\/gnu\/store\/[^/]+$/u.test(root))throw new Error('retained artifact is not an exact immutable store output');
  const matches=(policy.retainedReleases??[]).filter(record=>record.storePath===root);
  if(matches.length!==1)throw new Error('retained artifact has no unique authenticated receiving record');
  const record=matches[0],required=['.metadata/release.json','.metadata/sources.json','.controller/machine.json','app/package.json',record.entry,`bin/${policy.name}`,record.host,record.instance];
  if(!Array.isArray(record.files)||new Set(record.files.map(file=>file.path)).size!==record.files.length||required.some(path=>!record.files.some(file=>file.path===path)))throw new Error('retained declarations are not all bound');
  const bytes=new Map();
  for(const file of record.files){
    if(typeof file.path!=='string'||file.path.split('/').some(part=>!part||part==='.'||part==='..')||/[\\\0]/u.test(file.path)||!/^([a-f0-9]{64})$/u.test(file.sha256??''))throw new Error('retained receiving file is not canonical');
    // The original Guix deployment links its admitted-runtime entries. Reuse
    // that constructor's existing typed carrier proof; the launcher is the
    // deployment's own direct generated file, not a runtime entry.
    let current;
    if(file.path===`bin/${policy.name}`){
      if(!lstatSync(join(root,'bin')).isDirectory()||!lstatSync(join(root,file.path)).isFile())throw new Error('retained launcher is redirected');
      current=join(root,file.path);
    }else current=admittedRuntimeFile(root,join(root,file.path));
    const content=readFileSync(current);
    if(createHash('sha256').update(content).digest('hex')!==file.sha256)throw new Error(`retained source bytes differ: ${file.path}`);
    bytes.set(file.path,content);
  }
  const json=path=>JSON.parse(bytes.get(path).toString('utf8'));
  const release=json('.metadata/release.json'),machine=json('.controller/machine.json');
  if(release.machineRepository!==record.repository||release.machineCommit!==record.revision||machine.repository!==record.repository||machine.name!==policy.name||machine.stateCompatibility!=='preserve-existing')throw new Error('retained sealed machine identity differs');
  if(record.repository!==policy.repository&&(record.transferredTo!==policy.repository||!Number.isSafeInteger(record.repositoryId)||record.repositoryId<=0||typeof record.repositoryNodeId!=='string'||!record.repositoryNodeId))throw new Error('retained repository transfer is not admitted');
  const receipt=bytes.get('.metadata/sources.json');
  if(createHash('sha256').update(receipt).digest('hex')!==record.sourceReceiptSha256)throw new Error('retained original source receipt differs');
  const sources=json('.metadata/sources.json'),manifest=json('app/package.json');
  if(!Array.isArray(sources.repositories)||!Array.isArray(sources.packages)||sources.packages.filter(row=>row.name===manifest.name&&sources.repositories.some(source=>source.repository===row.repository&&source.commit===row.commit)).length!==1)throw new Error('retained programme source is not uniquely admitted');
  if(!manifest.bin||!Object.values(manifest.bin).some(entry=>`app/${entry}`===record.entry))throw new Error('retained manifest does not declare its programme');
  for(const file of machine.configurationFiles??[])admittedRuntimeFile(root,resolve(root,file.source));
  for(const check of machine.auxiliaryChecks??[])admittedRuntimeFile(root,resolve(root,check.program));
  if(!lstatSync(join(root,'.guix-systemd')).isDirectory())throw new Error('retained unit carrier is redirected');
  for(const unit of machine.auxiliaryUnits??[]){
    if(typeof unit!=='string'||unit.includes('/')||!lstatSync(join(root,'.guix-systemd',unit)).isFile())throw new Error('retained declared unit is unavailable');
  }
  const node=realpathSync(join(root,'bin/node'));
  if(!/^\/gnu\/store\/[^/]+\/bin\/node$/u.test(node))throw new Error('retained programme interpreter is not store held');
  const launcher=bytes.get(`bin/${policy.name}`).toString('utf8');
  // The actual Guix constructor writes this quoted exec arm. Bind both operands
  // to the held interpreter and declared entry rather than parsing shell code.
  if(!launcher.endsWith(`exec "${node}" "${join(root,record.entry)}" "$@"\n`))throw new Error('retained launcher does not execute its declared programme');
  const host=json(record.host),instance=json(record.instance);
  if(host.version!==1||host.hostKind!=='feltos.enterprise-host'||typeof host.instance!=='string'||resolve(root,record.host,'..',host.instance)!==join(root,record.instance)||instance.version!==1||instance.instanceOf!=='@red-cup-engineering/metroplat'||typeof instance.identity?.id!=='string')throw new Error('retained host/instance declarations differ');
  if(typeof instance.profile!=='string'||!bytes.has(resolve(root,record.instance,'..',instance.profile).slice(root.length+1)))throw new Error('retained instance profile is not bound');
  json(resolve(root,record.instance,'..',instance.profile).slice(root.length+1));
  return {kind:'guix.retained-instance-receiving',storePath:root,repository:release.machineRepository,revision:release.machineCommit,programme:record.entry,declaredProgrammeReceived:true,originalDeclarationsReceived:true,operatingReceiving:false};
}

if(isCliEntry(import.meta.url)) await receiveInstalledInstance(process.argv[2]);
