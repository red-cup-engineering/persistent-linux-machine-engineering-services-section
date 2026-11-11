import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepare } from '../scripts/prepare-sources.mjs';
import { credentialBaseline, credentialDeclaration, credentialUnitReading,
  observeCredentialUnit, verifyCredentialExecution, credentialRefusal } from '../scripts/credential-unit-receiving.mjs';

const unit = '561-group-credentials.service';
const boot = '12345678-abcd-1234-abcd-123456789012';
const interpreter = '/gnu/store/aaa-node-24/bin/node';
const program = '/gnu/store/bbb-machine/node_modules/@red-cup-engineering/credential-custody-service/scripts/render-host.mjs';
const command = `${interpreter} ${program}`;
const declaration = { unit, interpreter, program, command, renderer: { commit: 'a'.repeat(40) } };
const fields = (changes = {}) => ({ Id: unit, LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead',
  Type: 'oneshot', Result: 'success', ExecMainCode: '1', ExecMainStatus: '0', NeedDaemonReload: 'no',
  ExecMainStartTimestampMonotonic: '200', ExecMainExitTimestampMonotonic: '250', InvocationID: '',
  ExecStart: `{ path=${interpreter} ; argv[]=${command} ; ignore_errors=no ; start_time=Thu 2026-10-08 20:00:00 UTC ; stop_time=Thu 2026-10-08 20:00:01 UTC ; pid=123 ; code=exited ; status=0 }`, ...changes });
const before = credentialBaseline(declaration, fields({ ExecMainStartTimestampMonotonic: '100', InvocationID: 'a'.repeat(32) }), boot);

test('first installation has a loaded zero-history baseline, then requires a positive completed invocation', () => {
  const empty = fields({ ExecMainStartTimestampMonotonic: '0', ExecMainExitTimestampMonotonic: '0', InvocationID: '' });
  const initial = credentialBaseline(declaration, empty, boot);
  assert.equal(initial.started, '0'); assert.equal(initial.invocationId, null);
  assert.equal(verifyCredentialExecution(declaration, initial, fields(), boot).status, 'received');
  assert.throws(() => verifyCredentialExecution(declaration, initial, empty, boot), /fresh completed invocation/);
});

test('inactive oneshot with retained fresh successful execution is admitted without inventing an invocation ID', () => {
  const result = verifyCredentialExecution(declaration, before, fields(), boot);
  assert.equal(result.status, 'received'); assert.equal(result.InvocationID, null);
  assert.equal(result.commandMatches, true); assert.match(result.commandSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.renderer.commit, declaration.renderer.commit);
  assert.equal(JSON.stringify(result).includes('argv'), false);
});
test('retained invocation ID must change and is reported exactly', () => {
  const fresh = fields({ InvocationID: 'b'.repeat(32) });
  assert.equal(verifyCredentialExecution(declaration, before, fresh, boot).InvocationID, 'b'.repeat(32));
  assert.throws(() => verifyCredentialExecution(declaration, before, fields({ InvocationID: before.invocationId }), boot), /identity did not advance/);
});
test('old, forgotten, running and reversed timestamps cannot report success', () => {
  for (const changes of [{ ExecMainStartTimestampMonotonic: '100' }, { ExecMainStartTimestampMonotonic: '0' },
    { ExecMainStartTimestampMonotonic: undefined }, { ExecMainExitTimestampMonotonic: '0' },
    { ExecMainExitTimestampMonotonic: '199' }, { ActiveState: 'activating', SubState: 'start' }])
    assert.throws(() => verifyCredentialExecution(declaration, before, fields(changes), boot));
  assert.throws(() => verifyCredentialExecution(declaration, before, fields(), '87654321-abcd-1234-abcd-123456789012'), /boot identity/);
});
test('failed, skipped, unknown or stale-daemon execution is refused', () => {
  for (const changes of [{ Result: 'exit-code' }, { Result: 'success', ExecMainStatus: '1' }, { ExecMainCode: '0' },
    { LoadState: 'not-found' }, { Type: 'simple' }, { NeedDaemonReload: 'yes' }, { InvocationID: 'malformed' }])
    assert.throws(() => verifyCredentialExecution(declaration, before, fields(changes), boot));
});
test('foreign or additional executed arguments never enter a receipt or error', () => {
  const secretSentinel = 'INERT_ARGUMENT_MUST_NOT_ESCAPE';
  for (const ExecStart of [fields().ExecStart.replace(program, '/gnu/store/old-machine/renderer.mjs'),
    fields().ExecStart.replace(command, `${command} ${secretSentinel}`), fields().ExecStart + fields().ExecStart]) {
    assert.throws(() => verifyCredentialExecution(declaration, before, fields({ ExecStart }), boot), error =>
      /executed command/.test(error.message) && !error.message.includes(secretSentinel));
  }
});
test('only fixed read-only allowlisted systemctl fields are requested, and failures are value-free', () => {
  const result = observeCredentialUnit((exe, args, options) => {
    assert.equal(exe, 'systemctl'); assert.deepEqual(args.slice(0, 3), ['--user', 'show', '--all']);
    assert.equal(args.at(-1), unit); assert.equal(args.length, 5);
    assert.doesNotMatch(args[3], /Environment|StatusText|journal/);
    assert.equal(options.timeout, 10_000);
    return { status: 0, stdout: Object.entries(fields()).map(([k, v]) => `${k}=${v}`).join('\n') + '\n' };
  });
  assert.deepEqual(result, fields());
  assert.throws(() => observeCredentialUnit(() => ({ status: 1, stderr: 'INERT_PRIVATE_OUTPUT' })), error =>
    !error.message.includes('INERT_PRIVATE_OUTPUT'));
  assert.throws(() => observeCredentialUnit(() => ({ status: 0, stdout: 'Environment=INERT_PRIVATE_OUTPUT\n' })), /invalid observation/);
});

