import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderStartHook, paths } from '../src/ci-runner-host.mjs';

// Two runners of one host, as the record declares them: sibling roots under one state directory.
function host() {
  const state = mkdtempSync(join(tmpdir(), 'ci-job-slot-'));
  const runners = ['a', 'b'].map((name) => ({ name, root: join(state, name), version: '2.0.0' }));
  execFileSync('mkdir', ['-p', join(state, 'hooks')]);
  for (const r of runners) writeFileSync(paths(r).startHook, renderStartHook(r), { mode: 0o755 });
  return { state, runners };
}
// A stand-in job worker: runs the job-started hook as the runner does (the worker is the hook's parent), then
// "works" until killed, and reports when its hook let it start.
function job(r) {
  const worker = spawn('bash', ['-c', `bash ${paths(r).startHook}; echo started; exec sleep 600`], { stdio: ['ignore', 'pipe', 'ignore'] });
  const started = new Promise((resolve) => worker.stdout.on('data', (chunk) => { if (String(chunk).includes('started')) resolve(Date.now()); }));
  return { worker, started };
}
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exited = (worker) => new Promise((resolve) => worker.once('exit', resolve));

test('the host runs one job at a time: a second runner\'s job starts only after the first job\'s worker exits', async () => {
  const { state, runners: [a, b] } = host();
  try {
    const first = job(a);
    await first.started;
    const second = job(b);
    let secondStarted = false;
    second.started.then(() => { secondStarted = true; });
    await settle(1500);
    assert.equal(secondStarted, false, 'the second job must wait while the first holds the slot');
    const endedAt = Date.now();
    first.worker.kill('SIGKILL');
    await exited(first.worker);
    const at = await second.started;
    assert.ok(at >= endedAt, 'the second job started after the first worker ended');
    second.worker.kill('SIGKILL');
    await exited(second.worker);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('the job-completed release (killing the holder) frees the slot before the worker exits', async () => {
  const { state, runners: [a, b] } = host();
  try {
    const first = job(a);
    await first.started;
    assert.ok(existsSync(paths(a).slotHolder));
    const second = job(b);
    execFileSync('bash', ['-c', `kill "$(cat '${paths(a).slotHolder}')"; rm -f '${paths(a).slotHolder}'`]);
    await second.started;
    for (const each of [first, second]) { each.worker.kill('SIGKILL'); await exited(each.worker); }
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('a pull request job completing dispatches the declared processor for its repository; other events do not (CR-29)', async () => {
  const { renderHook } = await import('../src/ci-runner-host.mjs');
  const state = mkdtempSync(join(tmpdir(), 'ci-dispatch-'));
  try {
    const calls = join(state, 'calls');
    const gh = join(state, 'gh');
    writeFileSync(gh, `#!/bin/bash\nprintf '%s|' "$@" >> '${calls}'; printf 'token=%s\\n' "\${GITHUB_TOKEN:-none}" >> '${calls}'\n`, { mode: 0o755 });
    const r = { name: 'a', root: join(state, 'a'), version: '2.0.0', diagDays: 7, registration: { executable: gh },
      pullRequestJobCompletedDispatch: { repository: 'o/runner', workflow: 'process-pull-requests.yml' } };
    execFileSync('mkdir', ['-p', join(state, 'a', '_work', '_temp'), join(state, 'a', '_diag')]);
    const hook = join(state, 'hook.sh');
    writeFileSync(hook, renderHook(r), { mode: 0o755 });
    for (const [event, repository] of [['pull_request', 'o/r'], ['push', 'o/r'], ['pull_request', 'bad repo']])
      execFileSync('bash', [hook], { env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_REPOSITORY: repository, GITHUB_TOKEN: 'job-token' } });
    assert.equal(execFileSync('cat', [calls], { encoding: 'utf8' }), 'workflow|run|process-pull-requests.yml|-R|o/runner|-f|repository=o/r|token=none\n');
    assert.doesNotMatch(renderHook({ ...r, pullRequestJobCompletedDispatch: undefined }), /workflow run/);
    assert.throws(() => renderHook({ ...r, pullRequestJobCompletedDispatch: { repository: 'x', workflow: 'w.yml' } }), /owner\/name/);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('a change deferred during a job is reconciled once that job\'s worker exits, and only then (CR-31)', async () => {
  const { renderHook } = await import('../src/ci-runner-host.mjs');
  const state = mkdtempSync(join(tmpdir(), 'ci-reconcile-'));
  try {
    const bin = join(state, 'bin'), calls = join(state, 'calls');
    execFileSync('mkdir', ['-p', bin, join(state, 'a', '_work', '_temp'), join(state, 'a', '_diag')]);
    writeFileSync(join(bin, 'systemctl'), `#!/bin/bash\nprintf '%s\\n' "$*" >> '${calls}'\n`, { mode: 0o755 });
    const r = { name: 'a', root: join(state, 'a'), version: '2.0.0', diagDays: 7 };
    const hook = join(state, 'hook.sh');
    writeFileSync(hook, renderHook(r), { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const run = () => spawn('bash', ['-c', `bash ${hook}; exec sleep 600`], { env, stdio: 'ignore' });
    const quiet = run(); await settle(800); quiet.kill('SIGKILL'); await exited(quiet); await settle(1500);
    assert.equal(existsSync(calls), false, 'no change pending: nothing is started');
    writeFileSync(paths(r).reconcilePending, 'pending\n');
    const worker = run(); await settle(1500);
    assert.equal(existsSync(calls), false, 'not while the job\'s worker still runs');
    worker.kill('SIGKILL'); await exited(worker); await settle(2500);
    assert.equal(execFileSync('cat', [calls], { encoding: 'utf8' }), '--user start --no-block ci-runner-host-reconcile.service\n');
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('a job whose commit is no longer current when it takes the slot is cancelled; a current or unreadable one runs (CR-33)', async () => {
  const state = mkdtempSync(join(tmpdir(), 'ci-superseded-'));
  try {
    const calls = join(state, 'calls'), gh = join(state, 'gh');
    // A fake gh: answers the pull request and branch reads from files, records every cancel.
    writeFileSync(gh, `#!/bin/bash
if [ "$1" = run ] && [ "$2" = cancel ]; then printf 'cancel %s %s\\n' "$3" "$5" >> '${calls}'; exit 0; fi
case "$2" in */pulls/*) cat '${state}/pull' 2>/dev/null || exit 1 ;; */commits/*) cat '${state}/branch' 2>/dev/null || exit 1 ;; esac
`, { mode: 0o755 });
    const r = { name: 'a', root: join(state, 'a'), version: '2.0.0', registration: { executable: gh }, cancelSupersededJobs: { jq: '/usr/bin/jq' } };
    execFileSync('mkdir', ['-p', join(state, 'hooks')]);
    writeFileSync(paths(r).startHook, renderStartHook(r), { mode: 0o755 });
    const event = join(state, 'event.json');
    const old = 'a'.repeat(40), newer = 'b'.repeat(40);
    // The stand-in worker is its own process ("; true" keeps bash from exec-ing the hook), so the slot frees when it exits.
    const runHook = (env) => execFileSync('bash', ['-c', `bash ${paths(r).startHook}; true`], { stdio: 'ignore', env: { ...process.env, GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '42', GITHUB_EVENT_PATH: event, GH_TOKEN: 'job', ...env } });
    const cancels = () => (existsSync(calls) ? execFileSync('cat', [calls], { encoding: 'utf8' }) : '');
    writeFileSync(event, JSON.stringify({ pull_request: { number: 7, head: { sha: old } } }));
    writeFileSync(join(state, 'pull'), `${old}\n`); runHook({ GITHUB_EVENT_NAME: 'pull_request' });
    assert.equal(cancels(), '', 'current head: runs');
    writeFileSync(join(state, 'pull'), `${newer}\n`); runHook({ GITHUB_EVENT_NAME: 'pull_request' });
    assert.equal(cancels(), 'cancel 42 o/r\n', 'head moved: cancelled');
    writeFileSync(join(state, 'pull'), 'closed\n'); runHook({ GITHUB_EVENT_NAME: 'pull_request' });
    assert.equal(cancels(), 'cancel 42 o/r\ncancel 42 o/r\n', 'closed: cancelled');
    rmSync(join(state, 'pull')); runHook({ GITHUB_EVENT_NAME: 'pull_request' });
    assert.equal(cancels().split('\n').length - 1, 2, 'unreadable: runs');
    writeFileSync(join(state, 'branch'), `${old}\n`); runHook({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: old });
    assert.equal(cancels().split('\n').length - 1, 2, 'branch still at this commit: runs');
    writeFileSync(join(state, 'branch'), `${newer}\n`); runHook({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: old });
    assert.equal(cancels().split('\n').length - 1, 3, 'branch moved on: cancelled');
    assert.doesNotMatch(renderStartHook({ ...r, cancelSupersededJobs: undefined }), /run cancel/);
  } finally {
    for (const pid of execFileSync('bash', ['-c', `cat '${state}'/ci-job-slot/*.pid 2>/dev/null || true`], { encoding: 'utf8' }).split('\n').filter(Boolean)) { try { process.kill(Number(pid)); } catch {} }
    rmSync(state, { recursive: true, force: true });
  }
});

test('a push run that repeats its open pull request\'s run of the same commit is cancelled; the PR run never is (CR-35)', async () => {
  const state = mkdtempSync(join(tmpdir(), 'ci-duplicate-'));
  try {
    const calls = join(state, 'calls'), gh = join(state, 'gh');
    writeFileSync(gh, `#!/bin/bash
if [ "$1" = run ] && [ "$2" = cancel ]; then printf 'cancel %s\\n' "$3" >> '${calls}'; exit 0; fi
case "$2" in
  repos/o/r) cat '${state}/default' ;;
  repos/o/r/pulls\\?*) cat '${state}/open-head' ;;
  repos/o/r/contents/*) base64 -w0 '${state}/workflow.yml' ;;
  repos/o/r/commits/*) cat '${state}/branch' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    const r = { name: 'a', root: join(state, 'a'), version: '2.0.0', registration: { executable: gh }, cancelSupersededJobs: { jq: '/usr/bin/jq' } };
    execFileSync('mkdir', ['-p', join(state, 'hooks')]);
    writeFileSync(paths(r).startHook, renderStartHook(r), { mode: 0o755 });
    const sha = 'a'.repeat(40);
    writeFileSync(join(state, 'default'), 'main\n'); writeFileSync(join(state, 'branch'), `${sha}\n`);
    const push = (ref, env = {}) => execFileSync('bash', ['-c', `bash ${paths(r).startHook}; true`], { stdio: 'ignore', env: { ...process.env,
      GITHUB_EVENT_NAME: 'push', GITHUB_REF: ref, GITHUB_SHA: sha, GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '9',
      GITHUB_WORKFLOW_REF: `o/r/.github/workflows/ci.yml@${ref}`, ...env } });
    const count = () => (existsSync(calls) ? execFileSync('cat', [calls], { encoding: 'utf8' }).split('\n').length - 1 : 0);
    writeFileSync(join(state, 'open-head'), `${sha}\n`);
    writeFileSync(join(state, 'workflow.yml'), 'on:\n  push:\n  pull_request:\n    branches: [main]\n');
    push('refs/heads/work'); assert.equal(count(), 1, 'duplicate of the PR run: cancelled');
    writeFileSync(join(state, 'workflow.yml'), 'on: [push, pull_request]\n');
    push('refs/heads/work'); assert.equal(count(), 2, 'list form: cancelled');
    writeFileSync(join(state, 'workflow.yml'), 'on:\n  push:\n  workflow_dispatch:\n');
    push('refs/heads/work'); assert.equal(count(), 2, 'the workflow has no PR run: runs');
    writeFileSync(join(state, 'workflow.yml'), 'on:\n  push:\n  pull_request:\n');
    push('refs/heads/main'); assert.equal(count(), 2, 'the default branch: runs');
    writeFileSync(join(state, 'open-head'), `${'b'.repeat(40)}\n`);
    push('refs/heads/work'); assert.equal(count(), 2, 'the PR head is another commit: runs');
  } finally { rmSync(state, { recursive: true, force: true }); }
});
