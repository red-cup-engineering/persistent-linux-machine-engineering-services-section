import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,cp,rm,chmod} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {workspaceSelectionSources,receiveCommittedPortableFiles} from '../scripts/workspace-selection-sources.mjs';
import {bindPortablePackages} from '../scripts/portable-runtime.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function git(root,...args){
  const result=spawnSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-C',root,...args],
    {encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});
  assert.equal(result.status,0,result.stderr);return result.stdout.trim();
}

// Committed fixture sources and explicit structural compiler receipts exercise
// the genuine Code verifier, source projector, portable binder and asset receiver.
// The inert compiler/producer carriers are read for identity, never executed;
// this is source receiving coverage, not a TypeScript/PNPM qualification.
async function fixture(t){
  const outer=await mkdtemp(join(tmpdir(),'generated-portable-assets-'));
  t.after(()=>rm(outer,{recursive:true,force:true}));
  const workspace=join(outer,'source'),artifact=join(outer,'selection'),runtime=join(outer,'runtime');
  const put=async(root,path,bytes)=>{await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),bytes);};
  const manifest={name:'@fixture/application',version:'1.0.0',type:'module',repository:{url:'https://github.com/fixture/software.git'},scripts:{'build:node':'tsc -p tsconfig.build.json'}};
  const producer={name:'@red-cup-engineering/node-runtime-release-promotion-service',version:'0.0.0',type:'module'};
  const producerBody='// inert fixture emission producer\n',compilerBody='// inert fixture compiler\n';
  await put(workspace,'package.json',JSON.stringify(manifest));
  await put(workspace,'tsconfig.build.json','{"compilerOptions":{"outDir":"dist"}}\n');
  await put(workspace,'src/index.ts','export const value: number = 1;\n');
  await put(workspace,'code/package.json',JSON.stringify(producer));
  await put(workspace,'code/src/generate-workspace-typescript.mjs',producerBody);
  await put(workspace,'pnpm-workspace.yaml','packages: [code]\n');
  await put(workspace,'pnpm-lock.yaml','lockfileVersion: 9.0\n');
  git(workspace,'init','-q');git(workspace,'add','.');git(workspace,'commit','-qm','committed fixture inputs');
  const commit=git(workspace,'rev-parse','HEAD'),sourceHashes={},manifestHashes={};
  for(const path of ['package.json','pnpm-workspace.yaml','pnpm-lock.yaml'])sourceHashes[path]=hash(await readFile(join(workspace,path)));
  for(const id of ['.','code'])manifestHashes[id]=hash(await readFile(join(workspace,id,'package.json')));
  const lock=await readFile(join(workspace,'pnpm-lock.yaml'));await put(artifact,'pnpm-lock.yaml',lock);
  const selection={type:'NodeRuntimeWorkspaceSelectionInstallReceipt',version:1,status:'installed',sourceConfigurationUnchanged:true,
    workspace,artifact,commit,sourceHashes,manifestHashes,importerIds:['.','code'],sourceMounts:[],scopedLockSha256:hash(lock)};
  const compilerManifest=JSON.stringify({name:'typescript',version:'0.0.0-fixture',main:'index.js'});
  await put(workspace,'node_modules/typescript/package.json',compilerManifest);
  await put(workspace,'node_modules/typescript/index.js',compilerBody);
  await mkdir(runtime);await cp(join(workspace,'package.json'),join(runtime,'package.json'));
  const body='export const value = 1;\n',path='dist/index.js';await put(runtime,path,body);await chmod(join(runtime,path),0o644);
  const projection=await workspaceSelectionSources({selection,snapshot:workspace});
  const compilation={type:'NodeRuntimeSourceCompilation',version:1,scope:'packed-selected-packages',staticBindingsCompiled:true,
    applicationExecuted:false,sourceCommit:commit,inspectedPackages:[{name:manifest.name,version:manifest.version,directory:runtime}]};
  const sources=await bindPortablePackages(runtime,projection.sources,compilation,commit);
  const generation={type:'NodeRuntimeTypeScriptEmission',version:1,sourceCommit:commit,sourceLockSha256:sourceHashes['pnpm-lock.yaml'],
    scopedLockSha256:selection.scopedLockSha256,sourceConfigurationUnchanged:true,applicationExecuted:false,
    producer:{package:producer.name,path:'src/generate-workspace-typescript.mjs',sha256:hash(producerBody)},
    packages:[{name:manifest.name,version:manifest.version,importer:'.',manifestSha256:manifestHashes['.'],
      configuration:{path:'tsconfig.build.json',sha256:hash(await readFile(join(workspace,'tsconfig.build.json')))},
      compiler:{name:'typescript',version:'0.0.0-fixture',manifestSha256:hash(compilerManifest),entrySha256:hash(compilerBody)},
      files:[{path,bytes:Buffer.byteLength(body),sha256:hash(body),executable:false}]}]};
  return {runtime,projection,sources,generation,selection,body,path,
    receive:()=>receiveCommittedPortableFiles(projection,runtime,sources,{generation,selection})};
}

test('committed source selection receives its attributed portable compiler bytes',async t=>{
  const f=await fixture(t);assert.deepEqual(await f.receive(),{committedFiles:0,derivedFiles:1});
});
test('same-length portable compiler byte drift refuses by its received digest',async t=>{
  const f=await fixture(t);await writeFile(join(f.runtime,f.path),f.body.replace('1','2'));
  await assert.rejects(f.receive(),/portable compiler product differs from its received emission/);
});
test('portable compiler executable-mode drift refuses',async t=>{
  const f=await fixture(t);await chmod(join(f.runtime,f.path),0o755);
  await assert.rejects(f.receive(),/portable compiler product differs from its received emission/);
});
test('unattributed portable outputs and changed compiler identity still refuse',async t=>{
  const f=await fixture(t);
  await assert.rejects(receiveCommittedPortableFiles(f.projection,f.runtime,f.sources),/derived-output attribution/);
  f.generation.packages[0].compiler.entrySha256='0'.repeat(64);
  await assert.rejects(f.receive(),/derived compiler differs from the selected frozen producer/);
});
