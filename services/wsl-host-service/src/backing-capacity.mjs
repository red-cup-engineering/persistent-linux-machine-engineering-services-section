// Read-only physical capacity for the registered backing disk of this WSL root.
import assert from 'node:assert/strict';
import { readFileSync, statSync, statfsSync, realpathSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, resolve, win32 } from 'node:path';
import { release } from 'node:os';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const decimal = (v, name, positive = false) => {
  assert.equal(typeof v, 'string', `${name} must be a decimal string`);
  assert.match(v, /^(0|[1-9][0-9]*)$/, `${name} must be a nonnegative integer`);
  assert.ok(v.length <= 24 && (!positive || BigInt(v) > 0n), `${name} is out of range`);
  return v;
};
const text = (v, name) => { assert.ok(typeof v === 'string' && v.length > 0 && v.length <= 4096 && !v.includes('\0'), `${name} is invalid`); return v; };
const sameWindows = (a, b) => win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();
const nearestDevice = path => {
  let p = path;
  for (;;) {
    try { const real = realpathSync(p); return { real, device: String(statSync(real, { bigint: true }).dev) }; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A missing leaf may be materialized; an existing dangling redirect is unknown.
      try { if (lstatSync(p).isSymbolicLink()) throw new Error('dangling destination redirect has unknown backing volume'); }
      catch (inspect) { if (inspect.code !== 'ENOENT') throw inspect; }
      const parent = dirname(p); if (parent === p) throw error; p = parent;
    }
  }
};

export function validateBackingStorage(parameters) {
  assert.equal(parameters?.schema, 'wsl-host-parameters@1');
  const p = parameters?.windows?.backingStorage;
  assert.ok(p && typeof p === 'object' && !Array.isArray(p), 'windows.backingStorage is required');
  for (const k of ['distributionName', 'registryKey', 'basePath', 'vhdFileName', 'volumeId', 'powershell', 'wslpath', 'linuxMount']) text(p[k], k);
  assert.match(p.distributionName, /^[A-Za-z0-9._-]+$/, 'unsupported distribution name');
  assert.match(p.registryKey, /^HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i, 'registry key must name one registered distribution');
  assert.ok(win32.isAbsolute(p.basePath) && !p.basePath.split(/[\\/]/).includes('..'), 'invalid VHD base path');
  assert.equal(win32.basename(p.vhdFileName), p.vhdFileName, 'VHD filename must be a basename');
  assert.match(p.vhdFileName, /^[^\\/:]+\.vhdx$/i, 'invalid VHD filename');
  assert.match(p.volumeId, /^\\\\\?\\Volume\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}\\$/i, 'stable Windows volume ID required');
  assert.ok(isAbsolute(p.powershell) && /\/powershell\.exe$/i.test(p.powershell), 'absolute Windows PowerShell executable required');
  assert.ok(isAbsolute(p.wslpath) && /\/wslpath$/.test(p.wslpath), 'absolute native wslpath required');
  assert.equal(p.linuxMount, '/', 'this bounded port supports only the current distribution root');
  assert.ok(Number.isSafeInteger(p.timeoutMs) && p.timeoutMs >= 100 && p.timeoutMs <= 10000, 'invalid probe timeout');
  assert.ok(Number.isSafeInteger(p.maxAgeMs) && p.maxAgeMs >= p.timeoutMs && p.maxAgeMs <= 30000, 'invalid freshness limit');
  const q = p.policy; assert.ok(q && typeof q === 'object', 'physical capacity policy required');
  for (const k of ['minFreeBytes', 'growthBytes', 'overheadBytes']) decimal(q[k], k);
  assert.ok(typeof q.minFreePercent === 'number' && Number.isFinite(q.minFreePercent) && q.minFreePercent >= 0 && q.minFreePercent < 100 && /^\d+(?:\.\d{1,6})?$/.test(String(q.minFreePercent)), 'invalid physical reserve percentage');
  text(q.basis, 'physical policy basis');
  return p;
}

/** Health only: no admission reservation and no effects when headroom is low. */
export function assessBackingVolumeHeadroom(capacity) {
  assert.equal(capacity?.type, 'WslBackingVolumeCapacity');
  return capacity.volumes.map(v => {
    const p = v.policy, percent = String(p.minFreePercent), digits = (percent.split('.')[1] ?? '').length;
    const denominator = 100n * 10n ** BigInt(digits), numerator = BigInt(percent.replace('.', ''));
    const proportional = (BigInt(v.totalBytes) * numerator + denominator - 1n) / denominator;
    const reserve = proportional > BigInt(p.minFreeBytes) ? proportional : BigInt(p.minFreeBytes);
    const required = reserve + BigInt(p.growthBytes) + BigInt(p.overheadBytes);
    return { id: v.id, availableBytes: v.availableBytes, requiredBytes: String(required), admitted: BigInt(v.availableBytes) >= required, vhd: v.vhd };
  });
}

/** The volume's drvfs mount from mountinfo: Windows answers statfs and stat there, with no Windows process. */
const drvfsDrive = (mountinfo, mount) => {
  for (const line of mountinfo.split('\n')) {
    const [left, right] = line.split(' - '); if (!right) continue;
    const point = left.split(' ')[4].replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
    if (point !== mount) continue;
    const [fstype, , options] = right.split(' ');
    assert.ok(fstype === '9p' || fstype === 'drvfs', `${mount} is not a drvfs mount`);
    const drive = /(?:^|[;,])path=([A-Za-z]):\\(?:[;,]|$)/.exec(options);
    assert.ok(drive, `${mount} does not mount a whole Windows volume`);
    return drive[1].toUpperCase();
  }
  throw new Error(`${mount} is not mounted`);
};

