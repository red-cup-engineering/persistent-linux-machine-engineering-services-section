# The maintenance parent and its reentry caller use the same exact capacity
# producer as the ordinary owner-context observer. Each read gets a fresh
# Windows PowerShell process, challenge and finite read budget. This child is
# observation only; its deadline never kills or retries the WSL maintenance.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Threading.Tasks;
public static class WslMaintenanceBackingRead {
 public sealed class ReadResult { public byte[] Bytes; public bool Overflow; }
 static async Task<ReadResult> Read(Stream input,int limit) {
  using(var kept=new MemoryStream()) {
   var buffer=new byte[8192];bool overflow=false;int n;
   while((n=await input.ReadAsync(buffer,0,buffer.Length))>0) {
    int retain=(int)Math.Min(n,Math.Max(0,limit-kept.Length));
    if(retain<n)overflow=true;if(retain>0)kept.Write(buffer,0,retain);
   }
   return new ReadResult {Bytes=kept.ToArray(),Overflow=overflow};
  }
 }
 static async Task Feed(StreamWriter writer,string input) {
  try {await writer.WriteAsync(input);await writer.FlushAsync();} finally {writer.Dispose();}
 }
 public static string Receive(string executable,string arguments,string input,int timeout,int limit) {
  if(timeout<100 || timeout>10000 || limit!=32768 || input.Length>262144)throw new Exception("Invalid original read allocation");
  using(var child=new Process()) {
   child.StartInfo=new ProcessStartInfo(executable,arguments) {UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,WorkingDirectory=Environment.GetFolderPath(Environment.SpecialFolder.Windows)};
   var clock=Stopwatch.StartNew();
   if(!child.Start())throw new Exception("Original capacity child did not start");
   var output=Read(child.StandardOutput.BaseStream,limit);var errors=Read(child.StandardError.BaseStream,limit);var feed=Feed(child.StandardInput,input);
   try {
    int remaining=Math.Max(1,timeout-(int)clock.ElapsedMilliseconds);
    if(!child.WaitForExit(remaining))throw new TimeoutException("Original capacity read deadline");
    remaining=Math.Max(1,timeout-(int)clock.ElapsedMilliseconds);
    if(!Task.WaitAll(new Task[]{output,errors,feed},remaining) || clock.ElapsedMilliseconds>timeout)throw new TimeoutException("Original capacity read deadline");
    // The original capacity entrance receives the exit status and bounded
    // stdout. PowerShell diagnostics/progress may use stderr on a successful
    // read; preserve that contract instead of inventing a silence requirement.
    if(child.ExitCode!=0 || output.Result.Overflow || errors.Result.Overflow)throw new Exception("Original capacity producer unavailable or evidence exceeded");
    return new UTF8Encoding(false,true).GetString(output.Result.Bytes);
   } finally {
    // Only this effect-free metadata child may be cancelled. The original
    // directly awaited WSL compaction child has a separate lifetime and custody.
    if(!child.HasExited) {child.Kill();child.WaitForExit(2000);}
    try {Task.WaitAll(new Task[]{output,errors,feed},2000);} catch { }
   }
  }
 }
}
'@

function Receive-MaintenanceNativePath([string]$path) {
 $current=$path
 while($current) {
  $entry=Get-Item -LiteralPath $current -Force
  if($entry.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){throw 'Redirected native target/provider ancestor'}
  $parent=[IO.Directory]::GetParent($current);if($null -eq $parent){break};$current=$parent.FullName
 }
}

