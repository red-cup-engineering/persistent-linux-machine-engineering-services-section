import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeQuarantine, holdQuarantine, planQuarantine, quarantineDeclaration, releaseQuarantine } from '../src/user-unit-quarantine.mjs';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'wsl-completion-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sectionRoot = join(home, 'operator-services-section');
  mkdirSync(sectionRoot, { mode: 0o700 });
  const expected = { pid: 101, invocationId: 'a'.repeat(32), controlGroup: '/user.slice/publisher.service', bootId: 'boot',
    process: { pid: 101, startTime: '123', argv: ['/gnu/store/old/bin/node', '/gnu/store/old/publisher.mjs'], cwd: '/gnu/store/old', cgroup: '0::/user.slice/publisher.service' } };
  const parameters = { linux: { userUnitQuarantine: { id: 'publisher-repair', unit: 'publisher.service',
    uid: process.getuid(), home, sectionRoot, origin: 'https://github.com/example/registry/issues/17',
    releasePolicy: 'hold-only', expected } } };
  const q = quarantineDeclaration(parameters);
  const otherGuard = join(home, '.config/systemd/user/publisher.service.d/99-controller-pending.conf');
  const unit = { Id: q.unit, LoadState: 'loaded', MainPID: '101', ControlPID: '0', Job: '',
    InvocationID: expected.invocationId, ControlGroup: expected.controlGroup,
    ActiveState: 'active', SubState: 'running', FreezerState: 'frozen',
    ExecStart: '{ path=/gnu/store/old/bin/node ; argv[]=/gnu/store/old/bin/node /gnu/store/old/publisher.mjs ; }',
    DropInPaths: '', Restart: 'always', conditions: [] };
  const effects = [];
  let populated = true;
  const stopped = () => { Object.assign(unit, { MainPID: '0', ControlPID: '0', Job: '',
    ActiveState: 'inactive', SubState: 'dead', FreezerState: 'running', ControlGroup: '' }); populated = false; };
  const native = {
    uid: () => process.getuid(), unit: () => structuredClone(unit), boot: () => expected.bootId,
    process: () => structuredClone(expected.process),
    cohortTerminal: group => group === expected.controlGroup && !populated,
    reload: () => {
      effects.push('reload');
      unit.DropInPaths = [otherGuard, ...(existsSync(q.guard) ? [q.guard] : []), ...(existsSync(q.completionGuard) ? [q.completionGuard] : [])].join(' ');
      unit.Restart = existsSync(q.completionGuard) ? 'no' : 'always';
      unit.ExecCondition = existsSync(q.completionGuard) ? '{ path=/usr/bin/false ; }' : '';
      unit.conditions = [['ConditionPathExists', false, true, 'other-controller-pending', 0],
        ...(existsSync(q.guard) ? [['ConditionPathExists', false, true, q.marker, 0]] : [])];
    },
    retire: selected => { assert.equal(selected, q.unit); assert.equal(unit.FreezerState, 'frozen'); effects.push('retire'); stopped(); },
  };
  holdQuarantine(parameters, native);
  writeFileSync(otherGuard, '[Unit]\nConditionPathExists=!other-controller-pending\n', { mode: 0o600 });
  effects.length = 0;
  return { parameters, native, q, unit, effects, expected, otherGuard, stopped, populate: () => { populated = true; } };
}

test('explicit completion retires the exact frozen invocation, clears only its controls, and leaves it stopped', t => {
  const f = fixture(t), original = readFileSync(f.q.marker, 'utf8');
  assert.throws(() => releaseQuarantine(f.parameters, f.native), /hold-only/);
  const result = completeQuarantine(f.parameters, f.native);
  assert.equal(result.status, 'completed');
  assert.equal(result.started, false);
  assert.equal(result.externalEffectsReconciled, false);
  assert.deepEqual(f.effects, ['reload', 'retire', 'reload']);
  assert.equal(f.unit.MainPID, '0');
  assert.equal(f.unit.ActiveState, 'inactive');
  assert.equal(existsSync(f.q.marker), false);
  assert.equal(existsSync(f.q.guard), false);
  assert.equal(readFileSync(f.otherGuard, 'utf8'), '[Unit]\nConditionPathExists=!other-controller-pending\n');
  const outcome = JSON.parse(readFileSync(f.q.completed));
  assert.equal(outcome.markerText, original);
  assert.equal(outcome.phase, 'completed');
  assert.equal(planQuarantine(f.parameters, f.native).status, 'unheld');
  assert.equal(completeQuarantine(f.parameters, f.native).unchanged, true);
  assert.deepEqual(f.effects, ['reload', 'retire', 'reload']);
  assert.throws(() => holdQuarantine(f.parameters, f.native), /completed identity/);
});

test('a retired unit systemd still marks frozen is not stopped: completion holds its controls', t => {
  // Seen on Cold Red Gate (systemd 257): github-pin-events was killed while frozen and stayed
  // FreezerState=frozen with no cgroup, refusing every start, while its hold read as finished.
  const f = fixture(t);
  f.native.retire = () => { f.stopped(); f.unit.FreezerState = 'frozen'; f.unit.ActiveState = 'failed'; f.unit.SubState = 'failed'; };
  assert.throws(() => completeQuarantine(f.parameters, f.native), /stopped unit remains frozen/);
  assert.equal(JSON.parse(readFileSync(f.q.completed)).phase, 'retiring');
  assert.equal(existsSync(f.q.marker), true);
  assert.equal(existsSync(f.q.guard), true);
});

