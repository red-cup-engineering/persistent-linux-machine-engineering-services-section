// Explicit own-unit native receiving. Never selects a production controller.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { completeQuarantine, holdQuarantine, nativeQuarantinePort, quarantineDeclaration } from '../src/user-unit-quarantine.mjs';

assert.equal(process.env.WSL_TEST_PRIVATE_USER_MANAGER, '1', 'explicit own-unit receiving required');
const receiving = resolve(process.env.WSL_TEST_NATIVE_RECEIPT || '');
assert.ok(receiving.includes('/data/'), 'source-owned fixture receipt required');
assert.equal(existsSync(receiving), false, 'never replace an original fixture receipt');
const parent = dirname(receiving);
const root = mkdtempSync(join(parent, 'completion-native-'));
const unit = 'wsl-complete-' + process.pid + '-' + root.split('-').at(-1).toLowerCase() + '.service';
const runtimeLink = join('/run/user/' + process.getuid(), 'systemd/user', unit);
const source = join(root, unit), sectionRoot = join(root, 'fixture-services-section');
const run = (...args) => execFileSync('/usr/bin/systemctl', ['--user', ...args], {
  encoding: 'utf8', timeout: 15000, maxBuffer: 65536,
});
const intent = { type: 'WslQuarantineCompletionNativeReceiving', phase: 'intent', unit, root, source, runtimeLink, productionUnitsTouched: false };
writeFileSync(receiving, JSON.stringify(intent, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
let linked = false, q, completed = false;
try {
  assert.equal(existsSync(runtimeLink), false);
  assert.match(run('show', unit, '--property=LoadState'), /^LoadState=not-found$/m);
  mkdirSync(sectionRoot, { mode: 0o700 });
  writeFileSync(source, '[Unit]\nDescription=Own quarantine completion fixture\n[Service]\nType=simple\nRestart=always\nRestartSec=2\nRuntimeMaxSec=120\nExecStart=/usr/bin/sleep infinity\n', { mode: 0o600 });
  run('link', '--runtime', source); linked = true;
  run('daemon-reload'); run('start', unit); run('freeze', unit);
  const native = nativeQuarantinePort({ budgetMs: 60000 }), before = native.unit(unit), pid = Number(before.MainPID);
  assert.ok(pid > 0);
  assert.equal(before.FreezerState, 'frozen');
  assert.match(readFileSync('/sys/fs/cgroup' + before.ControlGroup + '/cgroup.events', 'utf8'), /^frozen 1$/m);
  const expected = { pid, invocationId: before.InvocationID, controlGroup: before.ControlGroup,
    bootId: native.boot(), process: native.process(pid) };
  const parameters = { linux: { userUnitQuarantine: { id: unit.slice(0, -8), unit, uid: process.getuid(),
    home: homedir(), sectionRoot, origin: 'source-owned explicit completion native receiving',
    captureMode: 'frozen-resident', releasePolicy: 'hold-only', expected } } };
  q = quarantineDeclaration(parameters);
  assert.equal(existsSync(dirname(q.guard)), false);
  assert.equal(holdQuarantine(parameters, native).status, 'held');
  const originalMarker = readFileSync(q.marker, 'utf8');
  // Receive an actual interrupted pre-fix retirement: the old owner retained
  // its marker/journal after KILL while Restart=always was still configured.
  writeFileSync(q.completed, JSON.stringify({ type: 'WslUserUnitQuarantineCompletion', version: 1,
    id: q.id, unit: q.unit, markerText: originalMarker,
    markerSha256: createHash('sha256').update(originalMarker).digest('hex'),
    phase: 'retiring', requestedAt: new Date().toISOString(), started: false,
    externalEffectsReconciled: false }) + '\n', { flag: 'wx', mode: 0o600 });
  run('kill', '--kill-whom=all', '--signal=KILL', unit);
  let interrupted;
  for (let attempt = 0; attempt < 50; attempt++) {
    interrupted = native.unit(unit);
    if (interrupted.MainPID === '0' && native.cohortTerminal(expected.controlGroup)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  assert.equal(interrupted.MainPID, '0');
  assert.equal(interrupted.FreezerState, 'frozen');
  assert.equal(interrupted.Restart, 'always');
  assert.equal(native.cohortTerminal(expected.controlGroup), true);
  intent.interrupted = interrupted;
  const outcome = completeQuarantine(parameters, native);
  completed = outcome.status === 'completed';
  assert.equal(completed, true);
  assert.equal(outcome.started, false);
  assert.equal(outcome.externalEffectsReconciled, false);
  const after = native.unit(unit);
  assert.equal(after.MainPID, '0');
  assert.equal(after.ControlPID, '0');
  assert.ok(['inactive', 'failed'].includes(after.ActiveState));
  assert.equal(native.cohortTerminal(expected.controlGroup), true);
  assert.equal(existsSync('/proc/' + pid), false);
  assert.equal(existsSync(q.marker), false);
  assert.equal(existsSync(q.guard), false);
  const recorded = JSON.parse(readFileSync(q.completed));
  assert.equal(recorded.markerText, originalMarker);
  assert.equal(recorded.phase, 'completed');
  assert.equal(completeQuarantine(parameters, native).unchanged, true);
  writeFileSync(receiving, JSON.stringify({ ...intent, phase: 'received', expected, terminal: after, outcome }, null, 2) + '\n', { mode: 0o600 });
} finally {
  // A failed test retains its captured intent and manager state for its owner;
  // RuntimeMaxSec independently bounds the harmless sleeping fixture.
  if (completed && linked) {
    assert.equal(realpathSync(runtimeLink), source);
    const cleanupState = run('show', unit, '--property=ActiveState');
    if (/^ActiveState=failed$/m.test(cleanupState)) run('reset-failed', unit);
    unlinkSync(runtimeLink);
    if (q && existsSync(dirname(q.guard))) rmdirSync(dirname(q.guard));
    run('daemon-reload');
    assert.match(run('show', unit, '--property=LoadState'), /^LoadState=not-found$/m);
    const prior = JSON.parse(readFileSync(receiving));
    rmSync(root, { recursive: true });
    writeFileSync(receiving, JSON.stringify({ ...prior, phase: 'received-and-retired', rootAbsent: !existsSync(root), runtimeLinkAbsent: !existsSync(runtimeLink) }, null, 2) + '\n', { mode: 0o600 });
  }
}
console.log(JSON.stringify({ passed: completed, receipt: receiving, productionUnitsTouched: false }));
