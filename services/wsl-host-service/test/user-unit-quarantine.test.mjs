import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, chmodSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { holdQuarantine, planQuarantine, quarantineDeclaration, quarantineDeclarations, releaseQuarantine, receiveLegacyQuarantine } from '../src/user-unit-quarantine.mjs';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'wsl-quarantine-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const expected = { pid: 101, invocationId: 'a'.repeat(32), controlGroup: '/user.slice/test.service', bootId: 'old-boot',
    process: { pid: 101, startTime: '1234', argv: ['/gnu/store/node/bin/node', '/gnu/store/old/selector.mjs'], cwd: '/gnu/store/old', cgroup: '0::/user.slice/test.service' } };
  const parameters = { linux: { userUnitQuarantine: { id: 'old-selector', unit: 'selector.service', uid: process.getuid(), home,
    origin: 'https://github.com/example/owner/issues/48', expected, replacementReceiving: null } } };
  const sectionRoot = join(home, 'test-operations-services-section');
  mkdirSync(sectionRoot, { mode: 0o700 });
  parameters.linux.userUnitQuarantine.sectionRoot = sectionRoot;
  const q = quarantineDeclaration(parameters);
  const u = { Id: q.unit, MainPID: '101', ControlPID: '0', InvocationID: expected.invocationId, ControlGroup: expected.controlGroup,
    ActiveState: 'active', SubState: 'running', FreezerState: 'frozen', Job: '', DropInPaths: '', conditions: [] };
  const effects = [];
  const native = { uid: () => process.getuid(), unit: () => ({ ...u }), boot: () => expected.bootId,
    process: () => structuredClone(expected.process), reload: () => { effects.push('daemon-reload'); u.DropInPaths = q.guard; u.conditions = [['ConditionPathExists', false, true, q.marker, 0]]; },
    cohortTerminal: () => true };
  return { parameters, q, native, u, effects, expected };
}
export function legacyFixture(t) {
  const f=fixture(t), marker=join(f.q.home,'.local/state/wsl-host-service/quarantines',f.q.id+'.json');
  mkdirSync(join(f.q.home,'.local/state/wsl-host-service/quarantines'),{recursive:true,mode:0o700});
  mkdirSync(join(f.q.home,'.config/systemd/user',f.q.unit+'.d'),{recursive:true,mode:0o700});
  const bytes=JSON.stringify({type:'WslUserUnitQuarantine',version:1,id:f.q.id,unit:f.q.unit,uid:f.q.uid,home:f.q.home,origin:f.q.origin,original:f.expected,heldAt:'2026-10-19T00:00:00.000Z'})+'\n';
  const guard='# Owned by the WSL host record. Ordinary apply never clears this hold.\n[Unit]\nConditionPathExists=!'+marker+'\n';
  writeFileSync(marker,bytes,{mode:0o600});writeFileSync(f.q.guard,guard,{mode:0o600});
  const hash=text=>createHash('sha256').update(text).digest('hex');
  f.parameters.linux.legacyUserUnitQuarantine={...f.parameters.linux.userUnitQuarantine,markerSha256:hash(bytes),guardSha256:hash(guard)};
  f.u.DropInPaths=f.q.guard;f.u.conditions=[['ConditionPathExists',false,true,marker,0]];
  f.u.MainPID='0';f.u.ActiveState='inactive';f.native.boot=()=>{throw Error('historical resident must not be inferred')};f.native.process=()=>{throw Error('no process query required')};
  return {...f,marker,bytes,guard};
}

test('explicit legacy receiving observes retained original hold across boot without writing or claiming a resident',t=>{
  const f=legacyFixture(t),received=receiveLegacyQuarantine(f.parameters,f.native);
  assert.equal(received.status,'held');assert.equal(received.currentResidentClaimed,false);assert.equal(received.effectsExecuted,false);assert.equal(received.released,false);assert.deepEqual(received.original,f.expected);
  assert.equal(readFileSync(f.marker,'utf8'),f.bytes);assert.equal(readFileSync(f.q.guard,'utf8'),f.guard);assert.equal(existsSync(f.q.area),false);assert.deepEqual(f.effects,[]);
  assert.throws(()=>planQuarantine(f.parameters,f.native),/independently migrate/);
});
test('legacy receiving requires explicit exact marker and guard bytes, never an omitted-declaration fallback',t=>{
  for(const mutate of [f=>delete f.parameters.linux.legacyUserUnitQuarantine,f=>f.parameters.linux.legacyUserUnitQuarantine.markerSha256='0'.repeat(64),f=>f.parameters.linux.legacyUserUnitQuarantine.guardSha256='0'.repeat(64),f=>f.parameters.linux.legacyUserUnitQuarantine.origin='another-work',f=>f.native.uid=()=>999999]){
    const f=legacyFixture(t);mutate(f);assert.throws(()=>receiveLegacyQuarantine(f.parameters,f.native));assert.deepEqual(f.effects,[]);assert.equal(readFileSync(f.marker,'utf8'),f.bytes);
  }
});
test('retained bytes without actual loaded negative marker condition cannot qualify legacy boot hold',t=>{
  for(const mutate of [f=>f.u.DropInPaths='',f=>f.u.conditions=[],f=>f.u.conditions=[['ConditionPathExists',false,false,f.marker,0]],f=>f.u.conditions=[['ConditionPathExists',false,true,'another-marker',0]]]){
    const f=legacyFixture(t);mutate(f);assert.throws(()=>receiveLegacyQuarantine(f.parameters,f.native));assert.deepEqual(f.effects,[]);
  }
});
test('legacy missing, redirected or non-private custody refuses without allocation or repair',t=>{
  for(const mutate of [f=>rmSync(f.marker),f=>chmodSync(f.marker,0o644),f=>{rmSync(f.marker);symlinkSync(f.q.guard,f.marker)}]){
    const f=legacyFixture(t);mutate(f);assert.throws(()=>receiveLegacyQuarantine(f.parameters,f.native));assert.equal(existsSync(f.q.area),false);assert.deepEqual(f.effects,[]);
  }
});

