param(
  [string]$DocumentName = ""
)

$ErrorActionPreference = "Stop"

try {
  $app = [System.Runtime.InteropServices.Marshal]::GetActiveObject("kwps.Application")
} catch {
  $app = New-Object -ComObject kwps.Application
}

$doc = $null

if (-not [string]::IsNullOrWhiteSpace($DocumentName)) {
  for ($i = 1; $i -le $app.Documents.Count; $i++) {
    $candidate = $app.Documents.Item($i)
    if ([string]$candidate.Name -like "*$DocumentName*") {
      $doc = $candidate
      break
    }
  }
}

if (-not $doc) {
  $doc = $app.ActiveDocument
}

if (-not $doc) {
  throw "No active WPS Writer document."
}

Write-Output ("DOCNAME=" + $doc.Name)

$tableCount = 0
try {
  $tableCount = $doc.Tables.Count
} catch {
  $tableCount = 0
}

Write-Output ("TABLES=" + $tableCount)

if ($tableCount -gt 0) {
  $table = $doc.Tables.Item(1)
  Write-Output ("ROWS=" + $table.Rows.Count)
  Write-Output ("COLS=" + $table.Columns.Count)

  for ($r = 1; $r -le $table.Rows.Count; $r++) {
    for ($c = 1; $c -le $table.Columns.Count; $c++) {
      $text = $table.Cell($r, $c).Range.Text
      Write-Output ("CELL[$r,$c]=" + $text)
    }
  }
}

Write-Output ("TEXT=" + $doc.Content.Text)
