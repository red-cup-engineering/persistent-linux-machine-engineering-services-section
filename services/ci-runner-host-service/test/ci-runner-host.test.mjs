import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, utimesSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { bytes, renderUnit, renderSlice, renderReconcile, renderHook, mergeEnv, workspacesToRemove, ancestorCeiling, paths, isVersion, diskMeasurementIsCurrent, measureRunnerDisk } from '../src/ci-runner-host.mjs';

const r = {
  name: 'box', scope: 'https://github.com/o/r', version: '2.0.0', root: '/srv/ci/box',
  retain: ['r/r'], diagDays: 7, slice: 'ci.slice', nice: 10, cpuWeight: 20, ioWeight: 20, memoryMax: '6G',
};

test('the unit yields by weight and nice, has one hard ceiling and never a soft one (CR-8, CR-9)', () => {
  const u = renderUnit(r);
  for (const l of ['Slice=ci.slice', 'Nice=10', 'CPUWeight=20', 'IOWeight=20', 'MemoryMax=6G', 'WorkingDirectory=/srv/ci/box', 'ExecStart=/srv/ci/box/bin/runsvc.sh']) assert.ok(u.includes(`${l}\n`), l);
  assert.doesNotMatch(u, /MemoryHigh/);
});

test('every path comes from the record (CR-2, CR-5)', () => {
  assert.deepEqual(paths(r), {
    runner: '/srv/ci/box', version: '/srv/ci/versions/2.0.0', hook: '/srv/ci/hooks/box-job-completed.sh',
    work: '/srv/ci/box/_work', diag: '/srv/ci/box/_diag', startHook: '/srv/ci/hooks/box-job-started.sh',
    slot: '/srv/ci/ci-job-slot.lock', slotHolder: '/srv/ci/ci-job-slot/box.pid', reconcilePending: '/srv/ci/reconcile-pending',
  });
});

test('.env keeps the runner\'s lines and sets the hook once (CR-6, CR-11)', () => {
  const once = mergeEnv('LANG=C.UTF-8\nPATH=/bin\n', 'ACTIONS_RUNNER_HOOK_JOB_COMPLETED', '/h.sh');
  assert.equal(once, 'LANG=C.UTF-8\nPATH=/bin\nACTIONS_RUNNER_HOOK_JOB_COMPLETED=/h.sh\n');
  assert.equal(mergeEnv(once, 'ACTIONS_RUNNER_HOOK_JOB_COMPLETED', '/h.sh'), once);
});

test('only unretained workspaces are removed; the runner\'s own folders are not (CR-6)', () => {
  const e = [{ top: 'r', child: 'r' }, { top: 'r', child: 'old' }, { top: 'x', child: 'x' }, { top: '_tool', child: 'node' }];
  assert.deepEqual(workspacesToRemove(e, ['r/r']), ['r/old', 'x/x']);
});

test('the hook removes temp, stray workspaces and old diagnostics, and keeps caches (CR-6, CR-7)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-')), rr = { ...r, root };
  const p = paths(rr);
  for (const d of ['_temp/job1', 'r/r', 'r/old', 'x/x', '_tool/node']) mkdirSync(join(p.work, d), { recursive: true });
  mkdirSync(p.diag, { recursive: true });
  writeFileSync(join(p.diag, 'old.log'), ''); writeFileSync(join(p.diag, 'new.log'), '');
  const t = Date.now() / 1000 - 30 * 86400; utimesSync(join(p.diag, 'old.log'), t, t);
  writeFileSync(join(root, 'hook.sh'), renderHook(rr));
  execFileSync('bash', [join(root, 'hook.sh')]);
  assert.equal(existsSync(join(p.work, '_temp/job1')), false);
  assert.equal(existsSync(join(p.work, 'r/old')), false);
  assert.equal(existsSync(join(p.work, 'x')), false);
  assert.equal(existsSync(join(p.work, 'r/r')), true);
  assert.equal(existsSync(join(p.work, '_tool/node')), true);
  assert.equal(existsSync(join(p.diag, 'old.log')), false);
  assert.equal(existsSync(join(p.diag, 'new.log')), true);
});