test('hold preserves the exact frozen resident and loads only a durable condition', t => {
  const f = fixture(t);
  assert.equal(holdQuarantine(f.parameters, f.native).status, 'held');
  assert.deepEqual(f.effects, ['daemon-reload']);
  assert.equal(f.u.MainPID, '101');
  assert.equal(f.u.FreezerState, 'frozen');
  assert.equal(readFileSync(f.q.guard, 'utf8'), f.q.guardText);
  assert.equal(planQuarantine(f.parameters, f.native).status, 'held');
  assert.equal(holdQuarantine(f.parameters, f.native).unchanged, true);
  assert.deepEqual(f.effects, ['daemon-reload']);
});

test('identity drift, wrong owner and control jobs refuse before writing', t => {
  for (const change of [
    f => { f.u.InvocationID = 'b'.repeat(32); },
    f => { f.u.Job = '17'; },
    f => { f.u.ControlPID = '22'; },
    f => { f.u.FreezerState = 'running'; },
    f => { f.native.uid = () => 999999; },
    f => { f.native.process = () => ({ ...f.expected.process, startTime: 'other' }); }
  ]) {
    const f = fixture(t); change(f);
    assert.throws(() => holdQuarantine(f.parameters, f.native), /refused/);
    assert.equal(existsSync(f.q.marker), false);
    assert.deepEqual(f.effects, []);
  }
});

test('a failed reload leaves original marker and guard, and refuses a false received result', t => {
  const f = fixture(t);
  f.native.reload = () => { throw new Error('native reload uncertain'); };
  assert.throws(() => holdQuarantine(f.parameters, f.native), /uncertain/);
  assert.equal(existsSync(f.q.marker), true);
  assert.equal(existsSync(f.q.guard), true);
  assert.throws(() => planQuarantine(f.parameters, f.native), /not loaded/);
  // Reentry may complete the exact partial hold, but this native reload still fails.
  assert.throws(() => holdQuarantine(f.parameters, f.native), /native reload uncertain/);
  assert.throws(() => planQuarantine(f.parameters, f.native), /not loaded/);
});

test('changed resident after native reload leaves the persistent hold', t => {
  const f = fixture(t);
  const reload = f.native.reload;
  f.native.reload = () => { reload(); f.u.InvocationID = 'b'.repeat(32); };
  assert.throws(() => holdQuarantine(f.parameters, f.native), /invocation changed/);
  assert.ok(existsSync(f.q.marker));
  assert.ok(existsSync(f.q.guard));
});

test('omission, renamed declaration and simulated boot cannot clear existing custody', t => {
  const f = fixture(t);
  holdQuarantine(f.parameters, f.native);
  const bytes = readFileSync(f.q.marker, 'utf8');
  assert.throws(() => releaseQuarantine({ linux: {} }, f.native), /omission does not release/);
  const renamed = structuredClone(f.parameters);
  renamed.linux.userUnitQuarantine.id = 'different-name';
  assert.throws(() => releaseQuarantine(renamed, f.native), /ENOENT/);
  f.u.MainPID = '0'; f.u.ActiveState = 'inactive'; f.u.SubState = 'dead'; f.native.boot = () => 'new-boot';
  assert.throws(() => releaseQuarantine(f.parameters, f.native), /independently received/);
  assert.equal(readFileSync(f.q.marker, 'utf8'), bytes);
  assert.equal(planQuarantine(f.parameters, f.native).status, 'held');
});

test('a fabricated receiving file cannot bypass the reviewed digest or original hold subject', t => {
  const f = fixture(t);
  holdQuarantine(f.parameters, f.native);
  const path = join(f.q.sectionRoot, 'data/records/replacement.json');
  mkdirSync(join(f.q.sectionRoot, 'data/records'), { mode: 0o700 });
  writeFileSync(path, '{}\n', { mode: 0o600 });
  f.parameters.linux.userUnitQuarantine.replacementReceiving = { path, sha256: '0'.repeat(64) };
  assert.throws(() => releaseQuarantine(f.parameters, f.native), /digest changed/);
  assert.ok(existsSync(f.q.marker));
  assert.deepEqual(f.effects, ['daemon-reload']);
});

test('foreign or symlinked custody paths refuse', t => {
  const f = fixture(t);
  mkdirSync(join(f.q.sectionRoot, 'data'));
  const outside = join(f.q.home, 'outside-custody'); mkdirSync(outside, { mode: 0o700 });
  symlinkSync(outside, join(f.q.sectionRoot, 'data/state'));
  assert.throws(() => holdQuarantine(f.parameters, f.native), /unsafe owner path/);
  assert.equal(existsSync(f.q.guard), false);
});

test('tampered native condition never qualifies as held', t => {
  const f = fixture(t);
  holdQuarantine(f.parameters, f.native);
  writeFileSync(f.q.guard, '[Unit]\n');
  assert.throws(() => planQuarantine(f.parameters, f.native), /guard bytes changed/);
});

test('private file mode and prior release outcomes are authoritative', t => {
  const f = fixture(t);
  holdQuarantine(f.parameters, f.native);
  chmodSync(f.q.marker, 0o644);
  assert.throws(() => planQuarantine(f.parameters, f.native), /non-private custody/);
  chmodSync(f.q.marker, 0o600);
  writeFileSync(f.q.released, '{}', { mode: 0o600 });
  assert.throws(() => holdQuarantine(f.parameters, f.native), /reconcile|cannot be reused/);
});

test('a later native condition reset refuses despite retained drop-in bytes', t => {
  const f = fixture(t);
  holdQuarantine(f.parameters, f.native);
  f.u.conditions = [];
  assert.throws(() => planQuarantine(f.parameters, f.native), /effective negative marker condition missing/);
  assert.ok(existsSync(f.q.marker));
});

test('the actual service CLI reports an unheld declaration as drift and refuses staged hold effects', t => {
  const f = fixture(t);
  const record = join(f.q.home, 'wsl-host.json');
  writeFileSync(record, JSON.stringify(f.parameters), { mode: 0o600 });
  const cli = fileURLToPath(new URL('../scripts/wsl-host.mjs', import.meta.url));
  const plan = spawnSync(process.execPath, [cli, 'quarantine-plan', '--parameters=' + record], { encoding: 'utf8', timeout: 5000 });
  assert.equal(plan.status, 2, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).status, 'unheld');
  const staged = spawnSync(process.execPath, [cli, 'quarantine-hold', '--parameters=' + record, '--root=' + f.q.home], { encoding: 'utf8', timeout: 5000 });
  assert.equal(staged.status, 2, staged.stderr);
  assert.match(staged.stderr, /not staged/);
  assert.equal(existsSync(f.q.marker), false);
});


