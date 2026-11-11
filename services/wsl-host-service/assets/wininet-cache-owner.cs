using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
public static class PowerToysCacheOwner {
 [DllImport("wininet.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr FindFirstUrlCacheEntryW(string pattern,IntPtr buffer,ref uint size);
 [DllImport("wininet.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool FindNextUrlCacheEntryW(IntPtr handle,IntPtr buffer,ref uint size);
 [DllImport("wininet.dll",SetLastError=true)] static extern bool FindCloseUrlCache(IntPtr handle);
 public sealed class Entry {
  internal string SourceUrl; public string LocalPath,SourceHost,SourceUrlSha256; public uint CacheEntryType,UseCount,HitRate; public ulong LogicalBytes;
 }
 public sealed class Point {public ulong NativeEntriesExamined; public int NativeEndCode;public Entry[] Matches;}
 public static Point Observe(string selected) {
  if(IntPtr.Size!=8)throw new Exception("Unqualified native WinINet x64 layout");
  uint size=0;IntPtr h=FindFirstUrlCacheEntryW(null,IntPtr.Zero,ref size);int error=Marshal.GetLastWin32Error();
  if(h!=IntPtr.Zero){FindCloseUrlCache(h);throw new Exception("Unexpected cache initial handle");}
  if(error==259)return new Point{NativeEntriesExamined=0,NativeEndCode=259,Matches=new Entry[0]};
  if(error!=122 || size<112)throw new Exception("Native cache initial receive refused:"+error+" size:"+size);
  IntPtr b=Marshal.AllocHGlobal(checked((int)size));var found=new List<Entry>();ulong count=0;
  try {
   h=FindFirstUrlCacheEntryW(null,b,ref size);error=Marshal.GetLastWin32Error();
   if(h==IntPtr.Zero)throw new Exception("Native cache first receive refused:"+error);
   while(true){
    count++;IntPtr localPtr=Marshal.ReadIntPtr(b,16);string local=localPtr==IntPtr.Zero?null:Marshal.PtrToStringUni(localPtr);
    if(String.Equals(local,selected,StringComparison.OrdinalIgnoreCase)){
     string source=Marshal.PtrToStringUni(Marshal.ReadIntPtr(b,8));Uri uri;
     if(!Uri.TryCreate(source,UriKind.Absolute,out uri))throw new Exception("Selected native cache source malformed");
     string digest;using(var sha=SHA256.Create()){digest=BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(source))).Replace("-","").ToLowerInvariant();}
     found.Add(new Entry{SourceUrl=source,LocalPath=local,SourceHost=uri.DnsSafeHost,SourceUrlSha256=digest,CacheEntryType=unchecked((uint)Marshal.ReadInt32(b,24)),UseCount=unchecked((uint)Marshal.ReadInt32(b,28)),HitRate=unchecked((uint)Marshal.ReadInt32(b,32)),LogicalBytes=unchecked((uint)Marshal.ReadInt32(b,36))|((ulong)unchecked((uint)Marshal.ReadInt32(b,40))<<32)});
    }
    uint next=size;bool ok=FindNextUrlCacheEntryW(h,b,ref next);error=Marshal.GetLastWin32Error();
    if(ok)continue;if(error==259)break;
    if(error!=122 || next<=size)throw new Exception("Native cache next receive refused:"+error);
    Marshal.FreeHGlobal(b);b=IntPtr.Zero;b=Marshal.AllocHGlobal(checked((int)next));size=next;
    ok=FindNextUrlCacheEntryW(h,b,ref next);error=Marshal.GetLastWin32Error();
    if(!ok)throw new Exception("Native cache expanded receive refused:"+error);
   }
   return new Point{NativeEntriesExamined=count,NativeEndCode=259,Matches=found.ToArray()};
  }finally{if(h!=IntPtr.Zero)FindCloseUrlCache(h);if(b!=IntPtr.Zero)Marshal.FreeHGlobal(b);}
 }
 [DllImport("wininet.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool DeleteUrlCacheEntryW(string url);
 public static void ReleaseExact(string selected,string expectedUrlSha256){
  Point p=Observe(selected);
  if(p.Matches.Length!=1)throw new Exception("Exact native cache owner match changed");
  Entry e=p.Matches[0];
  if(e.SourceUrlSha256!=expectedUrlSha256||e.SourceHost!="release-assets.githubusercontent.com"||e.CacheEntryType!=65||e.UseCount!=0)throw new Exception("Native cache key/use/type changed");
  bool ok=DeleteUrlCacheEntryW(e.SourceUrl);int error=Marshal.GetLastWin32Error();
  if(!ok)throw new System.ComponentModel.Win32Exception(error,"Original WinINet cache release refused");
 }
}

