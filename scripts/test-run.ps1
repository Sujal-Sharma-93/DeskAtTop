<#
  Reusable DeskAtTop smoke test.

  1. Kill leftovers and free port 5183.
  2. Start `npm run tauri dev` with cargo on PATH (no remote-debugging args).
  3. Wait for desk-at-top.exe and the overlay window (15 s by default).
  4. Ping every DeskAtTop window (WM_NULL / SMTO_ABORTIFHUNG); fail on HUNG.
  5. Fail if the overlay webview never rendered its content (about:blank).
  6. Optionally open the settings window (tray menu) first.
  7. Quit through the real tray "Quit DeskAtTop" item.
  8. Confirm desk-at-top.exe is gone and port 5183 is free.
  9. Print exactly one PASS/FAIL line.
#>
[CmdletBinding()]
param(
  [int]$StartupTimeoutSec = 15,
  [switch]$OpenSettings,
  [int]$RunNumber = 0
)

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$port = 5183
$logOut = Join-Path $env:TEMP 'deskattop-test-out.log'
$logErr = Join-Path $env:TEMP 'deskattop-test-err.log'
$pidFile = Join-Path $env:TEMP 'deskattop-test-launcher.pid'
$fail = $null

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class WinInfo {
  public IntPtr Hwnd;
  public string Title = "";
  public string Class = "";
  public uint Pid;
}

public static class W {
  delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SendMessageTimeoutW(IntPtr h, uint msg, UIntPtr wp, IntPtr lp, uint flags, uint timeout, out UIntPtr res);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtrW(IntPtr h, int idx);

  public static List<WinInfo> TopWindows() {
    var list = new List<WinInfo>();
    EnumWindows((h, l) => {
      var t = new StringBuilder(512); GetWindowTextW(h, t, t.Capacity);
      var c = new StringBuilder(256); GetClassNameW(h, c, c.Capacity);
      uint pid; GetWindowThreadProcessId(h, out pid);
      list.Add(new WinInfo { Hwnd = h, Title = t.ToString(), Class = c.ToString(), Pid = pid });
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static bool IsHung(IntPtr h, uint timeoutMs) {
    UIntPtr res;
    IntPtr r = SendMessageTimeoutW(h, 0, UIntPtr.Zero, IntPtr.Zero, 0x0002, timeoutMs, out res);
    return r == IntPtr.Zero;
  }
}
'@

function Test-PortFree {
  return -not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Stop-Leftovers {
  if (Test-Path -LiteralPath $pidFile) {
    $old = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue
    if ($old) { & taskkill.exe /PID $old /T /F 2>$null | Out-Null }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  }
  Get-Process desk-at-top -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine -like '*DeskAtTop*' -or $_.CommandLine -like '*tauri*dev*') } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  foreach ($c in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
  }
  for ($i = 0; $i -lt 50 -and -not (Test-PortFree); $i++) { Start-Sleep -Milliseconds 100 }
  # Anything still parked on the dev port would make the next launch fail.
  foreach ($c in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
    & taskkill.exe /PID $c.OwningProcess /T /F 2>$null | Out-Null
  }
  Get-Process desk-at-top -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

function Get-DeskWindows {
  $procs = @(Get-Process desk-at-top -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  return @([W]::TopWindows() | Where-Object {
    ($_.Title -like 'DeskAtTop*') -or ($_.Class -eq 'tray_icon_app') -or ($procs -contains [int]$_.Pid)
  })
}

function Get-OverlayWindow {
  return [W]::TopWindows() | Where-Object { $_.Title -eq 'DeskAtTop' -and $_.Class -eq 'Tauri Window' } | Select-Object -First 1
}

function Test-OverlayRendered {
  param([IntPtr]$Hwnd, [int]$TimeoutSec = 8)
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, 'Quick Launch')
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd)
      if ($root) {
        $found = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
        if ($found) { return $true }
      }
    } catch { }
    Start-Sleep -Milliseconds 400
  }
  return $false
}

function Invoke-TrayItem {
  param([string]$Item, [string]$Keys)
  $tray = [W]::TopWindows() | Where-Object { $_.Class -eq 'tray_icon_app' } | Select-Object -First 1
  if (-not $tray) { return 'tray window not found' }
  [void][W]::PostMessageW($tray.Hwnd, 0x0205, [IntPtr]::Zero, [IntPtr]::Zero)  # WM_RBUTTONUP
  $deadline = (Get-Date).AddSeconds(3)
  $menu = $null
  while ((Get-Date) -lt $deadline -and -not $menu) {
    $menu = [W]::TopWindows() | Where-Object { $_.Class -eq '#32768' } | Select-Object -First 1
    if (-not $menu) { Start-Sleep -Milliseconds 150 }
  }
  if (-not $menu) { return 'tray menu did not open' }
  Start-Sleep -Milliseconds 250
  [System.Windows.Forms.SendKeys]::SendWait($Keys)
  return $null
}

