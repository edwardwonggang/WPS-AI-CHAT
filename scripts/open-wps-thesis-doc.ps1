param(
  [string]$Path = "test-artifacts\novel-book\wps-thesis\yumuxia-de-chitongmen-master-thesis-format.docx"
)

$ErrorActionPreference = "Stop"
$resolved = Resolve-Path -LiteralPath $Path

$app = New-Object -ComObject KWPS.Application
$app.Visible = $true
$doc = $app.Documents.Open($resolved.Path)

try {
  $doc.Fields.Update() | Out-Null
} catch {
  Write-Host "WARN: Field update failed: $($_.Exception.Message)"
}

try {
  $doc.TablesOfContents.Item(1).Update() | Out-Null
} catch {
  Write-Host "WARN: TOC update failed: $($_.Exception.Message)"
}

$doc.Save()
Write-Host "WPS_DOC=$($resolved.Path)"
Write-Host "PAGES=$($doc.ComputeStatistics(2))"
Write-Host "WORDS=$($doc.ComputeStatistics(0))"
