using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;

namespace Orbit.Core;

public sealed record PairRequest(string Id, string Name, string Address);
public sealed record PairedClient(string Id, string Name);
public sealed record HostLiveStatus(string Privilege, string Desktop, bool SecureDesktop, int ActiveSessions);

// This companion only talks to the loopback admin endpoint. The takeover engine
// owns all remote authentication and cryptography.
public sealed class SunshineApi : IDisposable
{
    private readonly HttpClient client;
    public SunshineApi(string username, string password, string certificatePath, int port = 47990)
    {
        using var trusted = X509Certificate2.CreateFromPem(File.ReadAllText(certificatePath));
        var expected = SHA256.HashData(trusted.RawData);
        var handler = new HttpClientHandler {
            AllowAutoRedirect = false,
            UseProxy = false,
            ServerCertificateCustomValidationCallback = (request, certificate, _, _) =>
                request.RequestUri?.Host == "127.0.0.1" && certificate != null &&
                CryptographicOperations.FixedTimeEquals(expected, SHA256.HashData(certificate.RawData))
        };
        client = CreateClient(handler, username, password, port);
    }

    // Used by integration tests to exercise request formats and fail-closed behavior.
    public SunshineApi(HttpMessageHandler handler, string username, string password) =>
        client = CreateClient(handler, username, password, 47990);

    private static HttpClient CreateClient(HttpMessageHandler handler, string username, string password, int port)
    {
        var http = new HttpClient(handler) { BaseAddress = new Uri($"https://127.0.0.1:{port}/"), Timeout = TimeSpan.FromSeconds(35) };
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Basic",
            Convert.ToBase64String(Encoding.UTF8.GetBytes(username + ":" + password)));
        return http;
    }

    private async Task<JsonElement> Read(string path)
    {
        using var response = await client.GetAsync(path);
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        if (document.RootElement.TryGetProperty("status", out var status) && status.ValueKind == JsonValueKind.False)
            throw new InvalidOperationException("Sunshine rejected this request.");
        return document.RootElement.Clone();
    }

    public async Task VerifyLogin() => _ = await Read("api/config");

    public async Task<HostLiveStatus> GetStatus()
    {
        var root = await Read("api/config");
        var priv = Get(root, "privilege");
        var desk = Get(root, "desktop");
        var secure = root.TryGetProperty("secureDesktop", out var s) && s.ValueKind == JsonValueKind.True;
        var sessions = root.TryGetProperty("activeSessions", out var a) && a.TryGetInt32(out var count) ? count : 0;
        return new HostLiveStatus(
            string.IsNullOrEmpty(priv) ? "Standard" : priv,
            string.IsNullOrEmpty(desk) ? "Default" : desk,
            secure,
            sessions);
    }

    public Task CreateInitialLogin(string username, string password)
    {
        if (string.IsNullOrWhiteSpace(username) || username.Contains(':') || password.Length < 12)
            throw new ArgumentException("Choose a username without a colon and a password of at least 12 characters.");
        return Post("api/password", new { currentUsername = "", currentPassword = "", newUsername = username,
            newPassword = password, confirmNewPassword = password });
    }

    public async Task<IReadOnlyList<PairRequest>> PendingPairs()
    {
        var root = await Read("api/pin");
        var array = GetArray(root, "requests", "pairings", "pending");
        return array.EnumerateArray().Select(x => new PairRequest(Get(x,"id"), Get(x,"name"), Get(x,"address")))
            .Where(x => x.Id.Length > 0).ToArray();
    }

    public async Task<IReadOnlyList<PairedClient>> Clients()
    {
        var root = await Read("api/clients/list");
        var array = GetArray(root, "named_certs", "clients");
        return array.EnumerateArray().Select(x => new PairedClient(Get(x,"uuid"), Get(x,"name")))
            .Where(x => x.Id.Length > 0).ToArray();
    }

    public static bool ValidPin(string pin) => pin.Length == 4 && pin.All(c => c is >= '0' and <= '9');

    public async Task Pair(string pairingId, string pin, string name)
    {
        if (string.IsNullOrWhiteSpace(pairingId) || !ValidPin(pin)) throw new ArgumentException("Select a pending device and enter its four-digit code.");
        await Post("api/pin", new { pairing_id = pairingId, pin, name });
    }

    public Task Revoke(string uuid) => string.IsNullOrWhiteSpace(uuid)
        ? throw new ArgumentException("Select a paired device first.") : Post("api/clients/unpair", new { uuid });

    private async Task Post(string path, object body)
    {
        using var response = await client.PostAsJsonAsync(path, body);
        response.EnsureSuccessStatusCode();
        using var result = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        if (!result.RootElement.TryGetProperty("status", out var status) || status.ValueKind != JsonValueKind.True)
            throw new InvalidOperationException("Sunshine did not confirm this action. Check the code and try again.");
    }

    private static JsonElement GetArray(JsonElement root, params string[] keys)
    {
        if (root.ValueKind == JsonValueKind.Array) return root;
        foreach (var key in keys)
            if (root.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.Array) return value;
        throw new InvalidOperationException("Unexpected Sunshine response. Open Sunshine settings to complete this action.");
    }
    private static string Get(JsonElement root, string key) => root.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
    public void Dispose() => client.Dispose();
}
