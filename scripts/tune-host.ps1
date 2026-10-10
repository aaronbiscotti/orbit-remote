param([switch]$Restart)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$engineRoot = Join-Path $repoRoot 'runtime\sunshine\Sunshine'
$configFile = Join-Path $engineRoot 'config\sunshine.conf'
$exe = Join-Path $engineRoot 'sunshine.exe'
if (!(Test-Path -LiteralPath $configFile) -or !(Test-Path -LiteralPath $exe)) { throw 'Set up the host first.' }
$backup = Join-Path $engineRoot ('config\sunshine-before-tuning-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss') + '.bak')
Copy-Item -LiteralPath $configFile -Destination $backup
$lines = @(Get-Content -LiteralPath $configFile | Where-Object { $_ -notmatch '^\s*(max_bitrate|minimum_fps_target)\s*=' })
$lines += 'max_bitrate = 12000'
$lines += 'minimum_fps_target = 120'
[IO.File]::WriteAllLines($configFile, $lines)
if ($Restart) {
    Get-Process -Name sunshine -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process
    Start-Process -FilePath $exe -ArgumentList ('"' + $configFile + '"') -WorkingDirectory $engineRoot -WindowStyle Hidden
}
Write-Output 'Host tuned: 12 Mbps cap, 120 fps minimum target. Previous config backed up locally.'
