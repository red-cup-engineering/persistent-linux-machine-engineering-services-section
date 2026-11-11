import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyRetirements, planRetirements, retiredTimerDeclarations } from '../src/managed-timer-retirement.mjs';
import { applyManagedTimers, managedTimerDeclarations, planManagedTimers, renderManagedTimerFiles } from '../src/managed-timers.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const SERVICE = '[Service]\nExecStart=/bin/true\n';
const TIMER = '[Timer]\nOnCalendar=hourly\n';
const row = (over = {}) => ({ name: 'example-clock', user: 'owner', uid: 1000,
  retire: { reason: 'replaced by an event source', serviceSha256: sha(SERVICE), timerSha256: sha(TIMER) }, ...over });
const parameters = (...rows) => ({ schema: 'wsl-host-parameters@1', linux: { managedTimers: rows } });

function machine({ service = SERVICE, timer = TIMER, active = true, failed = false } = {}) {
  const state = { service, timer, active, failed, events: [] };
  const file = (text) => text === null ? { exists: false }
    : { exists: true, regular: true, uid: 0, mode: 0o644, sha256: sha(text) };
  const native = {
    machineFile: path => file(path.endsWith('.service') ? state.service : state.timer),
    unit: (r, manager, unit) => {
      const isTimer = unit.endsWith('.timer');
      const text = isTimer ? state.timer : state.service;
      if (text === null) return { Id: unit, LoadState: 'not-found', ActiveState: 'inactive' };
      return { Id: unit, LoadState: 'loaded', UnitFileState: isTimer ? 'enabled' : 'static',
        ActiveState: isTimer ? (state.active ? 'active' : 'inactive') : (state.failed ? 'failed' : 'inactive') };
    },
    quiet: () => true, wait: () => { throw new Error('unexpected wait'); },
    removeFile: path => { state.events.push(['remove', path]); if (path.endsWith('.service')) state.service = null; else state.timer = null; },
  };
  const run = (r, manager, args) => { state.events.push([manager, ...args]); if (args[0] === 'disable') state.active = false; if (args[0] === 'reset-failed') state.failed = false; };
  return { state, native, run };
}

test('a retirement row is bounded and cannot smuggle an active declaration', () => {
  assert.equal(retiredTimerDeclarations(parameters(row()))[0].timerPath, '/etc/systemd/system/example-clock.timer');
  for (const changed of [{ uid: 0 }, { user: 'Bad User' }, { calendar: '*-*-* *:*:00' }, { retire: { reason: 'x' } },
    { retire: { reason: 'x', serviceSha256: 'zz', timerSha256: null } }, { name: '../etc' }])
    assert.throws(() => retiredTimerDeclarations(parameters(row(changed))), /retirement refused/);
  assert.throws(() => retiredTimerDeclarations(parameters(row(), row())), /unique/);
});

test('a retirement is not an active declaration: it renders no files and is skipped by the active reader', () => {
  const p = parameters(row());
  assert.deepEqual(managedTimerDeclarations(p), []);
  assert.deepEqual(renderManagedTimerFiles(p), []);
});

test('retirement stops the timer, removes exactly the installed bytes, reloads, and is idempotent', () => {
  const m = machine({ failed: true });
  assert.equal(planRetirements(parameters(row()), { native: m.native })[0].state, 'pending');
  const ran = applyRetirements(parameters(row()), m);
  assert.deepEqual(m.state.events.map(e => e.join(' ')), [
    'system disable --now example-clock.timer', 'system reset-failed example-clock.service',
    'remove /etc/systemd/system/example-clock.timer', 'remove /etc/systemd/system/example-clock.service', 'system daemon-reload']);
  assert.equal(ran.length, 5);
  assert.equal(planRetirements(parameters(row()), { native: m.native })[0].state, 'retired');
  m.state.events.length = 0;
  assert.deepEqual(applyRetirements(parameters(row()), m), []);
  assert.deepEqual(m.state.events, []);
});

test('a changed or foreign unit file is refused and nothing is stopped or deleted', () => {
  const m = machine({ service: SERVICE + '# edited by someone\n' });
  assert.equal(planRetirements(parameters(row()), { native: m.native })[0].state, 'refused');
  assert.throws(() => applyRetirements(parameters(row()), m), /not the installed bytes/);
  assert.deepEqual(m.state.events, []);
  assert.notEqual(m.state.service, null);
});

test('a recorded-absent file may stay absent; a present file the record calls absent is refused', () => {
  const absent = machine({ timer: null });
  const p = parameters(row({ retire: { reason: 'r', serviceSha256: sha(SERVICE), timerSha256: null } }));
  applyRetirements(p, absent);
  assert.equal(planRetirements(p, { native: absent.native })[0].state, 'retired');
  const present = machine();
  assert.throws(() => applyRetirements(p, present), /not the installed bytes/);
});

test('plan and apply of managed timers include retirements', () => {
  const m = machine();
  const files = [];
  const planFiles = rendered => rendered.map(f => ({ ...f, state: 'current' }));
  const native = { ...m.native, uid: () => 0, run: m.run, passwd: () => ({}) };
  const plan = planManagedTimers(parameters(row()), { native, planFiles });
  assert.equal(plan.current, false);
  assert.equal(plan.retired[0].state, 'pending');
  const result = applyManagedTimers(parameters(row()), { native, planFiles, applyPlan: () => ({ written: files }) });
  assert.equal(result.converged, true);
  assert.equal(planManagedTimers(parameters(row()), { native, planFiles }).current, true);
});
