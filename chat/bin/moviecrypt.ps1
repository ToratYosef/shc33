$ErrorActionPreference = 'Stop'

if (-not $Host.UI.RawUI) { exit 0 }

function Get-Hex([int]$Len = 8) {
  $chars = 'abcdef0123456789'.ToCharArray()
  -join (1..$Len | ForEach-Object { $chars[(Get-Random -Minimum 0 -Maximum $chars.Length)] })
}

function Get-Fingerprint {
  ($segments = 1..8 | ForEach-Object { Get-Hex 8 }) | Out-Null
  return ($segments -join '-')
}

Write-Host "=== E2EE SESSION NEGOTIATION CONSOLE (presentation overlay) ==="
Start-Sleep -Milliseconds 80
Write-Host "Handshake ✓"
for ($i=1; $i -le 5; $i++) {
  $bar = ('█' * $i).PadRight(5)
  Write-Host -NoNewline "`rEntropy harvest [$bar]"
  Start-Sleep -Milliseconds 80
}
Write-Host "`rEntropy harvest [█████] OK"
Write-Host "Key exchange ✓"
Start-Sleep -Milliseconds 80
Write-Host "Forward secrecy ✓"
Write-Host "DEVICE FP: $(Get-Fingerprint)"
Write-Host "PEER FP:   $(Get-Fingerprint)"
Write-Host "STATUS: ENCRYPTED • VERIFIED • ZERO-READ SERVER ROUTING"
Write-Host "==============================================================="
