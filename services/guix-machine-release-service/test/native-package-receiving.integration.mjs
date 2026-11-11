import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,symlinkSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {runNativeDeclaredReceiving,compareNativeDeclaredReceiving,compareDeclaredReceiving,changeVerdict} from '../scripts/test-change.mjs';

// Receive the ORIGINAL Code-owned published API from the selected native PNPM
// workspace dependency. No caller-supplied source path or Guix-local copy.
const pnpm=process.env.NATIVE_PNPM;
if(!pnpm)throw new Error('native integration requires PNPM11.28.5 executable and installed Code dependency');
const providerUrl=import.meta.resolve('@red-cup-engineering/node-runtime-release-promotion-service/read-workspace-source');
if(!providerUrl.startsWith('file:'))throw new Error('native Code source reader is not a file-backed selected package');
const bytes=readFileSync(fileURLToPath(providerUrl));
// Retain the exact owning implementation bound by this integration fixture;
// selected dependency and original Git source graph are separate obligations.
// Current owning sparse-reader refinement f479d7e32debe03ff7d57fee22462c8bca607daa;
// the restored public export selects this original implementation unchanged.
assert.equal(createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex'),'0e09da4df3423d6c5ea8bc0730a7d12e7f842937');
assert.equal(execFileSync(pnpm,['--version'],{encoding:'utf8'}).trim(),'11.28.5');
const {readNodeWorkspace}=await import(providerUrl);
const node=realpathSync(process.execPath);
function fixture(t,{expected=1,value=1,extra='',omitReceiving=false,receiving=['test/receive.test.mjs']}={}){
  const root=mkdtempSync(join(tmpdir(),'native-package-comparison-')),workspace=join(root,'source'),work=join(root,'work');
  mkdirSync(work);mkdirSync(workspace);t.after(()=>rmSync(root,{recursive:true,force:true}));
  const write=(path,content)=>{mkdirSync(dirname(join(workspace,path)),{recursive:true});writeFileSync(join(workspace,path),content);};
  write('.gitignore','node_modules/\n');
  write('package.json',JSON.stringify({name:'@fixture/root',private:true,packageManager:'pnpm@11.28.5'}));
  write('pnpm-workspace.yaml',"packages:\n  - packages/*\n");
  write('packages/provider/package.json',JSON.stringify({name:'@fixture/provider',version:'1.0.0',type:'module',exports:'./index.mjs'}));
  write('packages/provider/index.mjs',`export const value=${value};\n`);
  write('packages/consumer/package.json',JSON.stringify({name:'@fixture/consumer',version:'1.0.0',type:'module',dependencies:{'@fixture/provider':'workspace:*'},...(omitReceiving?{}:{receivingTests:receiving})}));
  write('packages/consumer/test/receive.test.mjs',`import assert from 'node:assert/strict';\nimport {value} from '@fixture/provider';\nassert.equal(value,${expected});\nassert.equal(process.env.GH_TOKEN,undefined);\nassert.equal(process.env.NODE_OPTIONS,'--max-old-space-size=384');\n${extra}\n`);
  write('packages/consumer/test/second.test.mjs',"import assert from 'node:assert/strict'; assert.ok(true);\n");
  const env={...process.env,CI:'true',HOME:work,XDG_DATA_HOME:join(root,'data'),COREPACK_ENABLE_PROJECT_SPEC:'0'};
  execFileSync(pnpm,['install','--offline','--ignore-scripts','--store-dir',join(root,'store')],{cwd:workspace,env,stdio:'pipe',encoding:'utf8'});
  const git=(...args)=>execFileSync('git',['-C',workspace,...args],{encoding:'utf8'}).trim();
  git('init','-q');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','native installed owner fixture');
  const commit=git('rev-parse','HEAD'),tree=git('rev-parse','HEAD^{tree}');
  execFileSync(pnpm,['install','--offline','--ignore-scripts','--frozen-lockfile','--store-dir',join(root,'store')],{cwd:workspace,env,stdio:'pipe',encoding:'utf8'});
  const graph={repositories:[{repository:'fixture/source',commit,tree,paths:['.']}]};
  const read=()=>readNodeWorkspace({workspace,pnpm,filter:'@fixture/consumer...'});
  const run=async(source)=>runNativeDeclaredReceiving({source:source??await read(),graph,work,node,environment:{PATH:process.env.PATH,GH_TOKEN:'must-not-pass',NODE_OPTIONS:'--invalid-loader'}});
  const input=async()=>({source:await read(),graph,work,node,environment:{PATH:process.env.PATH}});
  return {root,workspace,work,write,git,commit,graph,read,run,input};
}

test('genuine PNPM installed supplier and original receiving runner produce positive measured comparison',async t=>{
  const base=fixture(t),head=fixture(t),before=await base.run(),after=await head.run();
  assert.equal(after.length,1);assert.equal(after[0].name,'@fixture/consumer');assert.equal(after[0].results[0].passed,true);
  assert.equal(after[0].commit,head.commit);
  const comparison=compareDeclaredReceiving(before,after);
  assert.deepEqual(comparison.regressions,[]);assert.deepEqual(comparison.preexisting,[]);
  assert.equal(changeVerdict([],{}, {...comparison,unmeasured:true}).verdict,'incomplete');
  const overall=await compareNativeDeclaredReceiving({baseline:await base.input(),candidate:await head.input()});
  assert.equal(overall.verdict,'incomplete');assert.equal(overall.receiving.candidate[0].results[0].passed,true);assert.equal(overall.runtimeAcceptance,false);
});
test('actual candidate failure is a regression only against the measured passing baseline',async t=>{
  const base=fixture(t),head=fixture(t,{value:2});
  const comparison=compareDeclaredReceiving(await base.run(),await head.run());
  assert.deepEqual(comparison.regressions,['@fixture/consumer:test/receive.test.mjs']);
  assert.equal(changeVerdict([],{}, {...comparison,unmeasured:true}).verdict,'regression');
});
test('actual same baseline failure is retained as preexisting',async t=>{
  const base=fixture(t,{value:2}),head=fixture(t,{value:2});
  const comparison=compareDeclaredReceiving(await base.run(),await head.run());
  assert.deepEqual(comparison.regressions,[]);assert.deepEqual(comparison.preexisting,['@fixture/consumer:test/receive.test.mjs']);
});

test('unread baseline preserves genuine candidate evidence without inventing an empty baseline',async t=>{
  const base=fixture(t),head=fixture(t,{value:2}),baseline=await base.input();
  base.write('packages/consumer/test/receive.test.mjs','throw new Error("mutated");');
  const result=await compareNativeDeclaredReceiving({baseline,candidate:await head.input()});
  assert.equal(result.verdict,'incomplete');assert.equal(result.receiving.baseline,undefined);
  assert.equal(result.receiving.candidate[0].results[0].passed,false);
  assert.deepEqual(result.receiving.unread.map(row=>row.side),['baseline']);
  assert.equal(result.receiving.regressions,undefined);assert.equal(result.receiving.preexisting,undefined);
  assert.equal(result.runtimeAcceptance,false);
});

test('unread candidate preserves genuine baseline without claiming retirement',async t=>{
  const base=fixture(t),head=fixture(t),candidate=await head.input();
  head.write('packages/consumer/test/receive.test.mjs','throw new Error("mutated");');
  const result=await compareNativeDeclaredReceiving({baseline:await base.input(),candidate});
  assert.equal(result.verdict,'incomplete');assert.equal(result.receiving.candidate,undefined);
  assert.equal(result.receiving.baseline[0].results[0].passed,true);
  assert.deepEqual(result.receiving.unread.map(row=>row.side),['candidate']);
  assert.equal(result.receiving.removedTests,undefined);
});

test('unavailable process retains partial rows only after final source verification',async t=>{
  const f=fixture(t,{receiving:['test/receive.test.mjs','test/second.test.mjs']}),input=await f.input();
  const executable=join(f.root,'interrupt-second');
  writeFileSync(executable,`#!/bin/sh\ncase "$*" in *second.test.mjs*) kill -TERM $$;; esac\nexec '${node}' "$@"\n`,{mode:0o755});
  await assert.rejects(runNativeDeclaredReceiving({...input,node:executable}),error=>{
    assert.equal(error.code,'ERR_TEST_MEASUREMENT_UNAVAILABLE');assert.equal(error.signal,'SIGTERM');
    assert.equal(error.partialReceiving[0].results.length,1);assert.equal(error.partialReceiving[0].results[0].passed,true);return true;
  });
  const changed=fixture(t,{receiving:['test/receive.test.mjs','test/second.test.mjs'],
    extra:"import {appendFileSync} from 'node:fs'; appendFileSync(import.meta.filename,'// mutation\\n');"});
  await assert.rejects(runNativeDeclaredReceiving({...await changed.input(),node:executable}),error=>{
    assert.match(error.message,/bytes differ/);assert.equal(error.partialReceiving,undefined);return true;
  });
});
test('removed genuine declared obligation remains explicit and incomplete',async t=>{
  const base=fixture(t,{receiving:['test/receive.test.mjs','test/second.test.mjs']}),head=fixture(t);
  const comparison=compareDeclaredReceiving(await base.run(),await head.run());
  assert.equal(comparison.removedTests.length,1);assert.equal(comparison.removedTests[0].path,'test/second.test.mjs');
  assert.equal(changeVerdict([],{},comparison).verdict,'incomplete');
});
test('test mutation after native source reading refuses before execution',async t=>{
  const f=fixture(t),source=await f.read();f.write('packages/consumer/test/receive.test.mjs','throw new Error("tampered");');
  await assert.rejects(f.run(source),/bytes differ/);
});
test('genuine executed test mutation refuses final source verification',async t=>{
  const f=fixture(t,{extra:"import {appendFileSync} from 'node:fs'; appendFileSync(import.meta.filename,'// mutation\\n');"});
  await assert.rejects(f.run(),/bytes differ/);
});
test('source root and selected owner identity must match admitted graph',async t=>{
  const f=fixture(t);f.graph.repositories[0].commit='0'.repeat(40);
  await assert.rejects(f.run(),/exact graph root/);
});
test('duplicate importer, redirected importer, and outside path refuse',async t=>{
  const f=fixture(t),source=await f.read();
  await assert.rejects(f.run({...source,importerIds:[...source.importerIds,source.importerIds[0]]}),/live owning/);
  await assert.rejects(f.run({...source,importerIds:['../outside']}),/leaves/);
  symlinkSync(join(f.workspace,'packages/consumer'),join(f.workspace,'redirected'));
  await assert.rejects(f.run({...source,importerIds:['redirected']}),/redirected/);
});
test('filtered administrative root cannot silently become a receiving package',async t=>{
  const f=fixture(t);f.write('package.json',JSON.stringify({name:'@fixture/root',private:true,packageManager:'pnpm@11.28.5',receivingTests:['root.test.mjs']}));
  f.write('root.test.mjs','throw new Error("must not execute");');
  f.git('add','.');f.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','root receiving');
  f.graph.repositories[0].commit=f.git('rev-parse','HEAD');f.graph.repositories[0].tree=f.git('rev-parse','HEAD^{tree}');
  await assert.rejects(f.run(),/root receiving membership is unmeasured/);
});

test('exact graph tree mismatch and overlapping work refuse',async t=>{
  const f=fixture(t),source=await f.read();
  await assert.rejects(runNativeDeclaredReceiving({source,graph:f.graph,work:f.workspace,node}),/separate canonical/);
  f.graph.repositories[0].tree='0'.repeat(40);
  await assert.rejects(f.run(source),/exact graph root/);
});
test('changed manifest after provider reading refuses without executing declarations',async t=>{
  const f=fixture(t),source=await f.read();
  f.write('packages/consumer/package.json',JSON.stringify({name:'@fixture/consumer',receivingTests:['test/second.test.mjs']}));
  await assert.rejects(f.run(source),/bytes differ/);
});

test('removed package receiving declaration cannot erase baseline owner obligations',async t=>{
 const base=fixture(t),head=fixture(t,{omitReceiving:true});
 const result=await compareNativeDeclaredReceiving({baseline:await base.input(),candidate:await head.input()});
 assert.equal(result.receiving.baseline.length,1);assert.equal(result.receiving.candidate.length,0);
 assert.equal(result.receiving.removedTests.length,1);assert.equal(result.verdict,'incomplete');
});
test('original explicit string-path array contract refuses script/object substitutes',async t=>{
 for(const receiving of ['node arbitrary.mjs',{command:'node arbitrary.mjs'},[{path:'test/receive.test.mjs'}]]){
  const f=fixture(t,{receiving});await assert.rejects(f.run(),/invalid receivingTests/);
 }
});

// A valid committed filename must never become a Node command-line option.
test('committed leading-dash receiving files execute and fail rather than becoming Node options',async t=>{
 for(const path of ['--help','--version']){
  const f=fixture(t,{receiving:[path]});
  f.write(`packages/consumer/${path}`,"throw new Error('leading-dash receiving must execute');\n");
  f.git('add','.');f.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','leading dash receiving');
  f.graph.repositories[0].commit=f.git('rev-parse','HEAD');f.graph.repositories[0].tree=f.git('rev-parse','HEAD^{tree}');
  const rows=await f.run();
  assert.deepEqual(rows[0].results,[{file:path,passed:false}]);
  assert.deepEqual(compareDeclaredReceiving([],rows).regressions,[`@fixture/consumer:${path}`]);
 }
});
