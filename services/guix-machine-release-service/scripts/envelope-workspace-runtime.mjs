import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,lstat,rm,symlink,realpath,readdir} from 'node:fs/promises';
import {join,dirname,relative,resolve,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {workspaceReceiverInputs,workspaceReceivingSources,receiveCommittedPortableFiles} from './workspace-selection-sources.mjs';
import {bindPortablePackages,bindPortableDriver,confinePortableRuntime} from './portable-runtime.mjs';
import {writeReleaseEnvelope,writeTargetIngress} from './release-envelope.mjs';
import {packageReceivingChecks,sha256} from './package-receiving.mjs';

/** The portable caller supplies a fresh, exclusively held deployment produced
 * by the existing selected PNPM command and its genuine compilation result.
 * This phase does not acquire packages, run applications, seal, or activate.
 */
export async function receiveWorkspaceRuntime({selection,snapshot,target,runtime,compilation,command,generation}){
  const root=await confinePortableRuntime(runtime);
  if(command?.type!=='NodeRuntimeWorkspaceSelectionCommandReceipt'||command.version!==1||command.commit!==selection.commit||command.sourceConfigurationUnchanged!==true||typeof command.produced?.directory!=='string'||command.arguments?.at(-1)!==command.produced.directory||typeof selection.executable!=='string'||command.executable!==selection.executable)throw new Error('portable envelope requires its exact selected command receipt');
  const outputs=command.produced;
  if(!outputs?.directory||!Array.isArray(outputs.files)||outputs.files.length!==3)throw new Error('portable command lacks its observed root products');
  if(!isAbsolute(outputs.directory)||resolve(outputs.directory)!==outputs.directory)throw new Error('portable producer root is not canonical');
  for(const [index,path] of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml'].entries()){
    const row=outputs.files[index];
    if(!row||Object.keys(row).sort().join(',')!=='path,sha256'||row.path!==path||!(typeof row.sha256==='string'&&/^[a-f0-9]{64}$/.test(row.sha256)||path==='pnpm-workspace.yaml'&&row.sha256===null))throw new Error('portable product identity is malformed');
    const file=join(root,path),stat=await lstat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(row.sha256===null){if(stat)throw new Error('portable product differs from observed absence');}
    else if(!stat?.isFile()||sha256(await readFile(file))!==row.sha256)throw new Error('portable product differs from successful producer bytes');
  }
  const projection=await workspaceReceiverInputs({selection,snapshot,target});
  const deployedManifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  const rootProvider=projection.carriers.find(row=>row.package===deployedManifest.name);
  if(!rootProvider||!Array.isArray(selection.roots)||!selection.roots.includes(rootProvider.importer))throw new Error('portable entry owner is outside the explicitly admitted roots');
  assert.deepEqual(command.arguments,['--filter',rootProvider.package,'--config.ignore-scripts=true','--config.inject-workspace-packages=true','deploy','--prod',outputs.directory],'portable command differs from selected deployment');
  const enrolled=workspaceReceivingSources(projection,rootProvider);
  const sources=await bindPortablePackages(root,enrolled,compilation,selection.commit,outputs.directory);
  const consumers=sources.packages.filter(source=>source.name===rootProvider.package);
  if(consumers.length!==1||consumers[0].installationPath!=='.')
    throw new Error('portable receiving consumer must be observed at the actual deploy root');
  const payload=await receiveCommittedPortableFiles(projection,root,sources,{generation,selection});
  // Presence in the compiler observation does not prove every declared test was
  // packed. Receive the complete inventory before common assembly can return.
  packageReceivingChecks(root,sources);
  const lock=await readFile(join(root,'pnpm-lock.yaml'));
  const scopedLock=await readFile(join(selection.artifact,'pnpm-lock.yaml'));
  assert.equal(sha256(scopedLock),selection.scopedLockSha256,'installed selection lock changed');
  // The deployed lock is pnpm's actual producer output, not the historical
  // dependencies.lock.yaml which remains a committed controller declaration.
  const dependencyEvidence={producer:'pnpm-deploy',sourceLockSha256:selection.sourceHashes['pnpm-lock.yaml'],
    scopedLockSha256:selection.scopedLockSha256,portableLockSha256:sha256(lock)};
  try{dependencyEvidence.portableWorkspaceSha256=sha256(await readFile(join(root,'pnpm-workspace.yaml')));}catch(error){if(error.code!=='ENOENT')throw error;}
  return {root,projection,sources,payload,lock,dependencyEvidence};
}

// The separate target envelope never replaces or copies the common software.
// software is the original successful Guix build receipt for that one output.
export async function envelopeWorkspaceRuntime({selection,snapshot,target,runtime,compilation,command,generation,envelope=runtime,software}){
  const received=await receiveWorkspaceRuntime({selection,snapshot,target,runtime,compilation,command,generation});
  const {root,projection,sources,payload,lock,dependencyEvidence}=received;
  const destination=resolve(envelope),separate=destination!==root;
  if(separate){
    if(target===undefined||!software||!/^\/gnu\/store\/[^/]+$/u.test(software.storePath??'')||
        !/^[a-f0-9]{64}$/u.test(software.narSha256??'')||typeof software.root!=='string'||
        !/^\/gnu\/store\/[^/]+$/u.test(root)||await realpath(join(software.storePath,'share/runtime'))!==root)
      throw new Error('target envelope requires the exact shared Guix software receipt');
    if(await realpath(destination)!==destination||!(await lstat(destination)).isDirectory())
      throw new Error('target envelope requires its fresh canonical directory');
    if((await readdir(destination)).length)throw new Error('target envelope output must be empty');
  }else if(target!==undefined||software!==undefined)throw new Error('independent target envelope must remain separate from shared software');
  const work=await mkdtemp(join(tmpdir(),'receiver-envelope-'));
  try{
    const controller=join(work,'controller'),declarations=join(work,'snapshot');
    async function writeRows(base,rows){
      for(const row of rows){const file=join(base,row.path);await mkdir(dirname(file),{recursive:true});await writeFile(file,row.bytes,{flag:'wx',mode:row.mode==='100755'?0o755:0o644});}
    }
    await writeRows(controller,projection.controllerFiles);
    await writeRows(declarations,projection.declarationFiles);
    if(separate){
      // The same owning driver which produced the receipt now checks its held
      // root and hashes the actual immutable output. Shape alone is no proof.
      const driver=fileURLToPath(new URL('./guix-deployment.scm',import.meta.url));
      for(const name of ['guix-deployment.scm']){
        const source=projection.controllerFiles.find(row=>row.path==='scripts/'+name);
        if(!source)throw new Error('selected controller lacks software receipt verification');
        assert.deepEqual(await readFile(fileURLToPath(new URL('./'+name,import.meta.url))),source.bytes,'software verifier differs from selected controller source');
      }
      const verified=spawnSync('guix',['repl','--',driver,'verify',software.storePath,software.root,software.narSha256],{encoding:'utf8',maxBuffer:1024*1024});
      if(verified.error||verified.status!==0)throw verified.error??new Error('shared Guix software receipt was not verified');
      assert.deepEqual(JSON.parse(verified.stdout),{storePath:software.storePath,root:software.root,narSha256:software.narSha256},'software verifier returned another receipt');
    }
    for(const row of projection.deploymentFiles){
      const file=join(destination,row.path);
      try{const stat=await lstat(file);if(!stat.isFile())throw new Error('deployment declaration is redirected');assert.deepEqual(await readFile(file),row.bytes,'portable deployment differs from committed snapshot');}
      catch(error){if(error.code!=='ENOENT')throw error;await writeRows(destination,[row]);}
    }
    const ingress=projection.deploymentFiles.find(row=>row.path==='deployment/ingress.json');
    const targetIngress=ingress===undefined?undefined:await writeTargetIngress(destination,ingress.bytes);
    const driver=sources.packages.find(p=>p.name==='@red-cup-engineering/feltos');
    if(!driver)throw new Error('portable runtime lacks its selected FeltOS driver');
    const manifest=JSON.parse(await readFile(join(root,driver.installationPath,'package.json')));
    if(manifest.bin?.feltos!=='feltos.mjs')throw new Error('portable driver lacks the canonical FeltOS entry');
    if(!separate)await bindPortableDriver(root,sources);
    await writeReleaseEnvelope({closure:destination,snapshot:declarations,controller,lock,sources,
      dependencyEvidence,machineCommit:projection.identity.commit,machineRepository:projection.identity.repository,
      ...(separate?{software:{...software,sourceRepository:projection.softwareIdentity.repository,sourceCommit:projection.softwareIdentity.commit}}:{})});
    // Keep each existing receipt in its own vocabulary. No Guix import-graph
    // receipt is asserted for a Code-selected, compiled portable deployment.
    for(const [name,value] of [['workspace-selection.json',selection],['workspace-command.json',command],['source-compilation.json',compilation],['portable-source-receiving.json',payload],...(generation===undefined?[]:[['workspace-generation.json',generation]])])
      await writeFile(join(destination,'.metadata',name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
    packageReceivingChecks(root,sources);
    await confinePortableRuntime(destination);
    return {closure:destination,machineCommit:projection.identity.commit,machineRepository:projection.identity.repository,
      softwareCommit:projection.softwareIdentity.commit,softwareRepository:projection.softwareIdentity.repository,...payload,
      ...(targetIngress===undefined?{}:{targetIngress})};
  }finally{await rm(work,{recursive:true,force:true});}
}
