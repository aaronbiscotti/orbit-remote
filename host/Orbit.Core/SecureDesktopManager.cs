using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32;

namespace Orbit.Core;

public enum PrivilegeTier
{
    Standard,
    Administrator,
    System
}

public sealed record DesktopState(string Name, bool IsSecureDesktop, PrivilegeTier Privilege);

/// <summary>
/// Manages Windows desktop attachment across WinSta0\Default (normal desktop) and
/// WinSta0\Winlogon (UAC Administrator Prompts and Windows Lock/Login Screen),
/// plus Session 0 -> Active Console Session SYSTEM worker spawning and Service Control.
/// </summary>
public static class SecureDesktopManager
{
    private const uint DESKTOP_READOBJECTS = 0x0001;
    private const uint DESKTOP_CREATEWINDOW = 0x0002;
    private const uint DESKTOP_CREATEMENU = 0x0004;
    private const uint DESKTOP_HOOKCONTROL = 0x0008;
    private const uint DESKTOP_JOURNALRECORD = 0x0010;
    private const uint DESKTOP_JOURNALPLAYBACK = 0x0020;
    private const uint DESKTOP_ENUMERATE = 0x0040;
    private const uint DESKTOP_WRITEOBJECTS = 0x0080;
    private const uint DESKTOP_SWITCHDESKTOP = 0x0100;
    private const uint DESKTOP_ALL_ACCESS = DESKTOP_READOBJECTS | DESKTOP_CREATEWINDOW | DESKTOP_CREATEMENU |
        DESKTOP_HOOKCONTROL | DESKTOP_JOURNALRECORD | DESKTOP_JOURNALPLAYBACK | DESKTOP_ENUMERATE |
        DESKTOP_WRITEOBJECTS | DESKTOP_SWITCHDESKTOP;

    private const int UOI_NAME = 2;

    public static PrivilegeTier CurrentPrivilegeTier()
    {
        if (!OperatingSystem.IsWindows()) return PrivilegeTier.Standard;
        try
        {
            using var identity = WindowsIdentity.GetCurrent();
            if (identity.IsSystem) return PrivilegeTier.System;
            var principal = new WindowsPrincipal(identity);
            if (principal.IsInRole(WindowsBuiltInRole.Administrator)) return PrivilegeTier.Administrator;
        }
        catch { }
        return PrivilegeTier.Standard;
    }

    public static string PrivilegeLabel(PrivilegeTier tier) => tier switch
    {
        PrivilegeTier.System => "SYSTEM",
        PrivilegeTier.Administrator => "Administrator",
        _ => "Standard"
    };

    /// <summary>
    /// Queries the active input desktop (WinSta0\Default or WinSta0\Winlogon when a UAC prompt
    /// or Lock Screen is active) and attaches the calling thread to that desktop so GDI capture
    /// and SendInput operate directly on UAC prompts and login screens.
    /// </summary>
    public static DesktopState AttachThreadToInputDesktop()
    {
        var tier = CurrentPrivilegeTier();
        if (!OperatingSystem.IsWindows())
            return new DesktopState("Default", false, tier);

        var hInputDesk = OpenInputDesktop(0, false, DESKTOP_ALL_ACCESS);
        if (hInputDesk == IntPtr.Zero)
        {
            // Fallback: try read/switch access to at least identify whether Winlogon is active
            hInputDesk = OpenInputDesktop(0, false, DESKTOP_READOBJECTS | DESKTOP_SWITCHDESKTOP | DESKTOP_WRITEOBJECTS);
        }

        if (hInputDesk == IntPtr.Zero)
        {
            // If OpenInputDesktop fails with Access Denied on an unelevated process, a UAC prompt or lock screen is active!
            var err = Marshal.GetLastWin32Error();
            var likelySecure = err == 5; // ERROR_ACCESS_DENIED
            return new DesktopState(likelySecure ? "Winlogon" : "Default", likelySecure, tier);
        }

        try
        {
            var name = QueryDesktopName(hInputDesk);
            var isSecure = string.Equals(name, "Winlogon", StringComparison.OrdinalIgnoreCase);

            var currentDesk = GetThreadDesktop(GetCurrentThreadId());
            var currentName = currentDesk != IntPtr.Zero ? QueryDesktopName(currentDesk) : "";
            if (!string.Equals(currentName, name, StringComparison.OrdinalIgnoreCase))
            {
                _ = SetThreadDesktop(hInputDesk);
            }

            return new DesktopState(string.IsNullOrEmpty(name) ? "Default" : name, isSecure, tier);
        }
        finally
        {
            _ = CloseDesktop(hInputDesk);
        }
    }

    private static string QueryDesktopName(IntPtr hDesktop)
    {
        var buffer = new byte[256];
        if (!GetUserObjectInformationW(hDesktop, UOI_NAME, buffer, buffer.Length, out var needed) || needed <= 2)
            return "";
        return Encoding.Unicode.GetString(buffer, 0, needed - 2);
    }

