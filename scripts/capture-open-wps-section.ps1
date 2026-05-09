param(
  [int]$ParagraphIndex = 1,
  [string]$OutputPath = "test-artifacts\manual-inspect\wps-section.png"
)

$ErrorActionPreference = "Stop"

$app = [System.Runtime.InteropServices.Marshal]::GetActiveObject("kwps.Application")
$doc = $app.ActiveDocument
if (-not $doc) {
  throw "No active WPS document."
}

try { $app.Visible = $true } catch {}
try { $app.WindowState = 1 } catch {}

$process = Get-Process -Name wps -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$($doc.Name)*" } |
  Sort-Object StartTime -Descending |
  Select-Object -First 1

if (-not $process) {
  $process = Get-Process -Name wps -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Sort-Object StartTime -Descending |
    Select-Object -First 1
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WpsSectionWindowTools {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

if ($process) {
  [WpsSectionWindowTools]::ShowWindow($process.MainWindowHandle, 3) | Out-Null
  [WpsSectionWindowTools]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
}

$paragraphCount = [int]$doc.Paragraphs.Count
$targetIndex = [Math]::Max(1, [Math]::Min($ParagraphIndex, $paragraphCount))
$range = $doc.Paragraphs.Item($targetIndex).Range
try { $range.Select() } catch {}
try { $app.Selection.Range.Select() } catch {}
try { $app.ActiveWindow.ScrollIntoView($range, $true) } catch {}
try { $doc.ActiveWindow.ScrollIntoView($range, $true) } catch {}
try { $app.ScreenRefresh() } catch {}

Start-Sleep -Milliseconds 900

$fullOutputPath = Join-Path (Get-Location) $OutputPath
$outputDir = Split-Path -Parent $fullOutputPath
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

$captureScript = Join-Path (Get-Location) "scripts\capture-wps-window.ps1"
if (-not $process) {
  throw "No visible WPS process."
}

& $captureScript -ProcessId $process.Id -OutputPath $fullOutputPath | Out-Null

Write-Output ("SCREENSHOT={0}" -f $fullOutputPath)
