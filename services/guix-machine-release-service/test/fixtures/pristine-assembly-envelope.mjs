// Actual final envelope statements from Guix assemble.mjs blob 2aee3881d2420f1b27ac4a784bd92b384017a05f.
// Retained solely as a byte-compatibility oracle for the extracted owner phase.
import {readFile,writeFile,mkdir,cp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {storageUnits} from '../../scripts/release-storage.mjs';
export async function pristineAssemblyEnvelope({workspace,snapshot,closure,sources,dependencyEvidence,providers,environment}) {
const process={env:environment};
const lock=await readFile(join(workspace,'pnpm-lock.yaml'));
await mkdir(join(closure,'.metadata'),{recursive:true});
await writeFile(join(closure,'.metadata','dependencies.lock.yaml'),lock);
await writeFile(join(closure,'.metadata','runtime-dependencies.json'),JSON.stringify(dependencyEvidence,null,2)+'\n');
await rm(join(closure,'node_modules/.pnpm/lock.yaml'));
await writeFile(join(closure,'.metadata','sources.json'),JSON.stringify(sources,null,2)+'\n');
await cp(join(workspace,'source-imports.json'),join(closure,'.metadata','source-imports.json'));
const release={machineCommit:process.env.GITHUB_SHA??null,machineRepository:process.env.GITHUB_REPOSITORY??null,dependencyLockSha256:createHash('sha256').update(lock).digest('hex')};
await writeFile(join(closure,'.metadata','release.json'),JSON.stringify(release,null,2)+'\n');
// The receiving machine executes this exact, immutable owning controller.
// Public snapshot declarations travel with it; private environment files do not.
const controller=providers['@red-cup-engineering/guix-machine-release-service'];
// Package-local install links have the old packages/<name> depth. The copied
// controller resolves through the same sealed root node_modules as the app;
// copying or preserving those local links would retain the wrong location.
const controllerModules=join(controller,'node_modules');
await cp(controller,join(closure,'.controller'),{recursive:true,filter:path=>path!==controllerModules});
for(const name of ['machine.json','machine.scm','channels.scm','dependencies.lock.yaml']) await cp(join(snapshot,name),join(closure,'.controller',name));
const machineConfiguration=JSON.parse(await readFile(join(snapshot,'machine.json'),'utf8'));
if((machineConfiguration.supervisor??'systemd-user')==='systemd-user' && machineConfiguration.name){
  // Store paths are unknown until sealing. The Guix builder renders the same
  // units with its pinned interpreter and immutable output path.
  await mkdir(join(closure,'.storage-systemd'),{recursive:true});
  for(const [name,body] of Object.entries(storageUnits(machineConfiguration.name,'/RELEASE/bin/node','/RELEASE/.controller/scripts/release-storage.mjs','/RELEASE/.controller/machine.json')))
    await writeFile(join(closure,'.storage-systemd',name),body);
}
}