test('recently used workspaces are caches, the finished job\'s is marked used, and maxBytes evicts the least recent (CR-12)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-recent-')), rr = { ...r, root, retain: [], retainRecentDays: 7, maxBytes: '64K' };
  const p = paths(rr), age = (d, days) => { const t = Date.now() / 1000 - days * 86400; utimesSync(join(p.work, d), t, t); };
  for (const d of ['_temp/job1', 'a/a', 'b/b', 'old/old', 'job/job']) mkdirSync(join(p.work, d), { recursive: true });
  mkdirSync(p.diag, { recursive: true });
  age('a/a', 1); age('b/b', 2); age('old/old', 30); age('job/job', 30);
  writeFileSync(join(root, 'hook.sh'), renderHook(rr));
  // the job that just finished ran in job/job: it is the newest cache, though its checkout is old
  execFileSync('bash', [join(root, 'hook.sh')], { env: { ...process.env, GITHUB_WORKSPACE: join(p.work, 'job/job') } });
  assert.equal(existsSync(join(p.work, '_temp/job1')), false);
  assert.equal(existsSync(join(p.work, 'old')), false, 'unused for longer than retainRecentDays');
  for (const d of ['a/a', 'b/b', 'job/job']) assert.equal(existsSync(join(p.work, d)), true, d);
  // over maxBytes the least recently used goes first, the finished job's last
  writeFileSync(join(p.work, 'a/a/blob'), Buffer.alloc(48 * 1024)); writeFileSync(join(p.work, 'b/b/blob'), Buffer.alloc(48 * 1024));
  age('a/a', 1); age('b/b', 2);
  execFileSync('bash', [join(root, 'hook.sh')], { env: { ...process.env, GITHUB_WORKSPACE: join(p.work, 'job/job') } });
  assert.equal(existsSync(join(p.work, 'b')), false, 'least recently used evicted');
  assert.equal(existsSync(join(p.work, 'job/job')), true);
  // a workspace outside this runner's work folder is never touched
  assert.throws(() => renderHook({ ...rr, retainRecentDays: -1 }), /whole number/);
  rmSync(root, { recursive: true, force: true });
});

test('without retainRecentDays the hook keeps only the declared caches, as before (CR-6)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-static-')), rr = { ...r, root }, p = paths(rr);
  for (const d of ['r/r', 'x/x']) mkdirSync(join(p.work, d), { recursive: true });
  mkdirSync(p.diag, { recursive: true });
  writeFileSync(join(root, 'hook.sh'), renderHook(rr));
  execFileSync('bash', [join(root, 'hook.sh')], { env: { ...process.env, GITHUB_WORKSPACE: join(p.work, 'x/x') } });
  assert.equal(existsSync(join(p.work, 'x')), false); assert.equal(existsSync(join(p.work, 'r/r')), true);
  rmSync(root, { recursive: true, force: true });
});

test('a symlinked bin is not the installed version; hard-linked real directories are (CR-3)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cv-')), v = join(root, 'versions/1'), run = join(root, 'runner');
  for (const d of ['bin', 'externals']) mkdirSync(join(v, d), { recursive: true });
  writeFileSync(join(v, 'bin/Runner.Listener'), '');
  mkdirSync(run, { recursive: true });
  symlinkSync(join(v, 'bin'), join(run, 'bin')); symlinkSync(join(v, 'externals'), join(run, 'externals'));
  assert.equal(isVersion(run, v), false);
  rmSync(join(run, 'bin')); rmSync(join(run, 'externals'));
  for (const d of ['bin', 'externals']) execFileSync('cp', ['-al', join(v, d), join(run, d)]);
  assert.equal(isVersion(run, v), true);
});

