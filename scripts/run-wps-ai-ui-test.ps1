param(
  [string]$PromptPath = ".\scripts\wps-ai-render-test-prompt.txt",
  [string]$LogRoot = ".\test-artifacts\wps-ai-ui",
  [int]$WaitSeconds = 300,
  [int]$CaptureIntervalSeconds = 3,
  [switch]$NoPopup,
  [switch]$NoSend,
  [switch]$KeepExistingWps
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$PromptFullPath = if ([System.IO.Path]::IsPathRooted($PromptPath)) {
  (Resolve-Path -LiteralPath $PromptPath).Path
} else {
  (Resolve-Path -LiteralPath (Join-Path $ProjectRoot $PromptPath)).Path
}

$LogRootFullPath = if ([System.IO.Path]::IsPathRooted($LogRoot)) {
  $LogRoot
} else {
  Join-Path $ProjectRoot $LogRoot
}

$RunId = Get-Date -Format "yyyyMMdd-HHmmss"
$RunDir = Join-Path $LogRootFullPath $RunId
New-Item -ItemType Directory -Path $RunDir -Force | Out-Null
$CaptureDir = Join-Path $RunDir "captures"
New-Item -ItemType Directory -Path $CaptureDir -Force | Out-Null

$LogPath = Join-Path $RunDir "run.log"
$StatusPath = Join-Path $RunDir "status.json"
$SummaryPath = Join-Path $RunDir "summary.json"
$BeforeShot = Join-Path $RunDir "before-send.png"
$PromptFilledShot = Join-Path $RunDir "prompt-filled-before-submit.png"
$PromptSubmittedShot = Join-Path $RunDir "prompt-submitted.png"
$AfterShot = Join-Path $RunDir "after-output.png"
$StuckShot = Join-Path $RunDir "stuck.png"
$TaskpaneFailTree = Join-Path $RunDir "taskpane-failed-ui-tree.txt"
$TestDocPath = Join-Path $RunDir ("WpsAiUiTest-{0}.docx" -f $RunId)

function Add-Log {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $Message
  [System.IO.File]::AppendAllText($LogPath, $line + [Environment]::NewLine, $Utf8NoBom)
  Write-Host $line
}

function Set-TestStatus {
  param(
    [string]$Message,
    [string]$Color = "blue",
    [bool]$Done = $false
  )

  $status = [pscustomobject]@{
    title = "WPS AI UI Test"
    message = $Message
    color = $Color
    done = $Done
    time = (Get-Date).ToString("s")
    log = $LogPath
  }

  [System.IO.File]::WriteAllText(
    $StatusPath,
    ($status | ConvertTo-Json -Compress),
    $Utf8NoBom
  )

  Add-Log ("STATUS {0}: {1}" -f $Color, $Message)
}

function Start-StatusPopup {
  if ($NoPopup) {
    return
  }

  $scriptPath = Join-Path $PSScriptRoot "show-wps-test-status.ps1"
  Start-Process -FilePath "powershell" -WindowStyle Hidden -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $scriptPath,
    "-StatusPath",
    $StatusPath
  ) | Out-Null
}

function Invoke-Step {
  param(
    [string]$Name,
    [scriptblock]$Action
  )

  Add-Log ("STEP START {0}" -f $Name)
  try {
    $result = & $Action
    Add-Log ("STEP OK {0}" -f $Name)
    return $result
  } catch {
    Add-Log ("STEP FAIL {0}: {1}" -f $Name, $_.Exception.Message)
    Set-TestStatus ("Failed: {0}" -f $Name) "red" $true
    throw
  }
}

