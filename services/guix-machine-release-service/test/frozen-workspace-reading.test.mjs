import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseFrozenYaml,assertFrozenRegistryGraph,readFrozenWorkspace,manifestLockDiscrepancies} from '../scripts/design-rules.mjs';

const provider='@fixture/provider',consumer='@fixture/consumer';
const target='packages/@fixture__provider',caller='packages/@fixture__consumer';
const integrity='sha512-'+Buffer.alloc(64).toString('base64');
function graph(){
  const manifests=new Map([
    ['.',{private:true,packageManager:'pnpm@10.34.6',dependencies:{registry:'1.0.0'}}],
    [target,{name:provider,version:'1.0.0'}],
    [caller,{name:consumer,dependencies:{[provider]:'workspace:*'}}],
  ]);
  const overrides={[provider]:'workspace:*'},lock={lockfileVersion:'9.0',overrides:{...overrides},
    importers:{'.':{dependencies:{registry:{specifier:'1.0.0',version:'1.0.0'}}},[target]:{},
      [caller]:{dependencies:{[provider]:{specifier:'workspace:*',version:'link:../@fixture__provider'}}}},
    packages:{'registry@1.0.0':{resolution:{integrity}}},
    snapshots:{'registry@1.0.0':{dependencies:{[provider]:'link:'+target}}}};
  return {lock,manifests,context:{sourceManifests:manifests,workspaceOverrides:overrides}};
}
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'frozen-workspace-reading-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const f=graph(),workspace=join(root,'workspace'),yamlCli=join(root,'yaml/bin.mjs');
  const put=(path,body)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(body));};
  put(join(root,'yaml/package.json'),{name:'yaml',version:'2.9.0'});put(yamlCli,{});
  for(const [at,manifest] of f.manifests)put(join(workspace,at,'package.json'),manifest);
  put(join(workspace,'pnpm-lock.yaml'),f.lock);
  put(join(workspace,'pnpm-workspace.yaml'),{packages:['packages/*'],overrides:f.context.workspaceOverrides});
  let calls=0;
  const options={workspace,yamlCli,environment:{HOME:root,PATH:'/fixed-node'},execute:(program,args,options)=>{
    calls++;assert.equal(program,process.execPath);
    assert.deepEqual(args,[fileURLToPath(new URL('../scripts/parse-frozen-yaml.mjs',import.meta.url)),join(root,'yaml/dist/index.js')]);
    // Explicitly closed subprocess port: these pure controls evaluate no provider or package code.
    return {status:0,stdout:options.input};
  }};
  return {...f,root,workspace,put,options,calls:()=>calls,read:()=>readFrozenWorkspace(options)};
}

test('pinned parser delegation uses one exact API adapter and forwards bytes and environment',t=>{
  const f=fixture(t),text='{"exact":"bytes"}';let seen;
  assert.deepEqual(parseFrozenYaml(text,{...f.options,execute:(program,args,options)=>{seen={program,args,options};return{status:0,stdout:text};}}),{exact:'bytes'});
  assert.equal(seen.options.input,text);assert.equal(seen.options.env,f.options.environment);
  assert.equal(seen.args.length,2);assert.ok(seen.args[1].endsWith('/yaml/dist/index.js'));
  for(const result of [{status:1,stdout:'{}'},{status:0,stdout:'not JSON'},{error:new Error('closed')}])
    assert.throws(()=>parseFrozenYaml(text,{...f.options,execute:()=>result}),/genuine YAML parser failed|did not return/);
  f.put(join(f.root,'yaml/package.json'),{name:'yaml',version:'2.8.1'});
  assert.throws(()=>parseFrozenYaml(text,{...f.options,execute:()=>{throw new Error('must not launch');}}),/provider version differs/);
});

test('qualified snapshot overrides use lockfile-root links while direct links use importer-relative paths',()=>{
  const f=graph();assert.equal(assertFrozenRegistryGraph(f.lock,f.context),f.lock);
  f.lock.snapshots['registry@1.0.0'].optionalDependencies=f.lock.snapshots['registry@1.0.0'].dependencies;
  delete f.lock.snapshots['registry@1.0.0'].dependencies;
  assert.equal(assertFrozenRegistryGraph(f.lock,f.context),f.lock);
});

