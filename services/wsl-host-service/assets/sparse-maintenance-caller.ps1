$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$utf8=[Text.UTF8Encoding]::new($false)
if($inputPacket.request -cnotmatch '^[a-f0-9]{64}$'){throw 'Invalid maintenance selection'}
$profile=[Environment]::GetFolderPath('UserProfile')
if($profile -ine $inputPacket.profile){throw 'The Windows caller does not own the declared profile'}
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$base=Join-Path $profile 'AppData\Local\561-group\wsl-host-service\maintenance'
$directory=Join-Path $base $inputPacket.request
$statePath=Join-Path $directory 'state.json'
$claimPath=Join-Path $directory 'launch.json'
function Read-Json([string]$path) {
  if(-not(Test-Path -LiteralPath $path)){return $null}
  $file=Get-Item -LiteralPath $path -Force
  if($file.Length -gt 131072 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Invalid maintenance state file'}
  $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  try {
    if($stream.Length -gt 131072){throw 'Maintenance state exceeds its allocation'}
    $reader=[IO.StreamReader]::new($stream,$utf8)
    try { return $reader.ReadToEnd()|ConvertFrom-Json }
    finally { $reader.Dispose() }
  } finally { $stream.Dispose() }
}
function Read-LogTail {
  $path=Join-Path $directory 'output.log'
  if(-not(Test-Path -LiteralPath $path)){return $null}
  if((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Redirected maintenance output'}
  $file=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
  try {
    $length=$file.Length
    $count=[int][Math]::Min($length,16384)
    $null=$file.Seek(-$count,[IO.SeekOrigin]::End)
    $bytes=[byte[]]::new($count)
    $offset=0
    while($offset -lt $count){$read=$file.Read($bytes,$offset,$count-$offset);if($read -eq 0){break};$offset+=$read}
    return [ordered]@{bytes=$length;truncated=($length -gt $count);text=$utf8.GetString($bytes,0,$offset)}
  } finally { $file.Dispose() }
}
function Parent-Alive($observed) {
  if(-not $observed -or -not $observed.pid -or -not $observed.processStartedAt){return $false}
  $process=Get-Process -Id $observed.pid -ErrorAction SilentlyContinue
  return ($process -and $process.StartTime.ToUniversalTime().Ticks -eq [DateTime]::Parse($observed.processStartedAt).ToUniversalTime().Ticks)
}
function Complete-PendingState([string]$path,[string]$request,$previous) {
  if(-not $previous -or $previous.state -eq 'completed'){return $previous}
  $pending=Read-Json ($path+'.tmp')
  $claim=Read-Json (Join-Path ([IO.Path]::GetDirectoryName($path)) 'launch.json')
  if(-not $pending -or -not $claim -or $pending.state -cne 'completed' -or
    $previous.request -cne $request -or $pending.request -cne $request -or $claim.request -cne $request -or
    -not $previous.pid -or $pending.pid -ne $previous.pid -or $claim.pid -ne $previous.pid -or
    -not $previous.processStartedAt -or $pending.processStartedAt -cne $previous.processStartedAt -or $claim.processStartedAt -cne $previous.processStartedAt -or
    -not $previous.startedAt -or $pending.startedAt -cne $previous.startedAt -or
    -not $pending.completedAt -or $pending.exitCode -notin @(0,1) -or (Parent-Alive $previous)){return $previous}
  if([DateTime]::Parse($pending.completedAt).ToUniversalTime() -lt [DateTime]::Parse($previous.startedAt).ToUniversalTime()){return $previous}
  # Receive the stopped parent's actual terminal bytes. Do not invent a result,
  # erase its failed attempt, or complete a live/uncertain operation.
  [IO.File]::Replace($path+'.tmp',$path,[Management.Automation.Language.NullString]::Value)
  return Read-Json $path
}
function Maintenance-FileHash([string]$path,[long]$maximum=262144) {
  $item=Get-Item -LiteralPath $path -Force
  if($item.PSIsContainer -or $item.Length -gt $maximum -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Invalid retained maintenance file'}
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Receive-InterruptedParent([string]$request,[bool]$persist) {
  if($request -cnotmatch '^[a-f0-9]{64}$'){throw 'Exact interrupted maintenance request required'}
  $priorDirectory=Join-Path $base $request
  $item=Get-Item -LiteralPath $priorDirectory -Force
  if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Invalid interrupted maintenance directory'}
  $priorStatePath=Join-Path $priorDirectory 'state.json'
  $priorClaimPath=Join-Path $priorDirectory 'launch.json'
  $previous=Read-Json $priorStatePath
  $claim=Read-Json $priorClaimPath
  $manifest=Read-Json (Join-Path $priorDirectory 'manifest.json')
  if($manifest.parameterSha256 -cne $inputPacket.parameterSha256 -or
     (Maintenance-FileHash (Join-Path $priorDirectory 'parameters.json') 131072) -cne $inputPacket.parameterSha256 -or
     (Maintenance-FileHash (Join-Path $priorDirectory 'maintenance.ps1')) -cne $manifest.maintenanceSha256 -or
     (Maintenance-FileHash (Join-Path $priorDirectory 'run.ps1')) -cne $manifest.runnerSha256){throw 'Interrupted maintenance source or host declaration changed'}
  $originalText=[IO.File]::ReadAllText((Join-Path $priorDirectory 'parameters.json'),$utf8)+[char]0+
    [IO.File]::ReadAllText((Join-Path $priorDirectory 'maintenance.ps1'),$utf8)+[char]0+
    [IO.File]::ReadAllText((Join-Path $priorDirectory 'run.ps1'),$utf8)
  $requestHasher=[Security.Cryptography.SHA256]::Create()
  try{$originalRequest=([BitConverter]::ToString($requestHasher.ComputeHash($utf8.GetBytes($originalText)))).Replace('-','').ToLowerInvariant()}
  finally{$requestHasher.Dispose()}
  if($originalRequest -cne $request){throw 'Retained source bytes do not form the selected original maintenance request'}
  if(-not $previous -and $persist -and $claim.launcher -ceq 'task-scheduler') {
    return [ordered]@{received=$true;interruption=(Receive-NotStartedState $priorStatePath $request);callerInWindowsJob=[WslSparseMaintenanceProcess]::CurrentIsInJob()}
  }
  if($previous -and $previous.state -ceq 'not-started' -and $previous.request -ceq $request) {
    return [ordered]@{received=$true;interruption=$previous;callerInWindowsJob=[WslSparseMaintenanceProcess]::CurrentIsInJob()}
  }
  if(-not $previous -or -not $claim -or -not $manifest -or
     $previous.state -cnotin @('starting','running') -or $claim.state -cne 'started' -or
     $previous.request -cne $request -or $claim.request -cne $request -or $manifest.request -cne $request -or
     $claim.ownerSid -cne $owner -or -not $previous.pid -or $claim.pid -ne $previous.pid -or
     -not $previous.processStartedAt -or $previous.processStartedAt -cne $claim.processStartedAt -or
     (Parent-Alive $previous)){throw 'The selected prior Windows parent is not an identified stopped interruption'}
  if(Test-Path -LiteralPath ($priorStatePath+'.tmp')){throw 'Receive the pending terminal state before an interruption'}
  $stateHash=Maintenance-FileHash $priorStatePath 131072
  $claimHash=Maintenance-FileHash $priorClaimPath 131072
  $parameters=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($inputPacket.parameterBase64))|ConvertFrom-Json
  $target=$parameters.windows.backingStorage
  $registered=Get-ItemProperty -LiteralPath $target.registryKey
  $registeredPath=(Join-Path $registered.BasePath $target.vhdFileName) -replace '^\\\\\?\\',''
  if($registered.DistributionName -cne $inputPacket.distribution -or $registeredPath -ine (Join-Path $target.basePath $target.vhdFileName)){throw 'Interrupted maintenance registration changed'}
  $receiptPath=Join-Path $priorDirectory 'interruption.json'
  $retained=Read-Json $receiptPath
  if(-not $persist -and -not $retained){throw 'Receive the stopped maintenance parent before a new launch'}
  if($retained -and ($retained.kind -cne 'wsl.sparse-maintenance-interruption/v1' -or $retained.request -cne $request -or
     $retained.ownerSid -cne $owner -or $retained.stateSha256 -cne $stateHash -or $retained.launchSha256 -cne $claimHash -or
     $retained.parameterSha256 -cne $inputPacket.parameterSha256)){throw 'Retained interruption differs from its original state'}
  $mutex=[Threading.Mutex]::new($false,('Global\WslMaintenance-'+$owner+'-'+$target.registryKey.Split('\')[-1]))
  $leased=$false;$abandoned=$false
  try {
    try{$leased=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$leased=$true;$abandoned=$true}
    if(-not $leased){throw 'Another native maintenance operation still holds this distribution'}
    # A running native distribution excludes WSL's offline conversion/compaction
    # state. Listing observes it without starting a guest or replaying maintenance.
    $previousPreference=$ErrorActionPreference;$ErrorActionPreference='Continue'
    try{$running=& $target.sparse.wslExecutable --list --running --quiet 2>&1;$nativeExit=$LASTEXITCODE}
    finally{$ErrorActionPreference=$previousPreference}
    $runningText=(@($running|ForEach-Object{$_.ToString().Replace([string][char]0,'')}) -join [Environment]::NewLine)
    if($nativeExit -ne 0 -or $runningText.Length -gt 32768 -or
       -not @($runningText -split '\r?\n'|ForEach-Object{$_.Trim()}|Where-Object{$_ -ceq $inputPacket.distribution}).Count){throw 'Native provider does not report the selected distribution running'}
    if((Parent-Alive $previous) -or (Maintenance-FileHash $priorStatePath 131072) -cne $stateHash -or
       (Maintenance-FileHash $priorClaimPath 131072) -cne $claimHash){throw 'Interrupted parent identity changed during receiving'}
    $callerInJob=[WslSparseMaintenanceProcess]::CurrentIsInJob()
    $observation=[ordered]@{at=[DateTime]::UtcNow.ToString('o');parentAlive=$false;distributionRunning=$true;nativeListExitCode=$nativeExit;mutexAcquired=$true;mutexWasAbandoned=$abandoned}
    if(-not $retained) {
      $retained=[ordered]@{kind='wsl.sparse-maintenance-interruption/v1';request=$request;ownerSid=$owner;
        parameterSha256=$inputPacket.parameterSha256;stateSha256=$stateHash;launchSha256=$claimHash;
        parentPid=$previous.pid;processStartedAt=$previous.processStartedAt;state='interrupted';
        resultPath=(Join-Path $priorDirectory 'result.json');receiverRequest=$inputPacket.request;observation=$observation}
      $bytes=$utf8.GetBytes(($retained|ConvertTo-Json -Compress -Depth 8))
      $file=[IO.File]::Open($receiptPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
      try{$file.Write($bytes,0,$bytes.Length);$file.Flush($true)}finally{$file.Dispose()}
    }
    return [ordered]@{received=$true;interruption=$retained;currentObservation=$observation;callerInWindowsJob=$callerInJob}
  } finally {if($leased){$mutex.ReleaseMutex()};$mutex.Dispose()}
}
function Scheduler {
  try {
    $service=New-Object -ComObject Schedule.Service
    $service.Connect()
    return $service
  } catch {
    $native=$_.Exception.GetBaseException()
    throw ('Windows Task Scheduler connection refused: '+$native.Message+'; HRESULT='+$native.HResult+'; owner='+$owner+'; session='+[Diagnostics.Process]::GetCurrentProcess().SessionId)
  }
}
function Read-ScheduledTask($service,[string]$name) {
  try { return $service.GetFolder('\').GetTask($name) }
  catch {
    $failure=$_.Exception
    while($failure.InnerException){$failure=$failure.InnerException}
    if($failure.HResult -ne -2147024894){throw}
    return $null
  }
}
function Receive-ScheduledTask($task,[string]$name,[string]$taskDirectory=$directory,[bool]$allowDisabled=$false) {
  $definition=$task.Definition
  $principal=$definition.Principal.UserId
  if($principal -notmatch '^S-1-'){$principal=[Security.Principal.NTAccount]::new($principal).Translate([Security.Principal.SecurityIdentifier]).Value}
  if($task.Name -cne $name -or $principal -cne $owner -or $definition.Principal.LogonType -ne 3 -or $definition.Principal.RunLevel -ne 0 -or
    $definition.Actions.Count -ne 1 -or $definition.Triggers.Count -ne 0 -or $definition.Settings.MultipleInstances -ne 2 -or
    $definition.Settings.ExecutionTimeLimit -cne 'PT0S' -or $definition.Settings.AllowHardTerminate -or
    $definition.Settings.DisallowStartIfOnBatteries -or $definition.Settings.StopIfGoingOnBatteries){throw 'Windows maintenance task differs from its original owner operation'}
  if(-not $allowDisabled -and (-not $task.Enabled -or -not $definition.Settings.Enabled)){throw 'The selected Windows maintenance task is disabled'}
  $action=$definition.Actions.Item(1)
  if($action.Type -ne 0 -or $action.Path -ine 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -or
    $action.WorkingDirectory -ine $taskDirectory -or $action.Arguments -cne ('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $taskDirectory 'run.ps1')+'"')){throw 'Windows maintenance task action changed'}
}
function Receive-NotStartedState([string]$path,[string]$request) {
  $priorDirectory=[IO.Path]::GetDirectoryName($path)
  $claim=Read-Json (Join-Path $priorDirectory 'launch.json')
  $manifest=Read-Json (Join-Path $priorDirectory 'manifest.json')
  if(-not $claim -or -not $manifest -or $claim.request -cne $request -or $manifest.request -cne $request -or
    $manifest.parameterSha256 -cne $inputPacket.parameterSha256 -or $claim.ownerSid -cne $owner -or
    $claim.launcher -cne 'task-scheduler' -or $claim.taskName -cne ('561-group-wsl-maintenance-'+$request) -or
    $claim.pid -or -not $claim.caller.pid -or -not $claim.caller.processStartedAt -or (Parent-Alive $claim.caller)){throw 'The original Windows launch is still live or its identity is unavailable'}
  if((Test-Path -LiteralPath ($path+'.tmp')) -or (Test-Path -LiteralPath (Join-Path $priorDirectory 'result.json'))){throw 'Native maintenance has retained an outcome that must be received first'}
  $service=Scheduler
  $task=Read-ScheduledTask $service $claim.taskName
  $registered=[bool]$task
  if($task) {
    Receive-ScheduledTask $task $claim.taskName $priorDirectory $true
    if($task.State -notin @(1,3) -or $task.GetInstances(0).Count){throw 'The original Windows task is queued or running'}
    # Disable only this idle, exact task so a late Run request cannot start it.
    # An interrupted reception can finish from this same disabled state.
    $task.Enabled=$false
    $task=Read-ScheduledTask $service $claim.taskName
    Receive-ScheduledTask $task $claim.taskName $priorDirectory $true
    if($task.Enabled -or $task.State -ne 1 -or $task.GetInstances(0).Count){throw 'The original Windows task has not become idle and disabled'}
  }
  if(Test-Path -LiteralPath $path){throw 'The original native parent recorded state during launch recovery'}
  $failure=Read-Json (Join-Path $priorDirectory 'launch-error.json')
  $message=if($failure){$failure.error}else{'The original Windows launch ended before a native parent recorded its state.'}
  $received=[ordered]@{request=$request;state='not-started';pid=$null;exitCode=$null;receivedAt=[DateTime]::UtcNow.ToString('o');
    error=$message;
    caller=$claim.caller;task=[ordered]@{name=$claim.taskName;registered=$registered;enabled=$false;instances=0}}
  $file=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try{$bytes=$utf8.GetBytes(($received|ConvertTo-Json -Compress -Depth 8));$file.Write($bytes,0,$bytes.Length);$file.Flush($true)}finally{$file.Dispose()}
  return Read-Json $path
}
function Task-Status($claim,$state) {
  if(-not $claim.taskName){return $null}
  if($claim.taskName -cne ('561-group-wsl-maintenance-'+$inputPacket.request)){throw 'Unexpected Windows maintenance task'}
  $task=Read-ScheduledTask (Scheduler) $claim.taskName
  if(-not $task){return [ordered]@{name=$claim.taskName;registered=$false}}
  Receive-ScheduledTask $task $claim.taskName $directory ($state.state -ceq 'not-started')
  $instances=$task.GetInstances(0)
  $running=@()
  for($index=1;$index -le $instances.Count;$index++){$instance=$instances.Item($index);$running+=,[ordered]@{instance=$instance.InstanceGuid;enginePid=[int]$instance.EnginePID;state=[int]$instance.State}}
  return [ordered]@{name=$task.Name;registered=$true;state=[int]$task.State;lastRunAt=$task.LastRunTime.ToUniversalTime().ToString('o');lastResult=[long]$task.LastTaskResult;instances=$running}
}
function Receive-Status {
  $state=Read-Json $statePath
  $claim=Read-Json $claimPath
  $result=Read-Json (Join-Path $directory 'result.json')
  $observed=if($state){$state}else{$claim}
  $alive=($observed -and $observed.state -ne 'completed' -and (Parent-Alive $observed))
  $pending=$null
  if(-not $alive){try{$pending=Read-Json ($statePath+'.tmp')}catch{$pending=[ordered]@{error=$_.Exception.Message}}}
  return [ordered]@{request=$inputPacket.request;directory=$directory;ownerSid=$owner;launch=$claim;process=$state;processAlive=$alive;result=$result;pendingState=$pending;output=(Read-LogTail);
    task=(Task-Status $claim $state);launchError=(Read-Json (Join-Path $directory 'launch-error.json'));
    caller=[ordered]@{sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;inWindowsJob=[WslSparseMaintenanceProcess]::CurrentIsInJob();userInteractive=[Environment]::UserInteractive}}
}
if($inputPacket.action -ceq 'status'){Receive-Status|ConvertTo-Json -Compress -Depth 12;return}
if($inputPacket.action -cnotin @('launch','receive-interruption')){throw 'Unknown maintenance operation'}
# Refuse a redirected Windows state path and keep concurrent native maintenance singular.
$at=$base
while($at -and -not(Test-Path -LiteralPath $at)){$at=[IO.Path]::GetDirectoryName($at)}
while($at -and $at.Length -ge $profile.Length){if((Get-Item -LiteralPath $at -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Redirected maintenance owner path'};$at=[IO.Path]::GetDirectoryName($at)}
if($inputPacket.action -ceq 'receive-interruption'){Receive-InterruptedParent $inputPacket.priorRequest $true|ConvertTo-Json -Compress -Depth 12;return}
if(Test-Path -LiteralPath $claimPath){Receive-Status|ConvertTo-Json -Compress -Depth 12;return}
if(Test-Path -LiteralPath $base) {
  foreach($prior in @(Get-ChildItem -LiteralPath $base -Directory)) {
    if($prior.Name -ceq $inputPacket.request){continue}
    if(-not(Test-Path -LiteralPath (Join-Path $prior.FullName 'launch.json'))){continue}
    if($prior.Name -cnotmatch '^[a-f0-9]{64}$' -or ($prior.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unexpected prior maintenance directory'}
    $path=Join-Path $prior.FullName 'state.json'
    $previous=Complete-PendingState $path $prior.Name (Read-Json $path)
    if(-not $previous){throw 'Another native disk maintenance is pending; receive its outcome first'}
    if($previous.state -cnotin @('completed','not-started')){$null=Receive-InterruptedParent $prior.Name $false}
  }
}
[IO.Directory]::CreateDirectory($directory)|Out-Null
function Write-Exact([string]$name,[string]$base64,[string]$expected) {
  $bytes=[Convert]::FromBase64String($base64)
  if($bytes.Length -gt 262144){throw 'Maintenance input exceeds its allocation'}
  $hash=([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes))).Replace('-','').ToLowerInvariant()
  if($hash -cne $expected){throw 'Changed maintenance input'}
  $path=Join-Path $directory $name
  if(Test-Path -LiteralPath $path){if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected){throw 'Retained maintenance input differs'};return}
  $file=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try{$file.Write($bytes,0,$bytes.Length);$file.Flush($true)}finally{$file.Dispose()}
}
Write-Exact 'parameters.json' $inputPacket.parameterBase64 $inputPacket.parameterSha256
Write-Exact 'maintenance.ps1' $inputPacket.maintenanceBase64 $inputPacket.maintenanceSha256
Write-Exact 'run.ps1' $inputPacket.runnerBase64 $inputPacket.runnerSha256
foreach($name in @('maintenance.ps1','run.ps1')) {
  $tokens=$null;$errors=$null
  $null=[Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText((Join-Path $directory $name),$utf8),[ref]$tokens,[ref]$errors)
  if(@($errors).Count -gt 0){throw ('Invalid Windows PowerShell source '+$name+': '+(($errors|ForEach-Object{'line '+$_.Extent.StartLineNumber+', column '+$_.Extent.StartColumnNumber+': '+$_.Message}) -join '; '))}
}
$manifest=[ordered]@{request=$inputPacket.request;parameterSha256=$inputPacket.parameterSha256;maintenanceSha256=$inputPacket.maintenanceSha256;runnerSha256=$inputPacket.runnerSha256}
[IO.File]::WriteAllText((Join-Path $directory 'manifest.json'),($manifest|ConvertTo-Json -Compress),$utf8)
$taskName='561-group-wsl-maintenance-'+$inputPacket.request
$service=Scheduler
if(Read-ScheduledTask $service $taskName){throw 'A Windows maintenance task already exists without its launch claim'}
$claim=[ordered]@{request=$inputPacket.request;state='registering';ownerSid=$owner;at=[DateTime]::UtcNow.ToString('o');launcher='task-scheduler';taskName=$taskName;pid=$null;
  caller=[ordered]@{pid=$PID;processStartedAt=[Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToString('o')}}
$file=[IO.File]::Open($claimPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
try{$bytes=$utf8.GetBytes(($claim|ConvertTo-Json -Compress));$file.Write($bytes,0,$bytes.Length);$file.Flush($true)}finally{$file.Dispose()}
function Save-Claim {
  [IO.File]::WriteAllText($claimPath+'.tmp',($claim|ConvertTo-Json -Compress),$utf8)
  [IO.File]::Replace($claimPath+'.tmp',$claimPath,[Management.Automation.Language.NullString]::Value)
}
# Task Scheduler starts the same user's one-shot parent outside WSL interop.
# It has no trigger, password, elevation, automatic retry or expiry that kills
# an in-progress native disk operation.
try {
$definition=$service.NewTask(0)
$definition.RegistrationInfo.Description='Maintain the declared '+$inputPacket.distribution+' WSL backing disk.'
$definition.Principal.UserId=$owner
$definition.Principal.LogonType=3
$definition.Principal.RunLevel=0
$definition.Settings.Enabled=$true
$definition.Settings.AllowDemandStart=$true
$definition.Settings.MultipleInstances=2
$definition.Settings.ExecutionTimeLimit='PT0S'
$definition.Settings.AllowHardTerminate=$false
$definition.Settings.DisallowStartIfOnBatteries=$false
$definition.Settings.StopIfGoingOnBatteries=$false
$action=$definition.Actions.Create(0)
$action.Path='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$action.Arguments='-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $directory 'run.ps1')+'"'
$action.WorkingDirectory=$directory
$task=$service.GetFolder('\').RegisterTaskDefinition($taskName,$definition,2,$owner,$null,3,$null)
Receive-ScheduledTask $task $taskName
$claim.state='run-requested';Save-Claim
# The parent owns all subsequent claim writes, including late startup identity.
$null=$task.Run($null)
$deadline=[DateTime]::UtcNow.AddSeconds(10)
do {
  $parent=Read-Json $statePath
  if($parent -and $parent.request -ceq $inputPacket.request -and $parent.pid -and $parent.processStartedAt){break}
  Start-Sleep -Milliseconds 100
} while([DateTime]::UtcNow -lt $deadline)
Receive-Status|ConvertTo-Json -Compress -Depth 12
} catch {
  $caught=$_
  $native=$caught.Exception.GetBaseException()
  $failure=[ordered]@{request=$inputPacket.request;at=[DateTime]::UtcNow.ToString('o');phase=$claim.state;error=$native.Message;hresult=$native.HResult;nativeErrorCode=$native.NativeErrorCode;
    ownerSid=$owner;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;logonType=3;runLevel=0;taskName=$taskName}
  try{[IO.File]::WriteAllText((Join-Path $directory 'launch-error.json'),($failure|ConvertTo-Json -Compress),$utf8)}catch{Write-Warning $_.Exception.Message}
  throw $caught
}
