// Explicit native WSL ephemeral-swap retirement. Rendering performs no host effects.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { validateBackingStorage } from './backing-capacity.mjs';
import { observeStorageProviders } from './storage-providers.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const guid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const fileId = /^[0-9a-f]{8}:[0-9a-f]{16}$/;
const decimal = v => typeof v === 'string' && /^[1-9][0-9]{0,23}$/.test(v);

export function orphanSwapDeclaration(parameters) {
  const backing = validateBackingStorage(parameters), q = parameters.windows.orphanSwapRetirement;
  assert.ok(q && q.schema === 'wsl-orphan-swap-retirement@1', 'explicit orphan-swap declaration required');
  assert.match(q.id, /^[a-z0-9][a-z0-9-]+$/);
  assert.match(q.ownerSid, /^S-1-5-21-\d+-\d+-\d+-\d+$/);
  assert.match(q.machineName, /^[A-Z0-9-]+$/);
  assert.equal(q.wslVersion, '3.0.3.0', 'unqualified swap lifecycle version');
  assert.match(q.currentVmId, guid); assert.match(q.currentFileIdentity, fileId);
  assert.ok(win32.isAbsolute(q.localAppDataWindowsPath) && !q.localAppDataWindowsPath.split('\\').includes('..'));
  assert.ok(typeof parameters.windows.profileWindowsPath === 'string' && win32.isAbsolute(parameters.windows.profileWindowsPath), 'native Windows profile required');
  assert.ok(Array.isArray(q.targets) && q.targets.length > 0, 'an explicit nonempty target set is required');
  for (const t of q.targets) {
    assert.deepEqual(Object.keys(t).sort(), ['vmId', 'fileIdentity', 'allocatedBytes', 'logicalBytes', 'attributes', 'parentFileIdentity', 'parentSddlSha256'].sort());
    assert.match(t.vmId, guid); assert.notEqual(t.vmId.toLowerCase(), q.currentVmId.toLowerCase(), 'cannot select current VM');
    assert.match(t.fileIdentity, fileId); assert.match(t.parentFileIdentity, fileId); assert.match(t.parentSddlSha256, /^[0-9a-f]{64}$/); assert.ok(decimal(t.allocatedBytes) && decimal(t.logicalBytes));
    assert.equal(t.attributes, 32, 'only received ordinary nonsparse swap files are selected');
  }
  assert.equal(new Set(q.targets.map(t => t.vmId.toLowerCase())).size, q.targets.length, 'duplicate VM target');
  assert.equal(new Set(q.targets.map(t => t.fileIdentity)).size, q.targets.length, 'duplicate file target');
  assert.ok(!q.targets.some(t => t.fileIdentity === q.currentFileIdentity), 'cannot select current file');
  const providers = parameters.windows.storageProviders;
  assert.equal(providers?.wslVersion, q.wslVersion);
  assert.ok(win32.isAbsolute(providers.wslExecutableWindowsPath));
  return { ...q, volumeId: backing.volumeId, profile: parameters.windows.profileWindowsPath, wslExecutable: providers.wslExecutableWindowsPath };
}

