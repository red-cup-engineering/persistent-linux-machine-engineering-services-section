# Read-only. $expected is decoded by the owned Node caller from JSON data.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($expected.requestNonce -cnotmatch '^[0-9a-f]{64}$') { throw 'Invalid capacity request challenge' }
$r = Get-ItemProperty -LiteralPath $expected.registryKey
if ($r.DistributionName -cne $expected.distributionName -or
    $r.BasePath -ine $expected.basePath -or
    $r.VhdFileName -cne $expected.vhdFileName) { throw 'Registered distribution identity changed' }
$path = [IO.Path]::Combine($r.BasePath, $r.VhdFileName)
$f = Get-Item -LiteralPath $path -Force
if ($f.PSIsContainer -or ($f.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid VHD file' }
# Allocation is observed on this exact handle, never inferred from apparent
# length, sparse flags, guest free space or a different path's file metadata.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class WslBackingFileAllocation {
 [StructLayout(LayoutKind.Sequential)] struct Info {
  public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created,Accessed,Written;
  public uint VolumeSerial,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
 }
 [StructLayout(LayoutKind.Sequential)] struct Compression {
  public long CompressedFileSize; public ushort Format;
  public byte UnitShift,ChunkShift,ClusterShift,Reserved1,Reserved2,Reserved3;
 }
 public sealed class Snapshot {
  public string LengthBytes,AllocatedBytes,FileIdentity,VolumeId,AllocationUnitBytes; public uint Attributes;
 }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint mode,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h,int type,out Compression info,uint size);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder path,uint count,uint flags);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern bool GetDiskFreeSpace(string root,out uint sectorsPerCluster,out uint bytesPerSector,out uint freeClusters,out uint totalClusters);
 static string Identity(Info i) {return i.VolumeSerial.ToString("x8")+":"+i.IndexHigh.ToString("x8")+i.IndexLow.ToString("x8");}
 static ulong Length(Info i) {return ((ulong)i.SizeHigh<<32)|i.SizeLow;}
 public static Snapshot Observe(string path) {
  using(var handle=CreateFile(path,0x80,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero)) {
   Info before,after;Compression allocation;
   if(handle.IsInvalid || !GetFileInformationByHandle(handle,out before))throw new System.ComponentModel.Win32Exception();
   if((before.Attributes & (0x400u|0x10u))!=0)throw new Exception("VHD handle redirected or not a file");
   if(!GetFileInformationByHandleEx(handle,8,out allocation,(uint)Marshal.SizeOf(typeof(Compression))))throw new System.ComponentModel.Win32Exception();
   if(!GetFileInformationByHandle(handle,out after))throw new System.ComponentModel.Win32Exception();
   // Online capacity is an observation, not an offline maintenance admission.
   // Ordinary VHD writes/growth do not replace this handle or invalidate the
   // native allocation sample. Identity and attribute changes still refuse.
   if(Identity(before)!=Identity(after) || before.Attributes!=after.Attributes)throw new Exception("VHD identity changed during allocation observation");
   using(var named=CreateFile(path,0x80,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero)) {
    Info selected;if(named.IsInvalid || !GetFileInformationByHandle(named,out selected))throw new System.ComponentModel.Win32Exception();
    if(Identity(selected)!=Identity(after) || (selected.Attributes & (0x400u|0x10u))!=0)throw new Exception("Selected VHD path changed during allocation observation");
   }
   var finalPath=new StringBuilder(32768);
   uint count=GetFinalPathNameByHandle(handle,finalPath,(uint)finalPath.Capacity,1);
   if(count==0 || count>=finalPath.Capacity)throw new System.ComponentModel.Win32Exception();
   string resolved=finalPath.ToString();int end=resolved.IndexOf('\\',4);
   if(!resolved.StartsWith(@"\\?\Volume{",StringComparison.OrdinalIgnoreCase) || end<0)throw new Exception("Unknown native VHD volume");
   string volume=resolved.Substring(0,end+1);
   uint sectors,sectorBytes,freeClusters,totalClusters;
   if(!GetDiskFreeSpace(volume,out sectors,out sectorBytes,out freeClusters,out totalClusters) || sectors==0 || sectorBytes==0)throw new System.ComponentModel.Win32Exception();
   if(allocation.CompressedFileSize<0)throw new Exception("Unknown VHD physical allocation");
   return new Snapshot {LengthBytes=Length(after).ToString(),AllocatedBytes=allocation.CompressedFileSize.ToString(),FileIdentity=Identity(after),VolumeId=volume,AllocationUnitBytes=((ulong)sectors*sectorBytes).ToString(),Attributes=after.Attributes};
  }
 }
}
'@
$allocation=[WslBackingFileAllocation]::Observe($f.FullName)
if ($allocation.VolumeId -ine $expected.volumeId) { throw 'VHD handle belongs to another backing volume' }
# Address the one native volume directly. Get-Volume's Storage module startup
# exceeded the original 10-second budget; no deadline or health check is relaxed.
$volumePath = $allocation.VolumeId.Replace('\','\\')
$volumes = @(Get-CimInstance -Namespace 'root/Microsoft/Windows/Storage' -ClassName MSFT_Volume -Filter ("Path='{0}'" -f $volumePath) -Property Path,HealthStatus,Size,SizeRemaining,DriveLetter)
if ($volumes.Count -ne 1) { throw 'Ambiguous backing volume' }
$v = $volumes[0]
if ($v.Path -ine $expected.volumeId -or $null -eq $v.HealthStatus -or $v.HealthStatus -ne 0) { throw 'Unknown or unhealthy backing volume' }
$root = [IO.Path]::GetPathRoot($f.FullName)
# The same native volume observation carries its drive-letter association. A mounted
# folder or unlettered volume cannot borrow another drive's caller quota.
if (-not $v.DriveLetter -or $root -ine ($v.DriveLetter.ToString() + ':\')) { throw 'Caller quota capacity is unknown for this volume mount' }
$drive = [IO.DriveInfo]::new($root)
# AvailableFreeSpace includes the current Windows caller's disk quota.
$callerAvailable = $drive.AvailableFreeSpace
$available = [Math]::Min([UInt64]$v.SizeRemaining, [UInt64]$callerAvailable)
@{
  requestNonce = $expected.requestNonce
  at = [DateTime]::UtcNow.ToString('o')
  distribution = @{ name = $r.DistributionName; basePath = $r.BasePath; vhdFileName = $r.VhdFileName }
  volume = @{ id = $v.Path; totalBytes = $v.Size.ToString(); availableBytes = $available.ToString(); allocationUnitBytes = $allocation.AllocationUnitBytes; volumeFreeBytes = $v.SizeRemaining.ToString(); callerAvailableBytes = $callerAvailable.ToString() }
  vhd = @{ path = $f.FullName; lengthBytes = $allocation.LengthBytes; allocatedBytes = $allocation.AllocatedBytes; allocationSource = 'GetFileInformationByHandleEx/FileCompressionInfo'; fileIdentity = $allocation.FileIdentity; attributes = [int]$allocation.Attributes; sparse = [bool]($allocation.Attributes -band [int][IO.FileAttributes]::SparseFile); compressed = [bool]($allocation.Attributes -band [int][IO.FileAttributes]::Compressed) }
} | ConvertTo-Json -Depth 5 -Compress
