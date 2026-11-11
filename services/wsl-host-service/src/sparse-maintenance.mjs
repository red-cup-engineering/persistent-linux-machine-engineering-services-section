// Explicit Windows continuation for the owner's rendered sparse-disk operation.
// The existing host declaration selects the distribution, disk and unsafe policy.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { renderSparseMaintenanceScript, sparseDisk } from './sparse-disk.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const asset = name => readFileSync(new URL(`../assets/${name}`, import.meta.url), 'utf8');

export function sparseMaintenanceInput(parameterText, action, { priorRequest } = {}) {
  assert.ok(typeof parameterText === 'string' && Buffer.byteLength(parameterText) <= 131072, 'bounded host parameter record required');
  assert.ok(['launch', 'status', 'receive-interruption'].includes(action), 'explicit maintenance operation required');
  if (action === 'receive-interruption') assert.match(priorRequest ?? '', /^[a-f0-9]{64}$/, 'exact interrupted request required');
  else assert.equal(priorRequest, undefined, 'prior request belongs only to interruption receiving');
  const parameters = JSON.parse(parameterText), declaration = sparseDisk(parameters);
  assert.ok(declaration, 'host does not declare sparse-disk maintenance');
  assert.match(parameters.windows.profileWindowsPath ?? '', /^[A-Za-z]:\\[A-Za-z0-9 ._{}()@+\\-]+$/);
  const maintenance = renderSparseMaintenanceScript(parameters);
  const runner = asset('sparse-maintenance-process.ps1') + '\n' + asset('run-sparse-maintenance.ps1');
  const request = sha256(parameterText + '\0' + maintenance + '\0' + runner);
  return { action, request, ...(priorRequest ? { priorRequest } : {}), profile: parameters.windows.profileWindowsPath, distribution: declaration.target.distributionName,
    parameterSha256: sha256(parameterText), maintenanceSha256: sha256(maintenance), runnerSha256: sha256(runner),
    parameterBase64: Buffer.from(parameterText).toString('base64'), maintenanceBase64: Buffer.from(maintenance).toString('base64'),
    runnerBase64: Buffer.from(runner).toString('base64') };
}

export function operateSparseMaintenance(parameterText, action, { run = execFileSync, priorRequest } = {}) {
  const input = sparseMaintenanceInput(parameterText, action, { priorRequest }), parameters = JSON.parse(parameterText);
  const source = "$inputPacket=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + Buffer.from(JSON.stringify(input)).toString('base64') + "'))|ConvertFrom-Json\n" + asset('sparse-maintenance-process.ps1') + '\n' + asset('sparse-maintenance-caller.ps1');
  // The same finite interop loader used by the original maintenance caller;
  // the actual maintenance runs in its own Windows parent, without these pipes.
  const loader = "$ErrorActionPreference='Stop';$s=[Text.UTF8Encoding]::new($false,$true).GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));Invoke-Expression $s";
  const output = run(parameters.windows.backingStorage.powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(loader, 'utf16le').toString('base64')],
    { input: Buffer.from(source).toString('base64'), cwd: '/', encoding: 'utf8', timeout: 30000, maxBuffer: 131072 });
  return JSON.parse(output);
}