function Receive-MaintenanceBackingTarget($selected) {
 $target=$selected.target;$source=$selected.backingObservation.source
 if($source -isnot [string] -or [Text.Encoding]::UTF8.GetByteCount($source) -gt 131072){throw 'Original backing observer source is unavailable'}
 $sha=[Security.Cryptography.SHA256]::Create()
 try {$actual=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($source)))).Replace('-','').ToLowerInvariant()} finally {$sha.Dispose()}
 if($actual -cne $selected.backingObservation.sourceSha256){throw 'Original backing observer source changed'}
 $nonceBytes=[byte[]]::new(32);$random=[Security.Cryptography.RandomNumberGenerator]::Create()
 try {$random.GetBytes($nonceBytes)} finally {$random.Dispose()}
 $nonce=([BitConverter]::ToString($nonceBytes)).Replace('-','').ToLowerInvariant()
 $expected=@{};foreach($property in $target.PSObject.Properties){$expected[$property.Name]=$property.Value};$expected.requestNonce=$nonce
 $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($expected|ConvertTo-Json -Depth 12 -Compress)))
 $producer='$ProgressPreference="SilentlyContinue"' + "`n" + '$ErrorActionPreference="Stop"' + "`n" + '$expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(' + "'" + $encoded + "'" + '))|ConvertFrom-Json' + "`n" + $source
 $loader='$ProgressPreference="SilentlyContinue";$ErrorActionPreference="Stop";$source=[Text.UTF8Encoding]::new($false,$true).GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));Invoke-Expression $source'
 $arguments='-NoLogo -NoProfile -NonInteractive -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($loader))
 $executable=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
 if([IO.Path]::GetFileName($executable) -ine 'powershell.exe'){throw 'Original Windows PowerShell receiver required'}
 $clock=[Diagnostics.Stopwatch]::StartNew()
 $text=[WslMaintenanceBackingRead]::Receive($executable,$arguments,[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($producer)),[int]$target.timeoutMs,32768)
 $observation=$text.TrimStart([char]0xfeff)|ConvertFrom-Json
 if($clock.ElapsedMilliseconds -gt $target.maxAgeMs -or $observation.requestNonce -cne $nonce){throw 'Original backing observation stale or belongs to another request'}
 $producerAt=[DateTimeOffset]::MinValue
 if($observation.at -isnot [string] -or $observation.at.Length -gt 128 -or -not [DateTimeOffset]::TryParse($observation.at,[ref]$producerAt)){throw 'Original backing producer timestamp is invalid'}
 $path=[IO.Path]::Combine($target.basePath,$target.vhdFileName)
 if($observation.distribution.name -cne $target.distributionName -or $observation.distribution.basePath -ine $target.basePath -or $observation.distribution.vhdFileName -cne $target.vhdFileName -or $observation.vhd.path -ine $path -or $observation.volume.id -ine $target.volumeId){throw 'Current registered backing target changed'}
 foreach($value in @($observation.volume.totalBytes,$observation.volume.availableBytes,$observation.volume.volumeFreeBytes,$observation.volume.callerAvailableBytes,$observation.volume.allocationUnitBytes,$observation.vhd.lengthBytes,$observation.vhd.allocatedBytes)) {
  if($value -isnot [string] -or $value -cnotmatch '^(0|[1-9][0-9]{0,23})$'){throw 'Original backing capacity is unknown'}
 }
 $available=[Math]::Min([decimal]$observation.volume.volumeFreeBytes,[decimal]$observation.volume.callerAvailableBytes)
 if([decimal]$observation.volume.totalBytes -le 0 -or [decimal]$observation.volume.allocationUnitBytes -le 0 -or [decimal]$observation.vhd.lengthBytes -le 0 -or [decimal]$observation.volume.availableBytes -ne $available -or $available -gt [decimal]$observation.volume.totalBytes -or [decimal]$observation.vhd.allocatedBytes -gt [decimal]$observation.volume.totalBytes){throw 'Original backing capacity is inconsistent'}
 if($observation.vhd.allocationSource -cne 'GetFileInformationByHandleEx/FileCompressionInfo' -or $observation.vhd.fileIdentity -cnotmatch '^[a-f0-9]{8}:[a-f0-9]{16}$' -or $observation.vhd.attributes -isnot [int] -or $observation.vhd.attributes -lt 0 -or ($observation.vhd.attributes -band (16 -bor 1024)) -ne 0){throw 'Original native VHD identity is unavailable'}
 if($observation.vhd.sparse -isnot [bool] -or $observation.vhd.compressed -isnot [bool] -or $observation.vhd.sparse -ne [bool]($observation.vhd.attributes -band 512) -or $observation.vhd.compressed -ne [bool]($observation.vhd.attributes -band 2048)){throw 'Original native VHD attributes changed'}
 return [ordered]@{Path=$observation.vhd.path;FileIdentity=$observation.vhd.fileIdentity;Volume=$observation.volume.id;LengthBytes=$observation.vhd.lengthBytes;VolumeFreeBytes=$observation.volume.volumeFreeBytes;CallerAvailableBytes=$observation.volume.callerAvailableBytes;AllocatedBytes=$observation.vhd.allocatedBytes;AllocationSource=$observation.vhd.allocationSource;Attributes=$observation.vhd.attributes;Sparse=$observation.vhd.sparse;Compressed=$observation.vhd.compressed;ObservedAt=$observation.at;RequestNonce=$observation.requestNonce;ObserverSourceSha256=$actual}
}
