# Finite same-user carrier. Actions are explicitly selected by owner source.
function No-Redirect([string]$path) {
 $current=$path
 while($current){$item=Get-Item -LiteralPath $current -Force;if($item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){throw 'Redirected maintenance custody'};$parent=[IO.Directory]::GetParent($current);if($null -eq $parent){break};$current=$parent.FullName}
}
function Private-MaintenanceDirectory([string]$path,[bool]$create=$false) {
 if(-not (Test-Path -LiteralPath $path)) {
  if(-not $create){throw 'Missing original private custody'}
  $parent=[IO.Directory]::GetParent($path).FullName;No-Redirect $parent
  $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner([Security.Principal.SecurityIdentifier]::new($sid));$acl.SetAccessRuleProtection($true,$false)
  foreach($id in @($sid,'S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($id),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
  [IO.Directory]::CreateDirectory($path,$acl)|Out-Null
 }
 No-Redirect $path;$item=Get-Item -LiteralPath $path -Force;Maintenance-Assert $item.PSIsContainer 'Custody is not a directory'
 $acl=Get-Acl -LiteralPath $path;Maintenance-Assert ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $sid) 'Foreign maintenance custody owner'
 $mask=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
 foreach($ace in $acl.Access){$id=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;if($ace.AccessControlType -eq 'Allow' -and ($ace.FileSystemRights -band $mask) -ne 0 -and $id -notin @($sid,'S-1-5-18','S-1-5-32-544')){throw 'Unreceived principal can write maintenance custody'}}
}
function Durable-MaintenanceBytes([string]$path,[byte[]]$bytes) {
 $stream=[IO.FileStream]::new($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
 try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Durable-MaintenanceText([string]$path,[string]$value){Durable-MaintenanceBytes $path ([Text.UTF8Encoding]::new($false).GetBytes($value))}
function Durable-MaintenancePrivateText([string]$path,[string]$value){
 $acl=[Security.AccessControl.FileSecurity]::new();$acl.SetOwner([Security.Principal.SecurityIdentifier]::new($sid));$acl.SetAccessRuleProtection($true,$false);foreach($id in @($sid,'S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($id),'FullControl','Allow'))}
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes($value);$stream=[IO.FileStream]::new($path,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::Write,[IO.FileShare]::Read,4096,[IO.FileOptions]::WriteThrough,$acl);try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
$held=[Collections.Generic.List[object]]::new()
function Read-MaintenanceFile([string]$path,[int]$limit=131072) {
 No-Redirect $path;$stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);$held.Add($stream)
 Maintenance-Assert ($stream.Length -le $limit) 'Unbounded original file'
 $bytes=[byte[]]::new([int]$stream.Length);$offset=0;while($offset -lt $bytes.Length){$n=$stream.Read($bytes,$offset,$bytes.Length-$offset);if($n -eq 0){throw 'Changed original file'};$offset+=$n};return ,$bytes
}
function Fresh-MaintenanceAdmission($admission) {
 $before=Maintenance-Time $admission.notBefore;$expires=Maintenance-Time $admission.expiresAt;$now=[DateTimeOffset]::UtcNow
 Maintenance-Assert (($expires-$before).TotalMilliseconds -gt 0 -and ($expires-$before).TotalMilliseconds -le 600000 -and $now -ge $before -and $now -lt $expires) 'Fresh original admission required'
}
function Read-BoundedMaintenanceText {
 [Console]::InputEncoding=[Text.UTF8Encoding]::new($false,$true)
 $builder=[Text.StringBuilder]::new();$chars=[char[]]::new(8192);$bytes=0
 while(($n=[Console]::In.Read($chars,0,$chars.Length)) -gt 0){$chunk=[string]::new($chars,0,$n);$bytes+=[Text.Encoding]::UTF8.GetByteCount($chunk);Maintenance-Assert ($bytes -le 131072) 'Bounded reentry preparation input';$null=$builder.Append($chunk)}
 return $builder.ToString()
}
function Receive-Caller {
 Private-MaintenanceDirectory $root;Private-MaintenanceDirectory $caller
 $manifest=Maintenance-Json (Read-MaintenanceFile (Join-Path $caller 'manifest.json'))
 Maintenance-Assert ($manifest.Request -ceq $packet.admission.request -and $manifest.AdmissionSHA256 -ceq $packet.admissionSha256 -and $manifest.ParameterSHA256 -ceq $packet.parameterSha256) 'Original caller manifest mismatch'
 Maintenance-Assert ($manifest.ParentSHA256 -ceq $inputPacket.parentSha256) 'Expected original parent source changed'
 Maintenance-Assert ((Maintenance-HashBytes (Read-MaintenanceFile (Join-Path $caller 'parent.ps1') 1048576)) -ceq $manifest.ParentSHA256) 'Private parent file changed'
 Maintenance-Assert ((Maintenance-HashBytes ([Text.Encoding]::UTF8.GetBytes($inputPacket.parameterText))) -ceq $packet.parameterSha256 -and (Maintenance-HashBytes ([Text.Encoding]::UTF8.GetBytes($inputPacket.admissionText))) -ceq $packet.admissionSha256) 'Original exact caller text changed'
 foreach($resource in $packet.admission.resources){Maintenance-Assert ($resource.path -ceq (Join-Path $caller ($resource.role+'.resource.json'))) 'Wrong caller Resource path';Maintenance-Assert ((Maintenance-HashBytes (Read-MaintenanceFile $resource.path)) -ceq $resource.sha256) 'Original caller Resource changed'}
 Maintenance-Assert ($manifest.TemplateSHA256 -ceq $inputPacket.templateSha256) 'Stable caller template changed'
 if($PSCommandPath){$name=[IO.Path]::GetFileName($PSCommandPath);$field=switch -CaseSensitive ($name){'read.ps1'{'ReaderSHA256'};'prepare-reentry.ps1'{'ReentryPreparerSHA256'};'transfer.ps1'{'TransferSHA256'};'continue.ps1'{'ContinuationSHA256'};default{throw 'Unreceived standalone caller file'}};Maintenance-Assert ($PSCommandPath -ceq (Join-Path $caller $name) -and (Maintenance-HashBytes (Read-MaintenanceFile $PSCommandPath 1048576)) -ceq $manifest.$field) 'Standalone caller file changed'}
 return $manifest
}
function Receive-ExpectedMaintenanceBundle {
 $bundle=Read-MaintenanceBundle (Join-Path $root $packet.admission.request) $held
 Maintenance-Assert ([Text.UTF8Encoding]::new($false,$true).GetString([Convert]::FromBase64String($bundle.'packet.json')) -ceq $inputPacket.packetText) 'Expected original packet differs'
 return $bundle
}
function Start-PrivateMaintenanceFile([string]$file) {
 # ShellExecute owns a separate Windows parent and inherits no WSL stdio pipes.
 # Only the received fixed PowerShell executable and literal private -File path.
 Maintenance-Assert ($file -match '^[A-Za-z]:\\[A-Za-z0-9 ._{}()@+\\-]+$') 'Unsafe private file path'
 $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe';$start.Arguments='-NoLogo -NoProfile -NonInteractive -File "'+$file+'"';$start.UseShellExecute=$true;$start.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden;$start.WorkingDirectory=[IO.Directory]::GetParent($file).FullName
 return [Diagnostics.Process]::Start($start)
}
function Receive-Reentry($received,$reentry,$resources) {
 Maintenance-Assert ($reentry.type -ceq 'WslNativeCompactionReentryAdmission' -and $reentry.version -eq 1 -and $reentry.request -ceq $received.Request -and $reentry.outcomeSha256 -ceq $received.OutcomeSHA256 -and $reentry.parameterSha256 -ceq $received.ParameterSHA256 -and $reentry.maintenanceAdmissionSha256 -ceq $received.AdmissionSHA256) 'Original reentry outcome mismatch'
 Fresh-MaintenanceAdmission $reentry
 $d=$parameters.windows.nativeCompaction.reentry
 Maintenance-Assert ($null -ne $d -and $d.linuxUser -match '^[a-z_][a-z0-9_-]{0,31}$' -and $d.node -match '^/gnu/store/[a-z0-9]+-node-[0-9.]+/bin/node$' -and $d.receiver -match '^/[A-Za-z0-9_./-]+/receive-native-compaction-outcome\.mjs$' -and $d.receiver -notmatch '/\.\.?/' -and $d.receiverSha256 -cmatch '^[a-f0-9]{64}$' -and $d.ownerUid -is [int] -and $d.ownerUid -ge 1000 -and $d.sectionRoot -match '^/[A-Za-z0-9_./-]+$' -and $d.sectionRoot -notmatch '/\.\.?(/|$)' -and $d.outputDirectory.StartsWith($d.sectionRoot+'/data/logs/',[StringComparison]::Ordinal) -and $d.outputDirectory -match '^/[A-Za-z0-9_./-]+$' -and $d.outputDirectory -notmatch '/\.\.?(/|$)') 'Exact qualified guest receiver required'
 $closure=@('scripts/receive-native-compaction-outcome.mjs','src/native-maintenance-caller.mjs','src/native-compaction.mjs','src/backing-capacity.mjs','assets/native-compact.ps1','assets/native-compaction-outcome.ps1','assets/native-maintenance-caller.ps1','assets/observe-backing-capacity.ps1','assets/receive-backing-target.ps1')
 Maintenance-Assert (@($d.receiverClosure.PSObject.Properties).Count -eq $closure.Count) 'Complete original builtin receiver closure required'
 foreach($property in $d.receiverClosure.PSObject.Properties){Maintenance-Assert ($property.Name -cin $closure -and $property.Value -cmatch '^[a-f0-9]{64}$') 'Unqualified receiver closure member'}
 Maintenance-Assert ($d.receiverClosure.'scripts/receive-native-compaction-outcome.mjs' -ceq $d.receiverSha256) 'Receiver entry digest differs from original closure'
 $expected=@('--distribution',$packet.target.distributionName,'--user',$d.linuxUser,'--exec',$d.node,$d.receiver)
 Maintenance-Assert ($reentry.invocation.executable -ceq 'C:\Program Files\WSL\wsl.exe' -and ($reentry.invocation.argv|ConvertTo-Json -Compress) -ceq ($expected|ConvertTo-Json -Compress)) 'Reentry invocation changed'
 Maintenance-Assert ($reentry.resources.Count -eq 3) 'Missing reentry Resources'
 $roles=@{}
 foreach($resource in $reentry.resources){Maintenance-Assert ($resource.role -cin @('authority','checkpoint','independent-receiving') -and -not $roles.ContainsKey($resource.role)) 'Wrong reentry Resource role';$roles[$resource.role]=$true;Maintenance-Assert ($resource.path -ceq (Join-Path $caller ('reentry-'+$resource.role+'.resource.json'))) 'Wrong reentry Resource path';$bytes=[Text.UTF8Encoding]::new($false).GetBytes($resources.($resource.role));Maintenance-Assert ($bytes.Length -le 131072 -and (Maintenance-HashBytes $bytes) -ceq $resource.sha256) 'Changed reentry Resource bytes'}
 if($null -ne $d.continuation){$scope=Receive-ConditionalScope;$before=Maintenance-Time $reentry.notBefore;$expiry=Maintenance-Time $reentry.expiresAt;Maintenance-Assert ($expiry -le (Maintenance-Time $scope.Policy.expiresAt) -and ($expiry-$before).TotalMilliseconds -le $scope.Policy.reentryValidityMs -and $before -ge (Maintenance-Time $received.Result.At)) 'Conditional post-outcome receiving interval';$expectedDerived=New-ConditionalResources $scope $received $reentry.notBefore $reentry.expiresAt;foreach($role in @('authority','checkpoint','independent-receiving')){Maintenance-Assert (Same-MaintenanceValue ($resources.($role)|ConvertFrom-Json) $expectedDerived.($role)) 'Conditional derivation differs from actual prior facts'}}
 return $expected
}
function Exact-MaintenanceKeys($value,[string[]]$keys) {
 Maintenance-Assert ($null -ne $value -and ($value -is [pscustomobject] -or $value -is [Collections.IDictionary])) 'Semantic Resource object required'
 $actual=@($value.PSObject.Properties.Name);if($value -is [Collections.IDictionary]){$actual=@($value.Keys)}
 Maintenance-Assert (($actual|Sort-Object)-join ',' -ceq (($keys|Sort-Object)-join ',')) 'Semantic Resource schema differs'
}
function Same-MaintenanceValue($a,$b) {
 if($null -eq $a -or $null -eq $b){return ($null -eq $a -and $null -eq $b)}
 if($a -is [Collections.IDictionary] -or $a -is [pscustomobject]){
  $ak=@($a.PSObject.Properties.Name);if($a -is [Collections.IDictionary]){$ak=@($a.Keys)}
  $bk=@($b.PSObject.Properties.Name);if($b -is [Collections.IDictionary]){$bk=@($b.Keys)}
  if(($ak|Sort-Object)-join ',' -cne (($bk|Sort-Object)-join ',')){return $false};foreach($key in $ak){if(-not (Same-MaintenanceValue $a.$key $b.$key)){return $false}};return $true
 }
 if($a -is [Array]){if($b -isnot [Array] -or $a.Count -ne $b.Count){return $false};for($i=0;$i -lt $a.Count;$i++){if(-not (Same-MaintenanceValue $a[$i] $b[$i])){return $false}};return $true}
 return (($a|ConvertTo-Json -Compress) -ceq ($b|ConvertTo-Json -Compress))
}
function Receive-MaintenanceReference($value){Exact-MaintenanceKeys $value @('path','sha256');Maintenance-Assert ($value.path -is [string] -and $value.path.Length -le 1024 -and $value.path -cmatch '^/[A-Za-z0-9_./-]+$' -and $value.path -notmatch '/\.\.?(/|$)' -and $value.path -cmatch '/data/(records|logs|state)/' -and $value.sha256 -cmatch '^[a-f0-9]{64}$') 'Canonical original owner-data Resource reference required'}
function Receive-MaintenanceActor($value){Maintenance-Assert ($value -is [string] -and $value -cmatch '^https://[^\s/]+/actors/[^\s/]+$') 'Original addressed actor required'}
function Receive-ConditionalScope {
 $d=$packet.declaration.reentry;$p=$d.continuation
 Maintenance-Assert ($d.linuxUser -cmatch '^[a-z_][a-z0-9_-]{0,31}$' -and $d.node -cmatch '^/gnu/store/[a-z0-9]+-node-[0-9.]+/bin/node$' -and $d.receiver -cmatch '^/[A-Za-z0-9_./-]+/receive-native-compaction-outcome\.mjs$' -and $d.receiver -notmatch '/\.\.?/' -and $d.receiverSha256 -cmatch '^[a-f0-9]{64}$' -and $d.ownerUid -is [int] -and $d.ownerUid -ge 1000 -and $d.outputDirectory.StartsWith($d.sectionRoot+'/data/logs/',[StringComparison]::Ordinal)) 'Conditional exact original guest receiver required'
 $closure=@('scripts/receive-native-compaction-outcome.mjs','src/native-maintenance-caller.mjs','src/native-compaction.mjs','src/backing-capacity.mjs','assets/native-compact.ps1','assets/native-compaction-outcome.ps1','assets/native-maintenance-caller.ps1','assets/observe-backing-capacity.ps1','assets/receive-backing-target.ps1');Exact-MaintenanceKeys $d.receiverClosure $closure;foreach($property in $d.receiverClosure.PSObject.Properties){Maintenance-Assert ($property.Value -cmatch '^[a-f0-9]{64}$') 'Conditional source closure digest'};Maintenance-Assert ($d.receiverSha256 -ceq $d.receiverClosure.'scripts/receive-native-compaction-outcome.mjs') 'Conditional source entry differs'
 Exact-MaintenanceKeys $p @('mode','algorithm','templateSha256','expiresAt','reentryValidityMs','parentDeadlineMs')
 Maintenance-Assert ($p.mode -ceq 'one-successful-outcome-transfer' -and $p.algorithm -ceq 'wsl-native-complete-success-v1' -and $p.templateSha256 -ceq $inputPacket.templateSha256 -and $p.reentryValidityMs -is [int] -and $p.reentryValidityMs -ge 1 -and $p.reentryValidityMs -le 600000 -and $p.parentDeadlineMs -is [int] -and $p.parentDeadlineMs -ge $packet.declaration.deadlineMs -and $p.parentDeadlineMs -le 3660000) 'Conditional scope and stable template required'
 $expiry=Maintenance-Time $p.expiresAt;Maintenance-Assert ([DateTimeOffset]::UtcNow -lt $expiry -and $expiry -le (Maintenance-Time $packet.admission.expiresAt).AddMilliseconds($packet.declaration.deadlineMs+600000)) 'Conditional authority lifetime expired or excessive'
 $prior=[ordered]@{};$raw=[ordered]@{}
 foreach($role in @('authority','checkpoint','independent-receiving')){$bytes=Read-MaintenanceFile (Join-Path $caller ($role+'.resource.json'));$reference=@($packet.admission.resources|Where-Object {$_.role -ceq $role});Maintenance-Assert ($reference.Count -eq 1 -and (Maintenance-HashBytes $bytes) -ceq $reference[0].sha256) 'Original conditional Resource digest';$raw[$role]=$bytes;$prior[$role]=Maintenance-Json $bytes}
 $a=$prior.authority;$k=$prior.checkpoint;$i=$prior.'independent-receiving'
 foreach($pair in @(@('authority','Authority'),@('checkpoint','Checkpoint'),@('independent-receiving','Receiving'))){$v=$prior[$pair[0]];Maintenance-Assert ($v.type -ceq ('WslNativeCompactionConditional'+$pair[1]) -and $v.version -is [int] -and $v.version -eq 1 -and $v.request -ceq $packet.admission.request -and $v.parameterSha256 -ceq $packet.parameterSha256) 'Original conditional Resource subject'}
 Exact-MaintenanceKeys $a @('type','version','request','parameterSha256','holder','expiresAt','scope');Exact-MaintenanceKeys $a.holder @('actor','resource');Receive-MaintenanceActor $a.holder.actor;Receive-MaintenanceReference $a.holder.resource
 $invocation=[ordered]@{executable=$packet.qualification.executable;argv=@('--distribution',$packet.target.distributionName,'--user',$d.linuxUser,'--exec',$d.node,$d.receiver)}
 $expected=[ordered]@{mode=$p.mode;ownerSid=$packet.declaration.ownerSid;target=$packet.target;invocation=$invocation;receiverClosure=$d.receiverClosure;transferLimit=1}
 Maintenance-Assert ($a.expiresAt -ceq $p.expiresAt -and (Same-MaintenanceValue $a.scope $expected)) 'Conditional authority exact target/receiver scope'
 Exact-MaintenanceKeys $k @('type','version','request','parameterSha256','authoritySha256','checkpoint','holds','affectedWork','readiness','unknowns');Maintenance-Assert ($k.authoritySha256 -ceq (Maintenance-HashBytes $raw.authority)) 'Checkpoint authority changed';Receive-MaintenanceReference $k.checkpoint
 Maintenance-Assert ($k.holds -is [Array] -and $k.holds.Count -eq 4 -and (($k.holds.role|Sort-Object)-join ',') -ceq 'composer,host-ingress,host-main,selector') 'All original held subjects required'
 foreach($hold in $k.holds){Exact-MaintenanceKeys $hold @('role','resource','state');Receive-MaintenanceReference $hold.resource;$state='held-and-terminal';if($hold.role -ceq 'selector'){$state='boot-held'};Maintenance-Assert ($hold.state -ceq $state) 'Original hold/terminal receiving required'}
 Maintenance-Assert ($k.affectedWork -is [Array] -and $k.affectedWork.Count -ge 1 -and $k.affectedWork.Count -le 64) 'Original affected work required';foreach($workResource in $k.affectedWork){Receive-MaintenanceReference $workResource}
 Exact-MaintenanceKeys $k.readiness @('actor','answer','resource');Receive-MaintenanceActor $k.readiness.actor;Receive-MaintenanceReference $k.readiness.resource;Maintenance-Assert ($k.readiness.answer -ceq 'ready-for-selected-offline-maintenance') 'Actual human other-work readiness required'
 Maintenance-Assert ($k.unknowns -is [Array] -and $k.unknowns.Count -le 64) 'Retained original unknowns required';foreach($unknown in $k.unknowns){Maintenance-Assert ($unknown -is [string] -and $unknown.Length -gt 0 -and $unknown.Length -le 2048) 'Malformed original unknown'}
 Exact-MaintenanceKeys $i @('type','version','request','parameterSha256','authoritySha256','checkpointSha256','algorithm','templateSha256','receiverClosure','receiver');Maintenance-Assert ($i.authoritySha256 -ceq (Maintenance-HashBytes $raw.authority) -and $i.checkpointSha256 -ceq (Maintenance-HashBytes $raw.checkpoint) -and $i.algorithm -ceq $p.algorithm -and $i.templateSha256 -ceq $p.templateSha256 -and (Same-MaintenanceValue $i.receiverClosure $d.receiverClosure)) 'Exact independent algorithm/source receiving required';Exact-MaintenanceKeys $i.receiver @('actor','resource');Receive-MaintenanceActor $i.receiver.actor;Receive-MaintenanceReference $i.receiver.resource
 return [pscustomobject]@{Policy=$p;Prior=$prior;Raw=$raw;Invocation=$invocation}
}
function New-ConditionalResources($scope,$received,[string]$notBefore,[string]$expiresAt){
 $hashes=[ordered]@{};foreach($role in @('authority','checkpoint','independent-receiving')){$hashes[$role]=Maintenance-HashBytes $scope.Raw[$role]}
 $derived=[ordered]@{};foreach($role in @('authority','checkpoint','independent-receiving')){$derived[$role]=[ordered]@{type='WslNativeCompactionDerivedReentryResource';version=1;role=$role;request=$received.Request;parameterSha256=$received.ParameterSHA256;maintenanceAdmissionSha256=$received.AdmissionSHA256;outcomeSha256=$received.OutcomeSHA256;originalResource=@($packet.admission.resources|Where-Object {$_.role -ceq $role})[0];priorResourceSha256=$hashes;algorithm=$scope.Policy.algorithm;observedAt=$notBefore;expiresAt=$expiresAt;invocation=$scope.Invocation;receiverClosure=$packet.declaration.reentry.receiverClosure;capacityReopened=$false;holdsReleased=$false;chatResumed=$false;applicationDrained=$false}}
 return $derived
}
function Await-MaintenanceFileParent($process,[int]$deadline,[string]$role){
 $started=[DateTime]::UtcNow.ToString('o');$pidValue=$process.Id
 $pidError=$null;try{Durable-MaintenanceText (Join-Path $caller ($role+'-pid.json')) ([ordered]@{pid=$pidValue;startedAt=$started}|ConvertTo-Json -Compress)}catch{$pidError=$_.Exception.Message}
 $within=$process.WaitForExit($deadline);if(-not $within){$process.WaitForExit()}
 $result=[ordered]@{pid=$pidValue;startedAt=$started;terminalAt=[DateTime]::UtcNow.ToString('o');exit=$process.ExitCode;withinDeadline=$within;pidError=$pidError};$process.Dispose()
 Durable-MaintenanceText (Join-Path $caller ($role+'-terminal.json')) ($result|ConvertTo-Json -Compress)
 Maintenance-Assert ($within -and $result.exit -eq 0 -and $null -eq $pidError) 'Original Windows caller child unreceived';return $result
}
function Receive-CurrentMaintenanceProvider {
 foreach($provider in @(@{Path=$packet.qualification.executable;Hash=$packet.qualification.executableSha256},@{Path=$packet.qualification.service;Hash=$packet.qualification.serviceSha256})){Maintenance-Assert ((Maintenance-HashBytes (Read-MaintenanceFile $provider.Path 67108864)) -ceq $provider.Hash -and (Get-Item -LiteralPath $provider.Path).VersionInfo.ProductVersion -ceq $packet.qualification.version) 'Qualified reentry provider changed'}
}
function Receive-MaintenanceCustodyParent {
 $d=$parameters.windows.nativeCompaction;$c=$d.custodyPreparation;Exact-MaintenanceKeys $c @('existingParent','components')
 Maintenance-Assert ($d.ownerSid -ceq $sid -and $c.existingParent -cmatch '^[A-Za-z]:\\[A-Za-z0-9 ._{}()@+\\-]+$' -and [IO.Path]::GetFullPath($c.existingParent) -ceq $c.existingParent -and $c.components -is [Array] -and $c.components.Count -ge 1 -and $c.components.Count -le 8) 'Exact declared private owner hierarchy required'
 $selected=$c.existingParent;foreach($part in $c.components){Maintenance-Assert ($part -is [string] -and $part -cmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$' -and $part -notmatch '[.]$' -and $part -notmatch '^(con|prn|aux|nul|com[1-9]|lpt[1-9])([.]|$)') 'Literal bounded custody component required';$selected=Join-Path $selected $part}
 Maintenance-Assert ($selected -ceq $d.custodyDirectory) 'Custody hierarchy changed original target';No-Redirect $c.existingParent;Maintenance-Assert ((Get-Item -LiteralPath $c.existingParent -Force).PSIsContainer) 'Existing ancestor must be a directory'
 $acl=Get-Acl -LiteralPath $c.existingParent;$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;$writers=@()
 $mask=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
 foreach($ace in $acl.Access){if($ace.AccessControlType -eq 'Allow' -and ($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and ($ace.FileSystemRights -band $mask) -ne 0){$writers+=,$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}}
 return [ordered]@{type='WslNativeCompactionCustodyParentObservation';version=1;path=$c.existingParent;ownerSid=$sid;parentOwnerSid=$owner;effectiveWriterSids=@($writers|Sort-Object -Unique);fileIdentity=[WslMaintenanceTransfer]::DirectoryIdentity($c.existingParent);aclSha256=(Maintenance-HashBytes ([Text.Encoding]::UTF8.GetBytes($acl.Sddl)))}
}
function Invoke-MaintenanceCustodyPreparation {
 $parent=Receive-MaintenanceCustodyParent;if($inputPacket.action -ceq 'observe-custody'){return $parent}
 $receiving=Maintenance-Json ([Text.Encoding]::UTF8.GetBytes($inputPacket.receivingText));Exact-MaintenanceKeys $receiving @('type','version','parent','parameterSha256','custodyDirectory','templateSha256','receiver');Exact-MaintenanceKeys $receiving.receiver @('actor','resource');Receive-MaintenanceActor $receiving.receiver.actor;Receive-MaintenanceReference $receiving.receiver.resource
 Maintenance-Assert ($receiving.type -ceq 'WslNativeCompactionCustodyParentReceiving' -and $receiving.version -is [int] -and $receiving.version -eq 1 -and $receiving.parameterSha256 -ceq (Maintenance-HashBytes ([Text.Encoding]::UTF8.GetBytes($inputPacket.parameterText))) -and $receiving.custodyDirectory -ceq $parameters.windows.nativeCompaction.custodyDirectory -and $receiving.templateSha256 -ceq $inputPacket.templateSha256 -and (Same-MaintenanceValue $parent $receiving.parent)) 'Existing owner parent independently received identity/ACL changed'
 Receive-MaintenanceTrustedParent $parent
 $d=$parameters.windows.nativeCompaction;$receivingHash=Maintenance-HashBytes ([Text.Encoding]::UTF8.GetBytes($inputPacket.receivingText));$claim=Join-Path $parent.path ('.wsl-maintenance-custody-'+(Maintenance-HashBytes ([Text.Encoding]::UTF8.GetBytes($d.custodyDirectory)))+'.claim');$result=$claim+'.result.json'
 if(Test-Path -LiteralPath $claim){Maintenance-Assert ((Read-MaintenanceClaim $claim) -ceq $receivingHash -and (Test-Path -LiteralPath $result)) 'Unknown or different original custody preparation';$prior=Maintenance-Json (Read-MaintenanceSmallBytes $result);Maintenance-Assert ($prior.status -ceq 'completed' -and $prior.receivingSha256 -ceq $receivingHash -and $prior.custodyDirectory -ceq $d.custodyDirectory -and (Same-MaintenanceValue $prior.parent $parent)) 'Partial original custody preparation remains held';$path=$parent.path;foreach($part in $d.custodyPreparation.components){$path=Join-Path $path $part;Private-MaintenanceDirectory $path};return [ordered]@{type='WslNativeCompactionCustodyPrepared';status='received-without-writes';custodyDirectory=$d.custodyDirectory;originalReceipt=$result;effectsExecuted=$false}}
 Durable-MaintenancePrivateText $claim $receivingHash
 Durable-MaintenancePrivateText ($claim+'.started.json') ([ordered]@{type='WslNativeCompactionCustodyPreparationIntent';parent=$parent;receivingText=$inputPacket.receivingText;parameterSha256=(Maintenance-HashBytes ([Text.Encoding]::UTF8.GetBytes($inputPacket.parameterText)));custodyDirectory=$d.custodyDirectory}|ConvertTo-Json -Depth 20 -Compress)
 $created=@();try{$path=$parent.path;foreach($part in $d.custodyPreparation.components){$path=Join-Path $path $part;$existed=Test-Path -LiteralPath $path;Private-MaintenanceDirectory $path $true;if(-not $existed){$created+=,$path}}
  Maintenance-Assert (Same-MaintenanceValue $parent (Receive-MaintenanceCustodyParent)) 'Original parent changed during data preparation'
  $receipt=[ordered]@{type='WslNativeCompactionCustodyPrepared';status='completed';parent=$parent;receivingSha256=$receivingHash;custodyDirectory=$d.custodyDirectory;created=$created;effectsExecuted=$false};Durable-MaintenancePrivateText $result ($receipt|ConvertTo-Json -Depth 20 -Compress);return $receipt
 }catch{$failure=[ordered]@{type='WslNativeCompactionCustodyPrepared';status='partial-unknown';parent=$parent;receivingSha256=$receivingHash;custodyDirectory=$d.custodyDirectory;created=$created;error=$_.Exception.Message;effectsExecuted=$false};if(-not (Test-Path -LiteralPath $result)){Durable-MaintenancePrivateText $result ($failure|ConvertTo-Json -Depth 20 -Compress)};throw}
}
function Receive-MaintenanceTrustedParent($parent){
 $trusted=@($sid,'S-1-5-18','S-1-5-32-544');Maintenance-Assert ($parent.ownerSid -ceq $sid -and $parent.parentOwnerSid -cin $trusted) 'Unreceived existing ancestor owner';foreach($writer in $parent.effectiveWriterSids){Maintenance-Assert ($writer -cin $trusted) 'Unreceived existing ancestor writer'}
}
function Receive-CurrentMaintenanceTarget($received) {
 No-Redirect ([IO.Path]::Combine($packet.target.basePath,$packet.target.vhdFileName))
 $current=Receive-MaintenanceBackingTarget $packet
 Maintenance-Assert ($current.FileIdentity -ceq $received.Result.After.FileIdentity) 'Current reentry VHD file/volume identity changed'
}

function Invoke-ConditionalMaintenance {
  $null=Receive-Caller;Fresh-MaintenanceAdmission $packet.admission;$scope=Receive-ConditionalScope
  Maintenance-Assert ((Read-MaintenanceClaim (Join-Path $caller 'launch.claim')) -ceq $packet.admissionSha256) 'Original launch claim missing or changed'
  # Bounded Windows-to-Windows acknowledgement, before any offline child.
  $ackPath=Join-Path $caller 'launch-acknowledgement.json';$ackClock=[Diagnostics.Stopwatch]::StartNew();while(-not (Test-Path -LiteralPath $ackPath) -and $ackClock.ElapsedMilliseconds -lt 5000){Start-Sleep -Milliseconds 20}
  $ack=Maintenance-Json (Read-MaintenanceFile $ackPath);Maintenance-Assert ($ack.Type -ceq 'WslNativeCompactionFileLaunch' -and $ack.Request -ceq $packet.admission.request -and $ack.WindowsParentPID -eq $PID -and $ack.AdmissionSHA256 -ceq $packet.admissionSha256 -and $ack.ParentSHA256 -ceq $inputPacket.parentSha256) 'Original continuation launch acknowledgement unreceived'
  Maintenance-Assert (-not (Test-Path -LiteralPath (Join-Path $caller 'transfer.claim')) -and -not (Test-Path -LiteralPath (Join-Path $caller 'reentry-admission.json'))) 'Occupied original reentry custody'
  Durable-MaintenanceText (Join-Path $caller 'continuation.claim') $packet.admissionSha256
  Durable-MaintenanceText (Join-Path $caller 'continuation-holder.json') ([ordered]@{pid=$PID;ownerSid=$sid;request=$packet.admission.request;at=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json -Compress)
  $parent=Start-PrivateMaintenanceFile (Join-Path $caller 'parent.ps1');$parentTerminal=Await-MaintenanceFileParent $parent $scope.Policy.parentDeadlineMs 'conditional-parent'
  $bundle=Receive-ExpectedMaintenanceBundle;$received=Receive-MaintenanceOutcome $bundle
  $intent=Maintenance-Json ([Convert]::FromBase64String($bundle.'started.json'));Maintenance-Assert ($intent.WindowsParentPID -eq $parentTerminal.pid) 'Actual original Windows parent PID mismatch'
  $scope=Receive-ConditionalScope;Receive-CurrentMaintenanceProvider;Receive-CurrentMaintenanceTarget $received
  $now=[DateTimeOffset]::UtcNow;$expiry=$now.AddMilliseconds($scope.Policy.reentryValidityMs);$overall=Maintenance-Time $scope.Policy.expiresAt;if($expiry -gt $overall){$expiry=$overall};Maintenance-Assert ($expiry -gt $now) 'Expired conditional authority'
  $notBefore=$now.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');$expiresAt=$expiry.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  $derived=New-ConditionalResources $scope $received $notBefore $expiresAt;$resources=[ordered]@{};$references=@()
  foreach($role in @('authority','checkpoint','independent-receiving')){$resources[$role]=$derived[$role]|ConvertTo-Json -Depth 30 -Compress;$references+=@{role=$role;path=(Join-Path $caller ('reentry-'+$role+'.resource.json'));sha256=(Maintenance-HashBytes ([Text.Encoding]::UTF8.GetBytes($resources[$role])))}}
  $receiving=[ordered]@{type='WslNativeCompactionConditionalOutcomeReceiving';version=1;request=$received.Request;outcomeSha256=$received.OutcomeSHA256;algorithm=$scope.Policy.algorithm;observedAt=$notBefore;priorResourceSha256=$derived.authority.priorResourceSha256;priorFacts='original-pre-offline-receiving';capacityReopened=$false;holdsReleased=$false;chatResumed=$false;applicationDrained=$false}
  Durable-MaintenanceText (Join-Path $caller 'conditional-outcome-receiving.json') ($receiving|ConvertTo-Json -Depth 20 -Compress)
  $reentry=[ordered]@{type='WslNativeCompactionReentryAdmission';version=1;request=$received.Request;outcomeSha256=$received.OutcomeSHA256;parameterSha256=$received.ParameterSHA256;maintenanceAdmissionSha256=$received.AdmissionSHA256;notBefore=$notBefore;expiresAt=$expiresAt;invocation=$scope.Invocation;resources=$references};$null=Receive-Reentry $received $reentry $resources
  foreach($resource in $references){Durable-MaintenanceText $resource.path $resources[$resource.role]};Durable-MaintenanceText (Join-Path $caller 'reentry-admission.json') ($reentry|ConvertTo-Json -Depth 30 -Compress)
  # Existing original transfer owns its exclusive claim, provider/target locks,
  # bounded stdin and actual native terminal receiving. No second actuator.
  $manifest=Receive-Caller;Maintenance-Assert ((Maintenance-HashBytes (Read-MaintenanceFile (Join-Path $caller 'transfer.ps1') 1048576)) -ceq $manifest.TransferSHA256) 'Original transfer source changed'
  $transfer=Start-PrivateMaintenanceFile (Join-Path $caller 'transfer.ps1');$null=Await-MaintenanceFileParent $transfer 180000 'conditional-transfer'
  $null=Receive-MaintenanceTransferOutcome $caller $received
}
# The transfer helper has no compaction entry. Its two drains retain bounded
# bytes while continuing to consume both streams; deadlines never kill/retry.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Diagnostics;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class WslMaintenanceTransfer {
 [StructLayout(LayoutKind.Sequential)] public struct FileInfo {
  public uint Attributes;public System.Runtime.InteropServices.ComTypes.FILETIME Created,Accessed,Written;
  public uint VolumeSerial,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
 }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint mode,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetFileInformationByHandle(SafeFileHandle file,out FileInfo info);
 public static string Identity(string path){return EntryIdentity(path,false);}
 public static string DirectoryIdentity(string path){return EntryIdentity(path,true);}
 static string EntryIdentity(string path,bool directory){using(var file=CreateFile(path,0x80,7,IntPtr.Zero,3,0x00200000u|(directory?0x02000000u:0u),IntPtr.Zero)){FileInfo info;if(file.IsInvalid||!GetFileInformationByHandle(file,out info))throw new System.ComponentModel.Win32Exception();if((info.Attributes&0x400u)!=0||((info.Attributes&0x10u)!=0)!=directory)throw new Exception("Redirected/wrong-kind original custody");return info.VolumeSerial.ToString("x8")+":"+info.IndexHigh.ToString("x8")+info.IndexLow.ToString("x8");}}
 public class StreamEvidence { public long TotalBytes; public bool Overflow; public string Error; }
 static async Task<StreamEvidence> Drain(Stream input,FileStream sink,int limit) {
  var evidence=new StreamEvidence();var bytes=new byte[8192];long kept=0;
  try {int n;while((n=await input.ReadAsync(bytes,0,bytes.Length))>0){evidence.TotalBytes+=n;int retain=(int)Math.Min(n,Math.Max(0,limit-kept));if(retain<n)evidence.Overflow=true;if(retain>0&&evidence.Error==null){try{await sink.WriteAsync(bytes,0,retain);sink.Flush(true);kept+=retain;}catch(Exception e){evidence.Error=e.Message;}}}}
  catch(Exception e){evidence.Error=e.Message;}finally{sink.Dispose();}return evidence;
 }
 static void Durable(string file,string value){using(var f=new FileStream(file,FileMode.CreateNew,FileAccess.Write,FileShare.Read)){var b=new System.Text.UTF8Encoding(false).GetBytes(value);f.Write(b,0,b.Length);f.Flush(true);}}
 public class Outcome { public int Pid,Exit;public bool WithinDeadline;public string StartedAt,TerminalAt,PidError,InputError;public StreamEvidence Stdout,Stderr; }
 public static Outcome Await(string executable,string arguments,byte[] input,string directory,int deadline,int limit) {
  if(input.Length>131072)throw new Exception("Bounded modern result stdin required");
  using(var stdout=new FileStream(Path.Combine(directory,"transfer-stdout.bin"),FileMode.CreateNew,FileAccess.Write,FileShare.Read))
  using(var stderr=new FileStream(Path.Combine(directory,"transfer-stderr.bin"),FileMode.CreateNew,FileAccess.Write,FileShare.Read))
  using(var p=new Process()){
   p.StartInfo=new ProcessStartInfo(executable,arguments){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
   var o=new Outcome{StartedAt=DateTime.UtcNow.ToString("o")};var clock=Stopwatch.StartNew();if(!p.Start())throw new Exception("Original transfer did not start");o.Pid=p.Id;
   var a=Drain(p.StandardOutput.BaseStream,stdout,limit);var b=Drain(p.StandardError.BaseStream,stderr,limit);
   try{Durable(Path.Combine(directory,"transfer-pid.json"),"{\"pid\":"+o.Pid+",\"startedAt\":\""+o.StartedAt+"\"}");}catch(Exception e){o.PidError=e.Message;}
   try{var writing=p.StandardInput.BaseStream.WriteAsync(input,0,input.Length);while(!writing.IsCompleted){System.Threading.Thread.Sleep(100);}writing.GetAwaiter().GetResult();}catch(Exception e){o.InputError=e.Message;}finally{try{p.StandardInput.Close();}catch(Exception e){o.InputError=e.Message;}}
   int remaining=(int)Math.Max(0,deadline-clock.ElapsedMilliseconds);o.WithinDeadline=p.WaitForExit(remaining)&&clock.ElapsedMilliseconds<=deadline;
   while(!p.WaitForExit(30000)){}o.Exit=p.ExitCode;o.TerminalAt=DateTime.UtcNow.ToString("o");o.Stdout=a.GetAwaiter().GetResult();o.Stderr=b.GetAwaiter().GetResult();return o;
  }
 }
}
'@
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$parameters=Maintenance-Json ([Text.Encoding]::UTF8.GetBytes($inputPacket.parameterText))
if($inputPacket.action -cin @('observe-custody','prepare-custody')){try{Invoke-MaintenanceCustodyPreparation|ConvertTo-Json -Depth 30 -Compress}finally{foreach($stream in $held){$stream.Dispose()}};return}
$packet=Maintenance-Json ([Text.UTF8Encoding]::new($false).GetBytes($inputPacket.packetText))
Maintenance-Assert ($sid -ceq $packet.declaration.ownerSid) 'Actual Windows holder identity differs'
$root=$packet.declaration.custodyDirectory;$caller=Join-Path $root ($packet.admission.request+'.caller')
Maintenance-Assert ($caller -ceq $inputPacket.callerDirectory) 'Changed original caller directory'
try {
 switch -CaseSensitive ($inputPacket.action) {
 'prepare' {
  Fresh-MaintenanceAdmission $packet.admission;Private-MaintenanceDirectory $root $true
  Maintenance-Assert (-not (Test-Path -LiteralPath $caller)) 'Occupied original caller custody'
  # Exclusive file claim makes a racing/partial preparation permanently visible.
  Durable-MaintenanceText ($caller+'.preparation-claim') $packet.admissionSha256
  Private-MaintenanceDirectory $caller $true
  foreach($resource in $packet.admission.resources){Maintenance-Assert ($resource.path -ceq (Join-Path $caller ($resource.role+'.resource.json'))) 'Wrong preparation Resource path';$bytes=[Convert]::FromBase64String($inputPacket.resources.($resource.role));Maintenance-Assert ((Maintenance-HashBytes $bytes) -ceq $resource.sha256 -and $bytes.Length -le 131072) 'Original Resource digest changed';Durable-MaintenanceBytes $resource.path $bytes}
  $parentBytes=[Text.Encoding]::UTF8.GetBytes($inputPacket.parent);Maintenance-Assert ((Maintenance-HashBytes $parentBytes) -ceq $inputPacket.parentSha256) 'Rendered parent digest changed'
  Durable-MaintenanceBytes (Join-Path $caller 'parent.ps1') $parentBytes
  foreach($file in @(@{Name='read.ps1';Text=$inputPacket.reader},@{Name='prepare-reentry.ps1';Text=$inputPacket.reentryPreparer},@{Name='transfer.ps1';Text=$inputPacket.transfer})){Durable-MaintenanceText (Join-Path $caller $file.Name) $file.Text}
  $continuationHash=$null;if($null -ne $packet.declaration.reentry.continuation){$null=Receive-ConditionalScope;Maintenance-Assert ($inputPacket.continuation -is [string]) 'Missing finite continuation source';Durable-MaintenanceText (Join-Path $caller 'continue.ps1') $inputPacket.continuation;$continuationHash=Maintenance-HashBytes ([Text.Encoding]::UTF8.GetBytes($inputPacket.continuation))}
  Durable-MaintenanceText (Join-Path $caller 'parameters.json') $inputPacket.parameterText;Durable-MaintenanceText (Join-Path $caller 'admission.json') $inputPacket.admissionText
  $manifest=[ordered]@{Type='WslNativeCompactionFileCustody';Request=$packet.admission.request;ParameterSHA256=$packet.parameterSha256;AdmissionSHA256=$packet.admissionSha256;ParentSHA256=$inputPacket.parentSha256;TemplateSHA256=$inputPacket.templateSha256;ContinuationSHA256=$continuationHash;ReaderSHA256=(Maintenance-HashBytes ([Text.Encoding]::UTF8.GetBytes($inputPacket.reader)));ReentryPreparerSHA256=(Maintenance-HashBytes ([Text.Encoding]::UTF8.GetBytes($inputPacket.reentryPreparer)));TransferSHA256=(Maintenance-HashBytes ([Text.Encoding]::UTF8.GetBytes($inputPacket.transfer)));OwnerSID=$sid;EffectsExecuted=$false}
  Durable-MaintenanceText (Join-Path $caller 'manifest.json') ($manifest|ConvertTo-Json -Compress);$manifest|ConvertTo-Json -Compress
 }
 'launch' {
  $manifest=Receive-Caller;Fresh-MaintenanceAdmission $packet.admission
  Maintenance-Assert ($manifest.ParentSHA256 -ceq $inputPacket.parentSha256) 'Independent parent-file receiving changed'
  $review=Maintenance-Json ([Text.Encoding]::UTF8.GetBytes($inputPacket.reviewText));Maintenance-Assert ($review.type -ceq 'WslNativeCompactionFileReceiving' -and $review.request -ceq $packet.admission.request -and $review.parentSha256 -ceq $manifest.ParentSHA256 -and $review.admissionSha256 -ceq $packet.admissionSha256) 'Missing independent exact-file receiving'
  $selectedFile='parent.ps1';if($null -ne $packet.declaration.reentry.continuation){$null=Receive-ConditionalScope;Maintenance-Assert ($review.continuationSha256 -ceq $manifest.ContinuationSHA256 -and (Maintenance-HashBytes (Read-MaintenanceFile (Join-Path $caller 'continue.ps1') 1048576)) -ceq $manifest.ContinuationSHA256) 'Independent complete continuation file changed';$selectedFile='continue.ps1'}
  Receive-MaintenancePriorLaunches $root $packet.admission.request
  Durable-MaintenanceText (Join-Path $caller 'launch.claim') $packet.admissionSha256
  $parent=Start-PrivateMaintenanceFile (Join-Path $caller $selectedFile)
  $ack=[ordered]@{Type='WslNativeCompactionFileLaunch';Request=$packet.admission.request;WindowsParentPID=$parent.Id;ParentSHA256=$manifest.ParentSHA256;AdmissionSHA256=$packet.admissionSha256;At=[DateTime]::UtcNow.ToString('o');State='parent-started; native outcome unreceived'}
  Durable-MaintenanceText (Join-Path $caller 'launch-acknowledgement.json') ($ack|ConvertTo-Json -Compress);$parent.Dispose();$ack|ConvertTo-Json -Compress
 }
 'read' {
  $null=Receive-Caller;$bundle=Receive-ExpectedMaintenanceBundle
  $bundle|ConvertTo-Json -Compress
 }
 'prepare-reentry' {
  Maintenance-Assert (-not (Test-Path -LiteralPath (Join-Path $caller 'continuation.claim'))) 'Original conditional receiving already owns preparation'
  $null=Receive-Caller;$bundle=Receive-ExpectedMaintenanceBundle;$received=Receive-MaintenanceOutcome $bundle
  if($null -ne $inputPacket.reentryText){$new=$inputPacket}else{$inputText=Read-BoundedMaintenanceText;$new=$inputText|ConvertFrom-Json}
  $reentry=$new.reentryText|ConvertFrom-Json;$null=Receive-Reentry $received $reentry $new.resources
  foreach($resource in $reentry.resources){Durable-MaintenanceText $resource.path $new.resources.($resource.role)}
  Durable-MaintenanceText (Join-Path $caller 'reentry-admission.json') $new.reentryText
  [ordered]@{Type='WslNativeCompactionReentryPrepared';Request=$received.Request;OutcomeSHA256=$received.OutcomeSHA256;EffectsExecuted=$false}|ConvertTo-Json -Compress
 }
 'transfer' {
  $null=Receive-Caller;$bundle=Receive-ExpectedMaintenanceBundle;$received=Receive-MaintenanceOutcome $bundle
  $reentryText=[Text.UTF8Encoding]::new($false,$true).GetString((Read-MaintenanceFile (Join-Path $caller 'reentry-admission.json')));$reentry=$reentryText|ConvertFrom-Json;$resources=[pscustomobject]@{}
  if($null -ne $inputPacket.reentryText){Maintenance-Assert ($inputPacket.reentryText -ceq $reentryText) 'Prepared reentry admission changed'}
  foreach($role in @('authority','checkpoint','independent-receiving')){$value=[Text.UTF8Encoding]::new($false,$true).GetString((Read-MaintenanceFile (Join-Path $caller ('reentry-'+$role+'.resource.json'))));$resources|Add-Member -NotePropertyName $role -NotePropertyValue $value}
  $argv=Receive-Reentry $received $reentry $resources
  # Lock and recheck the qualified direct provider before any guest start.
  Receive-CurrentMaintenanceProvider
  Receive-CurrentMaintenanceTarget $received
  $custody=[ordered]@{};foreach($property in $bundle.PSObject.Properties){if($property.Name -cnotin @('packet.json','parameters.json','admission.json')){$custody[$property.Name]=$property.Value}}
  $payload=[ordered]@{type='WslNativeCompactionOutcomeTransfer';version=1;parameterText=$inputPacket.parameterText;admissionText=$inputPacket.admissionText;packetSha256=(Maintenance-HashBytes ([Text.Encoding]::UTF8.GetBytes($inputPacket.packetText)));custody=$custody;reentryText=$reentryText;resources=$resources;receiverSha256=$parameters.windows.nativeCompaction.reentry.receiverSha256}|ConvertTo-Json -Depth 20 -Compress
  $bytes=[Text.Encoding]::UTF8.GetBytes($payload);Maintenance-Assert ($bytes.Length -le 131072) 'Bounded modern result stdin'
  Fresh-MaintenanceAdmission $reentry
  Durable-MaintenanceText (Join-Path $caller 'transfer.claim') $received.OutcomeSHA256
  $outcome=[WslMaintenanceTransfer]::Await($packet.qualification.executable,($argv -join ' '),$bytes,$caller,120000,131072)
  $success=($outcome.Exit -eq 0 -and $outcome.WithinDeadline -and -not $outcome.PidError -and -not $outcome.InputError -and -not $outcome.Stdout.Overflow -and -not $outcome.Stderr.Overflow -and -not $outcome.Stdout.Error -and -not $outcome.Stderr.Error)
  $failure=$null;if($success){try{$null=Receive-MaintenanceGuestPersistence $caller $received}catch{$success=$false;$failure=$_.Exception.Message}}
  $transferReceipt=[ordered]@{Type='WslNativeCompactionTransferOutcome';Status='terminal-confirmed';Request=$received.Request;OutcomeSHA256=$received.OutcomeSHA256;ReentryAdmissionSHA256=(Maintenance-HashBytes ([Text.Encoding]::UTF8.GetBytes($reentryText)));Native=$outcome;Success=$success;Failure=$failure;At=[DateTime]::UtcNow.ToString('o')}
  Durable-MaintenanceText (Join-Path $caller 'transfer-result.json') ($transferReceipt|ConvertTo-Json -Depth 8 -Compress)
  $null=Receive-MaintenanceTransferOutcome $caller $received
  $transferReceipt|ConvertTo-Json -Depth 8 -Compress
 }
 'continue' {Invoke-ConditionalMaintenance}
 default {throw 'Unknown finite maintenance caller action'}
 }
} finally {foreach($stream in $held){$stream.Dispose()}}