test('quarantine custody is explicit section data/state, never an implicit home fallback', t => {
  const f = fixture(t);
  assert.equal(f.q.area, join(f.q.sectionRoot, 'data/state/wsl-user-unit-quarantine-state'));
  assert.equal(f.q.guard, join(f.q.home, '.config/systemd/user', f.q.unit + '.d', '90-wsl-host-quarantine-' + f.q.id + '.conf'));
  assert.equal(existsSync(join(f.q.home, '.local')), false);
  for (const sectionRoot of [undefined, f.q.home, join(f.q.home, '.local/owner-services-section'), f.q.sectionRoot + '/.', f.q.sectionRoot + '/../test-operations-services-section']) {
    const p = structuredClone(f.parameters); p.linux.userUnitQuarantine.sectionRoot = sectionRoot;
    assert.throws(() => holdQuarantine(p, f.native), /sectionRoot/);
    assert.deepEqual(f.effects, []); assert.equal(existsSync(f.q.marker), false);
  }
});

test('missing or redirected declared section refuses without allocating custody', t => {
  const f = fixture(t), p = structuredClone(f.parameters);
  p.linux.userUnitQuarantine.sectionRoot = join(f.q.home, 'missing-services-section');
  assert.throws(() => holdQuarantine(p, f.native), /ENOENT/);
  const redirect = join(f.q.home, 'redirect-services-section'); symlinkSync(f.q.sectionRoot, redirect);
  p.linux.userUnitQuarantine.sectionRoot = redirect;
  assert.throws(() => holdQuarantine(p, f.native), /unsafe owner/);
  assert.deepEqual(f.effects, []); assert.equal(existsSync(f.q.marker), false);
});

test('an existing original native guard is not overwritten or forked into a new hold', t => {
  const f = fixture(t), oldMarker = join(f.q.home, 'original-marker.json');
  const original = '# Retained original guard\n[Unit]\nConditionPathExists=!' + oldMarker + '\n';
  mkdirSync(join(f.q.home, '.config/systemd/user', f.q.unit + '.d'), { recursive: true, mode: 0o700 });
  writeFileSync(f.q.guard, original, { mode: 0o600 });
  assert.throws(() => planQuarantine(f.parameters, f.native), /independently migrate/);
  assert.throws(() => holdQuarantine(f.parameters, f.native), /independently migrate/);
  assert.equal(readFileSync(f.q.guard, 'utf8'), original);
  assert.equal(existsSync(f.q.marker), false); assert.deepEqual(f.effects, []);
});

test('dangling custody entry cannot appear unheld or be replaced', t => {
  const f = fixture(t);
  mkdirSync(f.q.area, { recursive: true, mode: 0o700 });
  symlinkSync(join(f.q.home, 'missing-marker-target'), f.q.marker);
  assert.throws(() => planQuarantine(f.parameters, f.native), /unsafe owner/);
  assert.throws(() => holdQuarantine(f.parameters, f.native), /unsafe owner/);
  assert.deepEqual(f.effects, []);
});

test('legacy release requires an explicit unambiguous source subject without migrating custody', t => {
  for (const subject of [undefined, 'other', 'legacy']) {
    const f = legacyFixture(t);
    if (subject !== undefined) f.parameters.linux.quarantineReleaseSubject = subject;
    assert.throws(() => releaseQuarantine(f.parameters, f.native));
    assert.equal(readFileSync(f.marker, 'utf8'), f.bytes);
    assert.equal(existsSync(f.q.area), false); assert.deepEqual(f.effects, []);
  }
});
test('explicit legacy release keeps the original marker until the selected receiving digest is accepted', t => {
  const f = legacyFixture(t); delete f.parameters.linux.userUnitQuarantine;
  f.parameters.linux.quarantineReleaseSubject = 'legacy';
  const directory = join(f.q.sectionRoot, 'data/records/quarantine-receiving');
  mkdirSync(directory, {recursive:true,mode:0o700});
  const path = join(directory, 'replacement.json');
  writeFileSync(path, '{}\n', {mode:0o600});
  f.parameters.linux.legacyUserUnitQuarantine.replacementReceiving = {path,sha256:'0'.repeat(64)};
  assert.throws(() => releaseQuarantine(f.parameters, f.native), /Resource digest/);
  assert.equal(readFileSync(f.marker, 'utf8'), f.bytes);
  assert.equal(readFileSync(f.q.guard, 'utf8'), f.guard);
  assert.equal(existsSync(f.q.released), false); assert.deepEqual(f.effects, []);
});

// Disposable stopped-subject fixtures; these never address a production unit.
export function stoppedFixture(t) {
  const f = fixture(t), q = f.parameters.linux.userUnitQuarantine;
  q.captureMode = 'stopped-no-resident';
  q.expected = { bootId: f.expected.bootId, execStart: '{ path=/fixture/node ; argv[]=/fixture/node /fixture/controller.mjs ; }' };
  q.effectDependencies = [{ type: 'CdePromotionUnknownEffect', unit: 'fixture-promoter.service', invocationId: 'b'.repeat(32), hostCommit: 'c'.repeat(40), terminalReceivingRequired: true }];
  Object.assign(f.u, { LoadState: 'loaded', ExecStart: q.expected.execStart, MainPID: '0', ControlPID: '0', Job: '', ActiveState: 'inactive', SubState: 'dead', FreezerState: 'running', ControlGroup: '', InvocationID: 'd'.repeat(32) });
  f.native.process = () => assert.fail('a stopped subject has no resident process to query');
  return { ...f, q: quarantineDeclaration(f.parameters) };
}
export function stoppedReplacementFixture(t) {
  const f = stoppedFixture(t), held = holdQuarantine(f.parameters, f.native);
  const original = JSON.parse(readFileSync(f.q.marker, 'utf8'));
  const directory = join(f.q.sectionRoot, 'data/records/quarantine-receiving');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dependencyPath = join(directory, 'fixture-promotion-terminal.json');
  const dependency = f.q.effectDependencies[0];
  const terminal = { type: 'WslQuarantineEffectDependencyReceiving', version: 1, dependency, receiver: 'independent-disposable-fixture-receiver', subject: 'Disposable fixture; no production effect is settled', unknownEffectsReconciled: true, unresolvedEffects: [], terminalReceiving: { receipt: 'disposable-fixture-terminal', outcome: 'reconciled-unknown', reconciliationEvidence: 'This source fixture creates no production promotion.' } };
  const terminalBytes = JSON.stringify(terminal) + '\n';
  writeFileSync(dependencyPath, terminalBytes, { mode: 0o600 });
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const receiving = { type: 'WslQuarantineReplacementReceiving', version: 1, receiver: 'independent-disposable-replacement-receiver', subject: 'Disposable stopped hold only', unknownEffectsReconciled: true, unresolvedEffects: [], id: f.q.id, unit: f.q.unit, markerSha256: held.markerSha256, oldInvocationId: null, captureMode: 'stopped-no-resident', originalCapture: original.original, effectDependencies: f.q.effectDependencies, effectDependencyReceiving: [{ dependency, path: dependencyPath, sha256: sha(terminalBytes) }] };
  const receivingPath = join(directory, 'stopped-replacement.json');
  const persist = () => {
    const bytes = JSON.stringify(receiving) + '\n';
    writeFileSync(receivingPath, bytes, { mode: 0o600 });
    f.parameters.linux.userUnitQuarantine.replacementReceiving = { path: receivingPath, sha256: sha(bytes) };
  };
  persist();
  return { ...f, receiving, terminal, dependencyPath, receivingPath, persist, sha };
}

