import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { applyPlan, planFiles } from '../src/wsl-host.mjs';
import { applyManagedTimers, managedTimerDeclarations, nativeManagedTimerPort, planManagedTimers, receiveManagedTimerInputs, renderManagedTimerFiles } from '../src/managed-timers.mjs';

const declaration = () => ({
  name: 'owned-intake', description: 'Existing intake', user: 'operator', uid: 1000,
  home: '/home/operator', ownerRoot: '/srv/own-services-section', workingDirectory: '/srv/own-services-section',
  command: ['/usr/bin/node', '/srv/own-services-section/data/logs/frozen/run.mjs', '--config', '/srv/own-services-section/data/records/config.json'],
  environment: { CODEX_HOME: '/home/operator/.codex', TMPDIR: '/srv/own-services-section/data/logs/tmp', XDG_CACHE_HOME: '/srv/own-services-section/data/logs/cache' },
  unsetEnvironment: ['NODE_COMPILE_CACHE'], timeoutStartSeconds: 270, timeoutStopSeconds: 10,
  memoryMaxBytes: 268435456, cpuQuotaPercent: 50, umask: '0077', calendar: '*-*-* *:0/10:00',
  bootDelaySeconds: 30, randomizedDelaySeconds: 30, persistent: false, replacesUserTimer: true,
  sourceBindings: [{ path: '/srv/own-services-section/data/logs/frozen/run.mjs', sha256: 'a'.repeat(64) }]
});
const parameters = r => ({ schema: 'wsl-host-parameters@1', linux: { managedTimers: [r] } });
const absent = () => ({ LoadState: 'not-found', ActiveState: 'inactive', MainPID: '0', ControlPID: '0', Job: '' });
function fixture({ current = false, enabled = false, legacy = false, running = false } = {}) {
  const r = declaration(), p = parameters(r), events = [];
  const units = { 'system:owned-intake.timer': absent(), 'system:owned-intake.service': absent(), 'user:owned-intake.timer': absent(), 'user:owned-intake.service': absent() };
  const bindService = () => { units['system:owned-intake.service'] = { ...absent(), LoadState: 'loaded', FragmentPath: '/etc/systemd/system/owned-intake.service', User: r.user, WorkingDirectory: r.workingDirectory, command: r.command }; };
  if (current) bindService();
  if (enabled) units['system:owned-intake.timer'] = { LoadState: 'loaded', ActiveState: 'active', UnitFileState: 'enabled', NextElapseUSecMonotonic: '100' };
  if (legacy) {
    units['user:owned-intake.timer'] = { LoadState: 'loaded', ActiveState: 'active', FragmentPath: '/run/user/1000/systemd/transient/owned-intake.timer' };
    units['user:owned-intake.service'] = { ...absent(), LoadState: 'loaded', FragmentPath: '/run/user/1000/systemd/transient/owned-intake.service', command: r.command,
      ...(running ? { MainPID: '123', ActiveState: 'activating', ControlGroup: '/captured' } : {}) };
  }
  const native = {
    uid: () => 0,
    unit: (_, manager, name) => structuredClone(units[manager + ':' + name]),
    quiet: u => u.MainPID === '0' && u.ControlPID === '0' && !u.Job && ['inactive', 'failed'].includes(u.ActiveState),
    wait: () => { events.push(['wait']); units['user:owned-intake.service'] = { ...units['user:owned-intake.service'], ...absent(), LoadState: 'loaded' }; },
    run: (_, manager, args) => {
      events.push([manager, ...args]);
      if (args[0] === 'stop') units[manager + ':' + args[1]] = { ...units[manager + ':' + args[1]], ...absent(), LoadState: 'loaded' };
      if (args[0] === 'daemon-reload') bindService();
      if (args[0] === 'enable') { bindService(); units['system:owned-intake.timer'] = { LoadState: 'loaded', ActiveState: 'active', UnitFileState: 'enabled', NextElapseUSecMonotonic: '100' }; }
    }
  };
  let filesCurrent = current;
  const options = { native, receiveInputs: () => { events.push(['receive-inputs']); }, receiveTargets: () => {},
    planFiles: files => files.map(f => ({ ...f, state: filesCurrent ? 'current' : 'absent' })),
    applyPlan: files => { events.push(['write', files.filter(f => f.state !== 'current').length]); const written = files.filter(f => f.state !== 'current').map(f => f.path); filesCurrent = true; return { written, ran: [] }; }
  };
  return { r, p, units, native, options, events };
}

