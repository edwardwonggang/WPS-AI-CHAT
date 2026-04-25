param(
  [int]$ProcessId = 0,
  [string]$TitleLike = "WPS",
  [string]$OutputPath = "d:\cursor_dev\wps_ai\wps-screen.png"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$outputDir = Split-Path -Parent $OutputPath
if (-not [string]::IsNullOrWhiteSpace($outputDir)) {
  New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($bounds.Width -le 0 -or $bounds.Height -le 0) {
  throw "Virtual screen bounds could not be resolved."
}

$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)

try {
  $graphics.CopyFromScreen(
    $bounds.Left,
    $bounds.Top,
    0,
    0,
    $bounds.Size,
    [System.Drawing.CopyPixelOperation]::SourceCopy
  )
  $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}

Write-Output $OutputPath
