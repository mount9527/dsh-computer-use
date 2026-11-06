# dsh-computer-use - emergency stop watcher
#
# A tiny resident helper whose only jobs are: notice the Esc key, write the stop marker the
# plugin and desk.ps1 both check, and leave evidence (last-Esc stamp, heartbeat, error log).
#
# Why polling GetAsyncKeyState instead of a keyboard hook or RegisterHotKey:
#   - RegisterHotKey with a bare Esc would STEAL Esc from every application.
#   - A low-level hook (WH_KEYBOARD_LL) is heavier and looks like a keylogger to security
#     software.
#   - GetAsyncKeyState reads the physical key state, needs no hook, and never consumes the
#     key: Esc keeps working in every app, and this process can only *observe* it.
#
# "Armed" means the plugin did something in the last 20 seconds (activity stamp). An Esc
# pressed while nothing is running still records a last-Esc stamp (so the user can see the
# key is detected) but does not block anything.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less .ps1 files as ANSI.
param(
  [Parameter(Mandatory = $true)][string]$StopFile,
  [Parameter(Mandatory = $true)][string]$ActivityFile,
  [string]$LastEscFile,
  [string]$HeartbeatFile,
  [string]$LogFile,
  [int]$PollMs = 60,
  [int]$MaxMinutes = 240,
  [int]$ArmedWindowMs = 20000,
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

$cs = @'
using System;
using System.Runtime.InteropServices;
public static class CuStopKey {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  public static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }
}
'@
if (-not ('CuStopKey' -as [type])) { Add-Type -TypeDefinition $cs }

$VK_ESCAPE = 0x1B
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-JsonFile([string]$path, [string]$json) {
  if ([string]::IsNullOrWhiteSpace($path)) { return }
  try { [System.IO.File]::WriteAllText($path, $json, $utf8) } catch { }
}

function Write-StopMarker([bool]$armed) {
  $payload = @{
    at     = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    source = 'esc'
    armed  = $armed
    pid    = $PID
  } | ConvertTo-Json -Compress
  Write-JsonFile $StopFile $payload
  if ($LastEscFile) { Write-JsonFile $LastEscFile $payload }
}

function Touch-Heartbeat {
  if ($HeartbeatFile) { Write-JsonFile $HeartbeatFile ([DateTimeOffset]::Now.ToUnixTimeMilliseconds().ToString()) }
}

if ($SelfTest) {
  Write-StopMarker $true
  Touch-Heartbeat
  exit 0
}

$deadline = [DateTimeOffset]::Now.AddMinutes($MaxMinutes).ToUnixTimeMilliseconds()
$wasDown = $false
$lastBeat = 0

try {
  while ($true) {
    Start-Sleep -Milliseconds $PollMs
    $nowMs = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    if ($nowMs -gt $deadline) { break }
    if ($nowMs - $lastBeat -gt 2000) { Touch-Heartbeat; $lastBeat = $nowMs }

    # How long ago did the plugin do something? desk.ps1 touches the stamp while it works,
    # so a long single operation stays armed.
    $activityAge = [int64]::MaxValue
    try {
      if (Test-Path -LiteralPath $ActivityFile) {
        $stamp = [System.IO.File]::ReadAllText($ActivityFile)
        $ts = [int64]0
        if ([int64]::TryParse($stamp.Trim(), [ref]$ts)) { $activityAge = $nowMs - $ts }
      }
    } catch { }
    $armed = $activityAge -lt $ArmedWindowMs

    # Edge-triggered: one marker per press, so holding Esc does not spam the file.
    $down = [CuStopKey]::Down($VK_ESCAPE)
    if ($down -and -not $wasDown) { Write-StopMarker $armed }
    $wasDown = $down
  }
} catch {
  if ($LogFile) {
    try {
      [System.IO.File]::AppendAllText($LogFile,
        ("{0} stop-watch failed: {1}`r`n" -f (Get-Date -Format s), $_.Exception.Message), $utf8)
    } catch { }
  }
  exit 1
}
