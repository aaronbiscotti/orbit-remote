using Orbit.Core;
using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace Orbit.Host;

// Headless entry point: the Windows service (--service), otherwise the takeover agent.
public static class Program
{
    public static void Main(string[] args)
    {
        var exePath = Environment.ProcessPath ?? AppContext.BaseDirectory;
        if (args.Any(a => string.Equals(a, "--service", StringComparison.OrdinalIgnoreCase)))
        {
            NativeWindowsService.Run(ct => RunSystemServiceLoopAsync(exePath, ct));
            return;
        }
        // Orbit starts the agent as sunshine.exe "<config>"; the service starts it with --session-agent "<config>".
        RunSessionAgentAsync(ResolveAgentConfigRoot(args)).GetAwaiter().GetResult();
    }

    private static string ResolveAgentConfigRoot(string[] args)
    {
        foreach (var arg in args)
        {
            if (arg.StartsWith("--", StringComparison.Ordinal)) continue;
            try
            {
                var full = Path.GetFullPath(arg.Trim('"'));
                if (full.EndsWith(".conf", StringComparison.OrdinalIgnoreCase))
                {
                    var dir = Path.GetDirectoryName(full);
                    if (!string.IsNullOrEmpty(dir)) return dir;
                }
                if (Directory.Exists(full)) return full;
            }
            catch { }
        }
        return Path.Combine(AppContext.BaseDirectory, "config");
    }

    private static async Task RunSessionAgentAsync(string configRoot)
    {
        SecureDesktopManager.ConfigureTakeoverPolicies();
        await using var server = new TakeoverServer(configRoot, TakeoverServer.DefaultAdminPort, TakeoverServer.DefaultTakeoverPort);
        server.Start();
        await Task.Delay(Timeout.Infinite);
    }

    private static async Task RunSystemServiceLoopAsync(string serviceExePath, CancellationToken ct)
    {
        SecureDesktopManager.ConfigureTakeoverPolicies();
        var engineDir = Path.GetDirectoryName(serviceExePath) ?? AppContext.BaseDirectory;
        var agentExe = Path.Combine(engineDir, "sunshine.exe");
        if (!File.Exists(agentExe)) agentExe = serviceExePath;
        var configFile = Path.Combine(engineDir, "config", "sunshine.conf");

        while (!ct.IsCancellationRequested)
        {
            try
            {
                var running = WindowsHostProcess.Find(agentExe).Where(p => p.Id != Environment.ProcessId).ToList();
                if (running.Count == 0)
                {
                    try
                    {
                        _ = SecureDesktopManager.SpawnSystemAgentInConsoleSession(
                            agentExe,
                            $"--session-agent \"{configFile}\"",
                            engineDir);
                    }
                    catch
                    {
                        // Fallback if no console session is attached yet
                    }
                }
            }
            catch { }

            try { await Task.Delay(3000, ct); }
            catch (OperationCanceledException) { break; }
        }
    }
}
