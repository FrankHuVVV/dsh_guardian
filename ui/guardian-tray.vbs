' guardian-tray.vbs — 以无窗口方式启动托盘宿主（不闪黑框）
Option Explicit
Dim fso, sh, dir, ps
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
ps = dir & "\guardian-tray.ps1"
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & ps & Chr(34), 0, False
