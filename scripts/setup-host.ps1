param([switch]$Start)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $repoRoot 'runtime\sunshine'
$engineRoot = Join-Path $runtimeRoot 'Sunshine'
$configRoot = Join-Path $engineRoot 'config'
$configFile = Join-Path $configRoot 'sunshine.conf'
$exe = Join-Path $engineRoot 'sunshine.exe'
if (!(Test-Path -LiteralPath $exe)) {
    New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
    $zipPath = Join-Path $runtimeRoot 'sunshine.zip'
    $url = 'https://github.com/LizardByte/Sunshine/releases/download/v2026.914.233613/Sunshine-Windows-AMD64-lite.zip'
    Invoke-WebRequest -Uri $url -OutFile $zipPath
    $expected = '233008e46f4c0e501a586cbfd6c4fd4a4c0d414a0b5fc7f13c070eb92ec3824b'
    if ((Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
        throw 'Sunshine download failed checksum verification. No executable was started.'
    }
    Expand-Archive -LiteralPath $zipPath -DestinationPath $runtimeRoot
}
if (!(Test-Path -LiteralPath $configFile)) {
    New-Item -ItemType Directory -Force -Path $configRoot,(Join-Path $configRoot 'credentials') | Out-Null
    Copy-Item -LiteralPath (Join-Path $engineRoot 'assets\apps.json') -Destination (Join-Path $configRoot 'apps.json')
    function ConfigPath([string]$name) { (Join-Path $configRoot $name).Replace('\','/') }
    $lines = @(
        "sunshine_name = $env:COMPUTERNAME",
        'origin_web_ui_allowed = pc',
        'upnp = false',
        'lan_encryption_mode = 2',
        'wan_encryption_mode = 2',
        "file_apps = $(ConfigPath 'apps.json')",
        "file_state = $(ConfigPath 'sunshine_state.json')",
        "credentials_file = $(ConfigPath 'sunshine_state.json')",
        "log_path = $(ConfigPath 'sunshine.log')",
        "pkey = $(ConfigPath 'credentials\cakey.pem')",
        "cert = $(ConfigPath 'credentials\cacert.pem')"
    )
    [IO.File]::WriteAllLines($configFile, $lines)
    # Windows profile data stays local and is not committed. Restrict this tree to
    # the current user, SYSTEM, and administrators before credentials are created.
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls $configRoot /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict host credential directory permissions.' }
}
Write-Output "Sunshine prepared in $engineRoot"
if ($Start) {
    if (Get-Process -Name sunshine -ErrorAction SilentlyContinue) { Write-Output 'A Sunshine host is already running.' }
    else { Start-Process -FilePath $exe -ArgumentList ('"' + $configFile + '"') -WorkingDirectory $engineRoot -WindowStyle Hidden }
}
