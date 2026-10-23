import test from 'node:test';import assert from 'node:assert/strict';
import {registrationInvocation,readRunnerRegistration,tarballPath,configureRunner,preflightRunnerRegistration,registerRunner,apply} from '../src/ci-runner-host.mjs';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
const runner={name:'held-runner',scope:'https://github.com/group/private-source',labels:['bare-cedar-fog'],registration:{executable:'/usr/bin/gh'},version:'2.338.0',tarball:'/owner/data/logs/runner.tgz'};
test('original supplier constructs exact private repository registration without a shell',()=>{
 assert.deepEqual(registrationInvocation(runner,'POST'),{executable:'/usr/bin/gh',args:['api','--hostname','github.com','--method','POST','/repos/group/private-source/actions/runners/registration-token','--jq','.token']});
 assert.equal(registrationInvocation({...runner,scope:'https://github.com/group'},'GET').args[5],'/orgs/group/actions/runners?per_page=100');
});
test('wrong host, credentials, mutable paths or methods refuse before supplier call',()=>{
 for(const scope of ['https://example.test/group/repo','https://user:pass@github.com/group/repo','https://github.com/group/repo?token=x','https://github.com/group/repo/actions'])
  assert.throws(()=>registrationInvocation({...runner,scope}));
 assert.throws(()=>registrationInvocation({...runner,registration:{executable:'gh'}}));
 assert.throws(()=>registrationInvocation(runner,'DELETE'));
});
test('a nonexistent declared archive stays in original owner custody',()=>{
 assert.equal(tarballPath(runner),'/owner/data/logs/runner.tgz');
});
test('a native config failure cannot expose or retain token-bearing command diagnostics',()=>{
 const token='fixture-registration-token';
 assert.throws(()=>configureRunner({...runner,root:'/owner/data/state/runner'},token,{run:(_command,args,options)=>{
  assert.ok(args.includes(token));assert.ok(!args.includes('--replace'));assert.equal(options.stdio,'ignore');throw Error('native failed with '+token);
 }}),error=>!error.message.includes(token)&&!error.cause&&/withheld/.test(error.message));
});
test('foreign local registration refuses before downloading, linking or unit effects',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-registration-'));
 try{
  fs.mkdirSync(path.join(root,'runner'));fs.writeFileSync(path.join(root,'runner/.runner'),JSON.stringify({agentName:runner.name,gitHubUrl:'https://github.com/other/scope'}));
  await assert.rejects(()=>apply({runners:[{...runner,root}]}),/identity differs/);
  assert.deepEqual(fs.readdirSync(root),['runner']);assert.deepEqual(fs.readdirSync(path.join(root,'runner')),['.runner']);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
const native={id:42,name:runner.name,status:'online',busy:false,labels:[{name:'self-hosted'},{name:'Linux'},{name:'X64'},{name:'bare-cedar-fog'}]};
test('unavailable, ambiguous and existing remote names refuse before new download or registration',async()=>{
 for(const response of [null,{total_count:2,runners:[native]}, {total_count:1,runners:[native]}]){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-admission-'));let calls=0;
  try{
   await assert.rejects(()=>apply({runners:[{...runner,root}]},{registrationRun:(_exe,args)=>{
    calls++;assert.ok(args.includes('GET'));assert.ok(!args.includes('POST'));
    if(response===null)throw Object.assign(Error('private diagnostic'),{stdout:'fixture-token'});
    return JSON.stringify(response);
   }}),/explicit same-scope remote absence/);
   assert.equal(calls,1);assert.deepEqual(fs.readdirSync(root),[]);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
 }
});
test('retained local id must match the actual native remote id before any materialization',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-retained-'));
 try{
  fs.mkdirSync(path.join(root,'runner'));const file=path.join(root,'runner/.runner');
  fs.writeFileSync(file,JSON.stringify({agentName:runner.name,gitHubUrl:runner.scope,agentId:41}));
  const read=()=>JSON.stringify({total_count:1,runners:[native]});
  assert.throws(()=>preflightRunnerRegistration({...runner,root},{run:read}),/identity is unreceived/);
  fs.writeFileSync(file,JSON.stringify({agentName:runner.name,gitHubUrl:runner.scope,agentId:42}));
  assert.equal(preflightRunnerRegistration({...runner,root},{run:read}).local.id,42);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('token supplier errors discard native stdout, stderr and command custody',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-token-'));let called=0;
 try{
  assert.throws(()=>registerRunner({...runner,root},[],{run:(_exe,args)=>{
   called++;if(args.includes('GET'))return JSON.stringify({total_count:0,runners:[]});
   throw Object.assign(Error('fixture-secret-token'),{stdout:'fixture-secret-token',stderr:'fixture-secret-token'});
  }}),error=>error.code==='runner-registration-token-unavailable'&&!JSON.stringify(error).includes('fixture-secret-token')&&!error.message.includes('fixture-secret-token')&&!error.cause&&!error.stdout&&!error.stderr);
  assert.equal(called,2);assert.deepEqual(fs.readdirSync(root),[]);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('actual API id, online state and labels receive the resource',()=>{
 const found=readRunnerRegistration(runner,{run:(exe,args,options)=>{
  assert.equal(exe,'/usr/bin/gh');assert.ok(args.includes('/repos/group/private-source/actions/runners?per_page=100'));
  assert.equal(options.timeout,10000);assert.equal(options.maxBuffer,1024*1024);
  return JSON.stringify({total_count:1,runners:[native]});
 }});
 assert.equal(found.state,'current');assert.equal(found.id,42);assert.equal(found.scope,runner.scope);
 assert.deepEqual(found.labels,['self-hosted','Linux','X64','bare-cedar-fog']);
});
test('missing, offline, wrong-label, incomplete and unavailable runner observations remain distinct',()=>{
 const read=data=>readRunnerRegistration(runner,{run:()=>JSON.stringify(data)});
 assert.equal(read({total_count:0,runners:[]}).state,'absent');
 assert.equal(read({total_count:1,runners:[{...native,status:'offline'}]}).state,'drift');
 assert.equal(read({total_count:1,runners:[{...native,labels:[{name:'other'}]}]}).state,'drift');
 assert.equal(read({total_count:2,runners:[native]}).state,'unknown');
 assert.equal(readRunnerRegistration(runner,{run:()=>{throw Error('private details must not surface');}}).state,'unknown');
});
