$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$expected = [IO.Path]::GetFullPath((Join-Path $repoRoot 'runtime\sunshine\Sunshine\sunshine.exe'))
Get-Process -Name sunshine -ErrorAction SilentlyContinue | Where-Object {
    try { [IO.Path]::GetFullPath($_.Path) -eq $expected } catch { $false }
} | Stop-Process
Write-Output 'Stopped only the Sunshine instance belonging to this project. Close Orbit Host to release keep-awake.'
