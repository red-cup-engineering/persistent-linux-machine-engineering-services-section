import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join,isAbsolute} from 'node:path';
import {sha256} from './package-receiving.mjs';

/** Join actual configured compiler emissions to the same committed providers
 * and frozen lock. A hash of an arbitrary post-build directory is insufficient.
 * The Code producer owns emission; this receiver owns exact packed-byte custody. */
async function receiveTypeScriptAssets({generation,selection,projection,readCommittedSourceFile,committedSourceObject}){
  const assets=new Map();
  if(generation===undefined)return assets;
  if(generation.type!=='NodeRuntimeTypeScriptEmission'||generation.version!==1||generation.sourceCommit!==selection.commit||generation.sourceLockSha256!==selection.sourceHashes['pnpm-lock.yaml']||generation.scopedLockSha256!==selection.scopedLockSha256||generation.sourceConfigurationUnchanged!==true||generation.applicationExecuted!==false||!Array.isArray(generation.packages))throw new Error('derived assets need their exact configured Code emission receipt');
  const producer=projection.carriers.find(row=>row.package==='@red-cup-engineering/node-runtime-release-promotion-service');
  if(!producer||generation.producer?.package!==producer.package||generation.producer.path!=='src/generate-workspace-typescript.mjs')throw new Error('derived asset producer is not the selected Code owner');
  const prefix=producer.packagePath==='.'?'':producer.packagePath+'/';
  assert.equal(sha256(readCommittedSourceFile(producer,prefix+generation.producer.path).bytes),generation.producer.sha256,'derived asset producer differs from committed Code');
  const seen=new Set();
  for(const row of generation.packages){
    const carrier=projection.carriers.find(candidate=>candidate.package===row.name&&candidate.importer===row.importer);
    if(!carrier||seen.has(row.name))throw new Error('derived provider is absent or duplicated');
    seen.add(row.name);
    const ownerPrefix=carrier.packagePath==='.'?'':carrier.packagePath+'/',manifestBytes=readCommittedSourceFile(carrier,ownerPrefix+'package.json').bytes,manifest=JSON.parse(manifestBytes);
    const recipe=/^tsc -p (tsconfig(?:\.build)?\.json)$/u.exec(manifest.scripts?.['build:node']??manifest.scripts?.build??'');
    if(!recipe||row.configuration?.path!==recipe[1]||manifest.version!==row.version||sha256(manifestBytes)!==row.manifestSha256||sha256(readCommittedSourceFile(carrier,ownerPrefix+recipe[1]).bytes)!==row.configuration.sha256)throw new Error('derived product inputs differ from their committed owner recipe');
    const require=createRequire(join(selection.workspace,row.importer,'package.json'));
    const compilerManifestBytes=await readFile(require.resolve('typescript/package.json')),compiler=JSON.parse(compilerManifestBytes);
    if(row.compiler?.name!=='typescript'||row.compiler.version!==compiler.version||sha256(compilerManifestBytes)!==row.compiler.manifestSha256||sha256(await readFile(require.resolve('typescript')))!==row.compiler.entrySha256)throw new Error('derived compiler differs from the selected frozen producer');
    if(!Array.isArray(row.files)||!row.files.length)throw new Error('derived provider has no actual compiler products');
    for(const file of row.files){
      if(typeof file.path!=='string'||!file.path.split('/').every(part=>part&&part!=='.'&&part!=='..')||/[\\\0]/u.test(file.path)||!Number.isSafeInteger(file.bytes)||file.bytes<0||!/^[a-f0-9]{64}$/u.test(file.sha256??'')||typeof file.executable!=='boolean')throw new Error('derived compiler product is malformed');
      const authored=committedSourceObject(carrier,ownerPrefix+file.path);
      if(authored)throw new Error('derived product overwrites committed source: '+JSON.stringify(authored));
      const key=row.name+':'+file.path;
      if(assets.has(key))throw new Error('derived compiler products conflict');
      assets.set(key,file);
    }
  }
  return assets;
}


/** Receive the exact native writer's configured non-TS products through the
 * same selected-source and packed-byte custody as compiler emissions. */
