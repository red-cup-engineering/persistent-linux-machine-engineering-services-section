// Explicit terminal retirement, never a retention policy or a program runner.
import assert from 'node:assert/strict';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { nativeManagedTimerPort } from './managed-timers.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (path, root) => path === root || path.startsWith(root + '/');
const absolute = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path && !/[\x00-\x1f\x7f]/.test(path);
const fail = message => { throw new Error('user-unit retirement refused: ' + message); };
function binding(file) {
  assert.ok(absolute(file.path), 'exact absolute artifact path required');
  assert.match(file.dev, /^(0|[1-9][0-9]*)$/); assert.match(file.ino, /^[1-9][0-9]*$/);
  assert.ok(Number.isSafeInteger(file.mode) && file.mode >= 0 && file.mode <= 0o7777 && !(file.mode & 0o022));
  if (file.sha256 !== undefined) assert.match(file.sha256, /^[a-f0-9]{64}$/);
}
export function userUnitRetirements(parameters) {
  assert.equal(parameters.schema, 'wsl-host-parameters@1');
  const rows = parameters.linux?.userUnitRetirements ?? [];
  assert.ok(Array.isArray(rows)); const ids = new Set(), paths = new Set(), units = new Set();
  return rows.map(row => {
    assert.match(row.id, /^[a-z][a-z0-9-]*$/); assert.ok(!ids.has(row.id)); ids.add(row.id);
    assert.match(row.user, /^[a-z_][a-z0-9_-]*$/);
    assert.ok(Number.isSafeInteger(row.uid) && row.uid >= 0 && absolute(row.home) && row.home !== '/');
    assert.ok(typeof row.reason === 'string' && row.reason.trim());
    assert.ok(absolute(row.artifactRoot) && row.artifactRoot !== row.home && within(row.artifactRoot, row.home));
    assert.ok(Array.isArray(row.units) && row.units.length && Array.isArray(row.artifacts) && Array.isArray(row.directories));
    for (const unit of row.units) {
      assert.ok(typeof unit.unit === 'string' && basename(unit.unit) === unit.unit && !unit.unit.startsWith('-') && !/[\x00-\x1f\x7f]/.test(unit.unit) && /\.(service|timer)$/.test(unit.unit));
      assert.ok(!units.has(row.user + ':' + unit.unit)); units.add(row.user + ':' + unit.unit);
      assert.equal(unit.path, join(row.home, '.config/systemd/user', unit.unit));
      if (unit.unit.endsWith('.service')) {
        assert.ok(Array.isArray(unit.command) && unit.command.length && absolute(unit.command[0]));
        assert.ok(unit.command.every(x => typeof x === 'string' && !/[\x00-\x1f\x7f]/.test(x)));
      } else assert.equal(unit.command, undefined);
    }
    for (const file of [...row.units, ...row.artifacts]) {
      binding(file); assert.match(file.sha256, /^[a-f0-9]{64}$/);
      assert.ok(!paths.has(file.path)); paths.add(file.path);
      if (!row.units.includes(file)) assert.ok(within(file.path, row.artifactRoot) && file.path !== row.artifactRoot);
    }
    const directories = new Set();
    for (const file of row.artifacts) for (let parent = dirname(file.path); within(parent, row.artifactRoot); parent = dirname(parent)) directories.add(parent);
    assert.deepEqual([...row.directories.map(x => x.path)].sort(), [...directories].sort(), 'only exact artifact ancestors may be removed');
    for (const dir of row.directories) { binding(dir); assert.equal(dir.sha256, undefined); assert.ok(!paths.has(dir.path)); paths.add(dir.path); }
    return row;
  });
}
function ancestors(path, home, uid) {
  for (let current = dirname(path); within(current, home); current = dirname(current)) {
    let stat;
    try { stat = lstatSync(current); } catch (error) { if (error.code === 'ENOENT' && current !== home) continue; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(current) !== current || ![0, uid].includes(stat.uid) || stat.mode & 0o022) fail('redirected or writable ancestor, or changed owner ' + current);
    if (current === home) break;
  }
}
function metadata(stat, file, uid, directory = false) {
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || Number(stat.uid) !== uid
    || stat.dev.toString() !== file.dev || stat.ino.toString() !== file.ino || Number(stat.mode & 0o7777n) !== file.mode)
    fail('changed owner/identity/type/mode ' + file.path);
}
function unchangedStamp(before, after, path) {
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
    fail('content stamp changed during receiving ' + path);
}
function receiveFile(file, owner, { remove = false, directory = false } = {}) {
  ancestors(file.path, owner.home, owner.uid);
  let stat;
  try { stat = lstatSync(file.path, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return { path: file.path, status: 'absent' }; throw error; }
  metadata(stat, file, owner.uid, directory);
  if (directory) return { path: file.path, status: 'present' };
  const fd = openSync(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const held = fstatSync(fd, { bigint: true }); metadata(held, file, owner.uid); unchangedStamp(stat, held, file.path);
    if (hash(readFileSync(fd)) !== file.sha256) fail('changed content ' + file.path);
    const afterRead = fstatSync(fd, { bigint: true }); metadata(afterRead, file, owner.uid); unchangedStamp(stat, afterRead, file.path);
    const finalPath = lstatSync(file.path, { bigint: true }); metadata(finalPath, file, owner.uid); unchangedStamp(stat, finalPath, file.path);
    if (remove) unlinkSync(file.path);
    return { path: file.path, status: remove ? 'retired' : 'present', dev: file.dev, ino: file.ino, sha256: file.sha256 };
  } finally { closeSync(fd); }
}
function receiveUnits(row, native) {
  const owner = native.passwd(row.user);
  if (owner.name !== row.user || owner.uid !== row.uid || owner.home !== row.home) fail('native owner changed');
  return row.units.map(expected => {
    const unit = native.unit(row, 'user', expected.unit);
    if (unit.Id !== expected.unit) fail('native unit identity changed');
    if (!native.quiet(unit)) fail('active job/PID/cohort for ' + expected.unit);
    if (unit.LoadState !== 'not-found') {
      let fragmentAbsent = false;
      try { lstatSync(expected.path); } catch (error) { if (error.code === 'ENOENT') fragmentAbsent = true; else throw error; }
      const futureActivationAbsent = ['disabled', 'static'].includes(unit.UnitFileState)
        || fragmentAbsent && ['', 'not-found'].includes(unit.UnitFileState);
      if (unit.LoadState !== 'loaded' || unit.FragmentPath !== expected.path || unit.DropInPaths
        || !futureActivationAbsent) fail('unreceived or enabled native unit ' + expected.unit);
      if (expected.command && JSON.stringify(unit.command) !== JSON.stringify(expected.command)) fail('native command changed ' + expected.unit);
    }
    return { unit: expected.unit, loadState: unit.LoadState, activeState: unit.ActiveState, unitFileState: unit.UnitFileState, fragmentPath: unit.FragmentPath, command: unit.command };
  });
}
function projection(rows, root) {
  if (!root) return rows;
  const stat = lstatSync(root);
  if (!absolute(root) || realpathSync(root) !== root || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) fail('private owned staging root required');
  const mapped = path => join(root, path.slice(1));
  return rows.map(row => ({ ...row, home: mapped(row.home), artifactRoot: mapped(row.artifactRoot),
    units: row.units.map(file => ({ ...file, path: mapped(file.path) })), artifacts: row.artifacts.map(file => ({ ...file, path: mapped(file.path) })), directories: row.directories.map(file => ({ ...file, path: mapped(file.path) })) }));
}
function observe(rows, native, staged) {
  return rows.map(row => {
    const units = staged ? [] : receiveUnits(row, native);
    const files = [...row.units, ...row.artifacts].map(file => receiveFile(file, row));
    const directories = row.directories.map(file => receiveFile(file, row, { directory: true }));
    return { id: row.id, units, files, directories, current: files.every(x => x.status === 'absent') && directories.every(x => x.status === 'absent') && units.every(x => x.loadState === 'not-found') };
  });
}
export function planUserUnitRetirements(parameters, { root = '', native = nativeManagedTimerPort() } = {}) {
  const rows = projection(userUnitRetirements(parameters), root), items = observe(rows, native, Boolean(root));
  return { component: 'user-unit-retirement', staged: Boolean(root), current: !root && items.every(x => x.current), stagedCurrent: Boolean(root) && items.every(x => x.current), items };
}
export function applyUserUnitRetirements(parameters, options = {}) {
  if (Object.keys(options).some(key => key !== 'root')) fail('native mutation ports are not substitutable');
  const root = options.root ?? '', staged = Boolean(root), rows = projection(userUnitRetirements(parameters), root), native = staged ? null : nativeManagedTimerPort();
  observe(rows, native, staged); // Receive ALL selected files/units before the first effect.
  const retired = [], removedDirectories = [], ran = [], attempts = [];
  try {
    for (const row of rows) {
      for (const file of [...row.units, ...row.artifacts]) {
        if (!staged) receiveUnits(row, native);
        const attempt = { path: file.path, status: 'not-yet-received' }; attempts.push(attempt);
        const result = receiveFile(file, row, { remove: true }); attempt.status = result.status;
        if (result.status === 'retired') retired.push(result);
      }
      for (const dir of [...row.directories].sort((a, b) => b.path.length - a.path.length)) {
        if (receiveFile(dir, row, { directory: true }).status === 'absent') continue;
        try { rmdirSync(dir.path); removedDirectories.push(dir.path); }
        catch (error) { if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error; }
      }
      if (!staged) {
        const units = receiveUnits(row, native);
        if (units.some(x => x.loadState !== 'not-found')) {
          const command = { user: row.user, args: ['daemon-reload'], status: 'native-return-unreceived' }; ran.push(command);
          native.run(row, 'user', command.args); command.status = 'returned';
        }
      }
    }
    const items = observe(rows, native, staged), converged = items.every(x => x.current);
    if (!converged) fail('selected retirement remains partial; unexpected directory contents or native state retained');
    return { component: 'user-unit-retirement', staged, current: !staged && converged, stagedCurrent: staged && converged, retired, removedDirectories, ran, items };
  } catch (cause) {
    const remaining = rows.flatMap(row => [...row.units, ...row.artifacts, ...row.directories].map(file => {
      try { return receiveFile(file, row, { directory: row.directories.includes(file) }); }
      catch (error) { return { path: file.path, status: 'unknown', error: error.message }; }
    }));
    const nativeStatus = staged ? [] : rows.flatMap(row => row.units.map(expected => {
      try {
        const unit = native.unit(row, 'user', expected.unit);
        return { unit: expected.unit, status: 'received', loadState: unit.LoadState, activeState: unit.ActiveState,
          mainPid: unit.MainPID, controlPid: unit.ControlPID, job: unit.Job, controlGroup: unit.ControlGroup, quiet: native.quiet(unit) };
      } catch (error) { return { unit: expected.unit, status: 'unknown', error: error.message }; }
    }));
    throw Object.assign(new Error(cause.message, { cause }), { retirementOutcome: { staged, retired, removedDirectories, ran, attempts, remaining, nativeStatus, current: false } });
  }
}