test('source links still require exact importer and manifest evidence',()=>{
  const f=graph();assert.throws(()=>assertFrozenRegistryGraph(f.lock),/qualified importer/);
  for(const amend of [x=>x.context.sourceManifests.delete(target),x=>{delete x.lock.importers[target];},
    x=>x.context.sourceManifests.set(target,{name:'@fixture/other'})]){
    const x=graph();amend(x);assert.throws(()=>assertFrozenRegistryGraph(x.lock,x.context),/qualified importer|identity differs/);
  }
});

for(const [label,amend] of [
  ['missing reviewed override',f=>{delete f.lock.overrides[provider];}],
  ['missing generated override',f=>{delete f.context.workspaceOverrides[provider];}],
  ['changed reviewed override',f=>{f.lock.overrides[provider]='1.0.0';}],
  ['changed generated override',f=>{f.context.workspaceOverrides[provider]='workspace:^';}],
])test(label+' refuses transitive source links',()=>{
  const f=graph();amend(f);assert.throws(()=>assertFrozenRegistryGraph(f.lock,f.context),/unqualified transitive source override/);
});

for(const value of ['link:../outside','link:/frozen-workspace/'+target,'link:../@fixture__provider','link:',
  'link:packages/absent','link:packages/../'+target,'link:./'+target,'file:'+target,'workspace:*'])
  test('unqualified snapshot target refuses: '+value,()=>{
    const f=graph();f.lock.snapshots['registry@1.0.0'].dependencies[provider]=value;
    assert.throws(()=>assertFrozenRegistryGraph(f.lock,f.context),/escapes admitted source|not canonical|unqualified edge protocol/);
  });

test('a direct importer cannot substitute snapshot-relative target semantics',()=>{
  const f=graph();f.lock.importers[caller].dependencies[provider].version='link:'+target;
  assert.throws(()=>assertFrozenRegistryGraph(f.lock,f.context),/qualified importer/);
});

test('registry integrity, dependency completeness, aliases, hooks and SQL guards remain closed',()=>{
  for(const [amend,expected] of [
    [f=>{delete f.lock.packages['registry@1.0.0'].resolution.integrity;},/integrity is missing/],
    [f=>{delete f.lock.snapshots['registry@1.0.0'];},/incomplete frozen edge/],
    [f=>{f.lock.packages['registry@1.0.0'].dependencies={other:'1.0.0'};},/overrides snapshot edges/],
    [f=>{f.lock.pnpmfileChecksum='unreviewed';},/hook checksum/],
    [f=>{f.lock.patchedDependencies={registry:{hash:'unreviewed'}};},/patched graph/],
    [f=>{f.lock.snapshots['registry@1.0.0'].dependencies.storage='sqlite3@5.0.0';},/SQLite admission refused/],
  ]){const f=graph();amend(f);assert.throws(()=>assertFrozenRegistryGraph(f.lock,f.context),expected);}
  const f=graph();delete f.lock.importers[caller].dependencies;f.lock.snapshots['registry@1.0.0']={};
  assert.doesNotThrow(()=>assertFrozenRegistryGraph(f.lock),'ordinary registry graph needs no source override context');
});

test('materialized workspace reads preserve bytes and validate full manifest identity before graph links',t=>{
  const f=fixture(t),before=readFileSync(join(f.workspace,'pnpm-lock.yaml'),'utf8');
  assert.equal(f.read().lockText,before);assert.equal(f.calls(),2);
  assert.equal(readFileSync(join(f.workspace,'pnpm-lock.yaml'),'utf8'),before);
});

