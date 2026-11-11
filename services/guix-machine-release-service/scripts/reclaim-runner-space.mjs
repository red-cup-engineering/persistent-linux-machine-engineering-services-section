#!/usr/bin/env node
// Free a release runner's disk before a build.
//   reclaim-runner-space.mjs WORK [--cache DIR] [--floor-bytes TARGET] [--min-free-bytes REQUIRED] [--dry-run]
// WORK is this run's own directory under its machine's runs cache (`<cache>/github-<machine>-runs/RUN-ATTEMPT`).
// Removed: every sibling of WORK in that cache (earlier runs' sources, artifacts and registry caches), and every
// `github-source-bootstrap` checkout older than the grace. Then `guix gc --free-space=FLOOR` reclaims unrooted store items.
// The caller holds the runner's build lease, so no sibling run is live; release roots and candidate GC roots are untouched.
import {lstatSync,readdirSync,rmSync,statfsSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename,dirname,join,resolve,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {isCliEntry} from './cli-entry.mjs';
import {sizeOf} from './release-retention.mjs';
import {collectionTarget} from './release-storage.mjs';

export const DEFAULT_FLOOR = 8 * 1024 ** 3;
// Operational observation: CRG run 38080498277 reclaimed to 6.93 GiB, but could not
// reach an 8 GiB target because remaining Guix store paths were rooted. Do not
// confuse a desirable cleanup target with minimum safe build capacity.
export const DEFAULT_BUILD_MINIMUM = 6 * 1024 ** 3;
const BOOTSTRAP_GRACE_MS = 24 * 60 * 60 * 1000;
const EXACT_REVISION = /^[0-9a-f]{40}$/;
const EXACT_RUN = /^[1-9][0-9]*-[1-9][0-9]*$/;
// A machine's runs cache sits directly in the house cache and is named for the machine.
const RUNS_CACHE = /^github-[a-z0-9]+(?:-[a-z0-9]+)*-runs$/;

export function freeBytes(path, statfs = statfsSync) { const s = statfs(path); return s.bavail * s.bsize; }

// Directory entries of DIR as {name, path, mtimeMs}; [] when DIR is missing.
function entries(dir) {
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  return names.flatMap((name) => { try { return [{name, path: join(dir, name), mtimeMs: lstatSync(join(dir, name)).mtimeMs}]; } catch { return []; } });
}

// Only exact owner/repo/SHA bootstrap checkouts are disposable. Never remove a whole
// owner directory: its mtime can be old while a newly bootstrapped descendant is live.
const directories = (dir) => entries(dir).filter(({path}) => {
  try {const info = lstatSync(path); return info.isDirectory() && !info.isSymbolicLink();} catch {return false;}
});
// The current controller is executed from inside its bootstrap SHA. Preserve it even if old.
export function planReclaim({work, bootstrapDir, activeBootstrap = process.env.RELEASE_CONTROLLER, now = Date.now(), graceMs = BOOTSTRAP_GRACE_MS}) {
  const keep = resolve(work), plan = [];
  for (const e of directories(dirname(keep))) if (EXACT_RUN.test(e.name) && resolve(e.path) !== keep) plan.push({path: e.path, kind: 'earlier-run'});
  for (const owner of directories(bootstrapDir ?? ''))
    for (const repository of directories(owner.path))
      for (const revision of directories(repository.path)) {
        if (!EXACT_REVISION.test(revision.name) || now - revision.mtimeMs < graceMs) continue;
        const path = resolve(revision.path), active = activeBootstrap && resolve(activeBootstrap);
        if (active && (active === path || active.startsWith(path + sep))) continue;
        plan.push({path, kind: 'old-bootstrap'});
      }
  return plan;
}

export function reclaim({work, cache = join(process.env.HOME ?? homedir(), '.cache/561-group'), floor = DEFAULT_FLOOR, minimum = Math.min(floor, DEFAULT_BUILD_MINIMUM), dryRun = false, guix = 'guix', statfs = statfsSync, activeBootstrap} = {}) {
  const runs = dirname(resolve(work ?? '.'));
  if (!work || !RUNS_CACHE.test(basename(runs)) || dirname(runs) !== resolve(cache) || !EXACT_RUN.test(basename(resolve(work)))) throw new Error('WORK must be an exact RUN-ATTEMPT directory in a github-<machine>-runs cache of the house cache');
  if (!Number.isSafeInteger(floor) || floor < 1) throw new TypeError('free space floor must be positive integer bytes');
  if (!Number.isSafeInteger(minimum) || minimum < 1 || minimum > floor) throw new TypeError('build minimum must be a positive integer no greater than cleanup target');
  const before = freeBytes(dirname(resolve(work)), statfs);
  const removed = planReclaim({work, bootstrapDir: join(cache, 'github-source-bootstrap'), activeBootstrap}).map((item) => {
    const bytes = sizeOf(item.path);
    if (!dryRun) rmSync(item.path, {recursive: true, force: true});
    return {...item, bytes};
  });
  let gc = {skipped: dryRun ? 'dry run' : 'free space floor already satisfied'};
  if (!dryRun && freeBytes(dirname(resolve(work)), statfs) < floor) {
    const filesystem=statfs('/gnu/store');
    const target=collectionTarget({bfree:BigInt(filesystem.bfree),bavail:BigInt(filesystem.bavail),bsize:BigInt(filesystem.bsize)},BigInt(floor));
    const done = spawnSync(guix, ['gc', `--free-space=${target}`], {encoding: 'utf8',timeout:120_000});
    gc = done.status === 0 ? {ok: true} : {ok: false, status: done.status};
  }
  const after = freeBytes(dirname(resolve(work)), statfs);
  return {kind: 'runner-space-reclaim', floor, minimum, freeBefore: before, freeAfter: after, removed, gc, targetMet: after >= floor, enough: after >= minimum};
}

if (isCliEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
  const work = args.find((a, i) => !a.startsWith('--') && !String(args[i - 1]).startsWith('--'));
  if (!work) { console.error('usage: reclaim-runner-space.mjs WORK [--cache DIR] [--floor-bytes TARGET] [--min-free-bytes REQUIRED] [--dry-run]'); process.exit(2); }
  const report = reclaim({work, cache: flag('--cache'), floor: flag('--floor-bytes') ? Number(flag('--floor-bytes')) : undefined, minimum: flag('--min-free-bytes') ? Number(flag('--min-free-bytes')) : undefined, dryRun: args.includes('--dry-run')});
  process.stderr.write(JSON.stringify(report) + '\n');
  // Fail only when the actual minimum build capacity is missing. Report when
  // the aspirational cleanup target cannot be met despite safe reclaimed space.
  if (!report.enough && !args.includes('--dry-run')) process.exit(1);
}
