// CI runner host service: makes a Linux host a GitHub Actions runner from one parameter record
// (specifications/requirements.md CR-1..CR-11). Node built-ins only.
import {
  readFileSync, writeFileSync, existsSync, lstatSync, statSync, readdirSync, mkdirSync, renameSync,
  rmSync, chmodSync, copyFileSync, constants, openSync, closeSync, fstatSync, readSync,
} from 'node:fs';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const SCHEMA = 'ci-runner-host-parameters@1';
const HOOK_KEY = 'ACTIONS_RUNNER_HOOK_JOB_COMPLETED';
const START_HOOK_KEY = 'ACTIONS_RUNNER_HOOK_JOB_STARTED';
const RUNNER_OWNED = ['_tool', '_actions', '_PipelineMapping', '_temp'];
const SCRIPTS = ['run.sh', 'config.sh', 'env.sh', 'run-helper.sh.template', 'run-helper.cmd.template', 'safe_sleep.sh', 'svc.sh'];

// ---------- pure ----------

const UNITS = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
export function bytes(size) {
  const m = /^(\d+(?:\.\d+)?)([KMG]?)B?$/.exec(String(size));
  if (!m) throw new Error(`unreadable size ${size}`);
  return Math.round(Number(m[1]) * UNITS[m[2]]);
}

import {unitName,paths,tarballPath} from './runner-layout.mjs';
import { execGitSync } from '@red-cup-engineering/git-engine/git-process';
export {unitName,paths,tarballPath} from './runner-layout.mjs';

/** The original GitHub supplier has fixed scope-bound methods, never a shell. */
export function registrationInvocation(r, method = 'GET') {
  const executable=r.registration?.executable;
  if(typeof executable!=='string'||!isAbsolute(executable)||/[\r\n\0]/.test(executable))throw new TypeError('absolute GitHub CLI supplier required');
  const url=new URL(r.scope), parts=url.pathname.replace(/\/$/,'').split('/').filter(Boolean);
  if(url.protocol!=='https:'||url.hostname!=='github.com'||url.port||url.username||url.password||url.search||url.hash
      || ![1,2].includes(parts.length)||parts.some(p=>!/^[A-Za-z0-9_.-]+$/.test(p)||['.','..'].includes(p)))
    throw new TypeError('exact GitHub organization or repository scope required');
  if(!['GET','POST'].includes(method))throw new TypeError('runner metadata or registration-token method required');
  const scope=(parts.length===1?'/orgs/':'/repos/')+parts.join('/');
  const endpoint=scope+'/actions/runners'+(method==='POST'?'/registration-token':'?per_page=100');
  return {executable,args:['api','--hostname','github.com','--method',method,endpoint,...(method==='POST'?['--jq','.token']:[])]};
}

/** Actual registered scope/labels; an incomplete or inaccessible list is unknown. */
export function readRunnerRegistration(r,{run=execFileSync}={}){
  const invocation=registrationInvocation(r);
  try{
    const result=JSON.parse(run(invocation.executable,invocation.args,{encoding:'utf8',timeout:10000,maxBuffer:1024*1024,stdio:['ignore','pipe','ignore']}));
    if(!Array.isArray(result.runners)||result.total_count!==result.runners.length||result.runners.length>100)
      return {state:'unknown',reason:'incomplete-runner-metadata'};
    const found=result.runners.filter(item=>item.name===r.name);
    if(found.length===0)return {state:'absent',scope:r.scope};
    const runner=found[0],labels=runner.labels?.map(label=>label.name);
    if(found.length!==1||!Number.isSafeInteger(runner.id)||runner.id<1||!Array.isArray(labels)||labels.some(label=>typeof label!=='string'))
      return {state:'unknown',reason:'ambiguous-runner-metadata'};
    return {state:runner.status==='online'&&(r.labels??[]).every(label=>labels.includes(label))?'current':'drift',
      id:runner.id,name:runner.name,scope:r.scope,status:runner.status,busy:typeof runner.busy==='boolean'?runner.busy:null,labels};
  }catch{return {state:'unknown',reason:'runner-metadata-unavailable'};}
}

/** Native config failures must never retain their token-bearing argv in an Error. */
export function configureRunner(r,token,{run=execFileSync}={}){
  if(typeof token!=='string'||!token||/[\r\n\0]/.test(token))throw new Error('registration supplier returned no single-use token');
  renderEnvironment(r.environment);
  const p=paths(r);
  try{run(join(p.runner,'config.sh'),['--unattended','--url',r.scope,'--token',token,'--name',r.name,
    '--labels',(r.labels??[]).join(','),'--work','_work','--disableupdate','--replace'],{cwd:p.runner,stdio:'ignore',env:{...process.env,...r.environment}});}
  catch{throw new Error('native runner registration failed; token and native diagnostics withheld');}
}

function renderEnvironment(environment = {}) {
  if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new TypeError('runner environment must be a variable map');
  }
  return Object.keys(environment).sort().map(key => {
    const value = environment[key];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new TypeError('runner environment requires valid variable names');
    }
    if (typeof value !== 'string' || /[\x00-\x1f\x7f]/u.test(value)) {
      throw new TypeError('runner environment values must be single-line strings');
    }
    const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
    return `Environment="${key}=${escaped}"`;
  });
}

