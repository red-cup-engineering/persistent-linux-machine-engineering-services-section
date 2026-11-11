# Native process lifetime for the original sparse-maintenance Windows parent.
# A console window and detached pipes do not establish independence from a job.
if (-not ('WslSparseMaintenanceProcess' -as [type])) {
Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class WslSparseMaintenanceProcess {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct StartupInfo {
    public uint cb; public string reserved; public string desktop; public string title;
    public uint x, y, xSize, ySize, xChars, yChars, fill, flags;
    public ushort showWindow, reservedBytes; public IntPtr reservedPointer, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInformation { public IntPtr process, thread; public uint processId, threadId; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes,
    IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
    ref StartupInfo startup, out ProcessInformation information);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inJob);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static bool CurrentIsInJob() {
    using (var process=Process.GetCurrentProcess()) {
      bool inJob;
      if (!IsProcessInJob(process.Handle, IntPtr.Zero, out inJob)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return inJob;
    }
  }
  public static int Start(string application, string arguments, string directory) {
    var startup=new StartupInfo(); startup.cb=(uint)Marshal.SizeOf(typeof(StartupInfo));
    ProcessInformation information;
    // CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW; no inherited handles.
    // A containing job that denies breakaway makes creation fail before a child exists.
    if (!CreateProcessW(application, new StringBuilder("\""+application+"\" "+arguments),
        IntPtr.Zero, IntPtr.Zero, false, 0x01000000 | 0x08000000, IntPtr.Zero, directory,
        ref startup, out information)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try { return checked((int)information.processId); }
    finally { CloseHandle(information.thread); CloseHandle(information.process); }
  }
}
'@
}
