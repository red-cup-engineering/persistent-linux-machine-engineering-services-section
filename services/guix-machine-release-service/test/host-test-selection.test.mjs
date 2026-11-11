import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
import {packageReceivingEnvironment} from '../scripts/package-receiving.mjs';

test('receiving runs the controller package test command without recursing into receiving',()=>{
  const source=readFileSync(new URL('../scripts/check-host.mjs',import.meta.url),'utf8');
  const start=source.indexOf("exec('guile',");
  const end=source.indexOf('const signchainChecks=');
  assert.ok(start>=0&&end>start);
  const calls=[],environment={PATH:'/fixture/previous-path'};
  const block=source.slice(start,end).replaceAll('import.meta.url',JSON.stringify('file:///fixture/controller/scripts/check-host.mjs'));
  new Function('exec','fileURLToPath','URL','environment','process','dirname',block)(
    (...args)=>calls.push(args),fileURLToPath,URL,environment,{execPath:'/fixture/runtime/bin/node'},dirname);
  assert.deepEqual(calls.map(([command])=>command),['guile','guile','npm']);
  assert.deepEqual(calls.at(-1),['npm',['test'],{env:{PATH:'/fixture/runtime/bin:/fixture/previous-path'},cwd:'/fixture/controller/'}]);
  const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url)));
  assert.equal(manifest.scripts.test,'node --test test/*.test.mjs');
});

// Inspect only trusted repository source's argument declaration. This is not an
// evaluator for external input. Never execute the receiving entry point.
function selectedHostTests(packageChecks=[]) {
  const source=readFileSync(new URL('../scripts/check-host.mjs',import.meta.url),'utf8');
  const start=source.indexOf('const signchainChecks=');
  const end=source.indexOf('const receivingEnvironment=');
  assert.ok(start>=0&&end>start,'the existing host-admission test selection is present');
  const calls=[],environment={};
  const providers=Object.fromEntries(['signchain','signcraft','feltos','semantic-content-identify-service','computer-code-development-engine'].map(name=>[
    `@red-cup-engineering/${name}`,`/fixture/admitted/${name}`,
  ]));
  const block=source.slice(start,end).replaceAll('import.meta.url',JSON.stringify('file:///fixture/controller/scripts/check-host.mjs'));
  new Function('exec','process','fileURLToPath','URL','join','providers','entry','environment','packageChecks',block)(
    (...args)=>calls.push(args),{execPath:'node'},fileURLToPath,URL,join,providers,'/fixture/host',environment,packageChecks);
  assert.equal(calls.length,1);
  assert.equal(calls[0][0],'node');
  assert.equal(calls[0][2].env,environment);
  return calls[0][1];
}

test('host admission selects merged history and lifecycle regressions through their actual providers',()=>{
  const selected=selectedHostTests();
  const additions=[
    '/fixture/admitted/signcraft/test/history-derivation.test.mjs',
    '/fixture/admitted/signcraft/test/history-projection.test.mjs',
    '/fixture/admitted/feltos/test/world.test.mjs',
    '/fixture/admitted/feltos/test/work-cycle.test.mjs',
    '/fixture/admitted/feltos/test/work-status.test.mjs',
    '/fixture/admitted/computer-code-development-engine/test/checkout-health-dispatch-readout.test.mjs',
  ];
  for(const path of additions)assert.equal(selected.filter(value=>value===path).length,1,`${path} occurs exactly once`);
  assert.deepEqual(selected.filter(value=>!additions.includes(value)),[
    '--test','/fixture/controller/test/release-admission.test.mjs',
    ...['work-forwarding.test.mjs','work-replication.test.mjs','work-peer-schedule.test.mjs','serve-instance-lifecycle.test.mjs'].map(name=>`/fixture/host/test/${name}`),
    '/fixture/admitted/signchain/test/typed-theory.test.mjs',
    '/fixture/admitted/signchain/test/derivation-validity.test.mjs',
    '/fixture/admitted/semantic-content-identify-service/test/semantic-content-identity.test.mjs',
  ],'all earlier host-admission checks retain their order');
});

test('code-engine compatibility bridge remains until explicitly selected, then runs exactly once',()=>{
  const name='@red-cup-engineering/computer-code-development-engine';
  const directory='/fixture/admitted/computer-code-development-engine';
  const path=join(directory,'test/checkout-health-dispatch-readout.test.mjs');
  const legacy=selectedHostTests();
  assert.equal(legacy.filter(arg=>arg===path).length,1,'a controller-only source update must not remove the gate');
  assert.deepEqual(selectedHostTests([{name:'@example/other',directory:'/other',tests:['/other/test.mjs']}]),legacy);
  const packageChecks=[{name,directory,tests:[path]}];
  const selected=selectedHostTests(packageChecks);
  assert.deepEqual(selected,legacy.filter(arg=>arg!==path),'only the temporary bridge is superseded');
  const source=readFileSync(new URL('../scripts/check-host.mjs',import.meta.url),'utf8');
  const block=source.slice(source.indexOf('const receivingEnvironment='),source.indexOf("exec(process.execPath,['--test',join(providers['@red-cup-engineering/computer-inference-engine']"));
  const calls=[];
  new Function('exec','process','packageReceivingEnvironment','packageChecks',block)(
    (...args)=>calls.push(args),{execPath:'/fixture/candidate/bin/node'},packageReceivingEnvironment,packageChecks);
  assert.equal([...selected,...calls.flatMap(([,args])=>args)].filter(arg=>arg===path).length,1);
});