export async function receiveGeneratedWorkspaceAssets(request){
  const {generation,selection,projection,readCommittedSourceFile,committedSourceObject}=request;
  if(generation===undefined||generation.type==='NodeRuntimeTypeScriptEmission')return receiveTypeScriptAssets(request);
  if(generation.type!=='NodeRuntimeWorkspaceEmission'||generation.version!==1||generation.sourceCommit!==selection.commit
    ||generation.sourceLockSha256!==selection.sourceHashes['pnpm-lock.yaml']||generation.scopedLockSha256!==selection.scopedLockSha256
    ||generation.sourceConfigurationUnchanged!==true||generation.applicationExecuted!==false||generation.typescript?.type!=='NodeRuntimeTypeScriptEmission'||!Array.isArray(generation.packages))throw new Error('module products need the exact configured Code emission receipt');
  const producer=projection.carriers.find(row=>row.package==='@red-cup-engineering/node-runtime-release-promotion-service');
  if(!producer||generation.producer?.package!==producer.package||generation.producer.path!=='src/generate-workspace-artifacts.mjs')throw new Error('module product writer is not the selected Code owner');
  const prefix=producer.packagePath==='.'?'':producer.packagePath+'/';
  assert.equal(sha256(readCommittedSourceFile(producer,prefix+generation.producer.path).bytes),generation.producer.sha256,'module product writer differs from committed Code');
  const assets=await receiveTypeScriptAssets({...request,generation:generation.typescript}),seen=new Set();
  const canonical=path=>typeof path==='string'&&path&&!isAbsolute(path)&&!/[\\\0]/u.test(path)&&path.split('/').every(part=>part&&part!=='.'&&part!=='..');
  for(const row of generation.packages){
    const carrier=projection.carriers.find(candidate=>candidate.package===row.name&&candidate.importer===row.importer);
    if(!carrier||seen.has(row.name))throw new Error('module product provider is absent or duplicated');
    seen.add(row.name);
    const ownerPrefix=carrier.packagePath==='.'?'':carrier.packagePath+'/',manifestBytes=readCommittedSourceFile(carrier,ownerPrefix+'package.json').bytes,manifest=JSON.parse(manifestBytes),declaration=manifest.nodeRuntimeGeneration;
    if(!declaration||typeof declaration!=='object'||Array.isArray(declaration)||Object.keys(declaration).sort().join(',')!=='export,module,outputs'
      ||!canonical(declaration.module)||!/\.[cm]?js$/u.test(declaration.module)||typeof declaration.export!=='string'||!/^[A-Za-z_$][\w$]*$/u.test(declaration.export)||!Array.isArray(declaration.outputs)||!declaration.outputs.length||declaration.outputs.some(path=>!canonical(path))
      ||declaration.outputs.includes(declaration.module)||new Set(declaration.outputs).size!==declaration.outputs.length||row.module?.path!==declaration.module||row.module.export!==declaration.export
      ||manifest.version!==row.version||sha256(manifestBytes)!==row.manifestSha256||!Array.isArray(row.files)||!Array.isArray(row.inputs))throw new Error('module products differ from their committed declaration');
    assert.equal(sha256(readCommittedSourceFile(carrier,ownerPrefix+declaration.module).bytes),row.module.sha256,'source-product module differs from committed owner');
    assert.deepEqual(row.files.map(file=>file.path).sort(),[...declaration.outputs].sort(),'module products do not match the exact declared output set');
    if(typeof row.publicationInstant!=='string'||!Number.isFinite(Date.parse(row.publicationInstant))||new Date(row.publicationInstant).toISOString()!==row.publicationInstant)throw new Error('module publication instant is malformed');
    const inputs=new Set();
    for(const input of row.inputs){
      if(!canonical(input.path)||inputs.has(input.path)||typeof input.sourceRepository!=='string'||!/^[a-f0-9]{40}$/u.test(input.sourceCommit??'')
        ||!/^[a-f0-9]{40}$/u.test(input.gitBlob??'')||!/^[a-f0-9]{64}$/u.test(input.sha256??''))throw new Error('module input receipt is malformed or duplicated');
      inputs.add(input.path);
      const source=projection.carriers.find(candidate=>candidate.path===input.sourceRepository&&candidate.commit===input.sourceCommit);
      if(!source)throw new Error('module input source is outside selected authenticated repositories');
      const rootPrefix=source.path==='.'?'':source.path+'/';
      if(!input.path.startsWith(rootPrefix))throw new Error('module input path differs from its source occurrence');
      const file=readCommittedSourceFile(source,input.path.slice(rootPrefix.length));
      assert.equal(file.gitBlob,input.gitBlob,'module input Git object differs');assert.equal(sha256(file.bytes),input.sha256,'module input bytes differ');
    }
    for(const file of row.files){
      if(!canonical(file.path)||!Number.isSafeInteger(file.bytes)||file.bytes<0||!/^[a-f0-9]{64}$/u.test(file.sha256??'')||file.executable!==false)throw new Error('module product event is malformed');
      const authored=committedSourceObject(carrier,ownerPrefix+file.path);
      if(authored)throw new Error('derived product overwrites committed source: '+JSON.stringify(authored));
      const key=row.name+':'+file.path;
      if(assets.has(key))throw new Error('module products conflict with configured compiler products');
      assets.set(key,file);
    }
  }
  return assets;
}
