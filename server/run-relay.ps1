$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$relayScript = Join-Path $PSScriptRoot "relay.mjs"
$configPath = Join-Path $PSScriptRoot "relay.config.json"

$existingProcess = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like "*relay.mjs*" } |
  Select-Object -First 1

if ($existingProcess) {
  exit 0
}

$listener = Get-NetTCPConnection -State Listen -LocalPort 3888 -ErrorAction SilentlyContinue |
  Select-Object -First 1

if ($listener) {
  exit 0
}

if (Test-Path $configPath) {
  try {
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    if ($config.proxyUrl) {
      $env:HTTP_PROXY = [string]$config.proxyUrl
      $env:HTTPS_PROXY = [string]$config.proxyUrl
      $env:NO_PROXY = "127.0.0.1,localhost"
    }
  } catch {
    # Ignore invalid config and continue.
  }
}

Set-Location $projectRoot
$node = (Get-Command node).Source
& $node $relayScript
