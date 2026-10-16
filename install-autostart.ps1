# ============================================================
#  One-time installer: register the field-demo LAN scheduling
#  server to auto-start at user logon.
#
#  Creates a shortcut in the current user's Startup folder that
#  runs wscript.exe -> start-server-hidden.vbs (hidden window)
#  -> start-server.bat -> node server/index.mjs
#
#  Run: install-autostart.bat  (or right-click -> Run with PowerShell)
# ============================================================
$ErrorActionPreference = 'Stop'

$projectRoot = $PSScriptRoot
$vbsPath = Join-Path $projectRoot 'start-server-hidden.vbs'
if (-not (Test-Path $vbsPath)) {
    Write-Host "ERROR: start-server-hidden.vbs not found in $projectRoot" -ForegroundColor Red
    exit 1
}

$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'FieldDemoScheduleServer.lnk'

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = 'wscript.exe'
$sc.Arguments = '"' + $vbsPath + '"'
$sc.WorkingDirectory = $projectRoot
$sc.Description = 'Field-demo LAN scheduling server (auto start at logon)'
$sc.Save()

Write-Host '[OK] Auto-start installed:' -ForegroundColor Green
Write-Host "  $lnk" -ForegroundColor Cyan
Write-Host 'The server will start automatically (hidden window) next time you log in to Windows.' -ForegroundColor Green
Write-Host 'To uninstall later: delete that shortcut file.' -ForegroundColor Yellow
