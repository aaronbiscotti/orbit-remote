$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $repoRoot 'dist\Orbit-Host\Orbit.Host.exe'
if (!(Test-Path -LiteralPath $exe)) { throw 'Build Orbit Host first; see README.md.' }
& (Join-Path $PSScriptRoot 'setup-host.ps1')
# The companion starts sharing according to the saved permission preference.
# Launching this script never raises a UAC prompt by itself.
# This is the interactive app the user requested to test.
Start-Process -FilePath $exe -WorkingDirectory $repoRoot