/** No shell, mutation, Windows process, or generic command adapter. Test ports replace observations only. */
export function observeBackingVolumeCapacity(parameters, destinations, ports = {}) {
  const p = validateBackingStorage(parameters), now = ports.now ?? Date.now;
  text(p.volumeMount, 'volumeMount');
  assert.ok(isAbsolute(p.volumeMount) && !p.volumeMount.split('/').includes('..'), 'absolute drvfs mount of the backing volume required');
  const monotonic = ports.monotonic ?? (() => performance.now());
  const started = monotonic();
  assert.ok(Number.isFinite(started), 'unknown local monotonic observation clock');
  assert.match((ports.osRelease ?? release)(), /microsoft/i, 'capacity requires the current WSL host');
  const namedDistribution = (ports.environment ?? process.env).WSL_DISTRO_NAME;
  // A user service manager may omit this hint. Native root UNC is mandatory below.
  if (namedDistribution !== undefined) assert.equal(namedDistribution, p.distributionName, 'current WSL distribution differs from host record');
  assert.ok(Array.isArray(destinations) && destinations.length > 0 && destinations.length <= 32, 'one to 32 destinations required');
  assert.equal(new Set(destinations).size, destinations.length, 'duplicate destinations');
  for (const path of destinations) assert.ok(typeof path === 'string' && isAbsolute(path) && path.length <= 4096 && !path.includes('\0'), 'invalid destination');
  const deviceOf = ports.deviceOf ?? nearestDevice, mount = deviceOf(p.linuxMount);
  const mappings = destinations.map(path => {
    const actual = deviceOf(resolve(path));
    assert.equal(actual.device, mount.device, `unknown backing volume for ${path}`);
    assert.ok(isAbsolute(actual.real), 'invalid observed destination');
    return { path, linuxMount: p.linuxMount, device: actual.device, volumeId: p.volumeId };
  });
  const requestNonce = (ports.nonce ?? (() => randomBytes(32).toString('hex')))();
  assert.match(requestNonce, /^[0-9a-f]{64}$/, 'invalid capacity request challenge');
  const run = ports.run ?? ((program, args) => execFileSync(program, args, { encoding: 'utf8', timeout: p.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 32768, cwd: p.linuxMount }));
  const rootWindowsPath = run(p.wslpath, ['-w', mount.real]).trim();
  const expectedRoots = [`\\\\wsl.localhost\\${p.distributionName}\\`, `\\\\wsl$\\${p.distributionName}\\`];
  assert.ok(expectedRoots.some(x => sameWindows(rootWindowsPath, x)), 'native WSL root identity differs from registered distribution');
  const drive = drvfsDrive((ports.mountinfo ?? (() => readFileSync('/proc/self/mountinfo', 'utf8')))(), p.volumeMount);
  assert.equal(win32.parse(p.basePath).root.toUpperCase(), `${drive}:\\`, 'registered VHD base path is not on the declared backing volume');
  const vhdWindowsPath = win32.join(p.basePath, p.vhdFileName);
  const vhdPath = [p.volumeMount, ...vhdWindowsPath.slice(3).split('\\')].join('/');
  const fs = ports.statfs ?? (path => statfsSync(path, { bigint: true })), st = ports.lstat ?? (path => lstatSync(path, { bigint: true }));
  const volume = fs(p.volumeMount), file = st(vhdPath);
  assert.ok(file.isFile() && !file.isSymbolicLink(), 'registered VHD is not a regular file');
  const unit = volume.bsize, total = volume.blocks * unit, free = volume.bfree * unit, caller = volume.bavail * unit;
  assert.ok(unit > 0n && total > 0n && caller <= total && free <= total, 'invalid Windows free capacity');
  const allocated = file.blocks * 512n, length = file.size;
  assert.ok(length > 0n, 'VHD length is unknown');
  assert.ok(allocated <= total, 'VHD allocation exceeds physical volume');
  // NTFS attributes are not visible through drvfs. An uncompressed file allocated below its length is sparse.
  const sparse = allocated < length;
  const hex = (v, width) => (v & ((1n << BigInt(width * 4)) - 1n)).toString(16).padStart(width, '0');
  // Bind the destination mapping again after the observation.
  assert.equal(deviceOf(p.linuxMount).device, mount.device, 'root device changed during probe');
  for (const mapping of mappings) assert.equal(deviceOf(resolve(mapping.path)).device, mapping.device, 'destination device changed during probe');
  const elapsedMs = monotonic() - started;
  assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= p.maxAgeMs, 'stale or unknown local capacity observation');
  const at = new Date(now()).toISOString();
  return { type: 'WslBackingVolumeCapacity', version: 1, at,
    freshness: { requestNonce, producerAt: at, elapsedMs }, rootWindowsPath, mappings,
    volumes: [{ id: p.volumeId, totalBytes: String(total), availableBytes: String(free < caller ? free : caller), volumeFreeBytes: String(free), callerAvailableBytes: String(caller), allocationUnitBytes: String(unit),
      policy: { ...p.policy },
      vhd: { path: vhdWindowsPath, lengthBytes: String(length), allocatedBytes: String(allocated), allocationSource: 'drvfs-stat', fileIdentity: `${hex(file.dev, 8)}:${hex(file.ino, 16)}`, attributes: sparse ? 512 : 0, attributesSource: 'derived-from-allocation', sparse, compressed: false } }],
    admissionKind: 'snapshot-not-reservation' };
}
