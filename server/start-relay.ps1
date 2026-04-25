param(
  [switch]$ForceRestart
)

$ErrorActionPreference = "Stop"

$port = 3888
$projectRoot = Split-Path -Parent $PSScriptRoot
$relayScript = Join-Path $PSScriptRoot "relay.mjs"
$stdoutLog = Join-Path $env:TEMP "wps-ai-relay.stdout.log"
$stderrLog = Join-Path $env:TEMP "wps-ai-relay.stderr.log"

$existingProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like "*server\\relay.mjs*" })

if ($ForceRestart) {
  foreach ($process in $existingProcesses) {
    try {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    } catch {
      # Ignore stale process records.
    }
  }

  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
  foreach ($listener in $listeners) {
    if ($listener.OwningProcess) {
      try {
        Stop-Process -Id $listener.OwningProcess -Force -ErrorAction Stop
      } catch {
        # Ignore processes that have already exited.
      }
    }
  }

  Start-Sleep -Milliseconds 500
} elseif ($existingProcesses.Count -gt 0) {
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
