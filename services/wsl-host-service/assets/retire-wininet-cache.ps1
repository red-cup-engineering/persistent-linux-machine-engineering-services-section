# One native WinINet-owner entry only; retain the pending installer.
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$journal=$null;$parents=@();$held=@();$called=$false;$stage='identity';$identity=$null
function Need([bool]$ok,[string]$message){if(-not$ok){throw $message}}
function Ancestors([string]$p){while($p){$i=Get-Item -LiteralPath $p -Force;Need ($i.PSIsContainer-and-not($i.Attributes-band1024)) 'Parent redirected';$u=[IO.Directory]::GetParent($p);if($null-eq$u){break};$p=$u.FullName}}
function FreePoint{[uint64]$a=0;[uint64]$t=0;[uint64]$f=0;Need ([OrphanSwapNative]::GetDiskFreeSpaceExW($expected.volumeId,[ref]$a,[ref]$t,[ref]$f)) 'Native capacity unknown';@{callerAvailableBytes=$a.ToString();volumeFreeBytes=$f.ToString();totalBytes=$t.ToString()}}
function OwnerState{Need ((Get-FileHash -LiteralPath $expected.owner.updateStatePath -Algorithm SHA256).Hash.ToLowerInvariant()-ceq$expected.owner.updateStateSha256) 'Pending update state changed';$s=Get-Content -LiteralPath $expected.owner.updateStatePath -Raw|ConvertFrom-Json;Need ($s.state-eq3-and$s.downloadedInstallerFilename-ceq$expected.owner.pendingFilename) 'Pending installer no longer selected'}
function ParentPoint($t,$h){$s=[OrphanSwapNative]::Read($h);$sec=[OrphanSwapNative]::Security($h);$p=[IO.Path]::GetDirectoryName($t.path);$native=$expected.volumeId+$p.Substring([IO.Path]::GetPathRoot($p).Length);Need (($s.Attributes-band16)-and-not($s.Attributes-band1024)-and-not$s.DeletePending-and$s.FinalPath-ieq$native-and$sec.OwnerSid-ceq$expected.ownerSid) 'Held parent changed';if($t.parentFileIdentity){Need ($s.Id-ceq$t.parentFileIdentity-and$sec.SddlSha256-ceq$t.parentSddlSha256) 'Parent binding changed'};@{fileIdentity=$s.Id;sddlSha256=$sec.SddlSha256;ownerSid=$sec.OwnerSid;finalPath=$s.FinalPath}}
function FilePoint($t,$h){$s=[OrphanSwapNative]::Read($h);$sec=[OrphanSwapNative]::Security($h);$digest=[OrphanSwapNative]::Hash($h);$streams=@([OrphanSwapNative]::Streams($h));$native=$expected.volumeId+$t.path.Substring([IO.Path]::GetPathRoot($t.path).Length)
 Need ($s.Id-ceq$t.fileIdentity-and$s.AllocatedBytes-ceq$t.allocatedBytes-and$s.LogicalBytes-ceq$t.logicalBytes-and$s.Attributes-eq$t.attributes-and$s.Links-eq1-and-not$s.DeletePending-and$s.FinalPath-ieq$native-and$sec.OwnerSid-ceq$expected.ownerSid) 'Held installer identity/allocation/owner changed'
 Need ($streams.Count-eq1-and$streams[0]-ceq('::$DATA|'+$t.logicalBytes)) 'Installer alternate stream unqualified'
 if($t.sha256){Need ($digest-ceq$t.sha256) 'Installer digest changed'};if($t.sddlSha256){Need ($sec.SddlSha256-ceq$t.sddlSha256) 'Installer security changed'}
 $signer=[OrphanSwapNative]::Verify($h);Need ($signer.Subject-match'Microsoft Corporation') 'Held installer vendor signature differs'
 @{fileIdentity=$s.Id;allocatedBytes=$s.AllocatedBytes;logicalBytes=$s.LogicalBytes;attributes=$s.Attributes;links=$s.Links;ownerSid=$sec.OwnerSid;sddlSha256=$sec.SddlSha256;sha256=$digest;streams=$streams;finalPath=$s.FinalPath;vendorSigner=$signer.Thumbprint;vendorSubject=$signer.Subject}
}
try{
 $identity=[Security.Principal.WindowsIdentity]::GetCurrent();Need ($identity.User.Value-ceq$expected.ownerSid-and[Environment]::MachineName-ceq$expected.machineName-and$env:USERPROFILE-ieq$expected.profile) 'Windows original owner/machine/profile changed'
 Need ([Environment]::GetFolderPath('LocalApplicationData')-ieq$expected.localAppDataWindowsPath) 'Known folder changed'
 $out=[IO.Path]::Combine($expected.localAppDataWindowsPath,'Temp',('561-wsl-wininet-cache-'+$expected.nonce+'.jsonl'));Ancestors ([IO.Path]::GetDirectoryName($out))
 $sec=[Security.AccessControl.FileSecurity]::new();$sec.SetAccessRuleProtection($true,$false);$sid=[Security.Principal.SecurityIdentifier]::new($expected.ownerSid);$sec.SetOwner($sid);$sec.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))
 $journal=[IO.FileStream]::new($out,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::Write,[IO.FileShare]::Read,4096,[IO.FileOptions]::WriteThrough,$sec)
 function Receive([hashtable]$r){$r.nonce=$expected.nonce;$r.parameterSha256=$expected.parameterSha256;$r.nativeProcessId=$PID;$r.actualOwnerSid=$identity.User.Value;$r.actualAdministrator=([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);$r.at=[DateTime]::UtcNow.ToString('o');$b=[Text.UTF8Encoding]::new($false).GetBytes(($r|ConvertTo-Json -Depth 12 -Compress)+[char]10);$journal.Write($b,0,$b.Length);$journal.Flush($true)}
 $stage='native-primitive';Add-Type -TypeDefinition $nativeSource;Add-Type -TypeDefinition $cacheOwnerSource
 OwnerState;$before=FreePoint
 foreach($t in @($expected.pending,$expected.cache)){
  Ancestors ([IO.Path]::GetDirectoryName($t.path));$p=[OrphanSwapNative]::CreateFileW([IO.Path]::GetDirectoryName($t.path),0x20080,3,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero);$parents+=,$p;Need (-not$p.IsInvalid) 'Parent pin refused';$null=ParentPoint $t $p
 }
 $stage='pending-installer';$pending=[OrphanSwapNative]::CreateFileW($expected.pending.path,[uint32]2147614848,1,[IntPtr]::Zero,3,0x00200000,[IntPtr]::Zero);$held+=,$pending;Need (-not$pending.IsInvalid) 'Pending installer pin refused';$pendingPoint=FilePoint $expected.pending $pending
 $stage='cache-file';$cache=[OrphanSwapNative]::CreateFileW($expected.cache.path,[uint32]2147614848,5,[IntPtr]::Zero,3,0x00200000,[IntPtr]::Zero);$held+=,$cache;$openCode=[Runtime.InteropServices.Marshal]::GetLastWin32Error();$absent=$cache.IsInvalid-and$openCode-eq2
 Need ($absent-or-not$cache.IsInvalid) 'Cache handle refused';$cachePoint=$null;if(-not$absent){$cachePoint=FilePoint $expected.cache $cache;Need ($cachePoint.sha256-ceq$pendingPoint.sha256) 'Pending duplicate bytes differ'}
 $stage='cache-owner';$owner=[PowerToysCacheOwner]::Observe($expected.cache.path)
 if($absent){Need ($owner.Matches.Count-eq0) 'Absent cache retains unknown owner key'}else{Need ($owner.Matches.Count-eq1-and$owner.Matches[0].SourceUrlSha256-ceq$expected.cache.sourceUrlSha256-and$owner.Matches[0].SourceHost-ceq$expected.cache.sourceHost-and$owner.Matches[0].CacheEntryType-eq65-and$owner.Matches[0].UseCount-eq0-and$owner.Matches[0].LogicalBytes-eq[uint64]$expected.cache.logicalBytes) 'Native owner key/type/use changed'}
 OwnerState;$null=FilePoint $expected.pending $pending;$null=ParentPoint $expected.pending $parents[0];$null=ParentPoint $expected.cache $parents[1];if(-not$absent){$null=FilePoint $expected.cache $cache}
 Receive @{phase='preflight';action=$expected.action;before=$before;pending=$pendingPoint;cache=$cachePoint;cacheAlreadyAbsent=$absent;pendingParent=(ParentPoint $expected.pending $parents[0]);cacheParent=(ParentPoint $expected.cache $parents[1]);owner=$owner}
 if($expected.action-ceq'retire'-and-not$absent){
  $stage='native-owner-release';$called=$true;[PowerToysCacheOwner]::ReleaseExact($expected.cache.path,$expected.cache.sourceUrlSha256)
  $afterOwner=[OrphanSwapNative]::Read($cache);Need $afterOwner.DeletePending 'WinINet accepted but terminal delete remains unreceived';Receive @{phase='owner-release';fileIdentity=$expected.cache.fileIdentity;deletePending=$true};$cache.Dispose()
 }
 $after=FreePoint
 if($expected.action-ceq'retire'){
  $probe=[OrphanSwapNative]::CreateFileW($expected.cache.path,0x80,7,[IntPtr]::Zero,3,0x00200000,[IntPtr]::Zero);$code=[Runtime.InteropServices.Marshal]::GetLastWin32Error();try{Need ($probe.IsInvalid-and$code-eq2) 'WinINet cache terminal absence unreceived'}finally{$probe.Dispose()}
  $null=FilePoint $expected.pending $pending;OwnerState;Receive @{phase='terminal';status='native-terminal-success';nativeAbsenceCode=$code;alreadyAbsent=$absent;ownerCalled=$called;before=$before;after=$after;pendingInstallerPreserved=$true;capacityReopened=$false}
 }else{Receive @{phase='terminal';status='native-observed-without-disposition';before=$before;after=$after;ownerCalled=$false;capacityReopened=$false}}
}catch{$f=$_;$r=@{phase='terminal';status=$(if($called){'partial-or-pending'}else{'refused-before-owner-call'});stage=$stage;ownerCalled=$called;error=$f.Exception.Message;nativeHResult=$f.Exception.GetBaseException().HResult;capacityReopened=$false};if($null-ne$journal){Receive $r}else{$r.nonce=$expected.nonce;$r.parameterSha256=$expected.parameterSha256;$r.nativeProcessId=$PID;Write-Output ($r|ConvertTo-Json -Compress)};throw $f
}finally{foreach($h in $held){$h.Dispose()};foreach($h in $parents){$h.Dispose()};if($null-ne$journal){$journal.Dispose()}}

