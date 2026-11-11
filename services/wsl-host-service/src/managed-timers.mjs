// Record-owned system timers: no application jobs, network client or scheduler of our own.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const fail = message => { throw new Error('managed timer refused: ' + message); };
const scalar = v => typeof v === 'string' && v.length > 0 && v.length <= 8192 && !/[\x00-\x1f\x7f]/.test(v);
const path = v => scalar(v) && isAbsolute(v) && resolve(v) === v && v.trim() === v && !v.includes('\\');
const within = (p, root) => p === root || p.startsWith(root + '/');
const forbidden = p => p.split('/').some(x => ['.local', 'node_modules'].includes(x)) || p.startsWith('/gnu/store/');
const integer = (n, low, high) => Number.isSafeInteger(n) && n >= low && n <= high;
const quote = (s, exec = false) => '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => exec ? '$$' : '$') + '"';

export const MAX_MANAGED_TIMER_SOURCE_BINDINGS = 128;

export function managedTimerDeclarations(parameters) {
  if (parameters.schema !== 'wsl-host-parameters@1') fail('unknown parameter schema');
  const active = parameters.linux?.managedTimers ?? [];
  const retired = parameters.linux?.retiredManagedTimers ?? [];
  if (!Array.isArray(active) || !Array.isArray(retired) || active.length + retired.length > 8) fail('bounded managed timer lifecycle arrays required');
  const rows = [...active.map(record => ({ record, retired: false })), ...retired.map(record => ({ record, retired: true }))];
  const names = new Set();
  return rows.map(({ record: r, retired }) => {
    if (!r || !/^[a-z][a-z0-9-]{0,63}$/.test(r.name ?? '') || names.has(r.name)) fail('unique simple unit name required');
    names.add(r.name);
    if (Object.hasOwn(r, 'state')) fail('lifecycle belongs to the active or retired declaration list');
    if (retired && !scalar(r.retirementReason)) fail('explicit retirement reason required');
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(r.user ?? '') || !integer(r.uid, 1, 2147483647) || !path(r.home)) fail('explicit unprivileged owner required');
    if (!path(r.ownerRoot) || !r.ownerRoot.endsWith('-services-section') || forbidden(r.ownerRoot)) fail('canonical section owner required');
    if (!path(r.workingDirectory) || !within(r.workingDirectory, r.ownerRoot)) fail('working directory outside owner');
    if (!Array.isArray(r.command) || !integer(r.command.length, 1, 32) || !path(r.command[0]) || !r.command.every(scalar)) fail('explicit executable and bounded argument vector required');
    if (Object.hasOwn(r, 'expectedLegacyCommand') && (!r.replacesUserTimer || !Array.isArray(r.expectedLegacyCommand)
        || !integer(r.expectedLegacyCommand.length, 1, 32) || !path(r.expectedLegacyCommand[0]) || !r.expectedLegacyCommand.every(scalar)))
      fail('explicit bounded expected legacy command requires replacesUserTimer');
    if (!scalar(r.description) || !scalar(r.calendar) || r.persistent !== false || typeof r.replacesUserTimer !== 'boolean') fail('explicit bounded timer policy required');
    if (!integer(r.bootDelaySeconds, 1, 3600) || !integer(r.randomizedDelaySeconds, 0, 300) || !integer(r.timeoutStartSeconds, 1, 600) || !integer(r.timeoutStopSeconds, 1, 60) || !integer(r.memoryMaxBytes, 1048576, 1073741824) || !integer(r.cpuQuotaPercent, 1, 100) || r.umask !== '0077') fail('finite resource allocation required');
    if (!r.environment || Array.isArray(r.environment) || typeof r.environment !== 'object' || Object.keys(r.environment).length > 32) fail('explicit environment required');
    for (const [k, v] of Object.entries(r.environment)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(k) || /TOKEN|SECRET|PASSWORD|AUTHORIZATION|COOKIE/.test(k) || k === 'HOME' || typeof v !== 'string' || (v !== '' && !scalar(v))) fail('unsafe or secret-bearing environment');
    }
    for (const key of ['TMPDIR', 'XDG_CACHE_HOME']) if (!path(r.environment[key]) || !within(r.environment[key], join(r.ownerRoot, 'data/logs'))) fail('temporary/cache directory must be typed owner logs');
    if (!Array.isArray(r.unsetEnvironment) || r.unsetEnvironment.some(k => !/^[A-Z][A-Z0-9_]*$/.test(k) || k === 'HOME' || k === 'CODEX_HOME')) fail('invalid unset environment');
    if (!Array.isArray(r.sourceBindings) || !integer(r.sourceBindings.length, 1, MAX_MANAGED_TIMER_SOURCE_BINDINGS) || r.sourceBindings.some(b => !path(b.path) || !/^[a-f0-9]{64}$/.test(b.sha256 ?? ''))) fail('exact selected runtime source bindings required');
    return { ...r, state: retired ? 'retired' : 'enabled', service: r.name + '.service', timer: r.name + '.timer' };
  });
}

