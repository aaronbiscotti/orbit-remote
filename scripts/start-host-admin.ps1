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

# Stop existing session agent instance before starting SYSTEM service / elevated replacement
$orbitExisting = @(Get-Process -Name sunshine -ErrorAction SilentlyContinue | Where-Object { $_.Path -and [string]::Equals([IO.Path]::GetFullPath($_.Path), $exe, [StringComparison]::OrdinalIgnoreCase) })
foreach ($orbitProcess in $orbitExisting) {
    Stop-Process -Id $orbitProcess.Id -Force -ErrorAction SilentlyContinue
    [void]$orbitProcess.WaitForExit(5000)
    $orbitProcess.Dispose()
}

# Register and start persistent LocalSystem service (OrbitHostService) so UAC Secure Desktop (WinSta0\Winlogon) and Lock Screen are accessible
$serviceName = 'OrbitHostService'
$binPath = "`"$serviceExe`" --service"
$existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if (!$existingService) {
    & sc.exe create $serviceName binPath= $binPath start= auto obj= LocalSystem DisplayName= "Orbit Remote OS Takeover Service" | Out-Null
} else {
    & sc.exe stop $serviceName | Out-Null
    Start-Sleep -Milliseconds 600
    & sc.exe config $serviceName binPath= $binPath start= auto obj= LocalSystem | Out-Null
}
& sc.exe start $serviceName | Out-Null
Start-Sleep -Milliseconds 1500

# Verify if the SYSTEM service spawned the console session agent; if not, start elevated administrator agent directly
$runningAfterService = @(Get-Process -Name sunshine -ErrorAction SilentlyContinue | Where-Object { $_.Path -and [string]::Equals([IO.Path]::GetFullPath($_.Path), $exe, [StringComparison]::OrdinalIgnoreCase) })
if ($runningAfterService.Count -eq 0) {
    $orbitStarted = Start-Process -FilePath $exe -ArgumentList ('"' + $config + '"') -WorkingDirectory $engineRoot -WindowStyle Hidden -PassThru
    try {
        if ($orbitStarted.WaitForExit(1500)) { throw 'Administrator sharing stopped during startup.' }
    } finally { $orbitStarted.Dispose() }
}

[IO.File]::WriteAllText((Join-Path $engineRoot 'config\administrator-control.enabled'), 'Administrator and SYSTEM UAC takeover requested by this PC owner.')
Write-Output 'Administrator and UAC Secure Desktop takeover started. Reconnect from your Mac.'
