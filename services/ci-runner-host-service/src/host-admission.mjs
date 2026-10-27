// Original CI owner: physical admission consumes the original WSL capacity port.
// A snapshot is not a conserved job reservation. Unknown phase peaks refuse.
import assert from 'node:assert/strict';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {paths,tarballPath} from './runner-layout.mjs';

const contexts = new WeakMap();
const phases = new Set(['materialization', 'startup', 'job']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,23})$/.test(value);
export function canonicalPath(path) {
  assert.ok(typeof path === 'string' && isAbsolute(path) && resolve(path) === path && !/[\r\n\0]/.test(path), 'canonical absolute path required');
  return path;
}
export function inspectOwnedFile(path, { uid = process.getuid() } = {}) {
  canonicalPath(path);
  let parent = path;
  for (;;) {
    const st = lstatSync(parent);
    assert.ok(!st.isSymbolicLink(), 'redirected source/control path refused');
    assert.ok(st.uid === uid || st.uid === 0, 'foreign source/control owner refused');
    // Native Guix store and ordinary private temp roots have root-owned sticky
    // parents. Sticky protection plus the checked owned child preserves custody.
    assert.ok(!(st.mode & 0o022) || (st.isDirectory() && st.uid === 0 && (st.mode & 0o1000)), 'writable-by-others source/control path refused');
    const next = dirname(parent); if (parent === next) break; parent = next;
  }
  const st = lstatSync(path);
  assert.ok(st.isFile(), 'regular source/control file required');
  assert.equal(realpathSync(path), path, 'redirected source/control file refused');
  return st;
}
export function readOwnedFile(path, { uid = process.getuid(), sha256 } = {}) {
  const st = inspectOwnedFile(path,{uid});
  const bytes = readFileSync(path), hash = digest(bytes);
  if (sha256 !== undefined) { assert.match(sha256, /^[a-f0-9]{64}$/); assert.equal(hash, sha256, 'source/control digest drift'); }
  return { path, bytes, sha256: hash, dev: st.dev, ino: st.ino, mode: st.mode & 0o777, uid: st.uid };
}
const unchanged = receipt => {
  const current = readOwnedFile(receipt.path, { uid: receipt.uid, sha256: receipt.sha256 });
  assert.equal(current.dev, receipt.dev, 'source/control device drift');
  assert.equal(current.ino, receipt.ino, 'source/control inode drift');
};

/** Source/config inspection only; installing refusal controls requires no growth admission. */
export function admissionDeclaration(record) {
  assert.equal(record.schema,'ci-runner-host-parameters@1');
  const p = record.hostAdmission;
  assert.ok(p && typeof p === 'object', 'original hostAdmission declaration required before runner effects');
  const host = readOwnedFile(p.hostParametersPath);
  const parameters = JSON.parse(host.bytes);
  assert.equal(parameters.schema, 'wsl-host-parameters@1');
  assert.ok(decimal(parameters.windows?.backingStorage?.policy?.minFreeBytes)
    && BigInt(parameters.windows.backingStorage.policy.minFreeBytes) >= 100000000000n, '100GB physical reserve cannot be lowered');
  const provider = p.provider;
  assert.ok(provider && typeof provider === 'object', 'original WSL capacity provider required');
  const module = readOwnedFile(provider.module, { sha256: provider.sha256 });
  const assetPath = join(dirname(dirname(provider.module)), 'assets/observe-backing-capacity.ps1');
  assert.equal(provider.asset, assetPath, 'original capacity sibling asset required');
  const asset = readOwnedFile(provider.asset, { sha256: provider.assetSha256 });
  return { declaration: p, parameters, receipts: [host, module, asset], module };
}

