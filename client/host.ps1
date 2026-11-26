<#
SUPERVIVE Revive — Local Edition: host a match server on this PC.   [EXPERIMENTAL — see docs/GAME-SERVER-MODE.md]

Starts, on the host PC only:
  1. client\agones-sdk.mjs — local stand-in for the Agones SDK sidecar, registered with the backend as a match host;
  2. a second, headless instance of YOUR OWN unmodified game in its built-in server mode, listening on UDP -Port.

Run the backend first (`bun start` with REVIVE_LAN=1 and REVIVE_EXPERIMENTAL_HOSTING=1), then:
    powershell -ExecutionPolicy Bypass -File client\host.ps1
Stop with -Stop. Players (including you) launch the normal client with client\launch.ps1.

Status: this path has NOT been seen to complete a match. The script reports exactly what the server process did
(whether it opened the UDP port, which backend calls it made) so it can be debugged; it does not claim success.
#>
param(
  [string]$Game = "",
  [string]$Backend = "http://127.0.0.1:24970",
  [int]$Port = 7777,
  [int]$ProxyPort = 24972,
  [int]$TlsPort = 24973,
  [string]$Map = "",
  [string]$LocalServerPlayerId = "",
  [switch]$Stop,
  [switch]$Visible
)
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$Data = Join-Path $Repo 'local-data'
$HostDir = Join-Path $Data 'host'
$UserDir = Join-Path $HostDir 'userdir'
$LogPath = Join-Path $HostDir 'server.log'
$PidFile = Join-Path $HostDir 'pids.json'
function Say($m) { Write-Host "[revive-host] $m" }

if ($Stop) {
  if (Test-Path $PidFile) {
    $p = Get-Content $PidFile -Raw | ConvertFrom-Json
    foreach ($id in @($p.server, $p.sdk)) { if ($id) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } }
    Remove-Item $PidFile -Force
  }
  Say 'stopped'
  return
}

$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) { $bun = Join-Path $env:USERPROFILE '.bun\bin\bun.exe' }
if (-not (Test-Path $bun)) { throw 'Bun not found (https://bun.sh).' }

if (-not $Game) {
  $inst = Join-Path $Data 'generated\install.json'
  if (Test-Path $inst) { $Game = (Get-Content $inst -Raw | ConvertFrom-Json).gameRoot }
}
$exe = $null
foreach ($b in @($Game, (Join-Path $Game 'SUPERVIVE'))) {
  $c = Join-Path $b 'Loki\Binaries\Win64\SUPERVIVE-Win64-Shipping.exe'
  if ($Game -and (Test-Path $c)) { $exe = $c; break }
}
if (-not $exe) { throw 'Pass -Game "<your SUPERVIVE install folder>" (or run setup once).' }

if (-not $Map) {
  $cat = Join-Path $Data 'generated\catalog.json'
  if (Test-Path $cat) {
    $m = (Get-Content $cat -Raw | ConvertFrom-Json).maps | Where-Object { $_.name -like '*ServerStandby*' } | Select-Object -First 1
    if ($m) { $Map = $m.path }
  }
}
if (-not $Map) { throw 'No server standby map known. Run setup with --listing, or pass -Map <package path>.' }

New-Item -ItemType Directory -Force -Path (Join-Path $UserDir 'Saved\Config\WindowsClient') | Out-Null
# The server instance gets its own user directory with the same service overrides the client uses.
$clientCfg = Join-Path $env:LOCALAPPDATA 'SUPERVIVE\Saved\Config\WindowsClient'
foreach ($f in @('Engine.ini', 'Game.ini')) {
  $src = Join-Path $clientCfg $f
  if (-not (Test-Path $src) -or -not ((Get-Content $src -Raw) -match 'supervive-revive-local')) {
    throw "Run client\launch.ps1 once first so $f carries the local overrides."
  }
  Copy-Item $src (Join-Path $UserDir "Saved\Config\WindowsClient\$f") -Force
}

$env:AGONES_SDK_HTTP_PORT = '9358'
$sdk = Start-Process -FilePath $bun -ArgumentList @((Join-Path $Repo 'client\agones-sdk.mjs'), '--backend', $Backend, '--match-port', "$Port") -WindowStyle Hidden -PassThru
Say "Agones SDK stand-in PID $($sdk.Id)"
Start-Sleep -Seconds 1

$base = "https://127.0.0.1:$TlsPort"
$srvArgs = @("$Map?listen", "-UserDir=$UserDir", "-port=$Port", "-httpproxy=127.0.0.1:$ProxyPort", "-CoreGameURL=$base",
  '-nosteam', '-SkipVersionCheck', '-unattended', '-log', "-ABSLOG=$LogPath")
if (-not $Visible) { $srvArgs += @('-nullrhi', '-nosound') }
if ($LocalServerPlayerId) { $srvArgs += "-LocalServerPlayerID=$LocalServerPlayerId" }
if (Test-Path $LogPath) { Remove-Item $LogPath -Force }
$srv = Start-Process -FilePath $exe -ArgumentList $srvArgs -WorkingDirectory (Split-Path $exe) -WindowStyle Hidden -PassThru
@{ server = $srv.Id; sdk = $sdk.Id } | ConvertTo-Json | Set-Content -Encoding UTF8 $PidFile
Say "server instance PID $($srv.Id), map $Map, UDP $Port"

for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  if ($srv.HasExited) { break }
  if (Get-NetUDPEndpoint -LocalPort $Port -ErrorAction SilentlyContinue) { break }
}
$udp = Get-NetUDPEndpoint -LocalPort $Port -ErrorAction SilentlyContinue
Say ("server process alive: " + (-not $srv.HasExited))
Say ("UDP $Port open: " + [bool]$udp)
$state = try { Invoke-RestMethod -Uri 'http://127.0.0.1:9358/revive/state' -TimeoutSec 3 } catch { $null }
if ($state) { Say "SDK state: $($state.state), registered host: $($state.hostId), match: $($state.matchId)" }
if (Test-Path $LogPath) {
  Say 'last server log lines of interest:'
  Get-Content $LogPath | Select-String -Pattern 'Agones|CoreGame|LoadMap|Listen|NetDriver|GameMode|Error|Fatal|Exit' | Select-Object -Last 25 | ForEach-Object { "  " + $_.Line }
}
if (-not $udp) { Say 'The server did not open its UDP port. Matches will fall back to the lobby. See docs/GAME-SERVER-MODE.md.' }
