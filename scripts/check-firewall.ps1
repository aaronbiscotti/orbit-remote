$ErrorActionPreference = 'Stop'
try {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $exe = Join-Path $repoRoot 'runtime\sunshine\Sunshine\sunshine.exe'
    foreach ($name in @('Orbit-Streaming-TCP','Orbit-Streaming-UDP')) {
        $rule = Get-NetFirewallRule -PolicyStore ActiveStore -Name $name -ErrorAction SilentlyContinue
        if (!$rule -or $rule.Enabled -ne 'True' -or $rule.Action -ne 'Allow' -or $rule.Direction -ne 'Inbound' -or $rule.Profile -ne 'Any') { exit 1 }
        $app = $rule | Get-NetFirewallApplicationFilter
        if (![string]::Equals($app.Program, $exe, [StringComparison]::OrdinalIgnoreCase)) { exit 1 }
        $port = $rule | Get-NetFirewallPortFilter
        $expected = if ($name -eq 'Orbit-Streaming-TCP') { @('47984','47989','48010') } else { @('47998','47999','48000','48002','48010') }
        $protocol = if ($name -eq 'Orbit-Streaming-TCP') { 'TCP' } else { 'UDP' }
        if ($port.Protocol -ne $protocol -or (($port.LocalPort | Sort-Object) -join ',') -ne (($expected | Sort-Object) -join ',')) { exit 1 }
        $addresses = @(($rule | Get-NetFirewallAddressFilter).RemoteAddress)
        if ($addresses.Count -ne 2 -or $addresses -notcontains 'LocalSubnet' -or !($addresses -contains '100.64.0.0/10' -or $addresses -contains '100.64.0.0/255.192.0.0')) { exit 1 }
    }
    exit 0
} catch { exit 2 }
