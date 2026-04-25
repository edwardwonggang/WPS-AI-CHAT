param(
  [string]$TitleLike = "WPS",
  [int]$MaxDepth = 6
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$process = Get-Process -Name wps -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$TitleLike*" } |
  Sort-Object StartTime -Descending |
  Select-Object -First 1

if (-not $process) {
  throw "No WPS window matched $TitleLike."
}

function Format-Rect($rect) {
  if ($rect.IsEmpty) {
    return ""
  }

  return "{0},{1},{2},{3}" -f [int]$rect.X, [int]$rect.Y, [int]$rect.Width, [int]$rect.Height
}

function Walk-Element($element, $depth) {
  if ($null -eq $element -or $depth -gt $MaxDepth) {
    return
  }

  $prefix = "  " * $depth
  $controlType = $element.Current.ControlType.ProgrammaticName -replace "^ControlType\.", ""
  $name = ($element.Current.Name -replace "\s+", " ").Trim()
  $automationId = ($element.Current.AutomationId -replace "\s+", " ").Trim()
  $className = ($element.Current.ClassName -replace "\s+", " ").Trim()
  $rect = Format-Rect $element.Current.BoundingRectangle

  Write-Output ("{0}{1} name=[{2}] id=[{3}] class=[{4}] offscreen=[{5}] rect=[{6}]" -f $prefix, $controlType, $name, $automationId, $className, $element.Current.IsOffscreen, $rect)

  $children = $element.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  )

  foreach ($child in $children) {
    Walk-Element $child ($depth + 1)
  }
}

$root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
Write-Output ("PROCESS={0} TITLE={1}" -f $process.Id, $process.MainWindowTitle)
Walk-Element $root 0