test('the installed runner starts as CommonJS under an ES module owner', () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-commonjs-'));
  const runner = { ...r, root: join(root, 'state', 'runner') };
  const p = paths(runner);
  try {
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(root, 'commands'), { recursive: true });
    writeFileSync(join(root, 'commands', 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    mkdirSync(join(root, 'home', '.config', 'systemd', 'user'), { recursive: true });
    for (const dir of ['bin', 'externals']) mkdirSync(join(p.version, dir), { recursive: true });
    writeFileSync(join(p.version, 'bin', 'Runner.Listener'), 'fixture');
    writeFileSync(join(p.version, 'bin', 'RunnerService.js'), 'require("node:assert/strict");process.stdout.write("commonjs");\n');
    mkdirSync(p.runner, { recursive: true });
    writeFileSync(join(p.runner, '.runner'), JSON.stringify({ agentName: runner.name, gitHubUrl: runner.scope }));
    const source = new URL('../src/ci-runner-host.mjs', import.meta.url).href;
    const code = `import {apply} from ${JSON.stringify(source)}; await apply(${JSON.stringify({ runners: [runner] })});`;
    const environment = { ...process.env, HOME: join(root, 'home'), PATH: join(root, 'commands') + ':' + process.env.PATH };
    execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: environment });
    assert.equal(execFileSync(process.execPath, [join(p.runner, 'bin', 'RunnerService.js')], { encoding: 'utf8' }), 'commonjs');
    assert.equal(isVersion(p.runner, p.version), true);
    execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: environment });
    assert.equal(execFileSync(process.execPath, [join(p.runner, 'bin', 'RunnerService.js')], { encoding: 'utf8' }), 'commonjs');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a parent cap below the runner\'s ceiling is found (CR-9)', () => {
  const max = { '/user.slice': '3221225472', '/user.slice/user-1000.slice': 'max', '/user.slice/user-1000.slice/user@1000.service': 'max' };
  assert.equal(ancestorCeiling('/user.slice/user-1000.slice/user@1000.service/ci.slice/ci-runner-box.service', (c) => max[c] ?? 'max'), 3221225472);
  assert.equal(ancestorCeiling('/a/b/c', () => 'max'), null);
  assert.equal(bytes('6G'), 6 * 1024 ** 3);
});

test('the shared slice carries the record\'s one hard ceiling and no swap (CR-8, CR-9)', () => {
  const sl = renderSlice({ sliceMemoryMax: '4G' });
  assert.ok(sl.includes('MemoryMax=4G\n')); assert.ok(sl.includes('MemorySwapMax=0\n')); assert.doesNotMatch(sl, /MemoryHigh/);
});


test('a disk measurement is read from its record until it is older than the measuring interval', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  assert.equal(diskMeasurementIsCurrent({ measuredAt: '2026-11-01T01:00:00Z', total: 5 }, now, 24), true);
  assert.equal(diskMeasurementIsCurrent({ measuredAt: '2026-10-31T11:00:00Z', total: 5 }, now, 24), false);
  assert.equal(diskMeasurementIsCurrent({ measuredAt: 'not a date', total: 5 }, now, 24), false);
  assert.equal(diskMeasurementIsCurrent({ measuredAt: '2026-11-01T01:00:00Z' }, now, 24), false);
  assert.equal(diskMeasurementIsCurrent({ measuredAt: '2026-11-01T13:00:00Z', total: 5 }, now, 24), false);
  assert.equal(diskMeasurementIsCurrent({ measuredAt: '2026-11-01T01:00:00Z', total: -1 }, now, 24), false);
  assert.equal(diskMeasurementIsCurrent(null, now, 24), false);
});

