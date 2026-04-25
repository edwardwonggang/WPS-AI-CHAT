param(
  [string]$TitleLike = "WPS",
  [string]$Prompt,
  [string]$PromptPath = "",
  [int]$InputX = 0,
  [int]$InputY = 0,
  [int]$SendX = 0,
  [int]$SendY = 0,
  [ValidateSet("Relay", "Enter", "Click")]
  [string]$SubmitMode = "Relay",
  [string]$AfterPasteScreenshotPath = "",
  [string]$AfterSubmitScreenshotPath = "",
  [int]$PauseAfterPasteMs = 1600,
  [int]$PauseAfterSubmitMs = 1200
)

$ErrorActionPreference = "Stop"

if (-not [string]::IsNullOrWhiteSpace($PromptPath)) {
  $resolvedPromptPath = (Resolve-Path -LiteralPath $PromptPath).Path
  $Prompt = [System.IO.File]::ReadAllText(
    $resolvedPromptPath,
    [System.Text.UTF8Encoding]::new($false, $true)
  )
}

if ([string]::IsNullOrWhiteSpace($Prompt)) {
  throw "Prompt is required."
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;

public class WpsDesktopInput {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int x, int y);

  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@

function Find-DescendantByClass {
  param(
    [System.Windows.Automation.AutomationElement]$Element,
    [string[]]$ClassNames,
    [int]$MaxDepth = 24,
    [int]$Depth = 0
  )

  if (-not $Element -or $Depth -gt $MaxDepth) {
    return $null
  }

  try {
    $className = [string]$Element.Current.ClassName
    if ($ClassNames -contains $className) {
      return $Element
    }
  } catch {}

  try {
    $children = $Element.FindAll(
      [System.Windows.Automation.TreeScope]::Children,
      [System.Windows.Automation.Condition]::TrueCondition
    )
  } catch {
    return $null
  }

  foreach ($child in $children) {
    $found = Find-DescendantByClass $child $ClassNames $MaxDepth ($Depth + 1)
    if ($found) {
      return $found
    }
  }

  return $null
}

$process = Get-Process -Name wps -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$TitleLike*" } |
  Sort-Object StartTime -Descending |
  Select-Object -First 1

if (-not $process) {
  $process = Get-Process -Name wps -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*WPS*" } |
    Sort-Object StartTime -Descending |
    Select-Object -First 1
}

if (-not $process) {
  throw "No WPS window matched $TitleLike."
}

$root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
$cefPane = if ($root) { Find-DescendantByClass $root @("CefBrowserWindow") } else { $null }

$taskpane = if ($cefPane) {
  $cefPane
} elseif ($root) {
  Find-DescendantByClass $root @("KxJSCTPWidget")
} else {
  $null
}

if ($taskpane) {
  $rect = $taskpane.Current.BoundingRectangle
  if ($InputX -le 0) {
    $InputX = [int]($rect.X + ($rect.Width * 0.5))
  }
  if ($InputY -le 0) {
    $InputY = [int]($rect.Y + $rect.Height - 52)
  }
  if ($SendX -le 0) {
    $SendX = [int]($rect.X + $rect.Width - 36)
  }
  if ($SendY -le 0) {
    $SendY = [int]($rect.Y + $rect.Height - 40)
  }
}

$MOUSEEVENTF_LEFTDOWN = 0x0002
$MOUSEEVENTF_LEFTUP = 0x0004

function Click-Point($x, $y) {
  [WpsDesktopInput]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 120
  [WpsDesktopInput]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
  [WpsDesktopInput]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
}

function Save-WindowScreenshot {
  param([string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return
  }

  $captureScript = Join-Path $PSScriptRoot "capture-wps-window.ps1"
  & $captureScript -ProcessId $process.Id -OutputPath $Path | Out-Null
  Write-Output ("SCREENSHOT={0}" -f $Path)
}

function Invoke-RelayJson {
  param(
    [string]$Path,
    [object]$Payload
  )

  $uri = "http://127.0.0.1:3888$Path"
  $json = $Payload | ConvertTo-Json -Depth 8
  $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($json)
  return Invoke-RestMethod -Uri $uri -Method Post -ContentType "application/json; charset=utf-8" -Body $bytes -TimeoutSec 15
}

function Get-TestCommandStatus {
  param([string]$CommandId)

  $encodedId = [System.Uri]::EscapeDataString($CommandId)
  $uri = "http://127.0.0.1:3888/test-command/status?id=$encodedId"
  return Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec 5
}

function Wait-TestCommandStage {
  param(
    [string]$CommandId,
    [string]$Stage,
    [int]$TimeoutSeconds = 12
  )

  $rank = @{
    queued = 0
    delivered = 1
    filled = 2
    submitted = 3
  }
  $targetRank = $rank[$Stage]
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastStatus = $null

  while ((Get-Date) -lt $deadline) {
    $result = Get-TestCommandStatus $CommandId
    $lastStatus = $result.status
    $currentStage = [string]$lastStatus.stage

    if ($rank.ContainsKey($currentStage) -and $rank[$currentStage] -ge $targetRank) {
      return $lastStatus
    }

    Start-Sleep -Milliseconds 250
  }

  $lastStage = if ($lastStatus) { [string]$lastStatus.stage } else { "none" }
  throw "Timed out waiting for test command $CommandId stage $Stage; last stage was $lastStage."
}

[WpsDesktopInput]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 300

if ($SubmitMode -eq "Relay") {
  $response = Invoke-RelayJson "/test-command" ([pscustomobject]@{
    prompt = $Prompt
    documentTitle = $TitleLike
    visibleDelayMs = [Math]::Max(600, $PauseAfterPasteMs)
  })
  $commandId = [string]$response.id
  $filledStatus = Wait-TestCommandStage $commandId "filled" 15
  Save-WindowScreenshot $AfterPasteScreenshotPath
  $submittedStatus = Wait-TestCommandStage $commandId "submitted" 15
  Save-WindowScreenshot $AfterSubmitScreenshotPath

  Write-Output ("PROMPT_SENT_TO={0}" -f $process.MainWindowTitle)
  Write-Output ("COMMAND_ID={0}" -f $commandId)
  Write-Output ("FILLED_STAGE={0}" -f $filledStatus.stage)
  Write-Output ("SUBMITTED_STAGE={0}" -f $submittedStatus.stage)
  Write-Output ("SUBMIT_MODE={0}" -f $SubmitMode)
  Write-Output ("PROMPT_CHARS={0}" -f $Prompt.Length)
  return
}

if ($InputX -le 0 -or $InputY -le 0 -or $SendX -le 0 -or $SendY -le 0) {
  throw "Taskpane coordinates could not be resolved."
}

Set-Clipboard -Value $Prompt
Click-Point $InputX $InputY
Start-Sleep -Milliseconds 250
[System.Windows.Forms.SendKeys]::SendWait("^a")
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds ([Math]::Max(300, $PauseAfterPasteMs))
Save-WindowScreenshot $AfterPasteScreenshotPath
if ($SubmitMode -eq "Enter") {
  [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
} else {
  Click-Point $SendX $SendY
}
Start-Sleep -Milliseconds ([Math]::Max(300, $PauseAfterSubmitMs))
Save-WindowScreenshot $AfterSubmitScreenshotPath

Write-Output ("PROMPT_SENT_TO={0}" -f $process.MainWindowTitle)
Write-Output ("INPUT={0},{1}" -f $InputX, $InputY)
Write-Output ("SEND={0},{1}" -f $SendX, $SendY)
Write-Output ("SUBMIT_MODE={0}" -f $SubmitMode)
Write-Output ("PROMPT_CHARS={0}" -f $Prompt.Length)