function fixture(t, configured = true) {
  const root = mkdtempSync(join(tmpdir(), 'credential-receiving-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => { const target = join(root, path); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, value); };
  const pkg = '@red-cup-engineering/credential-custody-service';
  const repository = 'red-cup-engineering/computer-data-services-section', commit = 'a'.repeat(40);
  const sources = { repositories: [{ repository, commit }], packages: [{ name: pkg, repository, commit, path: 'services/credential-custody-service' }] };
  write('.controller/machine.json', JSON.stringify({ unit: 'main.service', auxiliaryUnits: configured ? [unit] : [] }));
  write('.metadata/sources.json', JSON.stringify(sources));
  write(`.guix-systemd/${unit}`, `[Service]\nType=oneshot\nExecStart=${interpreter} ${root}/node_modules/${pkg}/scripts/render-host.mjs\n`);
  write('.guix-systemd/main.service', `[Unit]\nRequires=${unit}\nAfter=network-online.target ${unit}\n`);
  write(`packages/${pkg.replaceAll('/', '__')}/scripts/render-host.mjs`, '// inert source bytes, never executed\n');
  mkdirSync(join(root, 'node_modules/@red-cup-engineering'), { recursive: true });
  symlinkSync(join(root, 'packages', pkg.replaceAll('/', '__')), join(root, 'node_modules', pkg));
  return { root, write, sources };
}
test('source declaration binds exact admitted provider, bytes, immutable command and existing dependency', t => {
  const { root, write, sources } = fixture(t);
  const result = credentialDeclaration(root);
  assert.equal(result.renderer.commit, 'a'.repeat(40));
  assert.match(result.renderer.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.renderer.path, 'services/credential-custody-service/scripts/render-host.mjs');
  sources.packages[0].commit = 'b'.repeat(40);
  write('.metadata/sources.json', JSON.stringify(sources));
  assert.throws(() => credentialDeclaration(root), /identity is not admitted/);
  sources.packages[0].commit = 'a'.repeat(40);
  write('.metadata/sources.json', JSON.stringify(sources));
  write('.guix-systemd/main.service', '[Unit]\nAfter=network-online.target\n');
  assert.throws(() => credentialDeclaration(root), /activation dependency/);
});
test('real immutable Git extraction binds reported renderer blob despite changed checkout bytes', t => {
  const { root, write } = fixture(t);
  const repository = join(root, 'source'); mkdirSync(repository);
  const git = (...args) => {
    const r = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git('init', '--initial-branch=main'); git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid'); git('config', 'commit.gpgsign', 'false');
  const pkg = '@red-cup-engineering/credential-custody-service', path = 'services/credential-custody-service';
  write(`source/${path}/package.json`, JSON.stringify({ name: pkg, version: '0.1.0' }));
  write(`source/${path}/scripts/render-host.mjs`, '// exact committed inert renderer\n');
  git('add', '.'); git('commit', '-m', 'immutable renderer fixture');
  const commit = git('rev-parse', 'HEAD'), blob = git('rev-parse', `HEAD:${path}/scripts/render-host.mjs`);
  write(`source/${path}/scripts/render-host.mjs`, '// changed checkout must never be selected\n');
  prepare({ repositories: [{ repository: 'fixture/data', directory: repository, commit }], entries: [pkg], output: root });
  write('.metadata/sources.json', readFileSync(join(root, 'sources.json')));
  const evidence = credentialDeclaration(root);
  assert.equal(evidence.renderer.commit, commit); assert.equal(evidence.renderer.gitBlob, blob);
  assert.equal(readFileSync(evidence.program, 'utf8'), '// exact committed inert renderer\n');
  rmSync(join(root, 'node_modules', pkg));
  const foreign = join(root, 'foreign'); mkdirSync(join(foreign, 'scripts'), { recursive: true });
  writeFileSync(join(foreign, 'scripts/render-host.mjs'), '// wrong provider\n');
  symlinkSync(foreign, join(root, 'node_modules', pkg));
  assert.throws(() => credentialDeclaration(root), /alias differs/);
});
test('undeclared machines do not observe credentials or falsely claim receiving', t => {
  const { root } = fixture(t, false);
  const ports = { observe() { throw Error('must not observe'); }, bootIdentity() { throw Error('must not read'); } };
  const baseline = credentialUnitReading(root, 'baseline', null, ports);
  assert.deepEqual(baseline, { status: 'not-declared' });
  assert.deepEqual(credentialUnitReading(root, 'verify', baseline, ports), baseline);
});
test('receiver brackets its existing restart after daemon reload and gates before success; rollback remains in place', () => {
  const source = readFileSync(new URL('../scripts/receive.scm', import.meta.url), 'utf8');
  // Reload and restart go through the machine's supervisor (systemd or Shepherd); a call site is
  // any use that is not the procedure's own definition.
  const call = (name) => new RegExp(`(?<!define )\\(${name} config unit\\)`, 'g');
  const reload = source.search(call('units-reload!'));
  const baseline = source.indexOf('(set! credential-baseline');
  const restart = source.search(call('unit-restart!'));
  const verify = source.indexOf('(set! credential-reading');
  const success = source.indexOf('(receipt receipts "success"');
  assert.ok(reload > 0 && reload < baseline && baseline < restart && restart < verify && verify < success);
  assert.ok(source.includes('("credentialUnit" . ,credential-reading)'));
  assert.ok(source.indexOf('(when (and previous stopped?)') > success);
  assert.equal(source.match(call('unit-restart!')).length, 2); // existing switch and recovery only
});


test('credential refusals distinguish fixed gates without exposing exception details', () => {
  const refused = thunk => { try { thunk(); assert.fail('expected refusal'); } catch (error) { return credentialRefusal(error); } };
  for (const [changes, reason] of [
    [{ Result: 'INERT_PRIVATE_RESULT' }, 'completed-oneshot-unproven'],
    [{ ExecMainStartTimestampMonotonic: '100' }, 'fresh-invocation-unproven'],
    [{ InvocationID: before.invocationId }, 'invocation-identity-unproven'],
    [{ ExecStart: 'INERT_PRIVATE_COMMAND' }, 'executed-command-unavailable'],
    [{ ExecStart: fields().ExecStart.replace(`path=${interpreter}`, 'path=/INERT_PRIVATE_INTERPRETER') }, 'executed-interpreter-mismatch'],
    [{ ExecStart: fields().ExecStart.replace(`argv[]=${command}`, 'argv[]=INERT_PRIVATE_ARGUMENT') }, 'executed-arguments-mismatch'],
  ]) {
    assert.deepEqual(refused(() => verifyCredentialExecution(declaration, before, fields(changes), boot)),
      { kind: 'credential-unit-receiving', status: 'refused', reason });
  }
  assert.equal(refused(() => observeCredentialUnit(() => ({ status: 1, stderr: 'INERT_PRIVATE_STDERR' }))).reason,
    'observation-unavailable');
  for (const error of [Error('INERT_PRIVATE_MESSAGE'),
    Object.assign(Error('credential unit receiving: baseline unavailable'), { reason: 'baseline-unavailable' }),
    { reason: 'INERT_PRIVATE_REASON', stack: 'INERT_PRIVATE_STACK' }, null, 'INERT_PRIVATE_STRING']) {
    assert.deepEqual(credentialRefusal(error), { kind: 'credential-unit-receiving', status: 'refused', reason: 'unavailable' });
    assert.doesNotMatch(JSON.stringify(credentialRefusal(error)), /INERT_PRIVATE/);
  }
});
test('credential CLI emits a bounded refusal and retains failing exit status', () => {
  const result = spawnSync(process.execPath,
    [new URL('../scripts/credential-unit-receiving.mjs', import.meta.url).pathname, '/not-store/INERT_PRIVATE_ARGUMENT', 'verify', 'INERT_PRIVATE_BASELINE'],
    { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { kind: 'credential-unit-receiving', status: 'refused', reason: 'immutable-candidate-required' });
  assert.doesNotMatch(result.stderr, /INERT_PRIVATE|stack|at file/);
});