/** Test ports replace the native WSL observations, never its assessment or boolean result. */
export async function observeHostAdmission(record, { phase, destinations }, { capacityPorts } = {}) {
  assert.ok(phases.has(phase), 'known original runner phase required');
  const bound = admissionDeclaration(record), declaredPeak = bound.declaration.phasePeakBytes?.[phase];
  assert.ok(decimal(declaredPeak) && BigInt(declaredPeak) > 0n, `unknown or zero ${phase} peak; runner effects refused`);
  const jobPeak=phase==='startup'?bound.declaration.phasePeakBytes?.job:'0';
  if(phase==='startup')assert.ok(decimal(jobPeak)&&BigInt(jobPeak)>0n,'unknown selected job/preparation envelope; Listener startup refused');
  const peak=String(BigInt(declaredPeak)+BigInt(jobPeak));
  assert.ok(Array.isArray(destinations) && destinations.length && destinations.length <= 32, 'explicit runner destinations required');
  destinations.forEach(canonicalPath);
  assert.equal(new Set(destinations).size, destinations.length, 'duplicate runner destinations');
  // The declared SHA supplies operator-selected original code, not arbitrary JSON capacity.
  const original = await import(pathToFileURL(bound.module.path).href + '?sha256=' + bound.module.sha256);
  bound.receipts.forEach(unchanged);
  assert.equal(typeof original.observeBackingVolumeCapacity, 'function', 'original WSL observation export required');
  assert.equal(typeof original.assessBackingVolumeHeadroom, 'function', 'original WSL assessment export required');
  const capacity = original.observeBackingVolumeCapacity(bound.parameters, destinations, capacityPorts);
  bound.receipts.forEach(unchanged);
  assert.equal(capacity.admissionKind, 'snapshot-not-reservation');
  const assessments = original.assessBackingVolumeHeadroom(capacity).map(item => ({ ...item,
    phasePeakBytes: peak, phaseRequiredBytes: String(BigInt(item.requiredBytes) + BigInt(peak)),
    admitted: BigInt(item.availableBytes) >= BigInt(item.requiredBytes) + BigInt(peak) }));
  assert.ok(assessments.length > 0, 'physical capacity observation required');
  return { type: 'CiRunnerHostAdmission', phase, admitted: assessments.every(item => item.admitted),
    declaredPhasePeakBytes:declaredPeak, startupJobEnvelopeBytes:phase==='startup'?jobPeak:null,
    admissionKind: 'snapshot-not-reservation', capacity, assessments, source: bound.receipts.map(({path,sha256}) => ({path,sha256})) };
}

/** Derive the actual original installer's writes, never caller-asserted destinations. */
export function materializationDestinations(record,runners){
  assert.ok(Array.isArray(runners)&&runners.length>0&&runners.length<=16,'bounded selected original runners required');
  assert.ok(Array.isArray(record.runners),'canonical original runner selection required');
  assert.equal(new Set(runners.map(r=>r.name)).size,runners.length,'duplicate admitted runner');
  for(const r of runners){
    assert.ok(record.runners.some(original=>JSON.stringify(original)===JSON.stringify(r)),'selected runner not in canonical operation');
    canonicalPath(r.root);assert.match(r.version,/^\d+\.\d+\.\d+$/,'original pinned runner version required');
  }
  const destinations=[...new Set(runners.flatMap(r=>[r.root,paths(r).runner,paths(r).version,tarballPath(r)]))];
  destinations.forEach(canonicalPath);return destinations;
}

/** Private same-operation context protects direct synchronous mutation entry points. */
export async function prepareHostAdmission(record, runners) {
  assert.equal(arguments.length,2,'issuer derives destinations and accepts no observation overrides');
  assert.ok(record.controls?.mode!=='existing-flat','controls-only declaration cannot issue runner growth authority');
  const bound=admissionDeclaration(record);
  const ci=readOwnedFile(record.hostAdmission.ciParametersPath);
  assert.deepEqual(JSON.parse(ci.bytes),record,'canonical CI record differs from requested operation');
  const destinations=materializationDestinations(record,runners);
  const evidence = await observeHostAdmission(record, { phase: 'materialization', destinations });
  if(!evidence.admitted)throw Object.assign(new Error('insufficient native physical headroom for materialization'),{code:'runner-physical-capacity-refused',evidence});
  const context = Object.freeze({});unchanged(ci);
  assert.deepEqual(bound.receipts.map(({path,sha256})=>({path,sha256})),evidence.source,'admission source changed after observation');
  contexts.set(context, { runners: runners.map(r => JSON.stringify(r)), receipts: [ci,...bound.receipts],
    at: Date.parse(evidence.capacity.at), maxAgeMs: bound.parameters.windows.backingStorage.maxAgeMs });
  return context;
}
export function assertOperationAdmission(context, runner) {
  const bound = contexts.get(context);
  assert.ok(bound, 'issued original host admission required before runner mutation');
  assert.ok(bound.runners.includes(JSON.stringify(runner)), 'runner differs from admitted operation');
  const age = Date.now() - bound.at;
  assert.ok(age >= 0 && age <= bound.maxAgeMs, 'original host admission snapshot expired');
  bound.receipts.forEach(unchanged);
}
export function closeHostAdmission(context) { contexts.delete(context); }
