$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$engineRoot = Join-Path $repoRoot 'vendor\moonlight'
$buildRoot = Join-Path $repoRoot 'tools\client-build'
$deployRoot = Join-Path $repoRoot 'dist\Orbit-Client-Windows'
New-Item -ItemType Directory -Force -Path $buildRoot,$deployRoot | Out-Null
Push-Location $engineRoot
try {
    & powershell -NoProfile -File setup-deps.ps1
    if ($LASTEXITCODE -ne 0) { throw 'Dependency setup failed.' }
} finally { Pop-Location }
Push-Location $buildRoot
try {
    & qmake (Join-Path $engineRoot 'moonlight-qt.pro') 'CONFIG+=release'
    if ($LASTEXITCODE -ne 0) { throw 'qmake failed.' }
    & nmake release
    if ($LASTEXITCODE -ne 0) { throw 'Compilation failed.' }
    $clientExe = Join-Path $buildRoot 'app\release\Moonlight.exe'
    Copy-Item $clientExe $deployRoot
    Copy-Item (Join-Path $engineRoot 'libs\windows\lib\x64\*.dll') $deployRoot
    Copy-Item (Join-Path $buildRoot 'AntiHooking\release\AntiHooking.dll') $deployRoot
    Copy-Item (Join-Path $engineRoot 'app\SDL_GameControllerDB\gamecontrollerdb.txt') $deployRoot
    & windeployqt --release --dir $deployRoot --qmldir (Join-Path $engineRoot 'app\gui') --no-opengl-sw --no-sql --no-ffmpeg $clientExe
    if ($LASTEXITCODE -ne 0) { throw 'Qt deployment failed.' }
    Copy-Item (Join-Path $engineRoot 'LICENSE') (Join-Path $deployRoot 'Moonlight-LICENSE.txt')
    Copy-Item (Join-Path $repoRoot 'NOTICE') $deployRoot
    Rename-Item -LiteralPath (Join-Path $deployRoot 'Moonlight.exe') -NewName Orbit.exe
} finally { Pop-Location }