export function renderManagedTimerFiles(parameters, root = '') {
  return managedTimerDeclarations(parameters).filter(r => r.state === 'enabled').flatMap(r => {
    const service = [
      '[Unit]', `Description=${r.description.replaceAll('%', '%%')}`, 'After=network-online.target',
      '', '[Service]', 'Type=oneshot', `User=${r.user}`, `WorkingDirectory=${r.workingDirectory.replaceAll('%', '%%')}`,
      ...Object.entries(r.environment).map(([k, v]) => `Environment=${quote(k + '=' + v)}`),
      ...(r.unsetEnvironment.length ? ['UnsetEnvironment=' + r.unsetEnvironment.join(' ')] : []),
      `ExecStart=${r.command.map(s => quote(s, true)).join(' ')}`,
      `TimeoutStartSec=${r.timeoutStartSeconds}s`, `TimeoutStopSec=${r.timeoutStopSeconds}s`,
      'KillMode=control-group', `MemoryMax=${r.memoryMaxBytes}`, `CPUQuota=${r.cpuQuotaPercent}%`, `UMask=${r.umask}`, ''
    ].join('\n');
    const timer = ['[Unit]', `Description=${r.description.replaceAll('%', '%%')} timer`, '', '[Timer]',
      `OnBootSec=${r.bootDelaySeconds}s`, `OnCalendar=${r.calendar.replaceAll('%', '%%')}`,
      `RandomizedDelaySec=${r.randomizedDelaySeconds}s`, 'Persistent=false', `Unit=${r.service}`,
      '', '[Install]', 'WantedBy=timers.target', ''].join('\n');
    return [[r.service, service], [r.timer, timer]].map(([name, content]) => ({ scope: 'linux', path: root + '/etc/systemd/system/' + name, content, mode: 0o644, hooks: [] }));
  });
}

