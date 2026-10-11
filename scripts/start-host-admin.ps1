$ErrorActionPreference = 'Stop'
$orbitIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$orbitPrincipal = New-Object Security.Principal.WindowsPrincipal($orbitIdentity)
if (!$orbitPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Windows administrator approval is required. Use Enable administrator control in Orbit Host while at the PC.'
}
$repoRoot = Split-Path -Parent $PSScriptRoot
$engineRoot = Join-Path $repoRoot 'runtime\sunshine\Sunshine'
$exe = [IO.Path]::GetFullPath((Join-Path $engineRoot 'sunshine.exe'))
$config = Join-Path $engineRoot 'config\sunshine.conf'
if (!(Test-Path -LiteralPath $exe) -or !(Test-Path -LiteralPath $config)) { throw 'Extract and set up the complete Windows host first.' }

# This script runs only after UAC approval. Cancelling that prompt leaves the current host intact.
$orbitExisting = @(Get-Process -Name sunshine -ErrorAction SilentlyContinue | Where-Object { $_.Path -and [string]::Equals([IO.Path]::GetFullPath($_.Path), $exe, [StringComparison]::OrdinalIgnoreCase) })
foreach ($orbitProcess in $orbitExisting) {
    Stop-Process -Id $orbitProcess.Id -ErrorAction Stop
    if (!$orbitProcess.WaitForExit(5000)) { throw 'The current sharing process did not stop. No replacement was started.' }
    $orbitProcess.Dispose()
}
$orbitStarted = Start-Process -FilePath $exe -ArgumentList ('"' + $config + '"') -WorkingDirectory $engineRoot -WindowStyle Hidden -PassThru
try {
    if ($orbitStarted.WaitForExit(2000)) { throw 'Administrator sharing stopped during startup.' }
    [IO.File]::WriteAllText((Join-Path $engineRoot 'config\administrator-control.enabled'), 'Administrator control requested by this PC owner.')
    Write-Output 'Administrator sharing started. Reconnect from your Mac.'
} finally { $orbitStarted.Dispose() }
