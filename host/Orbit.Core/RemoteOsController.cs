using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace Orbit.Core;

public sealed record CommandOutput(int ExitCode, string Stdout, string Stderr, string WorkingDirectory);
public sealed record FileEntryItem(string Name, string Path, bool IsDirectory, long Size, string Modified);
public sealed record DirectoryListing(string CurrentPath, string ParentPath, IReadOnlyList<FileEntryItem> Entries, string? Error = null);
public sealed record ProcessEntryItem(int Id, string Name, double MemoryMb, bool Elevated, string WindowTitle);

public static class RemoteOsController
{
    public static async Task<CommandOutput> ExecuteCommandAsync(string command, string? workingDirectory = null, string shell = "powershell", int timeoutMs = 30000)
    {
        var cwd = !string.IsNullOrWhiteSpace(workingDirectory) && Directory.Exists(workingDirectory)
            ? Path.GetFullPath(workingDirectory)
            : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (string.IsNullOrWhiteSpace(cwd) || !Directory.Exists(cwd))
            cwd = Path.GetPathRoot(Environment.SystemDirectory) ?? @"C:\";

        ProcessStartInfo psi;
        if (string.Equals(shell, "cmd", StringComparison.OrdinalIgnoreCase))
        {
            psi = new ProcessStartInfo("cmd.exe")
            {
                WorkingDirectory = cwd,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            psi.ArgumentList.Add("/c");
            psi.ArgumentList.Add(command);
        }
        else
        {
            var psExe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
            if (!File.Exists(psExe)) psExe = "powershell.exe";
            var wrapped = $"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Set-Location -LiteralPath '{cwd.Replace("'", "''")}'; {command}; Write-Output \"`n__ORBIT_CWD__=$((Get-Location).Path)\"";
            var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(wrapped));
            psi = new ProcessStartInfo(psExe)
            {
                WorkingDirectory = cwd,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
                Arguments = $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -OutputFormat Text -EncodedCommand {encoded}"
            };
        }

        try
        {
            using var proc = Process.Start(psi);
            if (proc == null) return new CommandOutput(-1, "", "Failed to start shell process.", cwd);

            using var cts = new CancellationTokenSource(timeoutMs);
            var stdoutTask = proc.StandardOutput.ReadToEndAsync(cts.Token);
            var stderrTask = proc.StandardError.ReadToEndAsync(cts.Token);

            try
            {
                await proc.WaitForExitAsync(cts.Token);
            }
            catch (OperationCanceledException)
            {
                try { proc.Kill(entireProcessTree: true); } catch { }
                return new CommandOutput(-1, await SafeAwait(stdoutTask), "Command timed out.", cwd);
            }

            var stdout = await SafeAwait(stdoutTask);
            var stderr = await SafeAwait(stderrTask);

            var marker = "\n__ORBIT_CWD__=";
            var idx = stdout.LastIndexOf(marker, StringComparison.Ordinal);
            if (idx >= 0)
            {
                var after = stdout[(idx + marker.Length)..].Trim();
                if (Directory.Exists(after)) cwd = after;
                stdout = stdout[..idx].TrimEnd('\r', '\n');
            }

            return new CommandOutput(proc.ExitCode, stdout, stderr, cwd);
        }
        catch (Exception ex)
        {
            return new CommandOutput(-1, "", ex.Message, cwd);
        }
    }

    private static async Task<string> SafeAwait(Task<string> task)
    {
        try { return await task; } catch { return ""; }
    }