function Close-ExistingWpsWriter {
  $processes = @(Get-Process -Name wps -ErrorAction SilentlyContinue)
  if ($processes.Count -eq 0) {
    Add-Log "CLOSE_WPS none"
    return
  }

  foreach ($process in $processes) {
    Add-Log ("CLOSE_WPS request id={0} title={1}" -f $process.Id, $process.MainWindowTitle)
    try {
      if ($process.MainWindowHandle -ne 0) {
        $null = $process.CloseMainWindow()
      } else {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      }
    } catch {
      Add-Log ("CLOSE_WPS request_failed id={0} error={1}" -f $process.Id, $_.Exception.Message)
    }
  }

  $deadline = (Get-Date).AddSeconds(12)
  while ((Get-Date) -lt $deadline) {
    $remaining = @(Get-Process -Name wps -ErrorAction SilentlyContinue)
    if ($remaining.Count -eq 0) {
      Add-Log "CLOSE_WPS closed"
      return
    }

    Start-Sleep -Milliseconds 500
  }

  $remaining = @(Get-Process -Name wps -ErrorAction SilentlyContinue)
  foreach ($process in $remaining) {
    Add-Log ("CLOSE_WPS force id={0} title={1}" -f $process.Id, $process.MainWindowTitle)
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
}

function Get-WpsProcessForDocument {
  param([string]$DocumentName)

  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    $exactProcess = Get-Process -Name wps -ErrorAction SilentlyContinue |
      Where-Object {
        $_.MainWindowHandle -ne 0 -and
        $_.MainWindowTitle -like "*$DocumentName*"
      } |
      Sort-Object StartTime -Descending |
      Select-Object -First 1

    if ($exactProcess) {
      return $exactProcess
    }

    $wpsProcess = Get-Process -Name wps -ErrorAction SilentlyContinue |
      Where-Object {
        $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*WPS*"
      } |
      Sort-Object StartTime -Descending |
      Select-Object -First 1

    if ($wpsProcess) {
      return $wpsProcess
    }

    Start-Sleep -Milliseconds 500
  }

  return $null
}

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

function Get-TaskpaneRect {
  param([System.Diagnostics.Process]$Process)

  if (-not $Process -or $Process.MainWindowHandle -eq 0) {
    return $null
  }

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($Process.MainWindowHandle)
  if (-not $root) {
    return $null
  }

  $cefPane = Find-DescendantByClass $root @("CefBrowserWindow")

  if ($cefPane) {
    return $cefPane.Current.BoundingRectangle
  }

  $taskpane = Find-DescendantByClass $root @("KxJSCTPWidget")

  if ($taskpane) {
    return $taskpane.Current.BoundingRectangle
  }

  return $null
}

function Wait-Taskpane {
  param(
    [System.Diagnostics.Process]$Process,
    [string]$DocumentName = ""
  )

  $deadline = (Get-Date).AddSeconds(40)
  $attempt = 0
  while ((Get-Date) -lt $deadline) {
    $attempt++
    $candidates = @()

    if ($Process) {
      $fresh = Get-Process -Id $Process.Id -ErrorAction SilentlyContinue
      if ($fresh -and $fresh.MainWindowHandle -ne 0) {
        $candidates += $fresh
      }
    }

    if (-not [string]::IsNullOrWhiteSpace($DocumentName)) {
      $named = Get-Process -Name wps -ErrorAction SilentlyContinue |
        Where-Object {
          $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$DocumentName*"
        }
      $candidates += $named
    }

    $allWps = Get-Process -Name wps -ErrorAction SilentlyContinue |
      Where-Object {
        $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*WPS*"
      }
    $candidates += $allWps

    $uniqueCandidates = $candidates |
      Where-Object { $_ -and $_.MainWindowHandle -ne 0 } |
      Sort-Object Id -Unique

    foreach ($candidate in $uniqueCandidates) {
      $rect = Get-TaskpaneRect $candidate
      if ($rect -and -not $rect.IsEmpty -and $rect.Width -gt 200 -and $rect.Height -gt 200) {
        Add-Log ("TASKPANE_MATCH process={0} title={1} rect={2},{3},{4},{5}" -f $candidate.Id, $candidate.MainWindowTitle, [int]$rect.X, [int]$rect.Y, [int]$rect.Width, [int]$rect.Height)
        return [pscustomobject]@{
          process = $candidate
          rect = $rect
        }
      }
    }

    if ($attempt -eq 1 -or $attempt % 5 -eq 0) {
      $titles = ($uniqueCandidates | Select-Object -ExpandProperty MainWindowTitle) -join " | "
      Add-Log ("TASKPANE_WAIT attempt={0} candidates={1} titles={2}" -f $attempt, ($uniqueCandidates | Measure-Object).Count, $titles)
    }

    if ($uniqueCandidates -and ($attempt -eq 1 -or $attempt % [Math]::Max(1, $CaptureIntervalSeconds) -eq 0)) {
      Save-CaptureFrame ($uniqueCandidates | Select-Object -First 1) "taskpane-wait"
    }

    Start-Sleep -Milliseconds 800
  }

  return $null
}

