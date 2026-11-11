#!/usr/bin/env node
// Retention for a machine's release root: what a successful receive keeps, and what it removes.
//   release-retention.mjs (MACHINE.json | --release-root DIR [--profile PROFILE]) [--dry-run] [--units DIR]...
// Kept: the `current` release, the `previous` release it replaced (the rollback target), the pre-Guix
// `current.before-guix` target, and every release a unit file's ExecStart/EnvironmentFile/WorkingDirectory
// names. Removed: other release trees, stale `.staging-*`/`.probe-*` scratch and empty
// `.materialization-*` markers directly under the release root. The release profile's older Guix generations
// are deleted with an explicit generation list, so `guix gc` can reclaim what only they held.
// Guix store outputs are never removed here: unrooted ones are the garbage collector's.
import {lstatSync,readdirSync,readFileSync,readlinkSync,realpathSync,rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute,join,resolve,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {isCliEntry} from './cli-entry.mjs';

export const TREE = /^[0-9a-f]{64}$/;
const SCRATCH_GRACE_MS = 60 * 60 * 1000;
const UNIT_KEYS = /^(ExecStart|ExecStartPre|ExecStartPost|ExecStop|ExecReload|EnvironmentFile|WorkingDirectory|Environment)=/;

const stat = (path) => { try { return lstatSync(path); } catch { return null; } };

// The entry of ROOT that PATH lies in, following a link entry to its target; null when it leads outside ROOT.
export function entryOf(root, path) {
  const base = resolve(root);
  const absolute = isAbsolute(path) ? resolve(path) : resolve(base, path);
  if (!absolute.startsWith(base + sep)) return null;
  const name = absolute.slice(base.length + 1).split(sep)[0];
  const link = stat(join(base, name));
  if (link?.isSymbolicLink()) {
    const target = readlinkSync(join(base, name));
    const inner = entryOf(root, isAbsolute(target) ? target : join(base, target));
    return inner;
  }
  return name;
}

// Entries of ROOT that unit files in DIRS name. A unit's paths are read as text; a path need not exist.
export function unitReferences(root, dirs) {
  const names = new Set();
  const base = resolve(root);
  for (const dir of dirs) {
    let files = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const file of files) {
      if (!/\.(service|socket|timer)$/.test(file)) continue;
      let text;
      try { text = readFileSync(join(dir, file), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!UNIT_KEYS.test(line.trim())) continue;
        for (const token of line.split(/[\s"'=]+/)) {
          const at = token.indexOf(base + sep);
          if (at < 0) continue;
          const path = token.slice(at).replace(/[;,)]+$/, '');
          const name = entryOf(root, path);
          if (name) names.add(name);
        }
      }
    }
  }
  return names;
}

// The kept/removed split of ROOT's entries. Entries it does not classify are never candidates.
export function planRetention({root, unitDirs = [], now = Date.now(), graceMs = SCRATCH_GRACE_MS}) {
  const keep = new Map();
  const mark = (name, reason) => { if (name && !keep.has(name)) keep.set(name, reason); };
  for (const [link, reason] of [['current', 'current release'], ['previous', 'previous release (rollback target)'],
                                ['current.before-guix', 'pre-Guix release (rollback target)']]) {
    if (stat(join(root, link))) mark(entryOf(root, join(root, link)), reason);
  }
  for (const name of unitReferences(root, unitDirs)) mark(name, 'named by a unit file');
  const remove = [];
  for (const name of readdirSync(root).sort()) {
    const info = stat(join(root, name));
    if (!info) continue;
    let kind = null;
    if (TREE.test(name) && info.isDirectory()) kind = 'release-tree';
    else if (name.startsWith('.staging-') && info.isDirectory()) kind = 'staging';
    else if (name.startsWith('.probe-') && info.isDirectory()) kind = 'probe';
    else if (name.startsWith('.materialization-') && info.isFile()) kind = 'materialization';
    if (!kind) continue;
    if (keep.has(name)) continue;
    // A scratch younger than the grace may belong to a receive that began before this lease.
    if ((kind === 'probe' || kind === 'staging') && now - info.mtimeMs < graceMs) { mark(name, 'scratch within grace'); continue; }
    remove.push({name, kind});
  }
  return {keep: [...keep].map(([name, reason]) => ({name, reason})), remove};
}

// Entries of ROOT that a live process maps, holds as its working directory or root, or names on its command line.
export function heldEntries(root, proc = '/proc') {
  const held = new Set();
  const base = resolve(root) + sep;
  const note = (path) => { const name = path.startsWith(base) ? path.slice(base.length).split(sep)[0] : null; if (name) held.add(name); };
  let pids = [];
  try { pids = readdirSync(proc).filter((p) => /^\d+$/.test(p)); } catch { return held; }
  for (const pid of pids) {
    for (const link of ['cwd', 'root', 'exe']) { try { note(readlinkSync(join(proc, pid, link))); } catch { /* gone or foreign */ } }
    try { for (const word of readFileSync(join(proc, pid, 'cmdline'), 'utf8').split('\0')) note(word); } catch { /* gone or foreign */ }
    try {
      for (const line of readFileSync(join(proc, pid, 'maps'), 'utf8').split('\n')) { const at = line.indexOf(base); if (at >= 0) note(line.slice(at)); }
    } catch { /* gone or foreign */ }
    try { for (const fd of readdirSync(join(proc, pid, 'fd'))) { try { note(readlinkSync(join(proc, pid, 'fd', fd))); } catch { /* closed */ } } } catch { /* foreign */ }
  }
  return held;
}

export function sizeOf(path) {
  const info = stat(path);
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of readdirSync(path)) total += sizeOf(join(path, name));
  return total;
}

