using System.Text.RegularExpressions;

namespace Orbit.Core;

// Lets paired Orbit devices log in through Windows' SSH server. Each device's public key sits in the admin key
// list tagged with its Orbit id, so a newer key replaces the old one and unpairing the device removes it.
public static class SshAccess
{
    private static readonly Regex KeyPattern = new(@"\A(ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ssh-rsa) [A-Za-z0-9+/]+={0,3}\z", RegexOptions.CultureInvariant);
    private static readonly Regex IdPattern = new(@"\A[A-Za-z0-9-]{1,64}\z", RegexOptions.CultureInvariant);
    private static readonly object FileLock = new();

    public static string KeysFile => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "ssh", "administrators_authorized_keys");

    private static string Tag(string clientId) => " orbit:" + clientId;

    // Only "type key" is kept from what the device sent, so no SSH options or extra lines can get in.
    public static List<string> WithKey(IEnumerable<string> lines, string clientId, string publicKey)
    {
        var parts = (publicKey ?? "").Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 2 || !KeyPattern.IsMatch(parts[0] + " " + parts[1]) || !IdPattern.IsMatch(clientId ?? ""))
            throw new ArgumentException("Not an SSH public key.");
        var result = WithoutClient(lines, clientId!);
        result.Add(parts[0] + " " + parts[1] + Tag(clientId!));
        return result;
    }

    public static List<string> WithoutClient(IEnumerable<string> lines, string clientId) =>
        lines.Where(l => !l.TrimEnd().EndsWith(Tag(clientId), StringComparison.Ordinal)).ToList();

    public static bool AddKey(string clientId, string publicKey) => Update(lines => WithKey(lines, clientId, publicKey));

    public static bool RemoveClient(string clientId) => Update(lines => WithoutClient(lines, clientId));

    // Edits the file the Enable step created, which already has the permissions sshd insists on.
    private static bool Update(Func<IEnumerable<string>, List<string>> change)
    {
        lock (FileLock)
        {
            if (!File.Exists(KeysFile)) return false;
            var before = File.ReadAllLines(KeysFile);
            var after = change(before);
            if (!after.SequenceEqual(before)) File.WriteAllLines(KeysFile, after);
            return true;
        }
    }
}
