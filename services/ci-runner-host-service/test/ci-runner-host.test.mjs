import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { bytes, renderUnit, renderHook, mergeEnv, workspacesToRemove, ancestorCeiling, paths, isVersion } from '../src/ci-runner-host.mjs';

const r = {
  name: 'box', scope: 'https://github.com/o/r', version: '2.0.0', root: '/srv/ci/box',
  retain: ['r/r'], diagDays: 7, slice: 'ci.slice', nice: 10, cpuWeight: 20, ioWeight: 20, memoryMax: '6G',
};

test('the unit yields by weight and nice, has one hard ceiling and never a soft one (CR-8, CR-9)', () => {
  const u = renderUnit(r);
  for (const l of ['Slice=ci.slice', 'Nice=10', 'CPUWeight=20', 'IOWeight=20', 'MemoryMax=6G', 'WorkingDirectory=/srv/ci/box/runner', 'ExecStart=/srv/ci/box/runner/run.sh']) assert.ok(u.includes(`${l}\n`), l);
  assert.doesNotMatch(u, /MemoryHigh/);
});

test('every path comes from the record (CR-2, CR-5)', () => {
  assert.deepEqual(paths(r), {
    runner: '/srv/ci/box/runner', version: '/srv/ci/box/versions/2.0.0', hook: '/srv/ci/box/hooks/job-completed.sh',
    work: '/srv/ci/box/runner/_work', diag: '/srv/ci/box/runner/_diag',
  });
});

test('.env keeps the runner\'s lines and sets the hook once (CR-6, CR-11)', () => {
  const once = mergeEnv('LANG=C.UTF-8\nPATH=/bin\n', 'ACTIONS_RUNNER_HOOK_JOB_COMPLETED', '/h.sh');
  assert.equal(once, 'LANG=C.UTF-8\nPATH=/bin\nACTIONS_RUNNER_HOOK_JOB_COMPLETED=/h.sh\n');
  assert.equal(mergeEnv(once, 'ACTIONS_RUNNER_HOOK_JOB_COMPLETED', '/h.sh'), once);
});

test('only unretained workspaces are removed; the runner\'s own folders are not (CR-6)', () => {
  const e = [{ top: 'r', child: 'r' }, { top: 'r', child: 'old' }, { top: 'x', child: 'x' }, { top: '_tool', child: 'node' }];
  assert.deepEqual(workspacesToRemove(e, ['r/r']), ['r/old', 'x/x']);
});

test('the hook removes temp, stray workspaces and old diagnostics, and keeps caches (CR-6, CR-7)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-')), rr = { ...r, root };
  const p = paths(rr);
  for (const d of ['_temp/job1', 'r/r', 'r/old', 'x/x', '_tool/node']) mkdirSync(join(p.work, d), { recursive: true });
  mkdirSync(p.diag, { recursive: true });
  writeFileSync(join(p.diag, 'old.log'), ''); writeFileSync(join(p.diag, 'new.log'), '');
  const t = Date.now() / 1000 - 30 * 86400; utimesSync(join(p.diag, 'old.log'), t, t);
  writeFileSync(join(root, 'hook.sh'), renderHook(rr));
  execFileSync('bash', [join(root, 'hook.sh')]);
  assert.equal(existsSync(join(p.work, '_temp/job1')), false);
  assert.equal(existsSync(join(p.work, 'r/old')), false);
  assert.equal(existsSync(join(p.work, 'x')), false);
  assert.equal(existsSync(join(p.work, 'r/r')), true);
  assert.equal(existsSync(join(p.work, '_tool/node')), true);
  assert.equal(existsSync(join(p.diag, 'old.log')), false);
  assert.equal(existsSync(join(p.diag, 'new.log')), true);
});

