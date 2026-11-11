import { receiveQuarantineReadRecord } from './quarantine-read-record.mjs';
// Durable boot/reentry custody and explicit terminal completion for record-owned units.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';

const hash = b => createHash('sha256').update(b).digest('hex');
const fail = message => { throw new Error('quarantine refused: ' + message); };
const read = (p, max = 65536) => { const b = readFileSync(p); if (b.length > max) fail('oversized ' + p); return b.toString('utf8'); };
const same = (a, b, label) => { if (!isDeepStrictEqual(a, b)) fail(label + ' changed'); };
const pathData = p => typeof p === 'string' && /^\/[A-Za-z0-9_./+@=-]+$/.test(p) && !p.split('/').includes('..');
// Validate the whole declaration set before selecting any mutation subject.
export function quarantineDeclarations(parameters) {
  const linux = parameters.linux ?? {};
  const collection = linux.userUnitQuarantines;
  if (collection !== undefined && (!Array.isArray(collection) || collection.length < 1 || collection.length > 32)) fail('invalid quarantine collection');
  const raw = [...(linux.userUnitQuarantine === undefined ? [] : [linux.userUnitQuarantine]), ...(collection ?? [])];
  if (!raw.length) fail('no declared quarantine; omission does not release an existing native hold');
  const declarations = raw.map(parseQuarantineDeclaration);
  for (const key of ['id', 'unit', 'marker', 'guard']) {
    const seen = new Set();
    for (const q of declarations) {
      if (seen.has(q[key])) fail('duplicate quarantine ' + key);
      seen.add(q[key]);
    }
  }
  return declarations;
}
function selectQuarantines(parameters, selectorId) {
  const declarations = quarantineDeclarations(parameters);
  if (selectorId === undefined) return declarations;
  if (typeof selectorId !== 'string' || !selectorId) fail('nonempty explicit quarantine-id required');
  const selected = declarations.find(q => q.id === selectorId);
  if (!selected) fail('explicit quarantine-id not found');
  return [selected];
}
export function quarantineDeclaration(parameters, selectorId) {
  const selected = selectQuarantines(parameters, selectorId);
  if (selected.length !== 1) fail('ambiguous quarantine mutation selection; explicit quarantine-id required');
  return selected[0];
}
function parseQuarantineDeclaration(q) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) fail('invalid quarantine declaration');
  const captureMode = q.captureMode ?? 'frozen-resident';
  if (!['frozen-resident', 'stopped-no-resident'].includes(captureMode)) fail('unknown quarantine capture mode');
  const releasePolicy = q.releasePolicy ?? 'cde-release';
  if (!['cde-release', 'hold-only'].includes(releasePolicy)) fail('unknown quarantine release policy');
  if (releasePolicy === 'hold-only' && q.effectDependencies !== undefined && (!Array.isArray(q.effectDependencies) || q.effectDependencies.length !== 0)) fail('hold-only cannot declare effect dependencies');
  if (captureMode === 'stopped-no-resident') {
    for (const name of ['bootId', 'execStart']) if (typeof q.expected?.[name] !== 'string' || !q.expected[name].trim() || q.expected[name].length > 65536) fail('stopped expected ' + name + ' required');
    if (releasePolicy !== 'hold-only') {
      if (!Array.isArray(q.effectDependencies) || q.effectDependencies.length < 1 || q.effectDependencies.length > 16) fail('explicit stopped effect dependencies required');
      const subjects = new Set();
      for (const d of q.effectDependencies) {
        if (!d || d.type !== 'CdePromotionUnknownEffect' || typeof d.unit !== 'string' || !/^[a-zA-Z0-9_.@-]+\.service$/.test(d.unit) || !/^[a-f0-9]{32}$/.test(d.invocationId || '') || !/^[a-f0-9]{40}$/.test(d.hostCommit || '') || d.terminalReceivingRequired !== true) fail('invalid effect dependency');
        const subject = d.unit + ':' + d.invocationId + ':' + d.hostCommit;
        if (subjects.has(subject)) fail('duplicate effect dependency');
        subjects.add(subject);
      }
    }
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(q.id) || !/^[a-zA-Z0-9_.@-]+\.service$/.test(q.unit) || !Number.isSafeInteger(q.uid) || q.uid < 1 || !pathData(q.home) || !q.origin) fail('invalid owner binding');
  if (!pathData(q.sectionRoot) || resolve(q.sectionRoot) !== q.sectionRoot || !basename(q.sectionRoot).endsWith('-services-section') || q.sectionRoot.startsWith('/gnu/store/') || q.sectionRoot.split('/').some(part => ['.local', 'node_modules'].includes(part))) fail('explicit canonical owning sectionRoot required');
  const area = join(q.sectionRoot, 'data/state/wsl-user-unit-quarantine-state');
  const marker = join(area, q.id + '.json');
  const guard = join(q.home, '.config/systemd/user', q.unit + '.d', '90-wsl-host-quarantine-' + q.id + '.conf');
  return { ...q, captureMode, releasePolicy, area, marker, guard, released: join(area, q.id + '.released.json'), completed: join(area, q.id + '.completed.json'),
    completionGuard: join(q.home, '.config/systemd/user', q.unit + '.d', '99-wsl-host-completion-' + q.id + '.conf'),
    guardText: '# Owned by the WSL host record. Ordinary apply never clears this hold.\n[Unit]\nConditionPathExists=!' + marker + '\n' };
}
export function nativeQuarantinePort({ budgetMs = 15000 } = {}) {
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 60000) fail('finite native allocation required');
  const deadline = performance.now() + budgetMs;
  const runNative = (executable, args) => {
    const timeout = Math.floor(deadline - performance.now());
    if (timeout < 1) fail('native allocation exhausted');
    return execFileSync(executable, args, { encoding: 'utf8', timeout, maxBuffer: 65536 });
  };
  const run = args => runNative('/usr/bin/systemctl', ['--user', ...args]);
  return {
    uid: () => process.getuid(),
    reload: () => run(['daemon-reload']),
    retire(unit, { original, marker, guard } = {}) {
      const check = (state, waiting = false) => {
        same(state.Id, unit, 'retirement unit');
        if (state.Restart !== 'no' || !(state.ExecCondition || '').includes('path=/usr/bin/false ')) fail('retirement restart suppression not loaded');
        if (!waiting && (state.ControlPID !== '0' || (state.Job && state.Job !== '0'))) fail('retirement control operation or queued job');
        if (!(state.DropInPaths || '').split(' ').includes(guard)
          || !state.conditions?.some(row => row[0] === 'ConditionPathExists' && row[1] === false && row[2] === true && row[3] === marker)
          || !existsSync(marker)) fail('original retirement guard no longer loaded');
      };
      let state = this.unit(unit); check(state, true);
      if (state.MainPID !== '0') {
        same(state.InvocationID, original?.invocationId, 'retirement invocation');
        same(state.MainPID, String(original?.pid), 'retirement main PID');
        same(state.FreezerState, 'frozen', 'retirement frozen capture');
        same(this.process(original.pid), original.process, 'retirement process');
        run(['kill', '--kill-whom=all', '--signal=KILL', unit]);
      }
      // Some managers reject stop on a frozen unit and queue Restart=always.
      // Only the empty captured cohort is thawed; its old code is already gone,
      // and the original negative marker still denies every fresh activation.
      for (;;) {
        state = this.unit(unit); check(state, true);
        if (state.MainPID === '0' && state.ControlPID === '0' && (!state.Job || state.Job === '0') && this.cohortTerminal(original.controlGroup)) break;
        if (performance.now() >= deadline) fail('captured retirement remains populated');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      let cancellationAttempted = false, freezerReset = false;
      for (;;) {
        state = this.unit(unit); check(state, true);
        if (state.MainPID !== '0') fail('retirement cohort changed');
        if (['inactive', 'failed'].includes(state.ActiveState) && state.ControlPID === '0' && (!state.Job || state.Job === '0') && this.cohortTerminal(original.controlGroup)) {
          if (state.FreezerState !== 'frozen') return;
          // systemd 257 keeps a unit killed while frozen marked frozen after its
          // cgroup is gone: thaw answers "Unit is not active" and every later
          // start or stop answers "Cannot perform operation on frozen unit".
          // Under the loaded Restart=no guard the unit is failed, and
          // reset-failed is the one operation that clears the stale freezer
          // state; it starts nothing.
          if (freezerReset) fail('retired unit remains frozen after reset-failed');
          freezerReset = true;
          run(['reset-failed', unit]);
          continue;
        }
        if (!cancellationAttempted && ['active', 'activating'].includes(state.ActiveState) && state.ControlPID === '0' && (!state.Job || state.Job === '0') && this.cohortTerminal(original.controlGroup)) {
          cancellationAttempted = true;
          try {
            if (state.FreezerState === 'frozen') run(['thaw', unit]);
            run(['stop', unit]);
          } catch (error) {
            const after = this.unit(unit); check(after, true);
            if (after.MainPID !== '0') fail('retirement cancellation changed cohort');
            // Inactive freezer replies are received by observation below;
            // never repeat a thaw or stop merely because its reply differed.
            if (!/Unit is (?:not active|inactive)/.test(String(error.stderr || ''))) throw error;
          }
          continue;
        }
        // An already queued restart can retain activating without a live cgroup.
        // Its received false ExecCondition prevents the obsolete entry; wait
        // within this same native deadline for the skipped job to be terminal.
        if (state.ActiveState !== 'activating' || performance.now() >= deadline)
          fail(state.FreezerState === 'frozen'
            ? 'retirement deadlocked: a restart was queued while the unit was frozen, so systemd refuses both thaw and stop; the restart guard was not loaded when the cohort was killed'
            : 'guarded retirement restart remains queued');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    },
    unit: unit => {
      const output = run(['show', unit, '--no-pager', '--property=Id,LoadState,MainPID,ControlPID,InvocationID,ControlGroup,ActiveState,SubState,FreezerState,Job,DropInPaths,ExecStart,Restart,ExecCondition']);
      const result = Object.fromEntries(output.trim().split('\n').filter(Boolean).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
      const escaped = [...unit].map(c => /[A-Za-z0-9]/.test(c) ? c : '_' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
      const conditions = JSON.parse(runNative('/usr/bin/busctl', ['--user', '--json=short', 'get-property', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1/unit/' + escaped, 'org.freedesktop.systemd1.Unit', 'Conditions']));
      if (conditions.type !== 'a(sbbsi)' || !Array.isArray(conditions.data)) fail('unqualified native condition schema');
      result.conditions = conditions.data;
      return result;
    },
    process: pid => {
      const stat = read('/proc/' + pid + '/stat');
      const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return { pid, startTime: tail[19], argv: read('/proc/' + pid + '/cmdline').split('\0').filter(Boolean),
        cwd: realpathSync('/proc/' + pid + '/cwd'), cgroup: read('/proc/' + pid + '/cgroup').trim() };
    },
    profileArtifact: ({ node, selector, guix, profile }) => {
      // The selected immutable CDE owns the native Guix profile codec. A
      // package.json may belong to its shared registry runtime, not this host.
      const code = 'import{profileArtifact}from ' + JSON.stringify(pathToFileURL(selector).href)
        + ';import{execFileSync}from"node:child_process";process.stdout.write(profileArtifact(execFileSync('
        + JSON.stringify(guix) + ',["package","--profile="+' + JSON.stringify(profile)
        + ',"--list-installed"],{encoding:"utf8",timeout:10000,maxBuffer:32768})));';
      return runNative(node, ['--input-type=module', '--eval', code]).trim();
    },
    boot: () => read('/proc/sys/kernel/random/boot_id').trim(),
    cohortTerminal: group => {
      if (!/^\/[A-Za-z0-9_./@:-]+$/.test(group) || group.includes('..')) fail('invalid captured cgroup');
      const path = '/sys/fs/cgroup' + group + '/cgroup.events';
      try { return /^populated 0$/m.test(read(path)); } catch (e) { if (e.code === 'ENOENT') return true; throw e; }
    }
  };
}
// Absence is a missing entry, never a dangling redirect.
const entryExists = p => { try { lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
function ownedPath(p, q, { create = false, privateFile = false, allowMissing = false } = {}) {
  const anchor = p === q.sectionRoot || p.startsWith(q.sectionRoot + '/') ? q.sectionRoot : q.home;
  if (p !== anchor && !p.startsWith(anchor + '/')) fail('path outside declared owner');
  const parts = [anchor, ...p.slice(anchor.length + 1).split('/').filter(Boolean)];
  let current = parts.shift();
  for (const part of [null, ...parts]) {
    if (part) current = join(current, part);
    if (!entryExists(current)) {
      if (create) mkdirSync(current, { mode: 0o700 });
      else if (allowMissing) return false;
    }
    const st = lstatSync(current);
    if (st.isSymbolicLink() || realpathSync(current) !== current || st.uid !== q.uid || (st.mode & 0o022)) fail('unsafe owner path ' + current);
    if (current !== p && !st.isDirectory()) fail('non-directory owner path');
    if (privateFile && current === p && (!st.isFile() || (st.mode & 0o077))) fail('non-private custody file');
  }
  return true;
}
function receiveOwner(q) {
  ownedPath(q.sectionRoot, q);
  if (!lstatSync(q.sectionRoot).isDirectory()) fail('owning sectionRoot is not a directory');
  ownedPath(q.area, q, { allowMissing: true });
}
function receiveExistingGuard(q) {
  if (!entryExists(q.guard)) return;
  ownedPath(q.guard, q, { privateFile: true });
  if (read(q.guard) !== q.guardText) fail('native guard bytes changed; independently migrate original custody before changing its marker path');
}
function syncDir(p) { const fd = openSync(p, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function exclusive(p, text, q) {
  ownedPath(dirname(p), q, { create: true });
  const fd = openSync(p, 'wx', 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  syncDir(dirname(p));
}
// The stopped witness records only properties actually read from a loaded unit.
// A retained InvocationID is historical unit metadata, never a resident identity.
function stoppedUnitFacts(q, u) {
  same(u?.Id, q.unit, 'stopped unit');
  same(u.LoadState, 'loaded', 'stopped load state');
  if (typeof u.ExecStart !== 'string' || !u.ExecStart.trim() || u.ExecStart.length > 65536) fail('loaded stopped command required');
  same(u.MainPID, '0', 'stopped main PID');
  same(u.ControlPID, '0', 'stopped control PID');
  if (typeof u.Job !== 'string' || !['', '0'].includes(u.Job)) fail('stopped queued job or unknown job');
  if (!['inactive', 'failed'].includes(u.ActiveState) || !['dead', 'failed'].includes(u.SubState)) fail('stopped terminal state required');
  // A unit still marked frozen refuses every later start, so it is not stopped.
  if (u.FreezerState === 'frozen') fail('stopped unit remains frozen');
  if (typeof u.ControlGroup !== 'string' || typeof u.InvocationID !== 'string' || !/^(?:[a-f0-9]{32})?$/.test(u.InvocationID)) fail('stopped native identity witness required');
  return Object.fromEntries(['Id', 'LoadState', 'ExecStart', 'MainPID', 'ControlPID', 'Job', 'ActiveState', 'SubState', 'ControlGroup', 'InvocationID'].map(key => [key, u[key]]));
}
function receiveStoppedUnit(q, native, unit = native.unit(q.unit)) {
  same(native.uid(), q.uid, 'executing stopped owner');
  const witness = stoppedUnitFacts(q, unit);
  if (witness.ControlGroup !== '' && native.cohortTerminal(witness.ControlGroup) !== true) fail('stopped hierarchical cohort remains populated');
  return witness;
}
function capture(q, native) {
  same(native.uid(), q.uid, 'executing owner');
  const u = native.unit(q.unit);
  same(u.Id, q.unit, 'unit');
  if (q.captureMode === 'stopped-no-resident') {
    const unit = receiveStoppedUnit(q, native, u), bootId = native.boot();
    same(bootId, q.expected.bootId, 'stopped boot');
    same(unit.ExecStart, q.expected.execStart, 'stopped command');
    return { captureMode: q.captureMode, bootId, resident: null, unit };
  }
  if (u.ControlPID !== '0' || (u.Job && u.Job !== '0')) fail('control operation or queued job');
  same(u.MainPID, String(q.expected.pid), 'main PID');
  same(u.InvocationID, q.expected.invocationId, 'invocation');
  same(u.ControlGroup, q.expected.controlGroup, 'control group');
  same([u.ActiveState, u.SubState, u.FreezerState], ['active', 'running', 'frozen'], 'frozen resident');
  same(native.boot(), q.expected.bootId, 'boot');
  same(native.process(q.expected.pid), q.expected.process, 'process identity');
  return { bootId: q.expected.bootId, pid: q.expected.pid, invocationId: u.InvocationID, controlGroup: u.ControlGroup, process: q.expected.process };
}
function readMarker(q) {
  ownedPath(q.marker, q, { privateFile: true });
  const text = read(q.marker);
  const marker = JSON.parse(text);
  if (marker.type !== 'WslUserUnitQuarantine' || marker.version !== 1) fail('unknown hold format');
  same([marker.id, marker.unit, marker.uid, marker.home], [q.id, q.unit, q.uid, q.home], 'hold owner');
  same(marker.captureMode ?? 'frozen-resident', q.captureMode, 'hold capture mode');
  same(marker.releasePolicy ?? 'cde-release', q.releasePolicy, 'hold release policy');
  if (q.releasePolicy === 'hold-only' && marker.effectDependencies !== undefined) fail('hold-only marker cannot contain effect dependencies');
  if (q.captureMode === 'stopped-no-resident') {
    if (marker.original?.captureMode !== q.captureMode || marker.original.resident !== null) fail('stopped original capture required');
    same(marker.original.bootId, q.expected.bootId, 'original stopped boot');
    const unit = stoppedUnitFacts(q, marker.original.unit);
    same(unit.ExecStart, q.expected.execStart, 'original stopped command');
    if (q.releasePolicy !== 'hold-only') same(marker.effectDependencies, q.effectDependencies, 'original effect dependencies');
  }
  return { marker, text, digest: hash(text) };
}
function guardLoaded(q, native, observedUnit) {
  ownedPath(q.guard, q, { privateFile: true });
  same(read(q.guard), q.guardText, 'native guard bytes');
  const unit = observedUnit ?? native.unit(q.unit);
  if (!(unit.DropInPaths || '').split(' ').includes(q.guard)) fail('guard not loaded by user manager');
  if (!unit.conditions?.some(row => row[0] === 'ConditionPathExists' && row[1] === false && row[2] === true && row[3] === q.marker)) fail('effective negative marker condition missing');
  if (q.captureMode === 'stopped-no-resident') receiveStoppedUnit(q, native, unit);
}
export function planQuarantine(parameters, native = nativeQuarantinePort(), selectorId) {
  const results = selectQuarantines(parameters, selectorId).map(q => planOneQuarantine(q, native));
  if (results.length === 1) return results[0];
  return { type: 'WslUserUnitQuarantinePlanCollection', status: results.every(r => r.status === 'held') ? 'held' : results.every(r => r.status === 'unheld') ? 'unheld' : 'mixed', quarantines: results };
}
function planOneQuarantine(q, native) {
  same(native.uid(), q.uid, 'executing owner');
  receiveOwner(q); receiveExistingGuard(q);
  if (!entryExists(q.marker)) return { type: 'WslUserUnitQuarantinePlan', id: q.id, status: 'unheld', unit: q.unit, marker: q.marker };
  const held = readMarker(q); guardLoaded(q, native);
  if (q.releasePolicy === 'hold-only' && q.captureMode === 'frozen-resident') same(capture(q, native), held.marker.original, 'held preventive frozen invocation');
  return { type: 'WslUserUnitQuarantinePlan', id: q.id, status: 'held', unit: q.unit, marker: q.marker, markerSha256: held.digest, original: held.marker.original };
}
/** Explicit observation of existing original custody only. Never a fallback
 * for creation, release, migration or a claim that the old resident survives. */
function legacyQuarantineDeclaration(parameters) {
  const declared = parameters.linux?.legacyUserUnitQuarantine;
  if (!declared || !/^[a-f0-9]{64}$/.test(declared.markerSha256 || '') || !/^[a-f0-9]{64}$/.test(declared.guardSha256 || '')) fail('explicit exact legacy marker and guard digests required');
  const q = parseQuarantineDeclaration(declared);
  q.marker = join(q.home, '.local/state/wsl-host-service/quarantines', q.id + '.json');
  q.guardText = '# Owned by the WSL host record. Ordinary apply never clears this hold.\n[Unit]\nConditionPathExists=!' + q.marker + '\n';
  return { q, declared };
}
export function receiveLegacyQuarantine(parameters, native = nativeQuarantinePort()) {
  const { q, declared } = legacyQuarantineDeclaration(parameters);
  same(native.uid(), q.uid, 'legacy executing owner');
  ownedPath(q.sectionRoot, q);
  const held = readMarker(q);
  same(held.digest, declared.markerSha256, 'original legacy marker digest');
  same(held.marker.origin, q.origin, 'original legacy authority locator');
  ownedPath(q.guard, q, { privateFile: true });
  same(hash(read(q.guard)), declared.guardSha256, 'original legacy guard digest');
  guardLoaded(q, native);
  return { type: 'WslLegacyUserUnitQuarantineReceiving', version: 1, status: 'held',
    unit: q.unit, marker: q.marker, markerSha256: held.digest, guard: q.guard,
    guardSha256: declared.guardSha256, original: held.marker.original,
    currentResidentClaimed: false, effectsExecuted: false, released: false };
}
export function holdQuarantine(parameters, native = nativeQuarantinePort(), selectorId) {
  const q = quarantineDeclaration(parameters, selectorId);
  same(native.uid(), q.uid, 'executing owner');
  receiveOwner(q); receiveExistingGuard(q);
  if (entryExists(q.released) || entryExists(q.completed)) fail('completed identity cannot be reused for a new hold');
  if (entryExists(q.marker)) {
    const held = readMarker(q);
    same(held.marker.original, capture(q, native), 'held invocation');
    same(readMarker(q).digest, held.digest, 'hold marker');
    if (entryExists(q.guard)) {
      const unit = native.unit(q.unit);
      same(unit.Id, q.unit, 'guard observation unit');
      if (typeof unit.DropInPaths !== 'string' || !Array.isArray(unit.conditions)) fail('native guard observation unread');
      const loaded = unit.DropInPaths.split(' ').includes(q.guard)
        && unit.conditions.some(row => row[0] === 'ConditionPathExists' && row[1] === false && row[2] === true && row[3] === q.marker);
      if (loaded) {
        guardLoaded(q, native, unit);
        if (q.captureMode === 'stopped-no-resident') same(capture(q, native), held.marker.original, 'stopped capture after loaded guard');
        else if (q.releasePolicy === 'hold-only') same(capture(q, native), held.marker.original, 'preventive capture after loaded guard');
        same(readMarker(q).digest, held.digest, 'hold marker');
        return { status: 'held', markerSha256: held.digest, unchanged: true };
      }
      receiveExistingGuard(q);
    } else exclusive(q.guard, q.guardText, q);
    // Complete only this exact earlier marker's interrupted guard/reload stage.
    // Unknown observations, unsafe paths and competing bytes never grant repair.
    same(readMarker(q).digest, held.digest, 'hold marker');
    same(capture(q, native), held.marker.original, 'partial hold capture before reload');
    native.reload();
    same(readMarker(q).digest, held.digest, 'hold marker');
    same(capture(q, native), held.marker.original, 'partial hold capture after reload');
    guardLoaded(q, native);
    same(capture(q, native), held.marker.original, 'partial hold capture after loaded guard');
    same(readMarker(q).digest, held.digest, 'hold marker');
    return { status: 'held', markerSha256: held.digest, unchanged: false };
  }
  const original = capture(q, native);
  const marker = { type: 'WslUserUnitQuarantine', version: 1, id: q.id, unit: q.unit, uid: q.uid, home: q.home, origin: q.origin, ...(q.captureMode === 'stopped-no-resident' ? { captureMode: q.captureMode, ...(q.releasePolicy !== 'hold-only' ? { effectDependencies: q.effectDependencies } : {}) } : {}), ...(q.releasePolicy === 'hold-only' ? { releasePolicy: q.releasePolicy } : {}), original, heldAt: new Date().toISOString() };
  // Marker first: a partial operation never clears custody. A marker without its
  // loaded guard is explicitly NOT received as a boot-safe hold.
  exclusive(q.marker, JSON.stringify(marker) + '\n', q);
  if (entryExists(q.guard)) { ownedPath(q.guard, q, { privateFile: true }); same(read(q.guard), q.guardText, 'existing guard'); }
  else exclusive(q.guard, q.guardText, q);
  same(capture(q, native), original, 'capture after custody');
  native.reload();
  same(capture(q, native), original, 'capture after reload');
  guardLoaded(q, native);
  if (q.captureMode === 'stopped-no-resident') same(capture(q, native), original, 'stopped capture after loaded guard');
  else if (q.releasePolicy === 'hold-only') same(capture(q, native), original, 'preventive capture after loaded guard');
  return { status: 'held', markerSha256: readMarker(q).digest, unchanged: false };
}
// Stable selected declaration identity excludes the separate preparation binding.
function sortedData(value) {
  if (Array.isArray(value)) return value.map(sortedData);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedData(value[key])]));
  return value;
}
/** Explicit native-only owner prerequisite; ordinary hold/apply never calls it.
 * No injectable observation can issue permission authority through this entry. */
export function prepareQuarantineOwnerPaths(parametersPath, expectedParametersSha256, selectorId) {
  if (arguments.length !== 3 || typeof selectorId !== 'string' || !selectorId || !/^[a-f0-9]{64}$/.test(expectedParametersSha256 || '')) fail('exact canonical record digest and quarantine id required');
  if (!pathData(parametersPath) || resolve(parametersPath) !== parametersPath) fail('canonical parameter path required');
  const sectionPrefix = parametersPath.slice(0, parametersPath.lastIndexOf('/data/records/'));
  if (!basename(sectionPrefix).endsWith('-services-section')) fail('original section record required');
  const recordBinding = { sectionRoot: sectionPrefix, uid: process.getuid(), parametersPath };
  const parameterRecord = receiveQuarantineReadRecord(recordBinding, 'parametersPath', expectedParametersSha256);
  const parameterBytes = parameterRecord.text;
  const parameters = JSON.parse(parameterBytes), q = quarantineDeclaration(parameters, selectorId);
  same(q.sectionRoot, sectionPrefix, 'selected canonical record section');
  if (!/^\/home\/[A-Za-z0-9_-]+$/.test(q.home) || !pathData(parametersPath) || resolve(parametersPath) !== parametersPath || !parametersPath.startsWith(join(q.sectionRoot, 'data/records') + '/')) fail('canonical declared user and owning parameter record required');
  const native = nativeQuarantinePort();
  same(native.uid(), q.uid, 'executing preparation owner');
  receiveOwner(q);
  if (entryExists(q.released)) fail('released identity cannot prepare owner paths');
  const binding = parameters.linux?.quarantineOwnerPathPreparation;
  if (!binding || Object.keys(binding).sort().join(',') !== 'path,sha256' || !pathData(binding.path) || resolve(binding.path) !== binding.path || !binding.path.startsWith(join(q.sectionRoot, 'data/records') + '/') || !/^[a-f0-9]{64}$/.test(binding.sha256 || '')) fail('exact original preparation record binding required');
  recordBinding.preparationPath = binding.path;
  const preparationRecord = receiveQuarantineReadRecord(recordBinding, 'preparationPath', binding.sha256);
  const preparationText = preparationRecord.text;
  const p = JSON.parse(preparationText), helper = fileURLToPath(new URL('../assets/prepare-quarantine-owner-paths.py', import.meta.url));
  if (p.type !== 'WslQuarantineOwnerPathPreparation' || p.version !== 1 || p.id !== q.id || p.parametersPath !== parametersPath || !/^[a-f0-9]{64}$/.test(p.historicalParametersSha256 || '')) fail('original preparation subject required');
  same(p.selectedQuarantineSha256, hash(JSON.stringify(sortedData(q))), 'selected original declaration');
  same(p.source, { moduleSha256: hash(read(fileURLToPath(import.meta.url), 1048576)), helperSha256: hash(read(helper, 1048576)), recordReceiverSha256: hash(read(fileURLToPath(new URL('./quarantine-read-record.mjs', import.meta.url)), 1048576)) }, 'preparation source identity');
  if (!Array.isArray(p.directories) || p.directories.length !== 2) fail('two fixed native directory prestates required');
  p.directories.forEach((row, index) => {
    if (!row || Object.keys(row).sort().join(',') !== 'device,gid,inode,mode,name,uid' || row.name !== ['.config', '.config/systemd'][index] || row.uid !== q.uid || row.gid !== process.getgid() || row.mode !== 0o775 || ![row.device, row.inode, row.uid, row.gid].every(value => Number.isSafeInteger(value) && value >= 0)) fail('fixed owner directory prestate required');
  });
  const held = readMarker(q);
  const receiveMarkerIdentity = () => {
    const st = lstatSync(q.marker);
    same(p.marker, { path: q.marker, sha256: held.digest, device: st.dev, inode: st.ino, uid: st.uid, gid: st.gid }, 'original marker identity');
    same(readMarker(q).digest, held.digest, 'original preparation marker');
    same(capture(q, native), held.marker.original, 'original paused preparation capture');
  };
  const recheck = () => {
    same(receiveQuarantineReadRecord(recordBinding, 'parametersPath', expectedParametersSha256), parameterRecord, 'canonical record before/after preparation');
    same(receiveQuarantineReadRecord(recordBinding, 'preparationPath', binding.sha256), preparationRecord, 'preparation record before/after effect');
    receiveMarkerIdentity();
  };
  recheck();
  const packet = { home: q.home, area: q.area, id: q.id,
    directories: p.directories.map(({ name, ...facts }) => facts),
    binding: { preparationSha256: binding.sha256, parametersSha256: expectedParametersSha256,
      selectedQuarantineSha256: p.selectedQuarantineSha256, marker: p.marker, source: p.source } };
  const result = JSON.parse(execFileSync('/usr/bin/python3', [helper], { input: JSON.stringify(packet), encoding: 'utf8', timeout: 15000, maxBuffer: 65536 }));
  recheck();
  if (result.status !== 'directories-received' || result.guardLoaded !== false || result.released !== false) fail('owner path result unread');
  return result;
}
// These private, source-owned records settle exact prior effects independently
// of a stopped unit, missing work directory or caller-supplied boolean.
function receiveEffectDependencyReceiving(q, held, r) {
  const dependencies = held.marker.effectDependencies, receivings = r.effectDependencyReceiving;
  if (!Array.isArray(dependencies) || !dependencies.length || !Array.isArray(receivings) || receivings.length !== dependencies.length) fail('complete effect dependency receiving required');
  for (let i = 0; i < dependencies.length; i++) {
    const entry = receivings[i];
    if (!entry || typeof entry !== 'object') fail('effect dependency receiving entry required');
    same(entry.dependency, dependencies[i], 'effect dependency receiving subject');
    if (!pathData(entry.path) || resolve(entry.path) !== entry.path || !entry.path.startsWith(join(q.sectionRoot, 'data/records') + '/') || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')) fail('canonical effect receiving path and digest required');
    ownedPath(entry.path, q, { privateFile: true });
    const text = read(entry.path);
    same(hash(text), entry.sha256, 'effect dependency receiving digest');
    const received = JSON.parse(text), terminal = received.terminalReceiving;
    const nonempty = value => typeof value === 'string' && value.trim().length > 0;
    if (received.type !== 'WslQuarantineEffectDependencyReceiving' || received.version !== 1 || !nonempty(received.receiver) || !nonempty(received.subject) || received.unknownEffectsReconciled !== true || !Array.isArray(received.unresolvedEffects) || received.unresolvedEffects.length) fail('independent effect dependency receiving incomplete');
    same(received.dependency, dependencies[i], 'received exact original effect dependency');
    if (!terminal || !nonempty(terminal.receipt) || !['completed', 'failed', 'reconciled-unknown'].includes(terminal.outcome)) fail('original terminal receiving required');
    if (terminal.outcome === 'reconciled-unknown' && !nonempty(terminal.reconciliationEvidence)) fail('independent unknown-effect reconciliation evidence required');
  }
}
/** Retire the exact captured invocation and finish its original control hold.
 * This is explicit administrative completion, never ordinary apply or release
 * of the old code. The next runtime is installed and started by its own owner.
 * HTTP, storage and other external effects are not settled by stopping a unit.
 */
export function completeQuarantine(parameters, native = nativeQuarantinePort(), selectorId) {
  const q = quarantineDeclaration(parameters, selectorId);
  same(native.uid(), q.uid, 'completion owner');
  receiveOwner(q);
  if (entryExists(q.released)) fail('a released identity is not a completion subject');
  const readCompletion = () => {
    ownedPath(q.completed, q, { privateFile: true });
    const text = read(q.completed);
    const result = JSON.parse(text);
    if (result.type !== 'WslUserUnitQuarantineCompletion' || result.version !== 1
      || !['retiring', 'retired', 'completed'].includes(result.phase)
      || typeof result.markerText !== 'string' || hash(result.markerText) !== result.markerSha256)
      fail('invalid completion outcome');
    same([result.id, result.unit], [q.id, q.unit], 'completion subject');
    const marker = JSON.parse(result.markerText);
    same([marker.id, marker.unit, marker.uid, marker.home, marker.origin],
      [q.id, q.unit, q.uid, q.home, q.origin], 'completed original owner');
    same(marker.captureMode ?? 'frozen-resident', q.captureMode, 'completed capture mode');
    same(marker.releasePolicy ?? 'cde-release', q.releasePolicy, 'completed hold policy');
    if (q.captureMode === 'frozen-resident')
      same(marker.original, { bootId: q.expected.bootId, pid: q.expected.pid,
        invocationId: q.expected.invocationId, controlGroup: q.expected.controlGroup,
        process: q.expected.process }, 'completed original capture');
    else {
      same(marker.original.bootId, q.expected.bootId, 'completed stopped boot');
      same(marker.original.unit.ExecStart, q.expected.execStart, 'completed stopped command');
    }
    return { value: result, text, marker };
  };
  const writeCompletion = (value, previous) => {
    const text = JSON.stringify(value) + '\n', pending = q.completed + '.pending';
    if (entryExists(pending)) {
      ownedPath(pending, q, { privateFile: true });
      same(read(pending), text, 'pending completion bytes');
    } else exclusive(pending, text, q);
    same(read(q.completed), previous, 'completion before update');
    renameSync(pending, q.completed); syncDir(q.area);
    return readCompletion();
  };
  let completed;
  if (entryExists(q.completed)) completed = readCompletion();
  else {
    receiveExistingGuard(q);
    const held = readMarker(q); guardLoaded(q, native);
    same(capture(q, native), held.marker.original, 'completion original capture');
    const value = { type: 'WslUserUnitQuarantineCompletion', version: 1,
      id: q.id, unit: q.unit, markerSha256: held.digest, markerText: held.text,
      phase: 'retiring', requestedAt: new Date().toISOString(),
      started: false, externalEffectsReconciled: false };
    exclusive(q.completed, JSON.stringify(value) + '\n', q);
    completed = readCompletion();
  }
  if (completed.value.phase === 'completed') {
    if (entryExists(q.marker) || entryExists(q.guard) || entryExists(q.completionGuard)) fail('completed hold was recreated');
    return { status: 'completed', unit: q.unit, unchanged: true, started: false,
      externalEffectsReconciled: false, outcome: q.completed };
  }
  const terminal = (observed = native.unit(q.unit)) => {
    const unit = receiveStoppedUnit(q, native, observed);
    const group = completed.marker.original.controlGroup;
    if (group && native.cohortTerminal(group) !== true) fail('captured hierarchical cohort remains populated');
    return unit;
  };
  if (completed.value.phase === 'retiring') {
    const restartText = '[Service]\nRestart=no\nExecCondition=/usr/bin/false\n';
    if (entryExists(q.completionGuard)) {
      ownedPath(q.completionGuard, q, { privateFile: true });
      same(read(q.completionGuard), restartText, 'completion restart guard');
    } else exclusive(q.completionGuard, restartText, q);
    let loaded = native.unit(q.unit);
    if (!(loaded.DropInPaths || '').split(' ').includes(q.completionGuard) || (loaded.Restart !== 'no' || !(loaded.ExecCondition || '').includes('path=/usr/bin/false '))) {
      native.reload(); loaded = native.unit(q.unit);
    }
    if (!(loaded.DropInPaths || '').split(' ').includes(q.completionGuard) || (loaded.Restart !== 'no' || !(loaded.ExecCondition || '').includes('path=/usr/bin/false ')))
      fail('completion restart suppression not loaded');
    same(readMarker(q).digest, completed.value.markerSha256, 'completion original marker');
    guardLoaded(q, native);
    const unit = native.unit(q.unit);
    if (unit.MainPID !== '0') {
      same(capture(q, native), completed.marker.original, 'captured invocation before retirement');
    }
    if (unit.MainPID !== '0' || !['inactive', 'failed'].includes(unit.ActiveState)) {
      if (typeof native.retire !== 'function') fail('native retirement unavailable');
      native.retire(q.unit, { original: completed.marker.original, marker: q.marker, guard: q.guard });
    }
    const terminalUnit = terminal();
    completed = writeCompletion({ ...completed.value, phase: 'retired', terminalUnit }, completed.text);
  }
  terminal();
  // The durable terminal outcome precedes removing only this owner's controls.
  // A partial clear is resumed from that outcome, without another kill or start.
  if (entryExists(q.marker)) {
    same(readMarker(q).digest, completed.value.markerSha256, 'original marker before completion');
    unlinkSync(q.marker); syncDir(dirname(q.marker));
  }
  if (entryExists(q.guard)) {
    receiveExistingGuard(q);
    unlinkSync(q.guard); syncDir(dirname(q.guard));
  }
  if (entryExists(q.completionGuard)) {
    ownedPath(q.completionGuard, q, { privateFile: true });
    same(read(q.completionGuard), '[Service]\nRestart=no\nExecCondition=/usr/bin/false\n', 'completion restart guard before removal');
    unlinkSync(q.completionGuard); syncDir(dirname(q.completionGuard));
  }
  native.reload();
  const finalLoaded = native.unit(q.unit), finalUnit = terminal(finalLoaded);
  if ((finalLoaded.DropInPaths || '').split(' ').some(path => [q.guard, q.completionGuard].includes(path))
    || finalLoaded.conditions?.some(row => row[0] === 'ConditionPathExists' && row[3] === q.marker))
    fail('completed control still loaded');
  completed = writeCompletion({ ...completed.value, phase: 'completed', terminalUnit: finalUnit }, completed.text);
  return { status: 'completed', unit: q.unit, unchanged: false, started: false,
    externalEffectsReconciled: false, outcome: q.completed };
}

export function releaseQuarantine(parameters, native = nativeQuarantinePort(), selectorId) {
  const subject = parameters.linux?.quarantineReleaseSubject ?? 'canonical';
  if (!['canonical', 'legacy'].includes(subject)) fail('invalid explicit release subject');
  let q;
  if (subject === 'legacy') {
    if (parameters.linux?.userUnitQuarantine !== undefined || parameters.linux?.userUnitQuarantines !== undefined || selectorId !== undefined) fail('ambiguous canonical and legacy release subjects');
    // Receive precisely the already installed custody. This creates no new
    // marker, changes no guard and grants no replacement receiving authority.
    receiveLegacyQuarantine(parameters, native);
    ({ q } = legacyQuarantineDeclaration(parameters));
  } else q = quarantineDeclaration(parameters, selectorId);
  same(native.uid(), q.uid, 'executing owner');
  receiveOwner(q); receiveExistingGuard(q);
  const held = readMarker(q); guardLoaded(q, native);
  if (q.releasePolicy === 'hold-only') fail('hold-only policy explicitly refuses release');
  const binding = q.replacementReceiving;
  if (!binding || !pathData(binding.path) || !/^[a-f0-9]{64}$/.test(binding.sha256 || '')) fail('no source-owned independently received replacement Resource');
  if (!binding.path.startsWith(join(q.sectionRoot, 'data/records') + '/')) fail('replacement receiving must be in declared owner data/records');
  ownedPath(binding.path, q, { privateFile: true });
  const text = read(binding.path);
  same(hash(text), binding.sha256, 'receiving Resource digest');
  const r = JSON.parse(text);
  if (r.type !== 'WslQuarantineReplacementReceiving' || r.version !== 1 || !r.receiver || !r.subject || r.unknownEffectsReconciled !== true || !Array.isArray(r.unresolvedEffects) || r.unresolvedEffects.length) fail('replacement receiving incomplete');
  if (q.captureMode === 'stopped-no-resident') {
    same(r.captureMode, q.captureMode, 'replacement capture mode');
    same([r.id, r.unit, r.markerSha256, r.oldInvocationId], [q.id, q.unit, held.digest, null], 'stopped receiving subject');
    same(r.originalCapture, held.marker.original, 'received original stopped capture');
    same(r.effectDependencies, held.marker.effectDependencies, 'received effect dependencies');
    receiveEffectDependencyReceiving(q, held, r);
  } else {
    same([r.id, r.unit, r.markerSha256, r.oldInvocationId], [q.id, q.unit, held.digest, held.marker.original.invocationId], 'receiving subject');
  }
  const p = q.replacement;
  if (!p || !pathData(p.profile) || !/^[a-f0-9]{40}$/.test(p.gitHead || '') || !/^[a-f0-9]{40}$/.test(p.selectorGitBlob || '')) fail('invalid replacement binding');
  same(r.profile, p.profile, 'profile');
  if (!pathData(r.artifactRoot) || !/^\/gnu\/store\/[a-z0-9]{32}-[^/]+$/.test(r.artifactRoot) || !/^[a-f0-9]{64}$/.test(r.profileRecordSha256 || '')) fail('invalid received product');
  same(hash(read(p.profile + '.lagoon-release.json', 1048576)), r.profileRecordSha256, 'native profile record');
  same(readlinkSync(p.profile), r.profileLink, 'native profile link');
  const packageRoot = dirname(realpathSync(join(p.profile, 'node_modules', '@red-cup-engineering/computer-deployment-engine/package.json')));
  const manifest = JSON.parse(read(join(packageRoot, 'package.json')));
  same([manifest.name, manifest.version, manifest.gitHead], ['@red-cup-engineering/computer-deployment-engine', p.version, p.gitHead], 'qualified controller');
  const script = readFileSync(join(packageRoot, 'scripts/release-on-landing.mjs'));
  const blob = createHash('sha1').update(Buffer.from('blob ' + script.length + '\0')).update(script).digest('hex');
  same(blob, p.selectorGitBlob, 'qualified selector source');
  const unit = native.unit(q.unit);
  if (unit.MainPID !== '0' || unit.ControlPID !== '0' || (unit.Job && unit.Job !== '0') || !['inactive', 'failed'].includes(unit.ActiveState)) fail('replacement unit not held terminal');
  const argv = /(?:^|;\s*)argv\[\]=([^;]+)\s*;/.exec(unit.ExecStart || '')?.[1]?.trim().split(/\s+/);
  same(argv, r.execStart, 'selected native command');
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== realpathSync(join(r.artifactRoot, 'bin/node')) || argv[1] !== join(r.artifactRoot, 'node_modules/@red-cup-engineering/computer-deployment-engine/scripts/release-on-landing.mjs')) fail('command outside received product');
  if (!pathData(p.guix) || !/^\/gnu\/store\/[a-z0-9]{32}-[^/]+\/bin\/guix$/.test(p.guix) || !/^[a-f0-9]{64}$/.test(p.guixSha256 || '')) fail('qualified native profile reader required');
  same(hash(readFileSync(p.guix)), p.guixSha256, 'qualified Guix supplier');
  if (typeof native.profileArtifact !== 'function') fail('native profile receiving unavailable');
  same(native.profileArtifact({ node: argv[0], selector: join(packageRoot, 'scripts/release-on-landing.mjs'), guix: p.guix, profile: p.profile }), r.artifactRoot, 'native registered artifact');
  same(hash(readFileSync(p.guix)), p.guixSha256, 'Guix supplier after profile observation');
  if (q.captureMode === 'stopped-no-resident') receiveStoppedUnit(q, native, unit);
  else if (!native.cohortTerminal(held.marker.original.controlGroup)) fail('old hierarchical cohort remains populated');
  const cdeHolds = p.profile + '.lagoon-unit-holds';
  if (existsSync(cdeHolds) && readdirSync(cdeHolds).length) fail('unresolved native controller hold');
  // No stop/start, replay, cursor rewrite or effect reconciliation occurs here.
  // The approved Resource digest carries the independent receiving decision.
  const released = { type: 'WslUserUnitQuarantineReleased', version: 1, id: q.id, marker: held.marker, markerSha256: held.digest, receivingSha256: binding.sha256, profileRecordSha256: r.profileRecordSha256, releasedAt: new Date().toISOString() };
  if (entryExists(q.released)) fail('release outcome already exists; reconcile original outcome');
  same(hash(read(p.profile + '.lagoon-release.json', 1048576)), r.profileRecordSha256, 'native profile record before release');
  same(readlinkSync(p.profile), r.profileLink, 'native profile link before release');
  exclusive(q.released, JSON.stringify(released) + '\n', q);
  same(readMarker(q).digest, held.digest, 'hold before release');
  guardLoaded(q, native);
  if (q.captureMode === 'stopped-no-resident') {
    same(hash(read(binding.path)), binding.sha256, 'replacement receiving before stopped release');
    receiveEffectDependencyReceiving(q, held, r);
  }
  unlinkSync(q.marker); syncDir(dirname(q.marker));
  return { status: 'released', receivingSha256: binding.sha256, started: false };
}
