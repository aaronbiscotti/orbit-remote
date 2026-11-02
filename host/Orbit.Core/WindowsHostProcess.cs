using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace Orbit.Core;

public sealed record HostProcess(int Id, string Executable, bool? Elevated, bool IsSystem = false);

public static class WindowsHostProcess
{
    public static IReadOnlyList<HostProcess> Find(string executable)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var expected = Path.GetFullPath(executable);
        var result = new List<HostProcess>();
        foreach (var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(expected))) {
            using (process) {
                // MainModule enumeration requires more access and fails across elevation levels.
                var handle = OpenProcess(0x1000, false, process.Id);
                if (handle == IntPtr.Zero) continue;
                try {
                    var path = new StringBuilder(32768);
                    var size = path.Capacity;
                    if (!QueryFullProcessImageName(handle, 0, path, ref size) ||
                        !string.Equals(Path.GetFullPath(path.ToString()), expected, StringComparison.OrdinalIgnoreCase)) continue;
                    bool? elevated = null;
                    var isSystem = false;
                    if (OpenProcessToken(handle, 8, out var token)) {
                        try {
                            if (GetTokenInformation(token, 20, out var value, sizeof(int), out _)) elevated = value != 0;
                            try {
                                using var identity = new WindowsIdentity(token);
                                if (identity.IsSystem) {
                                    isSystem = true;
                                    elevated = true;
                                }
                            } catch { }
                        } finally { CloseHandle(token); }
                    }
                    result.Add(new HostProcess(process.Id, path.ToString(), elevated, isSystem));
                } finally { CloseHandle(handle); }
            }
        }
        return result;
    }

    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, int id);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref int size);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int size, out int needed);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
}

public static class AdministratorLaunch
{
    public static ProcessStartInfo ForScript(string script)
    {
        var command = "& '" + Path.GetFullPath(script).Replace("'", "''") + "'";
        return new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe")) {
            UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden,
            Arguments = "-NoProfile -ExecutionPolicy Bypass -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(command))
        };
    }
}
