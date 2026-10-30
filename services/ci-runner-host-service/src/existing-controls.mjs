// Resource controls for the retained flat runner installations (CR-8, CR-9).
//
// Each runner gets its declared ceiling (MemoryMax, no swap, CPU and I/O weight,
// nice) and is placed in the CI slice, and the slice gets one shared ceiling, so the
// runners together can never take more of the host than the record allots to CI.
// Convergence is idempotent: the rendered files are written when they differ, the
// manager is reloaded, and the ceilings are applied to running units at once. A
// unit's move into the slice takes effect at its next start; nothing is restarted.
// This never installs, registers, moves, cleans, starts or stops a runner.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { unitName } from './runner-layout.mjs';

const OWNED = '# Owned by ci-runner-host-service, rendered from the CI runner host record.';
const LIVE = ['MemoryMax', 'MemorySwapMax', 'CPUWeight', 'IOWeight'];
const SIZE = /^\d+(?:\.\d+)?[KMGT]?$/;

export function bytes(size) {
  const m = /^(\d+(?:\.\d+)?)([KMGT]?)$/.exec(String(size));
  assert.ok(m, `size like 3G required, got ${size}`);
  return Math.round(Number(m[1]) * 1024 ** ' KMGT'.indexOf(m[2] || ' '));
}

function controlsOf(record, r) {
  assert.match(String(r.memoryMax), SIZE, `${r.name}: memoryMax required`);
  for (const k of ['cpuWeight', 'ioWeight']) assert.ok(Number.isInteger(r[k]) && r[k] >= 1 && r[k] <= 10000, `${r.name}: ${k} 1-10000 required`);
  assert.ok(Number.isInteger(r.nice) && r.nice >= -20 && r.nice <= 19, `${r.name}: nice required`);
  assert.match(r.slice, /^[A-Za-z0-9_-]+\.slice$/, `${r.name}: slice required`);
  assert.ok(bytes(r.memoryMax) <= bytes(record.controls.sliceMemoryMax), `${r.name}: memoryMax ${r.memoryMax} exceeds the CI slice's ${record.controls.sliceMemoryMax}`);
  return { MemoryMax: r.memoryMax, MemorySwapMax: '0', CPUWeight: String(r.cpuWeight), IOWeight: String(r.ioWeight) };
}

export function renderDropin(record, r) {
  const c = controlsOf(record, r);
  return [OWNED, '[Service]', `Slice=${r.slice}`, `Nice=${r.nice}`, ...LIVE.map(k => `${k}=${c[k]}`), ''].join('\n');
}

export function renderSlice(record) {
  const c = record.controls;
  assert.match(String(c.sliceMemoryMax), SIZE, 'controls.sliceMemoryMax required');
  return [OWNED, '[Unit]', 'Description=CI runners on this host, under one memory ceiling', '', '[Slice]',
    `MemoryMax=${c.sliceMemoryMax}`, 'MemorySwapMax=0', `CPUWeight=${c.sliceCpuWeight ?? 20}`, `IOWeight=${c.sliceIoWeight ?? 20}`, ''].join('\n');
}

const readText = path => { try { return readFileSync(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

export function systemctlShow(unit, properties) {
  const out = execFileSync('/usr/bin/systemctl', ['--user', 'show', unit, '--no-pager', `--property=${properties.join(',')}`],
    { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
  return Object.fromEntries(out.trimEnd().split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

const sameLive = (want, have) => LIVE.every(k => k === 'MemoryMax' || k === 'MemorySwapMax'
  ? String(bytes(want[k])) === have[k] : want[k] === have[k]);

/** Read-only: what would change. Files are compared by content; ceilings by the running units' values. */
export function planExistingControls(record, { home = record.controls.home, show = systemctlShow, read = readText } = {}) {
  assert.equal(record.schema, 'ci-runner-host-parameters@1');
  assert.equal(record.controls?.mode, 'existing-flat', 'explicit controls-only flat layout required');
  assert.ok(Array.isArray(record.runners) && record.runners.length > 0, 'declared runners required');
  const userUnits = join(home, '.config/systemd/user');
  const slices = [...new Set(record.runners.map(r => r.slice))];
  assert.equal(slices.length, 1, 'all CI runners share one slice');
  const files = [{ path: join(userUnits, slices[0]), content: renderSlice(record) },
    ...record.runners.map(r => ({ path: join(userUnits, `${unitName(r)}.d`, '80-ci-runner-host-controls.conf'), content: renderDropin(record, r) }))]
    .map(f => {
      const current = read(f.path);
      assert.ok(current === null || current.startsWith(OWNED), `${f.path} exists and is not owned by ci-runner-host-service`);
      return { ...f, current: current === f.content };
    });
  const units = record.runners.map(r => {
    const want = controlsOf(record, r), have = show(unitName(r), ['Id', 'LoadState', 'ActiveState', 'Slice', ...LIVE]);
    return { name: unitName(r), want, have, live: sameLive(want, have), inSlice: have.Slice === r.slice, active: have.ActiveState };
  });
  return { type: 'CiRunnerExistingControlsPlan', changed: files.some(f => !f.current) || units.some(u => !u.live), files, units };
}

/** Write what differs, reload, and apply ceilings to running units now. */
export function applyExistingControls(record, { reload, setProperty, ...ports } = {}) {
  const plan = planExistingControls(record, ports);
  if (!plan.changed) return { changed: false, writes: [], live: [] };
  const writes = [];
  for (const f of plan.files.filter(x => !x.current)) {
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(`${f.path}.pending`, f.content, { mode: 0o644 });
    renameSync(`${f.path}.pending`, f.path);
    writes.push(f.path);
  }
  (reload ?? (() => execFileSync('/usr/bin/systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore', timeout: 30000 })))();
  const set = setProperty ?? ((unit, props) => execFileSync('/usr/bin/systemctl', ['--user', 'set-property', '--runtime', unit, ...props], { stdio: 'ignore', timeout: 30000 }));
  const live = [];
  for (const u of plan.units.filter(x => !x.live && x.active === 'active')) {
    set(u.name, LIVE.map(k => `${k}=${u.want[k]}`));
    live.push(u.name);
  }
  const after = planExistingControls(record, ports);
  return { changed: true, writes, live, pendingSlice: after.units.filter(u => !u.inSlice).map(u => u.name),
    unconverged: after.units.filter(u => !u.live && u.active === 'active').map(u => u.name) };
}

