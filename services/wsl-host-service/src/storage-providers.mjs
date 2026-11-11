// Read-only diagnostic points. This module grants no mutation/admission authority.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, basename, win32 } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { validateBackingStorage } from './backing-capacity.mjs';

const ids = ['wsl-swap', 'pagefiles', 'shadow-storage', 'shadow-copies', 'docker-data'];
const guid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,23})$/.test(value);
const bounded = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
const localArtifactPath = path => {
  if (!bounded(path)) return false;
  const extended = path.startsWith('\\\\?\\'), local = extended ? path.slice(4) : path;
  return (/^[A-Za-z]:\\/.test(local) || (extended && /^Volume\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}\\/i.test(local)))
    && !/[?*/]/.test(local) && !local.slice(2).includes(':') && !local.split('\\').includes('..');
};

export function validateStorageProviders(parameters) {
  const backing = validateBackingStorage(parameters), p = parameters.windows.storageProviders;
  assert.ok(p && typeof p === 'object' && !Array.isArray(p), 'windows.storageProviders declaration required');
  assert.deepEqual(Object.keys(p).sort(), ['rule', 'timeoutMs', 'wslExecutableWindowsPath', 'wslVersion', 'wslinfo', ...(p.swapFileTransition ? ['swapFileTransition'] : []), ...(p.dockerData ? ['dockerData'] : [])].sort(), 'unsupported storage-provider declaration');
  assert.equal(p.rule, 'wsl-3.0.3-user-temp-vm-id', 'unqualified WSL swap rule');
  assert.equal(p.wslVersion, '3.0.3.0', 'unqualified WSL version');
  assert.ok(bounded(p.wslinfo) && isAbsolute(p.wslinfo) && basename(p.wslinfo) === 'wslinfo', 'absolute native wslinfo required');
  assert.ok(bounded(p.wslExecutableWindowsPath) && win32.isAbsolute(p.wslExecutableWindowsPath) && win32.basename(p.wslExecutableWindowsPath).toLowerCase() === 'wsl.exe', 'absolute original WSL executable required');
  assert.ok(bounded(parameters.windows.profileWindowsPath) && win32.isAbsolute(parameters.windows.profileWindowsPath), 'original Windows profile required');
  assert.ok(Number.isSafeInteger(p.timeoutMs) && p.timeoutMs >= 1000 && p.timeoutMs <= 15000, 'invalid provider observation deadline');
  if (p.swapFileTransition) {
    const t=p.swapFileTransition;
    assert.deepEqual(Object.keys(t).sort(), ['fromVmId','fromFileIdentity','toWindowsPath'].sort(), 'unsupported swap activation transition');
    assert.match(t.fromVmId,guid); assert.match(t.fromFileIdentity,/^[a-f0-9]{8}:[a-f0-9]{16}$/);
    assert.ok(bounded(t.toWindowsPath) && /^[A-Za-z]:\\/.test(t.toWindowsPath) && !/[?*]/.test(t.toWindowsPath) && !t.toWindowsPath.split('\\').includes('..') && win32.extname(t.toWindowsPath).toLowerCase()==='.vhdx', 'exact stable swap path required');
  }
  if (p.dockerData) {
    const d = p.dockerData;
    assert.deepEqual(Object.keys(d).sort(), ['artifacts', 'rule'], 'unsupported Docker artifact declaration');
    assert.equal(d.rule, 'declared-native-docker-artifacts-v1', 'unsupported Docker artifact rule');
    assert.ok(Array.isArray(d.artifacts) && d.artifacts.length > 0, 'selected Docker artifacts required');
    const names = new Set(), paths = new Set();
    for (const a of d.artifacts) {
      assert.deepEqual(Object.keys(a).sort(), ['name', 'path', 'volumeId'], 'unsupported Docker artifact fields');
      assert.ok(bounded(a.name) && localArtifactPath(a.path), 'exact native Docker artifact name/path required');
      assert.match(a.volumeId, /^\\\\\?\\Volume\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}\\$/i, 'native Docker artifact volume required');
      assert.ok(!names.has(a.name) && !paths.has(a.path.toLowerCase()), 'duplicate Docker artifact selection');
      names.add(a.name); paths.add(a.path.toLowerCase());
    }
  }
  return { ...p, backing, profile: parameters.windows.profileWindowsPath };
}

