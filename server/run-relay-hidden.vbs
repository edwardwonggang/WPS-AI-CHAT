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
