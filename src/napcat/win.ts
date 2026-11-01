/**
 * QQ 那个多余的控制台窗口。
 *
 * 背景：NapCatWinBootMain.exe 启动 QQ.exe 时没加 CREATE_NO_WINDOW，
 * QQ 就继承到一个控制台（类名 ConsoleWindowClass，标题是 QQ.exe 的路径）。
 * Node 的 windowsHide: true 只作用于**直接子进程**，管不到孙进程（QQ）。
 *
 * 所以只能事后用 Win32 的 ShowWindow 把它藏起来。
 * 注意：被 SW_HIDE 之后 Process.MainWindowHandle 会变成 0，
 * 想恢复必须用 EnumWindows 重新枚举 —— 这就是下面这个脚本存在的原因。
 */
import { execFile } from 'node:child_process'
import { writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PS = String.raw`
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class QQWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);

  public static List<IntPtr> Find(uint pid) {
    var res = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid) res.Add(h);
      return true;
    }, IntPtr.Zero);
    return res;
  }

  // 只看"控制台"类，并且要求可见性符合预期 ——
  // QQ 内部有好几个隐藏的控制台，把它们也算进来的话计数就没意义了。
  //
  // 三种类名：ConsoleWindowClass（传统 conhost）、
  // CASCADIA_HOSTING_WINDOW_CLASS（Windows Terminal）、PseudoConsoleWindow（ConPTY）
  public static bool Match(IntPtr h, bool wantVisible) {
    var c = new StringBuilder(256); GetClassName(h, c, 256);
    var cls = c.ToString();
    if (cls != "ConsoleWindowClass" && cls != "CASCADIA_HOSTING_WINDOW_CLASS" && cls != "PseudoConsoleWindow") return false;
    return IsWindowVisible(h) == wantVisible;
  }
}
"@

$mode = $args[0]
$n = 0
# QQ 会被 NapCatWinBootMain 带出一个控制台；NapCatWinBootMain 自己是控制台程序，
# 也会自己弹一个。两个都要藏 —— 只说"启动是无窗口的"就该真的没窗口。
foreach ($proc in @(Get-Process QQ, NapCatWinBootMain -ErrorAction SilentlyContinue)) {
  foreach ($h in [QQWin]::Find($proc.Id)) {
    if ($mode -eq 'hide') {
      if ([QQWin]::Match($h, $true)) { [QQWin]::ShowWindow($h, 0) | Out-Null; $n++ }
    } elseif ($mode -eq 'show') {
      if ([QQWin]::Match($h, $false)) { [QQWin]::ShowWindow($h, 9) | Out-Null; $n++ }
    } elseif ($mode -eq 'count') {
      if ([QQWin]::Match($h, $true)) { $n++ }
    }
  }
}
Write-Output "$n"
`

let scriptPath = ''

/** 把脚本落到临时目录（打包后进程读不了 asar 里的文件，写临时文件最稳） */
function ensureScript(): string {
  if (scriptPath && existsSync(scriptPath)) return scriptPath
  scriptPath = join(tmpdir(), 'qqbot-qq-window.ps1')
  writeFileSync(scriptPath, '\ufeff' + PS, 'utf8')
  return scriptPath
}

function run(mode: 'hide' | 'show' | 'count'): Promise<number> {
  return new Promise((resolve) => {
    try {
      execFile(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ensureScript(), mode],
        { timeout: 20_000 },
        (_err, stdout) => {
          const n = Number(String(stdout).trim())
          resolve(Number.isFinite(n) ? n : 0)
        },
      )
    } catch {
      resolve(0)
    }
  })
}

/** 藏掉那个多出来的 QQ 控制台。返回**实际藏了几个可见的** */
export async function hideQqConsole(): Promise<number> {
  return run('hide')
}