test('recently used workspaces are caches, the finished job\'s is marked used, and maxBytes evicts the least recent (CR-12)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-recent-')), rr = { ...r, root, retain: [], retainRecentDays: 7, maxBytes: '64K' };
  const p = paths(rr), age = (d, days) => { const t = Date.now() / 1000 - days * 86400; utimesSync(join(p.work, d), t, t); };
  for (const d of ['_temp/job1', 'a/a', 'b/b', 'old/old', 'job/job']) mkdirSync(join(p.work, d), { recursive: true });
  mkdirSync(p.diag, { recursive: true });
  age('a/a', 1); age('b/b', 2); age('old/old', 30); age('job/job', 30);
  writeFileSync(join(root, 'hook.sh'), renderHook(rr));
  // the job that just finished ran in job/job: it is the newest cache, though its checkout is old
  execFileSync('bash', [join(root, 'hook.sh')], { env: { ...process.env, GITHUB_WORKSPACE: join(p.work, 'job/job') } });
  assert.equal(existsSync(join(p.work, '_temp/job1')), false);
  assert.equal(existsSync(join(p.work, 'old')), false, 'unused for longer than retainRecentDays');
  for (const d of ['a/a', 'b/b', 'job/job']) assert.equal(existsSync(join(p.work, d)), true, d);
  // over maxBytes the least recently used goes first, the finished job's last
  writeFileSync(join(p.work, 'a/a/blob'), Buffer.alloc(48 * 1024)); writeFileSync(join(p.work, 'b/b/blob'), Buffer.alloc(48 * 1024));
  age('a/a', 1); age('b/b', 2);
  execFileSync('bash', [join(root, 'hook.sh')], { env: { ...process.env, GITHUB_WORKSPACE: join(p.work, 'job/job') } });
  assert.equal(existsSync(join(p.work, 'b')), false, 'least recently used evicted');
  assert.equal(existsSync(join(p.work, 'job/job')), true);
  // a workspace outside this runner's work folder is never touched
  assert.throws(() => renderHook({ ...rr, retainRecentDays: -1 }), /whole number/);
  rmSync(root, { recursive: true, force: true });
});

test('without retainRecentDays the hook keeps only the declared caches, as before (CR-6)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-static-')), rr = { ...r, root }, p = paths(rr);
  for (const d of ['r/r', 'x/x']) mkdirSync(join(p.work, d), { recursive: true });
  mkdirSync(p.diag, { recursive: true });
  writeFileSync(join(root, 'hook.sh'), renderHook(rr));
  execFileSync('bash', [join(root, 'hook.sh')], { env: { ...process.env, GITHUB_WORKSPACE: join(p.work, 'x/x') } });
  assert.equal(existsSync(join(p.work, 'x')), false); assert.equal(existsSync(join(p.work, 'r/r')), true);
  rmSync(root, { recursive: true, force: true });
});

test('a symlinked bin is not the installed version; hard-linked real directories are (CR-3)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cv-')), v = join(root, 'versions/1'), run = join(root, 'runner');
  for (const d of ['bin', 'externals']) mkdirSync(join(v, d), { recursive: true });
  writeFileSync(join(v, 'bin/Runner.Listener'), '');
  mkdirSync(run, { recursive: true });
  symlinkSync(join(v, 'bin'), join(run, 'bin')); symlinkSync(join(v, 'externals'), join(run, 'externals'));
  assert.equal(isVersion(run, v), false);
  rmSync(join(run, 'bin')); rmSync(join(run, 'externals'));
  for (const d of ['bin', 'externals']) execFileSync('cp', ['-al', join(v, d), join(run, d)]);
  assert.equal(isVersion(run, v), true);
});

test('a parent cap below the runner\'s ceiling is found (CR-9)', () => {
  const max = { '/user.slice': '3221225472', '/user.slice/user-1000.slice': 'max', '/user.slice/user-1000.slice/user@1000.service': 'max' };
  assert.equal(ancestorCeiling('/user.slice/user-1000.slice/user@1000.service/ci.slice/ci-runner-box.service', (c) => max[c] ?? 'max'), 3221225472);
  assert.equal(ancestorCeiling('/a/b/c', () => 'max'), null);
  assert.equal(bytes('6G'), 6 * 1024 ** 3);
});
