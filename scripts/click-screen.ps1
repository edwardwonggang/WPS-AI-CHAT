param(
  [Parameter(Mandatory = $true)]
  [int]$X,
  [Parameter(Mandatory = $true)]
  [int]$Y
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class MouseOps {
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int x, int y);

  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@

$MOUSEEVENTF_LEFTDOWN = 0x0002
$MOUSEEVENTF_LEFTUP = 0x0004

[MouseOps]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 120
[MouseOps]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 80
[MouseOps]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)

Write-Output ("CLICKED=" + $X + "," + $Y)
