import {readFile,writeFile,mkdir,cp,rm,mkdtemp,symlink,realpath} from 'node:fs/promises';
import {readFileSync as requireRead} from 'node:fs';
import {resolve,join,relative,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {writeReleaseEnvelope} from './release-envelope.mjs';
import {carryAgency,declaredAgencyRoot} from './agency-records.mjs';
import {hasTypeScriptBuild} from './typescript-build.mjs';
const [workspaceArg,snapshotArg,outputArg]=process.argv.slice(2);
const workspace=resolve(workspaceArg),snapshot=resolve(snapshotArg),output=resolve(outputArg);
const sources=JSON.parse(await readFile(join(workspace,'sources.json'),'utf8'));
const providers=Object.fromEntries(sources.packages.map(p=>[p.name,join(workspace,'packages',p.name.replaceAll('/','__'))]));
// Checks use the same admitted package namespace as the sealed runtime.
// Embedded modules keep their declared providers even inside another package.
for(const [name,directory] of Object.entries(providers)){
  const link=join(workspace,'node_modules',name);
  await mkdir(dirname(link),{recursive:true});
  await symlink(relative(dirname(link),directory),link);
}
const entry=providers['@red-cup-engineering/feltos'];
if (!entry) throw new Error('The shared software closure must contain its FeltOS driver');
const driver=JSON.parse(await readFile(join(entry,'package.json'),'utf8'));
if (driver.bin?.feltos !== 'feltos.mjs') throw new Error('The admitted FeltOS driver must declare its canonical feltos.mjs entry');
const world=providers['@red-cup-engineering/metroplat'];
if (!world) throw new Error('The shared software closure must contain its MetroPlat library');
const library=JSON.parse(await readFile(join(world,'package.json'),'utf8'));
if (library.exports?.['.'] !== './metroplat.mjs') throw new Error('The admitted MetroPlat library must declare its canonical world-library declaration');
const exec=(program,args,options={})=>{const r=spawnSync(program,args,{stdio:'inherit',...options});if(r.error||r.status!==0)throw r.error??new Error(`${program} build check failed (${r.status})`)};
const environment={...process.env,NODE_OPTIONS:'--max-old-space-size=384',GUIX_MACHINE_SNAPSHOT:snapshot};
// Build the declared TypeScript runtime outputs in dependency order, with the
// exact compiler and Node types recorded in the reviewed dependency lock.
const compiled=new Set(),building=new Set();
function buildTypes(name){
  if(compiled.has(name))return;
  if(building.has(name))throw new Error(`TypeScript build cycle: ${name}`);
  const directory=providers[name];if(!directory)return;
  const manifest=JSON.parse(requireRead(join(directory,'package.json')));
  if(!hasTypeScriptBuild(manifest))return;
  building.add(name);
  for(const dependency of Object.keys(manifest.dependencies??{}))buildTypes(dependency);
  exec(process.execPath,[join(workspace,'node_modules/typescript/bin/tsc'),'-p',join(directory,'tsconfig.build.json')],{env:environment,cwd:directory});
  building.delete(name);compiled.add(name);
}
for(const name of Object.keys(providers))buildTypes(name);
exec(process.execPath,[join(providers['@red-cup-engineering/metroplat'],'scripts/generate-operation-family-descriptors.mjs')],{env:environment,cwd:workspace});
await mkdir(output,{recursive:true});
const closure=await mkdtemp(join(output,'.closure-'));
// The frozen install is the checked dependency graph. Seal that graph once;
// pnpm deploy would resolve a second graph of cyclic file providers.
const requireWorkspace=createRequire(join(workspace,'package.json'));
const {parse}=requireWorkspace('yaml');
const reviewed=parse(await readFile(join(workspace,'pnpm-lock.yaml'),'utf8'));
const installed=parse(await readFile(join(workspace,'node_modules/.pnpm/lock.yaml'),'utf8'));
if(JSON.stringify(installed)!==JSON.stringify(reviewed))
  throw new Error('Installed dependency graph differs from the reviewed lock');
const dependencyEvidence=[
  ...sources.packages.map(p=>({package:p.name,version:p.version,repository:p.repository,commit:p.commit})),
  ...Object.entries(reviewed.packages??{}).map(([key,value])=>({package:key,resolution:value.resolution})),
];
// Relative workspace and third-party links keep their existing topology.
// The CI compute lease keeps this workspace fixed until Guix seals its own
// immutable store copy; hardlinks avoid duplicating its full bytes on the host.
for(const name of ['packages','node_modules'])
  exec('cp',['--archive','--link',join(workspace,name),join(closure,name)]);
await symlink(relative(workspace,entry),join(closure,'app'));
await cp(join(snapshot,'deployment'),join(closure,'deployment'),{recursive:true});
try {const ingress=JSON.parse(await readFile(join(snapshot,'deployment/ingress.json'),'utf8'));await writeFile(join(closure,'deployment/Caddyfile'),ingress.caddyConfiguration)} catch(error){if(error.code!=='ENOENT')throw error}
// A machine that declares no node jobs has no deployments directory; its closure has none either.
try {await cp(join(snapshot,'deployments'),join(closure,'deployments'),{recursive:true})} catch(error){if(error.code!=='ENOENT')throw error}
// A machine that declares agency.root carries its repository's agency records as agency/, which its
// node reads in place (METROPLAT_AGENCY_ROOT={release}/agency; see scripts/agency-records.mjs).
const machine=JSON.parse(await readFile(join(snapshot,'machine.json'),'utf8'));
if(machine.agency!==undefined){
  const top=spawnSync('git',['-C',snapshot,'rev-parse','--show-toplevel'],{encoding:'utf8'});
  if(top.status!==0)throw new Error('machine.json declares agency, but its snapshot is not in a Git checkout');
  const repository=top.stdout.trim(),root=declaredAgencyRoot(machine,repository);
  carryAgency(root,join(closure,'agency'),{root:machine.agency.root,machineCommit:process.env.GITHUB_SHA??null});
}
await writeFile(join(closure,'pnpm-workspace.yaml'),'packages: []\n');
// Installation metadata names producer locations, and is not a runtime input.
await rm(join(closure,'node_modules/.modules.yaml'),{force:true});
await rm(join(closure,'node_modules/.pnpm-workspace-state-v1.json'),{force:true});
const lock=await readFile(join(workspace,'pnpm-lock.yaml'));
await rm(join(closure,'node_modules/.pnpm/lock.yaml'));
await writeReleaseEnvelope({closure,snapshot,
  controller:providers['@red-cup-engineering/guix-machine-release-service'],
  lock,sources,sourceImports:await readFile(join(workspace,'source-imports.json')),
  dependencyEvidence,machineCommit:process.env.GITHUB_SHA??null,machineRepository:process.env.GITHUB_REPOSITORY??null});
process.stdout.write(JSON.stringify({closure})+'\n');
