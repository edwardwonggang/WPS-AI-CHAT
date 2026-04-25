$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $projectRoot "package.json"
$buildDir = Join-Path $projectRoot "dist"
$addonRoot = Join-Path $env:APPDATA "kingsoft\wps\jsaddons"
$runKeyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runValueName = "WPS AI Relay"
$runVbsPath = Join-Path $PSScriptRoot "run-relay-hidden.vbs"
$runVbsContent = @'
Set shell = CreateObject("WScript.Shell")

Dim fso
Dim scriptDir
Dim relayScript
Dim command

Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
relayScript = fso.BuildPath(scriptDir, "start-relay.ps1")
command = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & relayScript & """"

shell.Run command, 0, False
'@

if (!(Test-Path $packageJsonPath)) {
  throw "package.json not found."
}

if (!(Test-Path $buildDir)) {
  throw "dist not found. Run the build step first."
}

$package = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
$addonName = [string]$package.name
$addonType = [string]$package.addonType
$addonVersion = [string]$package.version
$offlineFolderName = "${addonName}_${addonVersion}"
$offlineTarget = Join-Path $addonRoot $offlineFolderName
$publishXmlPath = Join-Path $addonRoot "publish.xml"

New-Item -ItemType Directory -Path $addonRoot -Force | Out-Null
Get-ChildItem -Path $addonRoot -Directory -Filter "${addonName}_*" -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item $buildDir $offlineTarget -Recurse -Force
Set-Content -Path $runVbsPath -Value $runVbsContent -Encoding ASCII

[xml]$xml = if (Test-Path $publishXmlPath) {
  Get-Content $publishXmlPath -Raw
} else {
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><jsplugins />'
}

if (-not $xml.DocumentElement) {
  $xml.LoadXml('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><jsplugins />')
}

$root = $xml.DocumentElement

$nodesToRemove = @()
foreach ($node in $root.ChildNodes) {
  if ($node.NodeType -ne [System.Xml.XmlNodeType]::Element) {
    continue
  }

  if ($node.Attributes["name"] -and $node.Attributes["name"].Value -eq $addonName) {
    $nodesToRemove += $node
  }
}

foreach ($node in $nodesToRemove) {
  $root.RemoveChild($node) | Out-Null
}

$pluginNode = $xml.CreateElement("jsplugin")
$pluginNode.SetAttribute("name", $addonName)
$pluginNode.SetAttribute("type", $addonType)
$pluginNode.SetAttribute("url", $offlineFolderName)
$pluginNode.SetAttribute("version", $addonVersion)
$pluginNode.SetAttribute("enable", "enable_dev")
$pluginNode.SetAttribute("install", "null")
$pluginNode.SetAttribute("customDomain", "")
$root.AppendChild($pluginNode) | Out-Null

$settings = New-Object System.Xml.XmlWriterSettings
$settings.Indent = $true
$settings.Encoding = New-Object System.Text.UTF8Encoding($false)
$writer = [System.Xml.XmlWriter]::Create($publishXmlPath, $settings)
$xml.Save($writer)
$writer.Close()

New-Item -Path $runKeyPath -Force | Out-Null
Set-ItemProperty -Path $runKeyPath -Name $runValueName -Value "wscript.exe `"$runVbsPath`""

& powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "start-relay.ps1") -ForceRestart

Write-Output "Installed addon to $offlineTarget"
Write-Output "Updated publish.xml at $publishXmlPath"
Write-Output "Registered relay auto-start in $runKeyPath"
