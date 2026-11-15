import test from 'node:test';import assert from 'node:assert/strict';
import {registrationInvocation,readRunnerRegistration,tarballPath,configureRunner,preflightRunnerRegistration,registerRunner,apply,observe} from '../src/ci-runner-host.mjs';
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
test('a failing native config never exposes the token-bearing command',()=>{
 const token='fixture-registration-token';let calls=0;
 assert.throws(()=>configureRunner({...runner,root:'/owner/data/state/runner'},token,{run:()=>{calls++;throw Error('native failed with '+token);}}),error=>!error.message.includes(token)&&!error.cause&&/token and native diagnostics withheld/.test(error.message));
 assert.equal(calls,1);
});
test('foreign local registration refuses before downloading, linking or unit effects',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-registration-'));
 try{
  fs.writeFileSync(path.join(root,'.runner'),JSON.stringify({agentName:runner.name,gitHubUrl:'https://github.com/other/scope'}));
  await assert.rejects(()=>apply({runners:[{...runner,root}]}),/identity differs/);
  assert.deepEqual(fs.readdirSync(root),['.runner']);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
const native={id:42,name:runner.name,status:'online',busy:false,labels:[{name:'self-hosted'},{name:'Linux'},{name:'X64'},{name:'bare-cedar-fog'}]};
test('unavailable, ambiguous and existing remote names refuse before new download or registration',async()=>{
 for(const response of [null,{total_count:2,runners:[native]}, {total_count:1,runners:[native]}]){
  const root=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'runner-admission-')),'box');fs.mkdirSync(root);let calls=0;
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
  const file=path.join(root,'.runner');
  fs.writeFileSync(file,JSON.stringify({agentName:runner.name,gitHubUrl:runner.scope,agentId:41}));
  const read=()=>JSON.stringify({total_count:1,runners:[native]});
  assert.throws(()=>preflightRunnerRegistration({...runner,root},{run:read}),/identity is unreceived/);
  fs.writeFileSync(file,JSON.stringify({agentName:runner.name,gitHubUrl:runner.scope,agentId:42}));
  assert.equal(preflightRunnerRegistration({...runner,root},{run:read}).local.id,42);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('a failing token supplier surfaces no token or native diagnostics',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-token-'));let called=0;
 try{
  assert.throws(()=>registerRunner({...runner,root},[],{run:(_exe,args)=>{
   called++;if(args.includes('GET'))return JSON.stringify({total_count:0,runners:[]});
   throw Object.assign(Error('fixture-secret-token'),{stdout:'fixture-secret-token',stderr:'fixture-secret-token'});
  }}),error=>/token supplier failed/.test(error.message)&&!JSON.stringify(error).includes('fixture-secret-token')&&!error.message.includes('fixture-secret-token')&&!error.cause&&!error.stdout&&!error.stderr);
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

test('explicit CR-18 or CR-19 policies cannot fall through to generic apply', async()=>{
 for(const policy of [{controls:{mode:'existing-flat'}},{hostAdmission:{}}]){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-policy-'));
  try{
   const record={...policy,runners:[{...runner,root}]};
   let calls=0;
   await assert.rejects(()=>apply(record,{registrationRun:()=>{calls++;throw new Error('fixture supplier');}}),
     {code:'runner-physical-policy-unavailable'});
   assert.equal(calls,0,'refuse before the registration supplier');
   assert.deepEqual(fs.readdirSync(root),[],'refuse before local mutation');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
 }
});

test('plan reports an unsupported physical policy without entering runner observation',()=>{
 const record={controls:{mode:'existing-flat'},get runners(){assert.fail('unsupported controls must not enter generic runner observation');}};
 assert.deepEqual(observe(record).map(({id,status})=>({id,status})),[
  {id:'CR-19 existing-flat controls',status:'unobserved'},
 ]);
 assert.deepEqual(observe({hostAdmission:{},runners:[]}).map(({id,status})=>({id,status})),[
  {id:'CR-18 native physical admission',status:'unobserved'},
 ]);
});

test('physical plan traces current local destinations without admitting release or job effects',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-target-plan-'));
 try{
  const runners=['one','two'].map(name=>({...runner,name,root:path.join(root,name),slice:'ci.slice',tarball:path.join(root,'archive.tgz')}));
  const record={schema:'ci-runner-host-parameters@1',hostAdmission:{},runners,sliceMemoryMax:'4G',
   parametersPath:path.join(root,'parameters.json'),
   reconcile:{source:'https://github.com/group/source.git',commit:'a'.repeat(40),root:path.join(root,'release')}};
  const [result]=observe(record);
  assert.equal(result.status,'unobserved');
  assert.match(result.detail,/external effects unqualified/);
  const expected=new Set([path.join(root,'archive.tgz'),path.join(root,'versions','2.338.0'),
   path.join(root,'reconcile-pending'),path.join(root,'release'),
   ...['ci.slice','ci-runner-host-reconcile.timer','ci-runner-host-reconcile.path','ci-runner-host-reconcile.service']
     .map(file=>path.join(os.homedir(),'.config/systemd/user',file))]);
  for(const r of runners){
   for(const p of [r.root,path.join(r.root,'disk-usage.json'),path.join(root,'hooks',r.name+'-job-started.sh'),
    path.join(root,'hooks',r.name+'-job-completed.sh'),
    path.join(os.homedir(),'.config/systemd/user','ci-runner-'+r.name+'.service'),
    path.join(os.homedir(),'.config/systemd/user','ci-runner-'+r.name+'.service.d/80-ci-runner-host-controls.conf')])expected.add(p);
  }
  assert.deepEqual(new Set(result.possibleWriteTargets),expected);
  assert.equal(result.possibleWriteTargets.length,expected.size);
  assert.deepEqual(fs.readdirSync(root),[]);
  for(const bad of [
   {...record,runners:[{...runners[0],root:root+'/../escape'}]},
   {...record,runners:[{...runners[0],tarball:'relative.tgz'}]},
   {...record,runners:Array.from({length:10},(_,i)=>({...runners[0],name:'r'+i,root:path.join(root,'r'+i)}))},
  ]){
   const [refused]=observe(bad);
   assert.equal(refused.status,'unobserved');
   assert.equal(refused.possibleWriteTargets,null,'do not hand over an incomplete target list');
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
