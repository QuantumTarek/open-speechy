$ErrorActionPreference = "Stop"

$SourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BaseDir = Join-Path $env:USERPROFILE ".open-speechy"
$ServerDir = Join-Path $BaseDir "server"
$Uv = Get-Command uv -ErrorAction SilentlyContinue

if (-not $Uv) {
  throw "Install uv first: https://docs.astral.sh/uv/getting-started/installation/"
}

New-Item -ItemType Directory -Force -Path $BaseDir | Out-Null
New-Item -ItemType Directory -Force -Path $ServerDir | Out-Null
Copy-Item -Path (Join-Path $SourceDir "*") -Destination $ServerDir -Recurse -Force

& $Uv.Source sync --project $ServerDir --no-dev
if ($LASTEXITCODE -ne 0) { throw "uv sync failed." }

$env:OPEN_SPEECHY_TOKEN_FILE = Join-Path $BaseDir "token"
& $Uv.Source run --project $ServerDir python (Join-Path $ServerDir "auth.py") | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not create the local token." }

$Arguments = "run --project `"$ServerDir`" python -m server.app"
$Action = New-ScheduledTaskAction -Execute $Uv.Source `
  -Argument $Arguments -WorkingDirectory $BaseDir
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "Open Speechy Local Server" `
  -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null
Start-ScheduledTask -TaskName "Open Speechy Local Server"

Write-Output "Open Speechy server installed. Pair it at http://127.0.0.1:5123/pair"
