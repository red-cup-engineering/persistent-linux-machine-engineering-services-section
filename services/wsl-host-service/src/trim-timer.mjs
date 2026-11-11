// Host storage reclaims itself (Group rule host-storage-reclaims-itself, Leader 2026-10-25): a daily
// fstrim of the root filesystem, as a system service and timer rendered from the host record.
// With a sparse virtual disk, discarded blocks are deallocated on Windows; without the trim, a
// sparse disk never learns which blocks are free. Node built-ins only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

export const TRIM_SERVICE = 'wsl-fstrim.service';
export const TRIM_TIMER = 'wsl-fstrim.timer';

const line = (v, name) => { assert.ok(typeof v === 'string' && v.length > 0 && v.length <= 512 && /^[\x20-\x7e]+$/.test(v) && v.trim() === v, `linux.trimTimer.${name} must be one printable ASCII line`); return v; };
const absolute = (v, name) => { line(v, name); assert.ok(v.startsWith('/') && !/\s/.test(v) && !v.split('/').includes('..'), `linux.trimTimer.${name} must be an absolute path without spaces`); return v; };
const whole = (v, name, low, high) => { assert.ok(Number.isSafeInteger(v) && v >= low && v <= high, `linux.trimTimer.${name} must be an integer from ${low} to ${high}`); return v; };

/** Validates the record's declaration. Returns null when the record declares no trim timer. */
export function trimTimerDeclaration(linux) {
  const t = linux?.trimTimer;
  if (t === undefined) return null;
  assert.ok(t && typeof t === 'object' && !Array.isArray(t), 'linux.trimTimer must be an object');
  line(t.description, 'description');
  absolute(t.executable, 'executable');
  absolute(t.mountpoint, 'mountpoint');
  assert.match(line(t.calendar, 'calendar'), /^[A-Za-z0-9*:,./ -]+$/, 'linux.trimTimer.calendar must be a systemd calendar expression');
  whole(t.bootDelayMinutes, 'bootDelayMinutes', 1, 1440);
  whole(t.randomizedDelayMinutes, 'randomizedDelayMinutes', 0, 1440);
  whole(t.timeoutMinutes, 'timeoutMinutes', 5, 1440);
  if (t.comment !== undefined) assert.ok(Array.isArray(t.comment) && t.comment.every((c) => typeof c === 'string' && !/[\r\n]/.test(c)), 'linux.trimTimer.comment must be an array of lines');
  return t;
}

const comments = (c) => (c ?? []).map((l) => (l === '' ? '#' : `# ${l}`));

/**
 * The service trims once at idle I/O and CPU priority; the timer fires a few minutes after every boot
 * (a restarted VM has forgotten which block groups it trimmed) and daily after that, catching up on
 * a missed day.
 */
export function renderTrimUnits(linux) {
  const t = trimTimerDeclaration(linux);
  return {
    service: [
      ...comments(t.comment),
      '[Unit]',
      `Description=${t.description}`,
      'Documentation=man:fstrim(8)',
      `ConditionPathIsMountPoint=${t.mountpoint}`,
      '',
      '[Service]',
      'Type=oneshot',
      `ExecStart=${t.executable} --verbose ${t.mountpoint}`,
      'Nice=19',
      'IOSchedulingClass=idle',
      `TimeoutStartSec=${t.timeoutMinutes}min`,
      '',
    ].join('\n'),
    timer: [
      ...comments(t.comment),
      '[Unit]',
      `Description=${t.description}, shortly after boot and daily`,
      '',
      '[Timer]',
      `OnBootSec=${t.bootDelayMinutes}min`,
      `OnCalendar=${t.calendar}`,
      `RandomizedDelaySec=${t.randomizedDelayMinutes}min`,
      'Persistent=true',
      '',
      '[Install]',
      'WantedBy=timers.target',
      '',
    ].join('\n'),
  };
}

/** Properties of one systemd unit as {Name: value}, or null when systemd cannot be asked. */
export function systemdUnitState(unit, run = (cmd) => execFileSync(cmd[0], cmd.slice(1), { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] })) {
  try {
    const out = run(['systemctl', 'show', unit, '--no-pager', '--property=LoadState,UnitFileState,ActiveState,SubState,Result,NextElapseUSecRealtime,LastTriggerUSec']);
    return Object.fromEntries(out.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  } catch { return null; }
}

/**
 * The plan's view of the trim: the timer is enabled and waiting for its next trigger, and the last
 * trim did not fail. `unit(name)` answers systemdUnitState. The first check carries the hook that
 * repairs it; a failed trim has no hook, because only the next run can clear it.
 */
export function observeTrimTimer(linux, unit = systemdUnitState) {
  if (!trimTimerDeclaration(linux)) return [];
  const timer = unit(TRIM_TIMER), service = unit(TRIM_SERVICE);
  const next = timer?.NextElapseUSecRealtime ? timer.NextElapseUSecRealtime : null;
  const waiting = timer ? `${timer.UnitFileState || timer.LoadState || 'unknown'}, ${timer.ActiveState}${timer.SubState ? ` (${timer.SubState})` : ''}${next ? `, next trigger ${next}` : ''}` : null;
  const last = timer?.LastTriggerUSec && timer.LastTriggerUSec !== 'n/a' ? timer.LastTriggerUSec : 'never';
  return [
    { name: TRIM_TIMER, scope: 'linux', hook: 'trim-timer', want: 'enabled, active (waiting), next trigger scheduled', have: waiting, ok: timer?.UnitFileState === 'enabled' && timer?.ActiveState === 'active' && Boolean(next) },
    { name: `${TRIM_SERVICE} last result`, scope: 'linux', want: 'success', have: service ? `${service.Result || 'unknown'}; last trigger ${last}` : null, ok: service?.Result === 'success' },
  ];
}
