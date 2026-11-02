$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$expected = [IO.Path]::GetFullPath((Join-Path $repoRoot 'runtime\sunshine\Sunshine\sunshine.exe'))
if (Get-Service -Name 'OrbitHostService' -ErrorAction SilentlyContinue) {
    try { Stop-Service -Name 'OrbitHostService' -Force -ErrorAction SilentlyContinue } catch {}
}
Get-Process -Name sunshine -ErrorAction SilentlyContinue | Where-Object {
    try { [IO.Path]::GetFullPath($_.Path) -eq $expected } catch { $false }
} | Stop-Process -Force
Write-Output 'Stopped only the Orbit Takeover instance belonging to this project. Close Orbit Host to release keep-awake.'
