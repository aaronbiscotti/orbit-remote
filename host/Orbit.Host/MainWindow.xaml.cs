using Orbit.Core;
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Text.Json;
using System.Text;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;

namespace Orbit.Host;
public partial class MainWindow : Window
{
    private readonly DispatcherTimer timer;
    private readonly string root;
    private SunshineApi? api;
    private bool refreshing, pairing, loggingIn, checkingAccess, enablingAccess;
    private bool accessAllowed, configured, paired, connectingAnother;
    private bool hostRunning, administratorControl, systemControl, enablingAdministrator;
    private int pendingCount, activeSessions;
    public MainWindow()
    {
        InitializeComponent();
        root = FindRoot();
        ComputerName.Text = Environment.MachineName;
        try {
            EnsureRuntimePrepared();
            configured = HasAdminLogin();
            if (configured) {
                using var document = JsonDocument.Parse(File.ReadAllText(StateFile));
                Username.Text = document.RootElement.GetProperty("username").GetString() ?? "orbit";
            }
        } catch (Exception ex) { Notify(Friendly(ex)); }
        timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
        timer.Tick += async (_, _) => await Refresh();
        Loaded += async (_, _) => {
            await Refresh();
            // Elevation is always an explicit local action; loading the app never opens UAC.
            if (!hostRunning && !File.Exists(AdministratorPreference)) await StartStandardHost();
            timer.Start(); await CheckFirewall();
        };
        Closed += (_, _) => { timer.Stop(); api?.Dispose(); SetThreadExecutionState(0x80000000); };
    }
    private static string FindRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null) {
            if (Directory.Exists(Path.Combine(dir.FullName, "scripts")) && File.Exists(Path.Combine(dir.FullName, "NOTICE"))) return dir.FullName;
            dir = dir.Parent;
        }
        return AppContext.BaseDirectory;
    }
    private string Runtime => Path.Combine(root, "runtime", "sunshine", "Sunshine");
    private string Certificate => Path.Combine(Runtime, "config", "credentials", "cacert.pem");
    private string KeyFile => Path.Combine(Runtime, "config", "credentials", "cakey.pem");
    private string StateFile => Path.Combine(Runtime, "config", "sunshine_state.json");
    private string AdministratorPreference => Path.Combine(Runtime, "config", "administrator-control.enabled");

    private void EnsureRuntimePrepared()
    {
        var configDir = Path.Combine(Runtime, "config");
        var credDir = Path.Combine(configDir, "credentials");
        Directory.CreateDirectory(credDir);
        var configFile = Path.Combine(configDir, "sunshine.conf");
        if (!File.Exists(configFile))
        {
            File.WriteAllLines(configFile, new[]
            {
                $"sunshine_name = {Environment.MachineName}",
                "engine = orbit-takeover",
                "takeover_port = 47995",
                "admin_port = 47990"
            });
        }
        if (!File.Exists(Certificate) || !File.Exists(KeyFile))
        {
            using var cert = TakeoverServer.EnsureCertificate(Certificate, KeyFile);
        }
        var agentExe = Path.Combine(Runtime, "sunshine.exe");
        var currentExe = Environment.ProcessPath;
        if (!File.Exists(agentExe) && !string.IsNullOrEmpty(currentExe) && File.Exists(currentExe))
        {
            var srcDir = Path.GetDirectoryName(currentExe)!;
            foreach (var file in Directory.GetFiles(srcDir))
            {
                var dest = Path.Combine(Runtime, Path.GetFileName(file));
                if (!File.Exists(dest))
                {
                    try { File.Copy(file, dest, overwrite: false); } catch { }
                }
            }
            try { File.Copy(currentExe, agentExe, overwrite: true); } catch { }
            var runtimeConfig = Path.Combine(srcDir, "Orbit.Host.runtimeconfig.json");
            if (File.Exists(runtimeConfig))
            {
                try { File.Copy(runtimeConfig, Path.Combine(Runtime, "sunshine.runtimeconfig.json"), overwrite: true); } catch { }
            }
            var depsJson = Path.Combine(srcDir, "Orbit.Host.deps.json");
            if (File.Exists(depsJson))
            {
                try { File.Copy(depsJson, Path.Combine(Runtime, "sunshine.deps.json"), overwrite: true); } catch { }
            }
        }
    }

    private bool HasAdminLogin()
    {
        if (!File.Exists(StateFile)) return false;
        using var document = JsonDocument.Parse(File.ReadAllText(StateFile));
        return document.RootElement.TryGetProperty("username", out var value) && !string.IsNullOrWhiteSpace(value.GetString());
    }
    private void Notify(string message) { StatusLine.Text = message; StatusLine.Visibility = message.Length == 0 ? Visibility.Collapsed : Visibility.Visible; }
    private void DrawSteps()
    {
        var step = SetupProgress.CurrentStep(api != null, accessAllowed);
        LoginPanel.Visibility = step == 0 ? Visibility.Visible : Visibility.Collapsed;
        PermissionPanel.Visibility = step == 1 ? Visibility.Visible : Visibility.Collapsed;
        ConnectPanel.Visibility = step == 2 ? Visibility.Visible : Visibility.Collapsed;
        var borders = new[] { StepOne, StepTwo, StepThree };
        var labels = new[] { StepOneLabel, StepTwoLabel, StepThreeLabel };
        var names = new[] { "Protect PC", "Allow access", "Connect Mac" };
        for (var i = 0; i < 3; i++) {
            borders[i].Background = new SolidColorBrush((Color)ColorConverter.ConvertFromString(i == step ? "#B7C5FF" : "#1B1F2A"));
            labels[i].Foreground = new SolidColorBrush((Color)ColorConverter.ConvertFromString(i == step ? "#151927" : i < step ? "#A6D7BD" : "#9DA7BE"));
            labels[i].Text = (i < step ? "✓" : (i + 1).ToString()) + "  " + names[i];
        }
        LoginTitle.Text = configured ? "Unlock pairing" : "Protect your PC";
        LoginHint.Text = configured ? "Enter your PC password to approve a Mac." : "Choose a password to approve your Mac.";
        PasswordHint.Text = configured ? "Your Orbit Host password" : "12 characters or more";
        LoginButton.Content = loggingIn ? "Please wait…" : configured ? "Unlock & continue →" : "Save & continue →";
        UpdateCredentialsButton();
        var pending = pendingCount > 0;
        var showSuccess = paired && !connectingAnother && !pending;
        ConnectTitle.Text = pending ? "Your Mac wants to connect" : showSuccess ? "Your Mac is paired" : "Now, on your Mac";
        MacInstructions.Visibility = !pending && !showSuccess ? Visibility.Visible : Visibility.Collapsed;
        PairPanel.Visibility = pending ? Visibility.Visible : Visibility.Collapsed;
        SuccessPanel.Visibility = showSuccess ? Visibility.Visible : Visibility.Collapsed;
        Pending.Visibility = pendingCount > 1 ? Visibility.Visible : Visibility.Collapsed;
        PairDeviceHint.Text = Pending.SelectedItem is PairRequest request ? "Code shown on " + request.Name : "Enter the code shown on your Mac";
        PairButton.IsEnabled = api != null && pending && !pairing && SunshineApi.ValidPin(PairCode.Text.Trim());
        EnableButton.IsEnabled = !checkingAccess && !enablingAccess;
        EnableButton.Content = enablingAccess ? "Waiting for Windows…" : "Allow connections →";
        PermissionHint.Text = checkingAccess ? "Checking connection permission…" : enablingAccess ? "Approve the Windows prompt to continue." : "One click to allow connections from your Mac.";
        AdministratorButton.Visibility = administratorControl ? Visibility.Collapsed : Visibility.Visible;
        AdministratorButton.IsEnabled = !enablingAdministrator;
        AdministratorButton.Content = enablingAdministrator ? "Waiting for Windows…" : "Enable administrator control";
        AdministratorTitle.Text = systemControl
            ? "✓ Full OS Takeover (SYSTEM & UAC ready)"
            : administratorControl
                ? "✓ Administrator control enabled"
                : "OS Takeover & UAC prompts";
        AdministratorHint.Text = systemControl
            ? "Includes UAC Administrator prompts, elevated apps, and Windows Lock Screen."
            : administratorControl
                ? "Includes apps running as administrator and UAC prompts."
                : enablingAdministrator
                    ? "Approve the prompt on this Windows PC, then reconnect."
                    : "To see UAC prompts and control elevated apps from your Mac, enable this once while at the PC.";
    }
    private void UpdateCredentialsButton()
    {
        if (LoginButton == null || Username == null || Password == null) return;
        LoginButton.IsEnabled = !loggingIn && !string.IsNullOrWhiteSpace(Username.Text) && !Username.Text.Contains(':') && Password.Password.Length >= (configured ? 1 : 12);
    }
    private void CredentialsChanged(object sender, RoutedEventArgs e) => UpdateCredentialsButton();
    private void PinChanged(object sender, RoutedEventArgs e) { if (PairButton != null) PairButton.IsEnabled = api != null && pendingCount > 0 && !pairing && SunshineApi.ValidPin(PairCode.Text.Trim()); }
    private void PinInput(object sender, TextCompositionEventArgs e) => e.Handled = e.Text.Any(c => c is < '0' or > '9');
    private async Task Refresh()
    {
        if (refreshing || pairing || loggingIn || enablingAdministrator) return;
        refreshing = true;
        try {
            var adapters = NetworkInterface.GetAllNetworkInterfaces().Where(n => n.OperationalStatus == OperationalStatus.Up).ToArray();
            var addresses = adapters.OrderByDescending(n => n.GetIPProperties().GatewayAddresses.Count > 0).SelectMany(n => n.GetIPProperties().UnicastAddresses)
                .Select(n => n.Address).Where(n => n.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(n) && !(n.GetAddressBytes()[0] == 169 && n.GetAddressBytes()[1] == 254)).ToArray();
            var tail = adapters.Where(n => (n.Name + " " + n.Description).Contains("tailscale", StringComparison.OrdinalIgnoreCase))
                .SelectMany(n => n.GetIPProperties().UnicastAddresses).Select(n => n.Address)
                .FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork && a.GetAddressBytes()[0] == 100 && (a.GetAddressBytes()[1] & 0xC0) == 0x40);
            Address.Text = (tail ?? addresses.FirstOrDefault())?.ToString() ?? "No address";
            CopyButton.IsEnabled = tail != null || addresses.Length > 0;
            NetworkHint.Text = tail != null ? "● Tailscale connected · " + tail : "Local network · " + Address.Text;
            WaitingHint.Text = tail != null ? "Waiting for your Mac…" : "For access while away, connect Tailscale on both devices.";
            var processes = WindowsHostProcess.Find(Path.Combine(Runtime, "sunshine.exe"));
            hostRunning = processes.Count > 0;
            administratorControl = processes.Count >= 1 && processes.All(p => p.Elevated == true);
            systemControl = processes.Count >= 1 && processes.Any(p => p.IsSystem);
            configured = HasAdminLogin();
            HostStatus.Text = !hostRunning
                ? "○ OS Takeover is off"
                : activeSessions > 0
                    ? $"● Mac connected ({activeSessions})"
                    : "● OS Takeover ready";
            StartButton.Visibility = hostRunning ? Visibility.Collapsed : Visibility.Visible;
            Displays.Text = string.Join("\n", System.Windows.Forms.Screen.AllScreens.Select((s,i) => $"Display {i+1} · {s.Bounds.Width} × {s.Bounds.Height}{(s.Primary ? " · primary" : "")}"));
            if (api != null) {
                var status = await api.GetStatus();
                activeSessions = status.ActiveSessions;
                if (string.Equals(status.Privilege, "SYSTEM", StringComparison.OrdinalIgnoreCase))
                {
                    systemControl = true;
                    administratorControl = true;
                }
                var pairs = await api.PendingPairs();
                var selected = (Pending.SelectedItem as PairRequest)?.Id;
                Pending.ItemsSource = pairs;
                Pending.SelectedItem = pairs.FirstOrDefault(p => p.Id == selected) ?? pairs.FirstOrDefault();
                pendingCount = pairs.Count;
                var clients = await api.Clients();
                var selectedClient = (Clients.SelectedItem as PairedClient)?.Id;
                Clients.ItemsSource = clients;
                Clients.SelectedItem = clients.FirstOrDefault(c => c.Id == selectedClient) ?? clients.FirstOrDefault();
                paired = clients.Count > 0;
                Clients.IsEnabled = true;
                RevokeButton.IsEnabled = clients.Count > 0;
            }
        } catch (Exception ex) {
            if (ex is System.Net.Http.HttpRequestException http && http.StatusCode == HttpStatusCode.Unauthorized) { api?.Dispose(); api = null; pendingCount = 0; paired = false; Clients.IsEnabled = RevokeButton.IsEnabled = false; }
            Notify(Friendly(ex));
        } finally { refreshing = false; DrawSteps(); }
    }
    private async void StartHost(object sender, RoutedEventArgs e)
    {
        if (File.Exists(AdministratorPreference)) { await EnableAdministratorControl(); return; }
        await StartStandardHost();
    }
    private async Task StartStandardHost()
    {
        try {
            EnsureRuntimePrepared();
            var exe = Path.Combine(Runtime, "sunshine.exe");
            var config = Path.Combine(Runtime, "config", "sunshine.conf");
            if (!File.Exists(exe) || !File.Exists(config)) { Notify("Host files are missing. Extract the full Windows download and open Launch Orbit."); return; }
            var info = new ProcessStartInfo(exe) { WorkingDirectory = Runtime, UseShellExecute = false, CreateNoWindow = true };
            if (WindowsHostProcess.Find(exe).Count > 0) { await Refresh(); return; }
            info.ArgumentList.Add(config); using var process = Process.Start(info);
            Notify("Starting OS Takeover host…"); await Task.Delay(1200); await Refresh();
        } catch (Exception ex) { Notify(Friendly(ex)); }
    }
    private async void EnableAdministrator(object sender, RoutedEventArgs e) => await EnableAdministratorControl();
    private async Task EnableAdministratorControl()
    {
        if (enablingAdministrator) return;
        EnsureRuntimePrepared();
        var script = Path.Combine(root, "scripts", "start-host-admin.ps1");
        if (!File.Exists(script)) { Notify("Extract the complete updated Windows host first."); return; }
        enablingAdministrator = true; Notify("OS Takeover will restart with Administrator & UAC support after approval. Reconnect from your Mac."); DrawSteps();
        try {
            // Nothing is stopped until Windows has approved and started this helper.
            using var process = Process.Start(AdministratorLaunch.ForScript(script))!;
            await process.WaitForExitAsync();
            if (process.ExitCode != 0) throw new InvalidOperationException("Administrator takeover could not start.");
            var processes = WindowsHostProcess.Find(Path.Combine(Runtime, "sunshine.exe"));
            administratorControl = processes.Count >= 1 && processes.All(p => p.Elevated == true);
            systemControl = processes.Count >= 1 && processes.Any(p => p.IsSystem);
            Notify(administratorControl ? "Administrator & UAC takeover enabled. Reconnect from your Mac." : "Administrator permission could not be verified.");
        } catch (System.ComponentModel.Win32Exception ex) when (ex.NativeErrorCode == 1223) {
            Notify("Approval cancelled. Your current sharing process was left running.");
        } catch (Exception ex) {
            // Recover ordinary desktop sharing if starting the approved replacement failed.
            if (WindowsHostProcess.Find(Path.Combine(Runtime, "sunshine.exe")).Count == 0) {
                await StartStandardHost();
                Notify(Friendly(ex) + (WindowsHostProcess.Find(Path.Combine(Runtime, "sunshine.exe")).Count > 0
                    ? " Restored sharing with standard permissions." : " Sharing is off; try Start PC sharing."));
            } else Notify(Friendly(ex));
        } finally { enablingAdministrator = false; await Refresh(); }
    }
    private void OpenSettings(object sender, RoutedEventArgs e) => Open("https://127.0.0.1:47990/api/config");
    private void OpenTailscale(object sender, RoutedEventArgs e) => Open("https://tailscale.com/download");
    private void GetMacApp(object sender, RoutedEventArgs e) => Open("https://github.com/aaronbiscotti/orbit-remote/releases/latest");
    private static void Open(string url) => Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    private async Task CheckFirewall()
    {
        if (checkingAccess) return;
        checkingAccess = true; DrawSteps();
        try {
            var script = Path.Combine(root, "scripts", "check-firewall.ps1");
            if (!File.Exists(script)) { accessAllowed = false; return; }
            var start = new ProcessStartInfo("powershell.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardOutput = true };
            foreach (var argument in new[] { "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script }) start.ArgumentList.Add(argument);
            using var process = Process.Start(start)!;
            var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync(); await Task.WhenAll(stdout, stderr);
            accessAllowed = process.ExitCode == 0;
            if (process.ExitCode > 1) Notify("Could not check Windows permission. Click Allow connections to try again.");
        } catch (Exception ex) { accessAllowed = false; Notify(Friendly(ex)); }
        finally { checkingAccess = false; DrawSteps(); }
    }
    private async void CheckAccess(object sender, RoutedEventArgs e) { Notify(""); await CheckFirewall(); }
    private async void EnableConnections(object sender, RoutedEventArgs e)
    {
        EnsureRuntimePrepared();
        var script = Path.Combine(root, "scripts", "enable-firewall.ps1");
        if (!File.Exists(script)) { Notify("Extract the full Windows download first."); return; }
        enablingAccess = true; Notify(""); DrawSteps();
        try {
            var command = "& '" + script.Replace("'", "''") + "'";
            var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(command));
            using var process = Process.Start(new ProcessStartInfo("powershell.exe") { UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden,
                Arguments = "-NoProfile -ExecutionPolicy Bypass -EncodedCommand " + encoded })!;
            await process.WaitForExitAsync();
            await CheckFirewall();
            if (!accessAllowed) Notify("Windows permission is still needed. Click Allow connections to retry.");
        } catch (System.ComponentModel.Win32Exception) { Notify("Approval cancelled. Click Allow connections when you’re ready."); }
        catch (Exception ex) { Notify(Friendly(ex)); }
        finally { enablingAccess = false; DrawSteps(); }
    }
    private async void CopyAddress(object sender, RoutedEventArgs e)
    {
        try { Clipboard.SetText(Address.Text); CopyButton.Content = "Copied ✓"; await Task.Delay(1600); CopyButton.Content = "Copy address"; }
        catch (Exception ex) { Notify(Friendly(ex)); }
    }
    private async void Unlock(object sender, RoutedEventArgs e)
    {
        loggingIn = true; Notify(""); DrawSteps(); SunshineApi? candidate = null;
        try {
            EnsureRuntimePrepared();
            if (!File.Exists(Certificate)) throw new InvalidOperationException("Start PC sharing first.");
            if (string.IsNullOrWhiteSpace(Username.Text) || Username.Text.Contains(':') || Password.Password.Length == 0) throw new InvalidOperationException("Enter your PC username and password.");
            candidate = new SunshineApi(Username.Text.Trim(), Password.Password, Certificate);
            if (!HasAdminLogin()) await candidate.CreateInitialLogin(Username.Text.Trim(), Password.Password);
            await candidate.VerifyLogin(); api?.Dispose(); api = candidate; candidate = null;
            Password.Clear(); configured = true;
        } catch (Exception ex) { Notify(Friendly(ex)); }
        finally { candidate?.Dispose(); loggingIn = false; await Refresh(); }
    }
    private async void Approve(object sender, RoutedEventArgs e)
    {
        if (api == null || Pending.SelectedItem is not PairRequest request) return;
        pairing = true; Notify("Pairing your Mac…"); DrawSteps();
        try { await api.Pair(request.Id, PairCode.Text.Trim(), request.Name); PairCode.Clear(); paired = true; connectingAnother = false; Notify(""); }
        catch (Exception ex) { Notify(Friendly(ex)); }
        finally { pairing = false; await Refresh(); }
    }
    private void ConnectAnother(object sender, RoutedEventArgs e) { connectingAnother = true; Notify(""); DrawSteps(); }
    private async void Revoke(object sender, RoutedEventArgs e)
    {
        if (api == null || Clients.SelectedItem is not PairedClient selected) return;
        if (MessageBox.Show($"Remove access for {selected.Name}?", "Remove device", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
        try { await api.Revoke(selected.Id); Notify("Device removed."); await Refresh(); }
        catch (Exception ex) { Notify(Friendly(ex)); }
    }
    private void AwakeChanged(object sender, RoutedEventArgs e) => SetThreadExecutionState(KeepAwake.IsChecked == true ? 0x80000001 : 0x80000000);
    private static string Friendly(Exception ex) => ex is System.Net.Http.HttpRequestException http && http.StatusCode == HttpStatusCode.Unauthorized
        ? "That password didn’t work. Try your Orbit Host login again." : ex.Message;
    [DllImport("kernel32.dll")] private static extern uint SetThreadExecutionState(uint flags);
}
