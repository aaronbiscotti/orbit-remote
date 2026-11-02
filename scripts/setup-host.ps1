param([switch]$Start)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $repoRoot 'runtime\sunshine'
$engineRoot = Join-Path $runtimeRoot 'Sunshine'
$configRoot = Join-Path $engineRoot 'config'
$configFile = Join-Path $configRoot 'sunshine.conf'
$exe = Join-Path $engineRoot 'sunshine.exe'
$distDir = Join-Path $repoRoot 'dist\Orbit-Host'

New-Item -ItemType Directory -Force -Path $engineRoot,$configRoot,(Join-Path $configRoot 'credentials') | Out-Null

if (Test-Path -LiteralPath (Join-Path $distDir 'Orbit.Host.exe')) {
    Get-ChildItem -LiteralPath $distDir -File | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $engineRoot $_.Name) -Force
    }
    Copy-Item -LiteralPath (Join-Path $distDir 'Orbit.Host.exe') -Destination $exe -Force
    if (Test-Path -LiteralPath (Join-Path $distDir 'Orbit.Host.runtimeconfig.json')) {
        Copy-Item -LiteralPath (Join-Path $distDir 'Orbit.Host.runtimeconfig.json') -Destination (Join-Path $engineRoot 'sunshine.runtimeconfig.json') -Force
    }
    if (Test-Path -LiteralPath (Join-Path $distDir 'Orbit.Host.deps.json')) {
        Copy-Item -LiteralPath (Join-Path $distDir 'Orbit.Host.deps.json') -Destination (Join-Path $engineRoot 'sunshine.deps.json') -Force
    }
}

if (!(Test-Path -LiteralPath $configFile)) {
    function ConfigPath([string]$name) { (Join-Path $configRoot $name).Replace('\','/') }
    $lines = @(
        "sunshine_name = $env:COMPUTERNAME",
        'engine = orbit-takeover',
        'takeover_port = 47995',
        'admin_port = 47990',
        'origin_web_ui_allowed = pc',
        'upnp = false',
        'lan_encryption_mode = 2',
        'wan_encryption_mode = 2',
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
Write-Output "Orbit OS Takeover runtime prepared in $engineRoot"
if ($Start) {
    if (Get-Process -Name sunshine -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }) { Write-Output 'An Orbit Takeover host is already running.' }
    else { Start-Process -FilePath $exe -ArgumentList ('"' + $configFile + '"') -WorkingDirectory $engineRoot -WindowStyle Hidden }
}
