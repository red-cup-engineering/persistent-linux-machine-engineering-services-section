param(
  [Parameter(Mandatory=$true)][string]$Hostname,
  [Parameter(Mandatory=$true)][string]$ApplyScriptWindowsPath,
  [Parameter(Mandatory=$true)][string]$ExpectedApplyScriptSha256,
  [Parameter(Mandatory=$true)][string]$ResultWindowsPath,
  [string]$CurlExecutable = 'C:\Windows\System32\curl.exe'
)
# Source-bound native qualification. The only temporary firewall rule applies
# to the explicit curl executable, never a browser, WSL, Tailscale or global policy.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$encoding = New-Object Text.UTF8Encoding($false, $true)
$maximumScriptBytes = 1048576
$maximumOutputCharacters = 8192
$curlDeadlineMilliseconds = 15000
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator token required before qualification' }
if ($Hostname -cnotmatch '^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$') { throw 'Canonical hostname required' }
if ($ExpectedApplyScriptSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Expected lowercase SHA256 required' }
foreach ($path in @($ApplyScriptWindowsPath, $ResultWindowsPath, $CurlExecutable)) {
  if ($path -notmatch '^[A-Za-z]:\\' -or [IO.Path]::GetFullPath($path) -cne $path) { throw 'Explicit canonical Windows paths required' }
}
if (Test-Path -LiteralPath $ResultWindowsPath) { throw 'Qualification result already exists; inspect the original operation instead of replaying it' }
foreach ($path in @($ApplyScriptWindowsPath, $CurlExecutable, [IO.Path]::GetDirectoryName($ResultWindowsPath))) {
  $item = Get-Item -LiteralPath $path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Redirected qualification input refused' }
}
if (-not (Get-Command New-NetFirewallRule -ErrorAction Stop) -or -not (Get-Command Get-NetFirewallApplicationFilter -ErrorAction Stop)) { throw 'Native Windows firewall provider unavailable' }

$ruleName = '561-local-origin-qualification-' + [Guid]::NewGuid().ToString('N')
$result = [ordered]@{
  kind = 'wsl-local-origin-native-qualification'
  hostname = $Hostname
  applyScript = $ApplyScriptWindowsPath
  applyScriptSha256 = $ExpectedApplyScriptSha256
  curlExecutable = $CurlExecutable
  startedAt = [DateTime]::UtcNow.ToString('o')
  phase = 'source-receiving'
  outcome = 'running'
  apply = $null
  dns = $null
  local = $null
  externalBaseline = $null
  offlineExternal = $null
  offlineLocal = $null
  firewall = [ordered]@{ name = $ruleName; creationAttempted = $false; created = $false; received = $false; cleanupAttempted = $false; absent = $false }
  error = $null
  cleanupError = $null
}
function Save-Result {
  $json = $result | ConvertTo-Json -Depth 10
  if ($encoding.GetByteCount($json) -gt 65536) { throw 'Qualification result exceeds its source-defined bound' }
  $temporary = $ResultWindowsPath + '.writing'
  [IO.File]::WriteAllText($temporary, $json, $encoding)
  Move-Item -LiteralPath $temporary -Destination $ResultWindowsPath -Force
}
function Short-Error($ErrorRecord) {
  $message = [string]$ErrorRecord.Exception.Message
  return $message.Substring(0, [Math]::Min(2048, $message.Length))
}
function Read-ExactRule {
  try { return @(Get-NetFirewallRule -Name $ruleName -ErrorAction Stop) }
  catch {
    if (($_.FullyQualifiedErrorId -split ',')[0] -in @('CmdletizationQuery_NotFound_Name','CmdletizationQuery_NotFound_InstanceID')) { return @() }
    throw
  }
}
function Assert-ExactRule($rules) {
  if (@($rules).Count -ne 1) { throw 'Temporary qualification rule is not uniquely received' }
  $rule = @($rules)[0]
  if ($rule.Name -cne $ruleName -or [string]$rule.Enabled -ne 'True' -or [string]$rule.Direction -ne 'Outbound' -or [string]$rule.Action -ne 'Block' -or [string]$rule.Profile -ne 'Any') { throw 'Temporary qualification rule changed' }
  $application = @($rule | Get-NetFirewallApplicationFilter -ErrorAction Stop)
  $addresses = @($rule | Get-NetFirewallAddressFilter -ErrorAction Stop)
  $remote = @($addresses[0].RemoteAddress)
  if ($application.Count -ne 1 -or -not $application[0].Program.Equals($CurlExecutable, [StringComparison]::OrdinalIgnoreCase)) { throw 'Temporary rule does not select only the declared curl executable' }
  if ($addresses.Count -ne 1 -or $remote.Count -ne 1 -or $remote[0] -ne 'Any') { throw 'Temporary rule remote-address scope differs' }
}
function Invoke-DiagnosticCurl([string]$Url) {
  # Fixed flags do not send credentials, follow redirects or bypass certificate
  # validation. A response is discarded with a one-MiB body and ten-second bound.
  $arguments = @('--fail','--silent','--show-error','--noproxy','*','--connect-timeout','3','--max-time','10','--max-filesize','1048576','--output','NUL','--write-out','%{http_code}',$Url)
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $CurlExecutable
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.Arguments = ($arguments | ForEach-Object { '"' + $_.Replace('"','\"') + '"' }) -join ' '
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $start
  try {
    if (-not $process.Start()) { throw 'Diagnostic curl did not start' }
    $outputTask = $process.StandardOutput.ReadToEndAsync()
    $errorTask = $process.StandardError.ReadToEndAsync()
    $timedOut = -not $process.WaitForExit($curlDeadlineMilliseconds)
    if ($timedOut) {
      # This is only the exact diagnostic child started above, not a provider,
      # application process or unrelated curl invocation.
      try { $process.Kill() } catch {}
      if (-not $process.WaitForExit(5000)) { throw 'Own diagnostic curl did not reach terminal after timeout' }
    }
    if (-not $outputTask.Wait(5000) -or -not $errorTask.Wait(5000)) { throw 'Diagnostic curl streams did not settle' }
    $stdout = [string]$outputTask.Result
    $stderr = [string]$errorTask.Result
    if ($stdout.Length -gt $maximumOutputCharacters -or $stderr.Length -gt $maximumOutputCharacters) { throw 'Diagnostic curl output exceeded its bound' }
    return [ordered]@{ url=$Url; exitCode=$process.ExitCode; httpCode=$stdout.Trim(); timedOut=$timedOut; stderr=$stderr }
  } finally { $process.Dispose() }
}
function Require-Http200($observation) {
  if ($observation.timedOut -or $observation.exitCode -ne 0 -or $observation.httpCode -ne '200') { throw 'Trusted HTTPS diagnostic did not receive HTTP 200' }
}

$sourceStream = $null
try {
  # Holding a read-shared handle prevents replacement or modification between
  # exact source receiving and invocation of this reviewed apply script.
  $sourceStream = [IO.File]::Open($ApplyScriptWindowsPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  if ($sourceStream.Length -gt $maximumScriptBytes) { throw 'Apply script exceeds its source-defined bound' }
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { $actual = ([BitConverter]::ToString($hasher.ComputeHash($sourceStream))).Replace('-','').ToLowerInvariant() }
  finally { $hasher.Dispose() }
  if ($actual -cne $ExpectedApplyScriptSha256) { throw 'Apply script source changed; no apply was invoked' }
  $result.phase = 'apply'
  Save-Result
  $applyOutput = & $ApplyScriptWindowsPath -Apply
  if (-not $?) { throw 'Source-bound local-origin apply did not complete' }
  $applyText = $applyOutput | Out-String
  if ($applyText.Length -gt 65536) { throw 'Apply result exceeded its source-defined bound' }
  $applyResult = $applyText | ConvertFrom-Json
  if ($applyResult.current -ne $true -or $applyResult.applied -ne $true) { throw 'Source-bound apply did not receive current native configuration' }
  $result.apply = [ordered]@{ applied=$true; current=$true }
  $result.phase = 'local-baseline'
  $resolved = @([Net.Dns]::GetHostAddresses($Hostname) | ForEach-Object { $_.ToString() })
  $result.dns = $resolved
  if ($resolved.Count -eq 0 -or @($resolved | Where-Object { $_ -ne '127.0.0.1' }).Count -ne 0) { throw 'Canonical system DNS did not resolve exclusively to local loopback' }
  $canonical = 'https://' + $Hostname + '/'
  $result.local = Invoke-DiagnosticCurl $canonical
  Require-Http200 $result.local
  $result.phase = 'external-baseline'
  Save-Result
  $result.externalBaseline = Invoke-DiagnosticCurl 'https://example.com/'
  Require-Http200 $result.externalBaseline

  $result.phase = 'temporary-firewall-selection'
  if (@(Read-ExactRule).Count -ne 0) { throw 'Unique temporary qualification rule already exists' }
  $result.firewall.creationAttempted = $true
  Save-Result
  New-NetFirewallRule -Name $ruleName -DisplayName $ruleName -Direction Outbound -Action Block -Profile Any -Program $CurlExecutable -RemoteAddress Any -Enabled True -ErrorAction Stop | Out-Null
  $result.firewall.created = $true
  Assert-ExactRule (Read-ExactRule)
  $result.firewall.received = $true
  $result.phase = 'offline-receiving'
  Save-Result
  $result.offlineExternal = Invoke-DiagnosticCurl 'https://example.com/'
  if ($result.offlineExternal.exitCode -eq 0 -or $result.offlineExternal.httpCode -ne '000') { throw 'External diagnostic did not establish blocked Internet access for this curl process' }
  $result.offlineLocal = Invoke-DiagnosticCurl $canonical
  Require-Http200 $result.offlineLocal
  $result.outcome = 'qualified'
} catch {
  $result.outcome = 'failed'
  $result.error = Short-Error $_
} finally {
  if ($result.firewall.creationAttempted) {
    $result.phase = 'temporary-firewall-cleanup'
    $result.firewall.cleanupAttempted = $true
    try {
      $remaining = @(Read-ExactRule)
      if ($remaining.Count -gt 0) {
        Assert-ExactRule $remaining
        Remove-NetFirewallRule -Name $ruleName -ErrorAction Stop
      }
      if (@(Read-ExactRule).Count -ne 0) { throw 'Temporary qualification rule remains installed' }
      $result.firewall.absent = $true
    } catch {
      $result.cleanupError = Short-Error $_
      $result.outcome = 'failed'
    }
  } else {
    $result.firewall.absent = $true
  }
  if ($null -ne $sourceStream) { $sourceStream.Dispose() }
  $result.phase = 'terminal'
  $result.finishedAt = [DateTime]::UtcNow.ToString('o')
  Save-Result
}
$result | ConvertTo-Json -Depth 10
if ($result.outcome -ne 'qualified' -or $result.firewall.absent -ne $true) { exit 1 }
