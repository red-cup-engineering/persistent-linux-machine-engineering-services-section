import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {custodyDigest,prepareCustody,prepareRollback,activateCustody,restoreCustody} from '../scripts/custody-transition.mjs';

test('owning supervisor control stops then independently checks writers; active or omitted writers refuse',()=>{
  const result=spawnSync('guile',['--no-auto-compile',new URL('./custody-quiescence.scm',import.meta.url).pathname],{encoding:'utf8',timeout:5000,maxBuffer:32*1024,env:{...process.env,GUILE_AUTO_COMPILE:'0'}});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/controls passed/);
});

function fixture(t){
  const root=fs.mkdtempSync(path.join(tmpdir(),'release-custody-'));fs.chmodSync(root,0o700);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const state=path.join(root,'state'),live=path.join(state,'activitypub-native'),store=path.join(root,'candidate');
  fs.mkdirSync(path.join(live,'journal','data','journals','2026','10','11'),{recursive:true,mode:0o700});
  fs.mkdirSync(path.join(store,'steps'),{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(live,'journal','data','journals','2026','10','11','feed.jsonl.witnesses'),'original exact bytes\n',{mode:0o600});
  fs.writeFileSync(path.join(live,'journal','data','journals','2026','10','11','feed.jsonl.admitted'),'original ledger\n',{mode:0o600});
  fs.writeFileSync(path.join(store,'steps','file.mjs'),`import fs from 'node:fs';import path from 'node:path';
const root=process.argv[3],old=path.join(root,'data/journals'),logs=path.join(root,'data/logs/feed-logs');
if(fs.statSync(old).isFile()){console.log(JSON.stringify({conflicts:[]}));process.exit(0);}
fs.mkdirSync(logs,{recursive:true,mode:0o700});
for(const name of fs.readdirSync(path.join(old,'2026/10/11')))fs.renameSync(path.join(old,'2026/10/11',name),path.join(logs,name));
fs.rmSync(old,{recursive:true});fs.writeFileSync(old,'retired dated layout\\n',{mode:0o600});
console.log(JSON.stringify({conflicts:[]}));`);
  const config={unit:'fixture.service',stateRoot:state,stateCompatibility:'preserve-existing',custodyTransition:{directory:'activitypub-native',writerUnits:['fixture.service'],settlements:['journal'],converter:'steps/file.mjs',timeoutSeconds:3}};
  return {root,live,store,config,receipt:path.join(root,'transition.json')};
}
test('isolated conversion leaves original bytes intact, binds real destination, and rollback restores readable original',t=>{
  const f=fixture(t),original=custodyDigest(f.live);
  assert.equal(prepareCustody(f.config,f.store,f.receipt).phase,'prepared');
  assert.deepEqual(custodyDigest(f.live),original);
  assert.ok(fs.statSync(path.join(f.live,'journal/data/journals')).isDirectory());
  assert.equal(activateCustody(f.receipt).phase,'bound');
  assert.ok(fs.statSync(path.join(f.live,'journal/data/journals')).isFile());
  assert.equal(fs.readFileSync(path.join(f.live,'journal/data/logs/feed-logs/feed.jsonl.witnesses'),'utf8'),'original exact bytes\n');
  // A successor can receive work before its health fails. Preserve that work.
  fs.writeFileSync(path.join(f.live,'successor-work.json'),'retained new work\n',{mode:0o600});
  const restored=restoreCustody(f.receipt);assert.equal(restored.phase,'restored');assert.equal(restored.failedSuccessorCustodyRetained,true);
  assert.deepEqual(custodyDigest(f.live),original);
  const receipt=JSON.parse(fs.readFileSync(f.receipt));
  assert.equal(fs.readFileSync(path.join(receipt.failed,'successor-work.json'),'utf8'),'retained new work\n');
  assert.ok(fs.statSync(path.join(f.live,'journal/data/journals')).isDirectory());
});
test('converter refusal cannot bind altered state and recovery independently reads the untouched original',t=>{
  const f=fixture(t),original=custodyDigest(f.live);
  fs.writeFileSync(path.join(f.store,'steps/file.mjs'),"process.exit(1);\n");
  assert.throws(()=>prepareCustody(f.config,f.store,f.receipt),/converter failed/);
  assert.deepEqual(custodyDigest(f.live),original);assert.equal(restoreCustody(f.receipt).phase,'cancelled');
  assert.deepEqual(custodyDigest(f.live),original);
  assert.equal(fs.existsSync(JSON.parse(fs.readFileSync(f.receipt)).transaction),false);
});
test('repeat deployment on already filed state leaves the original binding and creates no retained duplicate',t=>{
  const f=fixture(t);prepareCustody(f.config,f.store,f.receipt);activateCustody(f.receipt);
  const oneConversion=fs.readdirSync(path.dirname(f.live)).filter(name=>name.startsWith('.custody-transition-'));
  assert.equal(oneConversion.length,1);
  for(const attempt of [2,3]){
    const receipt=path.join(f.root,'repeat-'+attempt+'.json'),before=custodyDigest(f.live);
    assert.equal(prepareCustody(f.config,f.store,receipt).phase,'unchanged');
    assert.equal(activateCustody(receipt).phase,'unchanged');
    assert.equal(restoreCustody(receipt).phase,'unchanged');
    assert.deepEqual(custodyDigest(f.live),before);
    assert.deepEqual(fs.readdirSync(path.dirname(f.live)).filter(name=>name.startsWith('.custody-transition-')),oneConversion);
    assert.equal(fs.existsSync(JSON.parse(fs.readFileSync(receipt)).transaction),false);
  }
});
test('changed source, linked state and omitted writer refuse custody movement',t=>{
  const f=fixture(t);prepareCustody(f.config,f.store,f.receipt);
  fs.writeFileSync(path.join(f.live,'concurrent.json'),'changed');
  assert.throws(()=>activateCustody(f.receipt),/changed before binding/);
  assert.equal(fs.readFileSync(path.join(f.live,'concurrent.json'),'utf8'),'changed');
  const g=fixture(t);g.config.custodyTransition.writerUnits=[];
  assert.throws(()=>prepareCustody(g.config,g.store,g.receipt),/omits/);
  const h=fixture(t);fs.symlinkSync('/etc/hosts',path.join(h.live,'unreceived'));
  assert.throws(()=>prepareCustody(h.config,h.store,h.receipt),/linked/);
});
test('actual release receiver restores code, unit and readable custody after candidate health failure',t=>{
  const f=fixture(t),held=path.join(f.root,'held'),releases=path.join(f.root,'releases'),home=path.join(f.root,'home');
  for(const p of [held,releases,path.join(f.root,'receipts'),path.join(home,'.config/systemd/user'),path.join(f.store,'.metadata'),path.join(f.store,'bin'),path.join(f.store,'.controller/scripts'),path.join(f.store,'.guix-systemd')])fs.mkdirSync(p,{recursive:true,mode:0o700});
  fs.symlinkSync(held,path.join(releases,'current'));fs.symlinkSync(process.execPath,path.join(f.store,'bin/node'));
  fs.copyFileSync(new URL('../scripts/custody-transition.mjs',import.meta.url),path.join(f.store,'.controller/scripts/custody-transition.mjs'));
  fs.writeFileSync(path.join(f.root,'rails.env'),'');fs.writeFileSync(path.join(home,'.config/systemd/user/fixture.service'),'held unit\n');
  fs.writeFileSync(path.join(f.store,'.guix-systemd/fixture.service'),'candidate unit\n');
  fs.writeFileSync(path.join(f.store,'.guix-systemd/environment'),'');
  fs.writeFileSync(path.join(f.store,'.metadata/release.json'),JSON.stringify({machineRepository:'fixture/repository',machineCommit:'1'.repeat(40)}));
  fs.writeFileSync(path.join(f.store,'steps/receive.mjs'),"console.log(JSON.stringify({kind:'fixture-receiving'}));\n");
  Object.assign(f.config,{name:'fixture',repository:'fixture/repository',environmentFile:path.join(f.root,'rails.env'),releaseRoot:releases,receiptRoot:path.join(f.root,'receipts'),health:'http://fixture/healthz',guixProfile:path.join(f.root,'profile'),preActivation:[]});
  f.config.custodyTransition.receive={program:'steps/receive.mjs',arguments:[],timeoutSeconds:3,expect:'fixture-receiving'};
  fs.writeFileSync(path.join(f.root,'machine.json'),JSON.stringify(f.config));
  const result=spawnSync('guile',['--no-auto-compile',new URL('./custody-health-rollback.scm',import.meta.url).pathname],{encoding:'utf8',timeout:10000,maxBuffer:64*1024,env:{...process.env,HOME:home,CUSTODY_FIXTURE_ROOT:f.root,GUILE_AUTO_COMPILE:'0'}});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Actual receiver live-check failure restored/);
  const stateTransactions=fs.readdirSync(path.dirname(f.live)).filter(name=>name.startsWith('.custody-transition-'));assert.equal(stateTransactions.length,1);
  assert.equal(fs.readFileSync(path.join(path.dirname(f.live),stateTransactions[0],'failed/new-work.json'),'utf8'),'successor-only work\n');
});

