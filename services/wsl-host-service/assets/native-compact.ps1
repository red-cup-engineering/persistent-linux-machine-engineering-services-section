# Source-only renderer. An original holder launches this parent from Windows,
# after receiving the fresh authority/checkpoint/independent-caller Resources.
# No guest bootstrap, cleanup, shutdown, elevation, kill or retry exists here.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class WslMaintenanceNative {
  [StructLayout(LayoutKind.Sequential)] public struct Info {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created;
    public System.Runtime.InteropServices.ComTypes.FILETIME Accessed, Written;
    public uint VolumeSerial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string p,uint access,uint share,IntPtr sa,uint mode,uint flags,IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info info);
  public static string Identity(string path) {
    using(var h=CreateFile(path,0x80,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero)) {
      Info i; if(h.IsInvalid || !GetFileInformationByHandle(h,out i)) throw new System.ComponentModel.Win32Exception();
      if((i.Attributes & (0x400u|0x10u))!=0) throw new Exception("VHD is redirected or a directory");
      return i.VolumeSerial.ToString("x8")+":"+i.IndexHigh.ToString("x8")+i.IndexLow.ToString("x8");
    }
  }
  public static void Durable(string path,string text) {
    DurableBytes(path,new UTF8Encoding(false).GetBytes(text));
  }
  public static void DurableBytes(string path,byte[] bytes) {
    using(var f=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.Read)) {
      f.Write(bytes,0,bytes.Length); f.Flush(true);
    }
  }
  public sealed class Evidence { public long TotalBytes; public bool Overflow; public string Error; }
  static async Task<Evidence> Drain(Stream input,FileStream output,int limit) {
    var e=new Evidence(); var buffer=new byte[8192]; long kept=0;
    try {
      int n; while((n=await input.ReadAsync(buffer,0,buffer.Length))>0) {
        e.TotalBytes+=n; int retain=(int)Math.Min(n,Math.Max(0,limit-kept));
        if(retain<n)e.Overflow=true;
        // A failed evidence write must not stop draining and deadlock the child.
        if(retain>0 && e.Error==null) { try { await output.WriteAsync(buffer,0,retain); output.Flush(true); kept+=retain; } catch(Exception x) { e.Error=x.Message; } }
      }
    } catch(Exception x) { e.Error=x.Message; }
    finally { output.Dispose(); }
    return e;
  }
  public sealed class Outcome { public int Pid,Exit; public bool WithinDeadline; public string StartedAt,TerminalAt,PidError; public Evidence Stdout,Stderr; }
  public static Outcome Await(string exe,string args,string directory,int deadline,int limit) {
    // Establish both bounded evidence sinks before any process can start.
    using(var stdout=new FileStream(Path.Combine(directory,"stdout.bin"),FileMode.CreateNew,FileAccess.Write,FileShare.Read))
    using(var stderr=new FileStream(Path.Combine(directory,"stderr.bin"),FileMode.CreateNew,FileAccess.Write,FileShare.Read))
    using(var p=new Process()) {
      p.StartInfo=new ProcessStartInfo(exe,args) { UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true };
      var o=new Outcome { StartedAt=DateTime.UtcNow.ToString("o") };
      if(!p.Start())throw new Exception("Native process did not start; retain original started intent");
      o.Pid=p.Id;
      var a=Drain(p.StandardOutput.BaseStream,stdout,limit); var b=Drain(p.StandardError.BaseStream,stderr,limit);
      try { Durable(Path.Combine(directory,"native-pid.json"),"{\"pid\":"+o.Pid+",\"startedAt\":\""+o.StartedAt+"\"}"); } catch(Exception x) { o.PidError=x.Message; }
      o.WithinDeadline=p.WaitForExit(deadline);
      // Deadline does not kill, retry, bootstrap or abandon the same native child.
      while(!p.WaitForExit(30000)) { }
      o.Exit=p.ExitCode; o.TerminalAt=DateTime.UtcNow.ToString("o");
      o.Stdout=a.GetAwaiter().GetResult(); o.Stderr=b.GetAwaiter().GetResult(); return o;
    }
  }
}
'@
function Hash-Text([string]$text) {
 $sha=[Security.Cryptography.SHA256]::Create()
 try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-','').ToLowerInvariant() } finally {$sha.Dispose()}
}
function No-Redirect([string]$path) {
 $current=$path
 while($current) {
  $entry=Get-Item -LiteralPath $current -Force
  if($entry.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){throw 'Redirected target/custody ancestor'}
  $parent=[IO.Directory]::GetParent($current); if($null -eq $parent){break};$current=$parent.FullName
 }
}
 $resourceLocks=[Collections.Generic.List[object]]::new()
