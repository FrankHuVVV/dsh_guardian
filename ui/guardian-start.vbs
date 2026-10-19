' guardian-start.vbs — 在独立隐藏进程中拉起后端（关闭控制台窗口不影响它）
Option Explicit
Dim fso, sh, dir, ps
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
ps = dir & "\guardian-start-backend.ps1"
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & ps & Chr(34), 0, False
