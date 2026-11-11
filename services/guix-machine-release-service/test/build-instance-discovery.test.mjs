import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareBuildInstanceDiscovery} from '../scripts/receive-instance.mjs';

async function fixture(t){
  const base=await mkdtemp(join(tmpdir(),'build-instance-discovery-')),runtime=join(base,'runtime'),outer=join(base,'artifact');
  const previous=process.env.METROPLAT_DEPLOYMENTS_ROOT;
  t.after(async()=>{if(previous===undefined)delete process.env.METROPLAT_DEPLOYMENTS_ROOT;else process.env.METROPLAT_DEPLOYMENTS_ROOT=previous;await rm(base,{recursive:true,force:true});});
  for(const path of ['.metadata','.controller','node_modules','deployment','deployments/fixture/deploy/jobs'])await mkdir(join(runtime,path),{recursive:true});
  await writeFile(join(runtime,'.metadata/sources.json'),'{}');
  const declaration=join(runtime,'deployments/fixture/deploy/release.json');await writeFile(declaration,'{"fixture":true}');
  await mkdir(outer);for(const entry of ['.metadata','.controller','node_modules','deployment','deployments'])await symlink(join(runtime,entry),join(outer,entry));
  return {base,runtime,outer,declaration};
}

test('build discovery binds the actual immutable carrier declaration location',async t=>{
  const f=await fixture(t);await prepareBuildInstanceDiscovery(f.outer);
  assert.equal(process.env.METROPLAT_DEPLOYMENTS_ROOT,join(f.outer,'deployments'));
  assert.deepEqual(JSON.parse(await readFile(join(process.env.METROPLAT_DEPLOYMENTS_ROOT,'fixture/deploy/release.json'),'utf8')),{fixture:true});
});

test('materialized staging remains supported with the same bounded discovery root',async t=>{
  const f=await fixture(t);await prepareBuildInstanceDiscovery(f.runtime);
  assert.equal(process.env.METROPLAT_DEPLOYMENTS_ROOT,join(f.runtime,'deployments'));
});

test('a redirected outer deployment directory cannot select another carrier',async t=>{
  const f=await fixture(t),outside=join(f.base,'host-state');await mkdir(outside);
  await rm(join(f.outer,'deployments'));await symlink(outside,join(f.outer,'deployments'));
  process.env.METROPLAT_DEPLOYMENTS_ROOT='unchanged-before-refusal';
  await assert.rejects(prepareBuildInstanceDiscovery(f.outer),/carrier entry/);
  assert.equal(process.env.METROPLAT_DEPLOYMENTS_ROOT,'unchanged-before-refusal');
});

test('a release declaration link into host state refuses before discovery',async t=>{
  const f=await fixture(t),outside=join(f.base,'host-state.json');await writeFile(outside,'{"unadmitted":true}');
  await rm(f.declaration);await symlink(outside,f.declaration);
  await assert.rejects(prepareBuildInstanceDiscovery(f.outer),/portable link/);
});

test('a relative outside-and-return deployment link cannot pass the tree audit',async t=>{
  const f=await fixture(t);await symlink('runtime/deployment',join(f.base,'return')); 
  await rm(join(f.runtime,'deployments'),{recursive:true});await symlink('../return',join(f.runtime,'deployments'));
  await assert.rejects(prepareBuildInstanceDiscovery(f.outer),/portable link/);
});

test('alternate services discovery cannot reach redirected host declarations',async t=>{
  const f=await fixture(t);await mkdir(join(f.runtime,'services/section/data/records'),{recursive:true});
  const outside=join(f.base,'host-state');await mkdir(outside);await symlink(outside,join(f.runtime,'services/section/data/records/machine-deployment-service-records'));
  await symlink(join(f.runtime,'services'),join(f.outer,'services'));
  await assert.rejects(prepareBuildInstanceDiscovery(f.outer),/portable link/);
});
