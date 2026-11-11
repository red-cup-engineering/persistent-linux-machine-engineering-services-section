// Portable owner contract controls use explicit fixture readers.
// Genuine provider qualification is retained separately, without vendoring it.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {corpusFixture} from './fixtures/lspace-corpus-fixture.mjs';
import {gitlinks,mountedSourceClosure} from '../scripts/source-pins.mjs';
import {projectLspaceCorpus} from '../scripts/lspace-corpus.mjs';
const SCIENCE='lenticule-science/science-services-section',CHILD='lenticule-science/math-services-section';
const OCCURRENCE='sources/lenticule-science/science-services-section';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

function ownerFixture(t){
 const f=corpusFixture(t),supplier=f.options.packageSource;
 const root={repository:supplier.repository,commit:supplier.commit,path:'.'};
 const mounts=[...gitlinks(f.directories.get(SCIENCE),supplier.commit,{requireAll:true})]
  .map(([repository,row])=>({repository,commit:row.commit,path:row.path,ref:row.ref}));
 const prepared=mountedSourceClosure({repositories:[root,...mounts]},source=>f.directories.get(source.repository));
 assert.equal(prepared.graph.machine,null);
 f.options.graph=prepared.graph;f.options.graphSha256=prepared.graphSha256;
 f.options.sourceOccurrence={repository:SCIENCE,commit:supplier.commit,path:OCCURRENCE};
 return f;
}

test('owner-rooted committed graph projects fixture reader documents at its separately bound occurrence',async t=>{
 const f=ownerFixture(t),result=await projectLspaceCorpus(f.options);
 assert.equal(result.documents,4);assert.equal(result.assets,1);assert.equal(result.occurrence,OCCURRENCE);
 assert.equal(f.options.graph.repositories.find(row=>row.repository===SCIENCE).paths[0],'.');
 assert.deepEqual(f.options.graph.repositories.find(row=>row.repository===CHILD).paths,['services/math-services-section']);
 assert.ok(f.written.has(OCCURRENCE+'/services/math-services-section/content/math.MARKDOWN'));
 assert.match(f.written.get(OCCURRENCE+'/content/protected.md').bytes.toString(),/visibility: protected/u);
 assert.ok(f.reads.every(row=>!/(?:^|\/)(?:private|legacy|dev|sites|lib)(?:\/|$)|unreferenced|link\.png|leak/u.test(row.path)));
 assert.ok(!f.lists.includes('fixture/sibling'));
});

test('owner graph and full machine graph preserve exactly the same committed output bytes and modes',async t=>{
 const f=ownerFixture(t),ownerOptions={...f.options};
 await projectLspaceCorpus({...f.options,graph:f.prepared.graph,graphSha256:f.prepared.graphSha256,sourceOccurrence:undefined});
 const first=[...f.written].map(([path,row])=>[path,row.oid,row.mode,row.bytes.toString('hex')]).sort();
 f.written.clear();f.reads.length=0;
 await projectLspaceCorpus(ownerOptions);
 assert.deepEqual([...f.written].map(([path,row])=>[path,row.oid,row.mode,row.bytes.toString('hex')]).sort(),first);
});

test('owner occurrence mismatches and multiple roots refuse before any tree or blob read',async t=>{
 const changes=[
  o=>{o.sourceOccurrence.path='other/science-services-section';},
  o=>{o.sourceOccurrence.repository='fixture/copied-machine';},
  o=>{o.sourceOccurrence.commit='0'.repeat(40);},
  o=>{o.graph.machine={repository:'fixture/machine'};},
  o=>{o.graph.repositories.find(row=>row.repository===SCIENCE).paths.push('second-occurrence');},
  o=>{o.graph.repositories.find(row=>row.repository===CHILD).paths.push('.');},
 ];
 for(const change of changes){
  const f=ownerFixture(t);change(f.options);f.options.graphSha256=hash(f.options.graph);
  await assert.rejects(projectLspaceCorpus(f.options));
  assert.deepEqual(f.lists,[]);assert.deepEqual(f.reads,[]);assert.equal(f.written.size,0);
 }
});

test('owner-relative missing child or substituted machine coordinate refuses before body acquisition',async t=>{
 for(const change of [
  o=>{o.graph.repositories=o.graph.repositories.filter(row=>row.repository!==CHILD);},
  o=>{o.graph.repositories.find(row=>row.repository===CHILD).paths=[OCCURRENCE+'/services/math-services-section'];},
 ]){
  const f=ownerFixture(t);change(f.options);f.options.graphSha256=hash(f.options.graph);
  // Even an excluded child still requires its authenticated committed identity.
  f.options.configuration.excludes=['services'];
  await assert.rejects(projectLspaceCorpus(f.options),/unresolved L-Space descendant/u);
  assert.deepEqual(f.lists,[]);assert.deepEqual(f.reads,[]);assert.equal(f.written.size,0);
 }
});

test('owner binding is explicit and cannot convert a full machine graph into an owner-rooted graph',async t=>{
 const f=ownerFixture(t);delete f.options.sourceOccurrence;
 await assert.rejects(projectLspaceCorpus(f.options));assert.deepEqual(f.lists,[]);assert.deepEqual(f.reads,[]);
 const g=ownerFixture(t);g.options.graph=g.prepared.graph;g.options.graphSha256=g.prepared.graphSha256;
 await assert.rejects(projectLspaceCorpus(g.options),/owner graph differs/u);assert.deepEqual(g.lists,[]);assert.deepEqual(g.reads,[]);
});

test('owner-rooted fixture exclusions deny child metadata and embedded media bytes',async t=>{
 const f=ownerFixture(t);f.options.configuration.excludes=['services','media'];
 const result=await projectLspaceCorpus(f.options);
 assert.equal(result.documents,3);assert.equal(result.assets,0);
 assert.deepEqual(f.lists,[SCIENCE]);
 assert.ok(f.reads.every(row=>row.repository===SCIENCE&&!row.path.startsWith('media/')));
});