for(const mode of ['successful-rollback','failed-rollback'])test('actual receiver forward success then '+mode+' receives correlated code and state',t=>{
  const f=fixture(t),held=path.join(f.root,'held'),releases=path.join(f.root,'releases'),home=path.join(f.root,'home');
  for(const p of [held,releases,path.join(f.root,'receipts'),path.join(f.root,'gc'),path.join(home,'.config/systemd/user')])fs.mkdirSync(p,{recursive:true,mode:0o700});
  fs.symlinkSync(held,path.join(releases,'current'));
  for(const [artifact,commit,unit] of [[held,'0','held unit\n'],[f.store,'1','candidate unit\n']]){
    for(const p of [path.join(artifact,'.metadata'),path.join(artifact,'bin'),path.join(artifact,'.guix-systemd')])fs.mkdirSync(p,{recursive:true,mode:0o700});
    fs.symlinkSync(process.execPath,path.join(artifact,'bin/node'));
    fs.writeFileSync(path.join(artifact,'.metadata/release.json'),JSON.stringify({machineRepository:'fixture/repository',machineCommit:commit.repeat(40)}));
    fs.writeFileSync(path.join(artifact,'.guix-systemd/fixture.service'),unit);
    fs.writeFileSync(path.join(artifact,'.guix-systemd/environment'),'');
  }
  // The genuine old generation deliberately has no new converter or helper.
  fs.mkdirSync(path.join(f.store,'.controller/scripts'),{recursive:true,mode:0o700});
  fs.copyFileSync(new URL('../scripts/custody-transition.mjs',import.meta.url),path.join(f.store,'.controller/scripts/custody-transition.mjs'));
  fs.writeFileSync(path.join(f.root,'rails.env'),'');fs.writeFileSync(path.join(home,'.config/systemd/user/fixture.service'),'held unit\n');
  fs.writeFileSync(path.join(f.store,'steps/receive.mjs'),"console.log(JSON.stringify({kind:'fixture-receiving'}));\n");
  Object.assign(f.config,{name:'fixture',repository:'fixture/repository',environmentFile:path.join(f.root,'rails.env'),releaseRoot:releases,receiptRoot:path.join(f.root,'receipts'),health:'http://fixture/healthz',guixProfile:path.join(f.root,'profile'),gcRoot:path.join(f.root,'gc/candidate'),preActivation:[]});
  f.config.custodyTransition.receive={program:'steps/receive.mjs',arguments:[],timeoutSeconds:3,expect:'fixture-receiving'};
  fs.writeFileSync(path.join(f.root,'machine.json'),JSON.stringify(f.config));
  const result=spawnSync('guile',['--no-auto-compile',new URL('./custody-health-rollback.scm',import.meta.url).pathname],{encoding:'utf8',timeout:10000,maxBuffer:64*1024,env:{...process.env,HOME:home,CUSTODY_FIXTURE_ROOT:f.root,CUSTODY_FIXTURE_MODE:mode,GUILE_AUTO_COMPILE:'0'}});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);assert.match(result.stdout,/Actual forward-success then rollback received/);
  const transaction=fs.readdirSync(path.dirname(f.live)).find(name=>name.startsWith('.custody-transition-'));
  assert.ok(transaction);
  const parked=path.join(path.dirname(f.live),transaction,mode==='successful-rollback'?'candidate':'failed');
  assert.equal(fs.readFileSync(path.join(parked,mode==='successful-rollback'?'forward-work.json':'rollback-work.json'),'utf8'),mode==='successful-rollback'?'current-generation work\n':'old-code new work\n');
  const receipts=fs.readdirSync(f.config.receiptRoot).filter(name=>/^\d+(?:-\d+)*-success\.json$/.test(name));
  assert.equal(receipts.length,mode==='successful-rollback'?2:1,'same-second transitions must retain distinct generation receipts');
});