function Get-DocumentText {
  param($Document)
  try {
    return [string]$Document.Content.Text
  } catch {
    return ""
  }
}

function Get-TableSummary {
  param($Document)

  $items = @()
  $count = 0

  try {
    $count = [int]$Document.Tables.Count
  } catch {
    $count = 0
  }

  for ($i = 1; $i -le $count; $i++) {
    try {
      $table = $Document.Tables.Item($i)
      $items += [pscustomobject]@{
        index = $i
        rows = [int]$table.Rows.Count
        cols = [int]$table.Columns.Count
      }
    } catch {
      $items += [pscustomobject]@{
        index = $i
        rows = 0
        cols = 0
      }
    }
  }

  return [pscustomobject]@{
    count = $count
    items = $items
  }
}

function Get-FormatStats {
  param($Document)

  $stats = [ordered]@{
    sampledChars = 0
    codeFontChars = 0
    coloredChars = 0
    boldChars = 0
    italicChars = 0
    headingLikeParagraphs = 0
    quoteLikeParagraphs = 0
    codeLineNumberParagraphs = 0
    leftAlignedParagraphs = 0
    paragraphSamples = @()
  }

  try {
    $paragraphCount = [Math]::Min([int]$Document.Paragraphs.Count, 80)
    for ($i = 1; $i -le $paragraphCount; $i++) {
      $paragraph = $Document.Paragraphs.Item($i)
      $range = $paragraph.Range
      $text = ([string]$range.Text -replace "[\u0000-\u001f]", " " -replace "\s+", " ").Trim()

      $fontSize = 0
      $bold = 0
      $alignment = ""
      $lineSpacing = 0
      $leftIndent = 0
      $firstLineIndent = 0
      $fontName = ""
      $fontNameAscii = ""
      try { $fontSize = [double]$range.Font.Size } catch {}
      try { $bold = [int]$range.Font.Bold } catch {}
      try { $alignment = [string]$range.ParagraphFormat.Alignment } catch {}
      try { $lineSpacing = [double]$range.ParagraphFormat.LineSpacing } catch {}
      try { $leftIndent = [double]$range.ParagraphFormat.CharacterUnitLeftIndent } catch {}
      try { $firstLineIndent = [double]$range.ParagraphFormat.CharacterUnitFirstLineIndent } catch {}
      try { $fontName = [string]$range.Font.Name } catch {}
      try { $fontNameAscii = [string]$range.Font.NameAscii } catch {}

      if ($fontSize -ge 14 -or $bold -ne 0) {
        $stats.headingLikeParagraphs++
      }
      if ($leftIndent -ge 2 -and $firstLineIndent -ge 0 -and $fontNameAscii -notlike "*Consolas*") {
        $stats.quoteLikeParagraphs++
      }
      if ($text -match "^\d+\s+\S" -and ($fontName -like "*Consolas*" -or $fontNameAscii -like "*Consolas*")) {
        $stats.codeLineNumberParagraphs++
      }
      if ($alignment -eq "0" -or $alignment -eq "wdAlignParagraphLeft") {
        $stats.leftAlignedParagraphs++
      }

      if ($stats.paragraphSamples.Count -lt 24) {
        $sampleText = $text
        if ($sampleText.Length -gt 80) {
          $sampleText = $sampleText.Substring(0, 80)
        }

        $stats.paragraphSamples += [pscustomobject]@{
          index = $i
          text = $sampleText
          fontName = $fontName
          fontNameAscii = $fontNameAscii
          fontSize = $fontSize
          bold = $bold
          alignment = $alignment
          lineSpacing = $lineSpacing
          leftIndent = $leftIndent
          firstLineIndent = $firstLineIndent
        }
      }
    }
  } catch {}

  try {
    $chars = $Document.Content.Characters
    $limit = [Math]::Min([int]$chars.Count, 6000)
    for ($i = 1; $i -le $limit; $i++) {
      $charRange = $chars.Item($i)
      $stats.sampledChars++

      $fontName = ""
      $fontNameAscii = ""
      $color = $null
      $bold = 0
      $italic = 0

      try { $fontName = [string]$charRange.Font.Name } catch {}
      try { $fontNameAscii = [string]$charRange.Font.NameAscii } catch {}
      try { $color = [int]$charRange.Font.Color } catch {}
      try { $bold = [int]$charRange.Font.Bold } catch {}
      try { $italic = [int]$charRange.Font.Italic } catch {}

      if ($fontName -like "*Consolas*" -or $fontNameAscii -like "*Consolas*") {
        $stats.codeFontChars++
      }
      if ($null -ne $color -and $color -ne 0 -and $color -ne -16777216) {
        $stats.coloredChars++
      }
      if ($bold -ne 0) {
        $stats.boldChars++
      }
      if ($italic -ne 0) {
        $stats.italicChars++
      }
    }
  } catch {}

  return [pscustomobject]$stats
}

