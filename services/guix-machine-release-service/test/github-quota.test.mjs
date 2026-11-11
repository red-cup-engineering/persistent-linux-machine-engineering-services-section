import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { githubQuota, rateLimitFailure } from '../scripts/github-reads.mjs';

test('quota observation uses the same gh read boundary and emits only allowlisted fields', () => {
  const actual = githubQuota('core', (program, args, options) => {
    assert.equal(program, 'gh'); assert.deepEqual(args, ['api', 'rate_limit']);
    assert.deepEqual(options, { allowFailure: true, timeout: 15_000, maxBuffer: 64 * 1024 });
    return { status: 0, stdout: JSON.stringify({ resources: { core: { remaining: 0, reset: 2000000000, extra: 'INERT_PRIVATE_FIELD' }, other: 'INERT_OTHER' } }) };
  });
  assert.deepEqual(actual, { resource: 'core', remaining: 0, reset: 2000000000 });
});
test('rate-limited failure becomes typed waiting with the observed reset, never an automatic retry', () => {
  let calls = 0;
  const error = rateLimitFailure('API rate limit exceeded', 'graphql', resource => {
    calls++; return { resource, remaining: 0, reset: 2000000000 };
  });
  assert.equal(calls, 1); assert.equal(error.code, 'GITHUB_RATE_LIMIT_WAITING');
  assert.deepEqual(error.waiting, { kind: 'github-rate-limit-waiting', resource: 'graphql', remaining: 0, reset: 2000000000, retryNotBefore: 2000000000 });
  assert.deepEqual(JSON.parse(error.message), error.waiting);
});
test('secondary or missing quota remains unresolved rather than guessing a reset or switching identity', () => {
  for (const observe of [() => { throw Error('INERT_FAILURE'); }, () => ({ remaining: 100, reset: 2000000000 })]) {
    const error = rateLimitFailure('secondary rate limit', 'graphql', observe);
    assert.equal(error.waiting.retryNotBefore, null); assert.doesNotMatch(error.message, /INERT_FAILURE/);
  }
  assert.equal(rateLimitFailure('authentication required', 'graphql', () => { throw Error('must not observe'); }), null);
});
test('malformed or denied observations fail without raw response or unrelated credential data', () => {
  for (const response of [{ status: 1, stderr: 'INERT_PRIVATE_ERROR', stdout: '{}' },
    { status: 0, stdout: 'INERT_INVALID_JSON' },
    { status: 0, stdout: JSON.stringify({ resources: { core: { remaining: -1, reset: 5 } } }) },
    { status: 0, stdout: JSON.stringify({ resources: { core: { remaining: 0, reset: 'tomorrow' } } }) }])
    assert.throws(() => githubQuota('core', () => response), error => error.message === 'GitHub quota observation unavailable');
  assert.throws(() => githubQuota('private-resource', () => { throw Error('must not execute'); }), /Unsupported/);
});
test('timeout or thrown observation errors are bounded and normalized even through the direct export', () => {
  for (const code of ['ETIMEDOUT', 'ENOBUFS', 'ENOENT']) {
    assert.throws(() => githubQuota('core', (_program, _args, options) => {
      assert.equal(options.timeout, 15_000); assert.equal(options.maxBuffer, 64 * 1024);
      throw Object.assign(new Error('INERT_PRIVATE_SUBPROCESS_DETAIL'), { code });
    }), error => error.message === 'GitHub quota observation unavailable');
  }
});
test('actual GitHub client turns one failed read into typed waiting and one same-port quota observation', t => {
  const root = mkdtempSync(join(tmpdir(), 'github-quota-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = join(root, 'calls');
  writeFileSync(join(root, 'gh'), `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');if(args.join(' ')==='api graphql --input -'){process.stderr.write('API rate limit exceeded: INERT_PRIVATE_DETAIL');process.exit(1)}if(args.join(' ')==='api rate_limit'){console.log(JSON.stringify({resources:{graphql:{remaining:0,reset:2000000000,extra:'INERT_PRIVATE_FIELD'}}}));process.exit(0)}process.exit(99);\n`, { mode: 0o755 });
  const module = new URL('../scripts/github-reads.mjs', import.meta.url).href;
  const code = `import {pullsForCommit} from ${JSON.stringify(module)};try{pullsForCommit('fixture/repo','${'a'.repeat(40)}');process.exitCode=99}catch(error){console.log(JSON.stringify({code:error.code,waiting:error.waiting}));}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', code],
    { encoding: 'utf8', env: { PATH: root }, timeout: 5_000, maxBuffer: 64 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const error = JSON.parse(result.stdout);
  assert.equal(error.code, 'GITHUB_RATE_LIMIT_WAITING'); assert.equal(error.waiting.reset, 2000000000);
  assert.doesNotMatch(result.stdout + result.stderr, /INERT_PRIVATE/);
  assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse),
    [['api', 'graphql', '--input', '-'], ['api', 'rate_limit']]);
});
