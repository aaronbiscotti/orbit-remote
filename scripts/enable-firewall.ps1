$ErrorActionPreference = 'Stop'
$admin = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (!$admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this script from an administrator PowerShell to add scoped inbound streaming rules.' }
. (Join-Path $PSScriptRoot 'orbit-common.ps1')
$addresses = @('LocalSubnet', '100.64.0.0/10')
# By port, not by program: this covers Orbit's engine in either of its folders and a portable Sunshine wherever it lives.
foreach ($rule in @(
    @{ Name = 'Orbit-Streaming-TCP'; Protocol = 'TCP'; Ports = @($OrbitTakeoverPort) + $SunshineTcpPorts },
    @{ Name = 'Orbit-Streaming-UDP'; Protocol = 'UDP'; Ports = $SunshineUdpPorts }
)) {
    Remove-NetFirewallRule -Name $rule.Name -ErrorAction SilentlyContinue
    New-NetFirewallRule -Name $rule.Name -DisplayName 'Orbit and Sunshine (LAN and Tailscale)' -Direction Inbound -Action Allow -Protocol $rule.Protocol -LocalPort $rule.Ports -RemoteAddress $addresses -Profile Any | Out-Null
}
Write-Output "Orbit ($OrbitTakeoverPort) and Sunshine ($SunshineBasePort) ports allowed only from LAN and Tailscale peers. The loopback admin port stays closed."
