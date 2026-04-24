$ErrorActionPreference = "Stop"

$port = 3888
$projectRoot = Split-Path -Parent $PSScriptRoot
$relayScript = Join-Path $PSScriptRoot "relay.mjs"
$stdoutLog = Join-Path $env:TEMP "wps-ai-relay.stdout.log"
$stderrLog = Join-Path $env:TEMP "wps-ai-relay.stderr.log"

$existingProcess = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like "*server\\relay.mjs*" } |
  Select-Object -First 1

if ($existingProcess) {
  exit 0
}

$listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
  Select-Object -First 1

if ($listener) {
  exit 0
}

$node = (Get-Command node).Source

Start-Process `
  -FilePath $node `
  -ArgumentList @($relayScript) `
  -WorkingDirectory $projectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog

Start-Sleep -Milliseconds 800
