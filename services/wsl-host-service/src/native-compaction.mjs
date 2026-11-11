// Source-only recovery of the received WSL 3.0.3 maintenance parent. No launcher.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { validateBackingStorage } from './backing-capacity.mjs';

export const nativeCompactionQualification = Object.freeze({
  adapter: 'microsoft-wsl-3.0.3-native-exclusive-compaction', version: '3.0.3.0',
  executable: 'C:\\Program Files\\WSL\\wsl.exe',
  executableSha256: 'a452a35073c296230402af36e54dad1f408fa52b6ebd3cf9ba30bce8f9025621',
  service: 'C:\\Program Files\\WSL\\wslservice.exe',
  serviceSha256: '262951e58df4bc82b63a79cbc64439c7d3ad7baa4344834442a5a82b2f9dd293',
  sourceBlobs: Object.freeze(['934a09bf49e70e8f5ac067584b0bedafa03c266f', '9ea6a26a28e4ba114d817edfad6cbc67684aabea', '39c10fef6bb995c065c4c898c5e047c1c7e16702', '48b5c4fe89337f2b30897e8cdee52f865f6f354d'])
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const windowsPath = value => typeof value === 'string' && value.length <= 1024 && /^[A-Za-z]:\\[A-Za-z0-9 ._{}()@+\\-]+$/.test(value) && !value.split('\\').some(p => p === '..' || p === '.' || /[. ]$/.test(p)) && win32.normalize(value) === value;
const boundedJson = (text, label) => {
  assert.equal(typeof text, 'string', label + ' must be exact original UTF-8 text');
  assert.ok(Buffer.byteLength(text) <= 131072, label + ' exceeds evidence allocation');
  const value = JSON.parse(text); assert.ok(value && typeof value === 'object' && !Array.isArray(value), label + ' must be an object'); return value;
};
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,23})$/.test(value);
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/** Render only. The original holder/receiver must receive the referenced
 * authority, checkpoint and caller review; hashes do not confer that authority.
 * No historical receipt is a current machine checkpoint. */
export function renderNativeCompaction(parameterText, admissionText) {
  const parameters = boundedJson(parameterText, 'parameter record');
  const target = validateBackingStorage(parameters), declaration = parameters.windows.nativeCompaction;
  assert.ok(windowsPath(target.basePath), 'canonical selected Windows VHD base path required');
  assert.ok(declaration, 'no explicitly declared native maintenance adapter');
  assert.equal(declaration.adapter, nativeCompactionQualification.adapter, 'unqualified maintenance adapter');
  assert.match(declaration.ownerSid ?? '', /^S-1-5-21-\d+-\d+-\d+-\d+$/, 'actual Windows owner SID required');
  assert.ok(windowsPath(declaration.custodyDirectory), 'canonical pre-existing Windows custody directory required');
  assert.ok(Number.isSafeInteger(declaration.deadlineMs) && declaration.deadlineMs >= 1000 && declaration.deadlineMs <= 3600000, 'finite native operation deadline required');
  assert.ok(Number.isSafeInteger(declaration.maxOutputBytes) && declaration.maxOutputBytes >= 1024 && declaration.maxOutputBytes <= 131072, 'bounded native evidence allocation required');
  // WSL-43/44: the original host record owns this reserve. A historical
  // housekeeping threshold must not replace the selected fabrication policy.
  assert.ok(BigInt(target.policy.minFreeBytes) > 0n, 'explicit positive physical reserve required');
  const admission = boundedJson(admissionText, 'maintenance admission');
  assert.equal(admission.type, 'WslNativeCompactionAdmission'); assert.equal(admission.version, 1);
  assert.match(admission.request ?? '', /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, 'original request UUID required');
  assert.equal(admission.parameterSha256, hash(parameterText), 'changed original parameter record');
  assert.ok(instant(admission.notBefore) && instant(admission.expiresAt), 'exact UTC millisecond admission interval required');
  const interval = Date.parse(admission.expiresAt) - Date.parse(admission.notBefore);
  assert.ok(interval > 0 && interval <= 600000, 'admission must have a bounded fresh checkpoint interval');
  assert.ok(decimal(admission.concurrentPeakBytes), 'explicit concurrent peak allocation required');
  assert.ok(Array.isArray(admission.resources) && admission.resources.length === 3, 'original authority, checkpoint and independent receiving Resources required');
  assert.deepEqual(admission.resources.map(r => r.role).sort(), ['authority', 'checkpoint', 'independent-receiving']);
  const root = declaration.custodyDirectory.toLowerCase() + '\\';
  for (const resource of admission.resources) {
    assert.ok(windowsPath(resource.path) && resource.path.toLowerCase().startsWith(root) && digest(resource.sha256), 'Resource must bind exact existing owner custody bytes');
  }
  assert.equal(new Set(admission.resources.map(r => r.path.toLowerCase())).size, 3, 'distinct original Resources required');
  const backingSource = readFileSync(new URL('../assets/observe-backing-capacity.ps1', import.meta.url), 'utf8');
  const packet = {
    type: 'WslNativeCompactionPacket', version: 1, target,
    declaration, qualification: nativeCompactionQualification,
    parameterText, parameterSha256: hash(parameterText), admissionSha256: hash(admissionText),
    backingObservation: { source: backingSource, sourceSha256: hash(backingSource) },
    // Preserve exact admitted text as well as its digest in Windows custody.
    admissionText, admission,
    invocation: { executable: nativeCompactionQualification.executable, arguments: '--manage ' + target.distributionName + ' --compact' }
  };
  const packetText = JSON.stringify(packet);
  const script = "$ProgressPreference='SilentlyContinue'\n$ErrorActionPreference='Stop'\n$packetText=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + Buffer.from(packetText).toString('base64') + "'))\n$packet=$packetText|ConvertFrom-Json\n" + readFileSync(new URL('../assets/receive-backing-target.ps1', import.meta.url), 'utf8') + '\n' + readFileSync(new URL('../assets/native-compaction-outcome.ps1', import.meta.url), 'utf8') + '\n' + readFileSync(new URL('../assets/native-compact.ps1', import.meta.url), 'utf8');
  return { type: 'WslNativeCompactionRendering', status: 'requires-original-holder-and-independent-receiving',
    request: admission.request, parameterSha256: packet.parameterSha256, admissionSha256: packet.admissionSha256,
    scriptSha256: hash(script), script, packetText, effectsExecuted: false, capacityReopened: false };
}
