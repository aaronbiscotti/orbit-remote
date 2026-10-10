$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $repoRoot 'dist\Orbit-Host\Orbit.Host.exe'
if (!(Test-Path -LiteralPath $exe)) { throw 'Build Orbit Host first; see README.md.' }
& (Join-Path $PSScriptRoot 'setup-host.ps1') -Start
# This is the interactive app the user requested to test.
Start-Process -FilePath $exe -WorkingDirectory $repoRoot