test('manual rollback refuses uncorrelated generation or changed retained custody before state movement',t=>{
  const f=fixture(t),held=path.join(f.root,'held');fs.mkdirSync(held,{mode:0o700});
  f.config.releaseRoot=path.join(f.root,'releases');f.config.receiptRoot=path.join(f.root,'receipts');
  fs.mkdirSync(f.config.releaseRoot,{mode:0o700});fs.mkdirSync(f.config.receiptRoot,{mode:0o700});
  prepareCustody(f.config,f.store,f.receipt,{heldArtifact:held});activateCustody(f.receipt);
  const custody=JSON.parse(fs.readFileSync(f.receipt)),success=path.join(f.config.receiptRoot,'123-success.json');
  const write=record=>fs.writeFileSync(success,JSON.stringify(record),{mode:0o600});
  const evidence={outcome:'success',storePath:f.store,previousArtifact:held,custody};
  write({...evidence,custody:{...custody,heldArtifact:path.join(f.root,'different-generation')}});
  const before=custodyDigest(f.live);
  assert.throws(()=>prepareRollback(f.config,held,f.store,path.join(f.root,'rollback.json')),/Expected values/);
  assert.deepEqual(custodyDigest(f.live),before);
  write(evidence);fs.writeFileSync(path.join(custody.retained,'unexpected.json'),'changed');
  assert.throws(()=>prepareRollback(f.config,held,f.store,path.join(f.root,'rollback.json')),/retained generation custody changed/);
  assert.deepEqual(custodyDigest(f.live),before);
});