function quietNativeUnit(u) {
  if (Number(u.MainPID || 0) || Number(u.ControlPID || 0) || (u.Job && u.Job !== '0')) return false;
  if (!['inactive', 'failed'].includes(u.ActiveState)) return false;
  if (!u.ControlGroup) return true;
  if (!/^\/[A-Za-z0-9_./@:-]+$/.test(u.ControlGroup) || u.ControlGroup.includes('..')) fail('invalid captured control group');
  try { return /^populated 0$/m.test(readFileSync('/sys/fs/cgroup' + u.ControlGroup + '/cgroup.events', 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return true; throw e; }
}

export function nativeManagedTimerPort(budgetMilliseconds = 300000, { runNative = execFileSync } = {}) {
  if (!integer(budgetMilliseconds, 1, 300000)) fail('finite native deadline required');
  const end = performance.now() + budgetMilliseconds;
  const run = (exe, args) => {
    const timeout = Math.floor(end - performance.now());
    if (timeout < 1) fail('native deadline exhausted');
    return runNative(exe, args, { encoding: 'utf8', timeout, maxBuffer: 65536 });
  };
  const systemctl = (r, manager, args) => run('/usr/bin/systemctl', [...(manager === 'user' ? ['--user', ...(process.getuid() === r.uid ? [] : ['--machine=' + r.user + '@.host'])] : []), ...args]);
  return {
    uid: () => process.getuid(),
    passwd: user => {
      const rows = run('/usr/bin/getent', ['passwd', user]).trim().split('\n');
      if (rows.length !== 1) fail('ambiguous native owner');
      const [name, , uid, , , home] = rows[0].split(':');
      return { name, uid: Number(uid), home };
    },
    unit: (r, manager, unit) => {
      const fields = '--property=Id,LoadState,ActiveState,SubState,MainPID,ControlPID,ControlGroup,Job,FragmentPath,UnitFileState,NextElapseUSecRealtime,NextElapseUSecMonotonic,User,ExecStart,DropInPaths,WorkingDirectory';
      const parse = raw => Object.fromEntries(raw.trim().split('\n').filter(Boolean).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
      let result;
      try { result = parse(systemctl(r, manager, ['show', unit, '--no-pager', fields])); }
      catch (error) {
        if (manager !== 'user') throw error;
        // A vanished user bus is not an empty estate. Receive its selected
        // system-owned manager cohort before concluding this legacy unit is gone.
        const ownerManager = parse(systemctl(r, 'system', ['show', 'user@' + r.uid + '.service', '--no-pager', fields]));
        if (!quietNativeUnit(ownerManager)) throw error;
        return { Id: unit, LoadState: 'not-found', ActiveState: 'inactive', MainPID: '0', ControlPID: '0', ControlGroup: '', Job: '', ownerManagerAbsent: true };
      }
      if (unit.endsWith('.service') && result.LoadState === 'loaded') {
        const escaped = [...unit].map(c => /[A-Za-z0-9]/.test(c) ? c : '_' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
        const argv = JSON.parse(run('/usr/bin/busctl', [...(manager === 'user' ? ['--user', ...(process.getuid() === r.uid ? [] : ['--machine=' + r.user + '@.host'])] : ['--system']), '--json=short', 'get-property', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1/unit/' + escaped, 'org.freedesktop.systemd1.Service', 'ExecStart']));
        if (argv.type !== 'a(sasbttttuii)' || !Array.isArray(argv.data) || argv.data.length !== 1 || argv.data[0][2] !== false) fail('unknown native command schema');
        result.command = argv.data[0][1];
      }
      return result;
    },
    quiet: quietNativeUnit,
    wait: () => {
      if (performance.now() >= end) fail('native drain deadline exhausted');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    },
    run: (r, manager, args) => systemctl(r, manager, args)
  };
}

function realDirectory(p, uid) {
  const st = lstatSync(p);
  if (!st.isDirectory() || st.isSymbolicLink() || realpathSync(p) !== p || st.uid !== uid || (st.mode & 0o022)) fail('unsafe declared directory ' + p);
}
export function receiveManagedTimerInputs(r, native) {
  const owner = native.passwd(r.user);
  if (owner.name !== r.user || owner.uid !== r.uid || owner.home !== r.home) fail('native owner identity changed');
  realDirectory(r.ownerRoot, r.uid);
  for (const p of [join(r.ownerRoot, 'data'), join(r.ownerRoot, 'data/logs'), r.workingDirectory, r.environment.TMPDIR, r.environment.XDG_CACHE_HOME]) realDirectory(p, r.uid);
  for (const binding of r.sourceBindings) {
    const st = lstatSync(binding.path);
    if (!st.isFile() || st.size > 1048576 || st.isSymbolicLink() || realpathSync(binding.path) !== binding.path || (st.mode & 0o022)) fail('unsafe runtime source ' + binding.path);
    if (createHash('sha256').update(readFileSync(binding.path)).digest('hex') !== binding.sha256) fail('selected runtime source changed');
  }
}

const activeTimer = u => u.LoadState === 'loaded' && u.ActiveState === 'active' && u.UnitFileState === 'enabled' && Boolean(u.NextElapseUSecRealtime || Number(u.NextElapseUSecMonotonic));
const loaded = u => u.LoadState !== 'not-found';
const sameCommand = (u, r) => JSON.stringify(u.command) === JSON.stringify(r.command);
const receiveLegacyUnit = (u, r, unit) => {
  if (loaded(u) && u.FragmentPath !== '/run/user/' + r.uid + '/systemd/transient/' + unit) fail('unreceived persistent legacy declaration');
};
const receiveLegacyCommand = (u, r) => {
  receiveLegacyUnit(u, r, r.service);
  if (loaded(u) && JSON.stringify(u.command) !== JSON.stringify(r.expectedLegacyCommand ?? r.command)) fail('changed legacy command');
};
const serviceBound = (u, r) => u.LoadState === 'loaded' && u.FragmentPath === '/etc/systemd/system/' + r.service && !u.DropInPaths && u.User === r.user && u.WorkingDirectory === r.workingDirectory && sameCommand(u, r);
function receiveMachineFiles(files) {
  for (const f of files) {
    realDirectory('/etc', 0); realDirectory('/etc/systemd', 0); realDirectory('/etc/systemd/system', 0);
    try {
      const st = lstatSync(f.path);
      if (!st.isFile() || st.isSymbolicLink() || realpathSync(f.path) !== f.path || st.uid !== 0 || (st.mode & 0o022)) fail('unsafe machine target ' + f.path);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}


// Retirement keeps the original declarations and application outcomes. It owns
// only future timer activation; an active service is held for native completion.
const retiredTimer = (u, native) => ['disabled', 'masked'].includes(u.UnitFileState)
  && native.quiet(u) && !u.NextElapseUSecRealtime && !Number(u.NextElapseUSecMonotonic);
const retiredCurrent = (x, r, native) => serviceBound(x.service, r)
  && x.timer.LoadState === 'loaded' && x.timer.FragmentPath === '/etc/systemd/system/' + r.timer
  && !x.timer.DropInPaths && retiredTimer(x.timer, native) && native.quiet(x.service)
  && (!x.legacyTimer || native.quiet(x.legacyTimer)) && (!x.legacyService || native.quiet(x.legacyService));
function receiveRetirement(r, native) {
  const owner = native.passwd(r.user);
  if (owner.name !== r.user || owner.uid !== r.uid || owner.home !== r.home) fail('retired native owner identity changed');
  const service = native.unit(r, 'system', r.service), timer = native.unit(r, 'system', r.timer);
  if (!serviceBound(service, r) || timer.LoadState !== 'loaded'
      || timer.FragmentPath !== '/etc/systemd/system/' + r.timer || timer.DropInPaths)
    fail('unreceived retired system declaration');
  if (r.replacesUserTimer) {
    receiveLegacyUnit(native.unit(r, 'user', r.timer), r, r.timer);
    receiveLegacyCommand(native.unit(r, 'user', r.service), r);
  }
}

export function planManagedTimers(parameters, { root = '', native = nativeManagedTimerPort(), planFiles } = {}) {
  const declarations = managedTimerDeclarations(parameters);
  const files = planFiles(renderManagedTimerFiles(parameters, root));
  const live = root ? [] : declarations.map(r => ({ name: r.name,
    timer: native.unit(r, 'system', r.timer), service: native.unit(r, 'system', r.service),
    legacyTimer: r.replacesUserTimer ? native.unit(r, 'user', r.timer) : null,
    legacyService: r.replacesUserTimer ? native.unit(r, 'user', r.service) : null }));
  const current = files.every(f => f.state === 'current') && live.every(x => {
    const r = declarations.find(r => r.name === x.name);
    return r.state === 'retired' ? retiredCurrent(x, r, native)
      : serviceBound(x.service, r) && activeTimer(x.timer) && (!x.legacyTimer || x.legacyTimer.ActiveState === 'inactive') && (!x.legacyService || native.quiet(x.legacyService));
  });
  return { type: 'WslManagedTimerPlan', current, files, live };
}

// The original applyPlan remains the only file writer. Application cursors/jobs are untouched.
export function applyManagedTimers(parameters, { root = '', native = nativeManagedTimerPort(), planFiles, applyPlan, receiveInputs = receiveManagedTimerInputs, receiveTargets = receiveMachineFiles } = {}) {
  const allDeclarations = managedTimerDeclarations(parameters);
  const declarations = allDeclarations.filter(r => r.state === 'enabled');
  const retired = allDeclarations.filter(r => r.state === 'retired');
  let plan = planManagedTimers(parameters, { root, native, planFiles });
  if (root) return { type: 'WslManagedTimerApply', ...applyPlan(plan.files, { staged: true }), converged: true, staged: true };
  if (native.uid() !== 0) fail('root required before any machine change');
  for (const r of declarations) receiveInputs(r, native);
  for (const r of retired) receiveRetirement(r, native);
  receiveTargets(plan.files);
  if (plan.current) return { type: 'WslManagedTimerApply', written: [], ran: [], converged: true };
  const ran = [];
  let phase = 'preflight';
  const command = (r, manager, args) => { native.run(r, manager, args); ran.push({ manager, args }); };
  try {
    // Refuse an unknown system declaration before stopping the old timer.
    for (const r of declarations) {
      const service = native.unit(r, 'system', r.service);
      if (loaded(service) && service.FragmentPath !== '/etc/systemd/system/' + r.service) fail('conflicting system service');
      if (r.replacesUserTimer) for (const unit of [r.timer, r.service]) {
        const old = native.unit(r, 'user', unit);
        if (unit === r.service) receiveLegacyCommand(old, r);
        else receiveLegacyUnit(old, r, unit);
      }
    }
    phase = 'retire';
    for (const r of retired) {
      // Re-receive the original role immediately before the only lifecycle effect.
      receiveRetirement(r, native);
      if (!retiredTimer(native.unit(r, 'system', r.timer), native)) command(r, 'system', ['disable', '--now', r.timer]);
      if (r.replacesUserTimer) {
        const old = native.unit(r, 'user', r.timer);
        receiveLegacyUnit(old, r, r.timer);
        if (!native.quiet(old)) command(r, 'user', ['stop', r.timer]);
      }
    }
    phase = 'retire-drain';
    const retirement = planManagedTimers(parameters, { native, planFiles });
    for (const r of retired) {
      receiveRetirement(r, native);
      if (!retiredCurrent(retirement.live.find(x => x.name === r.name), r, native))
        fail('retired role remains unreceived or running; service and application state preserved');
    }
    if (declarations.length === 0) return { type: 'WslManagedTimerApply', written: [], ran, converged: retirement.current };
    phase = 'drain';
    // Pause an existing system timer as well before changing a running declaration.
    for (const r of declarations) {
      const timer = native.unit(r, 'system', r.timer);
      if (loaded(timer) && timer.ActiveState !== 'inactive') command(r, 'system', ['stop', r.timer]);
    }
    for (const r of declarations) {
      if (r.replacesUserTimer) {
        // Bind the captured original command afresh immediately before pausing its timer.
        receiveLegacyCommand(native.unit(r, 'user', r.service), r);
        const timer = native.unit(r, 'user', r.timer);
        receiveLegacyUnit(timer, r, r.timer);
        if (loaded(timer) && timer.ActiveState !== 'inactive') command(r, 'user', ['stop', r.timer]);
        while (!native.quiet(native.unit(r, 'user', r.service))) native.wait();
        let old = native.unit(r, 'user', r.service);
        if (old.ActiveState === 'failed') command(r, 'user', ['reset-failed', r.service]);
        // reset-failed can collect a transient; never use its stale loaded fact.
        old = native.unit(r, 'user', r.service);
        if (!native.quiet(old)) fail('legacy service changed after drain');
        receiveLegacyCommand(old, r);
        if (loaded(old)) command(r, 'user', ['stop', r.service]);
      }
      while (!native.quiet(native.unit(r, 'system', r.service))) native.wait();
      receiveInputs(r, native);
    }
    phase = 'write';
    plan = planManagedTimers(parameters, { native, planFiles });
    receiveTargets(plan.files);
    const out = applyPlan(plan.files, { staged: true });
    if (out.written.length || declarations.some(r => !serviceBound(native.unit(r, 'system', r.service), r))) command(declarations[0], 'system', ['daemon-reload']);
    phase = 'enable';
    for (const r of declarations) if (!activeTimer(native.unit(r, 'system', r.timer))) command(r, 'system', ['enable', '--now', r.timer]);
    phase = 'receive';
    const after = planManagedTimers(parameters, { native, planFiles });
    if (!after.current) fail('selected timer did not converge');
    return { type: 'WslManagedTimerApply', written: out.written, ran, converged: true };
  } catch (error) {
    // Do not retry a partial native sequence or turn an uncertain outcome into success.
    error.managedTimerOutcome = { type: 'WslManagedTimerApply', phase, ran, converged: false, nativeMayHaveStarted: phase !== 'preflight' };
    throw error;
  }
}
