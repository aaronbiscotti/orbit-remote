$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'orbit-common.ps1')
try {
    $tcpOut = & netsh.exe advfirewall firewall show rule name="Orbit-Streaming-TCP" 2>$null
    if ($LASTEXITCODE -ne 0 -or !$tcpOut) { exit 1 }
    $joined = ($tcpOut -join "`n")
    if ($joined -notmatch 'Enabled:\s+Yes' -or $joined -notmatch "$OrbitTakeoverPort") { exit 1 }
    exit 0
} catch {
    exit 2
}
