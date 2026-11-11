# Explicit original WSL3.0.3 ephemeral objects only; no self-elevation or sweep.
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$stream=$null;$held=@();$completed=0;$started=$false;$stage='identity';$identity=$null
try {
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if($identity.User.Value -cne $expected.ownerSid -or [Environment]::MachineName -cne $expected.machineName -or $env:USERPROFILE -ine $expected.profile){throw 'Original owner/machine/profile changed'}
if([Environment]::GetFolderPath('LocalApplicationData') -ine $expected.localAppDataWindowsPath){throw 'Native known-folder changed'}
function Need([bool]$ok,[string]$message){if(-not $ok){throw $message}}
function Check-Ancestors([string]$parent){
 while($parent){$item=Get-Item -LiteralPath $parent -Force;Need ($item.PSIsContainer -and -not($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Parent redirected';$up=[IO.Directory]::GetParent($parent);if($null -eq $up){break};$parent=$up.FullName}
}
$stage='private-output'
$output=[IO.Path]::Combine([IO.Path]::Combine($expected.localAppDataWindowsPath,'temp'),('561-wsl-orphan-swap-'+$expected.nonce+'.jsonl'))
Check-Ancestors ([IO.Path]::GetDirectoryName($output))
$security=[Security.AccessControl.FileSecurity]::new();$security.SetAccessRuleProtection($true,$false);$sid=[Security.Principal.SecurityIdentifier]::new($expected.ownerSid);$security.SetOwner($sid);$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))
$stream=[IO.FileStream]::new($output,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::Write,[IO.FileShare]::Read,4096,[IO.FileOptions]::WriteThrough,$security)
function Receive-Step([hashtable]$step){$step.nonce=$expected.nonce;$step.parameterSha256=$expected.parameterSha256;$step.nativeProcessId=$PID;$step.at=[DateTime]::UtcNow.ToString('o');$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($step|ConvertTo-Json -Depth 10 -Compress)+"`n");$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}
$stage='administrator'
if(-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Actual administrator token required; no self-elevation'}
$stage='native-version'
if((Get-Item -LiteralPath $expected.wslExecutable).VersionInfo.FileVersion -cne $expected.wslVersion){throw 'Original WSL version changed'}
$stage='native-interop'
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;using System.Text;using Microsoft.Win32.SafeHandles;
public static class OrphanSwapNative {
 [StructLayout(LayoutKind.Sequential)]struct Info {public uint Attributes;public System.Runtime.InteropServices.ComTypes.FILETIME Created,Access,Write;public uint Serial,HighSize,LowSize,Links,HighId,LowId;}
 [StructLayout(LayoutKind.Sequential)]struct Standard {public long Allocation,Length;public uint Links;[MarshalAs(UnmanagedType.U1)]public bool DeletePending;[MarshalAs(UnmanagedType.U1)]public bool Directory;}
 [StructLayout(LayoutKind.Sequential)]struct Disposition {public byte Delete;}
 public sealed class SecuritySnapshot {public string OwnerSid,Sddl,SddlSha256;}
 public sealed class Snapshot {public string Id,AllocatedBytes,LogicalBytes,FinalPath;public uint Attributes,Links;public bool DeletePending;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint mode,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info value);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetFileInformationByHandleEx(SafeFileHandle h,int kind,out Standard value,uint bytes);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder path,uint size,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool ReadFile(SafeFileHandle h,[Out]byte[] bytes,uint size,out uint read,IntPtr overlapped);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool SetFileInformationByHandle(SafeFileHandle h,int kind,ref Disposition value,uint bytes);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool GetDiskFreeSpaceExW(string path,out ulong available,out ulong total,out ulong free);
 [DllImport("computecore.dll")]static extern IntPtr HcsCreateOperation(IntPtr context,IntPtr callback);
 [DllImport("computecore.dll",CharSet=CharSet.Unicode)]static extern int HcsEnumerateComputeSystems(string query,IntPtr operation);
 [DllImport("computecore.dll")]static extern int HcsWaitForOperationResult(IntPtr operation,uint timeout,out IntPtr result);
 [DllImport("computecore.dll")]static extern void HcsCloseOperation(IntPtr operation);
 [DllImport("kernel32.dll")]static extern IntPtr LocalFree(IntPtr value);
 [DllImport("advapi32.dll",SetLastError=true)]static extern uint GetSecurityInfo(SafeFileHandle h,int type,uint info,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr descriptor,uint revision,uint info,out IntPtr text,out uint length);
 public static SecuritySnapshot Security(SafeFileHandle h){IntPtr o,g,d,s,sd,text=IntPtr.Zero;uint rc=GetSecurityInfo(h,1,5,out o,out g,out d,out s,out sd);if(rc!=0)throw new System.ComponentModel.Win32Exception((int)rc);try{uint n;Need(ConvertSecurityDescriptorToStringSecurityDescriptorW(sd,1,5,out text,out n));string value=Marshal.PtrToStringUni(text);using(var hash=System.Security.Cryptography.SHA256.Create())return new SecuritySnapshot{OwnerSid=new System.Security.Principal.SecurityIdentifier(o).Value,Sddl=value,SddlSha256=BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-","").ToLowerInvariant()};}finally{if(text!=IntPtr.Zero)LocalFree(text);LocalFree(sd);}}
 static void Need(bool ok){if(!ok)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
 public static Snapshot Read(SafeFileHandle h){Info i;Standard s;Need(GetFileInformationByHandle(h,out i));Need(GetFileInformationByHandleEx(h,1,out s,(uint)Marshal.SizeOf(typeof(Standard))));var p=new StringBuilder(4096);uint n=GetFinalPathNameByHandleW(h,p,4096,1);Need(n>0&&n<4096);return new Snapshot{Id=i.Serial.ToString("x8")+":"+i.HighId.ToString("x8")+i.LowId.ToString("x8"),AllocatedBytes=s.Allocation.ToString(),LogicalBytes=s.Length.ToString(),FinalPath=p.ToString(),Attributes=i.Attributes,Links=i.Links,DeletePending=s.DeletePending};}
 public static string Header(SafeFileHandle h){byte[] b=new byte[8];uint n;Need(ReadFile(h,b,8,out n,IntPtr.Zero));if(n!=8)throw new Exception("Short VHDX header");return Encoding.ASCII.GetString(b);}
 public static void Delete(SafeFileHandle h){var d=new Disposition{Delete=1};Need(SetFileInformationByHandle(h,4,ref d,1));}
 public static string Hcs(string query){IntPtr op=HcsCreateOperation(IntPtr.Zero,IntPtr.Zero),result=IntPtr.Zero;if(op==IntPtr.Zero)throw new Exception("HCS operation unavailable");try{Marshal.ThrowExceptionForHR(HcsEnumerateComputeSystems(query,op));Marshal.ThrowExceptionForHR(HcsWaitForOperationResult(op,uint.MaxValue,out result));if(result==IntPtr.Zero)throw new Exception("HCS result absent");return Marshal.PtrToStringUni(result);}finally{if(result!=IntPtr.Zero)LocalFree(result);HcsCloseOperation(op);}}
}
'@
function Assert-ParentReceipt($snapshot,$security,$target,[string]$nativePath){
 Need ($snapshot.Id -ceq $target.parentFileIdentity -and ($snapshot.Attributes -band 16) -and -not($snapshot.Attributes -band 1024) -and -not $snapshot.DeletePending -and $snapshot.FinalPath -ieq $nativePath) 'Held original parent identity/path/type changed'
 Need ($security.OwnerSid -ceq $expected.ownerSid -and $security.SddlSha256 -ceq $target.parentSddlSha256) 'Held original parent security changed'
 @{fileIdentity=$snapshot.Id;finalPath=$snapshot.FinalPath;ownerSid=$security.OwnerSid;sddlSha256=$security.SddlSha256}
}
function Check-Parent($item){
 Check-Ancestors ([IO.Path]::GetDirectoryName($item.path))
 $s=[OrphanSwapNative]::Read($item.parentHandle);$security=[OrphanSwapNative]::Security($item.parentHandle)
 $parent=[IO.Path]::GetDirectoryName($item.path);$nativePath=$expected.volumeId+$parent.Substring([IO.Path]::GetPathRoot($parent).Length)
 Assert-ParentReceipt $s $security $item.target $nativePath
}
function Swap-Path([string]$vm){[IO.Path]::Combine([IO.Path]::Combine([IO.Path]::Combine($expected.localAppDataWindowsPath,'temp'),$vm),'swap.vhdx')}
function Assert-HcsSystems([object[]]$systems) {
 $live=@($systems|Where-Object{$_.Id -ieq $expected.currentVmId})
 Need ($live.Count -eq 1 -and ([Guid]$live[0].RuntimeId).ToString() -ieq $expected.currentVmId -and $live[0].Owner -ceq 'WSL' -and $live[0].State -ceq 'Running' -and $live[0].SystemType -ceq 'VirtualMachine') 'Current WSL VM not positively received'
 foreach($t in $expected.targets){Need (-not @($systems|Where-Object{$_.Id -ieq $t.vmId -or ([Guid]$_.RuntimeId).ToString() -ieq $t.vmId}).Count) 'Target VM still present in HCS'}
 @($systems|Select-Object Id,RuntimeId,Owner,State,SystemType)
}
function ConvertFrom-HcsReceipt([string]$json){
 $decoded=ConvertFrom-Json -InputObject $json
 Need ($decoded -is [Array]) 'Native HCS result is not a system array'
 $systems=@(foreach($system in $decoded){$system})
 Assert-HcsSystems $systems
}
function Check-Hcs {
 $ids=@($expected.currentVmId)+@($expected.targets|ForEach-Object{$_.vmId})
 ConvertFrom-HcsReceipt ([OrphanSwapNative]::Hcs((@{Ids=$ids}|ConvertTo-Json -Compress)))
}
function Check-Current {
 $path=Swap-Path $expected.currentVmId;$h=[OrphanSwapNative]::CreateFileW($path,0x80,7,[IntPtr]::Zero,3,0x00200000,[IntPtr]::Zero)
 try{Need (-not $h.IsInvalid) 'Current swap metadata missing';Need (([OrphanSwapNative]::Read($h)).Id -ceq $expected.currentFileIdentity) 'Current swap identity changed'}finally{$h.Dispose()}
 $h=[OrphanSwapNative]::CreateFileW($path,[uint32]2147483776,0,[IntPtr]::Zero,3,0x00200000,[IntPtr]::Zero);$errorCode=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
 try{Need ($h.IsInvalid -and $errorCode -eq 32) 'Current swap sharing negative control failed'}finally{$h.Dispose()}
}
function Free-Point {
 [uint64]$available=0;[uint64]$total=0;[uint64]$free=0
 Need ([OrphanSwapNative]::GetDiskFreeSpaceExW($expected.volumeId,[ref]$available,[ref]$total,[ref]$free)) 'Native volume capacity unknown'
 @{callerAvailableBytes=$available.ToString();volumeFreeBytes=$free.ToString();totalBytes=$total.ToString()}
}
$stage='native-preflight'
 Check-Current;$beforeHcs=Check-Hcs;$before=Free-Point
 foreach($t in $expected.targets){
  $path=Swap-Path $t.vmId;Check-Ancestors ([IO.Path]::GetDirectoryName($path))
  $parentHandle=[OrphanSwapNative]::CreateFileW([IO.Path]::GetDirectoryName($path),0x20080,3,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero);Need (-not $parentHandle.IsInvalid) 'Original parent handle refused'
  $item=@{target=$t;path=$path;parentHandle=$parentHandle;handle=$null;closed=$false;marked=$false};$held+=,$item;$parent=Check-Parent $item
  $h=[OrphanSwapNative]::CreateFileW($path,[uint32]2147680384,0,[IntPtr]::Zero,3,0x00200000,[IntPtr]::Zero);Need (-not $h.IsInvalid) 'Target exclusive read/delete handle refused'
  $item.handle=$h
  $s=[OrphanSwapNative]::Read($h);Need ($s.Id -ceq $t.fileIdentity -and $s.AllocatedBytes -ceq $t.allocatedBytes -and $s.LogicalBytes -ceq $t.logicalBytes -and $s.Attributes -eq $t.attributes -and $s.Links -eq 1 -and -not $s.DeletePending) 'Target native identity/allocation/type changed'
  $nativePath=$expected.volumeId+$path.Substring([IO.Path]::GetPathRoot($path).Length);Need ($s.FinalPath -ieq $nativePath) 'Target native final path/volume changed'
  $fileOwner=([OrphanSwapNative]::Security($h)).OwnerSid;Need ($fileOwner -ceq $expected.ownerSid) 'Target file owner changed'
  $header=[OrphanSwapNative]::Header($h);Need ($header -ceq 'vhdxfile') 'Original VHDX header missing'
  $held[-1].received=@{vmId=$t.vmId;path=$path;fileIdentity=$s.Id;allocatedBytes=$s.AllocatedBytes;logicalBytes=$s.LogicalBytes;attributes=$s.Attributes;links=$s.Links;header=$header;ownerSid=$fileOwner;finalPath=$s.FinalPath;parent=$parent}
  Need ([int64](Get-Item -LiteralPath 'HKCU:\SOFTWARE\Microsoft\Terminal Server Client\LocalDevices').GetValue($t.vmId) -eq 196) 'Original WSL GUID declaration missing'
 }
 $commitHcs=Check-Hcs;Check-Current
 foreach($item in $held){$null=Check-Parent $item;$s=[OrphanSwapNative]::Read($item.handle);Need ($s.Id -ceq $item.target.fileIdentity -and $s.AllocatedBytes -ceq $item.target.allocatedBytes) 'Held target changed';Need ([int64](Get-Item -LiteralPath 'HKCU:\SOFTWARE\Microsoft\Terminal Server Client\LocalDevices').GetValue($item.target.vmId) -eq 196) 'Original WSL GUID changed'}
 Receive-Step @{phase='preflight';action=$expected.action;before=$before;hcs=$commitHcs;targets=@($held|ForEach-Object{$_.received});currentVmId=$expected.currentVmId;ownerSid=$identity.User.Value;machine=[Environment]::MachineName;actualAdministrator=([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}
 if($expected.action -ceq 'retire'){
  foreach($item in $held){
   $stage='native-disposition';$started=$true;[OrphanSwapNative]::Delete($item.handle);$item.marked=$true;Receive-Step @{phase='file-marked';vmId=$item.target.vmId;fileIdentity=$item.target.fileIdentity}
   $item.handle.Dispose();$item.closed=$true
   $probe=[OrphanSwapNative]::CreateFileW($item.path,0x80,7,[IntPtr]::Zero,3,0x00200000,[IntPtr]::Zero);$absence=[Runtime.InteropServices.Marshal]::GetLastWin32Error();try{Need ($probe.IsInvalid -and $absence -eq 2) 'Target absence unreceived'}finally{$probe.Dispose()}
   $completed++;Receive-Step @{phase='file-terminal';vmId=$item.target.vmId;fileIdentity=$item.target.fileIdentity;allocatedBytes=$item.target.allocatedBytes;nativeAbsenceCode=$absence}
  }
 }
 $afterHcs=Check-Hcs;Check-Current;$after=Free-Point
 Receive-Step @{phase='terminal';status=$(if($expected.action -ceq 'retire'){'native-terminal-success'}else{'native-observed-without-disposition'});completedFiles=$completed;before=$before;after=$after;currentVmId=$expected.currentVmId;hcs=$afterHcs;capacityReopened=$false}
}catch{
 $failure=$_;$actualSid=$null;$actualAdmin=$null
 if($null -ne $identity){$actualSid=$identity.User.Value;$actualAdmin=([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}
 $outcome=@{phase='terminal';status=$(if($started){'partial-or-unknown'}else{'refused-before-disposition'});completedFiles=$completed;stage=$stage;actualOwnerSid=$actualSid;actualAdministrator=$actualAdmin;actualMachine=[Environment]::MachineName;error=$failure.Exception.Message;exceptionType=$failure.Exception.GetType().FullName;code=$failure.FullyQualifiedErrorId;position=$failure.InvocationInfo.PositionMessage;scriptStack=$failure.ScriptStackTrace;held=@($held|ForEach-Object{@{vmId=$_.target.vmId;marked=$_.marked;closed=$_.closed}});capacityReopened=$false}
 if($null -ne $stream){try{Receive-Step $outcome}catch{$outcome.journalError=$_.Exception.Message;Write-Output ($outcome|ConvertTo-Json -Depth 10 -Compress)}}else{$outcome.nonce=$expected.nonce;$outcome.parameterSha256=$expected.parameterSha256;$outcome.nativeProcessId=$PID;Write-Output ($outcome|ConvertTo-Json -Depth 10 -Compress)}
 throw $failure
}finally{
 foreach($item in $held){if(-not $item.closed -and $null -ne $item.handle){$item.handle.Dispose();$item.closed=$true};if($null -ne $item.parentHandle){$item.parentHandle.Dispose()}}
 if($null -ne $stream){$stream.Dispose()}
}