test('a failed runner disk reading is unknown and does not replace its cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'runner-disk-receiving-'));
  try {
    const cache = join(root, 'disk-usage.json');
    const legacy = '{"measuredAt":"2026-11-01T11:01:00Z","total":0}\n';
    writeFileSync(cache, legacy);
    const r = { root }, p = { work: join(root, 'work'), diag: join(root, 'diag') };
    const now = () => Date.parse('2026-11-01T12:00:00Z');
    assert.equal(measureRunnerDisk(r, p, { now, measure: () => assert.fail('plan is read-only') }), null);
    const failure = measureRunnerDisk(r, p, { now, refresh: true, measure() {
      throw Object.assign(new Error('disk read refused'), { code: 'EIO' });
    } });
    assert.equal(failure, null);
    assert.equal(readFileSync(cache, 'utf8'), legacy);
    // An older zero (previously also returned on every measurement error)
    // is not evidence. A positive native observation can replace it.
    let calls = 0;
    const measured = measureRunnerDisk(r, p, { now, refresh: true, measure() { return ++calls * 10; } });
    assert.equal(measured.total, 10);
    assert.equal(calls, 3);
    assert.deepEqual(measureRunnerDisk(r, p, { now, measure: () => assert.fail('must reuse valid cache') }), measured);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the actual plan command does not walk or write an unmeasured runner disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'runner-disk-plan-'));
  try {
    const runner = join(root, 'runner'), bin = join(root, 'bin'), marker = join(root, 'measurement-ran');
    mkdirSync(runner);
    mkdirSync(bin);
    for (const name of ['systemctl', 'journalctl'])
      writeFileSync(join(bin, name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    writeFileSync(join(bin, 'ionice'), '#!/bin/sh\n: > "$MEASUREMENT_MARKER"\nexit 1\n', { mode: 0o700 });
    const parameters = join(root, 'runner.json');
    writeFileSync(parameters, JSON.stringify({ schema: 'ci-runner-host-parameters@1',
      runners: [{ ...r, root: runner, maxBytes: '100G' }] }));
    const cli = new URL('../scripts/ci-runner-host.mjs', import.meta.url);
    const result = spawnSync(process.execPath, [cli.pathname, 'plan', `--parameters=${parameters}`], {
      env: { PATH: bin, HOME: root, MEASUREMENT_MARKER: marker }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stdout, /unobserved\s+CR-10.*no current measured runner usage receipt/u);
    assert.equal(existsSync(marker), false, 'plan cannot launch the usage measurement');
    assert.equal(existsSync(join(runner, 'disk-usage.json')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the reconcile runs when its record changes, never on a calendar (CR-30)', () => {
  const u = renderReconcile({ host: 'box', parametersPath: '/r/ci.json', reconcile: true }, { node: '/bin/node', cli: '/s/ci-runner-host.mjs' });
  assert.ok(u.service.includes('ExecStart="/bin/node" "/s/ci-runner-host.mjs" apply "--parameters=/r/ci.json"\n'));
  assert.ok(u.path.includes('PathChanged=/r/ci.json\n'));
  assert.ok(u.path.includes('Unit=ci-runner-host-reconcile.service\n'));
  assert.equal('timer' in u, false);
  assert.doesNotMatch(u.service + u.path, /OnCalendar|OnUnitActiveSec/);
});

test('a runner whose process started before its unit or .env changed runs stale configuration (CR-32)', async () => {
  const { staleConfiguration } = await import('../src/ci-runner-host.mjs');
  assert.equal(staleConfiguration({ activeSince: 100, unitModified: 50, envModified: 150 }), true);
  assert.equal(staleConfiguration({ activeSince: 100, unitModified: 150, envModified: 50 }), true);
  assert.equal(staleConfiguration({ activeSince: 100, unitModified: 50, envModified: 90 }), false);
  assert.equal(staleConfiguration({ activeSince: NaN, unitModified: 150, envModified: 150 }), false);
  assert.equal(staleConfiguration({ activeSince: 100, unitModified: NaN, envModified: NaN }), false);
});

test('the reconcile runs the declared release, never the copy that ran apply (CR-34)', async () => {
  const { releasePlan } = await import('../src/ci-runner-host.mjs');
  const reconcile = { source: 'https://github.com/o/service.git', commit: 'c'.repeat(40), root: '/state/ci-runner-host-service-release' };
  assert.equal(releasePlan(reconcile).cli, '/state/ci-runner-host-service-release/services/ci-runner-host-service/scripts/ci-runner-host.mjs');
  for (const bad of [true, {}, { ...reconcile, commit: 'main' }, { ...reconcile, root: 'relative' }, { ...reconcile, source: 'file:///tmp/x' }])
    assert.throws(() => releasePlan(bad), /reconcile names/);
});
