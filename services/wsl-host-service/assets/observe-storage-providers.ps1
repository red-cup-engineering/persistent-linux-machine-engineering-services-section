# Read-only provider points; the original caller supplies its existing allocation helper.
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
if ($env:USERPROFILE -ine $expected.profile) { throw 'Original Windows profile changed' }
$registered=Get-ItemProperty -LiteralPath $expected.backing.registryKey
if ($registered.DistributionName -cne $expected.backing.distributionName -or $registered.BasePath -ine $expected.backing.basePath -or $registered.VhdFileName -cne $expected.backing.vhdFileName) { throw 'Original distribution registration changed' }
$installed=Get-Item -LiteralPath $expected.wslExecutableWindowsPath
if ($installed.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected WSL executable' }
if ($installed.VersionInfo.FileVersion -cne $expected.wslVersion) { throw 'Installed WSL version changed' }
function UnknownProvider([string]$id,[string]$source,[object]$failure) {
 $message=[string]$failure.Exception.Message
 if($message.Length -gt 2048){$message=$message.Substring(0,2048)}
 @{id=$id;source=$source;status='unknown';error=@{message=$message;type=$failure.Exception.GetType().FullName;code=$failure.FullyQualifiedErrorId}}
}
function ReceiveProvider([string]$id,[string]$source,[scriptblock]$operation) {
 try { $items=@(& $operation);if($items.Count -gt 64){throw 'Provider metadata exceeds64 selected rows'};@{id=$id;source=$source;status='received';items=$items} }
 catch {UnknownProvider $id $source $_}
}
function Resolve-WslSwapPath([string]$config,[string]$localAppData,[string]$vmId) {
$section='';$swapFile=$null;$seen=$false
foreach($line in ($config -split '\r?\n')) {
 $text=$line.Trim()
 if($text -match '^\[([^\]]+)\]$'){$section=$Matches[1];continue}
 if($section -ieq 'wsl2' -and $text -match '^swapFile\s*=\s*(.*)$') {
  if($seen){throw 'Ambiguous configured swapFile'};$seen=$true;$swapFile=$Matches[1].Trim()
 }
}
if($seen) {
 # WSL config paths escape backslashes; accept only an exact absolute drive path.
 $swapFile=$swapFile.Replace('\\','\')
 if($swapFile -notmatch '^[A-Za-z]:\\' -or $swapFile.IndexOfAny([char[]]'*?') -ge 0 -or $swapFile.Split('\') -contains '..'){throw 'Unsupported configured absolute swapFile'}
 if([IO.Path]::GetExtension($swapFile) -ine '.vhdx'){$swapFile+='.vhdx'}
 $basis='current-native-wslconfig-explicit-swapFile'
} else {
 $swapFile=[IO.Path]::Combine([IO.Path]::Combine([IO.Path]::Combine($localAppData,'temp'),$vmId),'swap.vhdx')
 $basis='microsoft/WSL@15ea3b3846c5f18318722d1381186b2ff6ed72eb:LocalAppData/temp/liveVmId/swap.vhdx'
}
 return @{path=$swapFile;basis=$basis}
}
function Resolve-ActiveWslSwapPath([string]$config,[string]$localAppData,[string]$vmId,$transition) {
 $selection=Resolve-WslSwapPath $config $localAppData $vmId
 if($null -eq $transition){return $selection}
 if($vmId -ieq $transition.fromVmId){
  $active=Resolve-WslSwapPath '' $localAppData $vmId
  if($selection.path -ine $active.path -and $selection.path -ine $transition.toWindowsPath){throw 'Pending swap configuration differs from declaration'}
  $active.activation=$(if($selection.path -ieq $active.path){'configuration-staged'}else{'pending-next-VM'})
  $active.expectedFileIdentity=$transition.fromFileIdentity;$active.configuredPath=$transition.toWindowsPath
  return $active
 }
 if($selection.path -ine $transition.toWindowsPath){throw 'New VM swap configuration differs from declaration'}
 $selection.activation='configured-new-VM';$selection.configuredPath=$transition.toWindowsPath;return $selection
}
$configPath=[IO.Path]::Combine($expected.profile,'.wslconfig')
$configFile=Get-Item -LiteralPath $configPath
if(($configFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $configFile.Length -gt 65536){throw 'Unsafe or oversized original WSL configuration'}
$before=[WslBackingFileAllocation]::Observe($configPath)
$config=[IO.File]::ReadAllText($configPath)
$after=[WslBackingFileAllocation]::Observe($configPath)
$configFileAfter=Get-Item -LiteralPath $configPath
if($before.FileIdentity -cne $after.FileIdentity -or $configFile.LastWriteTimeUtc -ne $configFileAfter.LastWriteTimeUtc -or $configFile.Length -ne $configFileAfter.Length){throw 'WSL configuration changed during receiving'}
$selection=Resolve-ActiveWslSwapPath $config ([Environment]::GetFolderPath('LocalApplicationData')) $expected.vmId $expected.swapFileTransition
$swapFile=$selection.path;$basis=$selection.basis
try {
 $file=[WslBackingFileAllocation]::Observe($swapFile)
 if($file.VolumeId -ine $expected.backing.volumeId){throw 'Selected swap belongs to another backing volume'}
 if($selection.expectedFileIdentity -and $file.FileIdentity -cne $selection.expectedFileIdentity){throw 'Original live swap changed while activation pending'}
 $swap=@{id='wsl-swap';status='received';source='GetFileInformationByHandleEx/FileCompressionInfo';path=$swapFile;pathBasis=$basis;activation=$selection.activation;configuredPath=$selection.configuredPath;fileIdentity=$file.FileIdentity;volumeId=$file.VolumeId;logicalBytes=$file.LengthBytes;allocatedBytes=$file.AllocatedBytes;attributes=$file.Attributes}
} catch {$swap=UnknownProvider 'wsl-swap' 'GetFileInformationByHandleEx/FileCompressionInfo' $_}
$pagefiles=ReceiveProvider 'pagefiles' 'Win32_PageFileUsage/MiB' {
 Get-CimInstance -ClassName Win32_PageFileUsage -OperationTimeoutSec 2 -Property Name,AllocatedBaseSize,CurrentUsage,PeakUsage,TempPageFile |ForEach-Object {
  @{path=$_.Name;allocatedMiB=$_.AllocatedBaseSize.ToString();currentUsageMiB=$_.CurrentUsage.ToString();peakUsageMiB=$_.PeakUsage.ToString();temporary=$_.TempPageFile}
 }
}
$volume=$expected.backing.volumeId
$storage=ReceiveProvider 'shadow-storage' 'Win32_ShadowStorage/bytes' {
 # A REFERENCES query can return empty without initializing this provider.
 # Receive the original native class, bound its small metadata set, then select
 # only associations involving the exact backing volume (not filesystem paths).
 $rows=@(Get-CimInstance -ClassName Win32_ShadowStorage -OperationTimeoutSec 2 -Property Volume,DiffVolume,UsedSpace,AllocatedSpace,MaxSpace)
 if($rows.Count -gt 64){throw 'ShadowStorage metadata exceeds64 native rows'}
 foreach($row in $rows){if($row.Volume.DeviceID -ieq $volume -or $row.DiffVolume.DeviceID -ieq $volume){@{volume=$row.Volume.DeviceID;diffVolume=$row.DiffVolume.DeviceID;usedBytes=$row.UsedSpace.ToString();allocatedBytes=$row.AllocatedSpace.ToString();maxBytes=$row.MaxSpace.ToString()}}}
}
$copies=ReceiveProvider 'shadow-copies' 'Win32_ShadowCopy/exact-volume' {
 Get-CimInstance -ClassName Win32_ShadowCopy -Filter ("VolumeName='"+$volume.Replace('\','\\')+"'") -OperationTimeoutSec 2 -Property ID,VolumeName,InstallDate,State,ProviderID |ForEach-Object {
  if($_.VolumeName -ine $volume){throw 'Shadow copy returned another volume'};@{id=$_.ID;volume=$_.VolumeName;created=$_.InstallDate.ToString('o');state=$_.State;provider=$_.ProviderID}
 }
}
$docker=@{id='docker-data';status='unknown';source='original source-owned Docker data location';error=@{message='No original source-owned Docker data path declared; registered main VHD absence does not establish absence of data disks.'}}
if ($null -ne $expected.dockerData) {
 $docker=ReceiveProvider 'docker-data' 'selected declared Docker artifacts/GetFileInformationByHandleEx/FileCompressionInfo' {
  foreach($artifact in $expected.dockerData.artifacts) {
   $point=[WslBackingFileAllocation]::Observe($artifact.path)
   if($point.VolumeId -ine $artifact.volumeId){throw 'Declared Docker artifact belongs to another native volume'}
   @{name=$artifact.name;path=$artifact.path;volumeId=$point.VolumeId;fileIdentity=$point.FileIdentity;logicalBytes=$point.LengthBytes;allocatedBytes=$point.AllocatedBytes;attributes=$point.Attributes}
  }
 }
 $docker.scope='selected-declared-artifacts-only'
}
@{requestNonce=$expected.requestNonce;vmId=$expected.vmId;wslVersion=$installed.VersionInfo.FileVersion;at=[DateTime]::UtcNow.ToString('o');configuration=@{path=$configPath;fileIdentity=$before.FileIdentity;pathBasis=$basis};providers=@($swap,$pagefiles,$storage,$copies,$docker)}|ConvertTo-Json -Depth 8 -Compress