test('stopped mode captures a loaded terminal unit without inventing a resident', t => {
  const f = stoppedFixture(t);
  assert.equal(planQuarantine(f.parameters, f.native).status, 'unheld');
  const held = holdQuarantine(f.parameters, f.native);
  assert.equal(held.status, 'held');
  const marker = JSON.parse(readFileSync(f.q.marker, 'utf8'));
  assert.equal(marker.captureMode, 'stopped-no-resident');
  assert.equal(marker.original.resident, null);
  assert.equal(marker.original.unit.ExecStart, f.u.ExecStart);
  assert.equal(marker.original.unit.InvocationID, f.u.InvocationID);
  assert.equal(Object.hasOwn(marker.original, 'pid'), false);
  assert.equal(Object.hasOwn(marker.original, 'process'), false);
  assert.deepEqual(marker.effectDependencies, f.q.effectDependencies);
  assert.equal(holdQuarantine(f.parameters, f.native).unchanged, true);
  assert.equal(planQuarantine(f.parameters, f.native).status, 'held');
  assert.deepEqual(f.effects, ['daemon-reload']);
});

test('stopped native unknowns, jobs, active states and live cohorts refuse before custody', t => {
  const changes = [
    f => f.u.Id = 'wrong.service', f => f.u.LoadState = 'not-found',
    f => f.u.ExecStart = '', f => f.u.ExecStart = 'different command',
    f => f.u.MainPID = '17', f => delete f.u.MainPID, f => f.u.MainPID = '',
    f => f.u.ControlPID = '17', f => delete f.u.ControlPID,
    f => delete f.u.Job, f => f.u.Job = '17',
    f => f.u.ActiveState = 'activating', f => f.u.SubState = 'auto-restart',
    f => delete f.u.ControlGroup,
    f => { f.u.ControlGroup = '/user.slice/fixture.service'; f.native.cohortTerminal = () => false; },
    f => f.native.boot = () => 'another-boot'
  ];
  for (const change of changes) {
    const f = stoppedFixture(t); change(f);
    assert.throws(() => holdQuarantine(f.parameters, f.native), /quarantine refused/);
    assert.equal(existsSync(f.q.marker), false);
    assert.equal(existsSync(f.q.guard), false);
    assert.deepEqual(f.effects, []);
  }
});

test('stopped declarations never relax the omitted frozen mode or exact dependency subject', t => {
  for (const change of [
    q => delete q.captureMode, q => q.captureMode = 'stopped',
    q => q.effectDependencies = [], q => q.effectDependencies.push({ ...q.effectDependencies[0] }),
    q => q.effectDependencies[0].hostCommit = 'abbreviated'
  ]) {
    const f = stoppedFixture(t); change(f.parameters.linux.userUnitQuarantine);
    assert.throws(() => holdQuarantine(f.parameters, f.native));
    assert.equal(existsSync(f.q.marker), false); assert.deepEqual(f.effects, []);
  }
});

test('reload and post-condition races retain partial stopped custody without success', t => {
  for (const stage of ['reload', 'after-condition']) {
    const f = stoppedFixture(t);
    if (stage === 'reload') {
      const reload = f.native.reload;
      f.native.reload = () => { reload(); f.u.MainPID = '900'; f.u.ActiveState = 'active'; };
    } else {
      const observe = f.native.unit; let calls = 0;
      f.native.unit = unit => { const observed = observe(unit); if (++calls >= 5) observed.MainPID = '900'; return observed; };
    }
    assert.throws(() => holdQuarantine(f.parameters, f.native), /stopped/);
    assert.ok(existsSync(f.q.marker)); assert.ok(existsSync(f.q.guard));
    assert.throws(() => planQuarantine(f.parameters, f.native));
    assert.deepEqual(f.effects, ['daemon-reload']);
  }
});

test('held stopped mode and effect dependencies cannot be reinterpreted by changing the record', t => {
  for (const change of [q => q.captureMode = 'frozen-resident', q => q.effectDependencies[0].hostCommit = 'e'.repeat(40)]) {
    const f = stoppedFixture(t); holdQuarantine(f.parameters, f.native);
    const bytes = readFileSync(f.q.marker, 'utf8'); change(f.parameters.linux.userUnitQuarantine);
    assert.throws(() => planQuarantine(f.parameters, f.native));
    assert.equal(readFileSync(f.q.marker, 'utf8'), bytes);
  }
});

