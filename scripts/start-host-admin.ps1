$ErrorActionPreference = 'Stop'
$orbitIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$orbitPrincipal = New-Object Security.Principal.WindowsPrincipal($orbitIdentity)
if (!$orbitPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Windows administrator approval is required. Use Enable administrator control in Orbit Host while at the PC.'
}
$repoRoot = Split-Path -Parent $PSScriptRoot
$engineRoot = Join-Path $repoRoot 'runtime\sunshine\Sunshine'
$exe = [IO.Path]::GetFullPath((Join-Path $engineRoot 'sunshine.exe'))
$serviceExe = [IO.Path]::GetFullPath((Join-Path $engineRoot 'Orbit.Host.exe'))
if (!(Test-Path -LiteralPath $serviceExe)) { $serviceExe = $exe }
$config = Join-Path $engineRoot 'config\sunshine.conf'
if (!(Test-Path -LiteralPath $exe) -or !(Test-Path -LiteralPath $config)) { throw 'Extract and set up the complete Windows host first.' }

# Enable SoftwareSASGeneration so remote Ctrl+Alt+Del and UAC prompts work
try {
    Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name 'SoftwareSASGeneration' -Value 3 -Type DWord -Force -ErrorAction SilentlyContinue
} catch {}

# Stop the service and Orbit's own engine processes so ports 47990/47995 and the engine files are freed
$serviceName = 'OrbitHostService'
$existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existingService) {
    & sc.exe stop $serviceName | Out-Null
    Start-Sleep -Milliseconds 600
}
# Only Orbit's own engine copies: the real Sunshine, which Moonlight needs, is also called sunshine.exe.
$orbitDirs = @($engineRoot, (Join-Path $env:ProgramFiles 'Orbit\Engine')) | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') + '\' }
Get-Process -Name 'sunshine','Orbit.Host' -ErrorAction SilentlyContinue | Where-Object { $p = $_.Path; $p -and ($orbitDirs | Where-Object { $p.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }) } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 600

# Refresh $engineRoot from authoritative packaged engine while all processes are stopped (prevents locked-DLL version mismatches)
$authoritativeCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Orbit\resources\engine'),
    (Join-Path $repoRoot 'dist\Orbit-Host')
)
foreach ($cand in $authoritativeCandidates) {
    if (Test-Path -LiteralPath (Join-Path $cand 'Orbit.Host.exe')) {
        Get-ChildItem -LiteralPath $cand -File | Copy-Item -Destination $engineRoot -Force
        Copy-Item -LiteralPath (Join-Path $cand 'Orbit.Host.exe') -Destination (Join-Path $engineRoot 'sunshine.exe') -Force
        if (Test-Path -LiteralPath (Join-Path $cand 'Orbit.Host.runtimeconfig.json')) {
            Copy-Item -LiteralPath (Join-Path $cand 'Orbit.Host.runtimeconfig.json') -Destination (Join-Path $engineRoot 'sunshine.runtimeconfig.json') -Force
        }
        if (Test-Path -LiteralPath (Join-Path $cand 'Orbit.Host.deps.json')) {
            Copy-Item -LiteralPath (Join-Path $cand 'Orbit.Host.deps.json') -Destination (Join-Path $engineRoot 'sunshine.deps.json') -Force
        }
        break
    }
}

# Run the SYSTEM service from a folder only administrators can change. The per-user copy lives under
# %APPDATA%, which any program running as this user could rewrite to gain SYSTEM rights.
$userConfigDir = Join-Path $engineRoot 'config'
$secureRoot = Join-Path $env:ProgramFiles 'Orbit\Engine'
New-Item -ItemType Directory -Force -Path $secureRoot | Out-Null
Get-ChildItem -LiteralPath $engineRoot -File | Copy-Item -Destination $secureRoot -Force
# Copy config if missing, and always keep local_admin_key.json + sunshine_state.json credentials synced
$secureConfigDir = Join-Path $secureRoot 'config'
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
$engineRoot = $secureRoot
$exe = Join-Path $secureRoot 'sunshine.exe'
$serviceExe = Join-Path $secureRoot 'Orbit.Host.exe'
if (!(Test-Path -LiteralPath $serviceExe)) { $serviceExe = $exe }
$config = Join-Path $secureConfigDir 'sunshine.conf'

# Register and start persistent LocalSystem service (OrbitHostService)
$binPath = "`"$serviceExe`" --service"
if (!$existingService) {
    & sc.exe create $serviceName binPath= $binPath start= auto obj= LocalSystem DisplayName= "Orbit Remote OS Takeover Service" | Out-Null
} else {
    & sc.exe config $serviceName binPath= $binPath start= auto obj= LocalSystem | Out-Null
}
& sc.exe start $serviceName | Out-Null
Start-Sleep -Milliseconds 1500

# Verify if the SYSTEM service spawned the console session agent; if not, start elevated administrator agent directly
$runningAfterService = @(Get-Process -Name sunshine -ErrorAction SilentlyContinue | Where-Object { $_.Path -and [string]::Equals([IO.Path]::GetFullPath($_.Path), [IO.Path]::GetFullPath($exe), [StringComparison]::OrdinalIgnoreCase) })
if ($runningAfterService.Count -eq 0) {
    $orbitStarted = Start-Process -FilePath $exe -ArgumentList ('"' + $config + '"') -WorkingDirectory $engineRoot -WindowStyle Hidden -PassThru
    try {
        if ($orbitStarted.WaitForExit(1500)) { throw 'Administrator sharing stopped during startup.' }
    } finally { $orbitStarted.Dispose() }
}

[IO.File]::WriteAllText((Join-Path $userConfigDir 'administrator-control.enabled'), 'Administrator and SYSTEM UAC takeover requested by this PC owner.')
Write-Output 'Administrator and UAC Secure Desktop takeover started. Reconnect from your Mac.'
