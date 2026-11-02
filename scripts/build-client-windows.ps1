$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$clientRoot = Join-Path $repoRoot 'client'
$buildRoot = Join-Path $repoRoot 'tools\client-build'
$deployRoot = Join-Path $repoRoot 'dist\Orbit-Client-Windows'
$jomRoot = Join-Path $repoRoot 'tools\jom'
if (Test-Path -LiteralPath $buildRoot) { Remove-Item -LiteralPath $buildRoot -Recurse -Force }
if (Test-Path -LiteralPath $deployRoot) { Remove-Item -LiteralPath $deployRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $buildRoot,$deployRoot | Out-Null
if (!(Test-Path -LiteralPath (Join-Path $jomRoot 'jom.exe'))) {
    New-Item -ItemType Directory -Force -Path $jomRoot | Out-Null
    $jomZip = Join-Path $jomRoot 'jom.zip'
    Invoke-WebRequest 'https://download.qt.io/official_releases/jom/jom_1_1_7.zip' -OutFile $jomZip
    if ((Get-FileHash -LiteralPath $jomZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne '4c8af345586a9a08fbfd2f613fcac748226d91a75627aa3581b297dd513046fe') {
        throw 'Qt jom checksum verification failed.'
    }
    Expand-Archive -LiteralPath $jomZip -DestinationPath $jomRoot
}
Push-Location $buildRoot
try {
    & qmake (Join-Path $clientRoot 'orbit-client.pro') 'CONFIG+=release'
    if ($LASTEXITCODE -ne 0) { throw 'qmake failed.' }
    & (Join-Path $jomRoot 'jom.exe') -j 4
    if ($LASTEXITCODE -ne 0) { throw 'Compilation failed.' }
    $clientExe = Join-Path $buildRoot 'release\Orbit.exe'
    if (!(Test-Path -LiteralPath $clientExe)) { $clientExe = Join-Path $buildRoot 'Orbit.exe' }
    Copy-Item -LiteralPath $clientExe -Destination $deployRoot
    & windeployqt --release --dir $deployRoot --qmldir (Join-Path $clientRoot 'qml') --no-opengl-sw --no-sql --no-ffmpeg (Join-Path $deployRoot 'Orbit.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Qt deployment failed.' }
    Copy-Item (Join-Path $repoRoot 'LICENSE') (Join-Path $deployRoot 'LICENSE.txt')
    Copy-Item (Join-Path $repoRoot 'NOTICE') $deployRoot
} finally { Pop-Location }
