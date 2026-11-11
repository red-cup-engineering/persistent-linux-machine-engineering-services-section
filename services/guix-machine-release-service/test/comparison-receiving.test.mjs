import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {command,prepare} from '../scripts/prepare-sources.mjs';
import {runDeclaredReceiving,compareDeclaredReceiving,receivingObligations,changeVerdict} from '../scripts/test-change.mjs';

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'comparison-receiving-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=join(root,'source');mkdirSync(source);command('git',['init','-q'],source);
  const put=(path,body)=>{mkdirSync(dirname(join(source,path)),{recursive:true});writeFileSync(join(source,path),body);};
  const commit=tests=>{put('package.json',JSON.stringify({name:'@example/consumer',version:'1.0.0',type:'module',receivingTests:tests}));
    command('git',['add','.'],source);command('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','fixture'],source);
    return command('git',['rev-parse','HEAD'],source);};
  const materialize=(commit,name)=>{const output=join(root,name);prepare({repositories:[{repository:'example/consumer',directory:source,commit}],entries:['@example/consumer'],receivingPackages:['@example/consumer'],output});return output;};
  put('receiving/one.mjs','import test from "node:test";test("exact declared receiving",()=>{});\n');
  put('receiving/two.mjs','import test from "node:test";test("second declared receiving",()=>{});\n');
  // This generic test must never replace the explicit receiving declaration.
  put('test/unselected.test.mjs','throw new Error("generic discovery is not receiving enrollment");\n');
  return {root,source,put,commit,materialize};
}

test('actual receiving executes exact manifest paths outside test/ with authenticated source identities',t=>{
  const f=fixture(t),commit=f.commit(['receiving/one.mjs']),output=f.materialize(commit,'head');
  const result=runDeclaredReceiving(output,{PATH:process.env.PATH});assert.equal(result.length,1);
  assert.equal(result[0].commit,commit);assert.deepEqual(result[0].results,[{file:'receiving/one.mjs',passed:true}]);
  assert.match(result[0].tests[0].gitBlob,/^[a-f0-9]{40}$/);assert.match(result[0].manifestSha256,/^[a-f0-9]{64}$/);
  const sources=JSON.parse(readFileSync(join(output,'sources.json'),'utf8'));
  assert.deepEqual(result[0].tests,sources.packages[0].receiving.tests);
});

test('removing one declared path preserves the measured baseline identity and makes receiving incomplete',t=>{
  const f=fixture(t),base=f.commit(['receiving/one.mjs','receiving/two.mjs']);
  const baseline=runDeclaredReceiving(f.materialize(base,'base'),{PATH:process.env.PATH});
  const head=f.commit(['receiving/one.mjs']);
  const candidate=runDeclaredReceiving(f.materialize(head,'head'),{PATH:process.env.PATH});
  const receiving=compareDeclaredReceiving(baseline,candidate);assert.deepEqual(receiving.regressions,[]);
  assert.deepEqual(receiving.removedTests,[{name:'@example/consumer',repository:'example/consumer',commit:base,packagePath:'.',
    manifestSha256:baseline[0].manifestSha256,...baseline[0].tests[1]}]);
  assert.equal(changeVerdict([],{added:[]},receiving).verdict,'incomplete');
});

test('empty package changes cannot erase removed enrollment, entry, executable or unmeasured topology',()=>{
  const side={machine:{definition:'machines/crg',machineBlob:'a',channelsBlob:'b',lockBlob:'c'},repositories:[{repository:'example/owner'}],
    receivingPackages:['@example/consumer'],entries:['@example/consumer','@example/retired'],buildEntries:['@example/build'],graph:{edges:[]}};
  const cases=[{...side,receivingPackages:[]},{...side,entries:['@example/consumer']},{...side,buildEntries:[]}];
  for(const head of cases)assert.equal(changeVerdict([],{added:[]},receivingObligations(side,head)).verdict,'incomplete');
  const baseline={...side,receivingPackages:[]},head={...baseline,machine:{...side.machine,machineBlob:'new'}};
  assert.equal(changeVerdict([],{added:[]},receivingObligations(baseline,head)).verdict,'incomplete');
  assert.equal(changeVerdict([],{added:[]},{removedPackages:[{name:'@example/retired',disposition:'unmeasured-retired-executable'}]}).verdict,'incomplete');
  assert.equal(changeVerdict([],{added:[]},{removedPackages:[{name:'@example/unused',disposition:'outside-baseline-machine-closure'}]}).verdict,'no-regression');
});

test('changed declared bytes and newly enrolled files remain explicit while pass/fail comparison stays paired',()=>{
  const row=(tests,results,commit)=>({name:'@example/consumer',repository:'example/consumer',path:'',manifestSha256:commit,commit,tests,results});
  const baseline=[row([{path:'one',gitBlob:'a'},{path:'two',gitBlob:'b'}],[{file:'one',passed:true},{file:'two',passed:false}],'base')];
  const candidate=[row([{path:'one',gitBlob:'c'},{path:'two',gitBlob:'b'},{path:'new',gitBlob:'d'}],[{file:'one',passed:false},{file:'two',passed:false},{file:'new',passed:true}],'head')];
  const result=compareDeclaredReceiving(baseline,candidate);
  assert.deepEqual(result.regressions,['@example/consumer:one']);assert.deepEqual(result.preexisting,['@example/consumer:two']);
  assert.equal(result.changedTests[0].baseline.gitBlob,'a');assert.equal(result.changedTests[0].candidate.gitBlob,'c');assert.equal(result.addedTests[0].path,'new');
  assert.equal(changeVerdict([],{added:[]},result).verdict,'regression');
});

test('receiving carries its own qualified interpreter and never falls back to the controller Node',t=>{
 const f=fixture(t),commit=f.commit(['receiving/one.mjs']),output=f.materialize(commit,'head'),node='/missing-qualified-composition/bin/node';
 let observed;
 runDeclaredReceiving(output,{PATH:'/trusted/bin'},(directory,files,env,selected)=>{
   observed={env,selected};return new Map(files.map(file=>[file,true]));
 },node);
 assert.equal(observed.selected,node);assert.ok(observed.env.PATH.startsWith('/missing-qualified-composition/bin:'));
 assert.throws(()=>runDeclaredReceiving(output,{PATH:process.env.PATH},undefined,node),error=>{
   assert.equal(error.code,'ERR_TEST_MEASUREMENT_UNAVAILABLE');
   assert.equal(error.executable,node);assert.equal(error.processErrorCode,'ENOENT');
   assert.equal(error.status,null);assert.equal(error.signal,null);
   assert.equal(error.completedResults.size,0);
   assert.equal(error.file,join(output,'packages/@example__consumer/receiving/one.mjs'));
   return true;
 });
});
