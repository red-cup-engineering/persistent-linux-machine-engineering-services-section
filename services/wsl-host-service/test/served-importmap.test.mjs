import test from 'node:test';
import assert from 'node:assert';
import { parseServedImportMap, resolveServedImport } from '../src/served-importmap.mjs';

test('import map resolution', () => {
  const base = 'https://site.test/app/index.html';
  const map = parseServedImportMap({ imports: { 'react': './vendor/react.mjs', 'pkg/': './vendor/pkg/' }, scopes: { './room/': { 'react': './vendor/scoped.mjs' } } }, base);
  const roomRef = 'https://site.test/app/room/file.html';
  assert.strictEqual(resolveServedImport('react', roomRef, map), 'https://site.test/app/vendor/scoped.mjs');
  assert.strictEqual(resolveServedImport('react', base, map), 'https://site.test/app/vendor/react.mjs');
  assert.strictEqual(resolveServedImport('pkg/sub.mjs', base, map), 'https://site.test/app/vendor/pkg/sub.mjs');
});

test('invalid mappings', () => {
  const map = parseServedImportMap({ imports: { 'a': null } }, 'https://a.b/');
  assert.throws(() => resolveServedImport('a', 'https://a.b/', map), /Blocked/);
  assert.throws(() => resolveServedImport('b', 'https://a.b/', map), /Unresolved/);
});

test('absolute URL uses normalized map key', () => {
  const m = parseServedImportMap({ imports: { '/absolute.mjs': './mapped.mjs' } }, 'https://site.test/app/index.html');
  assert.strictEqual(resolveServedImport('https://site.test/absolute.mjs', 'https://site.test/room/x.mjs', m), 'https://site.test/app/mapped.mjs');
});

test('non-slash scope does not match sibling', () => {
  const m = parseServedImportMap({ imports: { x: './global.mjs' }, scopes: { './room': { x: './wrong.mjs' } } }, 'https://site.test/app/index.html');
  assert.strictEqual(resolveServedImport('x', 'https://site.test/app/roommate/x.mjs', m), 'https://site.test/app/global.mjs');
});

test('bare targets refuse', () => assert.throws(() => parseServedImportMap({ imports: { x: 'bare' } }, 'https://site.test/')));
test('non-http base refuses', () => assert.throws(() => parseServedImportMap({ imports: {} }, 'file:///tmp/x')));
test('malformed map refuses', () => {
  assert.throws(() => parseServedImportMap({ imports: [] }, 'https://site.test/'));
  assert.throws(() => parseServedImportMap({ imports: null }, 'https://site.test/'));
});
test('nested scopes fall back but a matched null blocks', () => {
  const map = parseServedImportMap({imports: {global: '/g.mjs'}, scopes: {'/room/': {outer: '/o.mjs', blocked: '/b.mjs'}, '/room/deep/': {inner: '/i.mjs', blocked: null}, '/room': {global: '/wrong.mjs'}}}, 'https://site.test/');
  const referrer = 'https://site.test/room/deep/x.mjs';
  assert.strictEqual(resolveServedImport('inner', referrer, map), 'https://site.test/i.mjs');
  assert.strictEqual(resolveServedImport('outer', referrer, map), 'https://site.test/o.mjs');
  assert.strictEqual(resolveServedImport('global', referrer, map), 'https://site.test/g.mjs');
  assert.strictEqual(resolveServedImport('global', 'https://site.test/roommate/x.mjs', map), 'https://site.test/g.mjs');
  assert.throws(() => resolveServedImport('blocked', referrer, map), /[Bb]locked/);
});
test('exact/prefix precedence and prefix backtracking are explicit', () => {
  const map = parseServedImportMap({imports: {'pkg/': '/vendor/', 'pkg/sub/': '/deep/', 'pkg/exact': '/exact.mjs'}}, 'https://site.test/');
  assert.strictEqual(resolveServedImport('pkg/sub/x.mjs?x#y', 'https://site.test/', map), 'https://site.test/deep/x.mjs?x#y');
  assert.strictEqual(resolveServedImport('pkg/exact', 'https://site.test/', map), 'https://site.test/exact.mjs');
  assert.throws(() => resolveServedImport('pkg/../escape', 'https://site.test/', map), /[Bb]acktracking/);
});

test('source maps remain detached from authored input',()=>{const value={imports:{x:'./x.mjs'},scopes:{'/r/':{x:'./r.mjs'}}};const before=JSON.stringify(value);const map=parseServedImportMap(value,'https://site.test/');value.imports.x='./changed.mjs';assert.strictEqual(map.imports.x,'https://site.test/x.mjs');assert.strictEqual(before.includes('changed'),false);});

test('non-special URL schemes allow exact matches but never prefix remapping', () => {
  const map = parseServedImportMap({imports: {'data:text/': '/wrong/', 'node:fs/': '/wrong/', 'data:text/exact': '/exact.mjs', 'https://other.test/pkg/': '/special/'}}, 'https://site.test/');
  assert.strictEqual(resolveServedImport('data:text/source', 'https://site.test/', map), 'data:text/source');
  assert.strictEqual(resolveServedImport('node:fs/promises', 'https://site.test/', map), 'node:fs/promises');
  assert.strictEqual(resolveServedImport('data:text/exact', 'https://site.test/', map), 'https://site.test/exact.mjs');
  assert.strictEqual(resolveServedImport('https://other.test/pkg/x.mjs', 'https://site.test/', map), 'https://site.test/special/x.mjs');
});
