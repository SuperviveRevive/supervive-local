<#
SUPERVIVE Revive — Local Edition launcher (Windows, PowerShell 5.1+).

  Play on this PC (backend running here):
    powershell -ExecutionPolicy Bypass -File client\launch.ps1 -Name "MyName"

  Join a friend who hosts on the LAN:
    powershell -ExecutionPolicy Bypass -File client\launch.ps1 -Name "MyName" -Backend http://192.168.1.20:24970

  Undo every change this launcher made (config overrides + trusted CA):
    powershell -ExecutionPolicy Bypass -File client\launch.ps1 -Uninstall

What it changes, all reversible with -Uninstall:
  * appends a marked block to your user config (%LOCALAPPDATA%\SUPERVIVE\Saved\Config\WindowsClient\Engine.ini
    and Game.ini) that points the game's service URLs at the local proxy; a backup is kept first;
  * optionally (asks first) appends a CA generated on this PC to the game's trust bundle.
The game executable and its packaged files are never modified.
#>
param(
  [string]$Game = "",
  [string]$Name = "",
  [string]$Backend = "http://127.0.0.1:24970",
  [int]$ProxyPort = 24972,
  [int]$TlsPort = 24973,
  [switch]$Uninstall,
  [switch]$Windowed,
  [string[]]$ExtraArgs = @()
)
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$Data = Join-Path $Repo 'local-data'
New-Item -ItemType Directory -Force -Path $Data | Out-Null
$CfgDir = Join-Path $env:LOCALAPPDATA 'SUPERVIVE\Saved\Config\WindowsClient'
$Begin = '; >>> supervive-revive-local (remove with: launch.ps1 -Uninstall) >>>'
$End = '; <<< supervive-revive-local <<<'
$Utf8 = New-Object System.Text.UTF8Encoding($false)

function Say($m) { Write-Host "[revive] $m" }

function Find-Bun {
  $b = Get-Command bun -ErrorAction SilentlyContinue
  if ($b) { return $b.Source }
  $p = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
  if (Test-Path $p) { return $p }
  throw 'Bun was not found. Install it from https://bun.sh and run this again.'
}

function Find-Game([string]$root) {
  if (-not $root) {
    $inst = Join-Path $Data 'generated\install.json'
    if (Test-Path $inst) { $root = (Get-Content $inst -Raw | ConvertFrom-Json).gameRoot }
  }
  if (-not $root) { throw 'Pass -Game "<your SUPERVIVE install folder>" (or run `bun run setup -- --game ...` once).' }
  foreach ($base in @($root, (Join-Path $root 'SUPERVIVE'))) {
    $exe = Join-Path $base 'Loki\Binaries\Win64\SUPERVIVE-Win64-Shipping.exe'
    if (Test-Path $exe) { return @{ Root = $base; Exe = $exe } }
  }
  throw "SUPERVIVE-Win64-Shipping.exe not found under $root"
}

function Remove-Block([string]$file) {
  if (-not (Test-Path $file)) { return }
  $t = [System.IO.File]::ReadAllText($file)
  $a = $t.IndexOf($Begin)
  if ($a -lt 0) { return }
  $b = $t.IndexOf($End, $a)
  $t2 = if ($b -lt 0) { $t.Substring(0, $a) } else { $t.Substring(0, $a) + $t.Substring($b + $End.Length) }
  [System.IO.File]::WriteAllText($file, $t2.TrimEnd() + "`r`n", $Utf8)
}

function Set-Block([string]$file, [string]$body) {
  New-Item -ItemType Directory -Force -Path (Split-Path $file) | Out-Null
  if ((Test-Path $file) -and -not (Test-Path "$file.revive-local-backup")) { Copy-Item $file "$file.revive-local-backup" }
  Remove-Block $file
  $cur = if (Test-Path $file) { [System.IO.File]::ReadAllText($file).TrimEnd() } else { '' }
  [System.IO.File]::WriteAllText($file, ($cur + "`r`n`r`n$Begin`r`n$body`r`n$End`r`n").TrimStart(), $Utf8)
}

$bun = Find-Bun
$proxy = Join-Path $Repo 'client\proxy.mjs'

if ($Uninstall) {
  Remove-Block (Join-Path $CfgDir 'Engine.ini')
  Remove-Block (Join-Path $CfgDir 'Game.ini')
  Say 'removed config overrides'
  try { $g = Find-Game $Game; & $bun $proxy untrust --game $g.Root } catch { Say "trust bundle: $($_.Exception.Message)" }
  Say 'done'
  return
}

$g = Find-Game $Game

