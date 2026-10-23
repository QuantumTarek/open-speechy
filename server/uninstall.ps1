$ErrorActionPreference = "Stop"
$TaskName = "Open Speechy Local Server"
$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($Task) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$BaseDir = Join-Path $env:USERPROFILE ".open-speechy"
$Registrar = Join-Path $BaseDir "server\native_host_manifest.py"
$Python = Join-Path $BaseDir "server\.venv\Scripts\python.exe"
if ((Test-Path $Registrar) -and (Test-Path $Python)) {
  & $Python $Registrar uninstall $BaseDir | Out-Null
}

Write-Output "The scheduled task and extension helper were removed. Local files in ~/.open-speechy were left in place."
