// Host storage sparse configuration (Group rule host-storage-reclaims-itself, Leader 2026-10-25): the record
// declares the backing VHDX sparse. This module renders the owner-run Windows script that marks it sparse,
// and the plan checks that make drift visible. It renders and reads only; it never starts a Windows program.
import assert from 'node:assert/strict';
import { statfsSync } from 'node:fs';
import { validateBackingStorage } from './backing-capacity.mjs';

const WSL_EXECUTABLE = /^(?:[A-Za-z0-9._-]+\.exe|[A-Za-z]:\\[A-Za-z0-9 ._()\\-]+\.exe)$/;
const RELAUNCHER = /^[A-Za-z0-9 ._()-]+\.exe$/;
const ascii = (v, name) => { assert.ok(typeof v === 'string' && /^[\x20-\x7e]+$/.test(v), `${name} must be printable ASCII (Windows PowerShell 5.1 reads an unmarked script as ANSI)`); return v; };
const psq = (v) => `'${v.replaceAll("'", "''")}'`;
const ps = (b) => (b ? '$true' : '$false');
const GiB = (n) => (Number(n) / 2 ** 30).toFixed(1);

/** The record's sparse declaration joined to its validated backing target; null when undeclared. */
export function sparseDisk(parameters) {
  const declared = parameters?.windows?.backingStorage?.sparse;
  if (declared === undefined) return null;
  const target = validateBackingStorage(parameters);
  assert.ok(declared && typeof declared === 'object' && !Array.isArray(declared), 'windows.backingStorage.sparse must be an object');
  assert.equal(declared.want, true, 'windows.backingStorage.sparse.want must be true: the only declared state is a sparse disk');
  assert.ok(typeof declared.wslExecutable === 'string' && WSL_EXECUTABLE.test(declared.wslExecutable) && !declared.wslExecutable.split('\\').includes('..'), 'windows.backingStorage.sparse.wslExecutable must be an .exe name or absolute Windows path');
  for (const k of ['allowUnsafe', 'compactWhenBelowFloor']) assert.equal(typeof declared[k], 'boolean', `windows.backingStorage.sparse.${k} must be a boolean`);
  assert.equal(declared.compactWhenBelowFloor, false, 'windows.backingStorage.sparse.compactWhenBelowFloor must be false');
  assert.match(String(declared.maxSlackBytes), /^[1-9][0-9]{0,23}$/, 'windows.backingStorage.sparse.maxSlackBytes must be a positive decimal string');
  assert.ok(typeof declared.basis === 'string' && declared.basis.length > 0, 'windows.backingStorage.sparse.basis must state the evidence');
  // What starts the distribution again from Windows (an app that runs wsl.exe and restarts it when it
  // exits). Conversion needs the distribution stopped; any of these running wins that race.
  assert.ok(Array.isArray(declared.relaunchers) && declared.relaunchers.every((name) => typeof name === 'string' && RELAUNCHER.test(name)),
    'windows.backingStorage.sparse.relaunchers must list Windows executable names (e.g. "ChatGPT.exe")');
  assert.ok(Number.isSafeInteger(declared.conversionAttempts) && declared.conversionAttempts >= 1 && declared.conversionAttempts <= 10,
    'windows.backingStorage.sparse.conversionAttempts must be an integer from 1 to 10');
  assert.equal(typeof declared.trimAfterConversion, 'boolean', 'windows.backingStorage.sparse.trimAfterConversion must be a boolean');
  for (const k of ['distributionName', 'registryKey', 'basePath', 'vhdFileName']) ascii(target[k], `windows.backingStorage.${k}`);
  return { ...declared, target };
}

/**
 * The script the host owner runs once from Windows (no elevation). It verifies the registered
 * distribution, its GUID and its VHDX exactly as the owner's desktop script did, makes the VHDX sparse
 * through WSL's native `--manage --set-sparse true`. Sparse conversion
 * requires the distribution to be stopped, so the script first awaits native `--terminate` for the
 * verified distribution and receives its result. Null when the record declares no sparse disk.
 */
