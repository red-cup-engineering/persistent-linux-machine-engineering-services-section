import test from 'node:test';
import assert from 'node:assert/strict';
import {projectLspaceCorpus} from '../scripts/lspace-corpus.mjs';
import {corpusFixture,OCCURRENCE,CHILD,protectedText,hash} from './fixtures/lspace-corpus-fixture.mjs';

test('projects complete bound reader occurrence and referenced assets from exact child commits',async t=>{
  const f=corpusFixture(t),result=await projectLspaceCorpus(f.options);
  assert.equal(result.documents,4);assert.equal(result.assets,1);
  assert.equal(f.written.get(OCCURRENCE+'/content/protected.md').bytes.toString(),protectedText);
  assert.deepEqual([...f.written.keys()].sort(),[
    '/content/protected.md','/content/public.md','/content/unsafe.md','/media/kept.png','/services/math-services-section/content/math.MARKDOWN',
  ].map(path=>OCCURRENCE+path).sort());
  assert.ok(f.reads.some(row=>row.repository===CHILD));
  assert.ok(!f.lists.includes('fixture/sibling'));
  assert.ok(f.reads.every(row=>!/(?:^|\/)(?:private|dev|legacy|sites|lib)(?:\/|$)/u.test(row.path)));
  assert.ok(!f.reads.some(row=>/link.png|unreferenced|leak/.test(row.path)));
});

test('unbound reader roots and supplier revisions fail before reading tree or blob data',async t=>{
  for(const change of [options=>{options.configuration.root='legacy/elsewhere';},options=>{options.packageSource.commit='0'.repeat(40);},options=>{options.configuration.root='../escape';}]){
    const f=corpusFixture(t);change(f.options);
    await assert.rejects(projectLspaceCorpus(f.options));assert.deepEqual(f.reads,[]);assert.deepEqual(f.lists,[]);
  }
});

test('missing descendant identity or committed mount refuses before any document blob',async t=>{
  const f=corpusFixture(t);f.options.graph=structuredClone(f.options.graph);
  f.options.graph.repositories=f.options.graph.repositories.filter(row=>row.repository!==CHILD);f.options.graphSha256=hash(f.options.graph);
  await assert.rejects(projectLspaceCorpus(f.options),/unresolved L-Space descendant/);assert.deepEqual(f.reads,[]);
  const g=corpusFixture(t),list=g.options.listTree;
  g.options.listTree=source=>list(source).filter(row=>row.mode!=='160000');
  await assert.rejects(projectLspaceCorpus(g.options),/missing from its committed tree/);assert.deepEqual(g.reads,[]);
});

test('graph digest drift and non-boolean admission fail closed before blobs',async t=>{
  const f=corpusFixture(t);f.options.graphSha256='0'.repeat(64);
  await assert.rejects(projectLspaceCorpus(f.options),/authenticated preparation graph/);assert.deepEqual(f.reads,[]);
  for(const answer of [undefined,'true',Promise.resolve(true)]){
    const g=corpusFixture(t);g.options.readerPolicy=()=>({excludes:[],admitPath:()=>answer});
    await assert.rejects(projectLspaceCorpus(g.options),/must return a boolean/);assert.deepEqual(g.reads,[]);
  }
});

test('returned document bytes must match their committed blob identity',async t=>{
  const f=corpusFixture(t);f.options.readBlobs=(_source,rows)=>rows.map(()=>Buffer.from('uncommitted bytes'));
  await assert.rejects(projectLspaceCorpus(f.options),/blob identity differs/);assert.equal(f.written.size,0);
});

test('additional reader exclusions apply to documents and referenced media before acquisition',async t=>{
  const f=corpusFixture(t);f.options.configuration.excludes=['media'];
  const result=await projectLspaceCorpus(f.options);
  assert.equal(result.documents,4);assert.equal(result.assets,0);
  assert.ok(f.reads.every(row=>!row.path.startsWith('media/')));
});