function Save-Screenshot {
  param(
    [System.Diagnostics.Process]$Process,
    [string]$Path
  )

  $captureScript = Join-Path $PSScriptRoot "capture-wps-window.ps1"
  & $captureScript -ProcessId $Process.Id -OutputPath $Path | Out-Null
  Add-Log ("SCREENSHOT {0}" -f $Path)
}

function Save-CaptureFrame {
  param(
    [System.Diagnostics.Process]$Process,
    [string]$Stage
  )

  if (-not $Process -or $Process.MainWindowHandle -eq 0) {
    return
  }

  $stamp = Get-Date -Format "HHmmss-fff"
  $safeStage = ($Stage -replace "[^A-Za-z0-9_-]", "-")
  $path = Join-Path $CaptureDir ("{0}-{1}.png" -f $stamp, $safeStage)
  try {
    Save-Screenshot $Process $path
  } catch {
    Add-Log ("CAPTURE_FAILED stage={0} error={1}" -f $Stage, $_.Exception.Message)
  }
}

function Save-UiTree {
  param(
    [string]$TitleLike,
    [string]$Path
  )

  $inspectScript = Join-Path $PSScriptRoot "inspect-wps-ui.ps1"
  try {
    $output = & $inspectScript -TitleLike $TitleLike -MaxDepth 14
    [System.IO.File]::WriteAllLines($Path, [string[]]$output, $Utf8NoBom)
    Add-Log ("UI_TREE {0}" -f $Path)
  } catch {
    Add-Log ("UI_TREE_FAILED {0}" -f $_.Exception.Message)
  }
}

Start-StatusPopup
Set-TestStatus "Preparing log and checking relay..." "blue"

Add-Log ("RUN_DIR={0}" -f $RunDir)
Add-Log ("CAPTURE_DIR={0}" -f $CaptureDir)
Add-Log ("TEST_DOC={0}" -f $TestDocPath)
Add-Log ("PROMPT_PATH={0}" -f $PromptFullPath)
Add-Log ("POWERSHELL={0}" -f $PSVersionTable.PSVersion.ToString())

$prompt = [System.IO.File]::ReadAllText(
  $PromptFullPath,
  [System.Text.UTF8Encoding]::new($false, $true)
)
Add-Log ("PROMPT_CHARS={0}" -f $prompt.Length)

if (-not $KeepExistingWps) {
  Set-TestStatus "Closing existing WPS Writer windows..." "blue"
  Invoke-Step "close existing WPS Writer" {
    Close-ExistingWpsWriter
  }
}