test('managed timers are optional and declarations reject unbounded, injected and ambient inputs', () => {
  assert.deepEqual(renderManagedTimerFiles({ schema: 'wsl-host-parameters@1', linux: {} }), []);
  for (const changed of [{ name: '../other' }, { persistent: true }, { command: ['node', 'x'] }, { description: 'x\nUser=root' }, { ownerRoot: '/home/operator/.local/own-services-section' }, { environment: { HOME: '/fictional' } }, { sourceBindings: [] }, { workingDirectory: '/srv/own-services-section ' }, { workingDirectory: '/srv/own-services-section\\suffix' }]) {
    assert.throws(() => managedTimerDeclarations(parameters({ ...declaration(), ...changed })), /managed timer refused/);
  }
  assert.throws(() => managedTimerDeclarations({ schema: 'wsl-host-parameters@1', linux: { managedTimers: [declaration(), declaration()] } }), /unique/);
});

test('the standalone package exposes its original managed-timer contract to explicit native callers', async () => {
  const require = createRequire(import.meta.url);
  const original = await import(pathToFileURL(require.resolve('@red-cup-engineering/wsl-host-service/managed-timers')));
  assert.equal(original.managedTimerDeclarations, managedTimerDeclarations);
  assert.equal(original.renderManagedTimerFiles, renderManagedTimerFiles);
  assert.equal(original.applyManagedTimers, applyManagedTimers);
  assert.equal(original.MAX_MANAGED_TIMER_SOURCE_BINDINGS, 128);
});