export function renderOrphanSwapRequest(parameterText, { action, nonce } = {}) {
  assert.ok(['observe', 'retire'].includes(action), 'explicit observe or retire action required');
  assert.match(nonce, /^[0-9a-f]{64}$/, 'exact request nonce required');
  const p = JSON.parse(parameterText), q = orphanSwapDeclaration(p);
  const template = readFileSync(new URL('../assets/retire-orphan-swap.ps1', import.meta.url), 'utf8');
  const expected = { ...q, action, nonce, parameterSha256: sha(parameterText) };
  const script = `$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n$expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify(expected)).toString('base64')}'))|ConvertFrom-Json\n` + template;
  // Standard Deflate prevents Windows' commandline ceiling; the decoded source
  // must match its reviewed byte length and digest before ScriptBlock execution.
  const packed = deflateRawSync(Buffer.from(script)).toString('base64');
  const launcher = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$m=[IO.MemoryStream]::new([Convert]::FromBase64String('${packed}'));$d=[IO.Compression.DeflateStream]::new($m,[IO.Compression.CompressionMode]::Decompress);$r=[IO.StreamReader]::new($d,[Text.Encoding]::UTF8);try{$s=$r.ReadToEnd()}finally{$r.Dispose();$d.Dispose();$m.Dispose()};$b=[Text.Encoding]::UTF8.GetBytes($s);$h=([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b))).Replace('-','').ToLowerInvariant();if($b.Length -ne ${Buffer.byteLength(script)} -or $h -cne '${sha(script)}'){throw 'Original source payload changed'};&([scriptblock]::Create($s))`;
  const encodedCommand = Buffer.from(launcher, 'utf16le').toString('base64');
  assert.ok(encodedCommand.length + 256 < 32767, 'native request exceeds Windows commandline');
  return { type: 'WslOrphanSwapNativeRequest', action, nonce, parameterSha256: sha(parameterText), templateSha256: sha(template), scriptSha256: sha(script), script,
    launcherSha256: sha(launcher), encodedCommand, targets: q.targets, currentVmId: q.currentVmId,
    resultWindowsPath: win32.join(q.localAppDataWindowsPath, 'temp', `561-wsl-orphan-swap-${nonce}.jsonl`), effectsExecuted: false };
}

/** The original command prepares against actual default native observations.
 * No injected ports/serialized positive flag can replace this current tuple.
 * The Windows request independently rechecks HCS and file handles at execution.
 */
export function prepareOrphanSwapRequest(parameterText, options) {
  const p=JSON.parse(parameterText), q=orphanSwapDeclaration(p);
  const point=observeStorageProviders(p), swap=point.providers.find(row=>row.id==='wsl-swap');
  assert.equal(point.vmId.toLowerCase(),q.currentVmId.toLowerCase(),'current native VM changed before launch');
  assert.equal(swap?.status,'received','current native swap unreceived before launch');
  assert.equal(swap.fileIdentity,q.currentFileIdentity,'current native swap identity changed before launch');
  return {...renderOrphanSwapRequest(parameterText,options),preLaunchObservation:{vmId:point.vmId,fileIdentity:swap.fileIdentity,allocatedBytes:swap.allocatedBytes,at:point.at,freshness:point.freshness}};
}

/** Receiving validates evidence only; it cannot issue an effect context or recovery credit. */
export function receiveOrphanSwapResult(request, raw) {
  const lines = raw.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(lines.length && lines.every(line => line.nonce === request.nonce && line.parameterSha256 === request.parameterSha256), 'foreign native result');
  const terminal = lines.at(-1);
  assert.equal(terminal.phase, 'terminal', 'native outcome is incomplete');
  assert.ok(['native-terminal-success','native-observed-without-disposition','refused-before-disposition','partial-or-unknown'].includes(terminal.status));
  if (terminal.status === 'native-terminal-success') {
    assert.equal(request.action, 'retire'); assert.equal(lines[0].phase, 'preflight');
    assert.equal(terminal.completedFiles, request.targets.length);
    const completed=lines.filter(x=>x.phase==='file-terminal'); assert.equal(completed.length,request.targets.length);
    assert.equal(new Set(completed.map(x=>x.vmId.toLowerCase())).size,request.targets.length);
    for(const target of request.targets){const row=completed.find(x=>x.vmId.toLowerCase()===target.vmId.toLowerCase());assert.ok(row);assert.equal(row.fileIdentity,target.fileIdentity);assert.equal(row.allocatedBytes,target.allocatedBytes);assert.equal(row.nativeAbsenceCode,2);}
  }
  // A parsed JSONL assertion is not a Windows launch/file-authenticity receipt.
  return { type: 'WslOrphanSwapOutcomeClaims', reportedStatus: terminal.status, lines, resultSha256: sha(raw), nativeEffectReceiving: 'requires-original-launch-and-output-file-binding', capacityReopened: false };
}
