using Orbit.Core;
using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;

namespace Orbit.Host;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        DispatcherUnhandledException += (_, args) => {
            MessageBox.Show(args.Exception.Message, "Orbit", MessageBoxButton.OK, MessageBoxImage.Warning);
            args.Handled = true;
        };
        base.OnStartup(e);

        var exePath = Environment.ProcessPath ?? AppContext.BaseDirectory;
        var exeName = Path.GetFileNameWithoutExtension(exePath);

        if (e.Args.Any(a => string.Equals(a, "--service", StringComparison.OrdinalIgnoreCase)))
        {
            ShutdownMode = ShutdownMode.OnExplicitShutdown;
            _ = Task.Run(() =>
            {
                try
                {
                    NativeWindowsService.Run(ct => RunSystemServiceLoopAsync(exePath, ct));
                }
                finally
                {
                    Dispatcher.Invoke(() => Shutdown(0));
                }
            });
            return;
        }

        var isSessionAgent = e.Args.Any(a => string.Equals(a, "--session-agent", StringComparison.OrdinalIgnoreCase))
            || string.Equals(exeName, "sunshine", StringComparison.OrdinalIgnoreCase)
            || string.Equals(exeName, "orbit-agent", StringComparison.OrdinalIgnoreCase);

        if (isSessionAgent)
        {
            ShutdownMode = ShutdownMode.OnExplicitShutdown;
            var configRoot = ResolveAgentConfigRoot(e.Args);
            _ = Task.Run(() => RunSessionAgentAsync(configRoot));
            return;
        }

        var window = new MainWindow();
        MainWindow = window;
        window.Show();
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
