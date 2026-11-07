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

# Turns on Windows' SSH server for paired Orbit devices: it starts with Windows, is reachable only from the home
# network and Tailscale, and admin logins use the key list that Orbit's service keeps for paired devices.
function Enable-OrbitSsh {
    $capability = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
    if ($capability -and $capability.State -ne 'Installed') { Add-WindowsCapability -Online -Name $capability.Name | Out-Null }
    Set-Service -Name sshd -StartupType Automatic
    Start-Service sshd
    $keys = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
    if (!(Test-Path -LiteralPath $keys)) { New-Item -ItemType File -Path $keys -Force | Out-Null }
    # sshd ignores this file unless only Administrators and SYSTEM can change it (SIDs work on any Windows language).
    & icacls.exe $keys /inheritance:r /grant '*S-1-5-32-544:F' '*S-1-5-18:F' | Out-Null
    if (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue) {
        Set-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -Enabled True -RemoteAddress LocalSubnet, 100.64.0.0/10
    } else {
        New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (LAN and Tailscale)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 22 -RemoteAddress LocalSubnet, 100.64.0.0/10 -Profile Any | Out-Null
    }
}
