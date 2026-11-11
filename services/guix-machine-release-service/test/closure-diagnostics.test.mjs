import test from 'node:test';
import assert from 'node:assert/strict';
import {missingWorkspaceSources, assertWorkspaceSources, ambiguousRequiredSources} from '../scripts/closure-diagnostics.mjs';
import {selectedSourcesWithDiagnostics} from '../scripts/prepare-sources.mjs';

const old = '@red-cup-engineering/computer-data-services-section';
const renamed = '@red-cup-engineering/computer-data-engineering-services-section';
const pkg = (name, deps={}, extra={}) => ({manifest:{name, version:'0.1.0', dependencies: deps, ...extra}});
const fixture = new Map([
  [renamed, pkg(renamed)],
  ['@causeway-services/koios-news', pkg('@causeway-services/koios-news', {[old]:'workspace:*'})],
  ['@causeway-services/public-education-services-section', pkg('@causeway-services/public-education-services-section', {[old]:'workspace:*'})],
  ['@coesite-operations/enterprise-outreach-operations-services-section', pkg('@coesite-operations/enterprise-outreach-operations-services-section', {[old]:'workspace:*'})],
  ['@red-cup-engineering/computer-code-development-engine', pkg('@red-cup-engineering/computer-code-development-engine', {[old]:'workspace:*'})],
  ['@red-cup-engineering/blockchain-trashpanda-services-section', pkg('@red-cup-engineering/blockchain-trashpanda-services-section', {[old]:'workspace:*'})],
  ['@lenticule-science/divining', pkg('@lenticule-science/divining', {[old]:'workspace:*'})],
]);
const roots=[...fixture.keys()];

test('frozen six-consumer rename incident reports every missing source', () => {
  const results=missingWorkspaceSources(fixture,roots);
  assert.equal(results.length,6);
  assert.deepEqual(results.map(row=>row.dependency),Array(6).fill(old));
  assert.throws(()=>assertWorkspaceSources(fixture,roots), error =>
    results.every(({consumer,dependency})=>error.message.includes(consumer + ' -> ' + dependency)));
});
test('historical Koios-only migration never implied full closure', () => {
  const p=new Map(fixture);
  p.set('@causeway-services/koios-news',pkg('@causeway-services/koios-news',{[renamed]:'workspace:*'}));
  assert.equal(missingWorkspaceSources(p,roots).length,5);
});
test('historical six migrations pass fixture without certifying current Guix', () => {
  const p=new Map([...fixture].map(([name,source])=>[name,pkg(name,
    Object.fromEntries(Object.entries(source.manifest.dependencies).map(([k,v])=>[k===old?renamed:k,v])))]));
  assert.equal(missingWorkspaceSources(p,roots).length,0);
  assert.doesNotThrow(()=>assertWorkspaceSources(p,roots));
});
test('reaches transitive runtime dependencies without looping forever',()=>{
  const p=new Map([['a',pkg('a',{b:'workspace:*'})],['b',pkg('b',{a:'workspace:*',lost:'workspace:*'})]]);
  assert.deepEqual(missingWorkspaceSources(p,['a']),[{consumer:'b',dependency:'lost'}]);
});
test('non-workspace semver is no false error, and a missing workspace provider has no registry substitute',()=>{
  const p=new Map([['a',pkg('a',{external:'1.2.3', provider:'workspace:*'})]]);
  assert.deepEqual(missingWorkspaceSources(p,['a']),[{consumer:'a',dependency:'provider'}]);
});
test('optional absent peer is excluded; required peer is checked',()=>{
  const p=new Map([['a',pkg('a',{}, {peerDependencies:{req:'workspace:*',opt:'workspace:*'},peerDependenciesMeta:{opt:{optional:true}}})]]);
  assert.deepEqual(missingWorkspaceSources(p,['a']),[{consumer:'a',dependency:'req'}]);
});
test('optionalDependencies with workspace demand are included',()=>{
  const p=new Map([['a',pkg('a',{}, {optionalDependencies:{optionalSource:'workspace:*'}})]]);
  assert.deepEqual(missingWorkspaceSources(p,['a']),[{consumer:'a',dependency:'optionalSource'}]);
});
test('does not invent dependencies for missing or ambiguous package roots',()=>{
  const p=new Map([['ambiguous',[pkg('ambiguous'),pkg('ambiguous')]]]);
  assert.deepEqual(missingWorkspaceSources(p,['missing','ambiguous']),[]);
});
test('refuses malformed entries and package collections',()=>{
  assert.throws(()=>missingWorkspaceSources({},['a']),/Map/);
  assert.throws(()=>missingWorkspaceSources(new Map(),['a',null]),/entries/);
});
test('stable ordering independent of source insertion or entry order',()=>{
  const rev=new Map([...fixture].reverse());
  assert.deepEqual(missingWorkspaceSources(rev,[...roots].reverse()),missingWorkspaceSources(fixture,roots));
});

