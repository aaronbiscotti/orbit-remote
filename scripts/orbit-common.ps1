# Shared by Orbit's Windows scripts. Ports must match electron/ports.js and TakeoverServer.cs.
$OrbitTakeoverPort = 47995
# Sunshine has to move off its default base port 47989, because its web page port (base + 1) is Orbit's 47990.
$SunshineBasePort = 48989
$SunshineTcpPorts = @(($SunshineBasePort - 5), $SunshineBasePort, ($SunshineBasePort + 21))
$SunshineUdpPorts = @(($SunshineBasePort + 9), ($SunshineBasePort + 10), ($SunshineBasePort + 11), ($SunshineBasePort + 13), ($SunshineBasePort + 21))

# Stops Orbit's own engine processes running from these folders. Matching by folder, never by name:
# the real Sunshine, which Moonlight needs, is also called sunshine.exe, as were older Orbit copies.
function Stop-OrbitEngine([string[]]$Folders) {
    $prefixes = @($Folders | Where-Object { $_ } | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') + '\' })
    Get-Process -Name 'Orbit.Host', 'sunshine' -ErrorAction SilentlyContinue |
        Where-Object { $p = $_.Path; $p -and ($prefixes | Where-Object { $p.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }) } |
        Stop-Process -Force -ErrorAction SilentlyContinue
}
