$ErrorActionPreference = 'Stop'
$admin = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (!$admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this script from an administrator PowerShell to add scoped inbound streaming rules.' }
$repoRoot = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $repoRoot 'runtime\sunshine\Sunshine\sunshine.exe'
if (!(Test-Path -LiteralPath $exe)) { throw 'Run setup-host.ps1 first.' }
$addresses = @('LocalSubnet','100.64.0.0/10')
if (!(Get-NetFirewallRule -Name Orbit-Streaming-TCP -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name Orbit-Streaming-TCP -DisplayName 'Orbit OS Takeover (LAN and Tailscale)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 47984,47989,47995,48010 -Program $exe -RemoteAddress $addresses -Profile Any | Out-Null
}
else {
    Set-NetFirewallRule -Name Orbit-Streaming-TCP -Enabled True -Direction Inbound -Action Allow -Protocol TCP -LocalPort 47984,47989,47995,48010 -Program $exe -RemoteAddress $addresses -Profile Any
}
if (!(Get-NetFirewallRule -Name Orbit-Streaming-UDP -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name Orbit-Streaming-UDP -DisplayName 'Orbit OS Takeover (LAN and Tailscale)' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 47998,47999,48000,48002,48010 -Program $exe -RemoteAddress $addresses -Profile Any | Out-Null
}
else {
    Set-NetFirewallRule -Name Orbit-Streaming-UDP -Enabled True -Direction Inbound -Action Allow -Protocol UDP -LocalPort 47998,47999,48000,48002,48010 -Program $exe -RemoteAddress $addresses -Profile Any
}
Write-Output 'Takeover ports allowed only from LAN and Tailscale peers. Loopback admin port remains closed.'