export function observeStorageProviders(parameters, ports = {}) {
  const p = validateStorageProviders(parameters), clock = ports.monotonic ?? (() => performance.now());
  const start = clock(), nonce = (ports.nonce ?? (() => randomBytes(32).toString('hex')))();
  assert.ok(Number.isFinite(start)); assert.match(nonce, /^[0-9a-f]{64}$/);
  const run = ports.run ?? ((program, args, timeout) => execFileSync(program, args, { encoding: 'utf8', cwd: '/', timeout, maxBuffer: 65536, windowsHide: true }));
  const invoke = (program, args) => {
    const left = p.timeoutMs - (clock() - start);
    assert.ok(Number.isFinite(left) && left > 0 && left <= p.timeoutMs, 'storage-provider observation deadline expired');
    try { return run(program, args, Math.max(1, Math.floor(left))); }
    catch (cause) { throw new Error(`native storage provider ${basename(program)} failed (${cause.code ?? cause.status ?? 'unknown'}): ${String(cause.stderr ?? cause.message).slice(0, 2048)}`, { cause }); }
  };
  assert.equal(invoke(p.wslinfo, ['--version']).trim(), p.wslVersion, 'native WSL version changed');
  const vmId = invoke(p.wslinfo, ['--vm-id']).trim(); assert.match(vmId, guid, 'native WSL VM ID unknown');
  // Reuse the original qualified handle receiver, not a second allocation implementation.
  const capacityAsset = readFileSync(new URL('../assets/observe-backing-capacity.ps1', import.meta.url), 'utf8');
  const helper = /Add-Type -TypeDefinition @'\n[\s\S]+?\n'@/.exec(capacityAsset)?.[0];
  assert.ok(helper, 'original allocation helper unavailable');
  const { registryKey, distributionName, basePath, vhdFileName, volumeId } = p.backing;
  const expected = Buffer.from(JSON.stringify({ requestNonce: nonce, vmId, swapFileTransition:p.swapFileTransition, dockerData:p.dockerData, profile: p.profile, wslExecutableWindowsPath: p.wslExecutableWindowsPath, wslVersion: p.wslVersion, backing: { registryKey, distributionName, basePath, vhdFileName, volumeId } })).toString('base64');
  const script = `$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n$expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${expected}'))|ConvertFrom-Json\n${helper}\n` + readFileSync(new URL('../assets/observe-storage-providers.ps1', import.meta.url), 'utf8');
  // The original read-only payload can exceed Windows'32K argv ceiling.
  // Standard Deflate is transport only: execute the exact decoded source hash.
  const packed=deflateRawSync(Buffer.from(script)).toString('base64'),digest=createHash('sha256').update(script).digest('hex');
  const launcher=`$ErrorActionPreference='Stop';$m=[IO.MemoryStream]::new([Convert]::FromBase64String('${packed}'));$d=[IO.Compression.DeflateStream]::new($m,[IO.Compression.CompressionMode]::Decompress);$r=[IO.StreamReader]::new($d,[Text.Encoding]::UTF8);try{$s=$r.ReadToEnd()}finally{$r.Dispose();$d.Dispose();$m.Dispose()};$b=[Text.Encoding]::UTF8.GetBytes($s);$h=([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b))).Replace('-','').ToLowerInvariant();if($b.Length -ne ${Buffer.byteLength(script)} -or $h -cne '${digest}'){throw 'Original provider source payload changed'};&([scriptblock]::Create($s))`;
  const encoded = Buffer.from(launcher, 'utf16le').toString('base64');
  assert.ok(encoded.length + p.backing.powershell.length + 128 < 32767, 'provider command exceeds native Windows argument capacity');
  const result = JSON.parse(invoke(p.backing.powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]).replace(/^\uFEFF/, ''));
  assert.equal(result.requestNonce, nonce, 'provider point belongs to another request');
  assert.equal(result.vmId, vmId); assert.equal(result.wslVersion, p.wslVersion);
  assert.equal(invoke(p.wslinfo, ['--vm-id']).trim(), vmId, 'WSL VM changed during provider receiving');
  assert.ok(Number.isFinite(Date.parse(result.at)), 'provider time unknown');
  assert.deepEqual(result.providers?.map(x => x.id), ids, 'incomplete provider point');
  for (const row of result.providers) {
    assert.ok(['received', 'unknown'].includes(row.status), 'invalid provider status');
    assert.ok(bounded(row.source), 'provider source unknown');
    if (row.id === 'docker-data' && !p.dockerData) assert.equal(row.status, 'unknown', 'undeclared Docker location cannot produce received data');
    if (row.status === 'unknown') { assert.ok(bounded(row.error?.message), 'unknown provider error missing'); if(row.error.code !== undefined) assert.ok(bounded(row.error.code), 'provider error code unbounded'); continue; }
    if (row.id === 'docker-data') {
      assert.equal(row.scope, 'selected-declared-artifacts-only', 'Docker allocation scope must be explicit');
      assert.ok(Array.isArray(row.items), 'Docker artifact observations required');
      assert.equal(row.items.length, p.dockerData.artifacts.length, 'incomplete Docker artifact observations');
      const received = new Set();
      row.items.forEach((item, index) => {
        const selected = p.dockerData.artifacts[index];
        assert.equal(item.name, selected.name); assert.equal(item.path, selected.path);
        assert.equal(item.volumeId?.toLowerCase(), selected.volumeId.toLowerCase(), 'Docker artifact volume changed');
        assert.match(item.fileIdentity ?? '', /^[a-f0-9]{8}:[a-f0-9]{16}$/);
        assert.ok(decimal(item.allocatedBytes) && decimal(item.logicalBytes), 'native Docker artifact allocation required');
        assert.ok(Number.isSafeInteger(item.attributes) && item.attributes >= 0 && item.attributes <= 0xffffffff && (item.attributes & (16 | 1024)) === 0, 'Docker artifact redirected or not a regular file');
        const id = item.volumeId.toLowerCase() + '/' + item.fileIdentity;
        assert.ok(!received.has(id), 'Docker artifacts alias the same native file'); received.add(id);
      });
      continue;
    }
    if (row.id === 'wsl-swap') {
      assert.ok(bounded(row.path) && win32.isAbsolute(row.path));
      assert.ok(decimal(row.allocatedBytes) && decimal(row.logicalBytes));
      assert.match(row.fileIdentity, /^[a-f0-9]{8}:[a-f0-9]{16}$/);
      assert.ok(bounded(row.volumeId));
      assert.equal(row.volumeId.toLowerCase(), p.backing.volumeId.toLowerCase(), 'swap uses another backing volume');
      if(p.swapFileTransition){
        assert.equal(row.configuredPath?.toLowerCase(),p.swapFileTransition.toWindowsPath.toLowerCase(),'configured swap activation target changed');
        assert.ok(['configuration-staged','pending-next-VM','configured-new-VM'].includes(row.activation), 'swap activation unreceived');
        if(vmId.toLowerCase()===p.swapFileTransition.fromVmId.toLowerCase()){
          assert.equal(row.fileIdentity,p.swapFileTransition.fromFileIdentity,'original live swap changed while activation pending');
          assert.ok(['configuration-staged','pending-next-VM'].includes(row.activation));
        }else{
          assert.equal(row.activation,'configured-new-VM'); assert.equal(row.path.toLowerCase(),p.swapFileTransition.toWindowsPath.toLowerCase());
        }
      }
    } else {
      assert.ok(Array.isArray(row.items) && row.items.length <= 64, 'provider items unbounded');
      for (const item of row.items) {
        if (row.id === 'pagefiles') {
          assert.ok(bounded(item.path) && win32.isAbsolute(item.path), 'pagefile path unknown');
          for (const key of ['allocatedMiB', 'currentUsageMiB', 'peakUsageMiB']) assert.ok(decimal(item[key]), 'pagefile native MiB unknown');
        } else if (row.id === 'shadow-storage') {
          assert.ok([item.volume, item.diffVolume].some(x => typeof x === 'string' && x.toLowerCase() === p.backing.volumeId.toLowerCase()), 'shadow storage target changed');
          for (const key of ['usedBytes', 'allocatedBytes', 'maxBytes']) assert.ok(decimal(item[key]), 'shadow storage native bytes unknown');
        } else if (row.id === 'shadow-copies') {
          assert.equal(item.volume?.toLowerCase(), p.backing.volumeId.toLowerCase(), 'shadow copy target changed');
          assert.ok(bounded(item.id), 'shadow copy identity unknown');
        } else assert.fail('undeclared Docker location cannot produce received data');
      }
    }
  }
  const elapsedMs = clock() - start;
  assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= p.timeoutMs, 'storage-provider observation stale');
  return { ...result, type: 'WslStorageProviderPoints', version: 1, freshness: { elapsedMs }, physicalCapacityCreditBytes: '0', historicalAttribution: 'unreceived' };
}

export function storageProviderChecks(result) {
  return result.providers.map(row => ({ name: `Windows storage provider ${row.id}`, ok: row.status === 'received', want: 'native point; zero capacity credit',
    have: row.status === 'unknown' ? `unknown: ${row.error.message}${row.error.code ? ` (${row.error.code})` : ''}; at ${result.at}` : row.id === 'wsl-swap' ? `${row.allocatedBytes} allocated bytes; ${row.fileIdentity}; ${row.path}${row.activation ? '; '+row.activation+(row.configuredPath ? '; configured '+row.configuredPath : '') : ''}; at ${result.at}` : `${row.items.length} ${row.id === 'docker-data' ? 'selected declared artifact(s); scope=selected-declared-artifacts-only; ' : 'native item(s); '}${JSON.stringify(row.items)}; at ${result.at}` }));
}

export function planStorageProviders(parameters, ports) {
  try { const point = observeStorageProviders(parameters, ports); return { component: 'storage-providers', current: point.providers.every(x => x.status === 'received'), point, checks: storageProviderChecks(point) }; }
  catch (error) { return { component: 'storage-providers', current: false, checks: [{ name: 'Windows storage providers', ok: false, want: 'fresh selected native provider points', have: `unknown: ${error.message}` }] }; }
}
