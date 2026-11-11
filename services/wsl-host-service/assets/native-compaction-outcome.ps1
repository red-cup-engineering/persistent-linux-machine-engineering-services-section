# Shared by the original parent and the finite file caller. No process launch.
function Maintenance-HashBytes([byte[]]$bytes) {
 $sha=[Security.Cryptography.SHA256]::Create()
 try {return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()} finally {$sha.Dispose()}
}
function Maintenance-Json([byte[]]$bytes) {
 $utf8=[Text.UTF8Encoding]::new($false,$true)
 return $utf8.GetString($bytes)|ConvertFrom-Json
}
function Maintenance-Assert([bool]$condition,[string]$message) {if(-not $condition){throw $message}}
function Maintenance-Time([string]$text) {
 Maintenance-Assert ($text -match '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,7}Z$') 'Invalid original timestamp'
 return [DateTimeOffset]::Parse($text,[Globalization.CultureInfo]::InvariantCulture)
}
function Receive-MaintenanceOutcome($bundle) {
 # Bundle values are base64 of exact custody bytes. No status-only admission.
 $files=@{};$total=0
 foreach($property in $bundle.PSObject.Properties) {
  $bytes=[Convert]::FromBase64String([string]$property.Value);$total+=$bytes.Length
  $limit=131072;if($property.Name -ceq 'packet.json'){$limit=1048576}
  Maintenance-Assert ($bytes.Length -le $limit -and $total -le 2097152) 'Unbounded original custody'
  $files[$property.Name]=$bytes
 }
 foreach($name in @('packet.json','parameters.json','admission.json','started.json','native-pid.json','result.json','stdout.bin','stderr.bin','authority.resource.json','checkpoint.resource.json','independent-receiving.resource.json')) {
  Maintenance-Assert ($files.ContainsKey($name)) ('Missing original custody '+$name)
 }
 $packet=Maintenance-Json $files['packet.json'];$admission=Maintenance-Json $files['admission.json']
 $parameters=Maintenance-Json $files['parameters.json'];$intent=Maintenance-Json $files['started.json']
 $pidRecord=Maintenance-Json $files['native-pid.json'];$result=Maintenance-Json $files['result.json']
 Maintenance-Assert ($packet.type -ceq 'WslNativeCompactionPacket' -and $packet.version -eq 1) 'Wrong original packet'
 $parameterHash=Maintenance-HashBytes $files['parameters.json'];$admissionHash=Maintenance-HashBytes $files['admission.json']
 Maintenance-Assert ($packet.parameterSha256 -ceq $parameterHash -and $admission.parameterSha256 -ceq $parameterHash -and $packet.admissionSha256 -ceq $admissionHash) 'Original packet/admission mismatch'
 $utf8=[Text.UTF8Encoding]::new($false,$true)
 Maintenance-Assert ($packet.parameterText -ceq $utf8.GetString($files['parameters.json']) -and $packet.admissionText -ceq $utf8.GetString($files['admission.json'])) 'Changed exact original text'
 # These objects are the original renderer's direct references. Comparing only
 # selected fields leaves a second, unbound declaration available to reentry.
 Maintenance-Assert (($packet.declaration|ConvertTo-Json -Depth 100 -Compress) -ceq ($parameters.windows.nativeCompaction|ConvertTo-Json -Depth 100 -Compress)) 'Original packet declaration changed'
 Maintenance-Assert (($packet.target|ConvertTo-Json -Depth 100 -Compress) -ceq ($parameters.windows.backingStorage|ConvertTo-Json -Depth 100 -Compress)) 'Original complete backing declaration changed'
 Maintenance-Assert (($packet.admission|ConvertTo-Json -Depth 100 -Compress) -ceq ($admission|ConvertTo-Json -Depth 100 -Compress)) 'Original packet admission changed'
 Maintenance-Assert ($admission.type -ceq 'WslNativeCompactionAdmission' -and $admission.version -eq 1 -and $admission.request -match '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') 'Wrong original admission'
 Maintenance-Assert ($packet.target.distributionName -ceq $parameters.windows.backingStorage.distributionName -and $packet.target.registryKey -ceq $parameters.windows.backingStorage.registryKey -and $packet.target.basePath -ceq $parameters.windows.backingStorage.basePath -and $packet.target.vhdFileName -ceq $parameters.windows.backingStorage.vhdFileName -and $packet.target.volumeId -ceq $parameters.windows.backingStorage.volumeId) 'Original target changed'
 Maintenance-Assert ($packet.qualification.adapter -ceq 'microsoft-wsl-3.0.3-native-exclusive-compaction' -and $packet.qualification.version -ceq '3.0.3.0' -and $packet.qualification.executable -ceq 'C:\Program Files\WSL\wsl.exe' -and $packet.qualification.service -ceq 'C:\Program Files\WSL\wslservice.exe' -and $packet.qualification.executableSha256 -ceq 'a452a35073c296230402af36e54dad1f408fa52b6ebd3cf9ba30bce8f9025621' -and $packet.qualification.serviceSha256 -ceq '262951e58df4bc82b63a79cbc64439c7d3ad7baa4344834442a5a82b2f9dd293') 'Unqualified original provider'
 Maintenance-Assert (($packet.qualification.sourceBlobs|ConvertTo-Json -Compress) -ceq (@('934a09bf49e70e8f5ac067584b0bedafa03c266f','9ea6a26a28e4ba114d817edfad6cbc67684aabea','39c10fef6bb995c065c4c898c5e047c1c7e16702','48b5c4fe89337f2b30897e8cdee52f865f6f354d')|ConvertTo-Json -Compress)) 'Original provider source qualification changed'
 Maintenance-Assert ($parameters.windows.nativeCompaction.adapter -ceq $packet.qualification.adapter -and $parameters.windows.nativeCompaction.deadlineMs -is [int] -and $parameters.windows.nativeCompaction.deadlineMs -ge 1000 -and $parameters.windows.nativeCompaction.deadlineMs -le 3600000 -and $parameters.windows.nativeCompaction.maxOutputBytes -is [int] -and $parameters.windows.nativeCompaction.maxOutputBytes -ge 1024 -and $parameters.windows.nativeCompaction.maxOutputBytes -le 131072 -and [decimal]$parameters.windows.backingStorage.policy.minFreeBytes -gt 0) 'Invalid original maintenance allocation'
 Maintenance-Assert ($packet.invocation.executable -ceq $packet.qualification.executable -and $packet.invocation.arguments -ceq ('--manage '+$packet.target.distributionName+' --compact')) 'Original invocation changed'
 Maintenance-Assert ($admission.resources.Count -eq 3) 'Missing original Resources'
 $roles=@{}
 foreach($resource in $admission.resources) {
  Maintenance-Assert ($resource.role -cin @('authority','checkpoint','independent-receiving') -and -not $roles.ContainsKey($resource.role)) 'Wrong original Resource role'
  $roles[$resource.role]=$true
  Maintenance-Assert ((Maintenance-HashBytes $files[($resource.role+'.resource.json')]) -ceq $resource.sha256) 'Original Resource bytes changed'
 }
 Maintenance-Assert ($intent.Type -ceq 'WslNativeCompactionIntent' -and $intent.Request -ceq $admission.request -and $intent.AdmissionSHA256 -ceq $admissionHash -and $intent.WindowsOwnerSID -ceq $parameters.windows.nativeCompaction.ownerSid -and $intent.WindowsParentPID -is [int] -and $intent.WindowsParentPID -gt 0) 'Original intent mismatch'
 Maintenance-Assert ($intent.Invocation.executable -ceq $packet.invocation.executable -and $intent.Invocation.arguments -ceq $packet.invocation.arguments) 'Intent invocation changed'
 Maintenance-Assert ($result.Type -ceq 'WslNativeCompactionOutcome' -and $result.Status -ceq 'terminal-confirmed' -and $result.Request -ceq $admission.request -and $result.AdmissionSHA256 -ceq $admissionHash -and $result.Success -is [bool] -and $result.Success -ceq $true -and $result.CapacityReopened -is [bool] -and $result.CapacityReopened -ceq $false -and $result.GuestReentryAdmitted -is [bool] -and $result.GuestReentryAdmitted -ceq $false) 'Original terminal is not qualified success'
 $native=$result.Native
 Maintenance-Assert ($native.Pid -is [int] -and $native.Pid -gt 0 -and $pidRecord.pid -is [int] -and $pidRecord.pid -eq $native.Pid -and $pidRecord.startedAt -ceq $native.StartedAt -and $native.Exit -is [int] -and $native.Exit -ceq 0 -and $native.WithinDeadline -is [bool] -and $native.WithinDeadline -ceq $true -and $native.PSObject.Properties.Name -contains 'PidError' -and $null -eq $native.PidError) 'Missing/mismatched PID or failed/late native terminal'
 $start=Maintenance-Time $native.StartedAt;$terminal=Maintenance-Time $native.TerminalAt;$intentAt=Maintenance-Time $intent.At
 $notBefore=Maintenance-Time $admission.notBefore;$expires=Maintenance-Time $admission.expiresAt;$at=Maintenance-Time $result.At
 Maintenance-Assert (($expires-$notBefore).TotalMilliseconds -gt 0 -and ($expires-$notBefore).TotalMilliseconds -le 600000 -and $intentAt -ge $notBefore -and $start -ge $intentAt -and $start -lt $expires -and $terminal -ge $start -and ($terminal-$start).TotalMilliseconds -le $parameters.windows.nativeCompaction.deadlineMs -and $at -ge $terminal -and $at -le [DateTimeOffset]::UtcNow) 'Original native deadline/clock mismatch'
 $targetPath=[IO.Path]::Combine($packet.target.basePath,$packet.target.vhdFileName)
 foreach($observation in @($intent.Before,$result.Before,$result.After)) {
  Maintenance-Assert ($observation.Path -ieq $targetPath -and $observation.Volume -ieq $packet.target.volumeId -and $observation.FileIdentity -cmatch '^[a-f0-9]{8}:[a-f0-9]{16}$' -and $observation.FileIdentity -ceq $intent.Before.FileIdentity) 'Original VHD identity drift'
  foreach($field in @('LengthBytes','VolumeFreeBytes','CallerAvailableBytes')) {Maintenance-Assert ($observation.$field -match '^(0|[1-9][0-9]{0,23})$') 'Invalid original byte observation'}
 }
 Maintenance-Assert (($intent.Before|ConvertTo-Json -Compress) -ceq ($result.Before|ConvertTo-Json -Compress)) 'Original before observation changed'
 foreach($stream in @(@{Key='Stdout';File='stdout.bin'},@{Key='Stderr';File='stderr.bin'})) {
  $e=$native.($stream.Key)
  Maintenance-Assert ($e.Overflow -is [bool] -and $e.Overflow -ceq $false -and $e.PSObject.Properties.Name -contains 'Error' -and $null -eq $e.Error -and ($e.TotalBytes -is [int] -or $e.TotalBytes -is [long]) -and $e.TotalBytes -ge 0 -and $e.TotalBytes -le $parameters.windows.nativeCompaction.maxOutputBytes -and $e.TotalBytes -eq $files[$stream.File].Length) 'Native stream missing/overflow/error'
 }
 return [pscustomobject]@{Request=$admission.request;OutcomeSHA256=(Maintenance-HashBytes $files['result.json']);AdmissionSHA256=$admissionHash;ParameterSHA256=$parameterHash;Result=$result;Packet=$packet}
}
function Read-MaintenanceBundle([string]$directory,$retainLocks=$null) {
 $bundle=[ordered]@{};$locks=[Collections.Generic.List[object]]::new()
 try {
  foreach($name in @('packet.json','parameters.json','admission.json','started.json','native-pid.json','result.json','stdout.bin','stderr.bin','authority.resource.json','checkpoint.resource.json','independent-receiving.resource.json')) {
   $path=Join-Path $directory $name;No-Redirect $path
   $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);$locks.Add($stream)
   Maintenance-Assert ($stream.Length -le 1048576) 'Unbounded original custody file'
   $bytes=[byte[]]::new([int]$stream.Length);$offset=0
   while($offset -lt $bytes.Length){$n=$stream.Read($bytes,$offset,$bytes.Length-$offset);if($n -eq 0){throw 'Original custody changed'};$offset+=$n}
   $bundle[$name]=[Convert]::ToBase64String($bytes)
  }
  $null=Receive-MaintenanceOutcome ([pscustomobject]$bundle)
  return [pscustomobject]$bundle
 } finally {foreach($lock in $locks){if($null -ne $retainLocks){$retainLocks.Add($lock)}else{$lock.Dispose()}}}
}
function Read-MaintenanceClaim([string]$path) {
 No-Redirect $path;$stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 try{Maintenance-Assert ($stream.Length -eq 64) 'Malformed original request claim';$bytes=[byte[]]::new(64);$offset=0;while($offset -lt 64){$n=$stream.Read($bytes,$offset,64-$offset);if($n -eq 0){throw 'Changed original request claim'};$offset+=$n};$value=[Text.UTF8Encoding]::new($false,$true).GetString($bytes);Maintenance-Assert ($value -cmatch '^[a-f0-9]{64}$') 'Malformed original claim digest';return $value}finally{$stream.Dispose()}
}
function Read-MaintenanceSmallBytes([string]$path) {
 No-Redirect $path;$stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 try{Maintenance-Assert ($stream.Length -le 131072) 'Unbounded original transfer custody';$bytes=[byte[]]::new([int]$stream.Length);$offset=0;while($offset -lt $bytes.Length){$n=$stream.Read($bytes,$offset,$bytes.Length-$offset);if($n -eq 0){throw 'Changed original transfer custody'};$offset+=$n};return ,$bytes}finally{$stream.Dispose()}
}
function Receive-MaintenanceGuestPersistence([string]$caller,$received) {
 $guest=Maintenance-Json (Read-MaintenanceSmallBytes (Join-Path $caller 'transfer-stdout.bin'))
 $expectedPath=$received.Packet.declaration.reentry.outputDirectory+'/'+$received.Request+'.windows-outcome.json'
 Maintenance-Assert ($guest.type -ceq 'WslNativeCompactionOutcomePersisted' -and $guest.request -ceq $received.Request -and $guest.outcomeSha256 -ceq $received.OutcomeSHA256 -and $guest.path -ceq $expectedPath -and $guest.capacityReopened -is [bool] -and $guest.capacityReopened -ceq $false -and $guest.holdsReleased -is [bool] -and $guest.holdsReleased -ceq $false -and $guest.chatResumed -is [bool] -and $guest.chatResumed -ceq $false) 'Original guest persistence unreceived'
 return $guest
}
function Receive-MaintenanceTransferOutcome([string]$caller,$received) {
 $claim=Read-MaintenanceClaim (Join-Path $caller 'transfer.claim')
 $result=Maintenance-Json (Read-MaintenanceSmallBytes (Join-Path $caller 'transfer-result.json'))
 $reentryBytes=Read-MaintenanceSmallBytes (Join-Path $caller 'reentry-admission.json');$reentry=Maintenance-Json $reentryBytes
 $pidRecord=Maintenance-Json (Read-MaintenanceSmallBytes (Join-Path $caller 'transfer-pid.json'));$n=$result.Native
 Maintenance-Assert ($claim -ceq $received.OutcomeSHA256 -and $result.Type -ceq 'WslNativeCompactionTransferOutcome' -and $result.Request -ceq $received.Request -and $result.OutcomeSHA256 -ceq $claim -and $result.ReentryAdmissionSHA256 -ceq (Maintenance-HashBytes $reentryBytes) -and $reentry.request -ceq $received.Request -and $reentry.outcomeSha256 -ceq $claim -and $result.Status -ceq 'terminal-confirmed' -and $result.Success -is [bool] -and $result.Success -ceq $true) 'Unresolved/failed original transfer custody'
 Maintenance-Assert ($n.Pid -is [int] -and $n.Pid -gt 0 -and $pidRecord.pid -is [int] -and $pidRecord.pid -eq $n.Pid -and $pidRecord.startedAt -ceq $n.StartedAt -and $n.Exit -is [int] -and $n.Exit -eq 0 -and $n.WithinDeadline -is [bool] -and $n.WithinDeadline -ceq $true -and $n.PSObject.Properties.Name -contains 'PidError' -and $n.PSObject.Properties.Name -contains 'InputError' -and $null -eq $n.PidError -and $null -eq $n.InputError) 'Unreceived original transfer PID/terminal'
 $start=Maintenance-Time $n.StartedAt;$terminal=Maintenance-Time $n.TerminalAt
 Maintenance-Assert ($start -ge (Maintenance-Time $reentry.notBefore) -and $start -lt (Maintenance-Time $reentry.expiresAt) -and $terminal -ge $start -and ($terminal-$start).TotalMilliseconds -le 120000 -and (Maintenance-Time $result.At) -ge $terminal) 'Late original transfer custody'
 foreach($stream in @(@{Key='Stdout';File='transfer-stdout.bin'},@{Key='Stderr';File='transfer-stderr.bin'})){$bytes=Read-MaintenanceSmallBytes (Join-Path $caller $stream.File);$e=$n.($stream.Key);Maintenance-Assert ($e.Overflow -is [bool] -and $e.Overflow -ceq $false -and $e.PSObject.Properties.Name -contains 'Error' -and $null -eq $e.Error -and ($e.TotalBytes -is [int] -or $e.TotalBytes -is [long]) -and $e.TotalBytes -ge 0 -and $e.TotalBytes -eq $bytes.Length) 'Failed original transfer stream'}
 $null=Receive-MaintenanceGuestPersistence $caller $received
 return $result
}
function Receive-MaintenancePriorLaunches([string]$root,[string]$currentRequest) {
 $callers=@(Get-ChildItem -LiteralPath $root -Filter '*.caller' -Directory -Force)
 Maintenance-Assert ($callers.Count -le 128) 'Bounded caller custody allocation exhausted'
 foreach($caller in $callers) {
  $request=$caller.Name.Substring(0,$caller.Name.Length-7)
  if($request -ceq $currentRequest){continue}
  $hasLaunch=Test-Path -LiteralPath (Join-Path $caller.FullName 'launch.claim');$hasTransfer=Test-Path -LiteralPath (Join-Path $caller.FullName 'transfer.claim');$hasContinuation=Test-Path -LiteralPath (Join-Path $caller.FullName 'continuation.claim')
  if($hasLaunch -or $hasTransfer -or $hasContinuation) {
   Maintenance-Assert ($request -match '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') 'Unrecognized original launch custody'
   No-Redirect $caller.FullName
   $received=Receive-MaintenanceOutcome (Read-MaintenanceBundle (Join-Path $root $request))
   Maintenance-Assert ($received.Request -ceq $request) 'Original caller request mismatch'
   if($hasLaunch){Maintenance-Assert ((Read-MaintenanceClaim (Join-Path $caller.FullName 'launch.claim')) -ceq $received.AdmissionSHA256) 'Unresolved original launch custody'}
   if($hasContinuation){Maintenance-Assert ($hasLaunch -and $hasTransfer -and (Read-MaintenanceClaim (Join-Path $caller.FullName 'continuation.claim')) -ceq $received.AdmissionSHA256) 'Unresolved original conditional continuation custody'}
   if($hasTransfer){$null=Receive-MaintenanceTransferOutcome $caller.FullName $received}
  }
 }
}