function Receive-Resources {
 foreach($resource in $packet.admission.resources) {
  No-Redirect $resource.path
  $item=Get-Item -LiteralPath $resource.path -Force
  if($item.PSIsContainer -or $item.Length -gt 131072){throw 'Unbounded or non-file original Resource'}
  $held=@($resourceLocks|Where-Object {$_.Path -ceq $resource.path})
  if($held.Count -eq 0) {
   # Hold exact Resource bytes against replacement/write until native terminal.
   $stream=[IO.File]::Open($item.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
   $lock=[pscustomobject]@{Path=$resource.path;Stream=$stream;Bytes=$null;Role=$resource.role};$resourceLocks.Add($lock)
   if($stream.Length -gt 131072){throw 'Resource changed beyond evidence allocation'}
   $bytes=[byte[]]::new([int]$stream.Length);$offset=0
   while($offset -lt $bytes.Length){$n=$stream.Read($bytes,$offset,$bytes.Length-$offset);if($n -eq 0){throw 'Original Resource changed while receiving'};$offset+=$n}
   $sha=[Security.Cryptography.SHA256]::Create()
   try {$actual=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()} finally {$sha.Dispose()}
   if($actual -cne $resource.sha256){throw 'Original authority/checkpoint/receiving bytes changed'}
   $lock.Bytes=$bytes
  }
 }
 $now=[DateTimeOffset]::UtcNow
 if($now -lt [DateTimeOffset]::Parse($packet.admission.notBefore) -or $now -ge [DateTimeOffset]::Parse($packet.admission.expiresAt)){throw 'Original fresh maintenance admission expired or not yet valid'}
}
function Receive-Target {
 No-Redirect ([IO.Path]::Combine($packet.target.basePath,$packet.target.vhdFileName))
 return (Receive-MaintenanceBackingTarget $packet)
}
function Receive-DispatchTarget($before) {
 Receive-Resources
 $fresh=Receive-Target
 if($fresh.FileIdentity -cne $before.FileIdentity){throw 'Native VHD file identity changed before dispatch'}
 # The bounded metadata read may consume the remaining admission interval.
 # Receive the actual Resource freshness again before any maintenance child.
 Receive-Resources
}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if($sid -cne $packet.declaration.ownerSid){throw 'Actual Windows holder identity differs from declared owner'}
if((Hash-Text $packet.admissionText) -cne $packet.admissionSha256){throw 'Admission bytes changed'}
if((Hash-Text $packet.parameterText) -cne $packet.parameterSha256){throw 'Original parameter bytes changed'}
$root=$packet.declaration.custodyDirectory
No-Redirect $root
if(-not (Get-Item -LiteralPath $root -Force).PSIsContainer){throw 'Pre-existing Windows owner custody directory required'}
$acl=Get-Acl -LiteralPath $root
if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid){throw 'Custody is not owned by the actual Windows holder'}
$writeMask=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
foreach($ace in $acl.Access) {
 $aceSid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
 if($ace.AccessControlType -eq 'Allow' -and ($ace.FileSystemRights -band $writeMask) -ne 0 -and $aceSid -notin @($sid,'S-1-5-18','S-1-5-32-544')){throw 'Custody writable by an unreceived principal'}
}
# A single parent lease covers preflight, dispatch and terminal custody. This is
# not the provider lock; WSL owns its selected-distribution lock during compact.
$mutex=[Threading.Mutex]::new($false,('Global\WslMaintenance-'+$sid+'-'+$packet.target.registryKey.Split('\')[-1]))
$leased=$false;$requestDirectory=$null;$created=$false;$started=$false;$terminal=$null;$before=$null;$after=$null
$providerLocks=[Collections.Generic.List[object]]::new()
try {
 try {$leased=$mutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$leased=$true;throw 'Abandoned maintenance parent: reconcile original custody before dispatch'}
 if(-not $leased){throw 'Another maintenance parent still owns the original operation'}
 Receive-MaintenancePriorLaunches $root $packet.admission.request
 $prior=@(Get-ChildItem -LiteralPath $root -Filter '*.claim' -File -Force)
 if($prior.Count -gt 128){throw 'Bounded original request custody allocation exhausted'}
 foreach($claim in $prior) {
  if($claim.BaseName -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'){throw 'Unrecognized original request claim requires original reconciliation'}
  if($claim.BaseName -match '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') {
   No-Redirect $claim.FullName
   $directory=Join-Path $root $claim.BaseName
   if(-not (Test-Path -LiteralPath $directory -PathType Container)){throw 'Original partial request claim requires original reconciliation'}
   No-Redirect $directory;$result=Join-Path $directory 'result.json'
   if(-not (Test-Path -LiteralPath $result -PathType Leaf)){throw 'Original started/partial maintenance custody remains unresolved'}
   No-Redirect $result
   if((Get-Item -LiteralPath $result).Length -gt 131072){throw 'Original outcome exceeds receiving allocation'}
   # Terminal status alone includes failed, late and overflow outcomes. Require
   # the complete original matching successful native custody before a new UUID.
   $priorBundle=Read-MaintenanceBundle $directory
   $received=Receive-MaintenanceOutcome $priorBundle
   if($received.Request -cne $claim.BaseName -or (Read-MaintenanceClaim $claim.FullName) -cne $received.AdmissionSHA256){throw 'Original claim/admission requires original reconciliation'}
  }
 }
 Receive-Resources
 foreach($provider in @(@{Path=$packet.qualification.executable;SHA256=$packet.qualification.executableSha256},@{Path=$packet.qualification.service;SHA256=$packet.qualification.serviceSha256})) {
  No-Redirect $provider.Path
  # A concurrent provider replacement must not change the qualified selection
  # after preflight while the directly awaited native operation is in flight.
  $providerLocks.Add([IO.File]::Open($provider.Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read))
  $file=Get-Item -LiteralPath $provider.Path
  if($file.VersionInfo.ProductVersion -cne $packet.qualification.version -or (Get-FileHash -LiteralPath $provider.Path -Algorithm SHA256).Hash -ine $provider.SHA256){throw 'Qualified installed native provider changed'}
 }
 $before=Receive-Target
 $requestDirectory=Join-Path $root $packet.admission.request
 # CreateDirectory alone is not exclusive. FileMode.CreateNew establishes one
 # immutable request claim first, even when a directory already exists.
 [WslMaintenanceNative]::Durable(($requestDirectory+'.claim'),$packet.admissionSha256)
 if(Test-Path -LiteralPath $requestDirectory){throw 'Original request custody already exists: no replay'}
 $private=[Security.AccessControl.DirectorySecurity]::new();$private.SetOwner([Security.Principal.SecurityIdentifier]::new($sid));$private.SetAccessRuleProtection($true,$false)
 foreach($owner in @($sid,'S-1-5-18','S-1-5-32-544')) {
  $rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($owner),'FullControl','ContainerInherit,ObjectInherit','None','Allow');$private.AddAccessRule($rule)
 }
 [IO.Directory]::CreateDirectory($requestDirectory,$private)|Out-Null
 $created=$true
 [WslMaintenanceNative]::Durable((Join-Path $requestDirectory 'packet.json'),$packetText)
 [WslMaintenanceNative]::Durable((Join-Path $requestDirectory 'parameters.json'),$packet.parameterText)
 [WslMaintenanceNative]::Durable((Join-Path $requestDirectory 'admission.json'),$packet.admissionText)
 foreach($resource in $resourceLocks){[WslMaintenanceNative]::DurableBytes((Join-Path $requestDirectory ($resource.Role+'.resource.json')),$resource.Bytes)}
 $intent=[ordered]@{Type='WslNativeCompactionIntent';Request=$packet.admission.request;AdmissionSHA256=$packet.admissionSha256;Invocation=$packet.invocation;Before=$before;WindowsParentPID=$PID;WindowsOwnerSID=$sid;At=[DateTime]::UtcNow.ToString('o')}
 [WslMaintenanceNative]::Durable((Join-Path $requestDirectory 'started.json'),($intent|ConvertTo-Json -Depth 12 -Compress))
 # Recheck after custody writes, immediately before the only effect.
 Receive-DispatchTarget $before
 $started=$true
 $terminal=[WslMaintenanceNative]::Await($packet.invocation.executable,$packet.invocation.arguments,$requestDirectory,$packet.declaration.deadlineMs,$packet.declaration.maxOutputBytes)
 $after=Receive-Target
 if($after.FileIdentity -cne $before.FileIdentity){throw 'Native VHD file identity changed after operation'}
 $success=($terminal.Exit -eq 0 -and $terminal.WithinDeadline -and -not $terminal.Stdout.Overflow -and -not $terminal.Stderr.Overflow -and -not $terminal.PidError -and -not $terminal.Stdout.Error -and -not $terminal.Stderr.Error)
 $result=[ordered]@{Type='WslNativeCompactionOutcome';Status='terminal-confirmed';Request=$packet.admission.request;AdmissionSHA256=$packet.admissionSha256;Before=$before;After=$after;Native=$terminal;Success=$success;CapacityReopened=$false;GuestReentryAdmitted=$false;At=[DateTime]::UtcNow.ToString('o')}
 [WslMaintenanceNative]::Durable((Join-Path $requestDirectory 'result.json'),($result|ConvertTo-Json -Depth 12 -Compress))
 if(-not $success){throw 'Native terminal retained; operation/evidence allocation failed: no retry or guest reentry'}
 Write-Output ($result|ConvertTo-Json -Depth 12 -Compress)
} catch {
 # Preserve evidence even if postflight failed. A missing/ambiguous terminal
 # prevents a later parent using a new request to bypass original reconciliation.
 if($created -and -not (Test-Path -LiteralPath (Join-Path $requestDirectory 'result.json'))) {
  $failed=[ordered]@{Type='WslNativeCompactionOutcome';Status='requires-original-reconciliation';Request=$packet.admission.request;AdmissionSHA256=$packet.admissionSha256;Started=$started;Native=$terminal;Before=$before;After=$after;Failure=$_.Exception.Message;CapacityReopened=$false;GuestReentryAdmitted=$false;At=[DateTime]::UtcNow.ToString('o')}
  [WslMaintenanceNative]::Durable((Join-Path $requestDirectory 'result.json'),($failed|ConvertTo-Json -Depth 12 -Compress))
 }
 throw
} finally {foreach($resource in $resourceLocks){$resource.Stream.Dispose()};foreach($provider in $providerLocks){$provider.Dispose()};if($leased){$mutex.ReleaseMutex()};$mutex.Dispose()}
