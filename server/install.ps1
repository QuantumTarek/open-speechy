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
# Skip local dev artifacts: a .venv from the source checkout would otherwise be
# copied over and reused by uv sync.
$Skip = @(".venv", "__pycache__", ".pytest_cache", ".ruff_cache", "tests")
Get-ChildItem -Path $SourceDir -Force |
  Where-Object { $Skip -notcontains $_.Name -and $_.Name -notlike "*.egg-info" } |
  Copy-Item -Destination $ServerDir -Recurse -Force

& $Uv.Source sync --project $ServerDir --python 3.11 --no-dev --extra engines
if ($LASTEXITCODE -ne 0) { throw "uv sync failed." }

$env:OPEN_SPEECHY_TOKEN_FILE = Join-Path $BaseDir "token"
& $Uv.Source run --project $ServerDir python (Join-Path $ServerDir "auth.py") | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not create the local token." }

# The native messaging host lets the extension connect without a pairing code
# and start or stop the server.
& $Uv.Source run --project $ServerDir python (Join-Path $ServerDir "native_host_manifest.py") install $BaseDir | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not register the extension helper." }

$Arguments = "run --project `"$ServerDir`" python -m server.app"
$Action = New-ScheduledTaskAction -Execute $Uv.Source `
  -Argument $Arguments -WorkingDirectory $BaseDir
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "Open Speechy Local Server" `
  -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null
# Stopping the server from the extension disables the task.
Enable-ScheduledTask -TaskName "Open Speechy Local Server" | Out-Null
Start-ScheduledTask -TaskName "Open Speechy Local Server"

Write-Output "Open Speechy server installed. Reload the extension; it connects on its own."
Write-Output "In other browsers, pair at http://127.0.0.1:5123/pair"
