import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {join,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {confinePortableRuntime,bindPortablePackages} from '../scripts/portable-runtime.mjs';

async function fixture(t){
 const outer=await mkdtemp(join(tmpdir(),'portable-namespace-'));t.after(()=>rm(outer,{recursive:true,force:true}));
 const runtime=join(outer,'runtime'),provider=join(runtime,'node_modules/.pnpm/example/node_modules/@example/provider');
 await mkdir(provider,{recursive:true});await writeFile(join(provider,'package.json'),'{"name":"@example/provider","version":"1.0.0"}');
 const alias=join(runtime,'node_modules/@example/provider');await mkdir(dirname(alias),{recursive:true});await symlink(relative(dirname(alias),provider),alias);
 const sources={repositories:[{repository:'example/provider',commit:'a'.repeat(40)}],packages:[{name:'@example/provider',version:'1.0.0',repository:'example/provider',commit:'a'.repeat(40),path:'source'}],receivingPackages:['@example/provider']};
 const compilation={type:'NodeRuntimeSourceCompilation',version:1,scope:'packed-selected-packages',staticBindingsCompiled:true,applicationExecuted:false,sourceCommit:'b'.repeat(40),inspectedPackages:[{name:'@example/provider',version:'1.0.0',directory:provider}]};
 return {outer,runtime,provider,alias,sources,compilation};
}
test('relative portable namespace remains relocatable and binds source path separately',async t=>{const f=await fixture(t);assert.equal(await confinePortableRuntime(f.runtime),f.runtime);const s=await bindPortablePackages(f.runtime,f.sources,f.compilation,'b'.repeat(40));assert.equal(s.packages[0].path,'source');assert.equal(s.packages[0].installationPath,'node_modules/.pnpm/example/node_modules/@example/provider');});
test('outside and outside-return symlinks refuse before the compiler',async t=>{const f=await fixture(t);const outside=join(f.outer,'return');await symlink(f.provider,outside);await symlink(relative(f.runtime,outside),join(f.runtime,'escape'));await assert.rejects(confinePortableRuntime(f.runtime),/leaves its admitted closure/);});
test('absolute staging links refuse even when their final target is inside',async t=>{const f=await fixture(t);await symlink(f.provider,join(f.runtime,'absolute'));await assert.rejects(confinePortableRuntime(f.runtime),/remain relative/);});
test('broken and looping links cannot become a sealed dependency',async t=>{const f=await fixture(t);await symlink('missing',join(f.runtime,'broken'));await assert.rejects(confinePortableRuntime(f.runtime));await rm(join(f.runtime,'broken'));await symlink('loop',join(f.runtime,'loop'));await assert.rejects(confinePortableRuntime(f.runtime));});
test('compiler source identity and unique provider joins are required',async t=>{const f=await fixture(t);await assert.rejects(bindPortablePackages(f.runtime,f.sources,f.compilation,'c'.repeat(40)),/exact selected compilation/);f.compilation.inspectedPackages.push(f.compilation.inspectedPackages[0]);await assert.rejects(bindPortablePackages(f.runtime,f.sources,f.compilation,'b'.repeat(40)),/uniquely selected/);});
test('unobserved declared receiving provider remains a refusal',async t=>{const f=await fixture(t);f.compilation.inspectedPackages=[];await assert.rejects(bindPortablePackages(f.runtime,f.sources,f.compilation,'b'.repeat(40)),/receiving provider is absent/);});
