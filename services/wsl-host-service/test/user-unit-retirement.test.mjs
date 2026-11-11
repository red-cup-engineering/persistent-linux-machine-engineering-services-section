import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmodSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { nativeManagedTimerPort } from '../src/managed-timers.mjs';
import { applyUserUnitRetirements, planUserUnitRetirements, userUnitRetirements } from '../src/user-unit-retirement.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wsl-unit-retirement-')), created = lstatSync(root);
  t.after(() => { const now = lstatSync(root); assert.equal(now.dev, created.dev); assert.equal(now.ino, created.ino); rmSync(root, { recursive: true }); });
  const home = '/home/fixture', actual = path => join(root, path.slice(1)), host = home + '/source/host';
  const paths = [home + '/.config/systemd/user/old-job.timer', home + '/.config/systemd/user/old-job.service', host + '/script.sh', host + '/systemd-user/template.service'];
  for (const path of paths) { mkdirSync(dirname(actual(path)), { recursive: true, mode: 0o700 }); writeFileSync(actual(path), 'obsolete fixture: ' + path + '\n', { mode: 0o644 }); }
  const binding = (path, directory = false) => {
    const s = lstatSync(actual(path), { bigint: true });
    return { path, dev: s.dev.toString(), ino: s.ino.toString(), mode: Number(s.mode & 0o777n), ...(directory ? {} : { sha256: createHash('sha256').update(readFileSync(actual(path))).digest('hex') }) };
  };
  const row = { id: 'old-job', user: 'fixture', uid: process.getuid(), home, artifactRoot: host, reason: 'Explicit original fixture retirement',
    units: [{ ...binding(paths[0]), unit: 'old-job.timer' }, { ...binding(paths[1]), unit: 'old-job.service', command: [host + '/script.sh'] }],
    artifacts: paths.slice(2).map(path => binding(path)), directories: [binding(host + '/systemd-user', true), binding(host, true)] };
  const parameters = { schema: 'wsl-host-parameters@1', linux: { userUnitRetirements: [row] } };
  const nativeRow = { ...row, home: actual(row.home), artifactRoot: actual(row.artifactRoot),
    units: row.units.map(f => ({ ...f, path: actual(f.path), ...(f.command ? { command: f.command.map(actual) } : {}) })), artifacts: row.artifacts.map(f => ({ ...f, path: actual(f.path) })), directories: row.directories.map(f => ({ ...f, path: actual(f.path) })) };
  const nativeParameters = { schema: parameters.schema, linux: { userUnitRetirements: [nativeRow] } };
  const native = { passwd: () => ({ name: row.user, uid: row.uid, home: nativeRow.home }), quiet: nativeManagedTimerPort().quiet,
    unit: (_row, manager, name) => { assert.equal(manager, 'user'); const f = nativeRow.units.find(x => x.unit === name); return { Id: name, LoadState: 'loaded', ActiveState: 'inactive', MainPID: '0', ControlPID: '0', Job: '', ControlGroup: '', FragmentPath: f.path, UnitFileState: name.endsWith('.timer') ? 'disabled' : 'static', DropInPaths: '', command: f.command }; } };
  return { root, actual, row, paths, parameters, nativeParameters, native };
}
test('exact staged retirement removes only selected files/empty directories and has zero native authority on reentry', t => {
  const f = fixture(t), first = applyUserUnitRetirements(f.parameters, { root: f.root });
  assert.equal(first.stagedCurrent, true); assert.equal(first.current, false); assert.equal(first.staged, true);
  assert.equal(first.retired.length, 4); assert.equal(first.removedDirectories.length, 2); assert.deepEqual(first.ran, []);
  for (const path of f.paths) assert.equal(existsSync(f.actual(path)), false);
  const second = applyUserUnitRetirements(f.parameters, { root: f.root });
  assert.deepEqual(second.retired, []); assert.deepEqual(second.removedDirectories, []); assert.deepEqual(second.ran, []); assert.equal(second.stagedCurrent, true);
});
test('changed content refuses before any selected file is unlinked', t => {
  const f = fixture(t); writeFileSync(f.actual(f.paths.at(-1)), 'foreign changed source');
  assert.throws(() => applyUserUnitRetirements(f.parameters, { root: f.root }), /changed content/);
  assert.ok(f.paths.every(path => existsSync(f.actual(path))));
});
test('same bytes at a replacement inode refuse before any unlink', t => {
  const f = fixture(t), path = f.actual(f.paths[0]), replacement = path + '.replacement';
  writeFileSync(replacement, readFileSync(path), { mode: 0o644 }); renameSync(replacement, path);
  assert.throws(() => applyUserUnitRetirements(f.parameters, { root: f.root }), /identity/);
  assert.ok(f.paths.every(path => existsSync(f.actual(path))));
});
test('an actual same-inode write after the mutation read preserves the changed file', t => {
  const f = fixture(t), path = f.actual(f.paths[0]), initial = lstatSync(path, { bigint: true }), initialBytes = readFileSync(path), originalRead = fs.readFileSync;
  let reads = 0, injected = false;
  fs.readFileSync = (input, ...options) => {
    const bytes = originalRead(input, ...options);
    if (typeof input === 'number') {
      const stat = fstatSync(input, { bigint: true });
      if (stat.dev === initial.dev && stat.ino === initial.ino && ++reads === 2) {
        // First read is whole-operation preflight; second is the actual unlink
        // receiver. Overwrite equal-length content without changing its inode or permissions.
        const changed = Buffer.from(bytes); changed[0] ^= 1; writeFileSync(path, changed);
        utimesSync(path, new Date(), new Date(Number(initial.mtimeMs) + 1000));
        assert.equal(lstatSync(path, { bigint: true }).ino, initial.ino); injected = true;
      }
    }
    return bytes;
  };
  syncBuiltinESMExports();
  try { assert.throws(() => applyUserUnitRetirements(f.parameters, { root: f.root }), /content stamp changed/); }
  finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); }
  assert.equal(injected, true); assert.ok(f.paths.every(path => existsSync(f.actual(path))));
  assert.equal(readFileSync(path).length, initialBytes.length); assert.notDeepEqual(readFileSync(path), initialBytes);
});
test('wrong recorded owner and changed directory identity/mode refuse', t => {
  const f = fixture(t), wrong = structuredClone(f.parameters); wrong.linux.userUnitRetirements[0].uid += 1;
  assert.throws(() => applyUserUnitRetirements(wrong, { root: f.root }), /owner/);
  chmodSync(f.actual(f.row.artifactRoot), 0o755);
  assert.throws(() => applyUserUnitRetirements(f.parameters, { root: f.root }), /mode/);
  assert.ok(f.paths.every(path => existsSync(f.actual(path))));
});
test('redirecting an artifact ancestor cannot select the same file through a symlink', t => {
  const f = fixture(t), path = f.actual(f.row.artifactRoot); renameSync(path, path + '-original'); symlinkSync(path + '-original', path);
  assert.throws(() => applyUserUnitRetirements(f.parameters, { root: f.root }), /redirected/);
  assert.ok(existsSync(f.actual(f.paths[0]))); assert.ok(existsSync(f.actual(f.paths[1])));
});
test('native active state, PID, control process, job and unreceived cohort each refuse the readonly plan', t => {
  const f = fixture(t); assert.equal(planUserUnitRetirements(f.nativeParameters, { native: f.native }).current, false);
  for (const change of [{ ActiveState: 'active' }, { MainPID: '7' }, { ControlPID: '8' }, { Job: '9' }]) {
    const port = { ...f.native, unit: (...args) => ({ ...f.native.unit(...args), ...change }) };
    assert.throws(() => planUserUnitRetirements(f.nativeParameters, { native: port }), /active job\/PID\/cohort/);
  }
  assert.throws(() => planUserUnitRetirements(f.nativeParameters, { native: { ...f.native, quiet: () => false } }), /cohort/);
  assert.ok(f.paths.every(path => existsSync(f.actual(path))));
});
test('enabled, foreign fragment, drop-in, command and native-owner drift refuse', t => {
  const f = fixture(t);
  for (const change of [{ UnitFileState: 'enabled' }, { FragmentPath: '/foreign.service' }, { DropInPaths: '/unknown.conf' }, { command: ['/bin/false'] }]) {
    const port = { ...f.native, unit: (...args) => ({ ...f.native.unit(...args), ...change }) };
    assert.throws(() => planUserUnitRetirements(f.nativeParameters, { native: port }));
  }
  assert.throws(() => planUserUnitRetirements(f.nativeParameters, { native: { ...f.native, passwd: () => ({ name: 'other', uid: f.row.uid, home: f.nativeParameters.linux.userUnitRetirements[0].home }) } }), /owner/);
});
test('missing files alone are not current while native systemd still holds the selected fragments', t => {
  const f = fixture(t); applyUserUnitRetirements(f.parameters, { root: f.root });
  const pending = planUserUnitRetirements(f.nativeParameters, { native: f.native }); assert.equal(pending.current, false);
  const cached = { ...f.native, unit: (...args) => ({ ...f.native.unit(...args), UnitFileState: '' }) };
  assert.equal(planUserUnitRetirements(f.nativeParameters, { native: cached }).current, false, 'missing file with cached native fragment requires reload');
  const gone = { ...f.native, unit: (_row, _manager, unit) => ({ Id: unit, LoadState: 'not-found', ActiveState: 'inactive', MainPID: '0' }) };
  assert.equal(planUserUnitRetirements(f.nativeParameters, { native: gone }).current, true);
});
test('unexpected directory data survives partial retirement and is never recursively removed', t => {
  const f = fixture(t), unknown = f.actual(f.row.artifactRoot) + '/unpublished-work'; writeFileSync(unknown, 'useful foreign bytes');
  let failure; try { applyUserUnitRetirements(f.parameters, { root: f.root }); } catch (error) { failure = error; }
  assert.match(failure.message, /partial/); assert.equal(failure.retirementOutcome.retired.length, 4);
  assert.equal(failure.retirementOutcome.attempts.length, 4);
  assert.ok(failure.retirementOutcome.remaining.some(item => item.path.endsWith('/host') && item.status === 'present'));
  assert.equal(readFileSync(unknown, 'utf8'), 'useful foreign bytes'); assert.ok(existsSync(dirname(unknown)));
  assert.throws(() => applyUserUnitRetirements(f.parameters, { root: f.root }), /partial/); assert.equal(readFileSync(unknown, 'utf8'), 'useful foreign bytes');
});
test('an injected positive native port cannot authorize production mutation', t => {
  const f = fixture(t); assert.throws(() => applyUserUnitRetirements(f.nativeParameters, { native: f.native }), /not substitutable/);
  assert.ok(f.paths.every(path => existsSync(f.actual(path))));
});
test('declarations cannot duplicate units/files, escape home or name unrelated directories', t => {
  const f = fixture(t);
  for (const change of [r => r.units.push(r.units[0]), r => r.artifacts.push(r.artifacts[0]), r => r.units[0].path = '/etc/systemd/system/old-job.timer', r => r.directories.push({ ...r.directories[0], path: '/unrelated' }), r => r.artifacts[0].mode = 0o666]) {
    const p = structuredClone(f.parameters); change(p.linux.userUnitRetirements[0]); assert.throws(() => userUnitRetirements(p));
  }
});