# 1. local proxy (TLS redirect) -------------------------------------------------------------------
$listening = Get-NetTCPConnection -LocalPort $ProxyPort -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  Say "starting proxy on 127.0.0.1:$ProxyPort -> $Backend"
  Start-Process -FilePath $bun -ArgumentList @($proxy, 'serve', '--backend', $Backend, '--port', "$ProxyPort", '--tls-port', "$TlsPort") -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 2
}
$status = (& $bun $proxy status --game $g.Root) | Out-String | ConvertFrom-Json
if (-not $status.trusted) {
  & $bun $proxy trust --game $g.Root
  if ($LASTEXITCODE -ne 0) { throw 'The game cannot reach the local backend without trusting the local CA. Nothing was launched.' }
}

# 2. config overrides (user config only) ----------------------------------------------------------
$base = "https://127.0.0.1:$TlsPort"
$svc = [ordered]@{
  BaseUrl = $base; IamServerUrl = "$base/iam"; PlatformServerUrl = "$base/platform"; LobbyServerUrl = "wss://localhost:$TlsPort/lobby"
  BasicServerUrl = "$base/basic"; CloudStorageServerUrl = "$base/binary"; GameProfileServerUrl = "$base/soc-profile"
  StatisticServerUrl = "$base/statistic"; QosManagerServerUrl = "$base/qosm"; LeaderboardServerUrl = "$base/leaderboard"
  CloudSaveServerUrl = "$base/cloudsave"; GameTelemetryServerUrl = "$base/game-telemetry"; AgreementServerUrl = "$base/agreement"
  AchievementServerUrl = "$base/achievement"; SessionBrowserServerUrl = "$base/sessionbrowser"; ChatServerUrl = "$base/chat"
  GroupServerUrl = "$base/group"; UGCServerUrl = "$base/ugc"; InventoryServerUrl = "$base/inventory"; SeasonPassServerUrl = "$base/seasonpass"
  ReportingServerUrl = "$base/reporting"; SessionServerUrl = "$base/session"; MatchmakingV2ServerUrl = "$base/match2"
  GDPRServerUrl = "$base/gdpr"; AMSServerUrl = "$base/ams"; SocialServerUrl = "$base/social"; MatchmakingServerUrl = "$base/matchmaking"
  LoginServerUrl = "$base/login"
}
$lines = foreach ($k in $svc.Keys) { "$k=`"$($svc[$k])`"" }
$engine = @()
foreach ($section in @('AccelByteSettings', 'AccelByteSettingsTCProduction')) {
  $engine += "[/Script/AccelByteUe4Sdk.$section]"
  $engine += $lines
  $engine += 'GameTelemetryCacheEnabled=false'
  $engine += ''
}
Set-Block (Join-Path $CfgDir 'Engine.ini') ($engine -join "`r`n")
$cc = "$base/client-config"
Set-Block (Join-Path $CfgDir 'Game.ini') ("[/Script/Loki.ClientConfigService]`r`nProdClientConfigURL=`"$cc`"`r`nPreProdClientConfigURL=`"$cc`"`r`nDevClientConfigURL=`"$cc`"`r`nPartnerClientConfigURL=`"$cc`"")
Say 'config overrides written (undo: -Uninstall)'

# 3. local profile login --------------------------------------------------------------------------
$profileFile = Join-Path $Data 'profile.json'
$prof = if (Test-Path $profileFile) { Get-Content $profileFile -Raw | ConvertFrom-Json } else { $null }
if (-not $Name) { $Name = if ($prof) { $prof.displayName } else { Read-Host 'Pick a display name' } }
$key = if ($prof -and $prof.displayName -eq $Name -and $prof.backend -eq $Backend) { $prof.profileKey } else { '' }
$body = @{ displayName = $Name; profileKey = $key } | ConvertTo-Json
try {
  $login = Invoke-RestMethod -Method Post -Uri "$Backend/revive/login" -ContentType 'application/json' -Body $body -TimeoutSec 10
} catch {
  throw "Login failed against ${Backend}: $($_.ErrorDetails.Message) $($_.Exception.Message)"
}
@{ displayName = $login.displayName; userId = $login.userId; profileKey = $login.profileKey; backend = $Backend } | ConvertTo-Json | Set-Content -Encoding UTF8 $profileFile
Say "signed in as $($login.displayName)"

# 4. launch the unmodified game -------------------------------------------------------------------
$ab = @()
foreach ($k in $svc.Keys) { $ab += "-ab$k"; $ab += $svc[$k] }
$flags = @('-AccelbyteEnv=TCProduction', "-httpproxy=127.0.0.1:$ProxyPort", '-nosteam', '-AccelbyteLauncher', "--AB_AUTH_CODE=$($login.authCode)", '-SkipVersionCheck') + $ab
if ($Windowed) { $flags += @('-windowed', '-ResX=1280', '-ResY=720') }
$flags += $ExtraArgs
$env:JUSTICE_AUTHORIZATION_CODE = $login.authCode
Say "launching $($g.Exe)"
Start-Process -FilePath $g.Exe -ArgumentList $flags -WorkingDirectory (Split-Path $g.Exe) | Out-Null
