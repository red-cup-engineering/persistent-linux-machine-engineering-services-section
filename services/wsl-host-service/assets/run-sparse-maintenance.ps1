$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$utf8=[Text.UTF8Encoding]::new($false)
$directory=$PSScriptRoot
$manifest=Get-Content -LiteralPath (Join-Path $directory 'manifest.json') -Raw | ConvertFrom-Json
$statePath=Join-Path $directory 'state.json'
$claimPath=Join-Path $directory 'launch.json'
$resultPath=Join-Path $directory 'result.json'
$logPath=Join-Path $directory 'output.log'
function Save-State($value) {
  $temporary=$statePath+'.tmp'
  [IO.File]::WriteAllText($temporary,($value|ConvertTo-Json -Compress -Depth 8),$utf8)
  if(Test-Path -LiteralPath $statePath){[IO.File]::Replace($temporary,$statePath,[Management.Automation.Language.NullString]::Value)}else{[IO.File]::Move($temporary,$statePath)}
}
function Require-Hash([string]$name,[string]$expected) {
  $path=Join-Path $directory $name
  if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected){throw "Maintenance input changed: $name"}
}
$state=[ordered]@{request=$manifest.request;state='starting';pid=$PID;processStartedAt=[Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToString('o');startedAt=[DateTime]::UtcNow.ToString('o');exitCode=$null;error=$null}
$exitCode=1
$mutex=$null
$leased=$false
if(Test-Path -LiteralPath $statePath){throw 'A maintenance parent already recorded its state; inspect it before another launch.'}
try {
  # A repeated parent never runs a second copy of the native operation.
  Save-State $state
  Require-Hash 'parameters.json' $manifest.parameterSha256
  Require-Hash 'maintenance.ps1' $manifest.maintenanceSha256
  Require-Hash 'run.ps1' $manifest.runnerSha256
  $parameters=Get-Content -LiteralPath (Join-Path $directory 'parameters.json') -Raw | ConvertFrom-Json
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $state.inWindowsJob=[WslSparseMaintenanceProcess]::CurrentIsInJob()
  $claim=Get-Content -LiteralPath $claimPath -Raw | ConvertFrom-Json
  if($claim.request -cne $manifest.request -or $claim.ownerSid -cne $sid -or $claim.launcher -cne 'task-scheduler' -or
    $claim.taskName -cne ('561-group-wsl-maintenance-'+$manifest.request) -or $claim.state -cne 'run-requested' -or $claim.pid){throw 'The native parent does not match its requested Windows task'}
  $scheduler=New-Object -ComObject Schedule.Service
  $scheduler.Connect()
  $task=$scheduler.GetFolder('\').GetTask($claim.taskName)
  $principal=$task.Definition.Principal.UserId
  if($principal -notmatch '^S-1-'){$principal=[Security.Principal.NTAccount]::new($principal).Translate([Security.Principal.SecurityIdentifier]).Value}
  if($principal -cne $sid -or $task.Definition.Principal.LogonType -ne 3 -or $task.Definition.Principal.RunLevel -ne 0 -or $task.State -ne 4){throw 'The native parent is not received by its running Windows owner task'}
  $state.launcher='task-scheduler';$state.taskName=$task.Name
  # After Run is requested, this parent alone writes its actual process identity.
  $claim.state='started';$claim.pid=$PID
  $claim|Add-Member -NotePropertyName processStartedAt -NotePropertyValue $state.processStartedAt
  [IO.File]::WriteAllText($claimPath+'.tmp',($claim|ConvertTo-Json -Compress -Depth 8),$utf8)
  [IO.File]::Replace($claimPath+'.tmp',$claimPath,[Management.Automation.Language.NullString]::Value)
  # Share the original native-maintenance carrier's distribution-wide mutex.
  $mutex=[Threading.Mutex]::new($false,('Global\WslMaintenance-'+$sid+'-'+$parameters.windows.backingStorage.registryKey.Split('\')[-1]))
  try {
    $leased=$mutex.WaitOne(0)
  } catch [Threading.AbandonedMutexException] {
    $leased=$true
    throw 'An earlier native maintenance parent ended without releasing its mutex; receive that outcome first'
  }
  if(-not $leased){throw 'Another native maintenance operation holds this distribution'}
  # Let the triggering runner report the durable Windows PID before WSL stops.
  Start-Sleep -Seconds 90
  $state.state='running';Save-State $state
  & (Join-Path $directory 'maintenance.ps1') -ResultPath $resultPath *>&1 | Out-File -LiteralPath $logPath -Encoding utf8
  $exitCode=0
} catch {
  $state.error=$_.Exception.Message
  [IO.File]::AppendAllText($logPath,($_|Out-String),$utf8)
} finally {
  $state.state='completed';$state.exitCode=$exitCode;$state.completedAt=[DateTime]::UtcNow.ToString('o')
  try { Save-State $state }
  finally {
    if($leased){$mutex.ReleaseMutex()}
    if($mutex){$mutex.Dispose()}
  }
}
exit $exitCode