test('independent terminal receiving is required before the original replacement gate', t => {
  const good = stoppedReplacementFixture(t);
  assert.throws(() => releaseQuarantine(good.parameters, good.native), /invalid replacement binding/);
  assert.ok(existsSync(good.q.marker));
  for (const change of [
    f => delete f.receiving.captureMode, f => f.receiving.oldInvocationId = 'invented',
    f => f.receiving.effectDependencies = [], f => f.receiving.effectDependencyReceiving = [],
    f => f.receiving.effectDependencyReceiving[0].dependency.hostCommit = 'e'.repeat(40),
    f => f.receiving.effectDependencyReceiving[0].sha256 = '0'.repeat(64),
    f => { delete f.terminal.terminalReceiving; const bytes = JSON.stringify(f.terminal); writeFileSync(f.dependencyPath, bytes); f.receiving.effectDependencyReceiving[0].sha256 = f.sha(bytes); },
    f => { delete f.terminal.terminalReceiving.reconciliationEvidence; const bytes = JSON.stringify(f.terminal); writeFileSync(f.dependencyPath, bytes); f.receiving.effectDependencyReceiving[0].sha256 = f.sha(bytes); },
    f => { f.terminal.unresolvedEffects = ['unknown original write']; const bytes = JSON.stringify(f.terminal); writeFileSync(f.dependencyPath, bytes); f.receiving.effectDependencyReceiving[0].sha256 = f.sha(bytes); }
  ]) {
    const f = stoppedReplacementFixture(t); change(f); f.persist();
    assert.throws(() => releaseQuarantine(f.parameters, f.native), error => !/invalid replacement binding/.test(error.message));
    assert.ok(existsSync(f.q.marker)); assert.equal(existsSync(f.q.released), false);
  }
});


test('a terminal-to-terminal invocation race preserves custody and refuses unreceived effects', t => {
  for (const stage of ['before-reload', 'after-reload', 'after-condition']) {
    const f = stoppedFixture(t);
    const observe = f.native.unit; let calls = 0;
    const changeAt = { 'before-reload': 2, 'after-reload': 3, 'after-condition': 5 }[stage];
    f.native.unit = unit => {
      const actual = observe(unit);
      if (++calls >= changeAt) actual.InvocationID = 'e'.repeat(32);
      return actual;
    };
    assert.throws(() => holdQuarantine(f.parameters, f.native), /capture/);
    assert.ok(existsSync(f.q.marker)); assert.ok(existsSync(f.q.guard));
    const original = JSON.parse(readFileSync(f.q.marker, 'utf8')).original;
    assert.equal(original.unit.InvocationID, 'd'.repeat(32));
    assert.equal(f.u.MainPID, '0'); assert.equal(f.u.ActiveState, 'inactive'); assert.equal(f.u.SubState, 'dead');
    assert.deepEqual(f.effects, stage === 'before-reload' ? [] : ['daemon-reload']);
  }
});