test('package checks use only the candidate Node and fixed test arguments, with no empty discovery',()=>{
  const source=readFileSync(new URL('../scripts/check-host.mjs',import.meta.url),'utf8');
  const start=source.indexOf('const receivingEnvironment=');
  const end=source.indexOf("exec(process.execPath,['--test',join(providers['@red-cup-engineering/computer-inference-engine']");
  const block=source.slice(start,end);
  const calls=[],candidate='/fixture/candidate/bin/node';
  const execute=packageChecks=>new Function('exec','process','packageReceivingEnvironment','packageChecks',block)(
    (...args)=>calls.push(args),{execPath:candidate},
    node=>packageReceivingEnvironment(node,{PATH:'/fixture/tools',NODE_OPTIONS:'--import /untrusted/loader.mjs',SKIP_TESTS:'1',NODE_TEST_CONTEXT:'child-v8'}),packageChecks);
  execute([]);
  assert.deepEqual(calls,[],'no declaration must never become bare node --test');
  execute([{directory:'/fixture/package',tests:['/fixture/package/test/one.mjs','/fixture/package/test/two.mjs']}]);
  assert.deepEqual(calls,[[candidate,['--test','/fixture/package/test/one.mjs','/fixture/package/test/two.mjs'],{
    cwd:'/fixture/package',env:{PATH:'/fixture/candidate/bin:/fixture/tools',NODE_OPTIONS:'--max-old-space-size=384'},
  }]]);
  assert.doesNotMatch(block,/computer-code-development-engine|checkout-health-dispatch-readout/,'the generic runner has no package catalog');
});

test('all subsequent legacy checks retain their exact commands, order and environment',()=>{
  const source=readFileSync(new URL('../scripts/check-host.mjs',import.meta.url),'utf8');
  const start=source.indexOf("exec(process.execPath,['--test',join(providers['@red-cup-engineering/computer-inference-engine']");
  const calls=[],environment={legacy:'unchanged'},artifact='/fixture/artifact';
  const providers=Object.fromEntries(['@red-cup-engineering/computer-inference-engine','@red-cup-engineering/activitypub-services-section'].map(name=>[name,`/fixture/${name}`]));
  const delivery=join(providers['@red-cup-engineering/activitypub-services-section'],'test/delivery-queue-responsiveness.test.mjs');
  new Function('exec','process','join','providers','environment','artifact','existsSync',source.slice(start))(
    (...args)=>calls.push(args),{execPath:'/fixture/candidate/bin/node'},join,providers,environment,artifact,(path)=>path===delivery);
  assert.deepEqual(calls,[
    ['/fixture/candidate/bin/node',['--test',join(providers['@red-cup-engineering/computer-inference-engine'],'test/zero-cash-account-admission.test.mjs')],{env:environment}],
    ['/fixture/candidate/bin/node',['--test',join(providers['@red-cup-engineering/activitypub-services-section'],'test/delivery-queue-responsiveness.test.mjs')],{env:environment}],
    ['/fixture/candidate/bin/node',['--input-type=module','-e',"await import('./app/src/serve-instance.mjs');"],{env:environment,cwd:artifact}],
  ]);
  for(const [,,options] of calls)assert.equal(options.env,environment);
});

test('a channel that still carries the SQLite delivery queue admits its own responsiveness test, never none',()=>{
  const source=readFileSync(new URL('../scripts/check-host.mjs',import.meta.url),'utf8');
  const start=source.indexOf("exec(process.execPath,['--test',join(providers['@red-cup-engineering/computer-inference-engine']");
  const calls=[],environment={legacy:'unchanged'},artifact='/fixture/artifact';
  const providers=Object.fromEntries(['@red-cup-engineering/computer-inference-engine','@red-cup-engineering/activitypub-services-section'].map(name=>[name,`/fixture/${name}`]));
  new Function('exec','process','join','providers','environment','artifact','existsSync',source.slice(start))(
    (...args)=>calls.push(args),{execPath:'/fixture/candidate/bin/node'},join,providers,environment,artifact,()=>false);
  assert.deepEqual(calls[1],['/fixture/candidate/bin/node',['--test',join(providers['@red-cup-engineering/activitypub-services-section'],'test/sqlite-queue-responsiveness.test.mjs')],{env:environment}]);
});