    public static bool SendSecureAttentionSequence()
    {
        if (!OperatingSystem.IsWindows()) return false;
        try
        {
            // Enable SoftwareSASGeneration policy when elevated/SYSTEM so SendSAS works on UAC and Lock screens.
            if (CurrentPrivilegeTier() != PrivilegeTier.Standard)
            {
                try
                {
                    using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System", writable: true);
                    key?.SetValue("SoftwareSASGeneration", 3, RegistryValueKind.DWord);
                }
                catch { }
            }
            SendSAS(false);
            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Configures Windows UAC policy on request so Administrator elevation prompts can also be interacted
    /// with cleanly and SoftwareSASGeneration is enabled.
    /// </summary>
    public static void ConfigureTakeoverPolicies()
    {
        if (!OperatingSystem.IsWindows() || CurrentPrivilegeTier() == PrivilegeTier.Standard) return;
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System", writable: true);
            key?.SetValue("SoftwareSASGeneration", 3, RegistryValueKind.DWord);
        }
        catch { }
    }

    public static uint ActiveConsoleSessionId()
    {
        if (!OperatingSystem.IsWindows()) return 0;
        return WTSGetActiveConsoleSessionId();
    }

    /// <summary>
    /// Called from the Session 0 SYSTEM service (OrbitHostService) to launch `Orbit.Host.exe --session-agent`
    /// inside the active physical console session running as NT AUTHORITY\SYSTEM so it has full access to
    /// both WinSta0\Default and WinSta0\Winlogon (UAC Secure Desktop & Lock Screen).
    /// </summary>
    public static int SpawnSystemAgentInConsoleSession(string executablePath, string arguments, string workingDirectory)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var sessionId = WTSGetActiveConsoleSessionId();
        if (sessionId == 0xFFFFFFFF) return -1;

        const uint TOKEN_DUPLICATE = 0x0002;
        const uint TOKEN_ASSIGN_PRIMARY = 0x0001;
        const uint TOKEN_QUERY = 0x0008;
        const uint TOKEN_ADJUST_DEFAULT = 0x0080;
        const uint TOKEN_ADJUST_SESSIONID = 0x0100;
        const uint TOKEN_ADJUST_PRIVILEGES = 0x0020;
        const uint MAXIMUM_ALLOWED = 0x02000000;

        if (!OpenProcessToken(GetCurrentProcess(),
            TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID | TOKEN_ADJUST_PRIVILEGES,
            out var processToken))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcessToken failed.");
        }