function preventiveFixture(t, id = 'preventive-monitor') {
  const f = stoppedFixture(t), declaration = f.parameters.linux.userUnitQuarantine;
  Object.assign(declaration, { id, unit: id + '.service', releasePolicy: 'hold-only' });
  delete declaration.effectDependencies;
  f.u.Id = declaration.unit;
  const q = quarantineDeclaration(f.parameters);
  f.native.reload = () => { f.effects.push('daemon-reload'); f.u.DropInPaths = q.guard; f.u.conditions = [['ConditionPathExists', false, true, q.marker, 0]]; };
  return { ...f, q };
}
function collectionFixture(t) {
  const first = stoppedFixture(t), second = preventiveFixture(t);
  const parameters = { linux: { userUnitQuarantine: first.parameters.linux.userUnitQuarantine, userUnitQuarantines: [second.parameters.linux.userUnitQuarantine] } };
  const native = { ...first.native,
    unit: unit => unit === first.q.unit ? first.native.unit(unit) : second.native.unit(unit),
    reload: () => { first.native.reload(); second.native.reload(); }
  };
  return { first, second, parameters, native };
}
test('preventive stopped hold binds explicit policy, private custody and loaded guard; release never writes', t => {
  const f = preventiveFixture(t), held = holdQuarantine(f.parameters, f.native);
  assert.equal(held.status, 'held'); assert.equal(holdQuarantine(f.parameters, f.native).unchanged, true);
  const bytes = readFileSync(f.q.marker, 'utf8'), marker = JSON.parse(bytes);
  assert.equal(marker.releasePolicy, 'hold-only'); assert.equal(marker.original.resident, null);
  assert.equal(Object.hasOwn(marker, 'effectDependencies'), false);
  f.parameters.linux.userUnitQuarantine.replacementReceiving = { path: '/not-read', sha256: 'a'.repeat(64) };
  f.native.profileArtifact = () => assert.fail('preventive hold cannot invoke CDE receiving');
  const effects = [...f.effects];
  assert.throws(() => releaseQuarantine(f.parameters, f.native), /hold-only policy explicitly refuses release/);
  assert.equal(readFileSync(f.q.marker, 'utf8'), bytes); assert.equal(existsSync(f.q.released), false);
  assert.deepEqual(f.effects, effects);
});
test('explicit preventive policy cannot reinterpret CDE custody or be omitted/flipped after capture', t => {
  const cde = stoppedFixture(t); holdQuarantine(cde.parameters, cde.native);
  const original = JSON.parse(readFileSync(cde.q.marker));
  assert.equal(Object.hasOwn(original, 'releasePolicy'), false);
  cde.parameters.linux.userUnitQuarantine.releasePolicy = 'hold-only';
  delete cde.parameters.linux.userUnitQuarantine.effectDependencies;
  assert.throws(() => planQuarantine(cde.parameters, cde.native), /hold release policy/);
  for (const change of [q => delete q.releasePolicy, q => { q.releasePolicy = 'cde-release'; q.effectDependencies = cde.q.effectDependencies; }]) {
    const f = preventiveFixture(t); holdQuarantine(f.parameters, f.native);
    const bytes = readFileSync(f.q.marker, 'utf8'); change(f.parameters.linux.userUnitQuarantine);
    assert.throws(() => releaseQuarantine(f.parameters, f.native));
    assert.equal(readFileSync(f.q.marker, 'utf8'), bytes); assert.equal(existsSync(f.q.released), false);
  }
  const frozen = fixture(t); holdQuarantine(frozen.parameters, frozen.native);
  const marker = JSON.parse(readFileSync(frozen.q.marker));
  assert.equal(Object.hasOwn(marker, 'captureMode'), false); assert.equal(Object.hasOwn(marker, 'releasePolicy'), false);
});
test('preventive capture refuses a mode/native mismatch and fictional effect dependencies', t => {
  for (const change of [q => delete q.captureMode, q => q.releasePolicy = 'unknown', q => q.effectDependencies = [{}], q => q.effectDependencies = null]) {
    const f = preventiveFixture(t); change(f.parameters.linux.userUnitQuarantine);
    assert.throws(() => holdQuarantine(f.parameters, f.native));
    assert.equal(existsSync(f.q.marker), false); assert.deepEqual(f.effects, []);
  }
  const f = preventiveFixture(t); f.parameters.linux.userUnitQuarantine.effectDependencies = [];
  assert.equal(holdQuarantine(f.parameters, f.native).status, 'held');
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(f.q.marker)), 'effectDependencies'), false);
});
test('default collection observation sees every additive declaration; mutation must select an exact id', t => {
  const f = collectionFixture(t), before = planQuarantine(f.parameters, f.native);
  assert.equal(before.status, 'unheld'); assert.deepEqual(before.quarantines.map(q => q.id), [f.first.q.id, f.second.q.id]);
  assert.equal(quarantineDeclarations(f.parameters).length, 2);
  for (const selector of [undefined, '', null, 'absent']) {
    assert.throws(() => holdQuarantine(f.parameters, f.native, selector));
    assert.throws(() => releaseQuarantine(f.parameters, f.native, selector));
  }
  assert.equal(existsSync(f.first.q.marker), false); assert.equal(existsSync(f.second.q.marker), false);
  holdQuarantine(f.parameters, f.native, f.first.q.id);
  const original = readFileSync(f.first.q.marker, 'utf8'), guard = readFileSync(f.first.q.guard, 'utf8');
  assert.equal(planQuarantine(f.parameters, f.native).status, 'mixed');
  holdQuarantine(f.parameters, f.native, f.second.q.id);
  assert.equal(planQuarantine(f.parameters, f.native).status, 'held');
  assert.equal(planQuarantine(f.parameters, f.native, f.second.q.id).id, f.second.q.id);
  assert.equal(readFileSync(f.first.q.marker, 'utf8'), original); assert.equal(readFileSync(f.first.q.guard, 'utf8'), guard);
  assert.throws(() => releaseQuarantine({ linux: {} }, f.native), /omission does not release/);
  assert.equal(readFileSync(f.first.q.marker, 'utf8'), original);
});
test('explicit collection release retains original CDE replacement gate and selects hold-only policy independently', t => {
  const first = stoppedReplacementFixture(t), second = preventiveFixture(t);
  holdQuarantine(second.parameters, second.native);
  const parameters = { linux: { userUnitQuarantine: first.parameters.linux.userUnitQuarantine, userUnitQuarantines: [second.parameters.linux.userUnitQuarantine] } };
  const native = { ...first.native, unit: unit => unit === first.q.unit ? first.native.unit(unit) : second.native.unit(unit) };
  const firstBytes = readFileSync(first.q.marker, 'utf8'), secondBytes = readFileSync(second.q.marker, 'utf8');
  assert.throws(() => releaseQuarantine(parameters, native, first.q.id), /invalid replacement binding/);
  assert.throws(() => releaseQuarantine(parameters, native, second.q.id), /hold-only policy explicitly refuses release/);
  assert.throws(() => releaseQuarantine(parameters, native), /ambiguous quarantine mutation selection/);
  assert.throws(() => releaseQuarantine(parameters, native, 'absent'), /explicit quarantine-id not found/);
  assert.throws(() => releaseQuarantine(parameters, native, ''), /nonempty explicit quarantine-id/);
  assert.equal(readFileSync(first.q.marker, 'utf8'), firstBytes); assert.equal(readFileSync(second.q.marker, 'utf8'), secondBytes);
  assert.equal(existsSync(first.q.released), false); assert.equal(existsSync(second.q.released), false);
  assert.deepEqual(first.effects, ['daemon-reload']); assert.deepEqual(second.effects, ['daemon-reload']);
});
test('full declaration set refuses duplicate id/unit/derived marker before any selected mutation', t => {
  for (const mutate of [
    f => f.parameters.linux.userUnitQuarantines[0].id = f.first.q.id,
    f => f.parameters.linux.userUnitQuarantines[0].unit = f.first.q.unit,
    f => Object.assign(f.parameters.linux.userUnitQuarantines[0], { id: f.first.q.id, sectionRoot: f.first.q.sectionRoot }),
    f => Object.assign(f.parameters.linux.userUnitQuarantines[0], { id: f.first.q.id, unit: f.first.q.unit, home: f.first.q.home }),
    f => f.parameters.linux.userUnitQuarantines = [],
    f => f.parameters.linux.userUnitQuarantines = Array(33).fill(f.second.parameters.linux.userUnitQuarantine)
  ]) {
    const f = collectionFixture(t); mutate(f);
    assert.throws(() => holdQuarantine(f.parameters, f.native, f.first.q.id));
    assert.equal(existsSync(f.first.q.marker), false); assert.equal(existsSync(f.second.q.marker), false);
    assert.deepEqual(f.first.effects, []); assert.deepEqual(f.second.effects, []);
  }
});
test('collection leaves exact original legacy marker and guard observation independent', t => {
  const legacy = legacyFixture(t), f = preventiveFixture(t);
  delete legacy.parameters.linux.userUnitQuarantine;
  legacy.parameters.linux.userUnitQuarantines = [f.parameters.linux.userUnitQuarantine];
  assert.equal(receiveLegacyQuarantine(legacy.parameters, legacy.native).status, 'held');
  holdQuarantine(legacy.parameters, f.native, f.q.id);
  assert.equal(readFileSync(legacy.marker, 'utf8'), legacy.bytes); assert.equal(readFileSync(legacy.q.guard, 'utf8'), legacy.guard);
  assert.equal(receiveLegacyQuarantine(legacy.parameters, legacy.native).status, 'held');
});
test('preventive stopped capture refuses PID/job/command and terminal-to-terminal races conservatively', t => {
  for (const change of [u => u.MainPID = '99', u => u.ControlPID = '99', u => u.Job = '99', u => u.ExecStart += ' changed', u => u.InvocationID = 'e'.repeat(32), u => { u.ActiveState = 'failed'; u.SubState = 'failed'; }]) {
    const f = preventiveFixture(t), observe = f.native.unit; let reads = 0;
    f.native.unit = unit => { const u = observe(unit); if (++reads >= 2) change(u); return u; };
    assert.throws(() => holdQuarantine(f.parameters, f.native));
    assert.ok(existsSync(f.q.marker)); assert.ok(existsSync(f.q.guard));
    assert.equal(existsSync(f.q.released), false);
  }
});
test('actual CLI observes all unheld collection entries and rejects ambiguous or empty mutation id before effects', t => {
  const f = collectionFixture(t), record = join(f.first.q.home, 'collection.json');
  writeFileSync(record, JSON.stringify(f.parameters), { mode: 0o600 });
  const cli = fileURLToPath(new URL('../scripts/wsl-host.mjs', import.meta.url));
  const run = (...argv) => spawnSync(process.execPath, [cli, ...argv, '--parameters=' + record], { encoding: 'utf8', timeout: 5000 });
  const plan = run('quarantine-plan'); assert.equal(plan.status, 2, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).quarantines.length, 2);
  for (const args of [['quarantine-hold'], ['quarantine-hold', '--quarantine-id='], ['quarantine-hold', '--quarantine-id=absent']]) {
    const result = run(...args); assert.equal(result.status, 2, result.stderr);
  }
  assert.equal(existsSync(f.first.q.marker), false); assert.equal(existsSync(f.second.q.marker), false);
});

