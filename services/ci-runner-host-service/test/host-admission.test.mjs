import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {observeHostAdmission,prepareHostAdmission,assertOperationAdmission,closeHostAdmission,materializationDestinations} from '../src/host-admission.mjs';
import {admissionFixture} from './fixtures/host-admission.mjs';
const run=fn=>async()=>{const f=admissionFixture();try{await fn(f);}finally{f.cleanup();}};
test('original WSL native observation and reserve plus phase peak govern exact boundary',run(async f=>{
 const required=100000000000n+2048n+64n+8192n+16384n;
 for(const available of [required-1n,required]){
  for(const key of ['availableBytes','volumeFreeBytes','callerAvailableBytes'])f.native.volume[key]=String(available);
  const r=await observeHostAdmission(f.record,{phase:'startup',destinations:[f.root]},{capacityPorts:f.ports});
  assert.equal(r.admitted,available===required);assert.equal(r.assessments[0].phaseRequiredBytes,String(required));assert.equal(r.admissionKind,'snapshot-not-reservation');
 }
 assert.equal(f.calls.length,4);assert.equal(f.calls[0].program,'/usr/bin/wslpath');assert.equal(f.calls[1].program,f.host.windows.backingStorage.powershell);
 assert.ok(Buffer.from(f.calls[1].args[4],'base64').toString('utf16le').endsWith(fs.readFileSync(f.record.hostAdmission.provider.asset,'utf8')));
}));
test('alternate registered volume and percentage floor remain original producer facts',run(async f=>{
 f.host.windows.backingStorage.volumeId='\\\\?\\Volume{33333333-3333-3333-3333-333333333333}\\';f.host.windows.backingStorage.policy.minFreePercent=20;f.saveHost();f.native.volume.id=f.host.windows.backingStorage.volumeId;
 const r=await observeHostAdmission(f.record,{phase:'job',destinations:[f.root]},{capacityPorts:f.ports});
 assert.equal(r.admitted,true);assert.equal(r.assessments[0].phaseRequiredBytes,'200000018496');
}));
test('unknown zero malformed peaks and lowered100GBfloor refuse before native calls',run(async f=>{
 for(const peak of [undefined,null,'0','-1','1.5',1]){
  f.record.hostAdmission.phasePeakBytes.startup=peak;await assert.rejects(observeHostAdmission(f.record,{phase:'startup',destinations:[f.root]},{capacityPorts:f.ports}),/peak/);
 }
 f.record.hostAdmission.phasePeakBytes.startup='8192';f.host.windows.backingStorage.policy.minFreeBytes='99999999999';f.saveHost();
 await assert.rejects(observeHostAdmission(f.record,{phase:'startup',destinations:[f.root]},{capacityPorts:f.ports}),/100GB/);assert.equal(f.calls.length,0);
}));
test('actual low native free refuses while guest logical size cannot provide headroom',run(async f=>{
 for(const key of ['availableBytes','volumeFreeBytes','callerAvailableBytes'])f.native.volume[key]='21600000000';f.native.vhd.lengthBytes='900000000000';
 const r=await observeHostAdmission(f.record,{phase:'job',destinations:[f.root]},{capacityPorts:f.ports});assert.equal(r.admitted,false);assert.equal(r.assessments[0].availableBytes,'21600000000');
}));
test('wrong native volume or destination device refuses through real original WSL source',run(async f=>{
 f.native.volume.id='\\\\?\\Volume{33333333-3333-3333-3333-333333333333}\\';await assert.rejects(observeHostAdmission(f.record,{phase:'job',destinations:[f.root]},{capacityPorts:f.ports}),/volume changed/);
 f.ports.deviceOf=p=>({real:p,device:p==='/'?'77':'88'});const before=f.calls.length;
 await assert.rejects(observeHostAdmission(f.record,{phase:'job',destinations:[f.root]},{capacityPorts:f.ports}),/unknown backing volume/);assert.equal(f.calls.length,before);
}));
test('provider digest asset topology relative and redirected paths refuse before native import',run(async f=>{
 const provider=f.record.hostAdmission.provider;
 provider.sha256='0'.repeat(64);await assert.rejects(observeHostAdmission(f.record,{phase:'job',destinations:[f.root]},{capacityPorts:f.ports}),/digest/);
 const g=admissionFixture();try{
  g.record.hostAdmission.provider.asset=g.record.hostAdmission.provider.module;
  await assert.rejects(observeHostAdmission(g.record,{phase:'job',destinations:[g.root]},{capacityPorts:g.ports}),/sibling asset/);
  g.record.hostAdmission.hostParametersPath='relative';await assert.rejects(observeHostAdmission(g.record,{phase:'job',destinations:[g.root]},{capacityPorts:g.ports}),/canonical/);
  const link=path.join(g.root,'redirect');fs.symlinkSync(f.record.hostAdmission.hostParametersPath,link);g.record.hostAdmission.hostParametersPath=link;
  await assert.rejects(observeHostAdmission(g.record,{phase:'job',destinations:[g.root]},{capacityPorts:g.ports}),/redirected/);assert.equal(g.calls.length,0);
 }finally{g.cleanup();}assert.equal(f.calls.length,0);
}));
test('source asset and canonical host record changes during observation refuse postreceipt',run(async f=>{
 const original=f.ports.run;f.ports.run=(program,args)=>{const r=original(program,args);if(program===f.host.windows.backingStorage.powershell)fs.appendFileSync(f.record.hostAdmission.hostParametersPath,' ');return r;};
 await assert.rejects(observeHostAdmission(f.record,{phase:'startup',destinations:[f.root]},{capacityPorts:f.ports}),/digest drift/);
 const g=admissionFixture();try{const run=g.ports.run;g.ports.run=(program,args)=>{const r=run(program,args);if(program===g.host.windows.backingStorage.powershell){fs.chmodSync(g.record.hostAdmission.provider.asset,0o600);fs.appendFileSync(g.record.hostAdmission.provider.asset,'\n');}return r;};
  await assert.rejects(observeHostAdmission(g.record,{phase:'startup',destinations:[g.root]},{capacityPorts:g.ports}),/digest drift/);
 }finally{g.cleanup();}
}));
test('ample injected physical observations cannot mint any production mutation context',run(async f=>{
 const runner={name:'fixture',root:path.join(f.root,'runner')};
 assert.throws(()=>assertOperationAdmission({},runner),/issued/);
 const result=await observeHostAdmission(f.record,{phase:'materialization',destinations:[runner.root]},{capacityPorts:f.ports});assert.equal(result.admitted,true,'functional assay alone reports ample capacity');
 const before=f.calls.length;await assert.rejects(prepareHostAdmission(f.record,[runner],[runner.root],{capacityPorts:f.ports}),/accepts no observation overrides/);assert.equal(f.calls.length,before,'issuer refuses injected port before any observation');
 closeHostAdmission({});assert.throws(()=>assertOperationAdmission({},runner),/issued/);
}));
test('startup requires known selected job preparation envelope before any native observation',run(async f=>{
 f.record.hostAdmission.phasePeakBytes.startup='1';f.record.hostAdmission.phasePeakBytes.job=null;
 await assert.rejects(observeHostAdmission(f.record,{phase:'startup',destinations:[f.root]},{capacityPorts:f.ports}),/job\/preparation envelope/);assert.equal(f.calls.length,0);
}));
test('issuer derives original mutation paths from exact canonical record members',run(async f=>{
 const runner={name:'original',root:path.join(f.root,'installation'),version:'2.338.2',tarball:path.join(f.root,'archive.tgz')};f.record.runners=[runner];
 assert.deepEqual(materializationDestinations(f.record,[runner]),[runner.root,path.join(runner.root,'runner'),path.join(runner.root,'versions/2.338.2'),runner.tarball]);
 assert.throws(()=>materializationDestinations(f.record,[{...runner,root:'/another/root'}]),/not in canonical operation/);
 f.record.hostAdmission.ciParametersPath=path.join(f.root,'ci.json');fs.writeFileSync(f.record.hostAdmission.ciParametersPath,JSON.stringify({...f.record,runners:[]}));
 await assert.rejects(prepareHostAdmission(f.record,[runner]),/canonical CI record differs/);assert.equal(f.calls.length,0);
 f.record.controls={mode:'existing-flat'};await assert.rejects(prepareHostAdmission(f.record,[runner]),/controls-only declaration/);
}));
