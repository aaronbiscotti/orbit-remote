using System.Buffers;
using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Orbit.Core;

public sealed class PairedDeviceRecord
{
    public string Uuid { get; set; } = "";
    public string Name { get; set; } = "";
    public string TokenHashHex { get; set; } = "";
    public string PairedAtUtc { get; set; } = "";
}

public sealed class HostPersistedState
{
    public string Username { get; set; } = "";
    public string PasswordSaltHex { get; set; } = "";
    public string PasswordHashHex { get; set; } = "";
    public List<PairedDeviceRecord> Clients { get; set; } = new();
}

public static class TakeoverFraming
{
    public const int MaxJsonBytes = 2 * 1024 * 1024;
    public const int MaxBinaryBytes = 32 * 1024 * 1024;

    public static async Task WriteFrameAsync(Stream stream, object jsonObject, byte[]? binaryPayload, SemaphoreSlim writeLock, CancellationToken ct)
    {
        var jsonBytes = JsonSerializer.SerializeToUtf8Bytes(jsonObject);
        var binBytes = binaryPayload ?? Array.Empty<byte>();
        var header = new byte[8];
        BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(0, 4), jsonBytes.Length);
        BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(4, 4), binBytes.Length);

        await writeLock.WaitAsync(ct);
        try
        {
            await stream.WriteAsync(header, ct);
            await stream.WriteAsync(jsonBytes, ct);
            if (binBytes.Length > 0)
            {
                await stream.WriteAsync(binBytes, ct);
            }
            await stream.FlushAsync(ct);
        }
        finally
        {
            writeLock.Release();
        }
    }

    public static async Task<(JsonDocument? Json, byte[] Binary)> ReadFrameAsync(Stream stream, CancellationToken ct)
    {
        var header = new byte[8];
        if (!await ReadExactAsync(stream, header, ct))
            return (null, Array.Empty<byte>());

        var jsonLen = BinaryPrimitives.ReadInt32BigEndian(header.AsSpan(0, 4));
        var binLen = BinaryPrimitives.ReadInt32BigEndian(header.AsSpan(4, 4));
        if (jsonLen <= 0 || jsonLen > MaxJsonBytes || binLen < 0 || binLen > MaxBinaryBytes)
            throw new InvalidDataException($"Invalid frame header lengths: json={jsonLen}, bin={binLen}");

        var rentedJson = ArrayPool<byte>.Shared.Rent(jsonLen);
        JsonDocument doc;
        try
        {
            if (!await ReadExactAsync(stream, rentedJson.AsMemory(0, jsonLen), ct))
                return (null, Array.Empty<byte>());
            doc = JsonDocument.Parse(rentedJson.AsMemory(0, jsonLen));
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(rentedJson);
        }

        var binBytes = binLen > 0 ? new byte[binLen] : Array.Empty<byte>();
        if (binLen > 0 && !await ReadExactAsync(stream, binBytes.AsMemory(0, binLen), ct))
            return (null, Array.Empty<byte>());

        return (doc, binBytes);
    }

    private static async Task<bool> ReadExactAsync(Stream stream, Memory<byte> buffer, CancellationToken ct)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.Slice(offset, buffer.Length - offset), ct);
            if (read == 0) return false;
            offset += read;
        }
        return true;
    }

    public static string ComputePairingCommitment(string pin, string certSha256Hex, string clientId, string tokenHashHex)
    {
        var keyMaterial = Encoding.UTF8.GetBytes($"{pin.Trim()}:{certSha256Hex.ToLowerInvariant()}");
        var key = SHA256.HashData(keyMaterial);
        var message = Encoding.UTF8.GetBytes($"{clientId}:{tokenHashHex.ToLowerInvariant()}");
        var mac = HMACSHA256.HashData(key, message);
        return Convert.ToHexString(mac).ToLowerInvariant();
    }

    public static string ComputeAuthProof(string tokenHashHex, string serverNonce, string certSha256Hex)
    {
        var key = Convert.FromHexString(tokenHashHex);
        var message = Encoding.UTF8.GetBytes($"{serverNonce}:{certSha256Hex.ToLowerInvariant()}");
        var mac = HMACSHA256.HashData(key, message);
        return Convert.ToHexString(mac).ToLowerInvariant();
    }
}

public sealed class TakeoverServer : IAsyncDisposable
{
    public const int DefaultAdminPort = 47990;
    public const int DefaultTakeoverPort = 47995;

    private readonly string stateFilePath;
    private readonly X509Certificate2 serverCertificate;
    private readonly string certSha256Hex;
    private readonly object stateLock = new();
    private readonly ConcurrentDictionary<string, PendingPairingSession> pendingPairings = new();
    private readonly ConcurrentDictionary<string, ConnectedClientSession> activeSessions = new();
    private readonly CancellationTokenSource cts = new();

    private TcpListener? adminListener;
    private TcpListener? takeoverListener;
    private Task? adminAcceptTask;
    private Task? takeoverAcceptTask;

    public int AdminPort { get; private set; }
    public int TakeoverPort { get; private set; }
    public string CertificateSha256 => certSha256Hex;

    public Func<int, string, bool, CapturedFrameDelta>? CustomCaptureProvider { get; set; }