Invoke-Step "relay bootstrap" {
  try {
    $bootstrap = Invoke-RestMethod -Uri "http://127.0.0.1:3888/bootstrap" -TimeoutSec 8
    Add-Log ("BOOTSTRAP_PROVIDER={0}" -f $bootstrap.defaults.providerId)
    Add-Log ("BOOTSTRAP_MODEL={0}" -f $bootstrap.defaults.model)
  } catch {
    Add-Log "Relay bootstrap failed; starting relay script."
    $relayScript = Join-Path $ProjectRoot "server\start-relay.ps1"
    & $relayScript -ForceRestart | Out-Null
    Start-Sleep -Seconds 3
    $bootstrap = Invoke-RestMethod -Uri "http://127.0.0.1:3888/bootstrap" -TimeoutSec 8
    Add-Log ("BOOTSTRAP_PROVIDER={0}" -f $bootstrap.defaults.providerId)
    Add-Log ("BOOTSTRAP_MODEL={0}" -f $bootstrap.defaults.model)
  }
}

Set-TestStatus "Opening a new WPS Writer document..." "blue"
$wpsContext = Invoke-Step "open WPS document" {
  $app = New-Object -ComObject kwps.Application
  $app.Visible = $true
  $doc = $app.Documents.Add()
  try {
    $doc.SaveAs2($TestDocPath)
  } catch {
    $doc.SaveAs($TestDocPath)
  }
  Start-Sleep -Seconds 5
  [pscustomobject]@{
    app = $app
    doc = $doc
    name = [string]$doc.Name
  }
}

Add-Log ("DOC_NAME={0}" -f $wpsContext.name)

$wpsProcess = Invoke-Step "find WPS window" {
  $process = Get-WpsProcessForDocument $wpsContext.name
  if (-not $process) {
    throw "No WPS process with a visible main window."
  }
  Add-Log ("WPS_PROCESS={0} TITLE={1}" -f $process.Id, $process.MainWindowTitle)
  $process
}

Set-TestStatus "Waiting for the WPS AI taskpane..." "blue"
$paneInfo = Invoke-Step "wait taskpane" {
  $paneInfo = Wait-Taskpane $wpsProcess $wpsContext.name
  if (-not $paneInfo) {
    Save-Screenshot $wpsProcess $StuckShot
    Save-UiTree $wpsContext.name $TaskpaneFailTree
    throw "WPS AI taskpane did not become visible."
  }
  Add-Log ("TASKPANE_RECT={0},{1},{2},{3}" -f [int]$paneInfo.rect.X, [int]$paneInfo.rect.Y, [int]$paneInfo.rect.Width, [int]$paneInfo.rect.Height)
  $paneInfo
}
$wpsProcess = $paneInfo.process
$paneRect = $paneInfo.rect

Save-Screenshot $wpsProcess $BeforeShot

if ($NoSend) {
  Set-TestStatus "NoSend enabled; skipping prompt submission." "orange" $true
  exit 0
}