export function renderSparseMaintenanceScript(parameters) {
  const d = sparseDisk(parameters);
  if (!d) return null;
  const t = d.target, floorPercent = String(t.policy.minFreePercent), floorBytes = t.policy.minFreeBytes;
  return String.raw`# Rendered by wsl-host-service from the host record. Change the record, not this file.
#
# THIS SCRIPT STOPS THE SELECTED WSL DISTRIBUTION. While it works, ${t.distributionName} is terminated: every Linux
# process in it, every SSH session into it and every agent running in it stops. The script starts it again at the end.
# No elevation is needed.
#
# Why: the backing VHDX is declared sparse (Group rule host-storage-reclaims-itself).
#
# It does, once, after verifying the registered distribution and its VHDX:
#   1. refuses while a declared relauncher (${d.relaunchers.join(', ') || 'none declared'}) runs: it would start ${t.distributionName} again
#   2. wsl --terminate ${t.distributionName}, and wsl --shutdown when the VHDX stays attached
#   3. wsl --manage ${t.distributionName} --set-sparse true      (only if the VHDX is not already sparse)
#      steps 2-3 repeat up to ${d.conversionAttempts} times when something starts ${t.distributionName} between them
#   4. starts ${t.distributionName} again${d.trimAfterConversion ? ' and runs fstrim on / as root, so freed blocks return to Windows now' : ''}
# With -PlanOnly it reports whether a run could succeed now (exit 3 when not) and changes nothing.
param([switch]$PlanOnly, [string]$ResultPath)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$distro = ${psq(t.distributionName)}
$base = ${psq(t.registryKey)}
$expectedVhd = ${psq(`${t.basePath}\\${t.vhdFileName}`)}
$wsl = ${psq(d.wslExecutable)}
$minFreeBytes = [double]${floorBytes}
$minFreePercent = [double]${floorPercent}
$allowUnsafe = ${ps(d.allowUnsafe)}
$relaunchers = @(${d.relaunchers.map(psq).join(', ')})
$conversionAttempts = ${d.conversionAttempts}
$trimAfterConversion = ${ps(d.trimAfterConversion)}

if (-not (Test-Path -LiteralPath $base)) { throw "The verified $distro registration was not found: $base" }
$registered = Get-ItemProperty -LiteralPath $base
if ($registered.DistributionName -cne $distro) { throw "Expected the verified distro to be $distro, found: $($registered.DistributionName)" }
$vhd = Join-Path $registered.BasePath ${psq(t.vhdFileName)}
$vhd = $vhd -replace '^\\\\\?\\', ''
if ($vhd -ine $expectedVhd) { throw "Unexpected VHDX path: $vhd" }
if (-not (Test-Path -LiteralPath $vhd -PathType Leaf)) { throw "Verified VHDX not found: $vhd" }
if (-not (Get-Command $wsl -ErrorAction SilentlyContinue)) { throw "WSL executable not found: $wsl" }

$root = [IO.Path]::GetPathRoot($vhd)
$floor = [Math]::Max($minFreeBytes, [Math]::Ceiling([double][IO.DriveInfo]::new($root).TotalSize * $minFreePercent / 100))
$freeBefore = [IO.DriveInfo]::new($root).AvailableFreeSpace
$isSparse = [bool]((Get-Item -LiteralPath $vhd -Force).Attributes -band [IO.FileAttributes]::SparseFile)
$needSparse = -not $isSparse

Add-Type -Namespace WslHost -Name Allocation -MemberDefinition @'
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern uint GetCompressedFileSizeW(string path, out uint high);
'@
# Bytes the VHDX actually occupies on the Windows volume (a sparse file's unallocated ranges excluded).
function Get-AllocatedBytes([string]$path) {
  $high = [uint32]0
  $low = [WslHost.Allocation]::GetCompressedFileSizeW($path, [ref]$high)
  if ($low -eq [uint32]::MaxValue -and [Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 0) { return $null }
  return ([uint64]$high -shl 32) + [uint64]$low
}
# Declared relaunchers running now.
function Get-RunningRelaunchers {
  @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $relaunchers -icontains ($_.ProcessName + '.exe') } |
    ForEach-Object { '{0}.exe (pid {1})' -f $_.ProcessName, $_.Id } | Sort-Object -Unique)
}
# Every wsl.exe client other than this script's, named by the program that started it.
function Get-WslClients {
  $all = @(Get-CimInstance Win32_Process)
  $byId = @{}; foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
  @($all | Where-Object { $_.Name -ieq 'wsl.exe' -and [int]$_.ParentProcessId -ne $PID } | ForEach-Object {
    $owner = $byId[[int]$_.ParentProcessId]
    while ($owner -and $owner.Name -ieq 'wsl.exe') { $owner = $byId[[int]$owner.ParentProcessId] }
    'wsl.exe (pid {0}) started by {1}' -f $_.ProcessId, $(if ($owner) { '{0} (pid {1})' -f $owner.Name, $owner.ProcessId } else { 'an exited process' })
  })
}
$allocatedBefore = Get-AllocatedBytes $vhd
$runningRelaunchers = @(Get-RunningRelaunchers)
$wslClients = @(Get-WslClients)

Write-Host "Verified distro: $distro"
Write-Host "Verified VHDX:   $vhd"
Write-Host ('VHDX sparse: {0}' -f $isSparse)
Write-Host ('{0} free: {1:N1} GiB; the record''s physical floor is {2:N1} GiB' -f $root, ($freeBefore / 1GB), ($floor / 1GB))
if ($null -ne $allocatedBefore) { Write-Host ('VHDX occupies {0:N1} GiB on {1}' -f ($allocatedBefore / 1GB), $root) }

if (-not $needSparse) {
  Write-Host 'Nothing to do: the VHDX is already sparse. WSL was not touched.'
  if ($ResultPath -and -not $PlanOnly) {
    $at=[DateTime]::UtcNow.ToString('o')
    $result=[ordered]@{distribution=$distro;vhd=$vhd;pid=$PID;state='current';startedAt=$at;completedAt=$at;
      sparseBefore=$isSparse;sparseAfter=$isSparse;freeBeforeBytes=[string]$freeBefore;freeAfterBytes=[string]$freeBefore;floorBytes=[string]$floor;
      stopAttempted=$false;stopExitCode=$null;stopError=$null;
      runningBeforeVmShutdown=@();vmShutdownAttempted=$false;vmShutdownExitCode=$null;vmShutdownError=$null;
      sparseAttempted=$false;sparseExitCode=$null;sparseError=$null;compactionAttempted=$false;compactionExitCode=$null;compactionError=$null;
      restartAttempted=$false;restartExitCode=$null;restartError=$null}
    [IO.File]::WriteAllText($ResultPath,($result|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
  }
  return
}
foreach ($c in $wslClients) { Write-Host "WSL client now: $c" }
if ($runningRelaunchers.Count -gt 0) {
  Write-Host ('NOT READY: close these first; each starts {0} again as soon as it stops: {1}' -f $distro, ($runningRelaunchers -join ', ')) -ForegroundColor Yellow
}
Write-Host "WILL RUN: $wsl --terminate $distro (and --shutdown if its VHDX stays attached)"
if ($needSparse) { Write-Host "WILL RUN: $wsl --manage $distro --set-sparse true (up to $conversionAttempts attempts)" }
if ($trimAfterConversion) { Write-Host "WILL RUN: $wsl -d $distro -u root --exec /usr/sbin/fstrim -v /" }
if ($PlanOnly) {
  if ($runningRelaunchers.Count -gt 0) { Write-Host 'PlanOnly: not ready; nothing was changed.'; exit 3 }
  Write-Host 'PlanOnly: ready; nothing was changed.'; return
}
if ($runningRelaunchers.Count -gt 0) {
  throw ('Refusing to stop {0}: {1} would start it again before conversion. Close them and run this again.' -f $distro, ($runningRelaunchers -join ', '))
}

Write-Host ''
Write-Host '*** THIS STOPS THE SELECTED WSL DISTRIBUTION. ***' -ForegroundColor Yellow
Write-Host "The $distro distribution is terminated now: every Linux process in it, every SSH session and every agent running there stops until this script starts it again."
Write-Host 'Press Ctrl+C within 10 seconds to cancel.'
Start-Sleep -Seconds 10

function Invoke-Wsl {
  param([string[]]$Arguments)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $wsl @Arguments 2>&1
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previous }
  $text = (@($output | ForEach-Object { $_.ToString().Replace([string][char]0, '') }) -join [Environment]::NewLine)
  if ($text) { Write-Host $text }
  if ($code -ne 0) {
    $error=[InvalidOperationException]::new("wsl $($Arguments -join ' ') failed (exit code $code).")
    $error.Data['ExitCode']=$code
    $error.Data['Output']=$text
    throw $error
  }
  return $code
}

function Get-RunningDistributions {
  $previous=$ErrorActionPreference
  $ErrorActionPreference='Continue'
  try { $output=& $wsl --list --running --quiet 2>&1; $code=$LASTEXITCODE }
  finally { $ErrorActionPreference=$previous }
  if($code -ne 0){throw "Native running-distribution query failed (exit code $code)."}
  return @($output | ForEach-Object { $_.ToString().Replace([string][char]0,'') -split '\r?\n' } | Where-Object { $_.Length -gt 0 })
}

function Wait-VhdRelease {
  $deadline=[DateTime]::UtcNow.AddSeconds(30)
  while($true) {
    try { $disk=[IO.File]::Open($vhd,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None);$disk.Dispose();return $true }
    catch [IO.IOException] {
      if(($_.Exception.GetBaseException().HResult -band 0xffff) -notin @(32,33)){throw}
      if([DateTime]::UtcNow -ge $deadline){return $false}
      Start-Sleep -Milliseconds 500
    }
  }
}

$result = [ordered]@{ distribution=$distro; vhd=$vhd; pid=$PID; startedAt=[DateTime]::UtcNow.ToString('o');
  sparseBefore=$isSparse; freeBeforeBytes=[string]$freeBefore; floorBytes=[string]$floor;
  allocatedBeforeBytes=[string]$allocatedBefore; wslClientsBefore=$wslClients; attempts=@();
  trimAttempted=$false; trimExitCode=$null; trimError=$null; allocatedAfterBytes=$null;
  stopAttempted=$false; stopExitCode=$null; stopError=$null;
  runningBeforeVmShutdown=@(); vmShutdownAttempted=$false; vmShutdownExitCode=$null; vmShutdownError=$null;
  sparseAttempted=$false; sparseExitCode=$null; sparseError=$null;
  compactionAttempted=$false; compactionExitCode=$null; compactionError=$null; restartAttempted=$false; restartExitCode=$null; restartError=$null }
$sparseFailure = $null
$restartFailure = $null
$maintenanceFailure = $null
function Save-MaintenanceResult([string]$phase) {
  $result.phase=$phase
  if(-not $ResultPath){return}
  $temporary=$ResultPath+'.tmp'
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($result|ConvertTo-Json -Compress))
  $file=[IO.File]::Open($temporary,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try{$file.Write($bytes,0,$bytes.Length);$file.Flush($true)}finally{$file.Dispose()}
  if(Test-Path -LiteralPath $ResultPath){[IO.File]::Replace($temporary,$ResultPath,[Management.Automation.Language.NullString]::Value)}
  else{[IO.File]::Move($temporary,$ResultPath)}
}
try {
# SetSparse requires a stopped distribution; it does not acquire the compaction
# conversion lock or stop a running instance. Stop only the verified target and
# refuse the offline operations if that native transition fails.
# Stop the verified target (and the utility VM when its VHDX stays attached), then convert at once.
# Something on Windows may start the distribution between the two; then record what did and repeat.
function Stop-Target {
  $result.stopAttempted = $true
  Save-MaintenanceResult 'before-stop'
  try { $result.stopExitCode = Invoke-Wsl @('--terminate', $distro) }
  catch { $result.stopExitCode=$_.Exception.Data['ExitCode']; $result.stopError=$_.Exception.Message; throw }
  Save-MaintenanceResult 'after-stop'
  if(-not (Wait-VhdRelease)) {
    # A stopped distribution can leave its VHD attached to the utility VM.
    # Close that VM only when no other registered distribution is running.
    $result.runningBeforeVmShutdown=@(Get-RunningDistributions)
    Save-MaintenanceResult 'vm-shutdown-selection'
    $others=@($result.runningBeforeVmShutdown | Where-Object { $_ -cne $distro })
    if($others.Count -gt 0){throw ('VHD remains attached; other distributions are running: '+($others -join ', '))}
    $result.vmShutdownAttempted=$true
    Save-MaintenanceResult 'before-vm-shutdown'
    try { $result.vmShutdownExitCode=Invoke-Wsl @('--shutdown') }
    catch { $result.vmShutdownExitCode=$_.Exception.Data['ExitCode'];$result.vmShutdownError=$_.Exception.Message;throw }
    Save-MaintenanceResult 'after-vm-shutdown'
    if(-not (Wait-VhdRelease)){throw 'The selected VHD remains in use after native WSL VM shutdown.'}
  }
}
if ($needSparse) {
  for ($attempt = 1; $attempt -le $conversionAttempts; $attempt++) {
    Stop-Target
    $result.sparseAttempted = $true
    Save-MaintenanceResult 'before-sparse-conversion'
    $arguments = @('--manage', $distro, '--set-sparse', 'true')
    if ($allowUnsafe) { $arguments += '--allow-unsafe' }
    try {
      $result.sparseExitCode = Invoke-Wsl $arguments
      $result.sparseError = $null; $sparseFailure = $null
      $result.attempts += [ordered]@{ attempt=$attempt; outcome='converted' }
      Save-MaintenanceResult 'after-sparse-conversion'
      break
    } catch {
      $sparseFailure = $_; $result.sparseExitCode=$_.Exception.Data['ExitCode']; $result.sparseError = $_.Exception.Message
      $restarted = [string]$_.Exception.Data['Output'] -match 'WSL_E_DISTRO_NOT_STOPPED'
      $result.attempts += [ordered]@{ attempt=$attempt; outcome=$(if ($restarted) { 'distribution-restarted' } else { 'refused' }); relaunchedBy=@(Get-WslClients) }
      Save-MaintenanceResult 'after-sparse-conversion'
      Write-Warning $result.sparseError
      if (-not $restarted) { break }
      Write-Warning ('{0} was started again before conversion by: {1}' -f $distro, ((Get-WslClients) -join '; '))
    }
  }
}

} catch { $maintenanceFailure=$_; $result.maintenanceError=$_.Exception.Message }
finally {
# Start the distribution again, even after a failure, so its services and timers come back.
$result.restartAttempted=$true
try { Save-MaintenanceResult 'before-restart' } catch { Write-Warning $_.Exception.Message }
try { $result.restartExitCode = Invoke-Wsl @('-d', $distro, '--exec', '/usr/bin/true') }
catch { $restartFailure = $_; $result.restartExitCode=$_.Exception.Data['ExitCode']; $result.restartError = $_.Exception.Message }
}

$sparseNow = [bool]((Get-Item -LiteralPath $vhd -Force).Attributes -band [IO.FileAttributes]::SparseFile)
if ($sparseNow -and $trimAfterConversion -and -not $restartFailure) {
  # Discards from this trim free the VHDX's unused ranges on Windows now instead of at the next daily trim.
  $result.trimAttempted = $true
  Save-MaintenanceResult 'before-trim'
  try { $result.trimExitCode = Invoke-Wsl @('-d', $distro, '-u', 'root', '--exec', '/usr/sbin/fstrim', '-v', '/') }
  catch { $result.trimExitCode=$_.Exception.Data['ExitCode']; $result.trimError=$_.Exception.Message; Write-Warning $result.trimError }
}
$allocatedAfter = Get-AllocatedBytes $vhd
$result.allocatedAfterBytes = [string]$allocatedAfter
$freeAfter = [IO.DriveInfo]::new($root).AvailableFreeSpace
$result.sparseAfter = $sparseNow
$result.freeAfterBytes = [string]$freeAfter
$result.completedAt = [DateTime]::UtcNow.ToString('o')
Save-MaintenanceResult 'received'
Write-Host ('VHDX sparse: {0}; {1} free {2:N1} GiB -> {3:N1} GiB' -f $sparseNow, $root, ($freeBefore / 1GB), ($freeAfter / 1GB))
if ($null -ne $allocatedBefore -and $null -ne $allocatedAfter) { Write-Host ('VHDX occupies {0:N1} GiB -> {1:N1} GiB' -f ($allocatedBefore / 1GB), ($allocatedAfter / 1GB)) }
if ($restartFailure) { throw $restartFailure }
if ($maintenanceFailure) { throw $maintenanceFailure }
if ($sparseFailure -and -not $sparseNow) { throw $sparseFailure }
if (-not $sparseNow) { throw 'WSL finished, but the VHDX file is still not marked sparse. If WSL printed a message about --allow-unsafe above, the host record''s sparse.allowUnsafe is the Leader''s decision; otherwise run wsl-host plan and read what it reports.' }
Write-Host 'Done. The disk is sparse.'
`;
}

