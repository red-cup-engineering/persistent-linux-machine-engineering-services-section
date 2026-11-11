import {isCliEntry} from './cli-entry.mjs';
// Read-only evidence for the credential unit already declared by the machine.
// Called inside receive.scm's existing writer lease, around its normal switch.
// This is receiving evidence, not credential custody or caller authorization.
import { readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { sha256, gitBlobIdentity, selectedPackageFile } from './package-receiving.mjs';

const UNIT = '561-group-credentials.service';
const PACKAGE = '@red-cup-engineering/credential-custody-service';
const PROGRAM = `node_modules/${PACKAGE}/scripts/render-host.mjs`;
const PROPERTIES = ['Id', 'LoadState', 'ActiveState', 'SubState', 'Type', 'Result',
  'ExecMainCode', 'ExecMainStatus', 'ExecMainStartTimestampMonotonic',
  'ExecMainExitTimestampMonotonic', 'InvocationID', 'ExecStart', 'NeedDaemonReload'];
// Closed refusal vocabulary: raw subprocess/file/parse errors remain unavailable.
const REFUSALS = new Map([
  ['systemctl observation unavailable', 'observation-unavailable'],
  ['invalid observation', 'invalid-observation'],
  ['unit identity differs', 'unit-identity-mismatch'],
  ['renderer source is not uniquely selected', 'renderer-source-ambiguous'],
  ['renderer source identity is not admitted', 'renderer-source-unadmitted'],
  ['declared renderer command differs', 'declared-command-mismatch'],
  ['no existing activation dependency for renderer', 'activation-dependency-missing'],
  ['renderer alias differs from selected source package', 'renderer-alias-mismatch'],
  ['boot identity unavailable', 'boot-identity-unavailable'],
  ['baseline unavailable', 'baseline-unavailable'],
  ['declaration changed', 'declaration-changed'],
  ['baseline or boot identity differs', 'baseline-identity-mismatch'],
  ['successful completed oneshot is not evidenced', 'completed-oneshot-unproven'],
  ['fresh completed invocation is not evidenced', 'fresh-invocation-unproven'],
  ['invocation identity did not advance', 'invocation-identity-unproven'],
  ['executed command structure is unavailable', 'executed-command-unavailable'],
  ['executed command interpreter differs', 'executed-interpreter-mismatch'],
  ['executed command arguments differ', 'executed-arguments-mismatch'],
  ['unknown reading mode', 'unknown-mode'],
  ['immutable candidate required', 'immutable-candidate-required'],
]);
class CredentialRefusal extends Error {
  constructor(reason) {
    super(`credential unit receiving: ${reason}`);
    this.reason = REFUSALS.get(reason) ?? 'unavailable';
  }
}
const fail = reason => { throw new CredentialRefusal(reason); };
export function credentialRefusal(error) {
  return { kind: 'credential-unit-receiving', status: 'refused',
    reason: error instanceof CredentialRefusal && [...REFUSALS.values()].includes(error.reason)
      ? error.reason : 'unavailable' };
}
const integer = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
const invocation = value => value === '' || /^[a-f0-9]{32}$/.test(value ?? '');
const json = file => JSON.parse(readFileSync(file, 'utf8'));

// Do not request Environment, EnvironmentFiles, StatusText or journal messages.
// Even a failed or malformed response is never interpolated into an error.
export function observeCredentialUnit(run = spawnSync) {
  const response = run('systemctl', ['--user', 'show', '--all',
    `--property=${PROPERTIES.join(',')}`, UNIT],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, maxBuffer: 64 * 1024 });
  if (response.error || response.status !== 0) fail('systemctl observation unavailable');
  const fields = {};
  for (const line of response.stdout.trimEnd().split('\n')) {
    const at = line.indexOf('='), key = line.slice(0, at);
    if (at < 1 || !PROPERTIES.includes(key) || Object.hasOwn(fields, key)) fail('invalid observation');
    fields[key] = line.slice(at + 1);
  }
  if (fields.Id !== UNIT) fail('unit identity differs');
  return fields;
}

export function credentialDeclaration(artifact) {
  const config = json(join(artifact, '.controller/machine.json'));
  if (!(config.auxiliaryUnits ?? []).includes(UNIT)) return null;
  const sources = json(join(artifact, '.metadata/sources.json'));
  const packages = sources.packages.filter(p => p.name === PACKAGE);
  if (packages.length !== 1) fail('renderer source is not uniquely selected');
  const source = packages[0];
  const repositories = sources.repositories.filter(r => r.repository === source.repository);
  if (repositories.length !== 1 || repositories[0].commit !== source.commit ||
      !/^[a-f0-9]{40}$/.test(source.commit ?? '') ||
      !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(source.repository ?? '') ||
      typeof source.path !== 'string' || !source.path.split('/').every(x => /^[a-zA-Z0-9_.-]+$/.test(x) && x !== '..'))
    fail('renderer source identity is not admitted');
  const unitText = readFileSync(join(artifact, '.guix-systemd', UNIT), 'utf8');
  const starts = unitText.split('\n').filter(line => line.startsWith('ExecStart='));
  const command = starts[0]?.slice('ExecStart='.length);
  const words = command?.split(' ');
  if (starts.length !== 1 || words?.length !== 2 ||
      !/^\/gnu\/store\/[a-z0-9]+-[^\s;]+\/bin\/node$/.test(words[0]) ||
      words[1] !== join(artifact, PROGRAM) || !unitText.split('\n').includes('Type=oneshot'))
    fail('declared renderer command differs');
  // Existing restart/dependency policy supplies the invocation; this code never starts a unit.
  const main = readFileSync(join(artifact, '.guix-systemd', config.unit), 'utf8');
  const has = key => main.split('\n').some(line => line.startsWith(key + '=') && line.slice(key.length + 1).split(/\s+/).includes(UNIT));
  if (!(config.restartAuxiliaryUnits ?? []).includes(UNIT) && !(has('Requires') && has('After')))
    fail('no existing activation dependency for renderer');
  // prepare-sources reads this selected package from the commit's ls-tree and
  // cat-file blob set (not working files). assemble links that same package;
  // Guix seals it. Refuse an entrypoint alias to a different materialized owner.
  const selectedProgram = selectedPackageFile(artifact, source, 'scripts/render-host.mjs');
  if (realpathSync(join(artifact, PROGRAM)) !== realpathSync(selectedProgram))
    fail('renderer alias differs from selected source package');
  const bytes = readFileSync(selectedProgram);
  return { unit: UNIT, command, interpreter: words[0], program: words[1],
    renderer: { package: PACKAGE, repository: source.repository, commit: source.commit,
      path: `${source.path}/scripts/render-host.mjs`, gitBlob: gitBlobIdentity(bytes, '0'.repeat(40)), sha256: sha256(bytes) } };
}

