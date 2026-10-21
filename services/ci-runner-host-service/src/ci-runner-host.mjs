// CI runner host service: makes a Linux host a GitHub Actions runner from one parameter record
// (specifications/requirements.md CR-1..CR-11). Node built-ins only.
import {
  readFileSync, writeFileSync, existsSync, lstatSync, statSync, readdirSync, mkdirSync, renameSync,
  rmSync, chmodSync, copyFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const SCHEMA = 'ci-runner-host-parameters@1';
const HOOK_KEY = 'ACTIONS_RUNNER_HOOK_JOB_COMPLETED';
const RUNNER_OWNED = ['_tool', '_actions', '_PipelineMapping', '_temp'];
const SCRIPTS = ['run.sh', 'config.sh', 'env.sh', 'run-helper.sh.template', 'run-helper.cmd.template', 'safe_sleep.sh', 'svc.sh'];

// ---------- pure ----------

const UNITS = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
export function bytes(size) {
  const m = /^(\d+(?:\.\d+)?)([KMG]?)B?$/.exec(String(size));
  if (!m) throw new Error(`unreadable size ${size}`);
  return Math.round(Number(m[1]) * UNITS[m[2]]);
}

export const unitName = (r) => `ci-runner-${r.name}.service`;
export const paths = (r) => ({
  runner: join(r.root, 'runner'), version: join(r.root, 'versions', r.version),
  hook: join(r.root, 'hooks', 'job-completed.sh'), work: join(r.root, 'runner', '_work'), diag: join(r.root, 'runner', '_diag'),
});

/** The systemd user unit (CR-8, CR-9): priority by weights and nice, one hard ceiling, never MemoryHigh. */
export function renderUnit(r) {
  const p = paths(r);
  return [
    '[Unit]',
    `Description=GitHub Actions runner ${r.name} for ${r.scope} (ci-runner-host-service)`,
    'After=network-online.target',
    '',
    '[Service]',
    `WorkingDirectory=${p.runner}`,
    `ExecStart=${join(p.runner, 'run.sh')}`,
    'Restart=always',
    'RestartSec=15',
    'KillMode=process',
    'KillSignal=SIGTERM',
    'TimeoutStopSec=5min',
    'UMask=0077',
    `Slice=${r.slice}`,
    `Nice=${r.nice}`,
    `CPUWeight=${r.cpuWeight}`,
    `IOWeight=${r.ioWeight}`,
    `MemoryMax=${r.memoryMax}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** The job-completed hook (CR-6, CR-7): temporary files and unretained workspaces go; caches and the runner's own folders stay. */
export function renderHook(r) {
  const p = paths(r);
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return [
    '#!/bin/bash',
    '# Installed by ci-runner-host-service (CR-6, CR-7). Runs after every job; edit the parameter record, not this file.',
    `W=${q(p.work)}`,
    `retain=(${(r.retain ?? []).map(q).join(' ')})`,
    'find "$W/_temp" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null',
    'for top in "$W"/*/; do',
    '  t=$(basename "$top"); case "$t" in _*) continue ;; esac',
    '  kept=no',
    '  for child in "$top"*/; do',
    '    [ -d "$child" ] || continue',
    '    rel="$t/$(basename "$child")"; keep=no',
    '    for k in "${retain[@]}"; do [ "$k" = "$rel" ] && keep=yes; done',
    '    if [ $keep = yes ]; then kept=yes; else rm -rf "$child"; fi',
    '  done',
    '  [ $kept = yes ] || rm -rf "$top"',
    'done',
    `find ${q(p.diag)} -type f -mtime +${Number(r.diagDays)} -delete 2>/dev/null`,
    'exit 0',
    '',
  ].join('\n');
}

/** Set KEY=value in a runner .env text, keeping every other line the runner wrote. */
export function mergeEnv(text, key, value) {
  const lines = text.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`; else lines.push(`${key}=${value}`);
  return `${lines.join('\n')}\n`;
}

/** Workspaces the hook would remove: everything under _work that is not runner-owned or retained. */
export function workspacesToRemove(entries, retain) {
  return entries.filter(({ top, child }) => !top.startsWith('_') && !retain.includes(`${top}/${child}`)).map(({ top, child }) => `${top}/${child}`);
}

/** The smallest memory.max among a cgroup's ancestors, or null when none is set. */
export function ancestorCeiling(cgroupPath, readMax) {
  const parts = cgroupPath.split('/').filter(Boolean);
  let min = null;
  for (let n = parts.length - 1; n > 0; n--) {
    const v = readMax(`/${parts.slice(0, n).join('/')}`);
    if (v && v !== 'max') { const b = Number(v); if (min === null || b < min) min = b; }
  }
  return min;
}

// ---------- host ----------

export function loadRecord(path) {
  const rec = JSON.parse(readFileSync(path, 'utf8'));
  if (rec.schema !== SCHEMA) throw new Error(`${path}: schema is not ${SCHEMA}`);
  return rec;
}
const text = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const lst = (p) => { try { return lstatSync(p); } catch { return null; } };
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim();
const shOk = (cmd, args) => { try { return sh(cmd, args); } catch { return ''; } };
const unitDir = () => join(homedir(), '.config', 'systemd', 'user');
const GB = (b) => `${(b / 1e9).toFixed(1)} GB`;

function duBytes(p) {
  if (!existsSync(p)) return 0;
  try { return Number(sh('ionice', ['-c3', 'nice', '-n19', 'du', '-sxb', p]).split(/\s/)[0]); } catch { return 0; }
}
function workEntries(work) {
  if (!existsSync(work)) return [];
  return readdirSync(work, { withFileTypes: true }).filter((e) => e.isDirectory())
    .flatMap((t) => (t.name.startsWith('_') ? [] : readdirSync(join(work, t.name), { withFileTypes: true }).filter((c) => c.isDirectory()).map((c) => ({ top: t.name, child: c.name }))));
}
const workerRunning = () => shOk('pgrep', ['-f', 'Runner.Worker']) !== '';

export function observe(record) {
  const items = [];
  const add = (id, ok, detail) => items.push({ id, status: ok ? 'current' : 'drift', detail });
  for (const r of record.runners) {
    const p = paths(r), tag = `[${r.name}]`;
    const reg = existsSync(join(p.runner, '.runner')) ? JSON.parse(readFileSync(join(p.runner, '.runner'), 'utf8').replace(/^﻿/, '')) : null;
    add(`CR-1 ${tag} registration`, !!reg && reg.agentName === r.name && reg.gitHubUrl === r.scope,
      reg ? `${reg.agentName} -> ${reg.gitHubUrl}` : `no registration under ${p.runner}`);
    const same = isVersion(p.runner, p.version);
    add(`CR-3 ${tag} version`, same, same ? `runs ${r.version} (hard links into ${p.version})` : `runner binaries are not the pinned ${r.version}`);
    const old = r.adopt?.from && existsSync(join(r.adopt.from, '.runner'));
    add(`CR-5 ${tag} one root`, !old, old ? `a registered runner still lives in ${r.adopt.from}` : r.root);
    const env = text(join(p.runner, '.env'));
    add(`CR-6 ${tag} job hook`, text(p.hook) === renderHook(r) && env.includes(`${HOOK_KEY}=${p.hook}\n`), p.hook);
    // Positive evidence of health, not "active": running (not cycling through restarts) and listening since its last start.
    const unitFile = text(join(unitDir(), unitName(r)));
    const show = Object.fromEntries(shOk('systemctl', ['--user', 'show', unitName(r), '-p', 'SubState', '-p', 'NRestarts', '-p', 'ActiveEnterTimestamp'])
      .split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const since = show.ActiveEnterTimestamp ? ['--since', show.ActiveEnterTimestamp.replace(/^\w+ /, '').replace(/ \w+$/, '')] : [];
    const listening = show.SubState === 'running' && /Listening for Jobs/.test(shOk('journalctl', ['--user', '-u', unitName(r), ...since, '--no-pager', '-o', 'cat']));
    add(`CR-8 ${tag} unit`, unitFile === renderUnit(r) && listening && show.NRestarts === '0',
      `${unitName(r)} ${unitFile === renderUnit(r) ? 'current' : 'differs'}, ${show.SubState || 'absent'}, ${show.NRestarts ?? '?'} restarts, ${listening ? 'listening for jobs' : 'NOT listening for jobs'}`);
    // Where the unit lives, or will live once installed (a user unit sits under user.slice either way).
    const uid = process.getuid();
    const cg = shOk('systemctl', ['--user', 'show', unitName(r), '-p', 'ControlGroup', '--value'])
      || `/user.slice/user-${uid}.slice/user@${uid}.service/${r.slice}/${unitName(r)}`;
    const ceiling = ancestorCeiling(cg, (c) => text(`/sys/fs/cgroup${c}/memory.max`).trim());
    add(`CR-9 ${tag} parent ceiling`, ceiling === null || ceiling >= bytes(r.memoryMax),
      ceiling === null ? 'no ancestor cap'
        : ceiling >= bytes(r.memoryMax) ? `nearest ancestor cap ${GB(ceiling)} is above this runner's ${r.memoryMax}`
          : `an ancestor caps memory at ${GB(ceiling)}, below this runner's ${r.memoryMax}: the host's memory budget decides`);
    const retained = (r.retain ?? []).reduce((s, k) => s + duBytes(join(p.work, k)), 0);
    const temp = duBytes(join(p.work, '_temp')), diag = duBytes(p.diag), total = duBytes(r.root);
    const stray = workspacesToRemove(workEntries(p.work), r.retain ?? []);
    add(`CR-10 ${tag} disk`, total <= bytes(r.maxBytes) && stray.length === 0,
      `${GB(total)} of ${r.maxBytes}: retained ${GB(retained)}, temp ${GB(temp)}, diag ${GB(diag)}${stray.length ? `; ${stray.length} unretained workspaces` : ''}`);
    const jobs = shOk('journalctl', ['--user', '-u', unitName(r), '--since', '-24h', '--no-pager', '-o', 'cat']).split('\n')
      .map((l) => /Job (\S+) \/ \S+ completed with result: (\w+)/.exec(l)).filter(Boolean)
      .reduce((m, [, job, res]) => { m[`${job} ${res}`] = (m[`${job} ${res}`] ?? 0) + 1; return m; }, {});
    items.push({ id: `${tag} jobs, 24 h`, status: 'current', detail: Object.entries(jobs).map(([k, n]) => `${k} x${n}`).join(', ') || 'none' });
  }
  return items;
}

function writeIfChanged(path, content, log, mode) {
  if (text(path) === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode) chmodSync(path, mode);
  log.push(`wrote ${path}`);
  return true;
}

function listenerVersion(binDir) {
  return shOk(join(binDir, 'Runner.Listener'), ['--version']);
}

async function ensureVersion(r, log) {
  const p = paths(r);
  if (existsSync(join(p.version, 'bin', 'Runner.Listener'))) return;
  // Adoption: an adopted runner's own binaries of the pinned version become the version directory.
  const bin = join(p.runner, 'bin');
  if (lst(bin)?.isDirectory() && !lst(bin).isSymbolicLink() && listenerVersion(bin) === r.version) {
    mkdirSync(p.version, { recursive: true });
    renameSync(bin, join(p.version, 'bin'));
    renameSync(join(p.runner, 'externals'), join(p.version, 'externals'));
    for (const s of SCRIPTS) if (existsSync(join(p.runner, s))) copyFileSync(join(p.runner, s), join(p.version, s));
    log.push(`kept the adopted runner's ${r.version} binaries as ${p.version}`);
    return;
  }
  const tarball = r.tarball && existsSync(r.tarball) ? r.tarball : join(tmpdir(), `actions-runner-linux-x64-${r.version}.tar.gz`);
  if (!existsSync(tarball)) {
    const url = `https://github.com/actions/runner/releases/download/v${r.version}/actions-runner-linux-x64-${r.version}.tar.gz`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
    writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
  }
  const sum = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  if (sum !== r.sha256) throw new Error(`${tarball}: sha256 ${sum} is not the record's ${r.sha256}`);
  mkdirSync(p.version, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', p.version]);
  log.push(`installed runner ${r.version} into ${p.version} (sha256 verified)`);
}

function adopt(r, log, now) {
  const p = paths(r);
  if (existsSync(join(p.runner, '.runner')) || !r.adopt?.from || !existsSync(join(r.adopt.from, '.runner'))) return false;
  if (workerRunning() && !now) { log.push(`not adopting ${r.adopt.from} yet: a job is running; apply --now to stop it (CR-12)`); return null; }
  if (r.adopt.oldUnit) shOk('systemctl', ['--user', 'stop', r.adopt.oldUnit]);
  for (let i = 0; i < 60 && workerRunning(); i++) execFileSync('sleep', ['1']);
  if (workerRunning()) { log.push('the old runner\'s job did not stop within 60 s; not moving its directory'); return null; }
  mkdirSync(r.root, { recursive: true });
  renameSync(r.adopt.from, p.runner);
  if (r.adopt.oldUnit) { shOk('systemctl', ['--user', 'disable', r.adopt.oldUnit]); log.push(`stopped and disabled ${r.adopt.oldUnit}`); }
  log.push(`adopted the registered runner from ${r.adopt.from} into ${p.runner} (same filesystem rename; cache kept)`);
  return true;
}

function register(r, log) {
  const p = paths(r);
  if (existsSync(join(p.runner, '.runner'))) return;
  if (!r.credentialCommand) throw new Error(`[${r.name}] nothing to adopt and no credentialCommand to obtain a registration token`);
  const token = execFileSync('bash', ['-c', r.credentialCommand], { encoding: 'utf8' }).trim();
  execFileSync(join(p.runner, 'config.sh'), ['--unattended', '--url', r.scope, '--token', token, '--name', r.name,
    '--labels', (r.labels ?? []).join(','), '--work', '_work', '--replace', '--disableupdate'], { cwd: p.runner, stdio: 'ignore' });
  log.push(`registered ${r.name} with ${r.scope}`);
}

// The runner finds its registration from its binaries' real path, so bin/ and externals/ are hard-linked
// copies of the version directory (no extra disk; the version store stays the unchanged original), not symlinks.
export const versionMarker = (dir) => join(dir, 'bin', 'Runner.Listener');
export function isVersion(runnerDir, versionDir) {
  // Real directories only: a symlinked bin/ resolves to the same inode but makes the runner look for its
  // registration inside the version directory.
  const real = (d) => { const s = lst(join(runnerDir, d)); return !!s && s.isDirectory() && !s.isSymbolicLink(); };
  if (!real('bin') || !real('externals')) return false;
  try { return statSync(versionMarker(runnerDir)).ino === statSync(versionMarker(versionDir)).ino; } catch { return false; }
}
function link(r, log) {
  const p = paths(r);
  mkdirSync(p.runner, { recursive: true });
  if (!isVersion(p.runner, p.version)) {
    shOk('systemctl', ['--user', 'stop', unitName(r)]);
    for (const d of ['bin', 'externals']) {
      const at = join(p.runner, d);
      if (lst(at)) rmSync(at, { recursive: true, force: true });
      execFileSync('cp', ['-al', join(p.version, d), at]);
    }
    log.push(`hard-linked ${p.version}/{bin,externals} into ${p.runner}`);
  }
  for (const s of SCRIPTS) if (existsSync(join(p.version, s)) && !existsSync(join(p.runner, s))) copyFileSync(join(p.version, s), join(p.runner, s));
}

export async function apply(record, { now = false } = {}) {
  const log = [];
  for (const r of record.runners) {
    const p = paths(r);
    const adopted = adopt(r, log, now);
    if (adopted === null) continue;
    await ensureVersion(r, log);
    link(r, log);
    register(r, log);
    writeIfChanged(p.hook, renderHook(r), log, 0o755);
    const envPath = join(p.runner, '.env');
    writeIfChanged(envPath, mergeEnv(text(envPath), HOOK_KEY, p.hook), log);
    const unitChanged = writeIfChanged(join(unitDir(), unitName(r)), renderUnit(r), log);
    if (unitChanged) shOk('systemctl', ['--user', 'daemon-reload']);
    shOk('systemctl', ['--user', 'enable', unitName(r)]);
    if (unitChanged || adopted || shOk('systemctl', ['--user', 'is-active', unitName(r)]) !== 'active') {
      if (!workerRunning()) { shOk('systemctl', ['--user', 'restart', unitName(r)]); log.push(`started ${unitName(r)}`); }
      else log.push(`${unitName(r)} changed; restart deferred while a job runs`);
    }
    if (!workerRunning()) { execFileSync('bash', [p.hook]); log.push('ran the job-completed hook once (idle)'); }
  }
  return log;
}
