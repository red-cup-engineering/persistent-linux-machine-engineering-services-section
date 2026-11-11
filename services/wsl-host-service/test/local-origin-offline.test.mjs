import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {servedPageEntries, offlineChildFailure, nativeProcessDiagnostic} from '../scripts/qualify-local-origin-offline.mjs';
import {resolveServedImport} from '../src/served-importmap.mjs';

test('actual served map/base and inline/external entries keep their browser referrers', () => {
  const html = '<base href="/app/"><script type="importmap">{"imports":{"pkg":"/vendor/pkg.mjs"}}</script>'
    + '<script\n type="module" src="./entry.mjs"></script><script type="module">import "pkg";</script>';
  const page = servedPageEntries(html, 'https://site.test/');
  assert.equal(page.base, 'https://site.test/app/');
  assert.equal(page.entries[0].url, 'https://site.test/app/entry.mjs');
  assert.equal(page.entries[1].referrer, 'https://site.test/app/');
  assert.equal(page.entries[1].source, 'import "pkg";');
  assert.equal(resolveServedImport('pkg', page.entries[1].referrer, page.map), 'https://site.test/vendor/pkg.mjs');
});
test('ambiguous map carriers refuse and ordinary comments create no entries', () => {
  assert.throws(() => servedPageEntries('<script type="module"></script><script type="importmap">{}</script>', 'https://site.test/'));
  assert.throws(() => servedPageEntries('<script type="importmap">{}</script><script type="importmap">{}</script><script type="module"></script>', 'https://site.test/'));
  assert.throws(() => servedPageEntries('<!-- <script type="module" src="/unused.mjs"></script> -->', 'https://site.test/'));
});
test('the actual CLI refuses an invalid origin before native/network entrances', () => {
  const result = spawnSync(process.execPath, [new URL('../scripts/qualify-local-origin-offline.mjs', import.meta.url).pathname, '--origin=http://site.test', '--uid=1000'], {encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).stage, 'canonical-https-origin');
  assert.deepEqual(offlineChildFailure(result.stderr), {kind: 'wsl-local-origin-offline-unreceived',
    stage: 'canonical-https-origin', name: 'Error', nativeProcess: {signal: null, errorCode: null}});
});
test('native process facts and classified child stages survive without raw payloads', () => {
  const missing = spawnSync('/wsl-offline-readonly-unreceived-native-' + process.pid, []);
  assert.equal(missing.error.code, 'ENOENT');
  assert.deepEqual(nativeProcessDiagnostic(missing), {signal: null, errorCode: 'ENOENT'});
  const value = offlineChildFailure('native warning\n' + JSON.stringify({kind: 'wsl-local-origin-offline-unreceived',
    stage: 'trusted-local-response', name: 'SyntaxError', message: 'unreceived-credential-and-body',
    nativeProcess: {signal: 'SIGTERM', errorCode: 'ENOENT', message: 'unreceived-credential-and-body'}}));
  assert.deepEqual(value, {kind: 'wsl-local-origin-offline-unreceived', stage: 'trusted-local-response',
    name: 'SyntaxError', nativeProcess: {signal: 'SIGTERM', errorCode: 'ENOENT'}});
  assert(!JSON.stringify(value).includes('credential'));
  const unknown = offlineChildFailure(JSON.stringify({kind: 'wsl-local-origin-offline-unreceived',
    stage: 'credential-stage', name: 'credential-name', nativeProcess: {signal: 'credential-signal', errorCode: 'credential-code'}}));
  assert.deepEqual(unknown, {kind: 'wsl-local-origin-offline-unreceived', stage: 'unclassified-client',
    name: 'Error', nativeProcess: {signal: null, errorCode: null}});
});
test('the actual CLI recognizes numeric option names before provider receiving', () => {
  const result = spawnSync(process.execPath, [new URL('../scripts/qualify-local-origin-offline.mjs', import.meta.url).pathname,
    '--origin=https://site.test', '--uid=1000', '--parser-module=/unreceived-parser', '--parser-sha256=bad'], {encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(offlineChildFailure(result.stderr).stage, 'owner-or-parser-selection');
});
