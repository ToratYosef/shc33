$ErrorActionPreference = 'Stop'

$ChatDir = Join-Path $HOME '.moviechat'
$BinDir = Join-Path $HOME 'bin'
$StoreDir = Join-Path $HOME '.matrix-store'

New-Item -ItemType Directory -Force -Path $ChatDir, $BinDir, $StoreDir | Out-Null

if (-not (Test-Path (Join-Path (Get-Location) 'chat\bin\chat.ps1'))) {
  throw 'Run from repo root containing .\chat'
}

Copy-Item .\chat\bin\chat.ps1 (Join-Path $ChatDir 'chat.ps1') -Force
Copy-Item .\chat\bin\moviecrypt.ps1 (Join-Path $ChatDir 'moviecrypt.ps1') -Force
Copy-Item .\chat\contacts.json (Join-Path $ChatDir 'contacts.json') -Force

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Write-Warning 'winget not found; install dependencies manually: Python, Rust, jq'
} else {
  winget install --id Python.Python.3.12 -e --silent
  winget install --id Rustlang.Rustup -e --silent
  winget install --id jqlang.jq -e --silent
}

python -m pip install --user matrix-commander
cargo install iamb

$Wrapper = Join-Path $BinDir 'chat.ps1'
@"
`$env:CHAT_CONTACTS_FILE = Join-Path '$ChatDir' 'contacts.json'
& '$ChatDir\chat.ps1' @args
"@ | Set-Content -Path $Wrapper -Encoding UTF8

$profileLine = "`$env:Path += ';$BinDir'"
if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Force -Path $PROFILE | Out-Null }
if (-not (Select-String -Path $PROFILE -Pattern [regex]::Escape($profileLine) -Quiet)) {
  Add-Content -Path $PROFILE -Value $profileLine
}

$hs = Read-Host 'Homeserver URL (example: https://example.com/chat)'
matrix-commander --store "$StoreDir\matrix-commander" --homeserver "$hs" --login

Write-Host "Installed. Restart PowerShell and run: chat contacts"
Write-Host "Safer alternative to iwr|iex: download install.ps1, inspect it, then run .\install.ps1"