function frozenPreventiveFixture(t) {
  const f = fixture(t);
  Object.assign(f.parameters.linux.userUnitQuarantine, { captureMode: 'frozen-resident', releasePolicy: 'hold-only' });
  return { ...f, q: quarantineDeclaration(f.parameters) };
}
test('preventive frozen custody preserves the native resident and explicitly refuses every release', t => {
  const f = frozenPreventiveFixture(t);
  assert.equal(holdQuarantine(f.parameters, f.native).status, 'held');
  const bytes = readFileSync(f.q.marker, 'utf8'), marker = JSON.parse(bytes);
  assert.equal(marker.releasePolicy, 'hold-only'); assert.equal(Object.hasOwn(marker, 'captureMode'), false);
  assert.equal(Object.hasOwn(marker, 'effectDependencies'), false); assert.equal(marker.original.pid, f.expected.pid);
  assert.equal(planQuarantine(f.parameters, f.native).status, 'held');
  assert.equal(holdQuarantine(f.parameters, f.native).unchanged, true);
  f.parameters.linux.userUnitQuarantine.replacementReceiving = { path: '/never-read', sha256: 'a'.repeat(64) };
  f.native.profileArtifact = () => assert.fail('no CDE receiving authority for a frozen preventive hold');
  assert.throws(() => releaseQuarantine(f.parameters, f.native), /hold-only policy explicitly refuses release/);
  assert.equal(readFileSync(f.q.marker, 'utf8'), bytes); assert.equal(existsSync(f.q.released), false);
  assert.equal(f.u.MainPID, '101'); assert.equal(f.u.FreezerState, 'frozen'); assert.deepEqual(f.effects, ['daemon-reload']);
});
test('default frozen CDE markers keep their exact field shape and cannot become preventive custody', t => {
  const f = fixture(t); holdQuarantine(f.parameters, f.native);
  const bytes = readFileSync(f.q.marker, 'utf8'), marker = JSON.parse(bytes);
  assert.deepEqual(Object.keys(marker), ['type', 'version', 'id', 'unit', 'uid', 'home', 'origin', 'original', 'heldAt']);
  f.parameters.linux.userUnitQuarantine.releasePolicy = 'hold-only';
  assert.throws(() => planQuarantine(f.parameters, f.native), /hold release policy/);
  assert.equal(readFileSync(f.q.marker, 'utf8'), bytes);
  const preventive = frozenPreventiveFixture(t); holdQuarantine(preventive.parameters, preventive.native);
  delete preventive.parameters.linux.userUnitQuarantine.releasePolicy;
  assert.throws(() => releaseQuarantine(preventive.parameters, preventive.native), /hold release policy/);
  assert.equal(existsSync(preventive.q.released), false);
});
test('preventive frozen observation refuses thaw, jobs, process birth and invocation drift while retaining custody', t => {
  for (const change of [f => f.u.FreezerState = 'running', f => f.u.Job = '17', f => f.u.MainPID = '102', f => f.u.InvocationID = 'b'.repeat(32), f => f.native.process = () => ({ ...f.expected.process, startTime: 'reused' }), f => f.native.boot = () => 'new-boot']) {
    const f = frozenPreventiveFixture(t); holdQuarantine(f.parameters, f.native);
    const bytes = readFileSync(f.q.marker, 'utf8'); change(f);
    assert.throws(() => planQuarantine(f.parameters, f.native));
    assert.equal(readFileSync(f.q.marker, 'utf8'), bytes); assert.ok(existsSync(f.q.guard)); assert.equal(existsSync(f.q.released), false);
  }
});
test('preventive frozen creation and idempotence recheck after the actual loaded condition', t => {
  for (const existing of [false, true]) {
    const f = frozenPreventiveFixture(t);
    if (existing) holdQuarantine(f.parameters, f.native);
    const unit = f.native.unit; let calls = 0;
    f.native.unit = name => { const u = unit(name); if (++calls >= (existing ? 3 : 5)) u.FreezerState = 'running'; return u; };
    assert.throws(() => holdQuarantine(f.parameters, f.native), /frozen resident/);
    assert.ok(existsSync(f.q.marker)); assert.ok(existsSync(f.q.guard)); assert.equal(existsSync(f.q.released), false);
    assert.deepEqual(f.effects, ['daemon-reload']);
  }
});
test('preventive frozen policy cannot carry fictional effect dependencies', t => {
  for (const dependencies of [null, {}, [{ type: 'CdePromotionUnknownEffect' }]]) {
    const f = frozenPreventiveFixture(t); f.parameters.linux.userUnitQuarantine.effectDependencies = dependencies;
    assert.throws(() => holdQuarantine(f.parameters, f.native), /hold-only cannot declare effect dependencies/);
    assert.equal(existsSync(f.q.marker), false); assert.deepEqual(f.effects, []);
  }
  const f = frozenPreventiveFixture(t); f.parameters.linux.userUnitQuarantine.effectDependencies = [];
  holdQuarantine(f.parameters, f.native); assert.equal(Object.hasOwn(JSON.parse(readFileSync(f.q.marker)), 'effectDependencies'), false);
});


