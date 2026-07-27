<#
  chGPS one-shot launcher.

  Starts tunneld + bridge + dev server, then blocks. Every child is placed in a
  Windows Job Object created with KILL_ON_JOB_CLOSE, so the whole group dies
  with this process — Ctrl+C, closing the window, or being killed outright.
  Handler-based cleanup alone would not survive the window's X button.

  tunneld needs a TUN interface, so the script elevates itself if needed.
#>

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- Elevate ---------------------------------------------------------------

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "需要系統管理員權限（tunneld 要建立 TUN 介面），正在提升..." -ForegroundColor Yellow
    Start-Process -FilePath 'powershell.exe' `
        -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"" `
        -Verb RunAs
    exit
}

# --- Job Object ------------------------------------------------------------

if (-not ('ChGps.JobObject' -as [type])) {
    Add-Type -Language CSharp @'
using System;
using System.Runtime.InteropServices;

namespace ChGps {
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public Int64 PerProcessUserTimeLimit;
    public Int64 PerJobUserTimeLimit;
    public UInt32 LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public UInt32 ActiveProcessLimit;
    public UIntPtr Affinity;
    public UInt32 PriorityClass;
    public UInt32 SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS {
    public UInt64 ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public UInt64 ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  public static class JobObject {
    const UInt32 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const int JobObjectExtendedLimitInformation = 9;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr a, string lpName);

    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int infoType, IntPtr info, uint cbInfo);

    [DllImport("kernel32.dll")]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    static IntPtr _handle = IntPtr.Zero;

    /// Creates the job and marks it kill-on-close. Safe to call repeatedly.
    public static void Create() {
      if (_handle != IntPtr.Zero) return;
      _handle = CreateJobObject(IntPtr.Zero, null);

      var ext = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      ext.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

      int len = Marshal.SizeOf(ext);
      IntPtr ptr = Marshal.AllocHGlobal(len);
      try {
        Marshal.StructureToPtr(ext, ptr, false);
        if (!SetInformationJobObject(_handle, JobObjectExtendedLimitInformation, ptr, (uint)len))
          throw new Exception("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
      } finally {
        Marshal.FreeHGlobal(ptr);
      }
    }

    public static bool Add(IntPtr processHandle) {
      if (_handle == IntPtr.Zero) Create();
      return AssignProcessToJobObject(_handle, processHandle);
    }
  }
}
'@
}

[ChGps.JobObject]::Create()

# --- Helpers ---------------------------------------------------------------

$script:Children = @()

function Start-Child {
    param(
        [string]$Name,
        [string]$File,
        [string[]]$Args,
        [string]$LogSuffix
    )

    $log = Join-Path $env:TEMP "chgps-$LogSuffix.log"
    $err = Join-Path $env:TEMP "chgps-$LogSuffix.err"
    Remove-Item $log, $err -ErrorAction SilentlyContinue

    $p = Start-Process -FilePath $File -ArgumentList $Args `
        -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $log -RedirectStandardError $err

    if (-not [ChGps.JobObject]::Add($p.Handle)) {
        Write-Host "  ! 無法將 $Name 加入 job object，關閉視窗時可能殘留" -ForegroundColor Yellow
    }

    $script:Children += [pscustomobject]@{ Name = $Name; Process = $p; Log = $log; Err = $err }
    return $p
}

function Wait-Until {
    param([scriptblock]$Test, [int]$TimeoutSec = 60)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try { if (& $Test) { return $true } } catch { }
        Start-Sleep -Milliseconds 700
    }
    return $false
}

function Test-Http {
    param([string]$Url, [int]$TimeoutSec = 3)
    try {
        $null = Invoke-WebRequest -Uri $Url -TimeoutSec $TimeoutSec -UseBasicParsing
        return $true
    } catch {
        return $false
    }
}

function Clear-StrayProcesses {
    # A simulate-location process outlives a crashed bridge and keeps holding the
    # device, which makes the next run fail in confusing ways. Sweep first.
    $stray = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'pymobiledevice3.*simulate-location' }

    foreach ($s in $stray) {
        & taskkill /pid $s.ProcessId /T /F 2>&1 | Out-Null
    }
    return @($stray).Count
}

# --- Banner ----------------------------------------------------------------

Clear-Host
Write-Host ""
Write-Host "  chGPS " -ForegroundColor Cyan -NoNewline
Write-Host "— 地圖選點改 iPhone 定位"
Write-Host "  ────────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host ""

$swept = Clear-StrayProcesses
if ($swept -gt 0) {
    Write-Host "  清理殘留的 simulate-location 行程 x$swept（iPhone 定位已還原）" -ForegroundColor DarkGray
    Write-Host ""
}

# --- 1. tunneld ------------------------------------------------------------

Write-Host "  [1/3] RemoteXPC tunneld ..." -NoNewline
if (Test-Http 'http://127.0.0.1:49151/' 2) {
    Write-Host " 已在執行" -ForegroundColor DarkGray
} else {
    Start-Child -Name 'tunneld' -File 'python' `
        -Args @('-m', 'pymobiledevice3', 'remote', 'tunneld') -LogSuffix 'tunneld' | Out-Null

    if (Wait-Until { Test-Http 'http://127.0.0.1:49151/' 2 } 45) {
        Write-Host " OK" -ForegroundColor Green
    } else {
        Write-Host " 失敗" -ForegroundColor Red
        Write-Host "        看 $env:TEMP\chgps-tunneld.err" -ForegroundColor DarkGray
    }
}

