# Exact derived Code entries only. The profile, provider and application stay.
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$stream=$null;$parent=$null;$held=@();$completed=0;$changed=0;$started=$false;$stage='identity';$identity=$null
function Need([bool]$ok,[string]$message){if(-not $ok){throw $message}}
function Check-Ancestors([string]$path){while($path){$item=Get-Item -LiteralPath $path -Force;Need ($item.PSIsContainer -and -not($item.Attributes-band1024)) 'Parent redirected';$up=[IO.Directory]::GetParent($path);if($null-eq$up){break};$path=$up.FullName}}
function Hash-Bytes([byte[]]$bytes){$h=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($h.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
function Assert-HeldFile($s,$sec,[string]$digest,[object[]]$streams,$t,[string]$native){
 Need ($s.Id-ceq$t.fileIdentity-and$s.AllocatedBytes-ceq$t.allocatedBytes-and$s.LogicalBytes-ceq$t.logicalBytes-and$s.Attributes-eq32-and$s.Links-eq1-and-not$s.DeletePending-and$s.FinalPath-ieq$native-and$sec.OwnerSid-ceq$expected.ownerSid) 'Held target native identity/content ownership changed'
 Need ($streams.Count-eq1-and$streams[0]-ceq('::$DATA|'+$t.logicalBytes)) 'Unqualified alternate stream would be lost'
 if($t.sha256){Need ($digest-ceq$t.sha256) 'Held original target digest changed'};if($t.sddlSha256){Need ($sec.SddlSha256-ceq$t.sddlSha256) 'Held original target security changed'}
 if($expected.action-ceq'retire'){Need ($t.sha256-and$t.sddlSha256) 'Retirement requires received content/security'}
}
function Check-Producer {
 $p=$expected.producer;$packages=@(Get-AppxPackage -Name OpenAI.Codex);Need ($packages.Count-eq1 -and $packages[0].PackageFullName-ceq$p.packageFullName -and $packages[0].InstallLocation-ieq$p.installLocation) 'Current original package changed'
 $f=[IO.File]::Open($p.makerPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 try{$null=$f.Seek([int64]$p.makerOffset,[IO.SeekOrigin]::Begin);$b=[byte[]]::new([int]$p.makerBytes);$at=0;while($at-lt$b.Length){$n=$f.Read($b,$at,$b.Length-$at);Need ($n-gt0) 'Original maker range incomplete';$at+=$n};Need ((Hash-Bytes $b)-ceq$p.makerSha256) 'Original cache maker changed'}finally{$f.Dispose()}
 foreach($file in $p.replacements){Need ((Get-FileHash -LiteralPath $file.path -Algorithm SHA256).Hash.ToLowerInvariant()-ceq$file.sha256) 'Retained local replacement changed'}
 $cli=@($p.replacements|Where-Object{$_.name-ceq'codex.exe'});Need ((Get-FileHash -LiteralPath $p.liveCliWindowsPath -Algorithm SHA256).Hash.ToLowerInvariant()-ceq$cli[0].sha256) 'Current managed CLI differs from retained supplier'
 foreach($g in $expected.configGuards){Need ((Get-FileHash -LiteralPath $g.path -Algorithm SHA256).Hash.ToLowerInvariant()-ceq$g.sha256) 'Original configured home selection changed'}
 foreach($scope in @('User','Machine','Process')){$v=[Environment]::GetEnvironmentVariable('CODEX_HOME',$scope);Need (-not$v -or -not$v.Replace('/','\').ToLowerInvariant().StartsWith($expected.cacheParentWindowsPath.Substring(0,$expected.cacheParentWindowsPath.Length-'\plugins\.plugin-appserver'.Length).ToLowerInvariant())) 'Managed home still selects old profile'}
 $refs=@();foreach($root in @('HKCU:\Software\Google\Chrome\NativeMessagingHosts','HKCU:\Software\Microsoft\Edge\NativeMessagingHosts','HKCU:\Software\Chromium\NativeMessagingHosts')){if(-not(Test-Path -LiteralPath $root)){continue};foreach($key in @(Get-ChildItem -LiteralPath $root)){$path=[string]$key.GetValue('');Need (-not$path -or $path.IndexOf($expected.cacheParentWindowsPath,[StringComparison]::OrdinalIgnoreCase)-lt0) 'Native host selects retired cache';if($key.PSChildName-match'openai|codex|chatgpt'){$m=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json;Need (-not([string]$m.path).Replace('/','\').ToLowerInvariant().StartsWith($expected.cacheParentWindowsPath.ToLowerInvariant())) 'Native host executable selects retired cache';$refs+=@{root=$root;name=$key.PSChildName;manifestSha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}}}}
 @{packageFullName=$packages[0].PackageFullName;makerSha256=$p.makerSha256;liveCliWindowsPath=$p.liveCliWindowsPath;nativeHosts=$refs}
}
try {
 $identity=[Security.Principal.WindowsIdentity]::GetCurrent();Need ($identity.User.Value-ceq$expected.ownerSid -and [Environment]::MachineName-ceq$expected.machineName -and $env:USERPROFILE-ieq$expected.profile) 'Original Windows owner/machine/profile changed'
 Need ([Environment]::GetFolderPath('LocalApplicationData')-ieq$expected.localAppDataWindowsPath) 'Original known-folder changed'
 Check-Ancestors $expected.cacheParentWindowsPath
 $output=[IO.Path]::Combine($expected.localAppDataWindowsPath,'Temp',('561-wsl-derived-code-'+$expected.nonce+'.jsonl'));Check-Ancestors ([IO.Path]::GetDirectoryName($output))
 $security=[Security.AccessControl.FileSecurity]::new();$security.SetAccessRuleProtection($true,$false);$sid=[Security.Principal.SecurityIdentifier]::new($expected.ownerSid);$security.SetOwner($sid);$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))
 $stream=[IO.FileStream]::new($output,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::Write,[IO.FileShare]::Read,4096,[IO.FileOptions]::WriteThrough,$security)
 function Receive-Step([hashtable]$row){$row.nonce=$expected.nonce;$row.parameterSha256=$expected.parameterSha256;$row.nativeProcessId=$PID;$row.actualOwnerSid=$identity.User.Value;$row.actualAdministrator=([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);$row.at=[DateTime]::UtcNow.ToString('o');$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($row|ConvertTo-Json -Depth 12 -Compress)+"`n");$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}
 $stage='native-primitive';Add-Type -TypeDefinition $nativeSource
 function Free-Point{[uint64]$a=0;[uint64]$t=0;[uint64]$f=0;Need ([OrphanSwapNative]::GetDiskFreeSpaceExW($expected.volumeId,[ref]$a,[ref]$t,[ref]$f)) 'Native free counters unknown';@{callerAvailableBytes=$a.ToString();volumeFreeBytes=$f.ToString();totalBytes=$t.ToString()}}
 function Check-Parent{$s=[OrphanSwapNative]::Read($parent);$sec=[OrphanSwapNative]::Security($parent);$native=$expected.volumeId+$expected.cacheParentWindowsPath.Substring([IO.Path]::GetPathRoot($expected.cacheParentWindowsPath).Length);Need (($s.Attributes-band16)-and-not($s.Attributes-band1024)-and-not$s.DeletePending-and$s.FinalPath-ieq$native-and$sec.OwnerSid-ceq$expected.ownerSid) 'Held original parent changed';if($expected.parentFileIdentity){Need ($s.Id-ceq$expected.parentFileIdentity-and$sec.SddlSha256-ceq$expected.parentSddlSha256) 'Held parent receipt changed'};@{fileIdentity=$s.Id;sddlSha256=$sec.SddlSha256;ownerSid=$sec.OwnerSid;finalPath=$s.FinalPath}}
 $stage='producer';$supplier=Check-Producer;$before=Free-Point
 $parent=[OrphanSwapNative]::CreateFileW($expected.cacheParentWindowsPath,0x20080,3,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero);Need (-not$parent.IsInvalid) 'Original no-delete parent handle refused';$parentReceipt=Check-Parent
 foreach($t in $expected.targets){
  $stage='exclusive-native-target';$path=[IO.Path]::Combine($expected.cacheParentWindowsPath,$t.name)
  $h=[OrphanSwapNative]::CreateFileW($path,[uint32]2147680384,0,[IntPtr]::Zero,3,0x00200000,[IntPtr]::Zero);$code=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
  $item=@{target=$t;path=$path;handle=$h;closed=$false;marked=$false;absent=$false};$held+=,$item
  if($h.IsInvalid){Need ($code-eq2) 'Exclusive native target handle refused';$item.absent=$true;continue}
  $s=[OrphanSwapNative]::Read($h);$sec=[OrphanSwapNative]::Security($h);$signature=[OrphanSwapNative]::Verify($h);Need ($signature.Subject-match'OpenAI OpCo') 'Held original vendor signer differs';$digest=[OrphanSwapNative]::Hash($h);$streams=@([OrphanSwapNative]::Streams($h));$native=$expected.volumeId+$path.Substring([IO.Path]::GetPathRoot($path).Length)
  Assert-HeldFile $s $sec $digest $streams $t $native
  $item.received=@{name=$t.name;fileIdentity=$s.Id;allocatedBytes=$s.AllocatedBytes;logicalBytes=$s.LogicalBytes;attributes=$s.Attributes;links=$s.Links;ownerSid=$sec.OwnerSid;sddlSha256=$sec.SddlSha256;sha256=$digest;streams=$streams;finalPath=$s.FinalPath;vendorSigner=$signature.Thumbprint;vendorSubject=$signature.Subject}
 }
 $stage='commit-fence';$supplier=Check-Producer;$null=Check-Parent
 foreach($i in $held){if(-not$i.absent){$s=[OrphanSwapNative]::Read($i.handle);$sec=[OrphanSwapNative]::Security($i.handle);$digest=[OrphanSwapNative]::Hash($i.handle);$streams=@([OrphanSwapNative]::Streams($i.handle));$bound=@{fileIdentity=$i.target.fileIdentity;allocatedBytes=$i.target.allocatedBytes;logicalBytes=$i.target.logicalBytes;sha256=$i.received.sha256;sddlSha256=$i.received.sddlSha256};Assert-HeldFile $s $sec $digest $streams $bound $i.received.finalPath}}
 Receive-Step @{phase='preflight';action=$expected.action;before=$before;parent=$parentReceipt;supplier=$supplier;targets=@($held|ForEach-Object{if($_.absent){@{name=$_.target.name;status='already-absent'}}else{$_.received}});ownerSid=$identity.User.Value;actualAdministrator=([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);unreceivedProcessImagesNotAssumedQuiet=$true}
 foreach($i in $held){
  if($expected.action-ceq'retire'){
   if(-not$i.absent){$stage='native-disposition';$started=$true;[OrphanSwapNative]::Delete($i.handle);$i.marked=$true;Receive-Step @{phase='file-marked';name=$i.target.name;fileIdentity=$i.target.fileIdentity};$i.handle.Dispose();$i.closed=$true;$changed++}
   $probe=[OrphanSwapNative]::CreateFileW($i.path,0x80,7,[IntPtr]::Zero,3,0x00200000,[IntPtr]::Zero);$absence=[Runtime.InteropServices.Marshal]::GetLastWin32Error();try{Need ($probe.IsInvalid-and$absence-eq2) 'Marked target terminal absence unreceived'}finally{$probe.Dispose()}
   $completed++;Receive-Step @{phase='file-terminal';name=$i.target.name;fileIdentity=$i.target.fileIdentity;nativeAbsenceCode=$absence;alreadyAbsent=$i.absent;allocatedBytes=$i.target.allocatedBytes}
  }
 }
 $after=Free-Point;Receive-Step @{phase='terminal';status=$(if($expected.action-ceq'retire'){'native-terminal-success'}else{'native-observed-without-disposition'});completedFiles=$completed;changedFiles=$changed;before=$before;after=$after;capacityReopened=$false}
}catch{
 $failure=$_;$row=@{phase='terminal';status=$(if($started){'partial-or-unknown'}else{'refused-before-disposition'});stage=$stage;nativeOpenCode=$(if($stage-ceq'exclusive-native-target'){$code}else{$null});nativeHResult=$failure.Exception.GetBaseException().HResult;completedFiles=$completed;changedFiles=$changed;error=$failure.Exception.Message;exceptionType=$failure.Exception.GetType().FullName;held=@($held|ForEach-Object{@{name=$_.target.name;marked=$_.marked;closed=$_.closed;alreadyAbsent=$_.absent}});capacityReopened=$false}
 if($null-ne$stream){try{Receive-Step $row}catch{Write-Output ($row|ConvertTo-Json -Depth 12 -Compress)}}else{$row.nonce=$expected.nonce;$row.parameterSha256=$expected.parameterSha256;$row.nativeProcessId=$PID;Write-Output ($row|ConvertTo-Json -Depth 12 -Compress)}
 throw $failure
}finally{foreach($i in $held){if(-not$i.closed-and$null-ne$i.handle){$i.handle.Dispose()}};if($null-ne$parent){$parent.Dispose()};if($null-ne$stream){$stream.Dispose()}}