    public static DirectoryListing ListDirectory(string? requestedPath)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(requestedPath) || requestedPath == "/" || requestedPath == "drives")
            {
                var drives = DriveInfo.GetDrives()
                    .Where(d => d.IsReady)
                    .Select(d => new FileEntryItem(
                        $"{d.Name.TrimEnd('\\')} ({ (string.IsNullOrWhiteSpace(d.VolumeLabel) ? d.DriveType.ToString() : d.VolumeLabel) })",
                        d.RootDirectory.FullName,
                        true,
                        d.TotalSize,
                        $"{d.AvailableFreeSpace / (1024 * 1024 * 1024)} GB free"))
                    .ToArray();
                return new DirectoryListing("", "", drives);
            }

            var full = Path.GetFullPath(requestedPath);
            if (!Directory.Exists(full))
                return new DirectoryListing(full, Path.GetDirectoryName(full) ?? "", Array.Empty<FileEntryItem>(), "Directory does not exist.");

            var info = new DirectoryInfo(full);
            var items = new List<FileEntryItem>();

            foreach (var dir in info.EnumerateDirectories().OrderBy(d => d.Name, StringComparer.OrdinalIgnoreCase))
            {
                try
                {
                    items.Add(new FileEntryItem(dir.Name, dir.FullName, true, 0, dir.LastWriteTime.ToString("yyyy-MM-dd HH:mm")));
                }
                catch { }
            }

            foreach (var file in info.EnumerateFiles().OrderBy(f => f.Name, StringComparer.OrdinalIgnoreCase))
            {
                try
                {
                    items.Add(new FileEntryItem(file.Name, file.FullName, false, file.Length, file.LastWriteTime.ToString("yyyy-MM-dd HH:mm")));
                }
                catch { }
            }

            var parent = info.Parent?.FullName ?? "drives";
            return new DirectoryListing(info.FullName, parent, items);
        }
        catch (Exception ex)
        {
            return new DirectoryListing(requestedPath ?? "", "drives", Array.Empty<FileEntryItem>(), ex.Message);
        }
    }

    public static byte[] ReadFileBytes(string path, int maxBytes = 24 * 1024 * 1024)
    {
        var full = Path.GetFullPath(path);
        var info = new FileInfo(full);
        if (!info.Exists) throw new FileNotFoundException("File not found on PC.", full);
        if (info.Length > maxBytes) throw new InvalidOperationException($"File exceeds {maxBytes / (1024 * 1024)} MB transfer limit.");
        return File.ReadAllBytes(full);
    }

    public static void WriteFileBytes(string path, byte[] content)
    {
        var full = Path.GetFullPath(path);
        var dir = Path.GetDirectoryName(full);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        File.WriteAllBytes(full, content);
    }

    public static void DeletePath(string path)
    {
        var full = Path.GetFullPath(path);
        if (Directory.Exists(full)) Directory.Delete(full, recursive: true);
        else if (File.Exists(full)) File.Delete(full);
    }

    public static IReadOnlyList<ProcessEntryItem> ListProcesses(int limit = 80)
    {
        var list = new List<ProcessEntryItem>();
        foreach (var proc in Process.GetProcesses())
        {
            using (proc)
            {
                try
                {
                    var memMb = Math.Round(proc.WorkingSet64 / (1024.0 * 1024.0), 1);
                    var title = "";
                    try { title = proc.MainWindowTitle ?? ""; } catch { }
                    var elevated = QueryProcessElevation(proc.Id) ?? false;
                    list.Add(new ProcessEntryItem(proc.Id, proc.ProcessName, memMb, elevated, title));
                }
                catch { }
            }
        }
        return list.OrderByDescending(p => p.MemoryMb).Take(limit).ToArray();
    }

    public static bool KillProcess(int pid)
    {
        try
        {
            using var proc = Process.GetProcessById(pid);
            proc.Kill(entireProcessTree: true);
            return true;
        }
        catch { return false; }
    }

    public static bool ExecutePowerAction(string action)
    {
        if (!OperatingSystem.IsWindows()) return false;
        switch (action.ToLowerInvariant())
        {
            case "lock":
                return LockWorkStation();
            case "sas":
            case "ctrl_alt_del":
                return SecureDesktopManager.SendSecureAttentionSequence();
            case "sleep":
                return Application.SetSuspendState(PowerState.Suspend, force: false, disableWakeEvent: false);
            case "restart":
                using (Process.Start(new ProcessStartInfo("shutdown.exe", "/r /t 3") { CreateNoWindow = true, UseShellExecute = false }))
                    return true;
            default:
                return false;
        }
    }

    public static string GetClipboardText()
    {
        if (!OperatingSystem.IsWindows()) return "";
        var result = "";
        var thread = new Thread(() =>
        {
            try
            {
                if (Clipboard.ContainsText()) result = Clipboard.GetText();
            }
            catch { }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join(1500);
        return result;
    }

    public static void SetClipboardText(string text)
    {
        if (!OperatingSystem.IsWindows() || string.IsNullOrEmpty(text)) return;
        var thread = new Thread(() =>
        {
            try { Clipboard.SetText(text); } catch { }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join(1500);
    }

    private static bool? QueryProcessElevation(int pid)
    {
        var handle = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
        if (handle == IntPtr.Zero) return null;
        try
        {
            if (!OpenProcessToken(handle, 0x0008 /* TOKEN_QUERY */, out var token)) return null;
            try
            {
                return GetTokenInformation(token, 20 /* TokenElevation */, out var value, sizeof(int), out _) ? value != 0 : null;
            }
            finally { _ = CloseHandle(token); }
        }
        finally { _ = CloseHandle(handle); }
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool LockWorkStation();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int id);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int size, out int needed);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
}
