param(
  [string]$OutputRoot = "test-artifacts\manual-inspect"
)

$ErrorActionPreference = "Stop"

function Normalize-Text {
  param([string]$Text)

  if ($null -eq $Text) {
    $value = ""
  } else {
    $value = [string]$Text
  }
  $value = $value -replace "[\u0000-\u001f]", " "
  $value = $value -replace "\s+", " "
  return $value.Trim()
}

function Read-StyleName {
  param($Range)

  try {
    return [string]$Range.Style.NameLocal
  } catch {
    try {
      return [string]$Range.Style
    } catch {
      return ""
    }
  }
}

function Read-ParagraphRecord {
  param(
    $Paragraph,
    [int]$Index
  )

  $range = $Paragraph.Range
  $text = Normalize-Text $range.Text
  if ($text.Length -gt 140) {
    $text = $text.Substring(0, 140)
  }

  $styleName = Read-StyleName $range
  $outline = $null
  $fontName = ""
  $fontNameAscii = ""
  $fontSize = $null
  $bold = $null
  $italic = $null
  $color = $null
  $shading = $null
  $alignment = $null
  $leftIndent = $null
  $firstIndent = $null
  $lineSpacing = $null
  $spaceBefore = $null
  $spaceAfter = $null

  try { $outline = [int]$Paragraph.OutlineLevel } catch {}
  try { $fontName = [string]$range.Font.Name } catch {}
  try { $fontNameAscii = [string]$range.Font.NameAscii } catch {}
  try { $fontSize = [double]$range.Font.Size } catch {}
  try { $bold = [int]$range.Font.Bold } catch {}
  try { $italic = [int]$range.Font.Italic } catch {}
  try { $color = [int]$range.Font.Color } catch {}
  try { $shading = [int]$range.Shading.BackgroundPatternColor } catch {}
  try { $alignment = [string]$range.ParagraphFormat.Alignment } catch {}
  try { $leftIndent = [double]$range.ParagraphFormat.CharacterUnitLeftIndent } catch {}
  try { $firstIndent = [double]$range.ParagraphFormat.CharacterUnitFirstLineIndent } catch {}
  try { $lineSpacing = [double]$range.ParagraphFormat.LineSpacing } catch {}
  try { $spaceBefore = [double]$range.ParagraphFormat.SpaceBefore } catch {}
  try { $spaceAfter = [double]$range.ParagraphFormat.SpaceAfter } catch {}

  $kind = "body"
  if ($outline -ge 1 -and $outline -le 6) {
    $kind = "outline-heading"
  } elseif ($text -match "^\d+(\.\d+)*\s+\S" -and $bold -ne 0) {
    $kind = "numbered-heading"
  } elseif ($fontName -like "*Consolas*" -or $fontNameAscii -like "*Consolas*" -or $text -match "^\s*\d+\s{2,}\S") {
    $kind = "code"
  } elseif ($styleName -match "目录|TOC|Contents") {
    $kind = "toc"
  }

  [pscustomobject]@{
    index = $Index
    kind = $kind
    text = $text
    style = $styleName
    outlineLevel = $outline
    fontName = $fontName
    fontNameAscii = $fontNameAscii
    fontSize = $fontSize
    bold = $bold
    italic = $italic
    color = $color
    shading = $shading
    alignment = $alignment
    leftIndent = $leftIndent
    firstLineIndent = $firstIndent
    lineSpacing = $lineSpacing
    spaceBefore = $spaceBefore
    spaceAfter = $spaceAfter
  }
}

function Read-TableRecord {
  param(
    $Table,
    [int]$Index
  )

  $cells = @()
  $rowLimit = [Math]::Min([int]$Table.Rows.Count, 5)
  $colLimit = [Math]::Min([int]$Table.Columns.Count, 5)

  for ($row = 1; $row -le $rowLimit; $row++) {
    for ($col = 1; $col -le $colLimit; $col++) {
      $cellRange = $Table.Cell($row, $col).Range
      $cells += [pscustomobject]@{
        row = $row
        col = $col
        text = Normalize-Text $cellRange.Text
        fontName = [string]$cellRange.Font.Name
        fontNameAscii = [string]$cellRange.Font.NameAscii
        fontSize = [double]$cellRange.Font.Size
        bold = [int]$cellRange.Font.Bold
        alignment = [string]$cellRange.ParagraphFormat.Alignment
      }
    }
  }

  [pscustomobject]@{
    index = $Index
    rows = [int]$Table.Rows.Count
    cols = [int]$Table.Columns.Count
    cells = $cells
  }
}

$outputRootPath = Join-Path (Get-Location) $OutputRoot
New-Item -ItemType Directory -Force -Path $outputRootPath | Out-Null

$runPath = Join-Path $outputRootPath (Get-Date -Format "yyyyMMdd-HHmmss")
New-Item -ItemType Directory -Force -Path $runPath | Out-Null

$app = [System.Runtime.InteropServices.Marshal]::GetActiveObject("kwps.Application")
$doc = $app.ActiveDocument
if (-not $doc) {
  throw "No active WPS document."
}

$paragraphs = @()
$paragraphLimit = [Math]::Min([int]$doc.Paragraphs.Count, 160)
for ($i = 1; $i -le $paragraphLimit; $i++) {
  $paragraphs += Read-ParagraphRecord -Paragraph $doc.Paragraphs.Item($i) -Index $i
}