test('identity, boot, process and control drift refuse before retirement or control removal', t => {
  for (const mutate of [
    f => { f.unit.MainPID = '202'; },
    f => { f.unit.InvocationID = 'b'.repeat(32); },
    f => { f.unit.ControlPID = '9'; },
    f => { f.unit.Job = '9'; },
    f => { f.unit.FreezerState = 'running'; },
    f => { f.native.boot = () => 'another-boot'; },
    f => { f.native.process = () => ({ ...f.expected.process, startTime: 'reused' }); },
    f => { f.native.uid = () => 999999; },
  ]) {
    const f = fixture(t), original = readFileSync(f.q.marker, 'utf8');
    mutate(f);
    assert.throws(() => completeQuarantine(f.parameters, f.native));
    assert.equal(readFileSync(f.q.marker, 'utf8'), original);
    assert.equal(existsSync(f.q.completed), false);
    assert.deepEqual(f.effects, []);
  }
});

test('an uncertain stop keeps controls and resumes from observed terminal state without killing again', t => {
  const f = fixture(t), retire = f.native.retire;
  f.native.retire = selected => { retire(selected); throw Error('reply lost after stop'); };
  assert.throws(() => completeQuarantine(f.parameters, f.native), /reply lost/);
  assert.equal(existsSync(f.q.marker), true);
  assert.equal(existsSync(f.q.guard), true);
  assert.equal(JSON.parse(readFileSync(f.q.completed)).phase, 'retiring');
  f.native.retire = () => { throw Error('must not kill an already retired cohort'); };
  assert.equal(completeQuarantine(f.parameters, f.native).status, 'completed');
  assert.deepEqual(f.effects, ['reload', 'retire', 'reload']);
});

test('a partial loaded-control clear resumes from durable retired state without another stop', t => {
  const f = fixture(t), reload = f.native.reload;
  let reloadCount = 0;
  f.native.reload = () => { if (++reloadCount === 2) throw Error('reload unavailable'); reload(); };
  assert.throws(() => completeQuarantine(f.parameters, f.native), /reload unavailable/);
  assert.equal(JSON.parse(readFileSync(f.q.completed)).phase, 'retired');
  assert.equal(existsSync(f.q.marker), false);
  assert.equal(existsSync(f.q.guard), false);
  f.native.reload = reload;
  f.native.retire = () => { throw Error('must not repeat stop'); };
  assert.equal(completeQuarantine(f.parameters, f.native).status, 'completed');
  assert.deepEqual(f.effects, ['reload', 'retire', 'reload']);
});

test('a lingering captured child cohort prevents clearing controls even with MainPID zero', t => {
  const f = fixture(t), retire = f.native.retire;
  f.native.retire = unit => { retire(unit); f.populate(); };
  assert.throws(() => completeQuarantine(f.parameters, f.native), /cohort remains populated/);
  assert.equal(existsSync(f.q.marker), true);
  assert.equal(existsSync(f.q.guard), true);
  assert.equal(JSON.parse(readFileSync(f.q.completed)).phase, 'retiring');
  assert.deepEqual(f.effects, ['reload', 'retire']);
});

test('changed original marker or guard on reentry cannot clear foreign controls', t => {
  for (const file of ['marker', 'guard']) {
    const f = fixture(t);
    f.native.retire = () => { throw Error('interrupted before stop'); };
    assert.throws(() => completeQuarantine(f.parameters, f.native), /interrupted/);
    writeFileSync(f.q[file], file === 'marker' ? JSON.stringify({ type: 'foreign' }) : '[Unit]\nforeign=true\n', { mode: 0o600 });
    assert.throws(() => completeQuarantine(f.parameters, f.native));
    assert.equal(existsSync(f.q.marker), true);
    assert.equal(existsSync(f.q.guard), true);
    assert.deepEqual(f.effects, ['reload']);
  }
});

test('native reload must actually remove this original condition before completion is reported', t => {
  const f = fixture(t);
  const reload = f.native.reload; let reloadCount = 0;
  f.native.reload = () => { if (++reloadCount === 1) reload(); else f.effects.push('reload'); };
  assert.throws(() => completeQuarantine(f.parameters, f.native), /still loaded/);
  assert.equal(JSON.parse(readFileSync(f.q.completed)).phase, 'retired');
  assert.deepEqual(f.effects, ['reload', 'retire', 'reload']);
});

test('omission and ambiguous selections do not complete any held unit', t => {
  const f = fixture(t), original = readFileSync(f.q.marker, 'utf8');
  assert.throws(() => completeQuarantine({ linux: {} }, f.native), /omission/);
  const second = { ...structuredClone(f.parameters.linux.userUnitQuarantine), id: 'another', unit: 'another.service' };
  f.parameters.linux.userUnitQuarantines = [second];
  assert.throws(() => completeQuarantine(f.parameters, f.native), /ambiguous/);
  assert.throws(() => completeQuarantine(f.parameters, f.native, 'unknown'), /not found/);
  assert.equal(readFileSync(f.q.marker, 'utf8'), original);
  assert.deepEqual(f.effects, []);
});

test('retiring reentry cancels an empty frozen restart without killing the old cohort twice', t => {
  const f = fixture(t);
  let kills = 0;
  f.native.retire = () => {
    if (f.unit.MainPID !== '0') {
      kills++;
      f.stopped();
      f.unit.ActiveState = 'activating';
      f.unit.SubState = 'auto-restart-queued';
      f.unit.FreezerState = 'frozen';
      throw Error('interrupted after captured cohort died');
    }
    f.stopped();
  };
  assert.throws(() => completeQuarantine(f.parameters, f.native), /interrupted/);
  assert.equal(JSON.parse(readFileSync(f.q.completed)).phase, 'retiring');
  assert.equal(completeQuarantine(f.parameters, f.native).status, 'completed');
  assert.equal(kills, 1);
});