/** Bytes in use on the guest filesystem at `mount`, from statfs (never a directory walk). */
export function guestUsedBytes(mount, ports = {}) {
  const s = (ports.statfs ?? statfsSync)(mount, { bigint: true });
  return (BigInt(s.blocks) - BigInt(s.bfree)) * BigInt(s.bsize);
}

/**
 * Plan checks for a declared sparse disk, from the one native capacity observation and the guest's used
 * bytes: whether the VHDX is sparse, and how much Windows allocation exceeds ext4 use. Empty when the
 * record declares no sparse disk. The sparse check carries the hook that names the owner's Windows command.
 */
export function assessBackingReclaim(parameters, capacity, usedBytes) {
  const d = sparseDisk(parameters);
  if (!d) return [];
  assert.equal(capacity?.type, 'WslBackingVolumeCapacity');
  const vhd = capacity.volumes[0].vhd, allocated = BigInt(vhd.allocatedBytes), used = BigInt(usedBytes), tolerated = BigInt(d.maxSlackBytes);
  const slack = allocated - used;
  return [
    { name: 'Windows backing disk sparse', hook: 'windows-maintenance', ok: vhd.sparse === true,
      want: 'sparse backing disk configured',
      have: vhd.sparse === true ? 'sparse' : 'NOT sparse' },
    { name: 'Windows backing allocation vs ext4 used', ok: slack <= tolerated,
      want: `VHDX allocation at most ${GiB(tolerated)} GiB above ext4 used bytes`,
      have: `VHDX ${GiB(allocated)} GiB allocated on Windows, ext4 ${GiB(used)} GiB used, accounting difference ${GiB(slack)} GiB` },
  ];
}