    private sealed class PendingPairingSession
    {
        public required string PairingId { get; init; }
        public required string ClientId { get; init; }
        public required string ClientName { get; init; }
        public required string Address { get; init; }
        public required string TokenHashHex { get; init; }
        public required string CommitmentHex { get; init; }
        public TaskCompletionSource<bool> ApprovalTcs { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    private sealed class ConnectedClientSession
    {
        public required string SessionId { get; init; }
        public required string ClientId { get; init; }
        public required string ClientName { get; init; }
        public required CancellationTokenSource SessionCts { get; init; }
    }

    public TakeoverServer(string configRoot, int adminPort = DefaultAdminPort, int takeoverPort = DefaultTakeoverPort)
    {
        Directory.CreateDirectory(configRoot);
        var credDir = Path.Combine(configRoot, "credentials");
        Directory.CreateDirectory(credDir);

        stateFilePath = Path.Combine(configRoot, "sunshine_state.json");
        var certPemPath = Path.Combine(credDir, "cacert.pem");
        var keyPemPath = Path.Combine(credDir, "cakey.pem");

        serverCertificate = EnsureCertificate(certPemPath, keyPemPath);
        certSha256Hex = Convert.ToHexString(SHA256.HashData(serverCertificate.RawData)).ToLowerInvariant();
        AdminPort = adminPort;
        TakeoverPort = takeoverPort;

        EnsureStateFileInitialized();
    }

    public void Start()
    {
        adminListener = new TcpListener(IPAddress.Loopback, AdminPort);
        adminListener.Start();
        AdminPort = ((IPEndPoint)adminListener.LocalEndpoint).Port;

        takeoverListener = new TcpListener(IPAddress.Any, TakeoverPort);
        takeoverListener.Start();
        TakeoverPort = ((IPEndPoint)takeoverListener.LocalEndpoint).Port;

        adminAcceptTask = Task.Run(() => AcceptLoopAsync(adminListener, HandleAdminClientAsync, cts.Token));
        takeoverAcceptTask = Task.Run(() => AcceptLoopAsync(takeoverListener, HandleTakeoverClientAsync, cts.Token));
    }

    public static X509Certificate2 EnsureCertificate(string certPemPath, string keyPemPath)
    {
        if (File.Exists(certPemPath) && File.Exists(keyPemPath))
        {
            try
            {
                using var loaded = X509Certificate2.CreateFromPemFile(certPemPath, keyPemPath);
                if (loaded.NotAfter > DateTime.UtcNow.AddDays(1))
                {
                    return MakeSchannelCompatible(loaded);
                }
            }
            catch { }
        }

        using var rsa = RSA.Create(2048);
        var req = new CertificateRequest(
            $"CN={Environment.MachineName}",
            rsa,
            HashAlgorithmName.SHA256,
            RSASignaturePadding.Pkcs1);

        var san = new SubjectAlternativeNameBuilder();
        san.AddIpAddress(IPAddress.Loopback);
        san.AddDnsName("localhost");
        san.AddDnsName(Environment.MachineName);
        req.CertificateExtensions.Add(san.Build());
        req.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, false));
        req.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, false));

        using var generated = req.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddYears(10));
        File.WriteAllText(certPemPath, generated.ExportCertificatePem());
        File.WriteAllText(keyPemPath, rsa.ExportPkcs8PrivateKeyPem());

        return MakeSchannelCompatible(generated);
    }

    private static X509Certificate2 MakeSchannelCompatible(X509Certificate2 certWithKey)
    {
        var pfx = certWithKey.Export(X509ContentType.Pfx, "orbit-local");
        try
        {
            return new X509Certificate2(pfx, "orbit-local", X509KeyStorageFlags.Exportable | X509KeyStorageFlags.UserKeySet);
        }
        catch
        {
            try
            {
                return new X509Certificate2(pfx, "orbit-local", X509KeyStorageFlags.Exportable | X509KeyStorageFlags.MachineKeySet);
            }
            catch
            {
                return new X509Certificate2(pfx, "orbit-local", X509KeyStorageFlags.Exportable);
            }
        }
    }

    private void EnsureStateFileInitialized()
    {
        lock (stateLock)
        {
            if (!File.Exists(stateFilePath))
            {
                SaveStateUnsafe(new HostPersistedState());
            }
        }
    }

    private HostPersistedState LoadStateUnsafe()
    {
        if (!File.Exists(stateFilePath)) return new HostPersistedState();
        try
        {
            var raw = File.ReadAllText(stateFilePath);
            var node = JsonNode.Parse(raw) as JsonObject;
            if (node == null) return new HostPersistedState();

            var state = new HostPersistedState
            {
                Username = node["username"]?.GetValue<string>() ?? "",
                PasswordSaltHex = node["passwordSaltHex"]?.GetValue<string>() ?? "",
                PasswordHashHex = node["passwordHashHex"]?.GetValue<string>() ?? ""
            };

            if (node["clients"] is JsonArray arr)
            {
                foreach (var item in arr.OfType<JsonObject>())
                {
                    state.Clients.Add(new PairedDeviceRecord
                    {
                        Uuid = item["uuid"]?.GetValue<string>() ?? "",
                        Name = item["name"]?.GetValue<string>() ?? "",
                        TokenHashHex = item["tokenHashHex"]?.GetValue<string>() ?? "",
                        PairedAtUtc = item["pairedAtUtc"]?.GetValue<string>() ?? ""
                    });
                }
            }
            return state;
        }
        catch
        {
            return new HostPersistedState();
        }
    }

    private void SaveStateUnsafe(HostPersistedState state)
    {
        var root = new JsonObject
        {
            ["username"] = state.Username,
            ["passwordSaltHex"] = state.PasswordSaltHex,
            ["passwordHashHex"] = state.PasswordHashHex,
            ["clients"] = new JsonArray(state.Clients.Select(c => (JsonNode)new JsonObject
            {
                ["uuid"] = c.Uuid,
                ["name"] = c.Name,
                ["tokenHashHex"] = c.TokenHashHex,
                ["pairedAtUtc"] = c.PairedAtUtc
            }).ToArray())
        };
        File.WriteAllText(stateFilePath, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    }

    private bool VerifyAdminCredentials(string username, string password)
    {
        lock (stateLock)
        {
            var state = LoadStateUnsafe();
            if (string.IsNullOrWhiteSpace(state.Username) || string.IsNullOrWhiteSpace(state.PasswordHashHex))
                return false;
            if (!string.Equals(state.Username, username, StringComparison.Ordinal))
                return false;

            var salt = Convert.FromHexString(state.PasswordSaltHex);
            var expected = Convert.FromHexString(state.PasswordHashHex);
            var actual = Rfc2898DeriveBytes.Pbkdf2(password, salt, 100_000, HashAlgorithmName.SHA256, 32);
            return CryptographicOperations.FixedTimeEquals(expected, actual);
        }
    }

    private async Task AcceptLoopAsync(TcpListener listener, Func<TcpClient, CancellationToken, Task> handler, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var client = await listener.AcceptTcpClientAsync(ct);
                client.NoDelay = true;
                _ = Task.Run(async () =>
                {
                    using (client)
                    {
                        try { await handler(client, ct); }
                        catch { }
                    }
                }, ct);
            }
            catch (OperationCanceledException) { break; }
            catch { await Task.Delay(50, ct).ConfigureAwait(false); }
        }
    }

    // =========================================================================
    // Loopback Admin HTTPS API (127.0.0.1:47990) - Compatible with SunshineApi
    // =========================================================================
    private async Task HandleAdminClientAsync(TcpClient tcp, CancellationToken ct)
    {
        using var ssl = new SslStream(tcp.GetStream(), false);
        await ssl.AuthenticateAsServerAsync(new SslServerAuthenticationOptions
        {
            ServerCertificate = serverCertificate,
            ClientCertificateRequired = false,
            EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13
        }, ct);

        while (!ct.IsCancellationRequested)
        {
            var req = await ReadHttpRequestAsync(ssl, ct);
            if (req == null) break;

            var (method, path, authHeader, body) = req.Value;
            var (statusCode, responseJson) = HandleAdminHttpRequest(method, path, authHeader, body);

            var bodyBytes = Encoding.UTF8.GetBytes(responseJson);
            var statusText = statusCode switch
            {
                200 => "OK",
                400 => "Bad Request",
                401 => "Unauthorized",
                404 => "Not Found",
                _ => "Internal Server Error"
            };

            var header = $"HTTP/1.1 {statusCode} {statusText}\r\n" +
                         "Content-Type: application/json; charset=utf-8\r\n" +
                         $"Content-Length: {bodyBytes.Length}\r\n" +
                         "Connection: keep-alive\r\n\r\n";
            var headerBytes = Encoding.ASCII.GetBytes(header);
            await ssl.WriteAsync(headerBytes, ct);
            await ssl.WriteAsync(bodyBytes, ct);
            await ssl.FlushAsync(ct);
        }
    }

    private (int StatusCode, string Json) HandleAdminHttpRequest(string method, string path, string? authHeader, string body)
    {
        var cleanPath = path.Trim('/').ToLowerInvariant();

        if (method == "POST" && cleanPath == "api/password")
        {
            try
            {
                using var doc = JsonDocument.Parse(body);
                var root = doc.RootElement;
                var newUsername = root.TryGetProperty("newUsername", out var nu) ? nu.GetString() ?? "" : "";
                var newPassword = root.TryGetProperty("newPassword", out var np) ? np.GetString() ?? "" : "";
                var currentUsername = root.TryGetProperty("currentUsername", out var cu) ? cu.GetString() ?? "" : "";
                var currentPassword = root.TryGetProperty("currentPassword", out var cp) ? cp.GetString() ?? "" : "";

                if (string.IsNullOrWhiteSpace(newUsername) || newUsername.Contains(':') || newPassword.Length < 12)
                    return (400, "{\"status\":false,\"error\":\"Invalid username or password.\"}");

                lock (stateLock)
                {
                    var state = LoadStateUnsafe();
                    if (!string.IsNullOrWhiteSpace(state.Username))
                    {
                        if (!VerifyAdminCredentials(currentUsername, currentPassword) && !VerifyBasicHeader(authHeader))
                            return (401, "{\"status\":false,\"error\":\"Unauthorized\"}");
                    }

                    var salt = RandomNumberGenerator.GetBytes(16);
                    var hash = Rfc2898DeriveBytes.Pbkdf2(newPassword, salt, 100_000, HashAlgorithmName.SHA256, 32);
                    state.Username = newUsername;
                    state.PasswordSaltHex = Convert.ToHexString(salt).ToLowerInvariant();
                    state.PasswordHashHex = Convert.ToHexString(hash).ToLowerInvariant();
                    SaveStateUnsafe(state);
                }

                return (200, "{\"status\":true}");
            }
            catch
            {
                return (400, "{\"status\":false}");
            }
        }

        if (!VerifyBasicHeader(authHeader))
        {
            return (401, "{\"status\":false,\"error\":\"Unauthorized\"}");
        }

        if (method == "GET" && cleanPath == "api/config")
        {
            var desk = SecureDesktopManager.AttachThreadToInputDesktop();
            var obj = new JsonObject
            {
                ["status"] = true,
                ["engine"] = "orbit-takeover",
                ["takeoverPort"] = TakeoverPort,
                ["privilege"] = SecureDesktopManager.PrivilegeLabel(desk.Privilege),
                ["desktop"] = desk.Name,
                ["secureDesktop"] = desk.IsSecureDesktop,
                ["activeSessions"] = activeSessions.Count
            };
            return (200, obj.ToJsonString());
        }

        if (method == "GET" && cleanPath == "api/pin")
        {
            var list = pendingPairings.Values.Select(p => (JsonNode)new JsonObject
            {
                ["id"] = p.PairingId,
                ["name"] = p.ClientName,
                ["address"] = p.Address
            }).ToArray();

            var obj = new JsonObject
            {
                ["status"] = true,
                ["pairings"] = new JsonArray(list)
            };
            return (200, obj.ToJsonString());
        }

        if (method == "POST" && cleanPath == "api/pin")
        {
            try
            {
                using var doc = JsonDocument.Parse(body);
                var root = doc.RootElement;
                var pairingId = root.TryGetProperty("pairing_id", out var pid) ? pid.GetString() ?? "" : "";
                var pin = root.TryGetProperty("pin", out var p) ? p.GetString() ?? "" : "";
                var name = root.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";

                if (!SunshineApi.ValidPin(pin) || !pendingPairings.TryGetValue(pairingId, out var session))
                    return (200, "{\"status\":false}");

                var expectedCommit = TakeoverFraming.ComputePairingCommitment(pin, certSha256Hex, session.ClientId, session.TokenHashHex);
                var expectedBytes = Convert.FromHexString(expectedCommit);
                var providedBytes = Convert.FromHexString(session.CommitmentHex);

                if (!CryptographicOperations.FixedTimeEquals(expectedBytes, providedBytes))
                {
                    return (200, "{\"status\":false}");
                }

                pendingPairings.TryRemove(pairingId, out _);

                lock (stateLock)
                {
                    var state = LoadStateUnsafe();
                    state.Clients.RemoveAll(c => string.Equals(c.Uuid, session.ClientId, StringComparison.OrdinalIgnoreCase));
                    state.Clients.Add(new PairedDeviceRecord
                    {
                        Uuid = session.ClientId,
                        Name = string.IsNullOrWhiteSpace(name) ? session.ClientName : name,
                        TokenHashHex = session.TokenHashHex.ToLowerInvariant(),
                        PairedAtUtc = DateTime.UtcNow.ToString("O")
                    });
                    SaveStateUnsafe(state);
                }

                session.ApprovalTcs.TrySetResult(true);
                return (200, "{\"status\":true}");
            }
            catch
            {
                return (200, "{\"status\":false}");
            }
        }

        if (method == "GET" && cleanPath == "api/clients/list")
        {
            lock (stateLock)
            {
                var state = LoadStateUnsafe();
                var arr = new JsonArray(state.Clients.Select(c => (JsonNode)new JsonObject
                {
                    ["uuid"] = c.Uuid,
                    ["name"] = c.Name
                }).ToArray());
                var obj = new JsonObject
                {
                    ["status"] = true,
                    ["named_certs"] = arr
                };
                return (200, obj.ToJsonString());
            }
        }

        if (method == "POST" && cleanPath == "api/clients/unpair")
        {
            try
            {
                using var doc = JsonDocument.Parse(body);
                var uuid = doc.RootElement.TryGetProperty("uuid", out var u) ? u.GetString() ?? "" : "";
                if (string.IsNullOrWhiteSpace(uuid)) return (200, "{\"status\":false}");

                bool removed;
                lock (stateLock)
                {
                    var state = LoadStateUnsafe();
                    removed = state.Clients.RemoveAll(c => string.Equals(c.Uuid, uuid, StringComparison.OrdinalIgnoreCase)) > 0;
                    SaveStateUnsafe(state);
                }

                foreach (var kv in activeSessions)
                {
                    if (string.Equals(kv.Value.ClientId, uuid, StringComparison.OrdinalIgnoreCase))
                    {
                        kv.Value.SessionCts.Cancel();
                    }
                }

                return (200, removed ? "{\"status\":true}" : "{\"status\":false}");
            }
            catch
            {
                return (200, "{\"status\":false}");
            }
        }

        return (404, "{\"status\":false}");
    }

    private bool VerifyBasicHeader(string? authHeader)
    {
        if (string.IsNullOrWhiteSpace(authHeader) || !authHeader.StartsWith("Basic ", StringComparison.OrdinalIgnoreCase))
            return false;
        try
        {
            var decoded = Encoding.UTF8.GetString(Convert.FromBase64String(authHeader[6..].Trim()));
            var idx = decoded.IndexOf(':');
            if (idx <= 0) return false;
            return VerifyAdminCredentials(decoded[..idx], decoded[(idx + 1)..]);
        }
        catch
        {
            return false;
        }
    }

    private static async Task<(string Method, string Path, string? AuthHeader, string Body)?> ReadHttpRequestAsync(Stream stream, CancellationToken ct)
    {
        var headerBuffer = new List<byte>(1024);
        var single = new byte[1];
        while (headerBuffer.Count < 32768)
        {
            var r = await stream.ReadAsync(single, ct);
            if (r == 0) return null;
            headerBuffer.Add(single[0]);
            var count = headerBuffer.Count;
            if (count >= 4 &&
                headerBuffer[count - 4] == '\r' &&
                headerBuffer[count - 3] == '\n' &&
                headerBuffer[count - 2] == '\r' &&
                headerBuffer[count - 1] == '\n')
            {
                break;
            }
        }

        var headerText = Encoding.ASCII.GetString(headerBuffer.ToArray());
        var lines = headerText.Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
        if (lines.Length == 0) return null;

        var parts = lines[0].Split(' ');
        if (parts.Length < 2) return null;
        var method = parts[0].ToUpperInvariant();
        var path = parts[1];

        string? auth = null;
        var contentLength = 0;
        var isChunked = false;
        foreach (var line in lines.Skip(1))
        {
            var colon = line.IndexOf(':');
            if (colon <= 0) continue;
            var name = line[..colon].Trim();
            var val = line[(colon + 1)..].Trim();
            if (name.Equals("Authorization", StringComparison.OrdinalIgnoreCase)) auth = val;
            else if (name.Equals("Content-Length", StringComparison.OrdinalIgnoreCase)) int.TryParse(val, out contentLength);
            else if (name.Equals("Transfer-Encoding", StringComparison.OrdinalIgnoreCase) && val.Contains("chunked", StringComparison.OrdinalIgnoreCase))
                isChunked = true;
        }

        var body = "";
        if (isChunked)
        {
            using var bodyStream = new MemoryStream();
            while (true)
            {
                var sizeLine = await ReadAsciiLineAsync(stream, ct);
                if (sizeLine == null) break;
                var semi = sizeLine.IndexOf(';');
                if (semi >= 0) sizeLine = sizeLine[..semi];
                if (!int.TryParse(sizeLine.Trim(), System.Globalization.NumberStyles.HexNumber, null, out var chunkSize) || chunkSize < 0)
                    break;
                if (chunkSize == 0)
                {
                    _ = await ReadAsciiLineAsync(stream, ct); // trailing CRLF
                    break;
                }
                var chunk = new byte[chunkSize];
                var readTotal = 0;
                while (readTotal < chunkSize)
                {
                    var r = await stream.ReadAsync(chunk.AsMemory(readTotal, chunkSize - readTotal), ct);
                    if (r == 0) break;
                    readTotal += r;
                }
                bodyStream.Write(chunk, 0, readTotal);
                _ = await ReadAsciiLineAsync(stream, ct); // chunk CRLF
            }
            body = Encoding.UTF8.GetString(bodyStream.ToArray());
        }
        else if (contentLength > 0 && contentLength <= 1024 * 1024)
        {
            var bodyBytes = new byte[contentLength];
            var offset = 0;
            while (offset < contentLength)
            {
                var read = await stream.ReadAsync(bodyBytes.AsMemory(offset, contentLength - offset), ct);
                if (read == 0) break;
                offset += read;
            }
            body = Encoding.UTF8.GetString(bodyBytes, 0, offset);
        }

        return (method, path, auth, body);
    }

    private static async Task<string?> ReadAsciiLineAsync(Stream stream, CancellationToken ct)
    {
        var bytes = new List<byte>(64);
        var b = new byte[1];
        while (bytes.Count < 4096)
        {
            var r = await stream.ReadAsync(b, ct);
            if (r == 0) return bytes.Count == 0 ? null : Encoding.ASCII.GetString(bytes.ToArray());
            if (b[0] == '\n')
            {
                if (bytes.Count > 0 && bytes[^1] == '\r') bytes.RemoveAt(bytes.Count - 1);
                return Encoding.ASCII.GetString(bytes.ToArray());
            }
            bytes.Add(b[0]);
        }
        return Encoding.ASCII.GetString(bytes.ToArray());
    }

    // =========================================================================
    // Remote OS Takeover TLS Server (0.0.0.0:47995)
    // =========================================================================
    private async Task HandleTakeoverClientAsync(TcpClient tcp, CancellationToken ct)
    {
        var remoteIp = (tcp.Client.RemoteEndPoint as IPEndPoint)?.Address.ToString() ?? "unknown";
        using var ssl = new SslStream(tcp.GetStream(), false);
        await ssl.AuthenticateAsServerAsync(new SslServerAuthenticationOptions
        {
            ServerCertificate = serverCertificate,
            ClientCertificateRequired = false,
            EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13
        }, ct);

        using var sessionCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var sessionToken = sessionCts.Token;
        using var writeLock = new SemaphoreSlim(1, 1);
        using var inputWakeSignal = new SemaphoreSlim(0, 100);

        var serverNonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var desk = SecureDesktopManager.AttachThreadToInputDesktop();
        var monitors = DesktopCaptureEngine.GetMonitors();

        await TakeoverFraming.WriteFrameAsync(ssl, new
        {
            type = "hello",
            hostname = Environment.MachineName,
            version = "1.0.0",
            nonce = serverNonce,
            certSha256 = certSha256Hex,
            privilege = SecureDesktopManager.PrivilegeLabel(desk.Privilege),
            desktop = desk.Name,
            secureDesktop = desk.IsSecureDesktop,
            monitors
        }, null, writeLock, sessionToken);

        var authenticated = false;
        var sessionKey = Guid.NewGuid().ToString("N");
        var selectedMonitor = 0;
        var selectedQuality = "crisp";
        var forceFullFrame = true;
        var lastAckedSeq = 0L;
        var lastSentSeq = 0L;
        var lastAckTime = DateTime.UtcNow;
        var shellCwd = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        Task? streamLoopTask = null;

        try
        {
            while (!sessionToken.IsCancellationRequested)
            {
                var (doc, binaryPayload) = await TakeoverFraming.ReadFrameAsync(ssl, sessionToken);
                if (doc == null) break;

                using (doc)
                {
                    var root = doc.RootElement;
                    var type = root.TryGetProperty("type", out var tProp) ? tProp.GetString() ?? "" : "";

                    if (type == "probe")
                    {
                        var clientId = root.TryGetProperty("clientId", out var cid) ? cid.GetString() ?? "" : "";
                        var isPaired = IsClientPaired(clientId);
                        var currentDesk = SecureDesktopManager.AttachThreadToInputDesktop();
                        await TakeoverFraming.WriteFrameAsync(ssl, new
                        {
                            type = "probe_result",
                            hostname = Environment.MachineName,
                            paired = isPaired,
                            certSha256 = certSha256Hex,
                            privilege = SecureDesktopManager.PrivilegeLabel(currentDesk.Privilege),
                            desktop = currentDesk.Name,
                            secureDesktop = currentDesk.IsSecureDesktop,
                            monitors = DesktopCaptureEngine.GetMonitors()
                        }, null, writeLock, sessionToken);
                        continue;
                    }

                    if (type == "pair_request")
                    {
                        var clientId = root.TryGetProperty("clientId", out var cid) ? cid.GetString() ?? "" : "";
                        var clientName = root.TryGetProperty("clientName", out var cname) ? cname.GetString() ?? "Mac" : "Mac";
                        var tokenHashHex = root.TryGetProperty("tokenHash", out var th) ? th.GetString() ?? "" : "";
                        var commitmentHex = root.TryGetProperty("commitment", out var cm) ? cm.GetString() ?? "" : "";

                        if (string.IsNullOrWhiteSpace(clientId) || tokenHashHex.Length != 64 || commitmentHex.Length != 64)
                        {
                            await TakeoverFraming.WriteFrameAsync(ssl, new { type = "pair_status", paired = false, error = "Invalid pairing request." }, null, writeLock, sessionToken);
                            continue;
                        }

                        var pairingId = Guid.NewGuid().ToString("N");
                        var pending = new PendingPairingSession
                        {
                            PairingId = pairingId,
                            ClientId = clientId,
                            ClientName = clientName,
                            Address = remoteIp,
                            TokenHashHex = tokenHashHex,
                            CommitmentHex = commitmentHex
                        };

                        // Remove any stale pending request from the same clientId
                        foreach (var old in pendingPairings.Where(kv => kv.Value.ClientId == clientId).ToList())
                        {
                            if (pendingPairings.TryRemove(old.Key, out var removed))
                                removed.ApprovalTcs.TrySetResult(false);
                        }

                        pendingPairings[pairingId] = pending;
                        try
                        {
                            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(sessionToken);
                            timeoutCts.CancelAfter(TimeSpan.FromMinutes(5));
                            var approved = await pending.ApprovalTcs.Task.WaitAsync(timeoutCts.Token);
                            await TakeoverFraming.WriteFrameAsync(ssl, new
                            {
                                type = "pair_status",
                                paired = approved,
                                certSha256 = certSha256Hex,
                                hostname = Environment.MachineName
                            }, null, writeLock, sessionToken);
                        }
                        finally
                        {
                            pendingPairings.TryRemove(pairingId, out _);
                        }
                        continue;
                    }

                    if (type == "auth")
                    {
                        var clientId = root.TryGetProperty("clientId", out var cid) ? cid.GetString() ?? "" : "";
                        var clientName = root.TryGetProperty("clientName", out var cname) ? cname.GetString() ?? "Mac" : "Mac";
                        var proofHex = root.TryGetProperty("proof", out var pr) ? pr.GetString() ?? "" : "";
                        if (root.TryGetProperty("quality", out var qProp) && qProp.GetString() is string q && q.Length > 0)
                            selectedQuality = q;
                        if (root.TryGetProperty("monitor", out var mProp) && mProp.TryGetInt32(out var mIdx))
                            selectedMonitor = mIdx;

                        if (!VerifyClientAuthProof(clientId, serverNonce, proofHex))
                        {
                            await TakeoverFraming.WriteFrameAsync(ssl, new { type = "auth_error", error = "Device authentication failed. Re-pair your Mac in Orbit Host." }, null, writeLock, sessionToken);
                            break;
                        }

                        authenticated = true;
                        activeSessions[sessionKey] = new ConnectedClientSession
                        {
                            SessionId = sessionKey,
                            ClientId = clientId,
                            ClientName = clientName,
                            SessionCts = sessionCts
                        };

                        var curDesk = SecureDesktopManager.AttachThreadToInputDesktop();
                        await TakeoverFraming.WriteFrameAsync(ssl, new
                        {
                            type = "auth_ok",
                            hostname = Environment.MachineName,
                            privilege = SecureDesktopManager.PrivilegeLabel(curDesk.Privilege),
                            desktop = curDesk.Name,
                            secureDesktop = curDesk.IsSecureDesktop,
                            monitors = DesktopCaptureEngine.GetMonitors(),
                            privacyCurtain = DisplayTakeoverManager.IsPrivacyCurtainActive
                        }, null, writeLock, sessionToken);

                        forceFullFrame = true;
                        streamLoopTask = Task.Run(async () =>
                        {
                            using var captureEngine = new DesktopCaptureEngine();
                            while (!sessionToken.IsCancellationRequested)
                            {
                                try
                                {
                                    // Backpressure control: wait until the client acknowledges the previous frame (or 2s recovery timeout)
                                    var canSend = lastAckedSeq >= lastSentSeq || (DateTime.UtcNow - lastAckTime).TotalMilliseconds > 2000;
                                    if (canSend)
                                    {
                                        var reqFull = forceFullFrame;
                                        forceFullFrame = false;
                                        var delta = CustomCaptureProvider != null
                                            ? CustomCaptureProvider(selectedMonitor, selectedQuality, reqFull)
                                            : captureEngine.CaptureNextDelta(selectedMonitor, selectedQuality, reqFull);

                                        if (delta.Tiles.Count > 0)
                                        {
                                            lastSentSeq = delta.Sequence;
                                            lastAckTime = DateTime.UtcNow;
                                            await TakeoverFraming.WriteFrameAsync(ssl, new
                                            {
                                                type = "frame",
                                                seq = delta.Sequence,
                                                screenW = delta.ScreenWidth,
                                                screenH = delta.ScreenHeight,
                                                desktop = delta.DesktopName,
                                                secureDesktop = delta.IsSecureDesktop,
                                                privilege = delta.Privilege,
                                                cursorX = delta.CursorX,
                                                cursorY = delta.CursorY,
                                                full = delta.FullFrame,
                                                tiles = delta.Tiles.Select(t => new
                                                {
                                                    x = t.X,
                                                    y = t.Y,
                                                    w = t.W,
                                                    h = t.H,
                                                    offset = t.Offset,
                                                    length = t.Length,
                                                    format = t.Format
                                                })
                                            }, delta.Payload, writeLock, sessionToken);
                                        }
                                    }

                                    // Wait up to 33ms (~30Hz dirty check), waking immediately on user input or frame_ack
                                    await inputWakeSignal.WaitAsync(33, sessionToken);
                                }
                                catch (OperationCanceledException) { break; }
                                catch { await Task.Delay(100, sessionToken); }
                            }
                        }, sessionToken);
                        continue;
                    }

                    if (!authenticated)
                    {
                        await TakeoverFraming.WriteFrameAsync(ssl, new { type = "error", error = "Unauthenticated session." }, null, writeLock, sessionToken);
                        break;
                    }

                    switch (type)
                    {
                        case "frame_ack":
                            if (root.TryGetProperty("seq", out var seqProp) && seqProp.TryGetInt64(out var ackSeq))
                            {
                                lastAckedSeq = Math.Max(lastAckedSeq, ackSeq);
                                SignalWake(inputWakeSignal);
                            }
                            break;

                        case "mouse":
                        {
                            var action = root.TryGetProperty("action", out var a) ? a.GetString() ?? "move" : "move";
                            var x = root.TryGetProperty("x", out var xp) && xp.TryGetDouble(out var xv) ? xv : 0.5;
                            var y = root.TryGetProperty("y", out var yp) && yp.TryGetDouble(out var yv) ? yv : 0.5;
                            var button = root.TryGetProperty("button", out var bp) ? bp.GetString() ?? "left" : "left";
                            var dx = root.TryGetProperty("deltaX", out var dxp) && dxp.TryGetInt32(out var dxv) ? dxv : 0;
                            var dy = root.TryGetProperty("deltaY", out var dyp) && dyp.TryGetInt32(out var dyv) ? dyv : 0;
                            DesktopInputInjector.InjectMouse(selectedMonitor, action, x, y, button, dx, dy);
                            SignalWake(inputWakeSignal);
                            break;
                        }

                        case "key":
                        {
                            var action = root.TryGetProperty("action", out var a) ? a.GetString() ?? "press" : "press";
                            var vk = (ushort)(root.TryGetProperty("vk", out var vp) && vp.TryGetInt32(out var vv) ? vv : 0);
                            var ctrl = root.TryGetProperty("ctrl", out var cp) && cp.GetBoolean();
                            var alt = root.TryGetProperty("alt", out var ap) && ap.GetBoolean();
                            var shift = root.TryGetProperty("shift", out var sp) && sp.GetBoolean();
                            var win = root.TryGetProperty("win", out var wp) && wp.GetBoolean();
                            DesktopInputInjector.InjectKey(action, vk, ctrl, alt, shift, win);
                            SignalWake(inputWakeSignal);
                            break;
                        }

                        case "text":
                        {
                            var text = root.TryGetProperty("text", out var tp) ? tp.GetString() ?? "" : "";
                            DesktopInputInjector.InjectText(text);
                            SignalWake(inputWakeSignal);
                            break;
                        }

                        case "sas":
                        {
                            var ok = SecureDesktopManager.SendSecureAttentionSequence();
                            forceFullFrame = true;
                            SignalWake(inputWakeSignal);
                            await TakeoverFraming.WriteFrameAsync(ssl, new { type = "sas_result", ok }, null, writeLock, sessionToken);
                            break;
                        }

                        case "display_config":
                        {
                            if (root.TryGetProperty("monitor", out var mp) && mp.TryGetInt32(out var mIdx))
                                selectedMonitor = mIdx;
                            if (root.TryGetProperty("quality", out var qp) && qp.GetString() is string q && q.Length > 0)
                                selectedQuality = q;
                            if (root.TryGetProperty("width", out var wp) && wp.TryGetInt32(out var reqW) &&
                                root.TryGetProperty("height", out var hp) && hp.TryGetInt32(out var reqH) &&
                                reqW >= 800 && reqH >= 600)
                            {
                                _ = DisplayTakeoverManager.SetResolution(reqW, reqH);
                            }
                            if (root.TryGetProperty("restoreResolution", out var rp) && rp.GetBoolean())
                            {
                                DisplayTakeoverManager.RestoreResolution();
                            }
                            forceFullFrame = true;
                            SignalWake(inputWakeSignal);
                            break;
                        }

                        case "privacy_curtain":
                        {
                            var enabled = root.TryGetProperty("enabled", out var ep) && ep.GetBoolean();
                            DisplayTakeoverManager.SetPrivacyCurtain(enabled);
                            await TakeoverFraming.WriteFrameAsync(ssl, new
                            {
                                type = "privacy_curtain_result",
                                enabled = DisplayTakeoverManager.IsPrivacyCurtainActive
                            }, null, writeLock, sessionToken);
                            break;
                        }

                        case "clipboard_get":
                        {
                            var text = RemoteOsController.GetClipboardText();
                            await TakeoverFraming.WriteFrameAsync(ssl, new { type = "clipboard_data", text }, null, writeLock, sessionToken);
                            break;
                        }

                        case "clipboard_set":
                        {
                            var text = root.TryGetProperty("text", out var tp) ? tp.GetString() ?? "" : "";
                            RemoteOsController.SetClipboardText(text);
                            SignalWake(inputWakeSignal);
                            break;
                        }

                        case "exec_cmd":
                        {
                            var cmdId = root.TryGetProperty("id", out var idp) ? idp.GetString() ?? "1" : "1";
                            var command = root.TryGetProperty("command", out var cmdp) ? cmdp.GetString() ?? "" : "";
                            var shell = root.TryGetProperty("shell", out var shp) ? shp.GetString() ?? "powershell" : "powershell";
                            _ = Task.Run(async () =>
                            {
                                var output = await RemoteOsController.ExecuteCommandAsync(command, shellCwd, shell);
                                shellCwd = output.WorkingDirectory;
                                await TakeoverFraming.WriteFrameAsync(ssl, new
                                {
                                    type = "exec_result",
                                    id = cmdId,
                                    exitCode = output.ExitCode,
                                    stdout = output.Stdout,
                                    stderr = output.Stderr,
                                    cwd = output.WorkingDirectory
                                }, null, writeLock, sessionToken);
                            }, sessionToken);
                            break;
                        }

                        case "fs_list":
                        {
                            var reqPath = root.TryGetProperty("path", out var pp) ? pp.GetString() ?? "" : "";
                            var listing = RemoteOsController.ListDirectory(reqPath);
                            await TakeoverFraming.WriteFrameAsync(ssl, new
                            {
                                type = "fs_list_result",
                                path = listing.CurrentPath,
                                parent = listing.ParentPath,
                                error = listing.Error ?? "",
                                entries = listing.Entries.Select(e => new
                                {
                                    name = e.Name,
                                    path = e.Path,
                                    isDir = e.IsDirectory,
                                    size = e.Size,
                                    modified = e.Modified
                                })
                            }, null, writeLock, sessionToken);
                            break;
                        }

                        case "fs_download":
                        {
                            var reqPath = root.TryGetProperty("path", out var pp) ? pp.GetString() ?? "" : "";
                            try
                            {
                                var bytes = RemoteOsController.ReadFileBytes(reqPath);
                                await TakeoverFraming.WriteFrameAsync(ssl, new
                                {
                                    type = "fs_download_result",
                                    ok = true,
                                    name = Path.GetFileName(reqPath),
                                    path = reqPath
                                }, bytes, writeLock, sessionToken);
                            }
                            catch (Exception ex)
                            {
                                await TakeoverFraming.WriteFrameAsync(ssl, new
                                {
                                    type = "fs_download_result",
                                    ok = false,
                                    name = Path.GetFileName(reqPath),
                                    path = reqPath,
                                    error = ex.Message
                                }, null, writeLock, sessionToken);
                            }
                            break;
                        }

                        case "fs_upload":
                        {
                            var destPath = root.TryGetProperty("path", out var pp) ? pp.GetString() ?? "" : "";
                            try
                            {
                                RemoteOsController.WriteFileBytes(destPath, binaryPayload);
                                await TakeoverFraming.WriteFrameAsync(ssl, new
                                {
                                    type = "fs_upload_result",
                                    ok = true,
                                    path = destPath
                                }, null, writeLock, sessionToken);
                            }
                            catch (Exception ex)
                            {
                                await TakeoverFraming.WriteFrameAsync(ssl, new
                                {
                                    type = "fs_upload_result",
                                    ok = false,
                                    path = destPath,
                                    error = ex.Message
                                }, null, writeLock, sessionToken);
                            }
                            break;
                        }

                        case "fs_delete":
                        {
                            var targetPath = root.TryGetProperty("path", out var pp) ? pp.GetString() ?? "" : "";
                            try
                            {
                                RemoteOsController.DeletePath(targetPath);
                                await TakeoverFraming.WriteFrameAsync(ssl, new { type = "fs_delete_result", ok = true, path = targetPath }, null, writeLock, sessionToken);
                            }
                            catch (Exception ex)
                            {
                                await TakeoverFraming.WriteFrameAsync(ssl, new { type = "fs_delete_result", ok = false, path = targetPath, error = ex.Message }, null, writeLock, sessionToken);
                            }
                            break;
                        }

                        case "proc_list":
                        {
                            var procs = RemoteOsController.ListProcesses();
                            await TakeoverFraming.WriteFrameAsync(ssl, new
                            {
                                type = "proc_list_result",
                                processes = procs.Select(p => new
                                {
                                    pid = p.Id,
                                    name = p.Name,
                                    memoryMb = p.MemoryMb,
                                    elevated = p.Elevated,
                                    title = p.WindowTitle
                                })
                            }, null, writeLock, sessionToken);
                            break;
                        }

                        case "proc_kill":
                        {
                            var pid = root.TryGetProperty("pid", out var pidp) && pidp.TryGetInt32(out var pv) ? pv : 0;
                            var ok = RemoteOsController.KillProcess(pid);
                            await TakeoverFraming.WriteFrameAsync(ssl, new { type = "proc_kill_result", ok, pid }, null, writeLock, sessionToken);
                            break;
                        }

                        case "sys_power":
                        {
                            var action = root.TryGetProperty("action", out var ap) ? ap.GetString() ?? "" : "";
                            var ok = RemoteOsController.ExecutePowerAction(action);
                            forceFullFrame = true;
                            SignalWake(inputWakeSignal);
                            await TakeoverFraming.WriteFrameAsync(ssl, new { type = "sys_power_result", ok, action }, null, writeLock, sessionToken);
                            break;
                        }
                    }
                }
            }
        }
        finally
        {
            sessionCts.Cancel();
            activeSessions.TryRemove(sessionKey, out _);
            if (authenticated && activeSessions.IsEmpty)
            {
                DisplayTakeoverManager.SetPrivacyCurtain(false);
                DisplayTakeoverManager.RestoreResolution();
            }
            if (streamLoopTask != null)
            {
                try { await streamLoopTask; } catch { }
            }
        }
    }

    private static void SignalWake(SemaphoreSlim sem)
    {
        try
        {
            if (sem.CurrentCount == 0) sem.Release();
        }
        catch { }
    }

    private bool IsClientPaired(string clientId)
    {
        if (string.IsNullOrWhiteSpace(clientId)) return false;
        lock (stateLock)
        {
            var state = LoadStateUnsafe();
            return state.Clients.Any(c => string.Equals(c.Uuid, clientId, StringComparison.OrdinalIgnoreCase));
        }
    }

    private bool VerifyClientAuthProof(string clientId, string serverNonce, string providedProofHex)
    {
        if (string.IsNullOrWhiteSpace(clientId) || providedProofHex.Length != 64) return false;
        string? tokenHashHex;
        lock (stateLock)
        {
            var state = LoadStateUnsafe();
            tokenHashHex = state.Clients.FirstOrDefault(c => string.Equals(c.Uuid, clientId, StringComparison.OrdinalIgnoreCase))?.TokenHashHex;
        }
        if (string.IsNullOrWhiteSpace(tokenHashHex) || tokenHashHex.Length != 64) return false;

        try
        {
            var expectedHex = TakeoverFraming.ComputeAuthProof(tokenHashHex, serverNonce, certSha256Hex);
            return CryptographicOperations.FixedTimeEquals(
                Convert.FromHexString(expectedHex),
                Convert.FromHexString(providedProofHex));
        }
        catch
        {
            return false;
        }
    }

    public async ValueTask DisposeAsync()
    {
        cts.Cancel();
        try { adminListener?.Stop(); } catch { }
        try { takeoverListener?.Stop(); } catch { }
        if (adminAcceptTask != null) { try { await adminAcceptTask; } catch { } }
        if (takeoverAcceptTask != null) { try { await takeoverAcceptTask; } catch { } }
        serverCertificate.Dispose();
        cts.Dispose();
    }
}