# --- 2. bridge -------------------------------------------------------------

Write-Host "  [2/3] Bridge (:4000)     ..." -NoNewline
Start-Child -Name 'bridge' -File 'node' -Args @('server/index.js') -LogSuffix 'bridge' | Out-Null

if (Wait-Until { Test-Http 'http://127.0.0.1:4000/api/status' 20 } 45) {
    Write-Host " OK" -ForegroundColor Green
} else {
    Write-Host " 失敗" -ForegroundColor Red
    Write-Host "        看 $env:TEMP\chgps-bridge.err" -ForegroundColor DarkGray
}

# --- 3. dev server ---------------------------------------------------------

Write-Host "  [3/3] Web UI (:3000)     ..." -NoNewline
Start-Child -Name 'vite' -File 'npm.cmd' -Args @('run', 'dev') -LogSuffix 'vite' | Out-Null

if (Wait-Until { Test-Http 'http://127.0.0.1:3000/' 3 } 60) {
    Write-Host " OK" -ForegroundColor Green
} else {
    Write-Host " 失敗" -ForegroundColor Red
    Write-Host "        看 $env:TEMP\chgps-vite.err" -ForegroundColor DarkGray
}

# --- Device summary --------------------------------------------------------

Write-Host ""
try {
    $st = Invoke-RestMethod -Uri 'http://127.0.0.1:4000/api/status?fresh=1' -TimeoutSec 90
    if ($st.connected) {
        Write-Host "  裝置  " -NoNewline -ForegroundColor DarkGray
        Write-Host "$($st.device.name) · $($st.device.model) · iOS $($st.device.iosVersion)"
        if ($st.ready) {
            Write-Host "  狀態  " -NoNewline -ForegroundColor DarkGray
            Write-Host "就緒，可傳送定位" -ForegroundColor Green
        } else {
            Write-Host "  狀態  " -NoNewline -ForegroundColor DarkGray
            Write-Host "尚未就緒" -ForegroundColor Yellow
            foreach ($b in $st.blockers) { Write-Host "        - $($b.message)" -ForegroundColor Yellow }
        }
    } else {
        Write-Host "  裝置  " -NoNewline -ForegroundColor DarkGray
        Write-Host "未偵測到 iPhone（請接上 USB 並解鎖）" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  裝置  無法查詢狀態" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  ────────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host "  http://localhost:3000" -ForegroundColor Cyan
Write-Host ""
Write-Host "  關閉此視窗或按 Ctrl+C 會停止所有服務" -ForegroundColor DarkGray
Write-Host ""

Start-Process 'http://localhost:3000' | Out-Null

# --- Supervise -------------------------------------------------------------
# Job Object handles teardown; this loop only reports a child dying early.

try {
    while ($true) {
        Start-Sleep -Seconds 3
        foreach ($c in $script:Children) {
            if ($c.Process.HasExited -and -not $c.PSObject.Properties['Reported']) {
                Add-Member -InputObject $c -NotePropertyName Reported -NotePropertyValue $true
                Write-Host "  ! $($c.Name) 已結束 (exit $($c.Process.ExitCode)) — 見 $($c.Err)" -ForegroundColor Red
            }
        }
    }
} finally {
    Write-Host ""
    Write-Host "  停止中..." -ForegroundColor DarkGray
    # Redundant with the Job Object, but makes Ctrl+C teardown immediate.
    foreach ($c in $script:Children) {
        if (-not $c.Process.HasExited) {
            & taskkill /pid $c.Process.Id /T /F 2>&1 | Out-Null
        }
    }
}