        try
        {
            if (!DuplicateTokenEx(processToken, MAXIMUM_ALLOWED, IntPtr.Zero, 2 /* SecurityImpersonation */, 1 /* TokenPrimary */, out var primaryToken))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "DuplicateTokenEx failed.");
            }

            try
            {
                // Set target console session ID on the duplicated SYSTEM token (TokenSessionId = 12)
                var sessionInt = unchecked((int)sessionId);
                if (!SetTokenInformation(primaryToken, 12, ref sessionInt, sizeof(int)))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "SetTokenInformation(TokenSessionId) failed.");
                }

                // Grant TokenUIAccess = 1 (class 26) so input injection bypasses UIPI across all windows
                var uiAccess = 1;
                _ = SetTokenInformation(primaryToken, 26, ref uiAccess, sizeof(int));

                var startup = new STARTUPINFOW
                {
                    cb = Marshal.SizeOf<STARTUPINFOW>(),
                    lpDesktop = @"WinSta0\Default",
                    dwFlags = 0x00000001, // STARTF_USESHOWWINDOW
                    wShowWindow = 0 // SW_HIDE
                };

                var cmdLine = new StringBuilder($"\"{Path.GetFullPath(executablePath)}\" {arguments}");
                const uint CREATE_NO_WINDOW = 0x08000000;
                const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;

                if (!CreateProcessAsUserW(
                    primaryToken,
                    null,
                    cmdLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    false,
                    CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                    IntPtr.Zero,
                    workingDirectory,
                    ref startup,
                    out var procInfo))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessAsUserW failed.");
                }

                _ = CloseHandle(procInfo.hThread);
                _ = CloseHandle(procInfo.hProcess);
                return procInfo.dwProcessId;
            }
            finally
            {
                _ = CloseHandle(primaryToken);
            }
        }
        finally
        {
            _ = CloseHandle(processToken);
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFOW
    {
        public int cb;
        public string? lpReserved;
        public string? lpDesktop;
        public string? lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetThreadDesktop(IntPtr hDesktop);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetThreadDesktop(uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr hDesktop);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetUserObjectInformationW(IntPtr hObj, int nIndex, byte[] pvInfo, int nLength, out int lpnLengthNeeded);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WTSGetActiveConsoleSessionId();

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool DuplicateTokenEx(IntPtr hExistingToken, uint dwDesiredAccess, IntPtr lpTokenAttributes, int ImpersonationLevel, int TokenType, out IntPtr phNewToken);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetTokenInformation(IntPtr TokenHandle, int TokenInformationClass, ref int TokenInformation, int TokenInformationLength);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessAsUserW(
        IntPtr hToken,
        string? lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string? lpCurrentDirectory,
        ref STARTUPINFOW lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("sas.dll", SetLastError = true)]
    private static extern void SendSAS(bool asUser);
}

/// <summary>
/// Zero-dependency P/Invoke wrapper for running Orbit.Host.exe --service as a native Windows LocalSystem service.
/// </summary>
public static class NativeWindowsService
{
    public const string ServiceName = "OrbitHostService";
    private const int SERVICE_WIN32_OWN_PROCESS = 0x00000010;
    private const int SERVICE_START_PENDING = 0x00000002;
    private const int SERVICE_RUNNING = 0x00000004;
    private const int SERVICE_STOP_PENDING = 0x00000003;
    private const int SERVICE_STOPPED = 0x00000001;
    private const int SERVICE_ACCEPT_STOP = 0x00000001;
    private const int SERVICE_ACCEPT_SHUTDOWN = 0x00000004;
    private const int SERVICE_CONTROL_STOP = 0x00000001;
    private const int SERVICE_CONTROL_SHUTDOWN = 0x00000005;

    private delegate void ServiceMainCallback(int argc, IntPtr argv);
    private delegate int ServiceCtrlHandlerEx(int control, int eventType, IntPtr eventData, IntPtr context);

    private static IntPtr statusHandle;
    private static ServiceMainCallback? serviceMainDelegate;
    private static ServiceCtrlHandlerEx? ctrlHandlerDelegate;
    private static CancellationTokenSource? stopCts;
    private static Func<CancellationToken, Task>? workerFactory;

    public static bool IsServiceInstalled()
    {
        if (!OperatingSystem.IsWindows()) return false;
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey($@"SYSTEM\CurrentControlSet\Services\{ServiceName}");
            return key != null;
        }
        catch { return false; }
    }

    public static void Run(Func<CancellationToken, Task> backgroundWorker)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        workerFactory = backgroundWorker;
        stopCts = new CancellationTokenSource();
        serviceMainDelegate = ServiceMain;

        var table = new SERVICE_TABLE_ENTRY[]
        {
            new() { lpServiceName = ServiceName, lpServiceProc = Marshal.GetFunctionPointerForDelegate(serviceMainDelegate) },
            new() { lpServiceName = null, lpServiceProc = IntPtr.Zero }
        };

        if (!StartServiceCtrlDispatcherW(table))
        {
            // If invoked manually outside SCM for testing, run until cancelled
            backgroundWorker(stopCts.Token).GetAwaiter().GetResult();
        }
    }

    private static void ServiceMain(int argc, IntPtr argv)
    {
        ctrlHandlerDelegate = ControlHandler;
        statusHandle = RegisterServiceCtrlHandlerExW(ServiceName, ctrlHandlerDelegate, IntPtr.Zero);
        ReportStatus(SERVICE_START_PENDING, 0);

        ReportStatus(SERVICE_RUNNING, SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN);
        try
        {
            if (workerFactory != null && stopCts != null)
                workerFactory(stopCts.Token).GetAwaiter().GetResult();
        }
        finally
        {
            ReportStatus(SERVICE_STOPPED, 0);
        }
    }

    private static int ControlHandler(int control, int eventType, IntPtr eventData, IntPtr context)
    {
        if (control is SERVICE_CONTROL_STOP or SERVICE_CONTROL_SHUTDOWN)
        {
            ReportStatus(SERVICE_STOP_PENDING, 0);
            stopCts?.Cancel();
        }
        return 0;
    }

    private static void ReportStatus(int currentState, int controlsAccepted)
    {
        if (statusHandle == IntPtr.Zero) return;
        var status = new SERVICE_STATUS
        {
            dwServiceType = SERVICE_WIN32_OWN_PROCESS,
            dwCurrentState = currentState,
            dwControlsAccepted = controlsAccepted,
            dwWin32ExitCode = 0,
            dwWaitHint = 3000
        };
        _ = SetServiceStatus(statusHandle, ref status);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SERVICE_TABLE_ENTRY
    {
        public string? lpServiceName;
        public IntPtr lpServiceProc;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SERVICE_STATUS
    {
        public int dwServiceType;
        public int dwCurrentState;
        public int dwControlsAccepted;
        public int dwWin32ExitCode;
        public int dwServiceSpecificExitCode;
        public int dwCheckPoint;
        public int dwWaitHint;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool StartServiceCtrlDispatcherW([In] SERVICE_TABLE_ENTRY[] lpServiceStartTable);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr RegisterServiceCtrlHandlerExW(string lpServiceName, ServiceCtrlHandlerEx lpHandlerProc, IntPtr lpContext);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetServiceStatus(IntPtr hServiceStatus, ref SERVICE_STATUS lpServiceStatus);
}