Set-TestStatus "Sending the fixed AI prompt to the taskpane..." "blue"
Invoke-Step "send prompt" {
  $sendScript = Join-Path $PSScriptRoot "send-wps-ai-prompt.ps1"
  $output = & $sendScript `
    -TitleLike $wpsContext.name `
    -PromptPath $PromptFullPath `
    -SubmitMode Relay `
    -AfterPasteScreenshotPath $PromptFilledShot `
    -AfterSubmitScreenshotPath $PromptSubmittedShot `
    -PauseAfterPasteMs 1800 `
    -PauseAfterSubmitMs 1200
  foreach ($line in $output) {
    Add-Log ("SEND_OUTPUT {0}" -f $line)
  }
}

Set-TestStatus ("Prompt submitted; waiting up to {0}s for AI output..." -f $WaitSeconds) "blue"
$monitorStart = Get-Date
$deadline = $monitorStart.AddSeconds($WaitSeconds)
$lastLength = -1
$stableRounds = 0
$contentStarted = $false
$nextCaptureAt = Get-Date

while ((Get-Date) -lt $deadline) {
  $text = Get-DocumentText $wpsContext.doc
  $length = $text.Length
  $tables = Get-TableSummary $wpsContext.doc

  if ($length -ne $lastLength) {
    Add-Log ("DOC_PROGRESS chars={0} tables={1}" -f $length, $tables.count)
    $lastLength = $length
    $stableRounds = 0
  } elseif ($length -gt 30) {
    $stableRounds++
  }

  if ($length -gt 30) {
    $contentStarted = $true
  }

  Set-TestStatus ("Waiting... chars={0}, tables={1}" -f $length, $tables.count) "blue"

  if ((Get-Date) -ge $nextCaptureAt) {
    Save-CaptureFrame $wpsProcess ("output-{0}-chars-{1}-tables" -f $length, $tables.count)
    $nextCaptureAt = (Get-Date).AddSeconds([Math]::Max(1, $CaptureIntervalSeconds))
  }

  if ($contentStarted -and $stableRounds -ge 6) {
    break
  }

  Start-Sleep -Seconds 2
}

$finalText = Get-DocumentText $wpsContext.doc
$finalTables = Get-TableSummary $wpsContext.doc

if ($finalText.Length -le 30) {
  Save-Screenshot $wpsProcess $StuckShot
  Add-Log "NO_DOCUMENT_OUTPUT_AFTER_WAIT"
  Set-TestStatus "No document output detected; see log and screenshot." "red" $true
  throw "No WPS document output detected after waiting."
}

Set-TestStatus "Inspecting table, code highlight, headings, and body text..." "blue"
$formatStats = Get-FormatStats $wpsContext.doc
Save-Screenshot $wpsProcess $AfterShot

$tableOk = $false
if ($finalTables.count -ge 1) {
  $firstTable = $finalTables.items | Select-Object -First 1
  $tableOk = ($firstTable.rows -ge 4 -and $firstTable.cols -ge 3)
}

$summary = [pscustomobject]@{
  runId = $RunId
  runDir = $RunDir
  log = $LogPath
  document = $wpsContext.name
  chars = $finalText.Length
  tableCount = $finalTables.count
  tables = $finalTables.items
  checks = [pscustomobject]@{
    bodyText = ($finalText.Length -gt 200)
    headings = ($formatStats.headingLikeParagraphs -ge 2)
    quote = ($formatStats.quoteLikeParagraphs -ge 1)
    table = $tableOk
    codeFont = ($formatStats.codeFontChars -gt 0)
    codeColor = ($formatStats.coloredChars -gt 0)
    codeLineNumbers = ($formatStats.codeLineNumberParagraphs -ge 2)
    bold = ($formatStats.boldChars -gt 0)
    italic = ($formatStats.italicChars -gt 0)
  }
  formatStats = $formatStats
  screenshots = [pscustomobject]@{
    before = $BeforeShot
    promptFilled = $PromptFilledShot
    promptSubmitted = $PromptSubmittedShot
    after = $AfterShot
    stuck = $StuckShot
  }
}

[System.IO.File]::WriteAllText(
  $SummaryPath,
  ($summary | ConvertTo-Json -Depth 8),
  $Utf8NoBom
)

Add-Log ("SUMMARY={0}" -f $SummaryPath)
Add-Log ("FINAL_CHARS={0}" -f $summary.chars)
Add-Log ("FINAL_TABLES={0}" -f $summary.tableCount)
Add-Log ("CODE_FONT_CHARS={0}" -f $formatStats.codeFontChars)
Add-Log ("COLORED_CHARS={0}" -f $formatStats.coloredChars)
Add-Log ("HEADING_LIKE_PARAGRAPHS={0}" -f $formatStats.headingLikeParagraphs)
Add-Log ("QUOTE_LIKE_PARAGRAPHS={0}" -f $formatStats.quoteLikeParagraphs)
Add-Log ("CODE_LINE_NUMBER_PARAGRAPHS={0}" -f $formatStats.codeLineNumberParagraphs)

$failedChecks = @()
foreach ($property in $summary.checks.PSObject.Properties) {
  if ($property.Value -ne $true) {
    $failedChecks += $property.Name
  }
}

if ($failedChecks.Count -gt 0) {
  Add-Log ("CHECK_WARNINGS={0}" -f ($failedChecks -join ","))
  Set-TestStatus ("Finished with warnings: {0}" -f ($failedChecks -join ",")) "orange" $true
} else {
  Set-TestStatus "Finished: table, code, headings, and body checks passed." "green" $true
}

Write-Output ("RUN_DIR={0}" -f $RunDir)
Write-Output ("LOG={0}" -f $LogPath)
Write-Output ("SUMMARY={0}" -f $SummaryPath)
