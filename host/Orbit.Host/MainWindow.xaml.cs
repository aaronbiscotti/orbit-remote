using Orbit.Core;
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;
using System.Threading.Tasks;
using System.Text.Json;
using System.Windows;
using System.Windows.Threading;

namespace Orbit.Host;
public partial class MainWindow : Window
{
    private readonly DispatcherTimer timer;
    private readonly string root;
    private SunshineApi? api;
    private bool refreshing;
    private bool pairing;
    public MainWindow()
    {
        InitializeComponent();
        root = FindRoot();
        ComputerName.Text = Environment.MachineName;
        timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(4) };
        timer.Tick += async (_, _) => await Refresh();
        Loaded += async (_, _) => { await Refresh(); ContentScroll.ScrollToTop(); timer.Start(); };
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
    private bool HasAdminLogin()
    {
        var stateFile = Path.Combine(Runtime, "config", "sunshine_state.json");
        if (!File.Exists(stateFile)) return false;
        using var document = JsonDocument.Parse(File.ReadAllText(stateFile));
        return document.RootElement.TryGetProperty("username", out var value) && !string.IsNullOrWhiteSpace(value.GetString());
    }

    private async Task Refresh()
    {
        if (refreshing || pairing) return;
        refreshing = true;
        try {
            var addresses = NetworkInterface.GetAllNetworkInterfaces()
                .Where(n => n.OperationalStatus == OperationalStatus.Up)
                .SelectMany(n => n.GetIPProperties().UnicastAddresses)
                .Select(n => n.Address).Where(n => n.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(n)).ToArray();
            var tail = addresses.FirstOrDefault(a => a.GetAddressBytes()[0] == 100 && (a.GetAddressBytes()[1] & 0xC0) == 0x40);
            Address.Text = (tail ?? addresses.FirstOrDefault())?.ToString() ?? "No network address";
            NetworkHint.Text = tail != null ? "Tailscale address detected. Use the same Tailscale account on your Mac; check that its connection is direct for best performance."
                : "This is a local address. To connect while away, install Tailscale on both devices and use this PC’s Tailscale address.";
            var running = Process.GetProcessesByName("sunshine").Length > 0;
            var configured = HasAdminLogin();
            HostStatus.Text = !running ? "Host is stopped · start it to connect" : !configured ? "Host is running · create your admin login below" : "Host is running · ready for authorized devices";
            LoginButton.Content = configured ? "Unlock" : "Create login";
            LoginHint.Text = configured ? "Use your host admin login to approve a device. Your password stays in memory only." : "Choose an admin username and a password of at least 12 characters. You will use this login to approve your Mac’s pairing code.";
            StartButton.IsEnabled = !running;
            Displays.Text = string.Join("\n", System.Windows.Forms.Screen.AllScreens.Select((s,i) => $"Display {i+1} · {s.Bounds.Width} × {s.Bounds.Height}{(s.Primary ? " · primary" : "")}"));
            if (api != null) {
                var pairs = await api.PendingPairs();
                var selected = (Pending.SelectedItem as PairRequest)?.Id;
                Pending.ItemsSource = pairs;
                Pending.SelectedItem = pairs.FirstOrDefault(p => p.Id == selected) ?? pairs.FirstOrDefault();
                var clients = await api.Clients();
                var selectedClient = (Clients.SelectedItem as PairedClient)?.Id;
                Clients.ItemsSource = clients;
                Clients.SelectedItem = clients.FirstOrDefault(c => c.Id == selectedClient) ?? clients.FirstOrDefault();
                PairButton.IsEnabled = pairs.Count > 0;
                RevokeButton.IsEnabled = clients.Count > 0;
            }
        } catch (Exception ex) {
            StatusLine.Text = "Refresh: " + Friendly(ex);
        } finally { refreshing = false; }
    }