test('units retain unprivileged owner, boot recovery, original cadence, limits and literal systemd arguments', () => {
  const r = declaration(); r.command.push('literal % $ " space');
  const [service, timer] = renderManagedTimerFiles(parameters(r));
  assert.match(service.content, /User=operator\n/); assert.match(service.content, /^WorkingDirectory=\/srv\/own-services-section$/m); assert.match(service.content, /literal %% \$\$ \\\" space/);
  assert.doesNotMatch(service.content, /Environment="HOME=/); assert.match(service.content, /TimeoutStartSec=270s/);
  assert.match(timer.content, /OnBootSec=30s\nOnCalendar=\*-\*-\* \*:0\/10:00/);
  assert.match(timer.content, /Persistent=false/); assert.match(timer.content, /WantedBy=timers.target/);
  assert.deepEqual(service.hooks, []); assert.deepEqual(timer.hooks, []);
});

test('one complete installed selection admits 128 exact bindings and refuses a 129th before any native call', () => {
  const r = declaration();
  const originalFiles = renderManagedTimerFiles(parameters(r));
  r.sourceBindings = Array.from({ length: 128 }, (_, index) => ({
    path: `/srv/own-services-section/data/logs/installed/member-${index}.mjs`, sha256: 'a'.repeat(64)
  }));
  assert.equal(managedTimerDeclarations(parameters(r))[0].sourceBindings.length, 128);
  assert.deepEqual(renderManagedTimerFiles(parameters(r)), originalFiles);
  r.sourceBindings.push({ path: '/srv/own-services-section/data/logs/installed/member-128.mjs', sha256: 'b'.repeat(64) });
  const native = new Proxy({}, { get() { assert.fail('over-bound declaration reached a native effect or observation'); } });
  assert.throws(() => applyManagedTimers(parameters(r), { native, planFiles, applyPlan }), /exact selected runtime source bindings/);
});

test('the 128th physical source retains its digest, one-MiB and non-symlink admission', () => {
  const stage = mkdtempSync(join(tmpdir(), 'wsl-complete-source-'));
  try {
    const owner = join(stage, 'fixture-services-section'), logs = join(owner, 'data/logs');
    mkdirSync(join(logs, 'temporary-logs'), { recursive: true, mode: 0o700 });
    mkdirSync(join(logs, 'cache-logs'), { mode: 0o700 });
    const r = { ...declaration(), uid: process.getuid(), ownerRoot: owner, workingDirectory: owner,
      environment: { TMPDIR: join(logs, 'temporary-logs'), XDG_CACHE_HOME: join(logs, 'cache-logs') }, sourceBindings: [] };
    for (let index = 0; index < 128; index++) {
      const path = join(logs, `member-${index}.mjs`), bytes = Buffer.from(`export const member = ${index};\n`);
      writeFileSync(path, bytes, { mode: 0o600 });
      r.sourceBindings.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    const native = { passwd: () => ({ name: r.user, uid: r.uid, home: r.home }) };
    receiveManagedTimerInputs(r, native);
    const last = r.sourceBindings.at(-1);
    writeFileSync(last.path, 'changed final member');
    assert.throws(() => receiveManagedTimerInputs(r, native), /selected runtime source changed/);
    const maximum = Buffer.alloc(1048576, 97);
    writeFileSync(last.path, maximum); last.sha256 = createHash('sha256').update(maximum).digest('hex');
    receiveManagedTimerInputs(r, native);
    writeFileSync(last.path, Buffer.alloc(1048577, 97));
    assert.throws(() => receiveManagedTimerInputs(r, native), /unsafe runtime source/);
    rmSync(last.path); symlinkSync(r.sourceBindings[0].path, last.path);
    last.sha256 = r.sourceBindings[0].sha256;
    assert.throws(() => receiveManagedTimerInputs(r, native), /unsafe runtime source/);
  } finally { rmSync(stage, { recursive: true }); }
});

test('component staging writes only its two files, runs no lifecycle command and is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'wsl-selected-timer-'));
  try {
    const native = new Proxy({}, { get() { throw new Error('native port called during staging'); } });
    const first = applyManagedTimers(parameters(declaration()), { root, native, planFiles, applyPlan });
    assert.equal(first.written.length, 2); assert.deepEqual(first.ran, []);
    assert.match(readFileSync(join(root, 'etc/systemd/system/owned-intake.service'), 'utf8'), /User=operator/);
    const second = applyManagedTimers(parameters(declaration()), { root, native, planFiles, applyPlan });
    assert.deepEqual(second.written, []); assert.deepEqual(second.ran, []);
  } finally { rmSync(root, { recursive: true }); }
});

test('first install drains the actual raced legacy service after stopping only its timer', () => {
  const f = fixture({ legacy: true, running: true });
  const result = applyManagedTimers(f.p, f.options);
  assert.equal(result.converged, true);
  const stopTimer = f.events.findIndex(e => e.join(':') === 'user:stop:owned-intake.timer');
  const wait = f.events.findIndex(e => e[0] === 'wait');
  const stopService = f.events.findIndex(e => e.join(':') === 'user:stop:owned-intake.service');
  const write = f.events.findIndex(e => e[0] === 'write');
  const enable = f.events.findIndex(e => e.join(':') === 'system:enable:--now:owned-intake.timer');
  assert.ok(stopTimer >= 0 && stopTimer < wait && wait < stopService && stopService < write && write < enable);
  assert.equal(f.events.filter(e => e[1] === 'daemon-reload').length, 1);
});

test('a nonterminal legacy cohort refuses before file writes or a competing enable', () => {
  const f = fixture({ legacy: true, running: true });
  f.native.wait = () => { throw new Error('finite drain exhausted'); };
  assert.throws(() => applyManagedTimers(f.p, f.options), e => e.message === 'finite drain exhausted' && e.managedTimerOutcome.phase === 'drain');
  assert.equal(f.events.some(e => e[0] === 'write' || e[1] === 'enable'), false);
  assert.equal(f.units['user:owned-intake.service'].MainPID, '123');
});

test('an already received system declaration causes no write, reload, enable or service replay', () => {
  const f = fixture({ current: true, enabled: true });
  const result = applyManagedTimers(f.p, f.options);
  assert.deepEqual(result.written, []); assert.deepEqual(result.ran, []);
  assert.deepEqual(f.events, [['receive-inputs']]);
});

test('current files with a lost timer restore enablement without rewriting files', () => {
  const f = fixture({ current: true });
  const result = applyManagedTimers(f.p, f.options);
  assert.deepEqual(result.written, []); assert.equal(result.converged, true);
  assert.equal(f.events.filter(e => e[1] === 'enable').length, 1);
  assert.equal(f.events.some(e => e[1] === 'daemon-reload'), false);
});

test('conflicting native declarations and a changed legacy command refuse before timer stop', () => {
  for (const changed of ['system', 'user']) {
    const f = fixture({ legacy: true });
    if (changed === 'system') f.units['system:owned-intake.service'] = { LoadState: 'loaded', FragmentPath: '/foreign/unit' };
    else f.units['user:owned-intake.service'].command = ['/foreign/actuator'];
    assert.throws(() => applyManagedTimers(f.p, f.options), /conflicting|changed legacy/);
    assert.equal(f.events.some(e => e[1] === 'stop' || e[0] === 'write'), false);
  }
});

test('unreceived effective User or command never counts as a converged timer', () => {
  const f = fixture({ current: true, enabled: true });
  f.units['system:owned-intake.service'].User = 'root';
  assert.equal(planManagedTimers(f.p, f.options).current, false);
  f.units['system:owned-intake.service'].User = f.r.user;
  f.units['system:owned-intake.service'].WorkingDirectory = '/foreign';
  assert.equal(planManagedTimers(f.p, f.options).current, false);
});

test('partial native enable failure retains its original phase and does not retry', () => {
  const f = fixture(); const run = f.native.run; let attempts = 0;
  f.native.run = (r, m, args) => { if (args[0] === 'enable') { attempts++; throw new Error('unknown provider outcome'); } return run(r, m, args); };
  assert.throws(() => applyManagedTimers(f.p, f.options), e => e.message === 'unknown provider outcome' && e.managedTimerOutcome.phase === 'enable' && e.managedTimerOutcome.nativeMayHaveStarted);
  assert.equal(attempts, 1);
});

test('privilege or selected source refusal precedes all machine effects', () => {
  const f = fixture(); f.native.uid = () => 1000;
  assert.throws(() => applyManagedTimers(f.p, f.options), /root required/); assert.deepEqual(f.events, []);
  f.native.uid = () => 0; f.options.receiveInputs = () => { throw new Error('source changed'); };
  assert.throws(() => applyManagedTimers(f.p, f.options), /source changed/); assert.deepEqual(f.events, []);
});

test('actual owner/source receiving rejects changed bytes and redirected temporary storage', () => {
  const stage = mkdtempSync(join(tmpdir(), 'wsl-owner-'));
  try {
    const owner = join(stage, 'fixture-services-section'), logs = join(owner, 'data/logs');
    mkdirSync(join(logs, 'temporary-logs'), { recursive: true, mode: 0o700 }); mkdirSync(join(logs, 'cache-logs'), { mode: 0o700 });
    const source = join(logs, 'runtime.mjs'); writeFileSync(source, 'original', { mode: 0o600 });
    const r = { ...declaration(), uid: process.getuid(), ownerRoot: owner, workingDirectory: owner,
      environment: { TMPDIR: join(logs, 'temporary-logs'), XDG_CACHE_HOME: join(logs, 'cache-logs') },
      sourceBindings: [{ path: source, sha256: createHash('sha256').update('original').digest('hex') }] };
    const native = { passwd: () => ({ name: r.user, uid: r.uid, home: r.home }) };
    receiveManagedTimerInputs(r, native);
    writeFileSync(source, 'changed'); assert.throws(() => receiveManagedTimerInputs(r, native), /source changed/);
    writeFileSync(source, 'original'); rmdirSync(r.environment.TMPDIR); symlinkSync(r.environment.XDG_CACHE_HOME, r.environment.TMPDIR);
    assert.throws(() => receiveManagedTimerInputs(r, native), /unsafe declared directory/);
  } finally { rmSync(stage, { recursive: true }); }
});


test('reset-failed collection is received afresh without stopping a vanished transient', () => {
  const f = fixture({ legacy: true });
  f.units['user:owned-intake.service'].ActiveState = 'failed';
  const run = f.native.run;
  f.native.run = (r, manager, args) => {
    if (args[0] === 'reset-failed') {
      f.events.push([manager, ...args]); f.units['user:owned-intake.service'] = absent(); return;
    }
    if (manager === 'user' && args.join(':') === 'stop:owned-intake.service') throw new Error('stale stop');
    return run(r, manager, args);
  };
  assert.equal(applyManagedTimers(f.p, f.options).converged, true);
  assert.equal(f.events.filter(e => e[1] === 'reset-failed').length, 1);
  assert.equal(f.events.some(e => e.join(':') === 'user:stop:owned-intake.service'), false);
});

test('missing user bus proves legacy absence only through its exact quiet system-manager cohort', () => {
  const r = declaration(); const calls = []; let managerActive = false;
  const original = new Error('user bus unavailable');
  const port = nativeManagedTimerPort(1000, { runNative: (exe, args) => {
    calls.push([exe, ...args]);
    if (args.includes('--user')) throw original;
    assert.ok(args.includes('user@1000.service'));
    return 'LoadState=loaded\nActiveState=' + (managerActive ? 'active' : 'inactive') + '\nMainPID=' + (managerActive ? '123' : '0') + '\nControlPID=0\nControlGroup=\nJob=\n';
  } });
  assert.equal(port.unit(r, 'user', 'owned-intake.service').ownerManagerAbsent, true);
  managerActive = true;
  assert.throws(() => port.unit(r, 'user', 'owned-intake.service'), error => error === original);
  assert.equal(calls.filter(row => row.includes('user@1000.service')).length, 2);
});


test('legacy command transition: exact captured old argv permits the separately bound successor', () => {
  const f = fixture({ legacy: true, running: true });
  const old = structuredClone(f.r.command);
  f.r.command = [old[0], '/srv/own-services-section/data/logs/successor/run.mjs', ...old.slice(2)];
  f.r.expectedLegacyCommand = old;
  const result = applyManagedTimers(f.p, f.options);
  assert.equal(result.converged, true);
  assert.deepEqual(f.units['system:owned-intake.service'].command, f.r.command);
  assert(f.events.findIndex(e => e.join(':') === 'user:stop:owned-intake.timer') < f.events.findIndex(e => e[0] === 'write'));
  const [service] = renderManagedTimerFiles(f.p);
  assert(service.content.includes('/data/logs/successor/run.mjs'));
  assert(!service.content.includes('/data/logs/frozen/run.mjs'));
});

test('legacy command transition: unexpected or newly raced legacy identity refuses before stop', () => {
  for (const race of ['initial-command', 'raced-command', 'raced-service-fragment', 'raced-timer-fragment']) {
    const f = fixture({ legacy: true });
    f.r.expectedLegacyCommand = structuredClone(f.r.command);
    f.r.command = [f.r.command[0], '/srv/own-services-section/data/logs/successor/run.mjs'];
    if (race === 'initial-command') f.units['user:owned-intake.service'].command = ['/foreign/producer'];
    else {
      const unit = f.native.unit; const reads = new Map();
      f.native.unit = (r, manager, name) => {
        const value = unit(r, manager, name);
        if (manager === 'user') {
          const count = (reads.get(name) ?? 0) + 1; reads.set(name, count);
          if (count >= 3) {
            if (race === 'raced-command' && name === r.service) value.command = ['/foreign/producer'];
            if (race === 'raced-service-fragment' && name === r.service) value.FragmentPath = '/persistent/unreceived.service';
            if (race === 'raced-timer-fragment' && name === r.timer) value.FragmentPath = '/persistent/unreceived.timer';
          }
        }
        return value;
      };
    }
    assert.throws(() => applyManagedTimers(f.p, f.options), /changed legacy command|unreceived persistent legacy/);
    assert.equal(f.events.some(e => e[1] === 'stop' || e[0] === 'write' || e[1] === 'enable'), false);
  }
});

test('legacy command transition: omitted field retains same-command behavior and invalid declarations refuse', () => {
  const same = fixture({ legacy: true });
  assert.equal(applyManagedTimers(same.p, same.options).converged, true);
  const changed = fixture({ legacy: true });
  changed.r.command = [changed.r.command[0], '/srv/own-services-section/data/logs/successor/run.mjs'];
  assert.throws(() => applyManagedTimers(changed.p, changed.options), /changed legacy command/);
  assert.equal(changed.events.some(e => e[1] === 'stop'), false);
  for (const amendment of [
    { expectedLegacyCommand: ['node', 'relative'] },
    { expectedLegacyCommand: ['/usr/bin/node', 'bad\nargument'] },
    { expectedLegacyCommand: ['/usr/bin/node'], replacesUserTimer: false },
  ]) assert.throws(() => managedTimerDeclarations(parameters({ ...declaration(), ...amendment })), /expected legacy command/);
});


function retirementFixture(options = {}) {
  const f = fixture({ current: true, enabled: true, ...options });
  f.p.linux.managedTimers = [];
  f.p.linux.retiredManagedTimers = [{ ...f.r, retirementReason: 'Original Work must run from native source events, never this clock.' }];
  f.units['system:owned-intake.timer'].FragmentPath = '/etc/systemd/system/owned-intake.timer';
  f.units['system:owned-intake.timer'].MainPID = '0';
  f.units['system:owned-intake.timer'].ControlPID = '0';
  f.native.passwd = () => ({ name: f.r.user, uid: f.r.uid, home: f.r.home });
  const original = f.native.run;
  f.native.run = (r, manager, args) => {
    if (args[0] !== 'disable') return original(r, manager, args);
    f.events.push([manager, ...args]);
    Object.assign(f.units['system:owned-intake.timer'], { ActiveState: 'inactive', UnitFileState: 'disabled', NextElapseUSecMonotonic: '', NextElapseUSecRealtime: '' });
  };
  f.native.wait = () => { throw new Error('retirement must not poll'); };
  return f;
}

test('retirement disables the exact timer persistently, preserves failed service evidence, and converges idempotently', () => {
  const f = retirementFixture();
  f.units['system:owned-intake.service'].ActiveState = 'failed';
  assert.deepEqual(renderManagedTimerFiles(f.p), []);
  assert.deepEqual(f.p.linux.managedTimers, [], 'an older producer selects no active role');
  assert.equal(planManagedTimers(f.p, f.options).current, false);
  const out = applyManagedTimers(f.p, f.options);
  assert.equal(out.converged, true);
  assert.deepEqual(out.written, []);
  assert.deepEqual(f.events, [['system', 'disable', '--now', 'owned-intake.timer']]);
  assert.equal(f.units['system:owned-intake.service'].ActiveState, 'failed');
  assert.equal(planManagedTimers(f.p, f.options).current, true);
  f.events.length = 0;
  assert.deepEqual(applyManagedTimers(f.p, f.options).ran, []);
  assert.deepEqual(f.events, []);
});

test('retirement of a running service removes future wakes and holds its actual job without stop, wait or replay', () => {
  const f = retirementFixture();
  Object.assign(f.units['system:owned-intake.service'], { ActiveState: 'activating', MainPID: '987' });
  assert.throws(() => applyManagedTimers(f.p, f.options), e => /running/.test(e.message)
    && e.managedTimerOutcome.phase === 'retire-drain' && !e.managedTimerOutcome.converged);
  assert.equal(f.units['system:owned-intake.service'].MainPID, '987');
  assert.deepEqual(f.events, [['system', 'disable', '--now', 'owned-intake.timer']]);
  Object.assign(f.units['system:owned-intake.service'], { ActiveState: 'inactive', MainPID: '0' });
  assert.equal(applyManagedTimers(f.p, f.options).converged, true);
  assert.equal(f.events.length, 1);
});

test('retirement rejects a changed native owner, effective command, timer fragment or user predecessor before effects', () => {
  for (const changed of ['owner', 'command', 'timer', 'legacy']) {
    const f = retirementFixture();
    if (changed === 'owner') f.native.passwd = () => ({ name: f.r.user, uid: 2000, home: f.r.home });
    if (changed === 'command') f.units['system:owned-intake.service'].command = ['/foreign/actuator'];
    if (changed === 'timer') f.units['system:owned-intake.timer'].FragmentPath = '/foreign/owned-intake.timer';
    if (changed === 'legacy') f.units['user:owned-intake.timer'] = { ...absent(), LoadState: 'loaded', FragmentPath: '/persistent/user.timer' };
    assert.throws(() => applyManagedTimers(f.p, f.options), /owner identity|unreceived/);
    assert.deepEqual(f.events, []);
  }
});

test('an uncertain native retirement is retained exactly once and cannot be reported as converged', () => {
  const f = retirementFixture();let attempts = 0;
  f.native.run = () => { attempts++; throw new Error('disable reply lost'); };
  assert.throws(() => applyManagedTimers(f.p, f.options), e => e.message === 'disable reply lost'
    && e.managedTimerOutcome.phase === 'retire' && e.managedTimerOutcome.nativeMayHaveStarted);
  assert.equal(attempts, 1);
});

test('retired and active declarations share one bound and unique roles, with an explicit retirement reason', () => {
  const f = retirementFixture();
  f.p.linux.managedTimers = [f.r];
  assert.throws(() => managedTimerDeclarations(f.p), /unique/);
  f.p.linux.managedTimers = [];
  delete f.p.linux.retiredManagedTimers[0].retirementReason;
  assert.throws(() => managedTimerDeclarations(f.p), /reason/);
  assert.throws(() => managedTimerDeclarations({ schema: f.p.schema, linux: { retiredManagedTimers: {} } }), /bounded/);
});

test('the original CLI stages a retirement without rendering or running a timer', () => {
  const stage = mkdtempSync(join(tmpdir(), 'wsl-retirement-cli-'));
  try {
    const f = retirementFixture(), parametersPath = join(stage, 'parameters.json');
    writeFileSync(parametersPath, JSON.stringify(f.p));
    const stdout = execFileSync(process.execPath, [new URL('../scripts/wsl-host.mjs', import.meta.url).pathname,
      'apply', '--component=managed-timers', '--parameters=' + parametersPath, '--root=' + join(stage, 'root')], { encoding: 'utf8', timeout: 10000 });
    const out = JSON.parse(stdout);
    assert.equal(out.staged, true);assert.deepEqual(out.written, []);assert.deepEqual(out.ran, []);
  } finally { rmSync(stage, { recursive: true }); }
});
