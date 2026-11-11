import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { observeMediaDependencies } from '../scripts/media-dependency-observation.mjs';

const state = (unit, changes = {}) => Object.entries({ Id: unit, LoadState: 'loaded', ActiveState: 'active',
  SubState: 'running', Result: 'success', ExecMainCode: '0', ExecMainStatus: '0', ...changes })
  .map(([k, v]) => `${k}=${v}`).join('\n') + '\n';

test('only three fixed units and nonsecret properties are queried, without mutation', () => {
  const calls = [];
  const result = observeMediaDependencies((program, args, options) => {
    assert.equal(program, 'systemctl'); assert.deepEqual(args.slice(0, 3), ['--user', 'show', '--all']);
    assert.equal(args[3], '--property=Id,LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus');
    assert.equal(args.length, 5); assert.equal(options.timeout, 10_000); assert.equal(options.maxBuffer, 16 * 1024);
    calls.push(args.at(-1)); return { status: 0, stdout: state(args.at(-1)) };
  });
  assert.deepEqual(calls, ['561-group-credentials.service', 'media-studio-display.service', 'media-studio-browser.service']);
  assert.equal(result.kind, 'media-dependency-observation'); assert.equal(result.units.length, 3);
  assert.equal(result.units.every(unit => unit.observation === 'observed'), true);
  assert.doesNotMatch(JSON.stringify(result), /Environment|StatusText|ExecStart|journal/);
});
test('failed credential dependency and unaffected display control remain distinct observations', () => {
  const result = observeMediaDependencies((_program, args) => ({ status: 0,
    stdout: state(args.at(-1), args.at(-1).startsWith('561-group') ?
      { ActiveState: 'failed', SubState: 'failed', Result: 'exit-code', ExecMainCode: '1', ExecMainStatus: '1' } : {}) }));
  assert.equal(result.units[0].Result, 'exit-code'); assert.equal(result.units[0].ExecMainStatus, 1);
  assert.equal(result.units[1].ActiveState, 'active'); assert.equal(result.units[1].Result, 'success');
  assert.equal(Object.hasOwn(result, 'received'), false);
});
test('unknown, missing and failed observations never disclose raw values or hide successful peer observations', () => {
  let call = 0;
  const result = observeMediaDependencies((_program, args) => {
    if (call++ === 0) throw Error('INERT_PRIVATE_EXCEPTION');
    if (call === 2) return { status: 4, stdout: state(args.at(-1), { LoadState: 'not-found', Result: '', ExecMainStatus: '' }), stderr: 'INERT_PRIVATE_STDERR' };
    return { status: 0, stdout: state(args.at(-1), { Result: 'INERT_PRIVATE_VALUE', SubState: 'INERT_PRIVATE_VALUE', ExecMainStatus: 'INERT_PRIVATE_VALUE' }) };
  });
  assert.equal(result.units[0].observation, 'unavailable');
  assert.equal(result.units[1].LoadState, 'not-found'); assert.equal(result.units[1].queryStatus, 4);
  assert.equal(result.units[2].Result, null); assert.equal(result.units[2].SubState, null);
  assert.doesNotMatch(JSON.stringify(result), /INERT_PRIVATE/);
});
test('timeouts, extra properties and ambiguous unit identity produce bounded unavailable readings', () => {
  for (const produce of [() => ({ error: Error('INERT_PRIVATE_TIMEOUT') }),
    unit => ({ status: 0, stdout: state(unit) + 'Environment=INERT_PRIVATE_ENV\n' }),
    unit => ({ status: 0, stdout: state(unit) + `Id=${unit}\n` }),
    () => ({ status: 0, stdout: state('unrequested.service') })]) {
    const result = observeMediaDependencies((_program, args) => produce(args.at(-1)));
    assert.equal(result.units.every(unit => unit.observation === 'unavailable'), true);
    assert.doesNotMatch(JSON.stringify(result), /INERT_PRIVATE|unrequested/);
  }
});
test('existing local and remote media call sites use the preserving failure wrapper', () => {
  const source = readFileSync(new URL('../scripts/github-machine-release.scm', import.meta.url), 'utf8');
  assert.equal(source.match(/\(receive-media config store mode\)/g).length, 3); // definition and two call sites
  assert.match(source, /\(apply throw args\)/);
  assert.doesNotMatch(source, /journalctl|systemctl.*(?:restart|reset-failed)/);
});
