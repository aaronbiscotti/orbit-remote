$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'orbit-common.ps1')
$repoRoot = Split-Path -Parent $PSScriptRoot
if (Get-Service -Name 'OrbitHostService' -ErrorAction SilentlyContinue) {
    try { Stop-Service -Name 'OrbitHostService' -Force -ErrorAction SilentlyContinue } catch {}
}
Stop-OrbitEngine -Folders @((Join-Path $repoRoot 'runtime\sunshine\Sunshine'), (Join-Path $env:ProgramFiles 'Orbit\Engine'))
Write-Output 'Stopped Orbit''s engine. Sunshine was left running.'
