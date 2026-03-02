param(
  [Parameter(Position=0)] [string]$Arg1,
  [Parameter(Position=1)] [string]$Arg2
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir
$ContactsFile = if ($env:CHAT_CONTACTS_FILE) { $env:CHAT_CONTACTS_FILE } else { Join-Path $RootDir 'contacts.json' }
$StoreDir = if ($env:MATRIX_STORE_DIR) { $env:MATRIX_STORE_DIR } else { Join-Path $HOME '.matrix-store' }
$McStore = Join-Path $StoreDir 'matrix-commander'
New-Item -ItemType Directory -Force -Path $McStore | Out-Null

$movie = Join-Path $ScriptDir 'moviecrypt.ps1'
if (Test-Path $movie) { & $movie }

function Require-Cmd([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing dependency: $Name"
  }
}

function Get-Room([string]$Name) {
  $json = Get-Content -Raw $ContactsFile | ConvertFrom-Json
  return $json.$Name
}

if (-not $Arg1) {
  Write-Host "Usage: chat contacts | chat listen | chat <name> | chat <name> <message>"
  exit 0
}

switch ($Arg1) {
  'contacts' {
    $json = Get-Content -Raw $ContactsFile | ConvertFrom-Json
    $json.PSObject.Properties | ForEach-Object { Write-Host "$($_.Name) -> $($_.Value)" }
    exit 0
  }
  'listen' {
    Require-Cmd 'matrix-commander'
    matrix-commander --store "$McStore" --listen forever
    exit $LASTEXITCODE
  }
  default {
    $contact = $Arg1
    $roomId = Get-Room $contact
    if (-not $roomId -or $roomId -eq '!replace_me_roomid:example.com') {
      Write-Host "Contact '$contact' has no room id in $ContactsFile"
      Write-Host "Create DM room in Element/iamb, then update contacts.json"
      exit 2
    }

    if ($Arg2) {
      Require-Cmd 'matrix-commander'
      matrix-commander --store "$McStore" --room "$roomId" --message "$Arg2"
      exit $LASTEXITCODE
    }

    Require-Cmd 'iamb'
    $env:IAMB_TARGET_ROOM = $roomId
    Write-Host "Opening iamb. Target contact: $contact ($roomId)"
    iamb
    exit $LASTEXITCODE
  }
}
