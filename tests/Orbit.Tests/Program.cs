using Orbit.Core;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

var assertions = 0;
void Check(bool result, string message) { assertions++; if (!result) throw new Exception(message); }
async Task Reject(Func<Task> action) { try { await action(); } catch (Exception) { assertions++; return; } throw new Exception("Expected a rejected action."); }
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
Console.WriteLine($"PASS: {assertions} authentication, pairing, and revocation assertions.");

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
        catch (HttpRequestException error) when (error.InnerException is System.Security.Authentication.AuthenticationException) {
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
