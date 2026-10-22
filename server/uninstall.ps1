$ErrorActionPreference = "Stop"
$TaskName = "Open Speechy Local Server"
$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($Task) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Write-Output "The scheduled task was removed. Local files in ~/.open-speechy were left in place."
