import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {enterChangeRuntime} from '../scripts/test-change.mjs';
const toolchain='/gnu/store/'+'a'.repeat(32)+'-machine-dependency-toolchain';
function fixture(t){const work=mkdtempSync(join(tmpdir(),'change-runtime-'));t.after(()=>rmSync(work,{recursive:true,force:true}));return {service:'/controller',snapshot:'/snapshot',work,arguments_:['/snapshot',work,'owner/repo=/source'],resolveExecutable:value=>value};}
test('ambient Node delegates receiving and preserves the selected runtime refusal',t=>{
  const options=fixture(t),calls=[];
  const status=enterChangeRuntime({...options,currentExecutable:'/usr/bin/node',execute:(program,args,config)=>{
    calls.push({program,args,config});return program==='guix'?{status:0,stdout:toolchain+'\n'}:{status:1};
  }});
  assert.equal(status,1);assert.equal(calls.length,2);
  assert.equal(calls[0].program,'guix');assert.ok(calls[0].args.includes('--require-installed'));
  assert.equal(calls[1].program,toolchain+'/bin/node');
  assert.deepEqual(calls[1].args,['/controller/scripts/test-change.mjs',...options.arguments_]);
  assert.equal(calls[1].config.stdio,'inherit');assert.ok(calls[1].config.env.PATH.startsWith(toolchain+'/bin:'));
  assert.deepEqual(readdirSync(options.work),[]);
});
test('the exact selected runtime continues without re-execution',t=>{
  const options=fixture(t);let calls=0;
  assert.equal(enterChangeRuntime({...options,currentExecutable:toolchain+'/bin/node',execute:()=>{calls++;return {status:0,stdout:toolchain};}}),undefined);
  assert.equal(calls,1);assert.deepEqual(readdirSync(options.work),[]);
});
test('unavailable installed channels refuse before launching source receiving',t=>{
  const options=fixture(t);let calls=0;
  assert.throws(()=>enterChangeRuntime({...options,execute:()=>{calls++;return {status:1,stderr:'installed channel mismatch'};}}),/installed channel mismatch/);
  assert.equal(calls,1);assert.deepEqual(readdirSync(options.work),[]);
});
test('selected child launch failure and interruption never look like a completed assay',t=>{
  for(const result of [{error:new Error('launch refused')},{signal:'SIGTERM',status:null},{status:null}]){
    const options=fixture(t);
    assert.throws(()=>enterChangeRuntime({...options,currentExecutable:'/usr/bin/node',execute:program=>program==='guix'?{status:0,stdout:toolchain}:result}));
  }
});