# ------------------------------------------------------------------ run
if ($RunNumber -lt 0) { $RunNumber = 0 }
Stop-Leftovers
if (-not (Test-PortFree)) { $fail = 'port 5183 still busy after cleanup' }

$launcher = $null
if (-not $fail) {
  $env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
  Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $logOut, $logErr -Force -ErrorAction SilentlyContinue
  $launcher = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm run tauri dev' `
    -WorkingDirectory $repo -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $logOut -RedirectStandardError $logErr
  $launcher.Id | Set-Content -LiteralPath $pidFile
}

$overlay = $null
if (-not $fail) {
  $deadline = (Get-Date).AddSeconds($StartupTimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $proc = Get-Process desk-at-top -ErrorAction SilentlyContinue
    $overlay = Get-OverlayWindow
    if ($proc -and $overlay) { break }
    if ($launcher -and $launcher.HasExited) { break }
    Start-Sleep -Milliseconds 300
  }
  if (-not $overlay) { $fail = "overlay window not found within ${StartupTimeoutSec}s" }
  elseif (-not (Get-Process desk-at-top -ErrorAction SilentlyContinue)) { $fail = 'desk-at-top.exe is not running' }
}

$hung = @()
if (-not $fail) {
  $wins = @(Get-DeskWindows)
  foreach ($w in $wins) {
    if ([W]::IsHung($w.Hwnd, 1500)) { $hung += "$($w.Class)/$($w.Title)" }
  }
  if ($hung.Count -gt 0) { $fail = 'HUNG: ' + ($hung -join ', ') }
}

if (-not $fail) {
  if (-not (Test-OverlayRendered -Hwnd $overlay.Hwnd)) {
    $fail = 'overlay webview has no content (about:blank / not rendered)'
  }
}

if (-not $fail) {
  $settingsFile = Join-Path $env:APPDATA 'com.deskattop.desk\settings.json'
  $deadline = (Get-Date).AddSeconds(5)
  $items = @()
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $settingsFile) {
      try {
        $saved = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json
        $box = @($saved.settings.boxes) | Where-Object { $_.title -eq 'Quick Launch' } | Select-Object -First 1
        $items = @($box.items)
        if ($items.Count -eq 3) { break }
      } catch { }
    }
    Start-Sleep -Milliseconds 250
  }
  $labels = ($items | ForEach-Object { $_.label }) -join ','
  if ($items.Count -ne 3) { $fail = "settings.json Quick Launch has $($items.Count) item(s) [$labels]" }
}

if (-not $fail -and $OpenSettings) {
  $err = Invoke-TrayItem -Item 'Open Settings' -Keys '{HOME}{ENTER}'
  if ($err) { $fail = $err }
  else {
    $deadline = (Get-Date).AddSeconds(5)
    $shown = $false
    while ((Get-Date) -lt $deadline -and -not $shown) {
      $sw = [W]::TopWindows() | Where-Object { $_.Title -eq 'DeskAtTop Settings' } | Select-Object -First 1
      if ($sw -and [W]::IsWindowVisible($sw.Hwnd)) { $shown = $true } else { Start-Sleep -Milliseconds 200 }
    }
    if (-not $shown) { $fail = 'settings window did not open' }
  }
}

if (-not $fail) {
  $err = Invoke-TrayItem -Item 'Quit DeskAtTop' -Keys '{END}{ENTER}'
  if ($err) { $fail = $err }
  else {
    $deadline = (Get-Date).AddSeconds(12)
    while ((Get-Date) -lt $deadline -and (Get-Process desk-at-top -ErrorAction SilentlyContinue)) {
      Start-Sleep -Milliseconds 250
    }
    if (Get-Process desk-at-top -ErrorAction SilentlyContinue) { $fail = 'desk-at-top.exe still running after tray Quit' }
    elseif (-not (Test-PortFree)) {
      $deadline = (Get-Date).AddSeconds(10)
      while ((Get-Date) -lt $deadline -and -not (Test-PortFree)) { Start-Sleep -Milliseconds 250 }
      if (-not (Test-PortFree)) { $fail = 'port 5183 still in use after Quit' }
    }
  }
}

# Final cleanup so the next run starts from a clean slate (does not affect the
# PASS/FAIL decision above).
if ($launcher) {
  & taskkill.exe /PID $launcher.Id /T /F 2>$null | Out-Null
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}
Get-Process desk-at-top -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
foreach ($c in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
  & taskkill.exe /PID $c.OwningProcess /T /F 2>$null | Out-Null
}

if ($fail) {
  Write-Output "FAIL run $RunNumber : $fail"
  $tail = @()
  if (Test-Path -LiteralPath $logErr) { $tail += (Get-Content -LiteralPath $logErr -Tail 5) }
  if ($tail.Count -gt 0) { Write-Output ('  log: ' + (($tail | Where-Object { $_ }) -join ' | ')) }
  exit 1
} else {
  Write-Output "PASS run $RunNumber"
  exit 0
}
