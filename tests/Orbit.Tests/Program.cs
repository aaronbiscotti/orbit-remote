using Orbit.Core;
using System.Drawing;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;

var assertions = 0;
void Check(bool result, string message) { assertions++; if (!result) throw new Exception(message); }
async Task Reject(Func<Task> action) { try { await action(); } catch (Exception) { assertions++; return; } throw new Exception("Expected a rejected action."); }

// =============================================================================
// 1. Original 24 Setup, Authentication, Pairing, Revocation & Host Assertions
// =============================================================================
var fake = new FakeHandler();
using var api = new SunshineApi(fake, "owner", "private password");
fake.Body = "{\"status\":true}";
await api.CreateInitialLogin("owner", "private password");
Check(fake.LastUri!.EndsWith("api/password"), "Initial login uses wrong endpoint.");
using(var initial = JsonDocument.Parse(fake.PostBody!)) {
    Check(initial.RootElement.GetProperty("currentPassword").GetString() == "", "Must not claim existing credentials during initial setup.");
    Check(initial.RootElement.GetProperty("newPassword").GetString() == initial.RootElement.GetProperty("confirmNewPassword").GetString(), "Password confirmation mismatch.");
}
await Reject(() => api.CreateInitialLogin("owner", "short"));
await api.VerifyLogin();
Check(fake.LastUri == "https://127.0.0.1:47990/api/config", "Admin requests must remain on loopback.");
Check(fake.Authorization == "Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes("owner:private password")), "Missing authentication.");
fake.Status = HttpStatusCode.Unauthorized;
await Reject(api.VerifyLogin);
fake.Status = HttpStatusCode.OK;
fake.Body = "{\"pairings\":[{\"id\":\"0123456789abcdef0123456789abcdef\",\"name\":\"MacBook\",\"address\":\"100.64.1.2\"}]}";
var pending = await api.PendingPairs();
Check(pending.Count == 1 && pending[0].Name == "MacBook", "Pending pairing response incompatible.");
fake.Body = "{\"status\":true}";
await api.Pair(pending[0].Id, "1234", "MacBook");
using(var payload = JsonDocument.Parse(fake.PostBody!)) {
    Check(payload.RootElement.GetProperty("pairing_id").GetString() == pending[0].Id, "Pairing must select an explicit request.");
    Check(payload.RootElement.GetProperty("pin").GetString() == "1234", "Wrong PIN payload.");
}
var before = fake.Calls;
await Reject(() => api.Pair(pending[0].Id, "１２３４", "MacBook"));
Check(fake.Calls == before, "Malformed PIN sent to server.");
fake.Body = "{\"status\":false}";
await Reject(() => api.Pair(pending[0].Id, "9999", "MacBook"));
fake.Body = "{}";
await Reject(() => api.Revoke("device-id"));
fake.Body = "{\"status\":true,\"named_certs\":[{\"uuid\":\"device-id\",\"name\":\"MacBook\"}]}";
Check((await api.Clients()).Single().Id == "device-id", "Client list incompatible.");
fake.Body = "{\"status\":true}";
await api.Revoke("device-id");
Check(fake.LastUri!.EndsWith("api/clients/unpair") && fake.PostBody!.Contains("device-id"), "Wrong revocation request.");
Check(SetupProgress.CurrentStep(false, false) == 0 && SetupProgress.CurrentStep(false, true) == 0, "Firewall permission must not bypass PC login.");
Check(SetupProgress.CurrentStep(true, false) == 1, "Connection step must wait for verified firewall permission.");
Check(SetupProgress.CurrentStep(true, true) == 2, "An unlocked, permitted host should advance to Mac pairing.");
if (OperatingSystem.IsWindows()) {
    var currentImage = Environment.ProcessPath!;
    var processes = WindowsHostProcess.Find(currentImage);
    Check(processes.Any(p => p.Id == Environment.ProcessId && p.Elevated != null), "Limited-access process queries must identify the current process and its elevation.");
    var wrongLocation = Path.Combine(Path.GetTempPath(), "orbit-process-scope-test", Path.GetFileName(currentImage));
    Check(WindowsHostProcess.Find(wrongLocation).Count == 0, "Matching an executable name must not select a process from another location.");
    var scriptPath = Path.Combine(Path.GetTempPath(), "Orbit's control $(whoami)", "start-host-admin.ps1");
    var launch = AdministratorLaunch.ForScript(scriptPath);
    Check(launch.UseShellExecute && launch.Verb == "runas", "Administrator control must go through Windows consent.");
    Check(Path.IsPathFullyQualified(launch.FileName) && launch.FileName.StartsWith(Environment.GetFolderPath(Environment.SpecialFolder.System), StringComparison.OrdinalIgnoreCase), "Elevated helpers must use the system PowerShell executable.");
    var encoded = launch.Arguments.Split(' ').Last();
    var command = Encoding.Unicode.GetString(Convert.FromBase64String(encoded));
    Check(command.Contains("Orbit''s control $(whoami)") && command.StartsWith("& '") && command.EndsWith("'"), "Script paths must remain a single literal, including apostrophes and PowerShell expressions.");
}

// =============================================================================
// 2. Dirty-Tile Zero-Idle-Bitrate, AVX2 SIMD Diffing & Tight Bounding-Box Crop
// =============================================================================
using var captureEngine = new DesktopCaptureEngine();
using (var syntheticScreen = new Bitmap(384, 256))
{
    using (var g = Graphics.FromImage(syntheticScreen))
    {
        g.Clear(Color.FromArgb(16, 18, 24));
    }
    var firstDelta = captureEngine.ComputeDeltaFromBitmap(syntheticScreen, "Default", false, "SYSTEM", 100, 100, "crisp", forceFullFrame: true);
    Check(firstDelta.FullFrame && firstDelta.Tiles.Count == 2 && firstDelta.Payload.Length > 0, "Initial full frame must encode all 2 (2x1) 256x256 tiles.");

    var staticDelta = captureEngine.ComputeDeltaFromBitmap(syntheticScreen, "Default", false, "SYSTEM", 100, 100, "crisp", forceFullFrame: false);
    Check(!staticDelta.FullFrame && staticDelta.Tiles.Count == 0 && staticDelta.Payload.Length == 0, "Static screen must produce 0 dirty tiles and 0 bytes (zero idle bitrate).");

    // Modify only a 20x20 region inside tile (col=1, row=0 -> X=128..256, Y=0..128)
    using (var g = Graphics.FromImage(syntheticScreen))
    {
        using var brush = new SolidBrush(Color.FromArgb(183, 197, 255));
        g.FillRectangle(brush, 150, 30, 20, 20);
    }
    var singleTileDelta = captureEngine.ComputeDeltaFromBitmap(syntheticScreen, "Default", false, "SYSTEM", 155, 35, "crisp", forceFullFrame: false);
    Check(!singleTileDelta.FullFrame && singleTileDelta.Tiles.Count == 1, "Single region update must only transmit 1 dirty patch.");
    var patch = singleTileDelta.Tiles[0];
    Check(patch.X >= 128 && patch.X <= 150 && patch.Y >= 0 && patch.Y <= 30 && patch.W <= 32 && patch.H <= 32,
        $"SIMD tight bounding-box crop must shrink the 128x128 macro-tile down to the ~20x20 modified region (got {patch.X},{patch.Y} {patch.W}x{patch.H}).");
}

// Benchmark 1920x1080 SIMD static frame diff speed
using (var fullHdScreen = new Bitmap(1920, 1080))
{
    _ = captureEngine.ComputeDeltaFromBitmap(fullHdScreen, "Default", false, "SYSTEM", 500, 500, "crisp", forceFullFrame: true);
    var sw = System.Diagnostics.Stopwatch.StartNew();
    const int iterations = 50;
    for (var i = 0; i < iterations; i++)
    {
        var diff = captureEngine.ComputeDeltaFromBitmap(fullHdScreen, "Default", false, "SYSTEM", 500, 500, "crisp", forceFullFrame: false);
        if (diff.Tiles.Count != 0) throw new Exception("Expected 0 dirty tiles on static 1080p frame.");
    }
    sw.Stop();
    var avgMs = sw.Elapsed.TotalMilliseconds / iterations;
    Console.WriteLine($"BENCHMARK: 1920x1080 AVX2 Vector256 SIMD frame diff averaged {avgMs:F3} ms/frame ({1000.0 / Math.Max(0.001, avgMs):F0} fps capacity).");
}

// =============================================================================
// 3. End-to-End Live OS-Takeover Server, Pinned TLS, Pairing & Remote Control
// =============================================================================
var tempConfigDir = Path.Combine(Path.GetTempPath(), "orbit-takeover-e2e-" + Guid.NewGuid().ToString("N"));
try
{
    using var testScreen = new Bitmap(256, 128);
    using (var g = Graphics.FromImage(testScreen)) g.Clear(Color.FromArgb(24, 28, 38));
    var syntheticEngine = new DesktopCaptureEngine();

    await using var server = new TakeoverServer(tempConfigDir, adminPort: 0, takeoverPort: 0)
    {
        CustomCaptureProvider = (_, quality, forceFull) =>
            syntheticEngine.ComputeDeltaFromBitmap(testScreen, "Winlogon", true, "SYSTEM", 64, 64, quality, forceFull)
    };
    server.Start();

    var certPath = Path.Combine(tempConfigDir, "credentials", "cacert.pem");
    Check(File.Exists(certPath), "TakeoverServer must generate pinned TLS certificate.");

    using var liveApi = new SunshineApi("orbit", "super-secret-orbit-pass", certPath, server.AdminPort);
    await liveApi.CreateInitialLogin("orbit", "super-secret-orbit-pass");
    await liveApi.VerifyLogin();
    var status = await liveApi.GetStatus();
    Check(!string.IsNullOrEmpty(status.Privilege), "Loopback admin API must report host privilege status.");

    // Verify wrong credentials fail closed
    using var badApi = new SunshineApi("orbit", "wrong-password-12345", certPath, server.AdminPort);
    await Reject(badApi.VerifyLogin);

    // Simulate Mac Client pairing over TLS
    var clientId = Guid.NewGuid().ToString("N");
    var secretBytes = RandomNumberGenerator.GetBytes(32);
    var tokenHashHex = Convert.ToHexString(SHA256.HashData(secretBytes)).ToLowerInvariant();
    var pin = "4829";

    using (var pairTcp = new TcpClient())
    {
        await pairTcp.ConnectAsync(IPAddress.Loopback, server.TakeoverPort);
        using var pairSsl = new SslStream(pairTcp.GetStream(), false, (_, _, _, _) => true);
        await pairSsl.AuthenticateAsClientAsync("localhost");
        using var writeLock = new SemaphoreSlim(1, 1);

        var (helloDoc, _) = await TakeoverFraming.ReadFrameAsync(pairSsl, CancellationToken.None);
        Check(helloDoc != null && helloDoc.RootElement.GetProperty("type").GetString() == "hello", "Server must send hello frame upon TLS connect.");
        var certSha = helloDoc!.RootElement.GetProperty("certSha256").GetString()!;
        helloDoc.Dispose();
        Check(certSha == server.CertificateSha256, "Hello frame must report exact server certificate SHA-256.");

        // Probe before pairing
        await TakeoverFraming.WriteFrameAsync(pairSsl, new { type = "probe", clientId, clientName = "Aaron-MacBook" }, null, writeLock, CancellationToken.None);
        var (probeDoc, _) = await TakeoverFraming.ReadFrameAsync(pairSsl, CancellationToken.None);
        Check(probeDoc != null && !probeDoc.RootElement.GetProperty("paired").GetBoolean(), "Unpaired Mac must receive paired=false on probe.");
        probeDoc!.Dispose();

        // Send cryptographic pairing request
        var commitment = TakeoverFraming.ComputePairingCommitment(pin, certSha, clientId, tokenHashHex);
        await TakeoverFraming.WriteFrameAsync(pairSsl, new
        {
            type = "pair_request",
            clientId,
            clientName = "Aaron-MacBook",
            tokenHash = tokenHashHex,
            commitment
        }, null, writeLock, CancellationToken.None);

        // Wait briefly for server to register pending pairing
        IReadOnlyList<PairRequest> livePending = Array.Empty<PairRequest>();
        for (var i = 0; i < 20 && livePending.Count == 0; i++)
        {
            await Task.Delay(25);
            livePending = await liveApi.PendingPairs();
        }
        Check(livePending.Count == 1 && livePending[0].Name == "Aaron-MacBook", "Orbit Host must list pending Mac pairing request.");

        // Entering wrong PIN on PC must fail cryptographically
        await Reject(() => liveApi.Pair(livePending[0].Id, "0000", "Aaron-MacBook"));

        // Entering correct PIN on PC must succeed and notify Mac
        await liveApi.Pair(livePending[0].Id, pin, "Aaron-MacBook");
        var (pairStatusDoc, _) = await TakeoverFraming.ReadFrameAsync(pairSsl, CancellationToken.None);
        Check(pairStatusDoc != null && pairStatusDoc.RootElement.GetProperty("paired").GetBoolean(), "Mac client must receive paired=true after PC approval.");
        pairStatusDoc!.Dispose();
    }

    var pairedClients = await liveApi.Clients();
    Check(pairedClients.Count == 1 && pairedClients[0].Id == clientId, "Paired Mac must persist in host client list.");

    // Connect authenticated OS Takeover session from paired Mac
    using (var sessionTcp = new TcpClient())
    {
        await sessionTcp.ConnectAsync(IPAddress.Loopback, server.TakeoverPort);
        using var sessionSsl = new SslStream(sessionTcp.GetStream(), false, (_, _, _, _) => true);
        await sessionSsl.AuthenticateAsClientAsync("localhost");
        using var writeLock = new SemaphoreSlim(1, 1);

        var (helloDoc, _) = await TakeoverFraming.ReadFrameAsync(sessionSsl, CancellationToken.None);
        var nonce = helloDoc!.RootElement.GetProperty("nonce").GetString()!;
        var certSha = helloDoc.RootElement.GetProperty("certSha256").GetString()!;
        helloDoc.Dispose();

        var proof = TakeoverFraming.ComputeAuthProof(tokenHashHex, nonce, certSha);
        await TakeoverFraming.WriteFrameAsync(sessionSsl, new
        {
            type = "auth",
            clientId,
            clientName = "Aaron-MacBook",
            proof,
            quality = "crisp",
            monitor = 0
        }, null, writeLock, CancellationToken.None);

        var (authDoc, _) = await TakeoverFraming.ReadFrameAsync(sessionSsl, CancellationToken.None);
        Check(authDoc != null && authDoc.RootElement.GetProperty("type").GetString() == "auth_ok", "Valid channel-bound HMAC proof must authenticate takeover session.");
        authDoc!.Dispose();

        // Read initial full dirty-tile frame (simulated on Winlogon UAC Secure Desktop)
        var (frameDoc, frameBin) = await TakeoverFraming.ReadFrameAsync(sessionSsl, CancellationToken.None);
        Check(frameDoc != null && frameDoc.RootElement.GetProperty("type").GetString() == "frame", "Authenticated session must receive initial desktop tile frame.");
        Check(frameDoc!.RootElement.GetProperty("secureDesktop").GetBoolean() && frameDoc.RootElement.GetProperty("desktop").GetString() == "Winlogon", "Frame metadata must report UAC Secure Desktop (Winlogon) state.");
        Check(frameBin.Length > 0 && frameDoc.RootElement.GetProperty("tiles").GetArrayLength() == 1, "256x128 screen must arrive as 1 dirty tile.");
        var seq = frameDoc.RootElement.GetProperty("seq").GetInt64();
        frameDoc.Dispose();

        await TakeoverFraming.WriteFrameAsync(sessionSsl, new { type = "frame_ack", seq }, null, writeLock, CancellationToken.None);

        // Test Remote PowerShell Command Execution over Takeover Session
        await TakeoverFraming.WriteFrameAsync(sessionSsl, new
        {
            type = "exec_cmd",
            id = "test-cmd-1",
            shell = "powershell",
            command = "Write-Output 'ORBIT_REMOTE_OS_OK'"
        }, null, writeLock, CancellationToken.None);

        string cmdOut = "";
        for (var i = 0; i < 10; i++)
        {
            var (msgDoc, _) = await TakeoverFraming.ReadFrameAsync(sessionSsl, CancellationToken.None);
            if (msgDoc == null) break;
            using (msgDoc)
            {
                if (msgDoc.RootElement.GetProperty("type").GetString() == "exec_result")
                {
                    cmdOut = msgDoc.RootElement.GetProperty("stdout").GetString() ?? "";
                    break;
                }
            }
        }
        Check(cmdOut.Contains("ORBIT_REMOTE_OS_OK"), "Remote PowerShell execution must return stdout over takeover channel.");

        // Test Remote File Upload & Download over Takeover Session
        var remoteTestFile = Path.Combine(tempConfigDir, "uploaded-from-mac.txt");
        var uploadBytes = Encoding.UTF8.GetBytes("File transferred from Mac to Windows PC");
        await TakeoverFraming.WriteFrameAsync(sessionSsl, new { type = "fs_upload", path = remoteTestFile }, uploadBytes, writeLock, CancellationToken.None);

        var (upDoc, _) = await TakeoverFraming.ReadFrameAsync(sessionSsl, CancellationToken.None);
        Check(upDoc != null && upDoc.RootElement.GetProperty("ok").GetBoolean() && File.Exists(remoteTestFile), "Remote file upload must write file on PC.");
        upDoc!.Dispose();

        await TakeoverFraming.WriteFrameAsync(sessionSsl, new { type = "fs_download", path = remoteTestFile }, null, writeLock, CancellationToken.None);
        var (downDoc, downBin) = await TakeoverFraming.ReadFrameAsync(sessionSsl, CancellationToken.None);
        Check(downDoc != null && downDoc.RootElement.GetProperty("ok").GetBoolean() && Encoding.UTF8.GetString(downBin) == "File transferred from Mac to Windows PC", "Remote file download must transfer exact file bytes to Mac.");
        downDoc!.Dispose();

        // Test Remote Process Manager Listing
        await TakeoverFraming.WriteFrameAsync(sessionSsl, new { type = "proc_list" }, null, writeLock, CancellationToken.None);
        var (procDoc, _) = await TakeoverFraming.ReadFrameAsync(sessionSsl, CancellationToken.None);
        Check(procDoc != null && procDoc.RootElement.GetProperty("processes").GetArrayLength() > 0, "Remote Task Manager must list active Windows processes.");
        procDoc!.Dispose();
    }

    // Revoke paired Mac and verify removal
    await liveApi.Revoke(clientId);
    Check((await liveApi.Clients()).Count == 0, "Revoking paired Mac must remove it from authorized clients.");
}
finally
{
    try { Directory.Delete(tempConfigDir, recursive: true); } catch { }
}

// =============================================================================
// 4. SSH access for paired devices: add, replace, reject and remove keys
// =============================================================================
{
    var macKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJYyYYQrVmCXPutbo51rHlc9KAXzYkk5SWu29taQTNpb orbit-mac";
    var newerKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINewerKeyNewerKeyNewerKeyNewerKeyNewerKey12";
    var existing = new[] { "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQC7 someone-else" };
    var added = SshAccess.WithKey(existing, "abc123", macKey);
    Check(added.Count == 2 && added[1] == "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJYyYYQrVmCXPutbo51rHlc9KAXzYkk5SWu29taQTNpb orbit:abc123", "A paired device's key is stored once, tagged with its Orbit id.");
    var replaced = SshAccess.WithKey(added, "abc123", newerKey);
    Check(replaced.Count == 2 && replaced[1].Contains("NewerKey"), "A device's newer key replaces its older one.");
    Check(SshAccess.WithoutClient(replaced, "abc123").SequenceEqual(existing), "Unpairing removes only that device's key.");
    foreach (var bad in new[] { "command=\"calc\" ssh-ed25519 AAAA", "ssh-ed25519 AAAA\nssh-rsa BBBB", "not a key", "" })
    {
        try { SshAccess.WithKey(existing, "abc123", bad); Check(false, "A malformed SSH key was accepted."); }
        catch (ArgumentException) { assertions++; }
    }
    Console.WriteLine("PASS: SSH keys of paired devices are added, replaced, rejected when malformed, and removed on unpair.");
}

Console.WriteLine($"PASS: {assertions} setup, authentication, pairing, revocation, dirty-tile zero-idle-bitrate, UAC secure desktop, and remote OS takeover assertions.");

if (args.Length == 2 && args[0] == "--probe-host") {
    using var live = new SunshineApi("orbit-invalid-test-user", "deliberately-invalid", args[1]);
    try { await live.VerifyLogin(); throw new Exception("Invalid credentials were accepted."); }
    catch (HttpRequestException error) when (error.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Found or HttpStatusCode.TemporaryRedirect) {
        Console.WriteLine("PASS: pinned TLS connects and live host denies an unauthenticated admin request.");
    }
    using var key = RSA.Create(2048);
    var certificateRequest = new CertificateRequest("CN=WrongHost", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
    using var wrongCertificate = certificateRequest.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddMinutes(10));
    var tempPath = Path.Combine(Path.GetTempPath(), "orbit-cert-test-" + Guid.NewGuid().ToString("N") + ".pem");
    try {
        File.WriteAllText(tempPath, wrongCertificate.ExportCertificatePem());
        using var wrongHost = new SunshineApi("orbit-invalid-test-user", "deliberately-invalid", tempPath);
        try { await wrongHost.VerifyLogin(); throw new Exception("Wrong host certificate was accepted."); }
        catch (HttpRequestException error) when (error.InnerException is AuthenticationException) {
            Console.WriteLine("PASS: live TLS pinning rejects a mismatched host certificate.");
        }
    } finally { File.Delete(tempPath); }
}

sealed class FakeHandler : HttpMessageHandler
{
    public string Body = "{}";
    public HttpStatusCode Status = HttpStatusCode.OK;
    public string? LastUri, Authorization, PostBody;
    public int Calls;
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Calls++; LastUri = request.RequestUri!.AbsoluteUri; Authorization = request.Headers.Authorization?.ToString();
        PostBody = request.Content == null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
        return new HttpResponseMessage(Status) { Content = new StringContent(Body, Encoding.UTF8, "application/json") };
    }
}