export function applyRetention(root, plan, {held = new Set(), dryRun = false} = {}) {
  const removed = [], skipped = [];
  for (const item of plan.remove) {
    if (held.has(item.name)) { skipped.push({...item, reason: 'held by a live process'}); continue; }
    // Direct children only: never follow a name out of the release root.
    if (item.name.includes(sep) || item.name === '..' || item.name === '.') { skipped.push({...item, reason: 'not a direct child'}); continue; }
    const path = join(root, item.name);
    const bytes = sizeOf(path);
    if (!dryRun) rmSync(path, {recursive: true, force: true});
    removed.push({...item, bytes});
  }
  return {removed, skipped};
}

// `guix package --list-generations` text -> [{number, current, stores}].
export function parseGenerations(text) {
  const generations = [];
  for (const line of text.split('\n')) {
    const head = /^Generation (\d+)\s.*?(\(current\))?\s*$/.exec(line);
    if (head) { generations.push({number: Number(head[1]), current: Boolean(head[2]), stores: []}); continue; }
    const store = /(\/gnu\/store\/\S+)\s*$/.exec(line);
    if (store && generations.length) generations.at(-1).stores.push(store[1]);
  }
  return generations;
}

// The explicit `--delete-generations` pattern: every generation but the current one and those holding a kept store path. '' when none.
export function generationsToDelete(generations, keptStores) {
  const kept = new Set(keptStores);
  return generations.filter((g) => !g.current && !g.stores.some((s) => kept.has(s))).map((g) => g.number).join(',');
}

function readLink(path) { try { return realpathSync(path); } catch { return null; } }

export function retain(config, {unitDirs, dryRun = false, procRoot = '/proc', guix = 'guix'} = {}) {
  const root = config.releaseRoot;
  const dirs = unitDirs ?? [join(process.env.HOME ?? homedir(), '.config/systemd/user')];
  const plan = planRetention({root, unitDirs: dirs});
  const trees = applyRetention(root, plan, {held: heldEntries(root, procRoot), dryRun});
  const report = {root, kept: plan.keep, ...trees, generations: {deleted: '', skipped: 'no profile'}};
  if (config.guixProfile) {
    const kept = ['current', 'previous'].map((name) => readLink(join(root, name))).filter((p) => p?.startsWith('/gnu/store/'));
    const listed = spawnSync(guix, ['package', `--profile=${config.guixProfile}`, '--list-generations'], {encoding: 'utf8'});
    if (listed.status !== 0) report.generations = {deleted: '', skipped: 'generation listing failed'};
    else {
      const pattern = generationsToDelete(parseGenerations(listed.stdout), kept);
      report.generations = {deleted: pattern, kept: kept};
      if (pattern && !dryRun) {
        const done = spawnSync(guix, ['package', `--profile=${config.guixProfile}`, `--delete-generations=${pattern}`], {encoding: 'utf8'});
        if (done.status !== 0) report.generations = {deleted: '', skipped: 'generation deletion failed'};
      }
    }
  }
  return report;
}

if (isCliEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
  const units = args.flatMap((a, i) => (args[i - 1] === '--units' ? [a] : []));
  const file = args.find((a, i) => !a.startsWith('--') && !String(args[i - 1]).startsWith('--'));
  const config = file ? JSON.parse(readFileSync(file, 'utf8')) : {releaseRoot: flag('--release-root'), guixProfile: flag('--profile')};
  if (!config.releaseRoot) { console.error('usage: release-retention.mjs (MACHINE.json | --release-root DIR [--profile PROFILE]) [--dry-run] [--units DIR]...'); process.exit(2); }
  const report = retain(config, {unitDirs: units.length ? units : undefined, dryRun: args.includes('--dry-run')});
  // The receive's own stdout names its receipt; the report goes beside it on stderr.
  process.stderr.write(JSON.stringify({kind: 'release-retention', ...report}) + '\n');
}