/** The systemd user unit (CR-8, CR-9): priority by weights and nice, one hard ceiling, never MemoryHigh. */
export function renderUnit(r) {
  const p = paths(r);
  return [
    '[Unit]',
    `Description=GitHub Actions runner ${r.name} for ${r.scope} (ci-runner-host-service)`,
    'After=network-online.target',
    '',
    '[Service]',
    ...renderEnvironment(r.environment),
    `WorkingDirectory=${p.runner}`,
    // GitHub's service entry point: it forwards SIGTERM to the listener, so a stop or restart never
    // leaves a second listener holding the registration (run.sh does not forward it).
    `ExecStart=${join(p.runner, 'bin', 'runsvc.sh')}`,
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

/**
 * The job-completed hook (CR-6, CR-7, CR-12): temporary files and unretained workspaces go; caches and the runner's
 * own folders stay. With `retainRecentDays`, every workspace a job used within that many days is a cache too: the
 * job's own workspace is marked used, the next job of its repository fetches only what it lacks instead of cloning
 * again, and `maxBytes` evicts the least recently used. Removing every workspace after every job cloned and deleted
 * a whole repository per push, which on a WSL host grows the Windows backing disk by whole virtual-disk blocks.
 */
export function renderHook(r) {
  const p = paths(r);
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const recentDays = Number(r.retainRecentDays ?? 0), maxKiB = r.maxBytes ? Math.floor(bytes(r.maxBytes) / 1024) : 0;
  if (!Number.isInteger(recentDays) || recentDays < 0) throw new TypeError('retainRecentDays is a whole number of days');
  // CR-29: a pull request's CI job completing is the event a pull-request processor waits on (its checks are now
  // known), so the hook dispatches the declared workflow for the job's repository. Nothing polls for it.
  const dispatch = r.pullRequestJobCompletedDispatch;
  const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  if (dispatch !== undefined && (!SLUG.test(dispatch?.repository ?? '') || !/^[A-Za-z0-9_.-]+\.ya?ml$/.test(dispatch?.workflow ?? '')
      || typeof r.registration?.executable !== 'string' || !isAbsolute(r.registration.executable)))
    throw new TypeError('pullRequestJobCompletedDispatch names an owner/name repository and a workflow file, and the record an absolute gh');
  const dispatchLines = dispatch === undefined ? [] : [
    '# A pull request\'s CI job completed: dispatch the pull-request processor for its repository (CR-29).',
    'case "${GITHUB_EVENT_NAME:-}" in pull_request|pull_request_target)',
    `  [[ "\${GITHUB_REPOSITORY:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] && env -u GH_TOKEN -u GITHUB_TOKEN ${q(r.registration.executable)} workflow run ${q(dispatch.workflow)} -R ${q(dispatch.repository)} -f repository="$GITHUB_REPOSITORY" >/dev/null 2>&1 ;;`,
    'esac',
  ];
  return [
    '#!/bin/bash',
    '# Installed by ci-runner-host-service (CR-6, CR-7, CR-12). Runs after every job; edit the parameter record, not this file.',
    `W=${q(p.work)}`,
    `retain=(${(r.retain ?? []).map(q).join(' ')})`,
    `recentDays=${recentDays}`,
    `maxKiB=${maxKiB}`,
    'find "$W/_temp" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null',
    '# The finished job\'s workspace is the next job\'s cache for its repository.',
    'case "${GITHUB_WORKSPACE:-}" in "$W"/[!_]*/*) [ -d "$GITHUB_WORKSPACE" ] && touch "$GITHUB_WORKSPACE" ;; esac',
    'retained() { local k; for k in "${retain[@]}"; do [ "$k" = "$1" ] && return 0; done; return 1; }',
    'for top in "$W"/*/; do',
    '  t=$(basename "$top"); case "$t" in _*) continue ;; esac',
    '  kept=no',
    '  for child in "$top"*/; do',
    '    [ -d "$child" ] || continue',
    '    rel="$t/$(basename "$child")"; keep=no',
    '    retained "$rel" && keep=yes',
    '    if [ $keep = no ] && [ "$recentDays" -gt 0 ] && [ -n "$(find "$child" -maxdepth 0 -mtime -"$recentDays" 2>/dev/null)" ]; then keep=yes; fi',
    '    if [ $keep = yes ]; then kept=yes; else rm -rf "$child"; fi',
    '  done',
    '  [ $kept = yes ] || rm -rf "$top"',
    'done',
    '# Bounded: over maxBytes, the least recently used unretained workspace goes first.',
    'while [ "$recentDays" -gt 0 ] && [ "$maxKiB" -gt 0 ] && [ "$(du -sk "$W" 2>/dev/null | cut -f1)" -gt "$maxKiB" ]; do',
    '  oldest=""',
    '  while read -r stamp rel; do retained "$rel" || { oldest=$rel; break; }; done < <(find "$W" -mindepth 2 -maxdepth 2 -type d -not -path "$W/_*" -printf \'%T@ %P\\n\' 2>/dev/null | sort -n)',
    '  [ -n "$oldest" ] || break',
    '  rm -rf "${W:?}/$oldest"; rmdir "$W/${oldest%%/*}" 2>/dev/null',
    'done',
    `find ${q(p.diag)} -type f -mtime +${Number(r.diagDays)} -delete 2>/dev/null`,
    ...dispatchLines,
    '# A change apply deferred while a job ran is reconciled once this job\'s worker exits (CR-31): the exit is the event.',
    `if [ -e ${q(p.reconcilePending)} ]; then (unset RUNNER_TRACKING_ID; setsid bash -c 'tail --pid="$1" -f /dev/null; systemctl --user start --no-block ${RECONCILE_UNIT}.service' _ "$PPID" </dev/null >/dev/null 2>&1 &); fi`,
    '# Release the host\'s CI job slot (CR-28) once this job\'s cleanup is done.',
    `[ -f ${q(p.slotHolder)} ] && kill "$(cat ${q(p.slotHolder)})" 2>/dev/null; rm -f ${q(p.slotHolder)}`,
    'exit 0',
    '',
  ].join('\n');
}

/**
 * The job-started hook (CR-28): the host runs one CI job at a time, whichever of its runners took it, so the runners
 * registered for several organizations never run jobs concurrently. The job waits here, blocked in the kernel on an
 * exclusive lock of the host's one slot file: no polling and no timer. The lock then passes to a holder process that
 * lives exactly as long as the job's worker (the hook's parent): it ends when the worker exits, when the job-completed
 * hook ends it, or in the runner's own orphan-process cleanup, so a crashed or cancelled job cannot keep the slot.
 */
export function renderStartHook(r) {
  const p = paths(r);
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const cancel = r.cancelSupersededJobs;
  if (cancel !== undefined && (typeof cancel?.jq !== 'string' || !isAbsolute(cancel.jq)
      || typeof r.registration?.executable !== 'string' || !isAbsolute(r.registration.executable)))
    throw new TypeError('cancelSupersededJobs names an absolute jq, and the record an absolute gh');
  // CR-33: a job whose commit is no longer current when it takes the slot is cancelled instead of run: the branch
  // moved on, or the pull request's head changed or it closed. Only definite evidence cancels; an unreadable answer runs
  // the job. This is cancel-in-progress for every repository at once, with no workflow edited.
  // GitHub invokes this hook with bash -e -o pipefail. Freshness is optional evidence, unlike the host slot below:
  // failed reads clear their output, and a failed cancellation must not turn the hook into a checkout gate.
  const supersededLines = cancel === undefined ? [] : [
    `gh=${q(r.registration.executable)}; jq=${q(cancel.jq)}; mine=""; current=""`,
    'api() { local answer; if answer=$(env -u GH_TOKEN -u GITHUB_TOKEN "$gh" api "$@" 2>/dev/null); then printf \'%s\\n\' "$answer"; else return 1; fi; }',
    'case "${GITHUB_EVENT_NAME:-}" in',
    '  pull_request|pull_request_target)',
    '    number=$("$jq" -r \'.pull_request.number // empty\' "${GITHUB_EVENT_PATH:-/dev/null}" 2>/dev/null) || number=""',
    '    mine=$("$jq" -r \'.pull_request.head.sha // empty\' "${GITHUB_EVENT_PATH:-/dev/null}" 2>/dev/null) || mine=""',
    '    if [[ "$number" =~ ^[0-9]+$ ]]; then current=$(api "repos/$GITHUB_REPOSITORY/pulls/$number" --jq \'if .state == "open" then .head.sha else "closed" end\') || current=""; fi ;;',
    '  push)',
    '    case "${GITHUB_REF:-}" in refs/heads/*) mine=${GITHUB_SHA:-}; current=$(api "repos/$GITHUB_REPOSITORY/commits/${GITHUB_REF#refs/heads/}" --jq .sha) || current="" ;; esac ;;',
    'esac',
    // CR-35: a push run on a branch whose open pull request has this exact head, when the same workflow also runs on
    // pull_request, repeats the pull request's run of the same commit: the push run is cancelled, never the PR run.
    'duplicate=no',
    'if [ "${GITHUB_EVENT_NAME:-}" = push ] && [ -n "$mine" ] && [ "$current" = "$mine" ]; then',
    '  branch=${GITHUB_REF#refs/heads/}; owner=${GITHUB_REPOSITORY%%/*}',
    '  default=$(api "repos/$GITHUB_REPOSITORY" --jq .default_branch) || default=""',
    '  workflow=${GITHUB_WORKFLOW_REF:-}; workflow=${workflow#*/*/}; workflow=${workflow%@*}',
    '  if [ -n "$default" ] && [ "$branch" != "$default" ] && [[ "$workflow" =~ ^\\.github/workflows/[A-Za-z0-9_.-]+\\.ya?ml$ ]] \\',
    '      && [ "$(api "repos/$GITHUB_REPOSITORY/pulls?state=open&head=$owner:$branch" --jq \'.[0].head.sha // empty\')" = "$mine" ] \\',
    '      && api "repos/$GITHUB_REPOSITORY/contents/$workflow?ref=$mine" --jq .content | base64 -d 2>/dev/null \\',
    '         | grep -Eq \'(^|[[:space:],[-])pull_request([[:space:]]*[:,]|[[:space:]]*\\]|[[:space:]]*$)\'; then duplicate=yes; fi',
    'fi',
    'if [[ "$mine" =~ ^[0-9a-f]{40}$ ]] && { { [[ "$current" =~ ^([0-9a-f]{40}|closed)$ ]] && [ "$current" != "$mine" ]; } || [ "$duplicate" = yes ]; } \\',
    '    && [[ "${GITHUB_REPOSITORY:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] && [[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ]]; then',
    '  env -u GH_TOKEN -u GITHUB_TOKEN "$gh" run cancel "$GITHUB_RUN_ID" -R "$GITHUB_REPOSITORY" >/dev/null 2>&1 || true',
    'fi',
  ];
  return [
    '#!/bin/bash',
    '# Installed by ci-runner-host-service (CR-28, CR-33). Runs before every job; edit the parameter record, not this file.',
    `mkdir -p ${q(dirname(p.slotHolder))}`,
    `exec 9>>${q(p.slot)}`,
    'flock -x 9',
    'tail --pid="$PPID" -f /dev/null &',
    `echo $! > ${q(p.slotHolder)}`,
    ...supersededLines,
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

/** Workspaces the hook would remove: everything under _work that is not runner-owned, retained, or used within recentDays (CR-12). */
export function workspacesToRemove(entries, retain, recentDays = 0, now = Date.now()) {
  return entries.filter(({ top, child, mtimeMs }) => !top.startsWith('_') && !retain.includes(`${top}/${child}`)
    && !(recentDays > 0 && Number.isFinite(mtimeMs) && now - mtimeMs < recentDays * 86400000)).map(({ top, child }) => `${top}/${child}`);
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

const physicalRecordSources = new WeakMap();
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_PHYSICAL_RECORD_BYTES = 256 * 1024;

function normalizeRecord(record, path) {
  if (record.schema !== SCHEMA) throw new Error(`${path}: schema is not ${SCHEMA}`);
  const defaults = record.defaults ?? {};
  renderEnvironment(defaults.environment);
  const runners = record.runners.map(runner => {
    renderEnvironment(runner.environment);
    const merged = { ...defaults, ...runner };
    if (defaults.environment !== undefined || runner.environment !== undefined) {
      merged.environment = { ...defaults.environment, ...runner.environment };
    }
    return merged;
  });
  return { ...record, parametersPath: path, runners };
}
const sourceDigest = bytes => createHash('sha256').update(bytes).digest('hex');
const fileIdentity = stat => [stat.dev, stat.ino, stat.uid, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

/** Read one bounded regular descriptor without waiting on a named pipe. */
function readRecordBytes(path, limit, inspect) {
  const initial = inspect && fileIdentity(inspect());
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (inspect ? constants.O_NOFOLLOW : 0));
  try {
    const stat = fstatSync(fd, { bigint: true });
    const identity = fileIdentity(stat);
    if (!stat.isFile() || stat.size > BigInt(limit) || (initial && initial !== identity))
      throw new Error('unqualified runner parameter file');
    const buffer = Buffer.alloc(Number(stat.size) + 1);
    let count = 0;
    while (count < buffer.length) {
      const received = readSync(fd, buffer, count, buffer.length - count, null);
      if (received === 0) break;
      count += received;
    }
    if (count !== Number(stat.size) || fileIdentity(fstatSync(fd, { bigint: true })) !== identity ||
        (inspect && fileIdentity(inspect()) !== identity)) throw new Error('runner parameter file changed during read');
    return { identity, bytes: buffer.subarray(0, count) };
  } finally { closeSync(fd); }
}

/** Bounded, owner-custodied source read, not a provider observation or authorization. */
function readPhysicalRecord(path) {
  if (!isAbsolute(path) || resolve(path) !== path || /[\x00-\x1f]/u.test(path)) throw new Error('noncanonical source path');
  const uid = BigInt(process.getuid());
  function inspect() {
    let at = path;
    let leaf;
    for (;;) {
      const st = lstatSync(at, { bigint: true });
      const owner = st.uid === uid || st.uid === 0n;
      const stickyRootDirectory = st.isDirectory() && st.uid === 0n && (st.mode & 0o1000n) !== 0n;
      if (!owner || st.isSymbolicLink() || ((st.mode & 0o022n) !== 0n && !stickyRootDirectory))
        throw new Error('unqualified source custody');
      if (at === path) {
        if (!st.isFile() || st.size > BigInt(MAX_PHYSICAL_RECORD_BYTES)) throw new Error('unqualified source file');
        leaf = st;
      }
      if (dirname(at) === at) break;
      at = dirname(at);
    }
    return leaf;
  }
  const { identity, bytes } = readRecordBytes(path, MAX_PHYSICAL_RECORD_BYTES, inspect);
  return { identity, digest: sourceDigest(bytes) };
}

export function loadRecord(path) {
  const { bytes } = readRecordBytes(path, MAX_RECORD_BYTES);
  const record = normalizeRecord(JSON.parse(bytes), path);
  if (record.hostAdmission?.ciParametersPath === path) {
    try {
      const input = readPhysicalRecord(path);
      if (input.digest === sourceDigest(bytes)) {
        physicalRecordSources.set(record, { path, input, operation: structuredClone(record), targets: physicalTargetPlan(record) });
      }
    } catch { /* an unqualified source remains unbound in plan */ }
  }
  return record;
}

function physicalRecordBinding(record, targets) {
  const bound = physicalRecordSources.get(record);
  if (!bound || !isDeepStrictEqual(record, bound.operation) || !isDeepStrictEqual(targets, bound.targets)) return null;
  try {
    const recheck = readPhysicalRecord(bound.path);
    return isDeepStrictEqual(recheck, bound.input)
      ? { type: 'ci-runner-parameter-record.v1', sha256: recheck.digest }
      : null;
  } catch { return null; }
}
const text = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const lst = (p) => { try { return lstatSync(p); } catch { return null; } };
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim();
const shOk = (cmd, args) => { try { return sh(cmd, args); } catch { return ''; } };
const unitDir = () => join(homedir(), '.config', 'systemd', 'user');
const diskRecordPath = r => join(r.root, 'disk-usage.json');
const runnerUnitPath = r => join(unitDir(), unitName(r));
const removedControlsPath = r => join(unitDir(), `${unitName(r)}.d`, '80-ci-runner-host-controls.conf');
const reconcileUnitPath = kind => join(unitDir(), `${RECONCILE_UNIT}.${kind}`);
const GB = (b) => `${(b / 1e9).toFixed(1)} GB`;

const diskBytes = value => Number.isSafeInteger(value) && value >= 0;
const DISK_MEASUREMENT = 'ci-runner-disk-measurement.v1';
function duBytes(p) {
  try { lstatSync(p); } catch (error) { if (error?.code === 'ENOENT') return 0; throw error; }
  const text = sh('ionice', ['-c3', 'nice', '-n19', 'du', '-sxb', p]).split(/\s/)[0];
  const value = Number(text);
  if (!/^\d+$/u.test(text) || !diskBytes(value)) throw new Error('invalid runner disk measurement');
  return value;
}
/**
 * Whether a recorded disk measurement is recent enough to read instead of walking the tree again. Walking every
 * runner with du on each 15-minute reconcile took longer than the interval and held the host's disk at 99% io
 * pressure (2026-11-01), so a runner is measured at most once per `hours`.
 */
export function diskMeasurementIsCurrent(measurement, nowMs, hours) {
  const at = Date.parse(measurement?.measuredAt ?? '');
  return Number.isFinite(at) && Number.isFinite(nowMs) && Number.isFinite(hours) && hours > 0 &&
    at <= nowMs && nowMs - at < hours * 3600e3 && diskBytes(measurement.total);
}

/** Read a bounded-age usage receipt. Deliberate apply may refresh it;
 * an unreadable measurement is never cached or reported as zero. */
export function measureRunnerDisk(r, p, { now = Date.now, measure = duBytes, refresh = false } = {}) {
  const file = diskRecordPath(r);
  const at = now();
  let recorded = null;
  try { recorded = JSON.parse(readFileSync(file, 'utf8')); } catch { recorded = null; }
  if (recorded?.kind === DISK_MEASUREMENT && diskMeasurementIsCurrent(recorded, at, Number(r.diskMeasureHours ?? 24)) &&
      [recorded.retained, recorded.temp, recorded.diag].every(diskBytes)) return recorded;
  if (!refresh) return null;
  let measured;
  try {
    const read = directory => {
      const result = measure(directory);
      if (!diskBytes(result)) throw new Error('invalid runner disk measurement');
      return result;
    };
    measured = {
      kind: DISK_MEASUREMENT,
      measuredAt: new Date(at).toISOString(),
      total: read(r.root),
      retained: (r.retain ?? []).reduce((s, k) => s + read(join(p.work, k)), 0),
      temp: read(join(p.work, '_temp')),
      diag: read(p.diag),
    };
    if (!diskBytes(measured.retained)) return null;
  } catch { return null; }
  try { writeFileSync(file, `${JSON.stringify(measured)}\n`); } catch { /* an unwritable record is measured again next time */ }
  return measured;
}

function workEntries(work) {
  if (!existsSync(work)) return [];
  return readdirSync(work, { withFileTypes: true }).filter((e) => e.isDirectory())
    .flatMap((t) => (t.name.startsWith('_') ? [] : readdirSync(join(work, t.name), { withFileTypes: true }).filter((c) => c.isDirectory()).map((c) => ({ top: t.name, child: c.name, mtimeMs: statSync(join(work, t.name, c.name)).mtimeMs }))));
}
const workers = (r) => shOk('pgrep', ['-f', join(paths(r).runner, 'bin', 'Runner.Worker')]).split('\n').filter(Boolean);
const workerRunning = (r) => workers(r).length > 0;
/** Record that apply deferred a change while a job ran (CR-31): the job-completed hook reconciles after that job. */
const markReconcilePending = (r) => writeFileSync(paths(r).reconcilePending, `${new Date().toISOString()} ${r.name}\n`);

/**
 * Statically enumerate possible explicit local write targets of generic apply and its CLI receipt.
 * Child release, service manager, registration, and listener effects are separate from these paths.
 */
function physicalTargetPlan(record) {
  const canonical = (value) => {
    if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value ||
        value.length > 4096 || /[\x00-\x1f]/u.test(value)) throw new TypeError('noncanonical target');
    return value;
  };
  const simpleName = value => typeof value === 'string' && /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/u.test(value);
  const runners = record.runners;
  if (!Array.isArray(runners) || runners.length === 0 || runners.length > 16) throw new TypeError('runner set unqualified');
  const targets = new Set();
  const names = new Set();
  for (const r of runners) {
    if (!simpleName(r.name) || !/^\d+\.\d+\.\d+$/u.test(r.version)) throw new TypeError('runner identity unqualified');
    if (names.has(r.name)) throw new TypeError('duplicate runner name');
    names.add(r.name);
    canonical(r.root);
    const p = paths(r);
    for (const path of [p.runner, p.version, tarballPath(r), p.reconcilePending,
      p.hook, p.startHook, diskRecordPath(r), runnerUnitPath(r), removedControlsPath(r)]) targets.add(canonical(path));
    if (record.sliceMemoryMax) {
      if (!simpleName(r.slice) || !r.slice.endsWith('.slice')) throw new TypeError('runner slice unqualified');
      targets.add(canonical(join(unitDir(), r.slice)));
    }
  }
  if (record.reconcile && record.parametersPath) {
    targets.add(canonical(releasePlan(record.reconcile).root));
    for (const kind of ['timer', 'service', 'path']) targets.add(canonical(reconcileUnitPath(kind)));
  }
  // One original WSL observation accepts at most 32 paths; do not split a cohort to evade this limit.
  if (targets.size > 32) throw new TypeError('target bound exceeded');
  return [...targets];
}

/** Refuse explicit contracts this release cannot execute; never treat them as generic runner records. */
function unsupportedPhysicalPolicy(record) {
  if (record.controls?.mode === 'existing-flat') {
    return { id: 'CR-19 existing-flat controls', status: 'unobserved',
      detail: 'this release cannot reconcile existing-flat controls; generic apply would change runner custody' };
  }
  if (Object.hasOwn(record, 'hostAdmission')) {
    return { id: 'CR-18 native physical admission', status: 'unobserved',
      detail: 'this release does not bind the declared native physical admission provider' };
  }
  return null;
}

export function observe(record, options={}) {
  const unsupported = unsupportedPhysicalPolicy(record);
  if (unsupported) {
    if (unsupported.id !== 'CR-18 native physical admission') return [unsupported];
    try {
      const possibleWriteTargets = physicalTargetPlan(record);
      const parameterRecord = physicalRecordBinding(record, possibleWriteTargets);
      return [{ ...unsupported, possibleWriteTargets, parameterRecord,
        detail: `${unsupported.detail}; ${possibleWriteTargets.length} possible local write targets, external effects unqualified; parameter record ${parameterRecord ? 'bound' : 'unbound'}` }];
    } catch {
      return [{ ...unsupported, possibleWriteTargets: null, parameterRecord: null,
        detail: `${unsupported.detail}; local write targets unknown (invalid or over-bound runner layout)` }];
    }
  }
  const items = [];
  const add = (id, ok, detail) => items.push({ id, status: ok ? 'current' : 'drift', detail });
  for (const r of record.runners) {
    const p = paths(r), tag = `[${r.name}]`;
    const reg = existsSync(join(p.runner, '.runner')) ? JSON.parse(readFileSync(join(p.runner, '.runner'), 'utf8').replace(/^﻿/, '')) : null;
    add(`CR-1 ${tag} registration`, !!reg && reg.agentName === r.name && reg.gitHubUrl === r.scope,
      reg ? `${reg.agentName} -> ${reg.gitHubUrl}` : `no registration under ${p.runner}`);
    if(r.registration){
      const registered=readRunnerRegistration(r);
      add(`CR-15 ${tag} registered resource`,registered.state==='current',JSON.stringify(registered));
    }
    const same = isVersion(p.runner, p.version);
    add(`CR-3 ${tag} version`, same, same ? `runs ${r.version} (hard links into ${p.version})` : `runner binaries are not the pinned ${r.version}`);
    const env = text(join(p.runner, '.env'));
    add(`CR-6 ${tag} job hook`, text(p.hook) === renderHook(r) && env.includes(`${HOOK_KEY}=${p.hook}\n`), p.hook);
    add(`CR-28 ${tag} one job at a time on the host`, text(p.startHook) === renderStartHook(r) && env.includes(`${START_HOOK_KEY}=${p.startHook}\n`), p.startHook);
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
    const diskId = `CR-10 ${tag} disk`;
    const disk = measureRunnerDisk(r, p, { refresh: options.refreshDisk === true });
    if (disk === null) items.push({ id: diskId, status: 'unobserved', detail: 'no current measured runner usage receipt' });
    else {
      const { total, retained: kept, temp, diag, measuredAt } = disk;
      try {
        const stray = workspacesToRemove(workEntries(p.work), r.retain ?? [], Number(r.retainRecentDays ?? 0));
        add(diskId, total <= bytes(r.maxBytes) && stray.length === 0,
          `${GB(total)} of ${r.maxBytes} (measured ${measuredAt}): retained ${GB(kept)}, temp ${GB(temp)}, diag ${GB(diag)}${stray.length ? `; ${stray.length} unretained workspaces` : ''}`);
      } catch { items.push({ id: diskId, status: 'unobserved', detail: 'runner workspace inventory could not be read' }); }
    }
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
  // A runner already holding the pinned version's binaries gives them to the version directory.
  const bin = join(p.runner, 'bin');
  if (lst(bin)?.isDirectory() && !lst(bin).isSymbolicLink() && listenerVersion(bin) === r.version) {
    if (workerRunning(r)) { markReconcilePending(r); log.push(`${r.name}: taking its ${r.version} binaries deferred while its job runs`); return; }
    shOk('systemctl', ['--user', 'stop', unitName(r)]);
    mkdirSync(p.version, { recursive: true });
    renameSync(bin, join(p.version, 'bin'));
    renameSync(join(p.runner, 'externals'), join(p.version, 'externals'));
    for (const s of SCRIPTS) if (existsSync(join(p.runner, s))) copyFileSync(join(p.runner, s), join(p.version, s));
    log.push(`kept ${r.name}'s ${r.version} binaries as ${p.version}`);
    return;
  }
  const tarball = tarballPath(r);
  if (!existsSync(tarball)) {
    const url = `https://github.com/actions/runner/releases/download/v${r.version}/actions-runner-linux-x64-${r.version}.tar.gz`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
    mkdirSync(dirname(tarball),{recursive:true});
    const archive=Buffer.from(await res.arrayBuffer());
    writeFileSync(tarball, archive);
  }
  const sum = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  if (sum !== r.sha256) throw new Error(`${tarball}: sha256 ${sum} is not the record's ${r.sha256}`);
  mkdirSync(p.version, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', p.version]);
  log.push(`installed runner ${r.version} into ${p.version} (sha256 verified)`);
}

function assertRegistrationIdentity(r) {
  const file=join(paths(r).runner,'.runner');
  if(!existsSync(file))return false;
  const registered=JSON.parse(readFileSync(file,'utf8').replace(/^﻿/,''));
  if(registered.agentName!==r.name||registered.gitHubUrl!==r.scope)throw new Error('existing runner registration identity differs; reconcile original custody');
  return registered;
}

/** Absence and retained native identity are the only registration admissions. */
export function preflightRunnerRegistration(r,{run=execFileSync}={}){
  const local=assertRegistrationIdentity(r);
  const remote=readRunnerRegistration(r,{run});
  if(!local){
    if(remote.state!=='absent')throw new Error('new runner requires explicit same-scope remote absence');
  }else if(!['current','drift'].includes(remote.state)||!Number.isSafeInteger(local.agentId)||local.agentId!==remote.id){
    throw new Error('retained local and remote runner identity is unreceived');
  }
  return {local:local?{id:local.agentId,name:local.agentName,scope:local.gitHubUrl}:null,remote};
}

function acquireRegistrationToken(r,invocation,run){
  try{
    const raw=invocation?run(invocation.executable,invocation.args,{encoding:'utf8',timeout:10000,maxBuffer:65536,stdio:['ignore','pipe','ignore']})
      :run('bash',['-c',r.credentialCommand],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
    const token=String(raw).trim();
    if(!token||/[\r\n\0]/.test(token))throw new Error('invalid token supplier result');
    return token;
  }catch{throw Object.assign(new Error('runner registration token supplier failed; native diagnostics withheld'),{code:'runner-registration-token-unavailable'});}
}

export function registerRunner(r, log, {run=execFileSync}={}) {
  if(r.registration)preflightRunnerRegistration(r,{run});
  if (assertRegistrationIdentity(r)) return;
  if (!r.credentialCommand&&!r.registration) throw new Error(`[${r.name}] no registration supplier`);
  const invocation=r.registration?registrationInvocation(r,'POST'):null;
  const token = acquireRegistrationToken(r,invocation,run);
  configureRunner(r,token,{run});
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
  if (!existsSync(versionMarker(p.version))) return;
  const packagePath = join(p.runner, 'package.json');
  if (!existsSync(packagePath)) writeIfChanged(packagePath, '{"type":"commonjs"}\n', log);
  if (!isVersion(p.runner, p.version)) {
    if (workerRunning(r)) { markReconcilePending(r); log.push(`${r.name}: relinking deferred while its job runs`); return; }
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

/** The slice every runner shares: one hard memory ceiling for all CI on the host (CR-8, CR-9). */
export function renderSlice(record) {
  return [
    '[Unit]',
    'Description=CI runners on this host, under one memory ceiling (ci-runner-host-service)',
    '',
    '[Slice]',
    `MemoryMax=${record.sliceMemoryMax}`,
    'MemorySwapMax=0',
    '',
  ].join('\n');
}

/**
 * Whether a runner's process started before its unit, .env or .path last changed, so it runs a configuration it has not read
 * (CR-32). This is evidence from the files and the process, not "changed in this apply": a restart deferred by an
 * earlier apply is still owed after that apply wrote the files.
 */
export function staleConfiguration({ activeSince, unitModified, envModified, pathModified }) {
  if (!Number.isFinite(activeSince)) return false;
  return [unitModified, envModified, pathModified].some((modified) => Number.isFinite(modified) && modified > activeSince);
}
const runsStaleConfiguration = (r, unitPath, envPath) => {
  const since = shOk('systemctl', ['--user', 'show', unitName(r), '-p', 'ActiveEnterTimestamp', '--value']);
  const mtime = (path) => { try { return statSync(path).mtimeMs; } catch { return NaN; } };
  return staleConfiguration({ activeSince: since ? Date.parse(since.replace(/^\w+ /, '')) : NaN, unitModified: mtime(unitPath), envModified: mtime(envPath), pathModified: mtime(join(paths(r).runner, '.path')) });
};

/**
 * The service's installed release (CR-34): `reconcile` names its source repository, an exact commit and a root
 * directory. The root holds a sparse, blobless checkout of only this service at that commit, kept current by apply;
 * the reconcile unit runs the CLI found there. Upgrading the service is changing the commit in the record, and that
 * change is itself the event (CR-30) on which the reconcile installs the new release. A root holding local changes is
 * never overwritten. Returns the absolute path of the release's CLI.
 */
export function releasePlan(reconcile) {
  const { source, commit, root } = reconcile ?? {};
  if (typeof source !== 'string' || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(source)
      || typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit) || typeof root !== 'string' || !isAbsolute(root))
    throw new TypeError('reconcile names the source repository (https://github.com/owner/name.git), an exact 40-hex commit and an absolute root');
  return { source, commit, root, cli: join(root, 'services', 'ci-runner-host-service', 'scripts', 'ci-runner-host.mjs') };
}
function ensureRelease(reconcile, log) {
  const { source, commit, root, cli } = releasePlan(reconcile);
  const git = (...args) => execGitSync(['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (!existsSync(join(root, '.git'))) {
    mkdirSync(root, { recursive: true });
    execGitSync(['clone', '--quiet', '--filter=blob:none', '--no-checkout', source, root], { stdio: ['ignore', 'ignore', 'pipe'] });
    git('sparse-checkout', 'set', '--no-cone', '/services/ci-runner-host-service/');
    log.push(`cloned the service release into ${root}`);
  }
  // A fresh --no-checkout clone has no index yet (status would list every file as deleted), and its HEAD may already
  // name the commit: only a populated checkout is checked for local changes, and an empty one is always checked out.
  const checkedOut = git('ls-files') !== '';
  if (checkedOut && git('status', '--porcelain', '--untracked-files=no')) throw new Error(`${root} holds local changes; the release is not overwritten`);
  let head = '';
  try { head = git('rev-parse', 'HEAD'); } catch { /* no commit checked out yet */ }
  if (head !== commit || !checkedOut) {
    try { git('cat-file', '-e', `${commit}^{commit}`); } catch { git('fetch', '--quiet', '--filter=blob:none', 'origin', commit); }
    git('checkout', '--quiet', '--detach', commit);
    log.push(`release ${root} now at ${commit}`);
    return { cli, installed: true };
  }
  return { cli, installed: false };
}

export const RECONCILE_UNIT = 'ci-runner-host-reconcile';

/**
 * The host's reconcile units (CR-30, CR-31): `apply` runs when something happens, never on a clock. The path unit
 * starts it when the parameter record changes; the job-completed hook starts it after a job during which apply had to
 * defer a change (CR-31). A hung job ends at its workflow's own timeout-minutes, which frees its runner and the host's
 * job slot; nothing here kills a job for its age.
 */
export function renderReconcile(record, { node = process.execPath, cli } = {}) {
  const q = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;
  return {
    service: [
      '[Unit]', `Description=Reconcile the CI runners of ${record.host} with their record (ci-runner-host-service)`, '',
      '[Service]', 'Type=oneshot', `ExecStart=${q(node)} ${q(cli)} apply ${q(`--parameters=${record.parametersPath}`)}`,
      'Nice=10', 'TimeoutStartSec=15min', '',
    ].join('\n'),
    path: [
      '[Unit]', `Description=Reconcile the CI runners of ${record.host} when their record changes`, '',
      '[Path]', `PathChanged=${record.parametersPath}`, `Unit=${RECONCILE_UNIT}.service`, '',
      '[Install]', 'WantedBy=default.target', '',
    ].join('\n'),
  };
}

export async function apply(record, { registrationRun=execFileSync } = {}) {
  const unsupported = unsupportedPhysicalPolicy(record);
  if (unsupported) throw Object.assign(new Error(unsupported.detail), { code: 'runner-physical-policy-unavailable' });
  // Every registration identity is checked before anything on the host changes.
  for (const r of record.runners) {
    renderEnvironment(r.environment);
    assertRegistrationIdentity(r);
    if(r.registration)preflightRunnerRegistration(r,{run:registrationRun});
  }
  const log = [];
  // This apply is the reconcile a deferral asked for; a change it must defer again marks it pending again.
  for (const r of record.runners) rmSync(paths(r).reconcilePending, { force: true });
  if (record.reconcile && record.parametersPath) {
    // CR-34: the reconcile runs the service's installed release, never whichever copy ran this apply (a temporary
    // clone that was then removed left the unit pointing at nothing, 2026-11-01).
    const { cli, installed } = ensureRelease(record.reconcile, log);
    if (installed) {
      // The code running this apply predates the release it just installed: hand the rest of the reconcile to the new
      // release, so its hooks and units are what the host gets (the install is the event; the next apply finds the
      // release current and does not hand over again).
      execFileSync(process.execPath, [cli, 'apply', `--parameters=${record.parametersPath}`], { stdio: 'inherit' });
      log.push(`handed the reconcile to the release at ${record.reconcile.commit}`);
      return log;
    }
    const units = renderReconcile(record, { cli });
    const timer = reconcileUnitPath('timer');
    if (existsSync(timer)) {
      shOk('systemctl', ['--user', 'disable', '--now', `${RECONCILE_UNIT}.timer`]);
      rmSync(timer);
      log.push(`removed ${timer}: the reconcile runs on events, not a calendar`);
    }
    const changed = [writeIfChanged(reconcileUnitPath('service'), units.service, log),
      writeIfChanged(reconcileUnitPath('path'), units.path, log)].some(Boolean);
    if (changed) shOk('systemctl', ['--user', 'daemon-reload']);
    shOk('systemctl', ['--user', 'enable', '--now', `${RECONCILE_UNIT}.path`]);
  }
  const slices = [...new Set(record.runners.map((r) => r.slice))];
  let reload = false;
  if (record.sliceMemoryMax) for (const s of slices) reload = writeIfChanged(join(unitDir(), s), renderSlice(record), log) || reload;
  for (const r of record.runners) {
    const p = paths(r);
    await ensureVersion(r, log);
    link(r, log);
    registerRunner(r, log,{run:registrationRun});
    writeIfChanged(p.hook, renderHook(r), log, 0o755);
    const envPath = join(p.runner, '.env');
    writeIfChanged(p.startHook, renderStartHook(r), log, 0o755);
    // The runner reads .env only when it starts: a changed .env needs a restart (deferred while a job runs).
    const envChanged = writeIfChanged(envPath, mergeEnv(mergeEnv(text(envPath), HOOK_KEY, p.hook), START_HOOK_KEY, p.startHook), log);
    // runsvc.sh restores its registration-time PATH after systemd starts it.
    const pathChanged = r.environment?.PATH !== undefined
      && writeIfChanged(join(p.runner, '.path'), r.environment.PATH, log);
    const unitPath = runnerUnitPath(r);
    if (lst(unitPath)?.isSymbolicLink()) rmSync(unitPath);
    let unitChanged = writeIfChanged(unitPath, renderUnit(r), log);
    // Drop-ins from the retired controls-only mode; the unit now carries its own ceilings.
    const dropIn = removedControlsPath(r);
    if (existsSync(dropIn)) { rmSync(dropIn); log.push(`removed ${dropIn}`); unitChanged = true; }
    if (unitChanged || reload) shOk('systemctl', ['--user', 'daemon-reload']);
    shOk('systemctl', ['--user', 'enable', unitName(r)]);
    if (unitChanged || envChanged || pathChanged || runsStaleConfiguration(r, unitPath, envPath) || shOk('systemctl', ['--user', 'is-active', unitName(r)]) !== 'active') {
      if (!workerRunning(r)) { shOk('systemctl', ['--user', 'restart', unitName(r)]); log.push(`started ${unitName(r)}`); }
      else { markReconcilePending(r); log.push(`${unitName(r)} changed; restart deferred while its job runs`); }
    }
  }
  return log;
}


