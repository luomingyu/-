' ============================================================
'  月度排课系统 · 隐藏窗口启动器（供计划任务调用）
'  从自身路径推导项目目录，避免硬编码路径
' ============================================================
Option Explicit
Dim fso, here, shell
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.Run """" & here & "\start-server.bat""", 0, False