for(const [label,amend,expected] of [
  ['changed target name',f=>f.put(join(f.workspace,target,'package.json'),{name:'@fixture/other'}),/identity differs/],
  ['ambiguous target name',f=>f.put(join(f.workspace,target,'package.json'),{name:consumer}),/identity is missing or ambiguous/],
  ['missing importer',f=>{delete f.lock.importers[target];f.put(join(f.workspace,'pnpm-lock.yaml'),f.lock);},/importer set differs/],
  ['missing source directory',f=>rmSync(join(f.workspace,target),{recursive:true}),/importer set differs/],
  ['changed source specifier',f=>f.put(join(f.workspace,caller,'package.json'),{name:consumer,dependencies:{[provider]:'1.0.0'}}),/specifier differs/],
  ['extra source dependency',f=>f.put(join(f.workspace,target,'package.json'),{name:provider,dependencies:{extra:'1.0.0'}}),/declarations differ/],
  ['manager mismatch',f=>f.put(join(f.workspace,'package.json'),{packageManager:'pnpm@11.9.0',dependencies:{registry:'1.0.0'}}),/packageManager/],
  ['npm configuration',f=>f.put(join(f.workspace,target,'.npmrc'),{}),/npm configuration/],
  ['redirected source directory',f=>{renameSync(join(f.workspace,target),join(f.root,'redirect'));symlinkSync(join(f.root,'redirect'),join(f.workspace,target));},/not a directory/],
  ['redirected source manifest',f=>{const path=join(f.workspace,target,'package.json');renameSync(path,join(f.root,'redirect.json'));symlinkSync(join(f.root,'redirect.json'),path);},/manifest is redirected/],
])test(label+' remains refused before any acquisition',t=>{const f=fixture(t);amend(f);assert.throws(f.read,expected);});

test('frozen importer refusal gives bounded exact package paths in both directions', t => {
  const f = fixture(t);
  delete f.lock.importers[target];
  f.lock.importers['packages/@fixture__missing'] = {};
  f.put(join(f.workspace, 'pnpm-lock.yaml'), f.lock);
  assert.throws(f.read, error => {
    assert.match(error.message, /reviewed importer set differs from materialized workspace/);
    assert.match(error.message, /materialized=3 reviewed=3/);
    assert.ok(error.message.includes('not-in-lock=1 ["packages/@fixture__provider"]'));
    assert.ok(error.message.includes('not-on-disk=1 ["packages/@fixture__missing"]'));
    return true;
  });
});

test('provider fixture admits only the exact parser adapter and inspected API argument',()=>{
  const boundary=readFileSync(new URL('./fixtures/frozen-provider-boundary.cjs',import.meta.url),'utf8');
  assert.match(boundary,/args\.length===2&&args\[0\]===parser&&\s+args\[1\]===path\.resolve\(path\.dirname\(yaml\),'dist\/index\.js'\)/u);
  assert.match(boundary,/else denied\('unexpected subprocess'\)/u);
  assert.match(boundary,/denied\('subprocess escape'\)/u);assert.match(boundary,/denied\('external socket'\)/u);
});


test('batch report joins independent source-lock defects without relaxing admission',t=>{
  const f=fixture(t);
  const importer=Object.keys(f.lock.importers).filter(x=>x.startsWith('packages/')).sort();
  const first=importer[0],second=importer[1];
  f.put(join(f.workspace,first,'package.json'),{name:f.manifests.get(first).name,
    dependencies:{'@fixture/new-first':'workspace:*'}});
  f.put(join(f.workspace,second,'package.json'),{name:f.manifests.get(second).name,
    dependencies:{'@fixture/new-second':'workspace:*'}});
  assert.throws(()=>f.read(),error=>{
    assert.match(error.message,/manifest and reviewed lock declarations differ/);
    assert.ok(error.message.includes('@fixture/new-first'));
    assert.ok(error.message.includes('@fixture/new-second'));
    assert.match(error.message,/"count":2/);
    return true;
  });
});
test('pure mismatch analysis preserves original edge semantics and stable ordering',()=>{
  const a=manifestLockDiscrepancies({dependencies:{z:'workspace:*',a:'^1.0.0'},
    devDependencies:{l:'1.0.0'}},{dependencies:{a:{specifier:'^2.0.0'},
      y:{specifier:'1.0.0'}},devDependencies:{l:{specifier:'1.0.0'}}},'packages/test');
  assert.deepEqual(a,[{importer:'packages/test',field:'dependencies',
    missing:['z'],extra:['y'],specifiers:[{dependency:'a',declared:'^1.0.0',reviewed:'^2.0.0'}]}]);
  assert.deepEqual(manifestLockDiscrepancies({},{},'.'),[]);
  assert.throws(()=>manifestLockDiscrepancies({},null,'.'),/manifest and importer/);
});
