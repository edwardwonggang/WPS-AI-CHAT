param(
  [Parameter(Mandatory = $true)]
  [string]$StatusPath,
  [int]$RefreshMs = 400
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Get-StatusColor($name) {
  switch ($name) {
    "green" { return [System.Drawing.Color]::FromArgb(28, 122, 72) }
    "orange" { return [System.Drawing.Color]::FromArgb(190, 103, 12) }
    "red" { return [System.Drawing.Color]::FromArgb(176, 32, 32) }
    "gray" { return [System.Drawing.Color]::FromArgb(82, 91, 107) }
    default { return [System.Drawing.Color]::FromArgb(0, 102, 204) }
  }
}

function Read-Status {
  if (-not (Test-Path -LiteralPath $StatusPath)) {
    return [pscustomobject]@{
      title = "WPS AI UI Test"
      message = "Starting..."
      color = "blue"
      done = $false
    }
  }

  try {
    $json = [System.IO.File]::ReadAllText($StatusPath, [System.Text.Encoding]::UTF8)
    return $json | ConvertFrom-Json
  } catch {
    return [pscustomobject]@{
      title = "WPS AI UI Test"
      message = "Reading status..."
      color = "gray"
      done = $false
    }
  }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "WPS AI UI Test"
$form.Width = 420
$form.Height = 128
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Left = $screen.Left + 24
$form.Top = $screen.Top + 72

$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Left = 18
$titleLabel.Top = 14
$titleLabel.Width = 370
$titleLabel.Height = 24
$titleLabel.Font = New-Object System.Drawing.Font("Segoe UI", 12, [System.Drawing.FontStyle]::Bold)
$titleLabel.ForeColor = [System.Drawing.Color]::White

$messageLabel = New-Object System.Windows.Forms.Label
$messageLabel.Left = 18
$messageLabel.Top = 45
$messageLabel.Width = 370
$messageLabel.Height = 48
$messageLabel.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$messageLabel.ForeColor = [System.Drawing.Color]::White

$form.Controls.Add($titleLabel)
$form.Controls.Add($messageLabel)

$closeAt = $null
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(200, $RefreshMs)
$timer.Add_Tick({
  $status = Read-Status
  $nextTitle = [string]$status.title
  if ([string]::IsNullOrWhiteSpace($nextTitle)) {
    $nextTitle = "WPS AI UI Test"
  }

  $nextMessage = [string]$status.message
  $nextColor = [string]$status.color
  if ([string]::IsNullOrWhiteSpace($nextColor)) {
    $nextColor = "blue"
  }

  $titleLabel.Text = $nextTitle
  $messageLabel.Text = $nextMessage
  $form.BackColor = Get-StatusColor $nextColor

  if ($status.done -eq $true) {
    if ($null -eq $script:closeAt) {
      $script:closeAt = (Get-Date).AddSeconds(4)
    } elseif ((Get-Date) -ge $script:closeAt) {
      $timer.Stop()
      $form.Close()
    }
  } else {
    $script:closeAt = $null
  }
})

$timer.Start()
[System.Windows.Forms.Application]::Run($form)
