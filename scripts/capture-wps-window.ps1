param(
  [int]$ProcessId = 0,
  [string]$TitleLike = "WPS",
  [string]$OutputPath = "d:\cursor_dev\wps_ai\wps-screen.png"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;

public class ScreenCaptureNative {
  [DllImport("user32.dll")]
  public static extern IntPtr GetDC(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

  [DllImport("gdi32.dll")]
  public static extern bool BitBlt(
    IntPtr hdcDest,
    int nXDest,
    int nYDest,
    int nWidth,
    int nHeight,
    IntPtr hdcSrc,
    int nXSrc,
    int nYSrc,
    int dwRop
  );
}
"@

$outputDir = Split-Path -Parent $OutputPath
if (-not [string]::IsNullOrWhiteSpace($outputDir)) {
  New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($bounds.Width -le 0 -or $bounds.Height -le 0) {
  throw "Virtual screen bounds could not be resolved."
}

function Save-WithCopyFromScreen {
  param(
    [System.Drawing.Rectangle]$Bounds,
    [string]$Path
  )

  $bitmap = New-Object System.Drawing.Bitmap $Bounds.Width, $Bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)

  try {
    $graphics.CopyFromScreen(
      $Bounds.Left,
      $Bounds.Top,
      0,
      0,
      $Bounds.Size,
      [System.Drawing.CopyPixelOperation]::SourceCopy
    )
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Save-WithBitBlt {
  param(
    [System.Drawing.Rectangle]$Bounds,
    [string]$Path
  )

  $bitmap = New-Object System.Drawing.Bitmap $Bounds.Width, $Bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $destDc = $graphics.GetHdc()
  $screenDc = [ScreenCaptureNative]::GetDC([IntPtr]::Zero)
  $SRCCOPY = 0x00CC0020

  try {
    if ($screenDc -eq [IntPtr]::Zero) {
      throw "Could not acquire desktop DC."
    }

    $ok = [ScreenCaptureNative]::BitBlt(
      $destDc,
      0,
      0,
      $Bounds.Width,
      $Bounds.Height,
      $screenDc,
      $Bounds.Left,
      $Bounds.Top,
      $SRCCOPY
    )

    if (-not $ok) {
      throw "Desktop BitBlt failed."
    }

    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    if ($screenDc -ne [IntPtr]::Zero) {
      [ScreenCaptureNative]::ReleaseDC([IntPtr]::Zero, $screenDc) | Out-Null
    }
    $graphics.ReleaseHdc($destDc)
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Save-CapturePlaceholder {
  param(
    [System.Drawing.Rectangle]$Bounds,
    [string]$Path,
    [string]$Message
  )

  $bitmap = New-Object System.Drawing.Bitmap $Bounds.Width, $Bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(245, 247, 250))
  $textBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(176, 32, 32))
  $font = New-Object System.Drawing.Font("Segoe UI", 16, [System.Drawing.FontStyle]::Bold)

  try {
    $graphics.FillRectangle($brush, 0, 0, $Bounds.Width, $Bounds.Height)
    $graphics.DrawString("Full-screen capture unavailable", $font, $textBrush, 32, 32)
    $graphics.DrawString($Message, (New-Object System.Drawing.Font("Consolas", 10)), $textBrush, 32, 74)
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $font.Dispose()
    $brush.Dispose()
    $textBrush.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

$lastError = $null
for ($attempt = 1; $attempt -le 3; $attempt++) {
  try {
    Save-WithCopyFromScreen $bounds $OutputPath
    Write-Output $OutputPath
    exit 0
  } catch {
    $lastError = $_.Exception.Message
    Start-Sleep -Milliseconds (150 * $attempt)
  }
}

try {
  Save-WithBitBlt $bounds $OutputPath
} catch {
  Save-CapturePlaceholder $bounds $OutputPath "CopyFromScreen: $lastError; BitBlt: $($_.Exception.Message)"
  Write-Output ("CAPTURE_PLACEHOLDER={0}" -f $OutputPath)
  exit 0
}

Write-Output $OutputPath