    private async void StartHost(object sender, RoutedEventArgs e)
    {
        try {
            var exe = Path.Combine(Runtime, "sunshine.exe");
            var config = Path.Combine(Runtime, "config", "sunshine.conf");
            if (!File.Exists(exe) || !File.Exists(config)) {
                StatusLine.Text = "Run scripts/setup-host.ps1 from the project folder first, then try again.";
                return;
            }
            var info = new ProcessStartInfo(exe) { WorkingDirectory = Runtime, UseShellExecute = false, CreateNoWindow = true };
            info.ArgumentList.Add(config);
            Process.Start(info);
            StatusLine.Text = "Starting Sunshine. Open settings to create your admin login if this is your first launch.";
            await Task.Delay(2500);
            await Refresh();
        } catch (Exception ex) { StatusLine.Text = Friendly(ex); }
    }
    private void OpenSettings(object sender, RoutedEventArgs e) => Open("https://127.0.0.1:47990");
    private void OpenTailscale(object sender, RoutedEventArgs e) => Open("https://tailscale.com/download");
    private static void Open(string url) => Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    private void CopyAddress(object sender, RoutedEventArgs e) { Clipboard.SetText(Address.Text); StatusLine.Text = "PC address copied."; }

    private async void Unlock(object sender, RoutedEventArgs e)
    {
        LoginButton.IsEnabled = false;
        SunshineApi? candidate = null;
        try {
            if (!File.Exists(Certificate)) throw new InvalidOperationException("Start the host first so it can create its local certificate.");
            if (string.IsNullOrWhiteSpace(Username.Text) || Username.Text.Contains(':') || Password.Password.Length == 0) throw new InvalidOperationException("Enter your host admin username (without a colon) and password.");
            candidate = new SunshineApi(Username.Text.Trim(), Password.Password, Certificate);
            if (!HasAdminLogin()) await candidate.CreateInitialLogin(Username.Text.Trim(), Password.Password);
            await candidate.VerifyLogin();
            api?.Dispose(); api = candidate; candidate = null;
            Password.Clear();
            Pending.IsEnabled = PairCode.IsEnabled = Clients.IsEnabled = true;
            PairStatus.Text = "Unlocked. Add this PC in Orbit on your Mac, click its card, then approve its code here.";
            await Refresh();
        } catch (Exception ex) { PairStatus.Text = Friendly(ex); }
        finally { candidate?.Dispose(); LoginButton.IsEnabled = true; }
    }

    private async void Approve(object sender, RoutedEventArgs e)
    {
        if (api == null || Pending.SelectedItem is not PairRequest request) return;
        pairing = true; PairButton.IsEnabled = false;
        try {
            PairStatus.Text = "Verifying the device’s pairing code…";
            await api.Pair(request.Id, PairCode.Text.Trim(), request.Name);
            PairCode.Clear();
            PairStatus.Text = "Paired. Your Mac can now connect using its saved device credential.";
        } catch (Exception ex) { PairStatus.Text = Friendly(ex); }
        finally { pairing = false; await Refresh(); }
    }

    private async void Revoke(object sender, RoutedEventArgs e)
    {
        if (api == null || Clients.SelectedItem is not PairedClient selected) return;
        if (MessageBox.Show($"Revoke access for {selected.Name}? It will need to pair again.", "Revoke device", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
        try { await api.Revoke(selected.Id); PairStatus.Text = "Device access revoked."; await Refresh(); }
        catch (Exception ex) { PairStatus.Text = Friendly(ex); }
    }
    private void AwakeChanged(object sender, RoutedEventArgs e) => SetThreadExecutionState(KeepAwake.IsChecked == true ? 0x80000001 : 0x80000000);
    private static string Friendly(Exception ex) => ex is System.Net.Http.HttpRequestException http && http.StatusCode == HttpStatusCode.Unauthorized
        ? "Admin login was rejected. Check your Sunshine username and password." : ex.Message;
    [DllImport("kernel32.dll")] private static extern uint SetThreadExecutionState(uint flags);
}