test('resolver integration reports all simultaneous missing workspace sources', () => {
  assert.throws(
    () => selectedSourcesWithDiagnostics(fixture, roots),
    error => /all missing workspace sources \(6\)/u.test(error.message) &&
      [...fixture.keys()].filter(name => name !== renamed)
        .every(name => error.message.includes(name + ' -> ' + old))
  );
});

test('one source review lists all ambiguous packages in the possible required closure', () => {
  const source=(name,repo,dependencies={},extra={})=>({
    ...pkg(name,dependencies,extra),repository:repo,path:'services/'+name,
  });
  const p=new Map([
    ['root',source('root','house/main',{alpha:'workspace:*',beta:'workspace:*'})],
    ['alpha',[
      source('alpha','old/one',{gamma:'workspace:*'}),
      source('alpha','new/two',{delta:'workspace:*'}),
    ]],
    ['beta',[source('beta','old/one'),source('beta','new/two')]],
    ['gamma',source('gamma','old/one',{root:'workspace:*'})], // cycle
    ['delta',[source('delta','old/one'),source('delta','new/two')]],
    ['unrelated',[source('unrelated','old/one'),source('unrelated','new/two')]],
  ]);
  const names=ambiguousRequiredSources(p,['root']).map(row=>row.name);
  assert.deepEqual(names,['alpha','beta','delta']);
  assert.ok(!names.includes('unrelated'));
  assert.throws(()=>selectedSourcesWithDiagnostics(p,['root']),error=>
    /ambiguous source owner for required package alpha/.test(error.message)
    && /all ambiguities in possible required closure \(3, showing 3\)/.test(error.message)
    && ['alpha','beta','delta'].every(name=>error.message.includes(name+' => '))
    && !error.message.includes('unrelated')
  );
});

test('ambiguous report is stable across source Map order and excludes optional absent peers', () => {
  const a=pkg('a',{b:'workspace:*'}, {peerDependencies:{absent:'workspace:*'},peerDependenciesMeta:{absent:{optional:true}}});
  const choices=[{...pkg('b',{c:'workspace:*'}),repository:'older',path:'b'},{...pkg('b'),repository:'newer',path:'b'}];
  const p=new Map([['a',a],['b',choices],['c',[{...pkg('c'),repository:'two',path:'c'},{...pkg('c'),repository:'one',path:'c'}]]]);
  const original=ambiguousRequiredSources(p,['a']);
  assert.deepEqual(original.map(row=>row.name),['b','c']);
  assert.deepEqual(original[0].sources,['newer:b','older:b']);
  assert.deepEqual(ambiguousRequiredSources(new Map([...p].reverse()),['a']),original);
  assert.doesNotThrow(()=>selectedSourcesWithDiagnostics(new Map([['a',pkg('a')]]),['a']));
  assert.deepEqual(ambiguousRequiredSources(p,['absent']),[]);
});

test('ambiguity reporting validates inputs and does not change single-error selection semantics', () => {
  assert.throws(()=>ambiguousRequiredSources({},['a']),/Map/);
  assert.throws(()=>ambiguousRequiredSources(new Map(),['a',null]),/entries/);
  const choices=[{...pkg('x'),repository:'a/repo',path:'.'},{...pkg('x'),repository:'b/repo',path:'.'}];
  const p=new Map([['x',choices]]);
  assert.deepEqual(ambiguousRequiredSources(p,['x']).map(z=>z.name),['x']);
  assert.throws(()=>selectedSourcesWithDiagnostics(p,['x']),error=>
    /ambiguous source owner for required package x/.test(error.message)
    && !error.message.includes('all ambiguities in possible required closure'));
});
