import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
export const sha = bytes=>createHash('sha256').update(bytes).digest('hex');
export function admissionFixture(){
  const parent=process.env.TMPDIR && fs.statSync(process.env.TMPDIR).uid===process.getuid()
    && !(fs.statSync(process.env.TMPDIR).mode&0o022)?process.env.TMPDIR:os.homedir();
  const root=fs.mkdtempSync(path.join(parent,'ci-admission-fixture-'));
  const provider=path.join(root,'provider');fs.mkdirSync(path.join(provider,'src'),{recursive:true});fs.mkdirSync(path.join(provider,'assets'));
  const original=process.env.WSL_BACKING_CAPACITY_SOURCE ?? fileURLToPath(new URL('../../../wsl-host-service/src/backing-capacity.mjs',import.meta.url));
  const moduleBytes=fs.readFileSync(original),assetBytes=fs.readFileSync(path.join(path.dirname(path.dirname(original)),'assets/observe-backing-capacity.ps1'));
  const module=path.join(provider,'src/backing-capacity.mjs'),asset=path.join(provider,'assets/observe-backing-capacity.ps1');
  fs.writeFileSync(module,moduleBytes,{mode:0o400});fs.writeFileSync(asset,assetBytes,{mode:0o400});
  const host={schema:'wsl-host-parameters@1',windows:{backingStorage:{distributionName:'Example',registryKey:'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{11111111-1111-1111-1111-111111111111}',
    basePath:'D:\\distros\\example',vhdFileName:'ext4.vhdx',volumeId:'\\\\?\\Volume{22222222-2222-2222-2222-222222222222}\\',powershell:'/mnt/d/Windows/powershell.exe',wslpath:'/usr/bin/wslpath',linuxMount:'/',timeoutMs:1000,maxAgeMs:5000,
    policy:{minFreeBytes:'100000000000',minFreePercent:0,growthBytes:'2048',overheadBytes:'64',basis:'Original fixture physical reserve plus declared growth; snapshot not reservation'}}}};
  const hostFile=path.join(root,'host.json');const saveHost=()=>fs.writeFileSync(hostFile,JSON.stringify(host),{mode:0o600});saveHost();
  const p=host.windows.backingStorage;
  const native={requestNonce:'0a'.repeat(32),at:new Date().toISOString(),distribution:{name:'Example',basePath:p.basePath,vhdFileName:'ext4.vhdx'},
    volume:{id:p.volumeId,totalBytes:'1000000000000',availableBytes:'400000000000',volumeFreeBytes:'400000000000',callerAvailableBytes:'400000000000',allocationUnitBytes:'4096'},
    vhd:{path:'D:\\distros\\example\\ext4.vhdx',lengthBytes:'50000',allocatedBytes:'40960',allocationSource:'GetFileInformationByHandleEx/FileCompressionInfo',fileIdentity:'1234abcd:0000000000001234',attributes:32,sparse:false,compressed:false}};
  const calls=[],ports={monotonic:()=>100,nonce:()=>native.requestNonce,osRelease:()=> 'microsoft-standard-WSL2',environment:{WSL_DISTRO_NAME:'Example'},
    deviceOf:p=>({real:p,device:'77'}),run:(program,args)=>{calls.push({program,args});return program===p.wslpath?'\\\\wsl.localhost\\Example\\\n':JSON.stringify(native);}};
  const record={schema:'ci-runner-host-parameters@1',hostAdmission:{hostParametersPath:hostFile,provider:{module,sha256:sha(moduleBytes),asset,assetSha256:sha(assetBytes)},phasePeakBytes:{startup:'8192',job:'16384',materialization:'32768'}},runners:[]};
  return {root,record,host,native,ports,calls,saveHost,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