// Independent acceptance for the existing-marker partial-operation defect.
function interruptedHold(f) {
  const reload=f.native.reload;
  f.native.reload=()=>{throw new Error('fixture interrupted before original reload');};
  try{assert.throws(()=>holdQuarantine(f.parameters,f.native),/fixture interrupted/);}
  finally{f.native.reload=reload;}
  assert.ok(existsSync(f.q.marker));assert.ok(existsSync(f.q.guard));
  assert.deepEqual(f.effects,[]);
  return {marker:readFileSync(f.q.marker),guard:readFileSync(f.q.guard)};
}
test('exact marker-only hold completes only after its original owner path is separately safe',t=>{
 const f=fixture(t);mkdirSync(join(f.q.home,'.config'),{mode:0o770});chmodSync(join(f.q.home,'.config'),0o770);
 assert.throws(()=>holdQuarantine(f.parameters,f.native),/unsafe owner path/);
 const marker=readFileSync(f.q.marker),before=statSync(f.q.marker);
 assert.equal(existsSync(f.q.guard),false);assert.deepEqual(f.effects,[]);
 assert.throws(()=>holdQuarantine(f.parameters,f.native),/unsafe owner path/);
 assert.equal(statSync(join(f.q.home,'.config')).mode&0o777,0o770,'hold never repairs permissions');
 // This changes ONLY the owned fixture, modeling separately received owner work.
 chmodSync(join(f.q.home,'.config'),0o700);
 const completed=holdQuarantine(f.parameters,f.native);
 assert.equal(completed.status,'held');assert.equal(completed.unchanged,false);
 assert.deepEqual(readFileSync(f.q.marker),marker);const after=statSync(f.q.marker);
 assert.equal(after.ino,before.ino);assert.equal(after.mtimeMs,before.mtimeMs);
 assert.equal(readFileSync(f.q.guard,'utf8'),f.q.guardText);assert.deepEqual(f.effects,['daemon-reload']);
 assert.equal(holdQuarantine(f.parameters,f.native).unchanged,true);assert.deepEqual(f.effects,['daemon-reload']);
});
test('an exact guard staged before failed reload completes the same frozen preventive hold',t=>{
 const f=frozenPreventiveFixture(t),before=interruptedHold(f),markerStat=statSync(f.q.marker),guardStat=statSync(f.q.guard);
 const completed=holdQuarantine(f.parameters,f.native);assert.equal(completed.status,'held');assert.equal(completed.unchanged,false);
 assert.deepEqual(readFileSync(f.q.marker),before.marker);assert.deepEqual(readFileSync(f.q.guard),before.guard);
 assert.equal(statSync(f.q.marker).ino,markerStat.ino);assert.equal(statSync(f.q.guard).ino,guardStat.ino);
 assert.deepEqual(f.effects,['daemon-reload']);assert.equal(planQuarantine(f.parameters,f.native).status,'held');
 assert.throws(()=>releaseQuarantine(f.parameters,f.native),/hold-only policy explicitly refuses release/);
});
test('partial completion preserves the original stopped CDE marker and unknown-effect dependencies',t=>{
 const f=stoppedFixture(t),before=interruptedHold(f);
 assert.equal(holdQuarantine(f.parameters,f.native).status,'held');
 assert.deepEqual(readFileSync(f.q.marker),before.marker);assert.deepEqual(readFileSync(f.q.guard),before.guard);
 assert.deepEqual(f.effects,['daemon-reload']);assert.equal(existsSync(f.q.released),false);
});
test('partial completion refuses changed frozen birth or cohort before reloading',t=>{
 for(const change of [f=>f.u.ControlGroup='/different-cohort',f=>f.native.process=()=>({...f.expected.process,startTime:'different-birth'})]){
  const f=frozenPreventiveFixture(t),before=interruptedHold(f);change(f);
  assert.throws(()=>holdQuarantine(f.parameters,f.native));
  assert.deepEqual(readFileSync(f.q.marker),before.marker);assert.deepEqual(readFileSync(f.q.guard),before.guard);assert.deepEqual(f.effects,[]);
 }
});
test('an in-flight changed marker is retained and cannot be silently completed',t=>{
 const f=frozenPreventiveFixture(t),before=interruptedHold(f),unit=f.native.unit;let changed=false;
 f.native.unit=name=>{if(!changed){changed=true;writeFileSync(f.q.marker,Buffer.concat([before.marker,Buffer.from(' ')]));}return unit(name);};
 assert.throws(()=>holdQuarantine(f.parameters,f.native),/marker.*changed|changed.*marker/);
 assert.deepEqual(readFileSync(f.q.marker),Buffer.concat([before.marker,Buffer.from(' ')]));assert.deepEqual(readFileSync(f.q.guard),before.guard);assert.deepEqual(f.effects,[]);
});
test('partial completion refuses competing guard bytes without replacing marker or guard',t=>{
 const f=frozenPreventiveFixture(t),before=interruptedHold(f);writeFileSync(f.q.guard,'competing original owner bytes');
 assert.throws(()=>holdQuarantine(f.parameters,f.native),/guard bytes changed/);
 assert.deepEqual(readFileSync(f.q.marker),before.marker);assert.equal(readFileSync(f.q.guard,'utf8'),'competing original owner bytes');assert.deepEqual(f.effects,[]);
});
test('unknown native guard observation is never treated as permission to reload a partial hold',t=>{
 const f=frozenPreventiveFixture(t),before=interruptedHold(f),unit=f.native.unit;let calls=0;
 f.native.unit=name=>{if(++calls===2)throw new Error('native selected unit is unread');return unit(name);};
 assert.throws(()=>holdQuarantine(f.parameters,f.native),/native selected unit is unread/);
 assert.deepEqual(readFileSync(f.q.marker),before.marker);assert.deepEqual(readFileSync(f.q.guard),before.guard);assert.deepEqual(f.effects,[]);
});

test('partial completion refuses owner-path mode drift without repairing permissions or custody',t=>{
 const f=frozenPreventiveFixture(t),before=interruptedHold(f),config=join(f.q.home,'.config');
 chmodSync(config,0o770);
 assert.throws(()=>holdQuarantine(f.parameters,f.native),/unsafe owner path/);
 assert.equal(statSync(config).mode&0o777,0o770);assert.deepEqual(readFileSync(f.q.marker),before.marker);
 assert.deepEqual(readFileSync(f.q.guard),before.guard);assert.deepEqual(f.effects,[]);
});
