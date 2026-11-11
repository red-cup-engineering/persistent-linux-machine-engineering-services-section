// Record-owned retirement of a system timer and service this installer once rendered.
//
// A managed timer is a clock. When the clock is replaced by an event source, its record entry
// becomes a retirement: the entry names the unit, the owner and the exact bytes this installer
// installed, and the installer removes exactly those bytes. A changed or foreign file is refused,
// never deleted. Nothing here is specific to any one unit.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';

const fail = message => { throw new Error('managed timer retirement refused: ' + message); };
const scalar = v => typeof v === 'string' && v.length > 0 && v.length <= 8192 && !/[\x00-\x1f\x7f]/.test(v);
const digest = v => v === null || /^[a-f0-9]{64}$/.test(v ?? '');
const integer = (n, low, high) => Number.isSafeInteger(n) && n >= low && n <= high;

export const isRetirement = row => row !== null && typeof row === 'object' && Object.hasOwn(row, 'retire');

/** The record's retirement rows: `{ name, user, uid, retire: { reason, serviceSha256, timerSha256 } }`. */
export function retiredTimerDeclarations(parameters) {
  if (parameters.schema !== 'wsl-host-parameters@1') fail('unknown parameter schema');
  const rows = parameters.linux?.managedTimers ?? [];
  if (!Array.isArray(rows) || rows.length > 8) fail('bounded managedTimers array required');
  const names = new Set(rows.filter(r => r && typeof r.name === 'string').map(r => r.name));
  if (names.size !== rows.length) fail('unique simple unit name required');
  return rows.filter(isRetirement).map(r => {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(r.name ?? '')) fail('unique simple unit name required');
    if (JSON.stringify(Object.keys(r).sort()) !== JSON.stringify(['name', 'retire', 'uid', 'user'])) fail('a retirement carries only name, user, uid and retire');
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(r.user ?? '') || !integer(r.uid, 1, 2147483647)) fail('explicit unprivileged owner required');
    const k = r.retire;
    if (!k || typeof k !== 'object' || JSON.stringify(Object.keys(k).sort()) !== JSON.stringify(['reason', 'serviceSha256', 'timerSha256'])) fail('retire carries reason, serviceSha256 and timerSha256');
    if (!scalar(k.reason) || !digest(k.serviceSha256) || !digest(k.timerSha256)) fail('a reason and exact installed digests (or null for an absent file) are required');
    return { ...r, service: r.name + '.service', timer: r.name + '.timer',
      servicePath: '/etc/systemd/system/' + r.name + '.service', timerPath: '/etc/systemd/system/' + r.name + '.timer' };
  });
}

/** Native port additions: read a machine file's identity and remove one. */
export function machineFilePort({ lstat = lstatSync, read = readFileSync, real = realpathSync, unlink = unlinkSync } = {}) {
  return {
    machineFile: path => {
      try {
        const st = lstat(path);
        return { exists: true, regular: st.isFile() && !st.isSymbolicLink() && real(path) === path, uid: st.uid, mode: st.mode,
          sha256: createHash('sha256').update(read(path)).digest('hex') };
      } catch (e) { if (e.code === 'ENOENT') return { exists: false }; throw e; }
    },
    removeFile: path => unlink(path),
  };
}

const loaded = u => u.LoadState !== 'not-found';
const sound = (file, sha) => file.exists
  ? file.regular && file.uid === 0 && !(file.mode & 0o022) && file.sha256 === sha
  : sha === null;

/** Observe each retirement: is it done, pending or refused. */
export const planRetirements = (parameters, { native }) => retiredTimerDeclarations(parameters).map(r => planRetirement(r, native));

function planRetirement(r, native) {
  {
    const files = { service: native.machineFile(r.servicePath), timer: native.machineFile(r.timerPath) };
    const units = { service: native.unit(r, 'system', r.service), timer: native.unit(r, 'system', r.timer) };
    const gone = !files.service.exists && !files.timer.exists && !loaded(units.service) && !loaded(units.timer);
    const refusal = (files.service.exists && !sound(files.service, r.retire.serviceSha256) ? 'service file is not the installed bytes' : null)
      ?? (files.timer.exists && !sound(files.timer, r.retire.timerSha256) ? 'timer file is not the installed bytes' : null)
      ?? ((units.service.DropInPaths || units.timer.DropInPaths) ? 'drop-in overrides are present' : null);
    return { name: r.name, state: gone ? 'retired' : refusal ? 'refused' : 'pending', refusal, files, units };
  }
}

/** Retire every pending row. Root is required; a refusal changes nothing; a partial sequence is never retried. */
export function applyRetirements(parameters, { native, run }) {
  const ran = [];
  const command = (r, args) => { run(r, 'system', args); ran.push({ unit: r.name, args }); };
  for (const r of retiredTimerDeclarations(parameters)) {
    const plan = planRetirement(r, native);
    if (plan.state === 'retired') continue;
    if (plan.state === 'refused') fail(r.name + ': ' + plan.refusal);
    if (loaded(plan.units.timer) && plan.units.timer.ActiveState !== 'inactive') command(r, ['disable', '--now', r.timer]);
    else if (plan.units.timer.UnitFileState === 'enabled') command(r, ['disable', r.timer]);
    while (!native.quiet(native.unit(r, 'system', r.service))) native.wait();
    if (native.unit(r, 'system', r.service).ActiveState === 'failed') command(r, ['reset-failed', r.service]);
    // Re-observe immediately before removal: bytes that changed during the drain are not ours to delete.
    const after = planRetirement(r, native);
    if (after.state === 'refused') fail(r.name + ': ' + after.refusal);
    for (const [file, path] of [[after.files.timer, r.timerPath], [after.files.service, r.servicePath]])
      if (file.exists) { native.removeFile(path); ran.push({ unit: r.name, removed: path }); }
    command(r, ['daemon-reload']);
    if (planRetirement(r, native).state !== 'retired')
      fail(r.name + ': retirement did not converge');
  }
  return ran;
}
