# Original private outcome receiver. No target or output disposition.
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition $nativeSource
function Need([bool]$ok,[string]$message){if(-not$ok){throw $message}}
$h=[OrphanSwapNative]::CreateFileW($expected.path,[uint32]2147614848,0,[IntPtr]::Zero,3,0x00200000,[IntPtr]::Zero)
$stream=$null
try{
 Need (-not$h.IsInvalid) 'Original private outcome exclusive handle refused'
 $s=[OrphanSwapNative]::Read($h);$sec=[OrphanSwapNative]::Security($h)
 Need ($s.FinalPath-ieq$expected.finalPath-and$s.Links-eq1-and-not$s.DeletePending-and-not($s.Attributes-band1040)-and$sec.OwnerSid-ceq$expected.ownerSid) 'Original private outcome native identity/owner/type differs'
 $descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($sec.Sddl)
 Need (($descriptor.ControlFlags-band[Security.AccessControl.ControlFlags]::DiscretionaryAclProtected)-and$descriptor.DiscretionaryAcl.Count-eq1) 'Private owner-only DACL differs'
 $ace=$descriptor.DiscretionaryAcl[0];Need (([int]$ace.AceType -eq 0) -and (([int]$ace.AceFlags -band 16) -eq 0) -and ($ace.AccessMask -eq 2032127) -and ($ace.SecurityIdentifier.Value -ceq $expected.ownerSid)) 'Private outcome access differs'
 $digest=[OrphanSwapNative]::Hash($h);Need ($digest-ceq$expected.sha256) 'Private outcome content changed'
 $stream=[IO.FileStream]::new($h,[IO.FileAccess]::Read);$null=$stream.Seek(0,[IO.SeekOrigin]::Begin);$m=[IO.MemoryStream]::new();try{$stream.CopyTo($m);$bytes=$m.ToArray()}finally{$m.Dispose()}
 Need ($bytes.Length-eq[int64]$s.LogicalBytes) 'Private outcome byte count changed'
 $raw=[Text.UTF8Encoding]::new($false,$true).GetString($bytes);$rows=@($raw.Trim().Split([char]10)|ForEach-Object{$_|ConvertFrom-Json})
 foreach($row in $rows){Need ($row.nonce-ceq$expected.nonce-and$row.parameterSha256-ceq$expected.parameterSha256-and$row.nativeProcessId-eq$expected.nativeProcessId) 'Private outcome original process/request differs';if($row.actualOwnerSid){Need ($row.actualOwnerSid-ceq$expected.ownerSid) 'Native row owner differs'}}
 Need ($rows.Count-gt0-and$rows[-1].phase-ceq'terminal') 'Original native outcome is incomplete'
 $post=[OrphanSwapNative]::Read($h);Need ($post.Id-ceq$s.Id-and$post.LogicalBytes-ceq$s.LogicalBytes-and$post.AllocatedBytes-ceq$s.AllocatedBytes) 'Private outcome changed under held handle'
 $receipt=@{path=$expected.path;finalPath=$s.FinalPath;fileIdentity=$s.Id;allocatedBytes=$s.AllocatedBytes;logicalBytes=$s.LogicalBytes;sha256=$digest;ownerSid=$sec.OwnerSid;sddlSha256=$sec.SddlSha256;privateOwnerOnlyAcl=$true;nonce=$expected.nonce;parameterSha256=$expected.parameterSha256;nativeProcessId=$expected.nativeProcessId;closed=$true;rawBase64=[Convert]::ToBase64String($bytes);effectsExecuted=$false}
}finally{if($null-ne$stream){$stream.Dispose()}else{$h.Dispose()}}
$receipt|ConvertTo-Json -Depth 8 -Compress