$tables = @()
try {
  for ($i = 1; $i -le $doc.Tables.Count; $i++) {
    $tables += Read-TableRecord -Table $doc.Tables.Item($i) -Index $i
  }
} catch {}

$tocText = @()
$tocCount = 0
try {
  $tocCount = [int]$doc.TablesOfContents.Count
  for ($i = 1; $i -le $tocCount; $i++) {
    $tocText += Normalize-Text $doc.TablesOfContents.Item($i).Range.Text
  }
} catch {}

$fullText = [string]$doc.Content.Text
$pageSetup = [ordered]@{
  paperSize = $null
  topMargin = $null
  bottomMargin = $null
  leftMargin = $null
  rightMargin = $null
  headerDistance = $null
  footerDistance = $null
}
try { $pageSetup.paperSize = [int]$doc.PageSetup.PaperSize } catch {}
try { $pageSetup.topMargin = [double]$doc.PageSetup.TopMargin } catch {}
try { $pageSetup.bottomMargin = [double]$doc.PageSetup.BottomMargin } catch {}
try { $pageSetup.leftMargin = [double]$doc.PageSetup.LeftMargin } catch {}
try { $pageSetup.rightMargin = [double]$doc.PageSetup.RightMargin } catch {}
try { $pageSetup.headerDistance = [double]$doc.PageSetup.HeaderDistance } catch {}
try { $pageSetup.footerDistance = [double]$doc.PageSetup.FooterDistance } catch {}

$report = [pscustomobject]@{
  document = [pscustomobject]@{
    name = [string]$doc.Name
    fullName = [string]$doc.FullName
    paragraphCount = [int]$doc.Paragraphs.Count
    tableCount = [int]$doc.Tables.Count
    tocCount = $tocCount
    textLength = $fullText.Length
    pageSetup = [pscustomobject]$pageSetup
  }
  tocText = $tocText
  paragraphs = $paragraphs
  tables = $tables
}

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

$jsonPath = Join-Path $runPath "wps-render-report.json"
$json = $report | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText(
  $jsonPath,
  $json,
  [System.Text.UTF8Encoding]::new($false)
)

$summaryPath = Join-Path $runPath "wps-render-summary.txt"
$headingRecords = @($paragraphs | Where-Object { $_.kind -match "heading" })
$outlineHeadingRecords = @($paragraphs | Where-Object { $_.kind -eq "outline-heading" })
$codeRecords = @($paragraphs | Where-Object { $_.kind -eq "code" })
$tocRecords = @($paragraphs | Where-Object { $_.kind -eq "toc" -or $_.text -match "^目录" })
$bodyRecords = @($paragraphs | Where-Object { $_.kind -eq "body" -and $_.text })
$summaryLines = @(
  "Document: $($doc.Name)",
  "Paragraphs: $($doc.Paragraphs.Count)",
  "Tables: $($doc.Tables.Count)",
  "TablesOfContents: $tocCount",
  "PageSetup: paper=$($pageSetup.paperSize); top=$($pageSetup.topMargin); bottom=$($pageSetup.bottomMargin); left=$($pageSetup.leftMargin); right=$($pageSetup.rightMargin)",
  "HeadingLikeParagraphs: $($headingRecords.Count)",
  "OutlineHeadingParagraphs: $($outlineHeadingRecords.Count)",
  "TocParagraphs: $($tocRecords.Count)",
  "CodeParagraphs: $($codeRecords.Count)",
  "BodyParagraphsSampled: $($bodyRecords.Count)",
  "",
  "Headings:",
  (($headingRecords | Select-Object -First 24 | ForEach-Object {
    "{0}: kind={1}; outline={2}; style={3}; font={4}/{5}; size={6}; bold={7}; text={8}" -f $_.index, $_.kind, $_.outlineLevel, $_.style, $_.fontName, $_.fontNameAscii, $_.fontSize, $_.bold, $_.text
  }) -join [Environment]::NewLine),
  "",
  "TOC:",
  (($tocRecords | Select-Object -First 12 | ForEach-Object {
    "{0}: kind={1}; outline={2}; style={3}; text={4}" -f $_.index, $_.kind, $_.outlineLevel, $_.style, $_.text
  }) -join [Environment]::NewLine),
  "",
  "Code:",
  (($codeRecords | Select-Object -First 24 | ForEach-Object {
    "{0}: font={1}/{2}; size={3}; color={4}; shading={5}; text={6}" -f $_.index, $_.fontName, $_.fontNameAscii, $_.fontSize, $_.color, $_.shading, $_.text
  }) -join [Environment]::NewLine)
)
[System.IO.File]::WriteAllText(
  $summaryPath,
  ($summaryLines -join [Environment]::NewLine),
  [System.Text.UTF8Encoding]::new($false)
)

$shotPath = Join-Path $runPath "active-wps.png"
if ($process) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WpsWindowTools {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
  [WpsWindowTools]::ShowWindow($process.MainWindowHandle, 9) | Out-Null
  [WpsWindowTools]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 700
  $captureScript = Join-Path (Get-Location) "scripts\capture-wps-window.ps1"
  & $captureScript -ProcessId $process.Id -OutputPath $shotPath | Out-Null
}

Write-Output ("REPORT={0}" -f $jsonPath)
Write-Output ("SUMMARY={0}" -f $summaryPath)
Write-Output ("SCREENSHOT={0}" -f $shotPath)
