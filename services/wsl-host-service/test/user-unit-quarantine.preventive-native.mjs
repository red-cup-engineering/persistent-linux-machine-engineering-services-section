// Explicit integration fixtures: own harmless runtime units, never a declared
// production monitor/controller. No release profile, CDE effect or package build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { holdQuarantine, nativeQuarantinePort, planQuarantine, quarantineDeclaration, releaseQuarantine } from '../src/user-unit-quarantine.mjs';

assert.equal(process.env.WSL_TEST_PRIVATE_USER_MANAGER, '1', 'explicit private native fixture admission required');
assert.ok(process.env.WSL_TEST_NATIVE_RECEIPT, 'explicit fresh fixture custody receipt required');
test('real stopped preventive hold loads the negative condition and denies harmless runtime-unit reentry', () => {
  const root = mkdtempSync(join(tmpdir(), 'wsl-preventive-native-'));
  const unit = 'wsl-preventive-test-' + process.pid + '-' + root.split('-').at(-1).toLowerCase() + '.service';
  const runtime = process.env.XDG_RUNTIME_DIR;
  assert.equal(runtime, '/run/user/' + process.getuid(), 'native runtime must belong to the executing user');
  const link = join(runtime, 'systemd/user', unit), source = join(root, unit), sentinel = join(root, 'ran');
  const sectionRoot = join(root, 'fixture-services-section');
  const intent = { phase: 'intent-before-native-effects', root, unit, link, source, sentinel, sectionRoot,
    guard: join(homedir(), '.config/systemd/user', unit + '.d', '90-wsl-host-quarantine-' + unit.slice(0, -8) + '.conf'),
    productionUnitsTouched: false };
  writeFileSync(process.env.WSL_TEST_NATIVE_RECEIPT, JSON.stringify(intent, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  mkdirSync(sectionRoot, { mode: 0o700 });
  const parameters = { linux: { userUnitQuarantine: { id: unit.slice(0, -8), unit, uid: process.getuid(), home: homedir(), sectionRoot,
    origin: 'source-owned disposable preventive quarantine native fixture', captureMode: 'stopped-no-resident', releasePolicy: 'hold-only', expected: {} } } };
  let uncertainNative = false;
  const run = (...args) => {
    try { return execFileSync('/usr/bin/systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 }); }
    catch (error) { if (error.signal || error.killed || error.status === null) uncertainNative = true; throw error; }
  };
  let linkAttempted = false, linked = false, q;
  try {
    assert.equal(existsSync(link), false, 'never adopt an existing runtime link');
    const prior = run('show', unit, '--property=LoadState,MainPID,ControlPID,Job');
    assert.match(prior, /^LoadState=not-found$/m, 'never adopt a loaded unit');
    writeFileSync(source, '[Unit]\nDescription=Disposable preventive quarantine receiving\n[Service]\nType=oneshot\nExecStart=/usr/bin/touch ' + sentinel + '\n', { mode: 0o600 });
    linkAttempted = true; run('link', '--runtime', source); linked = true;
    run('daemon-reload'); run('start', unit);
    assert.equal(existsSync(sentinel), true, 'unheld unit must actually execute'); unlinkSync(sentinel);
    const native = nativeQuarantinePort({ budgetMs: 60000 }), before = native.unit(unit);
    parameters.linux.userUnitQuarantine.expected = { bootId: native.boot(), execStart: before.ExecStart };
    q = quarantineDeclaration(parameters);
    assert.equal(existsSync(dirname(q.guard)), false, 'never adopt an existing fixture guard directory');
    assert.equal(holdQuarantine(parameters, native).status, 'held');
    const bytes = readFileSync(q.marker, 'utf8');
    assert.equal(planQuarantine(parameters, native).status, 'held');
    assert.equal(holdQuarantine(parameters, native).unchanged, true);
    run('start', unit);
    assert.equal(existsSync(sentinel), false, 'loaded negative condition must prevent command execution');
    assert.match(run('show', unit, '--property=ConditionResult'), /^ConditionResult=no$/m);
    assert.throws(() => releaseQuarantine(parameters, native), /hold-only policy explicitly refuses release/);
    assert.equal(readFileSync(q.marker, 'utf8'), bytes); assert.equal(existsSync(q.released), false);
  } finally {
    // A failed/unknown unit observation deliberately retains fixture custody.
    // No stop/kill operation or recursive removal can hide an unknown writer.
    assert.equal(uncertainNative, false, 'unknown native outcome retains all fixture custody');
    assert.ok(!linkAttempted || linked, 'unreceived link attempt retains all fixture custody');
    if (linked) {
      const terminal = run('show', unit, '--property=MainPID,ControlPID,Job,ActiveState');
      assert.match(terminal, /^MainPID=0$/m); assert.match(terminal, /^ControlPID=0$/m);
      assert.match(terminal, /^Job=(?:0)?$/m); assert.match(terminal, /^ActiveState=(?:inactive|failed)$/m);
      assert.equal(lstatSync(link).isSymbolicLink(), true); assert.equal(readlinkSync(link), source);
      if (q && existsSync(q.guard)) {
        assert.equal(lstatSync(q.guard).isFile(), true); assert.equal(readFileSync(q.guard, 'utf8'), q.guardText);
        unlinkSync(q.guard); rmdirSync(dirname(q.guard));
      }
      unlinkSync(link); run('daemon-reload');
      assert.match(run('show', unit, '--property=LoadState'), /^LoadState=not-found$/m);
    }
    rmSync(root, { recursive: true });
    assert.equal(existsSync(root), false); assert.equal(existsSync(link), false);
    writeFileSync(process.env.WSL_TEST_NATIVE_RECEIPT, JSON.stringify({ ...intent, phase: 'terminal-and-retired',
      rootAbsent: !existsSync(root), linkAbsent: !existsSync(link), guardAbsent: !existsSync(intent.guard) }, null, 2) + '\n', { mode: 0o600 });
  }
});

test('real frozen preventive custody preserves its resident and still denies a later fixture restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'wsl-frozen-preventive-native-'));
  const unit = 'wsl-frozen-test-' + process.pid + '-' + root.split('-').at(-1).toLowerCase() + '.service';
  const runtime = process.env.XDG_RUNTIME_DIR;
  assert.equal(runtime, '/run/user/' + process.getuid());
  const link = join(runtime, 'systemd/user', unit), source = join(root, unit), sectionRoot = join(root, 'fixture-services-section');
  const receiptPath = process.env.WSL_TEST_NATIVE_RECEIPT + '.frozen.json';
  const intent = { phase: 'intent-before-native-effects', root, unit, link, source, sectionRoot,
    guard: join(homedir(), '.config/systemd/user', unit + '.d', '90-wsl-host-quarantine-' + unit.slice(0, -8) + '.conf'), productionUnitsTouched: false };
  writeFileSync(receiptPath, JSON.stringify(intent, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  mkdirSync(sectionRoot, { mode: 0o700 });
  let uncertainNative = false, linkAttempted = false, linked = false, q;
  const run = (...args) => {
    try { return execFileSync('/usr/bin/systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 }); }
    catch (error) { if (error.signal || error.killed || error.status === null) uncertainNative = true; throw error; }
  };
  try {
    assert.equal(existsSync(link), false);
    assert.match(run('show', unit, '--property=LoadState'), /^LoadState=not-found$/m);
    writeFileSync(source, '[Unit]\nDescription=Disposable frozen preventive receiving\n[Service]\nType=simple\nExecStart=/usr/bin/sleep infinity\n', { mode: 0o600 });
    linkAttempted = true; run('link', '--runtime', source); linked = true;
    run('daemon-reload'); run('start', unit); run('freeze', unit);
    const native = nativeQuarantinePort({ budgetMs: 60000 }), before = native.unit(unit), pid = Number(before.MainPID);
    assert.ok(pid > 0); assert.equal(before.FreezerState, 'frozen');
    assert.match(readFileSync('/sys/fs/cgroup' + before.ControlGroup + '/cgroup.events', 'utf8'), /^frozen 1$/m);
    const expected = { pid, invocationId: before.InvocationID, controlGroup: before.ControlGroup, bootId: native.boot(), process: native.process(pid) };
    const parameters = { linux: { userUnitQuarantine: { id: unit.slice(0, -8), unit, uid: process.getuid(), home: homedir(), sectionRoot,
      origin: 'source-owned disposable frozen preventive native fixture', captureMode: 'frozen-resident', releasePolicy: 'hold-only', expected } } };
    q = quarantineDeclaration(parameters);
    assert.equal(existsSync(dirname(q.guard)), false);
    assert.equal(holdQuarantine(parameters, native).status, 'held');
    assert.equal(holdQuarantine(parameters, native).unchanged, true);
    const bytes = readFileSync(q.marker, 'utf8'), marker = JSON.parse(bytes), received = native.unit(unit);
    assert.equal(marker.releasePolicy, 'hold-only'); assert.equal(Object.hasOwn(marker, 'captureMode'), false);
    assert.equal(Object.hasOwn(marker, 'effectDependencies'), false);
    assert.deepEqual(native.process(pid), expected.process); assert.equal(received.MainPID, String(pid)); assert.equal(received.FreezerState, 'frozen');
    assert.equal(planQuarantine(parameters, native).status, 'held');
    assert.throws(() => releaseQuarantine(parameters, native), /hold-only policy explicitly refuses release/);
    assert.equal(readFileSync(q.marker, 'utf8'), bytes); assert.equal(existsSync(q.released), false);
    intent.nativeFrozenReceiving = { pid, invocationId: before.InvocationID, controlGroup: before.ControlGroup, process: expected.process,
      markerSha256: shaForFixture(bytes), loadedConditions: received.conditions, kernelFrozen: true };
    // Stop only this own harmless sleeping fixture, then prove its persistent
    // condition prevents a fresh invocation. Production holds never stop/thaw.
    run('stop', unit); run('start', unit);
    assert.match(run('show', unit, '--property=ConditionResult'), /^ConditionResult=no$/m);
    assert.equal(native.unit(unit).MainPID, '0');
    assert.throws(() => planQuarantine(parameters, native), /main PID|frozen resident/);
    assert.equal(readFileSync(q.marker, 'utf8'), bytes);
  } finally {
    assert.equal(uncertainNative, false, 'unknown native outcome retains fixture custody');
    assert.ok(!linkAttempted || linked, 'unreceived link attempt retains fixture custody');
    if (linked) {
      run('stop', unit);
      const terminal = run('show', unit, '--property=MainPID,ControlPID,Job,ActiveState');
      assert.match(terminal, /^MainPID=0$/m); assert.match(terminal, /^ControlPID=0$/m);
      assert.match(terminal, /^Job=(?:0)?$/m); assert.match(terminal, /^ActiveState=(?:inactive|failed)$/m);
      assert.equal(lstatSync(link).isSymbolicLink(), true); assert.equal(readlinkSync(link), source);
      if (q && existsSync(q.guard)) { assert.equal(readFileSync(q.guard, 'utf8'), q.guardText); unlinkSync(q.guard); rmdirSync(dirname(q.guard)); }
      unlinkSync(link); run('daemon-reload'); assert.match(run('show', unit, '--property=LoadState'), /^LoadState=not-found$/m);
    }
    rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); assert.equal(existsSync(link), false);
    writeFileSync(receiptPath, JSON.stringify({ ...intent, phase: 'terminal-and-retired', rootAbsent: true, linkAbsent: true, guardAbsent: !existsSync(intent.guard) }, null, 2) + '\n', { mode: 0o600 });
  }
});
function shaForFixture(text) { return createHash('sha256').update(text).digest('hex'); }
