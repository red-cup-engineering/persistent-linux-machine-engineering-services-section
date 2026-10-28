import test from'node:test';
import assert from'node:assert/strict';
import{createHash}from'node:crypto';
import{mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{importUserManagerEnvironment}from'../scripts/import-user-manager-environment.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'manager-environment-source-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const runtime=join(root,'runtime');mkdirSync(runtime,{mode:0o700});
 const input=join(root,'normal.env'),value='fixture-private-value';writeFileSync(input,'SOURCE='+value+'\n',{mode:0o600});
 const request={type:'LinuxUserManagerEnvironmentImport',version:1,id:'same-custody',work:root,managerUnit:'manager.service',runtimeDirectory:runtime,importerUnit:'original-importer.service',environmentFile:{path:input,sha256:hash(readFileSync(input))},bindings:[{from:'SOURCE',to:'TARGET',sha256:hash(value)}]};
 const manager={Id:'manager.service',OwnerUid:process.getuid(),SystemdUser:true,RuntimeDirectory:runtime,ActiveState:'active',MainPID:'900',ProcessStart:'1000',ControlGroup:'/system.slice/manager.service'};
 const imported=new Map(),effects=[];let sourcePid=42;
 const port={uid:()=>process.getuid(),manager:()=>({...manager}),controllerGroup:()=> '0::/system.slice/original-importer.service',environmentDigests:names=>names.map(name=>({name,sha256:imported.has(name)?hash(imported.get(name)):null}))};
 const run=(file,args,options)=>{
  if(file==='/usr/bin/busctl'){
   if(args.includes('GetUnit'))return JSON.stringify({type:'o',data:['/original/importer']});
   return JSON.stringify({data:args.at(-1)==='MainPID'?sourcePid:[[input,false]]});
  }
  assert.equal(file,'/usr/bin/systemctl');assert.deepEqual(args,['--user','import-environment','TARGET']);
  assert.equal(args.includes(value),false);assert.equal(options.env.TARGET,value);effects.push(args);
  imported.set('TARGET',options.env.TARGET);return'';
 };
 return{root,input,value,request,port,run,effects,environment:{SOURCE:value},setWrongSource:()=>{sourcePid=99},invoke(){return importUserManagerEnvironment(request,{port,run,environment:this.environment,pid:42})}};
}
test('normal native EnvironmentFile input restores only declared same-custody variables',t=>{
 const f=fixture(t),r=f.invoke();assert.equal(r.hashReadbackMatches,true);assert.equal(f.effects.length,1);
 assert.equal(readFileSync(r.outcome,'utf8').includes(f.value),false);assert.equal(r.providerUsePerformed,false);assert.equal(r.plaintextBackupCreated,false);
 const again=f.invoke();assert.equal(again.outcome,r.outcome);assert.equal(f.effects.length,2); // same-value native map assignment, not an application effect
});
test('a different importer process cannot claim the normal parser source',t=>{
 const f=fixture(t);f.setWrongSource();assert.throws(()=>f.invoke(),/not this source process/);assert.equal(f.effects.length,0);
});
test('rotated projection or mismatched private value refuses before native import',t=>{
 const f=fixture(t);f.environment.SOURCE='other-private-fixture';assert.throws(()=>f.invoke(),/credential value changed/);assert.equal(f.effects.length,0);
 f.environment.SOURCE=f.value;writeFileSync(f.input,'changed normal source\n');assert.throws(()=>f.invoke(),/environment source changed/);assert.equal(f.effects.length,0);
});
