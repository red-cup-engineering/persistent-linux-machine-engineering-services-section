// After fabrication, qualify the actual sealed driver/library and declarations.
// The receiver subsequently boots this candidate in isolation before promotion.
import {readFileSync,realpathSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {receiveInstalledInstance,installedInstanceProviderPaths,prepareBuildInstanceDiscovery,receiveRetainedInstance} from './receive-instance.mjs';
import {admittedRuntimeFile,resolveAdmittedRuntimeModule} from './package-receiving.mjs';

const [artifactArg,mode,...extra]=process.argv.slice(2);
if(mode==='--retained'){
  if(extra.length!==1||realpathSync(extra[0])!==realpathSync(fileURLToPath(new URL('../machine.json',import.meta.url))))throw new Error('retained receiving requires this authenticated controller policy');
  console.log(JSON.stringify(receiveRetainedInstance(artifactArg,JSON.parse(readFileSync(extra[0],'utf8')))));
}else{
if(extra.length||(mode!==undefined&&mode!=='--build-only'))throw new Error('unknown structural receiving argument');
const artifact=resolve(artifactArg);
if(mode==='--build-only')await prepareBuildInstanceDiscovery(artifact);
// Both prepared packages and a portable pnpm deployment expose the same
// admitted package namespace. Its exported manifest owns the canonical bin;
// the preparation workspace's physical packages/ spelling is not that API.
const manifest=resolveAdmittedRuntimeModule(artifact,'@red-cup-engineering/feltos/package.json');
const worldPath=resolveAdmittedRuntimeModule(artifact,'@red-cup-engineering/metroplat');
installedInstanceProviderPaths(artifact);
const driverDirectory=dirname(manifest);
const driver=JSON.parse(readFileSync(manifest,'utf8'));
if(driver.name!=='@red-cup-engineering/feltos')throw new Error('Sealed driver manifest names another package');
if (driver.bin?.feltos !== 'feltos.mjs') throw new Error('Sealed source does not declare the canonical FeltOS driver');
const driverEntry=admittedRuntimeFile(artifact,join(driverDirectory,driver.bin.feltos));
const parsed=spawnSync(process.execPath,['--check',driverEntry],{stdio:'inherit'});
if (parsed.error||parsed.status!==0) throw parsed.error??new Error('Sealed driver is not valid for its Guix Node interpreter');
const world=await import(pathToFileURL(worldPath).href);
if (world.default?.kind !== 'feltos.world-library' || !world.default.modules) throw new Error('Sealed library does not supply its driver world declaration');
await receiveInstalledInstance(artifact);
console.log(JSON.stringify({kind:'guix.driver-library-receiving',sourceInterfacesReceived:true,instanceDeclarationsReceived:true,operatingReceiving:false}));

}
