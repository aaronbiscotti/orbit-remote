$ErrorActionPreference = 'Stop'
$orbitIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$orbitPrincipal = New-Object Security.Principal.WindowsPrincipal($orbitIdentity)
if (!$orbitPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Windows administrator approval is required. Use Enable administrator control in Orbit Host while at the PC.'
}
. (Join-Path $PSScriptRoot 'orbit-common.ps1')
$repoRoot = Split-Path -Parent $PSScriptRoot
# The Orbit app makes this folder's engine copy complete and current right before it runs this script.
$engineRoot = Join-Path $repoRoot 'runtime\sunshine\Sunshine'
$userConfigDir = Join-Path $engineRoot 'config'
if (!(Test-Path -LiteralPath (Join-Path $engineRoot 'Orbit.Host.exe')) -or !(Test-Path -LiteralPath (Join-Path $userConfigDir 'sunshine.conf'))) { throw 'Extract and set up the complete Windows host first.' }

# Enable SoftwareSASGeneration so remote Ctrl+Alt+Del and UAC prompts work
try {
    Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name 'SoftwareSASGeneration' -Value 3 -Type DWord -Force -ErrorAction SilentlyContinue
} catch {}

# Run the SYSTEM service from a folder only administrators can change. The per-user copy lives under
# %APPDATA%, which any program running as this user could rewrite to gain SYSTEM rights.
$secureRoot = Join-Path $env:ProgramFiles 'Orbit\Engine'
$secureConfigDir = Join-Path $secureRoot 'config'

# Stop the service and Orbit's own engine processes so the ports and engine files are free.
$serviceName = 'OrbitHostService'
$existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existingService) {
    & sc.exe stop $serviceName | Out-Null
    Start-Sleep -Milliseconds 600
}
Stop-OrbitEngine -Folders @($engineRoot, $secureRoot)
Start-Sleep -Milliseconds 600

New-Item -ItemType Directory -Force -Path $secureRoot | Out-Null
Get-ChildItem -LiteralPath $engineRoot -File | Copy-Item -Destination $secureRoot -Force
# Older versions also ran a renamed copy called sunshine.exe, the same name as the real Sunshine.
Remove-Item -Path (Join-Path $secureRoot 'sunshine.*') -Force -ErrorAction SilentlyContinue
# Copy config if missing, and always keep local_admin_key.json + sunshine_state.json credentials synced
if (!(Test-Path -LiteralPath $secureConfigDir)) {
    Copy-Item -LiteralPath $userConfigDir -Destination $secureConfigDir -Recurse -Force
} else {
    foreach ($cfgFile in @('local_admin_key.json', 'sunshine_state.json', 'sunshine.conf')) {
        $srcCfg = Join-Path $userConfigDir $cfgFile
        if (Test-Path -LiteralPath $srcCfg) {
            Copy-Item -LiteralPath $srcCfg -Destination (Join-Path $secureConfigDir $cfgFile) -Force
        }
    }
}
$exe = Join-Path $secureRoot 'Orbit.Host.exe'
$config = Join-Path $secureConfigDir 'sunshine.conf'

# Register and start the LocalSystem service. The same program also runs as the agent it starts.
$binPath = "`"$exe`" --service"
if (!$existingService) {
    & sc.exe create $serviceName binPath= $binPath start= auto obj= LocalSystem DisplayName= "Orbit Remote OS Takeover Service" | Out-Null
} else {
    & sc.exe config $serviceName binPath= $binPath start= auto obj= LocalSystem | Out-Null
}
& sc.exe start $serviceName | Out-Null
Start-Sleep -Milliseconds 1500

# Did the service start the agent in the signed-in session? (The service itself runs in session 0.) If not, start it directly.
$agentRunning = @(Get-Process -Name 'Orbit.Host' -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -ne 0 -and $_.Path -and [string]::Equals([IO.Path]::GetFullPath($_.Path), [IO.Path]::GetFullPath($exe), [StringComparison]::OrdinalIgnoreCase) })
if ($agentRunning.Count -eq 0) {
    $orbitStarted = Start-Process -FilePath $exe -ArgumentList ('"' + $config + '"') -WorkingDirectory $secureRoot -WindowStyle Hidden -PassThru
    try {
        if ($orbitStarted.WaitForExit(1500)) { throw 'Administrator sharing stopped during startup.' }
    } finally { $orbitStarted.Dispose() }
}

[IO.File]::WriteAllText((Join-Path $userConfigDir 'administrator-control.enabled'), 'Administrator and SYSTEM UAC takeover requested by this PC owner.')
Write-Output 'Administrator and UAC Secure Desktop takeover started. Reconnect from your Mac.'