const bootIdentity = () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
function validBoot(boot) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(boot ?? '')) fail('boot identity unavailable');
  return boot;
}

export function credentialBaseline(declaration, fields, boot) {
  if (!declaration) return { status: 'not-declared' };
  if (!integer(fields.ExecMainStartTimestampMonotonic) || !invocation(fields.InvocationID)) fail('baseline unavailable');
  return { status: 'baseline', unit: UNIT, bootId: validBoot(boot),
    started: fields.ExecMainStartTimestampMonotonic, invocationId: fields.InvocationID || null };
}

export function verifyCredentialExecution(declaration, before, fields, boot) {
  if (!declaration) {
    if (before?.status !== 'not-declared') fail('declaration changed');
    return { status: 'not-declared' };
  }
  if (before?.status !== 'baseline' || before.unit !== UNIT || !integer(before.started) ||
      before.bootId !== validBoot(boot)) fail('baseline or boot identity differs');
  if (fields.Id !== UNIT || fields.LoadState !== 'loaded' || fields.Type !== 'oneshot' ||
      fields.NeedDaemonReload !== 'no' || fields.Result !== 'success' ||
      fields.ExecMainCode !== '1' || fields.ExecMainStatus !== '0' ||
      !((fields.ActiveState === 'inactive' && fields.SubState === 'dead') ||
        (fields.ActiveState === 'active' && fields.SubState === 'exited')))
    fail('successful completed oneshot is not evidenced');
  const start = fields.ExecMainStartTimestampMonotonic, end = fields.ExecMainExitTimestampMonotonic;
  // systemd documents these as the last/current process's CLOCK_MONOTONIC times.
  // Inactive is valid, but zero/forgotten/old timestamps are never positive proof.
  if (!integer(start) || !integer(end) || BigInt(start) <= BigInt(before.started) ||
      BigInt(start) === 0n || BigInt(end) < BigInt(start)) fail('fresh completed invocation is not evidenced');
  if (!invocation(fields.InvocationID) ||
      (fields.InvocationID && fields.InvocationID === before.invocationId)) fail('invocation identity did not advance');
  // systemctl's ExecStart is a bounded structure, augmented with runtime status.
  // Compare its path/argv internally; neither command text nor unknown fields are emitted.
  const execution = fields.ExecStart?.match(/^\{ path=([^;]+?)\s*; argv\[\]=([^;]+?)\s*; ignore_errors=no\s*; [^{}]*; code=exited\s*; status=0\s*\}$/);
  if (!execution) fail('executed command structure is unavailable');
  if (execution[1] !== declaration.interpreter) fail('executed command interpreter differs');
  if (execution[2] !== declaration.command) fail('executed command arguments differ');
  return { status: 'received', unit: UNIT, bootId: boot, Result: fields.Result,
    ExecMainCode: 1, ExecMainStatus: 0, InvocationID: fields.InvocationID || null,
    ExecMainStartTimestampMonotonic: start, ExecMainExitTimestampMonotonic: end,
    commandMatches: true, commandSha256: sha256(declaration.command), renderer: declaration.renderer };
}

export function credentialUnitReading(artifact, mode, before, ports = {}) {
  const declaration = credentialDeclaration(artifact);
  const fields = declaration ? (ports.observe ?? observeCredentialUnit)() : null;
  const boot = declaration ? (ports.bootIdentity ?? bootIdentity)() : null;
  if (mode === 'baseline') return credentialBaseline(declaration, fields, boot);
  if (mode === 'verify') return verifyCredentialExecution(declaration, before, fields, boot);
  fail('unknown reading mode');
}

if (isCliEntry(import.meta.url)) {
  try {
    const [artifact, mode, baseline] = process.argv.slice(2);
    if (!/^\/gnu\/store\/[a-z0-9]+-[^/\s]+$/.test(artifact ?? '') || realpathSync(artifact) !== artifact)
      fail('immutable candidate required');
    process.stdout.write(JSON.stringify(credentialUnitReading(artifact, mode,
      mode === 'verify' ? JSON.parse(baseline) : undefined)) + '\n');
  } catch (error) {
    // Report only an enumerated refusal, not exception text or raw observations.
    process.stderr.write(JSON.stringify(credentialRefusal(error)) + '\n');
    process.exitCode = 1;
  }
}
