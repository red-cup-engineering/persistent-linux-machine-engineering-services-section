import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,cp,rm,symlink,lstat} from 'node:fs/promises';
import {join,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {envelopeWorkspaceRuntime} from '../../scripts/envelope-workspace-runtime.mjs';

// Committed synthetic repositories exercise the genuine verifier/projector and
// envelope. Compiler/PNPM receipt fixtures are explicit structural inputs; no
// installation, real compiler, application, Guix or service is executed here.
const hash=b=>createHash('sha256').update(b).digest('hex');
function git(root,...args){const r=spawnSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-C',root,...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
export async function fixture(t,{includeRuntime=true}={}){
 const outer=await mkdtemp(join(tmpdir(),'portable-envelope-composition-'));t.after(()=>rm(outer,{recursive:true,force:true}));
 const workspace=join(outer,'source'),controller=join(outer,'controller'),runtime=join(outer,'runtime'),artifact=join(outer,'selection');
 for(const p of [workspace,controller,runtime,artifact])await mkdir(p);
 const put=async(root,path,bytes)=>{await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),bytes);};
 const controllerManifest={name:'@red-cup-engineering/guix-machine-release-service',version:'0.1.0',type:'module',files:['src','scripts']};
 git(controller,'init','-q');await put(controller,'package.json',JSON.stringify(controllerManifest));await put(controller,'scripts/receive.scm','; inert synthetic receiver\n');await put(controller,'scripts/check-host.mjs','// inert synthetic check\n');git(controller,'add','.');git(controller,'commit','-qm','controller');
 git(workspace,'init','-q');const rootManifest={name:'@561-group/fixture',version:'1.0.0',type:'module',files:['index.mjs']};
 await put(workspace,'package.json',JSON.stringify(rootManifest));await put(workspace,'index.mjs','export const value=1;\n');await put(workspace,'pnpm-workspace.yaml','packages: [driver, controller]\n');await put(workspace,'pnpm-lock.yaml','lockfileVersion: 9.0\n');
 const driverManifest={name:'@red-cup-engineering/feltos',version:'0.19.0',type:'module',bin:{feltos:'feltos.mjs'}};
 await put(workspace,'driver/package.json',JSON.stringify(driverManifest));await put(workspace,'driver/feltos.mjs','// inert synthetic driver\n');
 const snapshot=join(workspace,'machine');
 await put(snapshot,'machine.json',JSON.stringify({name:'fixture',repository:'561-group/fixture',run:{entries:['@red-cup-engineering/feltos'],buildEntries:[controllerManifest.name]}}));
 for(const [p,b] of Object.entries({'machine.scm':'; inert machine\n','channels.scm':'; pinned fixture\n','dependencies.lock.yaml':'historical: snapshot\n','deployment/host.json':'{"instance":"instance.json"}\n','deployment/instance.json':'{"profile":"../profiles/profile.json"}\n','deployments/job.json':'{"inert":true}\n'}))await put(snapshot,p,b);
 git(workspace,'-c','protocol.file.allow=always','submodule','add','-q',controller,'controller');git(workspace,'config','-f','.gitmodules','submodule.controller.url','https://github.com/red-cup-engineering/guix-machine-release-service.git');git(workspace,'add','.');git(workspace,'commit','-qm','machine');
 const commit=git(workspace,'rev-parse','HEAD'),importerIds=['.','controller','driver'],sourceHashes={},manifestHashes={};
 for(const p of ['package.json','pnpm-workspace.yaml','pnpm-lock.yaml'])sourceHashes[p]=hash(await readFile(join(workspace,p)));
 for(const p of importerIds)manifestHashes[p]=hash(await readFile(join(workspace,p,'package.json')));
 const lock=await readFile(join(workspace,'pnpm-lock.yaml'));await put(artifact,'pnpm-lock.yaml',lock);
 const selection={type:'NodeRuntimeWorkspaceSelectionInstallReceipt',version:1,status:'installed',sourceConfigurationUnchanged:true,executable:'pnpm-fixture',workspace,commit,artifact,scopedLockSha256:hash(lock),sourceHashes,manifestHashes,importerIds,sourceMounts:[{path:'controller',revision:git(controller,'rev-parse','HEAD')}]};
 if(!includeRuntime)return {outer,workspace,snapshot,runtime,artifact,selection,put};
 await put(runtime,'package.json',JSON.stringify(rootManifest));await cp(join(workspace,'index.mjs'),join(runtime,'index.mjs'));await put(runtime,'pnpm-lock.yaml','lockfileVersion: 9.0\n# actual portable producer bytes\n');
 const provider=join(runtime,'node_modules/.pnpm/driver/node_modules/@red-cup-engineering/feltos');await cp(join(workspace,'driver'),provider,{recursive:true});const alias=join(runtime,'node_modules/@red-cup-engineering/feltos');await mkdir(dirname(alias),{recursive:true});await symlink(relative(dirname(alias),provider),alias);
 const compilation={type:'NodeRuntimeSourceCompilation',version:1,scope:'packed-selected-packages',sourceCommit:commit,staticBindingsCompiled:true,applicationExecuted:false,inspectedPackages:[{name:rootManifest.name,version:rootManifest.version,directory:runtime},{name:driverManifest.name,version:driverManifest.version,directory:provider}]};
 const command={type:'NodeRuntimeWorkspaceSelectionCommandReceipt',version:1,commit,executable:'pnpm-fixture',sourceConfigurationUnchanged:true,arguments:['--filter',rootManifest.name,'--config.ignore-scripts=true','--config.inject-workspace-packages=true','deploy','--prod',runtime]};
 command.produced={directory:runtime,files:await Promise.all(['package.json','pnpm-lock.yaml','pnpm-workspace.yaml'].map(async path=>({path,sha256:path==='pnpm-workspace.yaml'?null:hash(await readFile(join(runtime,path)))})))};
 return{outer,workspace,snapshot,runtime,artifact,selection,compilation,command,provider,put};
}
