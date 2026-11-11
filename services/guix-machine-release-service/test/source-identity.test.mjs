import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { command, nestedMembranes, ownedBy, prepare, selectedSources, packageSources } from '../scripts/prepare-sources.mjs';

test('preparation uses committed blobs even when the checkout has later edits', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'guix-source-test-'));
  try {
    const repo = resolve(root, 'repo'); mkdirSync(repo);
    command('git', ['init', '-q'], repo);
    writeFileSync(resolve(repo, 'package.json'), JSON.stringify({ name: '@example/app', version: '1.0.0', type: 'module' }));
    writeFileSync(resolve(repo, 'index.mjs'), 'export const released = true;\n');
    writeFileSync(resolve(repo, 'example-package.json'), JSON.stringify({name:'@example/app',version:'99.0.0'}));
    for (const path of ['unused-one', 'unused-two']) {
      mkdirSync(resolve(repo, path));
      writeFileSync(resolve(repo, path, 'package.json'), JSON.stringify({ name: '@example/unused', version: '1.0.0' }));
    }
    command('git', ['add', '.'], repo);
    command('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], repo);
    const commit = command('git', ['rev-parse', 'HEAD'], repo);
    writeFileSync(resolve(repo, 'index.mjs'), 'throw new Error("unreviewed");\n');
    prepare({ repositories: [{ directory: repo, repository: 'example/app', commit }], entries: ['@example/app'], output: resolve(root, 'output') });
    assert.equal(readFileSync(resolve(root, 'output/packages/@example__app/index.mjs'), 'utf8'), 'export const released = true;\n');
    assert.throws(() => prepare({ repositories: [{ directory: repo, repository: 'example/app', commit }], entries: ['@example/unused'], output: resolve(root, 'ambiguous') }), /ambiguous source owner for required package/);
    assert.throws(() => prepare({ repositories: [{ directory: repo, repository: 'example/app', commit: '0'.repeat(40) }], entries: ['@example/app'], output: resolve(root, 'refused') }), /source commit differs/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an unresolved workspace input is refused rather than floated to a registry tag', () => {
  const packages = new Map([['app', { manifest: { dependencies: { missing: 'workspace:*' } } }]]);
  assert.throws(() => selectedSources(packages, ['app']), /has no home among the machine's sources: app -> missing/);
});

test('ambiguity is refused only in the required dependency closure', () => {
  const provider = { manifest: { dependencies: {} }, repository: 'example/one', path: 'provider' };
  const other = { ...provider, repository: 'example/two' };
  const packages = new Map([['app', { manifest: { dependencies: {} } }], ['unused', [provider, other]]]);
  assert.deepEqual([...selectedSources(packages, ['app']).keys()], ['app']);
  assert.throws(() => selectedSources(packages, ['unused']), /required package unused.*example\/one:provider.*example\/two:provider/);
  packages.get('app').manifest.dependencies.unused = 'workspace:*';
  assert.throws(() => selectedSources(packages, ['app']), /required package unused/);
});

test("a workspace dependency is taken only from its home among the machine's sources, never from the registry", () => {
  const packages = new Map([['app', { manifest: { dependencies: { provider: 'workspace:*' } } }]]);
  assert.throws(() => selectedSources(packages, ['app']), /workspace dependency has no home among the machine's sources: app -> provider/);
  // A released input that the sources do not hold keeps its registry meaning.
  packages.get('app').manifest.dependencies.provider = '0.1.6';
  assert.deepEqual([...selectedSources(packages, ['app']).keys()], ['app']);
  // A home among the sources is always taken, whatever range the consumer names.
  packages.set('provider', { repository: 'example/owner', path: 'services/provider', manifest: { dependencies: {} } });
  assert.deepEqual([...selectedSources(packages, ['app']).keys()], ['app', 'provider']);
  // Optional peers do not enlarge the selected closure.
  packages.get('app').manifest.peerDependencies = { unused: '*' };
  packages.get('app').manifest.peerDependenciesMeta = { unused: { optional: true } };
  assert.deepEqual([...selectedSources(packages, ['app']).keys()], ['app', 'provider']);
});

test('a nested package is materialized under its own name, and inside a parent only where the parent reaches it', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'guix-source-test-'));
  try {
    const repo = resolve(root, 'repo'); mkdirSync(repo);
    command('git', ['init', '-q'], repo);
    const put = (path, text) => { mkdirSync(dirname(resolve(repo, path)), { recursive: true }); writeFileSync(resolve(repo, path), text); };
    const parent = 'services/parent', child = `${parent}/services/child`, other = `${parent}/services/other`;
    put(`${parent}/package.json`, JSON.stringify({ name: '@example/parent', version: '1.0.0', dependencies: { '@example/child': 'workspace:*' } }));
    put(`${parent}/src/index.mjs`, 'export const parent = true;\n');
    put(`${parent}/test/fixtures/sample/package.json`, JSON.stringify({ name: 'fixture', version: '0.0.0' }));
    put(`${parent}/notes/package.json`, '{}\n');
    put(`${child}/package.json`, JSON.stringify({ name: '@example/child', version: '1.0.0' }));
    put(`${child}/src/index.mjs`, 'export const child = true;\n');
    put(`${other}/package.json`, JSON.stringify({ name: '@example/other', version: '1.0.0' }));
    put(`${other}/src/index.mjs`, 'export const other = true;\n');
    // A nested package the parent reaches by a relative path stays where the parent's code expects it.
    put(`${parent}/src/reach.mjs`, "export {weather} from '../services/reached/src/weather.mjs';\n");
    put(`${parent}/services/reached/package.json`, JSON.stringify({ name: '@example/reached', version: '1.0.0' }));
    put(`${parent}/services/reached/src/weather.mjs`, "export {deep} from '../services/deeper/index.mjs';\nexport const weather = true;\n");
    put(`${parent}/services/reached/services/deeper/package.json`, JSON.stringify({ name: '@example/deeper', version: '1.0.0' }));
    put(`${parent}/services/reached/services/deeper/index.mjs`, 'export const deep = true;\n');
    command('git', ['add', '.'], repo);
    command('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], repo);
    const commit = command('git', ['rev-parse', 'HEAD'], repo), output = resolve(root, 'output');
    prepare({ repositories: [{ directory: repo, repository: 'example/repo', commit }], entries: ['@example/parent'], output });
    const at = path => resolve(output, 'packages', path);
    assert.equal(readFileSync(at('@example__child/src/index.mjs'), 'utf8'), 'export const child = true;\n');
    assert.equal(readFileSync(at('@example__parent/src/index.mjs'), 'utf8'), 'export const parent = true;\n');
    // Fixtures and nameless manifests are not packages, so they stay with their owner.
    assert.ok(existsSync(at('@example__parent/test/fixtures/sample/package.json')));
    assert.ok(existsSync(at('@example__parent/notes/package.json')));
    for (const nested of ['services/child', 'services/other']) assert.equal(existsSync(at(`@example__parent/${nested}`)), false, nested);
    assert.equal(existsSync(at('@example__other')), false);
    assert.ok(existsSync(at('@example__parent/services/reached/src/weather.mjs')));
    assert.ok(existsSync(at('@example__parent/services/reached/services/deeper/index.mjs')), 'reached transitively');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a file belongs to its nearest enclosing package root', () => {
  const roots = new Set(['.', 'a', 'a/b']);
  assert.equal(ownedBy(roots, '.', 'top.mjs'), true);
  assert.equal(ownedBy(roots, '.', 'a/inner.mjs'), false);
  assert.equal(ownedBy(roots, 'a', 'a/src/x.mjs'), true);
  assert.equal(ownedBy(roots, 'a', 'a/b/x.mjs'), false);
  assert.equal(ownedBy(roots, 'a/b', 'a/b/deep/x.mjs'), true);
  assert.equal(ownedBy(undefined, '.', 'any/x.mjs'), true);
});

test('relative references from owned source open exactly the nested packages they reach', () => {
  const files = ['a/src/x.mjs', 'a/package.json', 'a/n/package.json', 'a/n/src/y.mjs', 'a/m/package.json', 'a/m/data.json'].map(file => ({ file }));
  const text = { 'a/src/x.mjs': "import y from '../n/src/y.mjs?raw#frag'; const d = new URL('./not-nested.json', import.meta.url);", 'a/package.json': '{"exports":{"./m":"./m/data.json"}}', 'a/n/src/y.mjs': '' };
  const membranes = nestedMembranes(files, new Set(['a', 'a/n', 'a/m', 'b']), 'a', entries => entries.map(({ file }) => text[file] ?? ''));
  assert.deepEqual([...membranes].sort(), ['a', 'b']);
  assert.deepEqual([...nestedMembranes(files, new Set(['a', 'a/n']), 'a', entries => entries.map(() => ''))].sort(), ['a', 'a/n']);
});


test('historical document and machine records remain bytes, never competing executable owners', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'guix-evidence-owner-'));
  try {
    const put = (path, body) => { mkdirSync(dirname(resolve(root, path)), {recursive:true}); writeFileSync(resolve(root, path), body); };
    command('git', ['init','-q'], root);
    const manifest = JSON.stringify({name:'@example/app',version:'1.0.0'});
    put('services/app/package.json', manifest);
    put('services/app/index.mjs', 'export const live = true;\n');
    const records = ['content/text/specifications/evidence/attempt03/stage', 'data/records/machine-deployment-service-records/previous', 'history/received'];
    for (const path of records) put(`services/app/${path}/package.json`, manifest);
    // An executable service named evidence is still source; classification uses its coordinate.
    put('services/evidence/package.json', JSON.stringify({name:'@example/evidence',version:'1.0.0'}));
    command('git',['add','.'],root);
    command('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','source and retained records'],root);
    const commit=command('git',['rev-parse','HEAD'],root);
    const sources=[{directory:root,repository:'example/capital',commit}];
    const packages=packageSources(sources);
    assert.deepEqual([...packages.keys()].sort(),['@example/app','@example/evidence']);
    assert.equal(packages.get('@example/app').path,'services/app');
    const output=resolve(root,'formed');
    prepare({repositories:sources,entries:['@example/app'],output});
    for (const path of records) assert.equal(readFileSync(resolve(output,'packages/@example__app',path,'package.json'),'utf8'),manifest);
    put('services/other/package.json',manifest);
    command('git',['add','services/other'],root);
    command('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','real conflicting owner'],root);
    sources[0].commit=command('git',['rev-parse','HEAD'],root);
    assert.throws(()=>selectedSources(packageSources(sources),['@example/app']),/ambiguous source owner/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
