# install-task.ps1 — register the "dustin.space now-imaging" Scheduled Task on the MeLe.
#
# Run once, as the user NINA runs under, from the now-imaging folder:
#   powershell -ExecutionPolicy Bypass -File .\install-task.ps1
#
# What it does, in plain terms:
#   * trigger: at system startup (and immediately, via Start-ScheduledTask below)
#   * action:  node agent.js in this folder
#   * runs whether the user is logged on or not (NINA starts at logon; the
#     agent's first checks simply no-op until NINA answers on port 1888)
#   * restarts itself every minute if it exits, up to 999 times, with no run-time
#     limit: the agent never exits on purpose, so an exit means a crash worth retrying
#
# Why a Scheduled Task and not a Windows Service: a task needs no service wrapper
# (no NSSM, no extra install), can be inspected with `schtasks /query`, and is
# the same mechanism ASCOM already uses on this machine. Why S4U logon: it runs
# without storing the account password and without an interactive session; the
# agent only needs the network and this folder.
#
# Re-running this script replaces the task in place (-Force).

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node -ErrorAction Stop).Source

$action    = New-ScheduledTaskAction -Execute $node -Argument "agent.js" -WorkingDirectory $here
$trigger   = New-ScheduledTaskTrigger -AtStartup
$settings  = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
	-ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited

Register-ScheduledTask -TaskName "dustin.space now-imaging" -Action $action -Trigger $trigger `
	-Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName "dustin.space now-imaging"

Write-Host "Registered and started. Check: schtasks /query /tn `"dustin.space now-imaging`" /v"
