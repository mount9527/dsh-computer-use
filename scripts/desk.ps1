# dsh-computer-use - Windows desktop executor
# Called by the (unsandboxed, normal-integrity) Host plugin: one process, one verb,
# one JSON input file, one JSON output file.
# Contract: always write $OutFile as { ok: bool, data?: object, error?: string, hints?: [] }.
# This file is deliberately ASCII-only: Windows PowerShell 5.1 reads BOM-less .ps1
# as ANSI, so any non-ASCII byte here would corrupt parsing. All user-facing text is
# supplied by the Node side inside the JSON payload.
param(
  [Parameter(Mandatory = $true)][string]$Verb,
  [string]$InFile,
  [string]$OutFile,
  [string]$Root,
  [string]$StopFile,
  [string]$ActivityFile
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not $Root) { $Root = Split-Path -Parent $MyInvocation.MyCommand.Path }
$script:StartedAt = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()

# Emergency stop, cooperative side: a marker written by the Esc watcher or the web stop
# button aborts work that is already running (tree walks, find loops, input batches).
# Only markers newer than this call count, so a previous stop cannot kill the next task.
function Test-StopRequested {
  if ([string]::IsNullOrWhiteSpace($StopFile)) { return $false }
  try {
    if (-not (Test-Path -LiteralPath $StopFile)) { return $false }
    $raw = [System.IO.File]::ReadAllText($StopFile)
    $obj = $raw | ConvertFrom-Json
    return ([int64]$obj.at) -ge $script:StartedAt
  } catch { return $false }
}

# Refreshing the activity stamp keeps the Esc watcher armed during one long operation.
function Touch-Activity {
  if ([string]::IsNullOrWhiteSpace($ActivityFile)) { return }
  try { [System.IO.File]::WriteAllText($ActivityFile, [DateTimeOffset]::Now.ToUnixTimeMilliseconds().ToString(), (New-Object System.Text.UTF8Encoding($false))) } catch { }
}

function Assert-NotStopped {
  Touch-Activity
  if (Test-StopRequested) {
    Fail ('STOPPED_BY_USER: the user pressed the stop button or Esc; this operation was abandoned. ' +
      'Tell them it stopped and wait for a new instruction. Do not retry.') @('The stop holds for a while; do not work around it.')
  }
}

function Write-Result {
  param([hashtable]$Payload)
  $json = $Payload | ConvertTo-Json -Depth 14 -Compress
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  if ($OutFile) {
    [System.IO.File]::WriteAllText($OutFile, $json, $utf8)
  } else {
    [Console]::Out.Write($json)
  }
}

# Stable error codes. Node maps these to Chinese messages (this script stays ASCII-only,
# because Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI).
$script:FailCodes = @(
  @('cannot read the UI Automation tree', 'UIA_TREE_UNREADABLE'),
  @('cannot start ', 'SPAWN_FAILED'),
  @('element does not support Invoke', 'ELEMENT_NO_INVOKE'),
  @('element does not support SetValue', 'ELEMENT_NO_SETVALUE'),
  @('element does not support Select', 'ELEMENT_NO_SELECT'),
  @('element does not support Toggle', 'ELEMENT_NO_TOGGLE'),
  @('element does not support Expand', 'ELEMENT_NO_EXPAND'),
  @('element does not support Collapse', 'ELEMENT_NO_COLLAPSE'),
  @('element does not support ScrollIntoView', 'ELEMENT_NO_SCROLL'),
  @('mouse click failed', 'CLICK_BLOCKED'),
  @('OCR failed', 'OCR_FAILED'),
  @('Win32 interop layer failed', 'INTEROP_INIT_FAILED'),
  @('window handle is invalid', 'STALE_HANDLE'),
  @('unknown ', 'BAD_ARG'),
  @('element not found', 'ELEMENT_NOT_FOUND')
)

function Get-FailCode([string]$Message) {
  foreach ($pair in $script:FailCodes) {
    if ($Message.StartsWith($pair[0], [StringComparison]::OrdinalIgnoreCase)) { return $pair[1] }
  }
  return ''
}

function Fail {
  param([string]$Message, [array]$Hints = @())
  Write-Result @{ ok = $false; code = (Get-FailCode $Message); error = $Message; hints = $Hints }
  exit 1
}

function Read-Spec {
  if (-not $InFile -or -not (Test-Path -LiteralPath $InFile)) { return @{} }
  $raw = [System.IO.File]::ReadAllText($InFile, [System.Text.Encoding]::UTF8)
  if ([string]::IsNullOrWhiteSpace($raw)) { return @{} }
  $obj = $raw | ConvertFrom-Json
  $hash = @{}
  if ($obj -is [System.Management.Automation.PSCustomObject]) {
    foreach ($p in $obj.PSObject.Properties) { $hash[$p.Name] = $p.Value }
  }
  return $hash
}

# ---------------------------------------------------------------- P/Invoke layer
$script:CsSource = @'
using System;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class CuNative {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }

  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr PostMessageW(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SendMessageTimeoutW(IntPtr h, uint msg, IntPtr wp, IntPtr lp, uint flags, uint timeout, out IntPtr result);
  public static bool IsResponsive(IntPtr h) {
    // WM_NULL with SMTO_ABORTIFHUNG: never enter a hung UI Automation provider.
    IntPtr r;
    return IsWindow(h) && SendMessageTimeoutW(h, 0, IntPtr.Zero, IntPtr.Zero, 2, 200, out r) != IntPtr.Zero;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr wp, string lp);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] p, int cb);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);

  public static int InputSize() { return Marshal.SizeOf(typeof(INPUT)); }

  // ---- Non-intrusive input: talk to the control's own window instead of moving the cursor.
  // These never touch the physical pointer or the foreground window, so the user keeps the mouse.
  public const uint WM_SETTEXT = 0x000C;
  public const uint WM_KEYDOWN = 0x0100;
  public const uint WM_KEYUP = 0x0101;
  public const uint WM_CHAR = 0x0102;
  public const uint WM_LBUTTONDOWN = 0x0201;
  public const uint WM_LBUTTONUP = 0x0202;
  public const uint WM_RBUTTONDOWN = 0x0204;
  public const uint WM_RBUTTONUP = 0x0205;
  public const uint WM_LBUTTONDBLCLK = 0x0203;
  public const uint BM_CLICK = 0x00F5;

  public static void PostRaw(IntPtr h, uint msg, IntPtr wp, IntPtr lp) {
    PostMessageW(h, msg, wp, lp);
    System.Threading.Thread.Sleep(15);
  }

  public static IntPtr MakeLParam(int x, int y) {
    return new IntPtr((y << 16) | (x & 0xFFFF));
  }

  public static bool ClickWindow(IntPtr h, int screenX, int screenY, bool rightButton, bool doubleClick) {
    var p = new POINT(); p.X = screenX; p.Y = screenY;
    if (!ScreenToClient(h, ref p)) return false;
    IntPtr lp = MakeLParam(p.X, p.Y);
    uint down = rightButton ? WM_RBUTTONDOWN : WM_LBUTTONDOWN;
    uint up = rightButton ? WM_RBUTTONUP : WM_LBUTTONUP;
    IntPtr wp = new IntPtr(1);
    PostMessageW(h, down, wp, lp);
    if (doubleClick && !rightButton) {
      System.Threading.Thread.Sleep(40);
      PostMessageW(h, WM_LBUTTONDBLCLK, wp, lp);
    }
    System.Threading.Thread.Sleep(40);
    PostMessageW(h, up, IntPtr.Zero, lp);
    return true;
  }

  public static bool SetTextMessage(IntPtr h, string text) {
    IntPtr r = SendMessageW(h, WM_SETTEXT, IntPtr.Zero, text);
    return true;
  }

  public static int PostChars(IntPtr h, string text) {
    int n = 0;
    foreach (char ch in text) {
      PostMessageW(h, WM_CHAR, new IntPtr(ch), IntPtr.Zero);
      n++;
      System.Threading.Thread.Sleep(8);
    }
    return n;
  }

  public static int PostKey(IntPtr h, int vk) {
    PostMessageW(h, WM_KEYDOWN, new IntPtr(vk), IntPtr.Zero);
    System.Threading.Thread.Sleep(15);
    PostMessageW(h, WM_KEYUP, new IntPtr(vk), IntPtr.Zero);
    return 2;
  }

  // Chromium-based hosts (Edge, Chrome, Electron, CEF, WebView2) paint each page in a
  // Chrome_RenderWidgetHostHWND child window, sometimes owned by another process.
  public static IntPtr[] ChromiumRenderers(IntPtr window, int max) {
    var found = new List<IntPtr>();
    var name = new StringBuilder(64);
    EnumChildWindows(window, delegate(IntPtr h, IntPtr p) {
      name.Length = 0;
      GetClassNameW(h, name, name.Capacity);
      if (name.ToString() == "Chrome_RenderWidgetHostHWND" && IsWindowVisible(h)) found.Add(h);
      return found.Count < max;
    }, IntPtr.Zero);
    return found.ToArray();
  }

  // Hand the foreground back without synthesising a key press.
  public static bool GiveForeground(IntPtr h) {
    if (h == IntPtr.Zero || !IsWindow(h)) return false;
    if (GetForegroundWindow() == h) return true;
    uint pid;
    IntPtr front = GetForegroundWindow();
    uint frontThread = front == IntPtr.Zero ? 0 : GetWindowThreadProcessId(front, out pid);
    uint mine = GetCurrentThreadId();
    bool attached = false;
    try {
      if (frontThread != 0 && frontThread != mine) attached = AttachThreadInput(mine, frontThread, true);
      BringWindowToTop(h);
      SetForegroundWindow(h);
    } finally {
      if (attached) AttachThreadInput(mine, frontThread, false);
    }
    return GetForegroundWindow() == h;
  }

  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowTextW(h, sb, 512); return sb.ToString(); }
  public static string ClassName(IntPtr h) { var sb = new StringBuilder(512); GetClassNameW(h, sb, 512); return sb.ToString(); }
  public static IntPtr RoomOf(IntPtr h) { return GetAncestor(h, 2); }

  // Menus and drop-downs are separate top-level windows owned by the app window.
  // A click on such a popup must count as a click on its owner, not as a stray window.
  public static bool OwnedBy(IntPtr h, IntPtr owner) {
    IntPtr cur = h;
    for (int i = 0; i < 4 && cur != IntPtr.Zero; i++) {
      IntPtr o = GetWindow(cur, 4);
      if (o == IntPtr.Zero) return false;
      if (o == owner) return true;
      cur = o;
    }
    return false;
  }

  // Children of a hidden parent inherit SW_HIDE, so a WinForms dialog would run its
  // message loop invisibly and then "time out". Force it visible, on top and focused.
  public static void ForceShowTopMost(IntPtr h) {
    ShowWindow(h, 5);
    SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0043); // HWND_TOPMOST, NOMOVE|NOSIZE|SHOWWINDOW
    BringWindowToTop(h);
    SetForegroundWindow(h);
  }

  public static List<IntPtr> TopLevel() {
    var list = new List<IntPtr>();
    EnumProc cb = delegate(IntPtr h, IntPtr p) { list.Add(h); return true; };
    EnumWindows(cb, IntPtr.Zero);
    return list;
  }

  // Foreground lock workaround: attach to the owning thread, restore, raise, detach.
  public static bool Activate(IntPtr h) {
    if (h == IntPtr.Zero || !IsWindow(h)) return false;
    uint pid;
    uint foreign = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint mine = GetCurrentThreadId();
    bool attached = false;
    try {
      if (foreign != 0 && foreign != mine) attached = AttachThreadInput(mine, foreign, true);
      if (IsIconic(h)) ShowWindow(h, 9); else ShowWindow(h, 5);
      BringWindowToTop(h);
      SetForegroundWindow(h);
    } finally {
      if (attached) AttachThreadInput(mine, foreign, false);
    }
    return GetForegroundWindow() == h || RoomOf(GetForegroundWindow()) == h;
  }

  public static bool MoveTo(int x, int y) { return SetCursorPos(x, y); }

  static uint Mouse(uint flags) {
    var mi = new INPUT(); mi.type = 0; mi.u.mi.dwFlags = flags;
    return SendInput(1, new INPUT[] { mi }, InputSize());
  }

  public static bool Click(int x, int y, string button, int count) {
    if (!SetCursorPos(x, y)) return false;
    System.Threading.Thread.Sleep(20);
    uint down = 0x0002, up = 0x0004;
    if (button == "right") { down = 0x0008; up = 0x0010; }
    else if (button == "middle") { down = 0x0020; up = 0x0040; }
    int times = count < 1 ? 1 : count;
    for (int i = 0; i < times; i++) {
      if (Mouse(down) != 1) return false;
      System.Threading.Thread.Sleep(25);
      if (Mouse(up) != 1) return false;
      if (i + 1 < times) System.Threading.Thread.Sleep(60);
    }
    return true;
  }

  public static bool Drag(int x1, int y1, int x2, int y2) {
    if (!SetCursorPos(x1, y1)) return false;
    System.Threading.Thread.Sleep(40);
    if (Mouse(0x0002) != 1) return false;
    int steps = 12;
    for (int i = 1; i <= steps; i++) {
      SetCursorPos(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
      System.Threading.Thread.Sleep(15);
    }
    System.Threading.Thread.Sleep(40);
    return Mouse(0x0004) == 1;
  }

  public static bool Scroll(int x, int y, int delta) {
    if (!SetCursorPos(x, y)) return false;
    var mi = new INPUT(); mi.type = 0;
    mi.u.mi.dwFlags = 0x0800;
    mi.u.mi.mouseData = unchecked((uint)delta);
    return SendInput(1, new INPUT[] { mi }, InputSize()) == 1;
  }

  // Unicode keyboard input: works for CJK/emoji and does not depend on the layout.
  public static int TypeText(string text) {
    if (string.IsNullOrEmpty(text)) return 0;
    var arr = new List<INPUT>(text.Length * 2);
    foreach (char ch in text) {
      if (ch == '\r') continue;
      ushort scan; uint flags;
      if (ch == '\n') { scan = 0x0D; flags = 0; } else { scan = (ushort)ch; flags = 0x0004; }
      var d = new INPUT(); d.type = 1; d.u.ki.wScan = scan; d.u.ki.wVk = 0; d.u.ki.dwFlags = flags;
      var u = new INPUT(); u.type = 1; u.u.ki.wScan = scan; u.u.ki.wVk = 0; u.u.ki.dwFlags = flags | 0x0002;
      arr.Add(d); arr.Add(u);
    }
    return (int)SendInput((uint)arr.Count, arr.ToArray(), InputSize());
  }

  public static int PressVk(int vk) {
    var d = new INPUT(); d.type = 1; d.u.ki.wVk = (ushort)vk;
    var u = new INPUT(); u.type = 1; u.u.ki.wVk = (ushort)vk; u.u.ki.dwFlags = 0x0002;
    uint a = SendInput(1, new INPUT[] { d }, InputSize());
    System.Threading.Thread.Sleep(20);
    uint b = SendInput(1, new INPUT[] { u }, InputSize());
    return (int)(a + b);
  }

  public static int KeyCombo(int[] mods, int[] keys) {
    int sent = 0;
    foreach (int m in mods) sent += PressVk(m);
    foreach (int k in keys) sent += PressVk(k);
    for (int i = keys.Length - 1; i >= 0; i--) sent += PressVk(keys[i]);
    for (int i = mods.Length - 1; i >= 0; i--) sent += PressVk(mods[i]);
    return sent;
  }

  public static string Grab(int x, int y, int w, int h, string path) {
    using (var bmp = new Bitmap(Math.Max(1, w), Math.Max(1, h), PixelFormat.Format24bppRgb))
    using (var g = Graphics.FromImage(bmp)) {
      g.CopyFromScreen(x, y, 0, 0, new Size(Math.Max(1, w), Math.Max(1, h)), CopyPixelOperation.SourceCopy);
      bmp.Save(path, ImageFormat.Png);
    }
    return path;
  }

  // True when the window actually painted. Blank output means PrintWindow is unsupported
  // by that window, and the caller should fall back to a screen grab of its rect.
  public static bool GrabWindow(IntPtr h, string path, bool full) {
    RECT r; if (!GetWindowRect(h, out r)) return false;
    int w = r.Right - r.Left, hgt = r.Bottom - r.Top;
    if (w <= 0 || hgt <= 0) return false;
    bool painted = false;
    using (var bmp = new Bitmap(w, hgt, PixelFormat.Format24bppRgb))
    using (var g = Graphics.FromImage(bmp)) {
      IntPtr hdc = g.GetHdc();
      painted = PrintWindow(h, hdc, full ? 2u : 0u);
      g.ReleaseHdc(hdc);
      if (painted) {
        int hits = 0;
        for (int i = 1; i <= 8; i++) {
          int px = Math.Min(w - 1, w * i / 9);
          int py = Math.Min(hgt - 1, hgt * (i % 3 + 1) / 4);
          Color c = bmp.GetPixel(px, py);
          if (c.R + c.G + c.B > 12) hits++;
        }
        painted = hits > 0;
      }
      bmp.Save(path, ImageFormat.Png);
    }
    return painted;
  }
}
'@

function Initialize-Native {
  if ('CuNative' -as [type]) { return }
  $cacheDir = Join-Path $Root '.cache'
  $key = 'static'
  try { $key = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.Substring(0, 10) } catch { }
  $dllPath = Join-Path $cacheDir ("CuNative-$key.dll")
  if (Test-Path -LiteralPath $dllPath) {
    try { Add-Type -Path $dllPath -ErrorAction Stop; return } catch { }
  }
  # Drop stale cached builds: the hash changes whenever this script changes.
  # Files still loaded by a concurrent call fail to delete and are simply kept for later.
  try {
    Get-ChildItem -LiteralPath $cacheDir -Filter 'CuNative-*.dll' -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -ne ("CuNative-$key.dll") } |
      ForEach-Object { try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop } catch { } }
  } catch { }
  try {
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    if (-not (Test-Path -LiteralPath $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }
    try {
      Add-Type -TypeDefinition $script:CsSource -ReferencedAssemblies 'System.Drawing', 'System.Windows.Forms' -OutputAssembly $dllPath -ErrorAction Stop
      Add-Type -Path $dllPath -ErrorAction Stop
      return
    } catch {
      try { Remove-Item -LiteralPath $dllPath -Force -ErrorAction SilentlyContinue } catch { }
    }
    Add-Type -TypeDefinition $script:CsSource -ReferencedAssemblies 'System.Drawing', 'System.Windows.Forms' -ErrorAction Stop
  } catch {
    Fail "Win32 interop layer failed to initialize: $($_.Exception.Message)" @('This machine may lack .NET Framework 4.x or the System.Drawing component')
  }
}

# Per-monitor DPI awareness so screenshots, UIA rects and cursor coordinates share one space.
function Initialize-Dpi {
  try { [void][CuNative]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { }
}

# ---------------------------------------------------------------- helpers
function Get-ProcName([int]$procId) {
  try { return (Get-Process -Id $procId -ErrorAction Stop).ProcessName + '.exe' } catch { return '' }
}

function Convert-Handle($h) {
  if ($h -is [IntPtr]) { return ('0x{0:x}' -f $h.ToInt64()) }
  return ('0x{0:x}' -f [int64]$h)
}

function ConvertTo-Handle([string]$text) {
  if ([string]::IsNullOrWhiteSpace($text)) { return [IntPtr]::Zero }
  $t = $text.Trim()
  if ($t -match '^(0x|0X)') { return [IntPtr]([int64]::Parse($t.Substring(2), 'HexNumber')) }
  if ($t -match '^[0-9a-fA-F]{5,}$') { return [IntPtr]([int64]::Parse($t, 'HexNumber')) }
  return [IntPtr]([int64]$t)
}

function Get-WindowSnapshot {
  param([IntPtr]$Handle)
  if ($Handle -eq [IntPtr]::Zero -or -not [CuNative]::IsWindow($Handle)) { return $null }
  $r = New-Object CuNative+RECT
  [void][CuNative]::GetWindowRect($Handle, [ref]$r)
  $procId = 0
  [void][CuNative]::GetWindowThreadProcessId($Handle, [ref]$procId)
  return @{
    h       = (Convert-Handle $Handle)
    title   = [CuNative]::Title($Handle)
    cls     = [CuNative]::ClassName($Handle)
    pid     = [int]$procId
    proc    = (Get-ProcName $procId)
    x       = $r.Left; y = $r.Top
    w       = ($r.Right - $r.Left); hh = ($r.Bottom - $r.Top)
    visible = [CuNative]::IsWindowVisible($Handle)
    iconic  = [CuNative]::IsIconic($Handle)
  }
}

# ---------------------------------------------------------------- verb: probe
function Invoke-Probe {
  $screenW = [CuNative]::GetSystemMetrics(0); $screenH = [CuNative]::GetSystemMetrics(1)
  $cur = New-Object CuNative+POINT
  [void][CuNative]::GetCursorPos([ref]$cur)
  # A no-op cursor move is the cheapest way to test whether synthetic input is allowed
  # for this process's integrity level (UIPI blocks Low -> Medium).
  $canInput = [CuNative]::MoveTo($cur.X, $cur.Y)

  $uiaOk = $false; $uiaDetail = ''
  try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
    $null = [System.Windows.Automation.AutomationElement]::RootElement
    $uiaOk = $true; $uiaDetail = 'ok'
  } catch { $uiaOk = $false; $uiaDetail = $_.Exception.Message }

  $ocrLang = ''; $ocrOk = $false
  try {
    [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($engine) { $ocrOk = $true; $ocrLang = $engine.RecognizerLanguage.LanguageTag }
  } catch { }

  $fg = [CuNative]::GetForegroundWindow()
  $fgInfo = Get-WindowSnapshot $fg
  $visible = 0
  foreach ($h in [CuNative]::TopLevel()) {
    if (-not [CuNative]::IsWindowVisible($h)) { continue }
    if ([CuNative]::Title($h).Length -eq 0) { continue }
    $visible++
  }

  Write-Result @{
    ok   = $true
    data = @{
      os           = [System.Environment]::OSVersion.VersionString
      user         = "$env:USERDOMAIN\$env:USERNAME"
      sessionId    = (Get-Process -Id $PID).SessionId
      interactive  = [System.Environment]::UserInteractive
      psVersion    = $PSVersionTable.PSVersion.ToString()
      screen       = @{ w = $screenW; h = $screenH }
      cursor       = @{ x = $cur.X; y = $cur.Y }
      foreground   = $fgInfo
      windows      = $visible
      capabilities = @{
        input       = [bool]$canInput
        uia         = $uiaOk
        ocr         = $ocrOk
        ocrLang     = $ocrLang
        dialog      = [bool][System.Environment]::UserInteractive
        printWindow = $true
      }
      helpers      = @{ uiaDetail = $uiaDetail }
    }
  }
}

# ---------------------------------------------------------------- verb: windows
function Invoke-Windows {
  $spec = Read-Spec
  $limit = 60; if ($spec.ContainsKey('limit') -and $spec['limit']) { $limit = [int]$spec['limit'] }
  $fgRoom = [CuNative]::RoomOf([CuNative]::GetForegroundWindow())
  $rows = @(); $skipped = 0
  foreach ($h in [CuNative]::TopLevel()) {
    if (-not [CuNative]::IsWindowVisible($h)) { continue }
    if ([CuNative]::Title($h).Length -eq 0) { continue }
    if ($rows.Count -ge $limit) { $skipped++; continue }
    $snap = Get-WindowSnapshot $h
    if ($snap -eq $null) { continue }
    $snap['foreground'] = ($h -eq $fgRoom)
    $rows += $snap
  }
  Write-Result @{
    ok   = $true
    data = @{
      foreground = (Convert-Handle $fgRoom)
      windows    = $rows
      truncated  = $skipped
    }
  }
}

# ---------------------------------------------------------------- OCR (WinRT)
$script:OcrReady = $false
function Initialize-Ocr {
  if ($script:OcrReady) { return }
  Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
  [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  $script:AsTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  if (-not $script:AsTaskGeneric) { throw 'IAsyncOperation.AsTask extension method not found' }
  $script:OcrReady = $true
}

function Await-WinRt($Operation, [type]$ResultType) {
  $m = $script:AsTaskGeneric.MakeGenericMethod($ResultType)
  $task = $m.Invoke($null, @($Operation))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

function Invoke-OcrFile {
  param([string]$Path, [string]$Lang, [int]$OffsetX = 0, [int]$OffsetY = 0, [int]$Limit = 400)
  Initialize-Ocr
  $engine = $null
  if ($Lang) {
    try {
      [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
      $language = New-Object Windows.Globalization.Language $Lang
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
    } catch { $engine = $null }
  }
  if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (-not $engine) { throw 'No Windows OCR language pack is available' }

  $maxDim = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
  $file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
  $stream = Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $imgW = [int]$decoder.PixelWidth; $imgH = [int]$decoder.PixelHeight

  $ocrPath = $Path
  $scale = 1.0
  # The engine rejects images above MaxImageDimension, so downscale big screens and
  # map the boxes back to screen coordinates.
  if ($imgW -gt $maxDim -or $imgH -gt $maxDim) {
    $scale = [Math]::Min($maxDim / $imgW, $maxDim / $imgH)
    $tmp = Join-Path ([System.IO.Path]::GetDirectoryName($Path)) ('.ocr-' + [guid]::NewGuid().ToString('N') + '.png')
    $src = [System.Drawing.Image]::FromFile($Path)
    $nw = [int]([Math]::Max(1, $imgW * $scale)); $nh = [int]([Math]::Max(1, $imgH * $scale))
    $bmp = New-Object System.Drawing.Bitmap $nw, $nh
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($src, 0, 0, $nw, $nh)
    $g.Dispose(); $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); $src.Dispose()
    $stream.Dispose()
    $file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp)) ([Windows.Storage.StorageFile])
    $stream = Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $ocrPath = $tmp
  }

  $bitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $inv = 1.0 / $scale
  $lines = @(); $skipped = 0
  foreach ($line in $result.Lines) {
    if ($lines.Count -ge $Limit) { $skipped++; continue }
    $minX = [double]::MaxValue; $minY = [double]::MaxValue; $maxX = 0.0; $maxY = 0.0
    foreach ($word in $line.Words) {
      $b = $word.BoundingRect
      if ($b.X -lt $minX) { $minX = $b.X }
      if ($b.Y -lt $minY) { $minY = $b.Y }
      if (($b.X + $b.Width) -gt $maxX) { $maxX = $b.X + $b.Width }
      if (($b.Y + $b.Height) -gt $maxY) { $maxY = $b.Y + $b.Height }
    }
    if ($minX -eq [double]::MaxValue) { continue }
    $lines += @{
      text = $line.Text
      x    = [int]([Math]::Round($minX * $inv)) + $OffsetX
      y    = [int]([Math]::Round($minY * $inv)) + $OffsetY
      w    = [int]([Math]::Round(($maxX - $minX) * $inv))
      h    = [int]([Math]::Round(($maxY - $minY) * $inv))
    }
  }
  $bitmap.Dispose(); $stream.Dispose()
  if ($ocrPath -ne $Path) { try { Remove-Item -LiteralPath $ocrPath -Force -ErrorAction SilentlyContinue } catch { } }
  return @{
    lang      = $engine.RecognizerLanguage.LanguageTag
    image     = @{ w = $imgW; h = $imgH }
    lines     = $lines
    text      = (($lines | ForEach-Object { $_.text }) -join "`n")
    truncated = $skipped
  }
}

# ---------------------------------------------------------------- verb: shot
function Invoke-Shot {
  $spec = Read-Spec
  $mode = 'screen'; if ($spec.ContainsKey('mode') -and $spec['mode']) { $mode = [string]$spec['mode'] }
  $path = [string]$spec['path']
  if (-not $path) { Fail 'shot requires path (absolute PNG path)' }
  $dir = Split-Path -Parent $path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

  $offsetX = 0; $offsetY = 0; $w = 0; $h = 0; $source = ''
  if ($mode -eq 'screen') {
    $w = [CuNative]::GetSystemMetrics(0); $h = [CuNative]::GetSystemMetrics(1)
    [void][CuNative]::Grab(0, 0, $w, $h, $path)
    $source = 'screen'
  } elseif ($mode -eq 'region') {
    $rect = $spec['rect']
    if (-not $rect) { Fail 'region mode requires rect = {x,y,w,h}' }
    $offsetX = [int]$rect.x; $offsetY = [int]$rect.y; $w = [int]$rect.w; $h = [int]$rect.h
    if ($w -le 0 -or $h -le 0) { Fail 'region w/h must be positive' }
    [void][CuNative]::Grab($offsetX, $offsetY, $w, $h, $path)
    $source = 'region'
  } elseif ($mode -eq 'window') {
    $handle = ConvertTo-Handle ([string]$spec['h'])
    if ($handle -eq [IntPtr]::Zero) { Fail 'window mode requires h (window handle such as 0x1a2b3c)' }
    if (-not [CuNative]::IsWindow($handle)) { Fail "window handle is invalid or closed: $($spec['h'])" }
    if ($spec.ContainsKey('activate') -and $spec['activate']) {
      [void][CuNative]::Activate($handle)
      Start-Sleep -Milliseconds 140
    }
    $painted = [CuNative]::GrabWindow($handle, $path, $true)
    if (-not $painted) { $painted = [CuNative]::GrabWindow($handle, $path, $false) }
    $snap = Get-WindowSnapshot $handle
    if ($snap -eq $null) { Fail 'window disappeared before capture' }
    $offsetX = $snap.x; $offsetY = $snap.y; $w = $snap.w; $h = $snap.hh
    if ($painted) {
      $source = 'printwindow'
    } else {
      [void][CuNative]::Grab($offsetX, $offsetY, $w, $h, $path)
      $source = 'window-screen-fallback'
    }
  } else {
    Fail "unknown shot.mode: $mode (screen / window / region)"
  }

  $item = Get-Item -LiteralPath $path
  $data = @{
    path   = $path
    mode   = $mode
    source = $source
    w      = $w
    h      = $h
    ox     = $offsetX
    oy     = $offsetY
    bytes  = $item.Length
  }
  if ($spec.ContainsKey('ocr') -and $spec['ocr']) {
    $lang = ''; if ($spec.ContainsKey('lang')) { $lang = [string]$spec['lang'] }
    $limit = 400; if ($spec.ContainsKey('ocrLimit')) { $limit = [int]$spec['ocrLimit'] }
    try {
      $data['ocr'] = Invoke-OcrFile -Path $path -Lang $lang -OffsetX $offsetX -OffsetY $offsetY -Limit $limit
    } catch {
      $data['ocr'] = @{ error = $_.Exception.Message; lines = @(); text = '' }
    }
  }
  Write-Result @{ ok = $true; data = $data }
}

# ---------------------------------------------------------------- verb: ocr
function Invoke-OcrOnly {
  $spec = Read-Spec
  $path = [string]$spec['path']
  if (-not $path -or -not (Test-Path -LiteralPath $path)) { Fail 'ocr requires an existing image path' }
  $lang = ''; if ($spec.ContainsKey('lang')) { $lang = [string]$spec['lang'] }
  $offsetX = 0; $offsetY = 0
  if ($spec.ContainsKey('ox')) { $offsetX = [int]$spec['ox'] }
  if ($spec.ContainsKey('oy')) { $offsetY = [int]$spec['oy'] }
  $limit = 400; if ($spec.ContainsKey('limit')) { $limit = [int]$spec['limit'] }
  try { $r = Invoke-OcrFile -Path $path -Lang $lang -OffsetX $offsetX -OffsetY $offsetY -Limit $limit }
  catch { Fail "OCR failed: $($_.Exception.Message)" }
  Write-Result @{ ok = $true; data = $r }
}

# ---------------------------------------------------------------- UI Automation
function Initialize-Uia {
  Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
  Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
  $null = [System.Windows.Automation.AutomationElement]::RootElement
}

function Get-RoleName($element) {
  try { return $element.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '' } catch { return 'Unknown' }
}

function Get-PatternNames($element) {
  $names = @()
  try {
    foreach ($p in $element.GetSupportedPatterns()) {
      $n = $p.ProgrammaticName -replace 'PatternIdentifiers\.', ''
      $n = $n -replace 'Pattern$', ''
      $names += $n.ToLowerInvariant()
    }
  } catch { }
  return $names
}

function Get-ValueOf($element) {
  try {
    $vp = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($vp) { return [string]$vp.Current.Value }
  } catch { }
  try {
    $tp = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    if ($tp) { return [string]$tp.Current.ToggleState }
  } catch { }
  return $null
}

$script:Walker = $null
function Set-Walker([string]$view) {
  switch ($view) {
    'raw' { $script:Walker = [System.Windows.Automation.TreeWalker]::RawViewWalker }
    'content' { $script:Walker = [System.Windows.Automation.TreeWalker]::ContentViewWalker }
    default { $script:Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker }
  }
}

function Get-Children($element) {
  $walker = $script:Walker
  if (-not $walker) { Set-Walker 'control'; $walker = $script:Walker }
  $list = New-Object System.Collections.ArrayList
  try { $child = $walker.GetFirstChild($element) } catch { return @() }
  while ($child -ne $null) {
    [void]$list.Add($child)
    try { $child = $walker.GetNextSibling($child) } catch { break }
  }
  return $list.ToArray()
}

function ConvertTo-Node($element, [string]$path, [bool]$withValue) {
  $role = 'Unknown'; $name = ''; $automationId = ''; $cls = ''
  $enabled = $true; $offscreen = $false; $password = $false; $focused = $false
  $nh = 0
  $fw = ''
  $rect = @{ x = 0; y = 0; w = 0; h = 0 }
  try {
    $c = $element.Current
    $role = Get-RoleName $element
    $name = [string]$c.Name
    if ($name.Length -gt 120) { $name = $name.Substring(0, 117) + '...' }
    $automationId = [string]$c.AutomationId
    $cls = [string]$c.ClassName
    $enabled = [bool]$c.IsEnabled
    $offscreen = [bool]$c.IsOffscreen
    $password = [bool]$c.IsPassword
    $focused = [bool]$c.HasKeyboardFocus
    $b = $c.BoundingRectangle
    if (-not $b.IsEmpty) { $rect = @{ x = [int]$b.X; y = [int]$b.Y; w = [int]$b.Width; h = [int]$b.Height } }
    try { $nh = [int]$c.NativeWindowHandle } catch { $nh = 0 }
    try { $fw = [string]$c.FrameworkId } catch { $fw = '' }
  } catch { }

  $node = @{
    p = $path; r = $role; n = $name; id = $automationId; c = $cls
    b = $rect; e = $enabled; o = $offscreen; pw = $password; f = $focused
    k = (Get-PatternNames $element)
  }
  # Own window handle: lets the caller activate the control without touching the mouse.
  if ($nh -ne 0) { $node['nh'] = ('0x{0:x}' -f $nh) }
  # Framework identity: Chromium/Gecko nest the page under unnamed layout panes.
  if ($fw) { $node['fw'] = $fw }
  if ($withValue -and -not $password) {
    $v = Get-ValueOf $element
    if ($v -ne $null -and $v.Length -gt 0) {
      if ($v.Length -gt 200) { $v = $v.Substring(0, 197) + '...' }
      $node['v'] = $v
    }
  }
  return $node
}

# A UI Automation element rect can be stale or belong to a hidden/covered window.
# Never inject a click at a point that does not actually belong to the target window.
function Assert-PointInWindow([IntPtr]$expected, [int]$x, [int]$y) {
  $pt = New-Object CuNative+POINT
  $pt.X = $x; $pt.Y = $y
  $hitRoom = [CuNative]::RoomOf([CuNative]::WindowFromPoint($pt))
  if ($hitRoom -ne $expected -and -not [CuNative]::OwnedBy($hitRoom, $expected)) {
    Fail ("element center $x,$y is not inside target window $(Convert-Handle $expected) " +
      "(the point hits $(Convert-Handle $hitRoom) '$([CuNative]::Title($hitRoom))'); " +
      "the element rect is stale, or the window is hidden/covered - re-read the ui tree") @('bring the window to the foreground first, or use action=invoke / setValue instead of clicking')
  }
}

function Get-NodeHandle($node) {
  if ($node -and $node.ContainsKey('nh') -and $node['nh']) {
    $t = ([string]$node['nh']).Trim()
    if ($t -match '^(0x|0X)') { return [IntPtr]([int64]::Parse($t.Substring(2), 'HexNumber')) }
  }
  return [IntPtr]::Zero
}

# Chromium only builds a page's accessibility tree after a UIA client asks for it.
# Two shapes exist in the wild, so both are tried:
#   1. older Chromium / Electron / CEF / WebView2 expose a Chrome_RenderWidgetHostHWND
#      child; reading a property on it wakes that page (the approach documented by
#      Yu-tao-Li/dsh-computer-use-win, MIT).
#   2. current Edge/Chrome (verified on Edge 156) no longer create that child window at
#      all - the only child is "Intermediate D3D Window" - and the page tree materialises
#      when a UIA client walks into the host panes and reads properties there.
# Either way this returns whether the page is ready, so the caller can say so honestly.
function Start-ChromiumWebContent {
  param([IntPtr]$Window, [int]$BudgetMs = 2000)
  $via = 'none'
  $renderers = @()
  try { $renderers = @([CuNative]::ChromiumRenderers($Window, 4)) } catch { $renderers = @() }
  if ($renderers.Count -gt 0) { $via = 'renderer' } else { $via = 'tree' }
  if (-not [CuNative]::IsResponsive($Window)) {
    return @{ renderers = $renderers.Count; state = 'unresponsive'; waitedMs = 0; via = $via }
  }
  # A minimized or hidden window has no page tree to wake: say so instead of waiting.
  if (-not [CuNative]::IsWindowVisible($Window) -or [CuNative]::IsIconic($Window)) {
    return @{ renderers = $renderers.Count; state = 'hidden'; waitedMs = 0; via = $via }
  }

  $rawWalker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $ready = $false
  $visited = 0

  # Bounded raw probe: stop as soon as a page document shows up.
  $probe = {
    param($element, $depth)
    if ($ready -or $visited -ge 900 -or $watch.ElapsedMilliseconds -ge $BudgetMs) { return }
    $visited++
    $framework = ''
    $controlType = ''
    $automationId = ''
    try {
      $framework = [string]$element.Current.FrameworkId
      $controlType = Get-RoleName $element
      $automationId = [string]$element.Current.AutomationId
    } catch { }
    # Modern Chromium puts the page root about eleven levels down; accept either signal.
    if ($controlType -eq 'Document' -and ($automationId -eq 'RootWebArea' -or $framework -eq 'Chrome')) {
      $ready = $true
      return
    }
    if ($depth -ge 14) { return }
    try { $child = $rawWalker.GetFirstChild($element) } catch { return }
    while ($null -ne $child) {
      & $probe $child ($depth + 1)
      if ($ready -or $watch.ElapsedMilliseconds -ge $BudgetMs) { return }
      try { $child = $rawWalker.GetNextSibling($child) } catch { break }
    }
  }

  while ($watch.ElapsedMilliseconds -lt $BudgetMs -and -not $ready) {
    foreach ($renderer in $renderers) {
      if (-not [CuNative]::IsWindow($renderer)) { continue }
      try {
        $el = [System.Windows.Automation.AutomationElement]::FromHandle($renderer)
        if ($null -eq $el) { continue }
        # Reading a property is the signal Chromium waits for.
        $null = $el.Current.Name
        $null = $el.Current.BoundingRectangle
        $null = $el.GetSupportedPatterns()
        if ($null -ne $rawWalker.GetFirstChild($el)) { $ready = $true }
      } catch { }
    }
    if (-not $ready) {
      $visited = 0
      try { & $probe ([System.Windows.Automation.AutomationElement]::FromHandle($Window)) 0 } catch { }
    }
    if (-not $ready) { Start-Sleep -Milliseconds 150 }
  }
  return @{
    renderers = $renderers.Count
    state     = $(if ($ready) { 'ready' } else { 'starting' })
    waitedMs  = [int]$watch.ElapsedMilliseconds
    via       = $via
    probed    = $visited
  }
}

# Give back what a step had to borrow: the pointer (only if it is still exactly where we
# left it, so a user who moved it keeps it) and the foreground.
# Approach mirrored from Yu-tao-Li/dsh-computer-use-win (MIT).
function Restore-Borrowed {
  param([hashtable]$State)
  $report = @{}
  if ($null -ne $State['movedAt']) {
    $now = New-Object CuNative+POINT
    [void][CuNative]::GetCursorPos([ref]$now)
    if ($now.X -eq $State['movedAt'].X -and $now.Y -eq $State['movedAt'].Y) {
      [void][CuNative]::MoveTo($State['cursorAt'].X, $State['cursorAt'].Y)
      $report['pointer'] = 'returned'
    } else {
      $report['pointer'] = 'left where you moved it'
    }
  }
  if (-not $State['borrowed']) { return $report }
  $userFront = [IntPtr]$State['userFront']
  if ($userFront -eq [IntPtr]::Zero -or -not [CuNative]::IsWindow($userFront) -or -not [CuNative]::IsWindowVisible($userFront)) {
    $report['foreground'] = 'kept: the window that was in front is gone'
    return $report
  }
  $targetProcess = 0
  if ($State['target'] -ne [IntPtr]::Zero) {
    [void][CuNative]::GetWindowThreadProcessId([IntPtr]$State['target'], [ref]$targetProcess)
  }
  $front = [CuNative]::GetForegroundWindow()
  $frontProcess = 0
  [void][CuNative]::GetWindowThreadProcessId($front, [ref]$frontProcess)
  if ($front -ne $userFront -and $frontProcess -ne $targetProcess) {
    $report['foreground'] = 'left: another window is in front now'
    return $report
  }
  $report['foreground'] = $(if ([CuNative]::GiveForeground($userFront)) { 'returned' } else { 'kept in front: Windows refused to switch back' })
  return $report
}

# Non-intrusive activation: use the control's own Invoke pattern first, then post a click
# to the control's window. Neither moves the pointer nor changes which window is foreground,
# so the user keeps the mouse and the focus while this runs.
function Invoke-ElementActivate($element, $node, [string]$mode, [bool]$intrusive, [IntPtr]$handle) {
  $nh = Get-NodeHandle $node

  if (-not $intrusive) {
    if ($mode -eq 'click') {
      try {
        $p = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        if ($p) { $p.Invoke(); return 'invoke-pattern' }
      } catch { }
    }
    if ($nh -ne [IntPtr]::Zero) {
      if ($mode -eq 'click') {
        [void][CuNative]::PostRaw($nh, [CuNative]::BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero)
        return 'wm-BM_CLICK'
      }
      $b = $null
      try { $b = $element.Current.BoundingRectangle } catch { }
      if ($b -eq $null -or $b.Width -le 0) { Fail 'element has no screen rect to aim at' }
      $cx = [int]($b.X + $b.Width / 2); $cy = [int]($b.Y + $b.Height / 2)
      $right = ($mode -eq 'rightClick')
      $dbl = ($mode -eq 'doubleClick')
      if (-not [CuNative]::ClickWindow($nh, $cx, $cy, $right, $dbl)) { Fail 'posting a click to the control window failed' }
      return "wm-click@$cx,$cy"
    }
    Fail ('this element exposes no Invoke pattern and no window handle of its own, so it cannot be activated ' +
      'without moving the mouse; pass allowIntrusive=true (the user confirms first) or use a structured action ' +
      '(select / toggle / expand / setValue)') @('Chromium page content usually has no own window handle: read the screen, and use intrusive mode only with approval')
  }

  # intrusive: real pointer, guarded by the point-in-window check
  $b = $null
  try { $b = $element.Current.BoundingRectangle } catch { }
  if ($b -eq $null -or $b.Width -le 0 -or $b.Height -le 0) { Fail 'element has no clickable screen rect (invisible?)' }
  $cx = [int]($b.X + $b.Width / 2); $cy = [int]($b.Y + $b.Height / 2)
  Assert-PointInWindow ([CuNative]::RoomOf($handle)) $cx $cy
  $button = 'left'; $count = 1
  if ($mode -eq 'rightClick') { $button = 'right' }
  if ($mode -eq 'doubleClick') { $count = 2 }
  if (-not [CuNative]::Click($cx, $cy, $button, $count)) { Fail "mouse click failed at $cx,$cy (likely blocked by UIPI)" }
  return "$mode@$cx,$cy (intrusive)"
}

# Non-intrusive text entry: ValuePattern first, then WM_CHAR posted to the control window.
function Invoke-ElementType($element, $node, [string]$text) {
  try {
    $p = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($p) { $p.SetValue($text); return 'value-pattern' }
  } catch { }
  $nh = Get-NodeHandle $node
  if ($nh -ne [IntPtr]::Zero) {
    $n = [CuNative]::PostChars($nh, $text)
    return "wm-chars=$n"
  }
  Fail 'this element accepts neither ValuePattern nor posted characters; typing would need the real keyboard (allowIntrusive=true, user confirms)'
}

function Resolve-Element($root, [string]$path) {
  if ($path -eq 'root' -or [string]::IsNullOrEmpty($path)) { return $root }
  $element = $root
  foreach ($seg in $path.Split('/')) {
    $kids = Get-Children $element
    $idx = -1
    if (-not [int]::TryParse($seg, [ref]$idx)) { throw "malformed element path: $path" }
    if ($idx -lt 0 -or $idx -ge $kids.Count) {
      throw "element path is stale (segment $seg exceeds $($kids.Count) children); re-read the ui tree"
    }
    $element = $kids[$idx]
  }
  return $element
}

function Invoke-Uia {
  Initialize-Uia
  $spec = Read-Spec
  $mode = 'tree'; if ($spec.ContainsKey('mode') -and $spec['mode']) { $mode = [string]$spec['mode'] }
  $handle = ConvertTo-Handle ([string]$spec['h'])
  if ($handle -eq [IntPtr]::Zero) { Fail 'uia requires h (window handle)' }
  if (-not [CuNative]::IsWindow($handle)) { Fail "window handle is invalid or closed: $($spec['h'])" }

  try { $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle) }
  catch { Fail "cannot read the UI Automation tree of this window: $($_.Exception.Message)" }
  if ($root -eq $null) { Fail 'window exposes no UI Automation root (closed, or access denied)' }

  $withValue = $true
  if ($spec.ContainsKey('values')) { $withValue = [bool]$spec['values'] }
  $depth = 6; if ($spec.ContainsKey('depth')) { $depth = [int]$spec['depth'] }
  $maxNodes = 500; if ($spec.ContainsKey('max')) { $maxNodes = [int]$spec['max'] }

  $view = 'auto'; if ($spec.ContainsKey('view')) { $view = [string]$spec['view'] }

  function Build-Tree($rootEl) {
    $nodeCount = 1
    $isTruncated = $false
    $rootNode = ConvertTo-Node $rootEl 'root' $withValue
    $nodeStack = New-Object System.Collections.Stack
    $nodeStack.Push(@{ el = $rootEl; path = 'root'; node = $rootNode; depth = 0 })
    while ($nodeStack.Count -gt 0) {
      if ($nodeCount % 40 -eq 0) { Assert-NotStopped }
      $frame = $nodeStack.Pop()
      if ($frame.depth -ge $depth) { continue }
      if ($nodeCount -ge $maxNodes) { $isTruncated = $true; continue }
      $kids = Get-Children $frame.el
      $children = @()
      $i = 0
      foreach ($kid in $kids) {
        if ($nodeCount -ge $maxNodes) { $isTruncated = $true; break }
        $childPath = if ($frame.path -eq 'root') { "$i" } else { "$($frame.path)/$i" }
        $i++
        $childNode = ConvertTo-Node $kid $childPath $withValue
        $nodeCount++
        $children += $childNode
      }
      $frame.node['ch'] = $children
      for ($j = $children.Count - 1; $j -ge 0; $j--) {
        # Chromium/Gecko hide the page six or more levels down behind unnamed layout
        # panes (NonClientView / ClientView / View ...). Those must not eat the depth
        # budget, or a window-scoped tree never reaches the page.
        $childDepth = $frame.depth + 1
        $childNode = $children[$j]
        if ($childNode.r -eq 'Pane' -and [string]::IsNullOrEmpty($childNode.n) -and
            ($childNode.ContainsKey('fw') -and ($childNode['fw'] -eq 'Chrome' -or $childNode['fw'] -eq 'Gecko'))) {
          $childDepth = $frame.depth
        }
        $nodeStack.Push(@{ el = $kids[$j]; path = $childNode.p; node = $childNode; depth = $childDepth })
      }
    }
    return @{ tree = $rootNode; nodes = $nodeCount; truncated = $isTruncated }
  }

  function Find-Nodes($rootEl) {
    $found = @()
    $visitedFind = 0
    $findStack = New-Object System.Collections.Stack
    $findStack.Push(@{ el = $rootEl; path = 'root'; depth = 0 })
    while ($findStack.Count -gt 0 -and $found.Count -lt 40) {
      if (($visitedFind % 40) -eq 0) { Assert-NotStopped }
      $visitedFind++
      $frame = $findStack.Pop()
      if ($frame.depth -ge $depth) { continue }
      $kids = Get-Children $frame.el
      $i = 0
      foreach ($kid in $kids) {
        $childPath = if ($frame.path -eq 'root') { "$i" } else { "$($frame.path)/$i" }
        $i++
        $isMatch = $true
        $role = ''; $name = ''; $aid = ''
        try {
          $c = $kid.Current
          $role = Get-RoleName $kid; $name = [string]$c.Name; $aid = [string]$c.AutomationId
        } catch { $isMatch = $false }
        if ($isMatch -and $filterRole -and $role -notmatch $filterRole) { $isMatch = $false }
        if ($isMatch -and $filterName -and $name -notmatch $filterName) { $isMatch = $false }
        if ($isMatch -and $filterId -and $aid -notmatch $filterId) { $isMatch = $false }
        if ($isMatch) {
          # Unnamed zero-size Text nodes are provider noise (Chromium emits dozens);
          # they push the real targets out of the result list.
          $isNoise = ([string]::IsNullOrEmpty($name) -and $role -eq 'Text')
          if (-not $isNoise) { $found += (ConvertTo-Node $kid $childPath $withValue) }
        }
        $findStack.Push(@{ el = $kid; path = $childPath; depth = $frame.depth + 1 })
      }
    }
    return $found
  }

  if ($mode -eq 'tree' -or $mode -eq 'find') {
    $filterRole = ''; if ($spec.ContainsKey('role')) { $filterRole = [string]$spec['role'] }
    $filterName = ''; if ($spec.ContainsKey('name')) { $filterName = [string]$spec['name'] }
    $filterId = ''; if ($spec.ContainsKey('automationId')) { $filterId = [string]$spec['automationId'] }

    # Chromium pages are invisible to UIA until a client asks; wake the renderers first.
    $webContent = @{ renderers = 0; state = 'none'; waitedMs = 0 }
    $warm = -not ($spec.ContainsKey('webContent') -and $spec['webContent'] -eq $false)
    if ($warm) {
      try { $webContent = Start-ChromiumWebContent $handle 1600 } catch { }
    }

    # Chromium/Electron expose their accessibility tree only once a UIA client asks for it,
    # so a sparse first answer is normal: retry once after a short pause.
    $views = @()
    if ($view -eq 'auto') { $views = @('control', 'raw') } else { $views = @($view) }
    $target = if ($mode -eq 'tree') { 12 } else { 1 }
    $best = $null
    foreach ($v in $views) {
      Set-Walker $v
      for ($attempt = 1; $attempt -le 2; $attempt++) {
        if ($mode -eq 'tree') {
          $r = Build-Tree $root
          $score = $r.nodes
          if ($best -eq $null -or $score -gt $best.score) { $best = @{ score = $score; view = $v; payload = $r } }
        } else {
          $nodes = Find-Nodes $root
          $score = $nodes.Count
          if ($best -eq $null -or $score -gt $best.score) { $best = @{ score = $score; view = $v; payload = $nodes } }
        }
        if ($best.score -ge $target) { break }
        if ($attempt -lt 2) { Start-Sleep -Milliseconds 220 }
      }
      if ($best.score -ge $target) { break }
    }
    Set-Walker $best.view

    if ($mode -eq 'tree') {
      Write-Result @{
        ok   = $true
        data = @{
          h          = (Convert-Handle $handle)
          title      = [CuNative]::Title($handle)
          view       = $best.view
          webContent = $webContent
          nodes      = $best.payload.nodes
          truncated  = $best.payload.truncated
          tree       = $best.payload.tree
        }
      }
      return
    }

    # PowerShell collapses an empty array to $null: force an array here.
    $found = @()
    if ($best.payload) { $found = @($best.payload) }
    Write-Result @{
      ok   = $true
      data = @{
        h           = (Convert-Handle $handle)
        title       = [CuNative]::Title($handle)
        view        = $best.view
        webContent  = $webContent
        matches     = $found
        count       = $found.Count
        fingerprint = (($found | ForEach-Object { "$($_.p)|$($_.r)|$($_.n)" }) -join ';')
      }
    }
    return
  }

  if ($mode -ne 'act') { Fail "unknown uia.mode: $mode (tree / find / act)" }

  # ---------- act ----------
  $path = [string]$spec['path']
  if (-not $path) { Fail 'uia act requires path (the p field from tree/find)' }
  $action = 'invoke'; if ($spec.ContainsKey('action') -and $spec['action']) { $action = [string]$spec['action'] }
  $text = ''; if ($spec.ContainsKey('text')) { $text = [string]$spec['text'] }
  # Non-intrusive by default: never move the physical pointer or steal the foreground window.
  $intrusive = $false; if ($spec.ContainsKey('intrusive') -and $spec['intrusive']) { $intrusive = $true }

  # Paths are relative to the view that produced them; try the requested view first.
  $actViews = @()
  if ($view -eq 'auto') { $actViews = @('control', 'raw') } else { $actViews = @($view) }
  $element = $null
  $lastError = ''
  foreach ($v in $actViews) {
    Set-Walker $v
    try { $element = Resolve-Element $root $path; break } catch { $lastError = $_.Exception.Message; $element = $null }
  }
  if ($element -eq $null) { Fail $lastError }

  $before = ConvertTo-Node $element $path $true
  $detail = ''
  $isPassword = $false
  try { $isPassword = [bool]$element.Current.IsPassword } catch { }
  if (($action -eq 'setValue' -or $action -eq 'type') -and $isPassword) {
    Fail 'target element is a password field; writing is forbidden (hard red line)' @('Passwords, OTP codes and second factors must be entered by the user')
  }

  # Non-intrusive guarantee, made auditable: sample the pointer position around the action.
  $cursorBefore = New-Object CuNative+POINT
  [void][CuNative]::GetCursorPos([ref]$cursorBefore)
  $cursorAfter = New-Object CuNative+POINT
  $userFront = [CuNative]::GetForegroundWindow()
  $restoreReport = @{}

  switch ($action) {
    'invoke' {
      try { $p = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $p.Invoke() }
      catch { Fail "element does not support Invoke: $($_.Exception.Message)" @('try action=click instead') }
    }
    'select' {
      try { $p = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern); $p.Select() }
      catch { Fail "element does not support Select: $($_.Exception.Message)" }
    }
    'expand' {
      try { $p = $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern); $p.Expand() }
      catch { Fail "element does not support Expand: $($_.Exception.Message)" }
    }
    'collapse' {
      try { $p = $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern); $p.Collapse() }
      catch { Fail "element does not support Collapse: $($_.Exception.Message)" }
    }
    'toggle' {
      try { $p = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); $p.Toggle() }
      catch { Fail "element does not support Toggle: $($_.Exception.Message)" }
    }
    'focus' {
      # SetFocus pulls keyboard focus to this window; in non-intrusive mode the user keeps it.
      if (-not $intrusive) {
        Fail 'action=focus would take keyboard focus away from the user; in non-intrusive mode use invoke/setValue/select instead, or pass allowIntrusive=true'
      }
      $element.SetFocus()
    }
    'scrollIntoView' {
      try { $p = $element.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern); $p.ScrollIntoView() }
      catch { Fail "element does not support ScrollIntoView: $($_.Exception.Message)" }
    }
    'setValue' {
      try { $p = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $p.SetValue($text) }
      catch { Fail "element does not support SetValue: $($_.Exception.Message)" @('many UIs only accept real keystrokes: use action=type (non-intrusive types into the control window)') }
    }
    { $_ -in @('click', 'doubleClick', 'rightClick') } {
      $detail = Invoke-ElementActivate $element $before $action $intrusive $handle
    }
    'type' {
      if (-not $intrusive) {
        $detail = Invoke-ElementType $element $before $text
      } else {
        $element.SetFocus()
        Start-Sleep -Milliseconds 60
        $n = [CuNative]::TypeText($text)
        $detail = "typed-keystrokes=$n"
      }
    }
    default { Fail "unknown uia.action: $action" }
  }

  $settle = 220; if ($spec.ContainsKey('settleMs')) { $settle = [int]$spec['settleMs'] }
  Start-Sleep -Milliseconds $settle

  # An intrusive step borrowed the pointer and the foreground: give both back.
  if ($intrusive) {
    $moved = New-Object CuNative+POINT
    [void][CuNative]::GetCursorPos([ref]$moved)
    $restoreReport = Restore-Borrowed @{
      cursorAt = $cursorBefore
      movedAt  = $moved
      userFront = $userFront
      borrowed = $true
      target   = $handle
    }
    Start-Sleep -Milliseconds 80
  }

  [void][CuNative]::GetCursorPos([ref]$cursorAfter)
  $pointerMoved = ($cursorBefore.X -ne $cursorAfter.X) -or ($cursorBefore.Y -ne $cursorAfter.Y)

  $exists = $true
  try { $null = $element.Current.Name } catch { $exists = $false }
  $after = $null
  if ($exists) { $after = ConvertTo-Node $element $path $true }
  $changed = $true
  if ($exists -and $before -and $after) {
    $changed = ($before.n -ne $after.n) -or ($before.e -ne $after.e) -or ($before.o -ne $after.o)
    if (-not $changed -and $before.ContainsKey('v') -and $after.ContainsKey('v')) { $changed = ($before.v -ne $after.v) }
  }

  Write-Result @{
    ok   = $true
    data = @{
      path       = $path
      action     = $action
      detail     = $detail
      intrusive  = $intrusive
      verification = $(if ($changed) { 'observed' } else { 'sent' })
      restore    = $restoreReport
      cursor     = @{
        before      = @{ x = $cursorBefore.X; y = $cursorBefore.Y }
        after       = @{ x = $cursorAfter.X; y = $cursorAfter.Y }
        pointerMoved = [bool]$pointerMoved
      }
      exists     = $exists
      before     = $before
      after      = $after
      changed    = $changed
      foreground = (Get-WindowSnapshot ([CuNative]::GetForegroundWindow()))
    }
  }
}

# ---------------------------------------------------------------- verb: input
$script:VkMap = @{
  'CTRL' = 0x11; 'CONTROL' = 0x11; 'ALT' = 0x12; 'SHIFT' = 0x10; 'WIN' = 0x5B; 'LWIN' = 0x5B
  'ENTER' = 0x0D; 'RETURN' = 0x0D; 'TAB' = 0x09; 'ESC' = 0x1B; 'ESCAPE' = 0x1B; 'SPACE' = 0x20
  'BACKSPACE' = 0x08; 'DELETE' = 0x2E; 'DEL' = 0x2E; 'INSERT' = 0x2D; 'HOME' = 0x24; 'END' = 0x23
  'PAGEUP' = 0x21; 'PAGEDOWN' = 0x22; 'UP' = 0x26; 'DOWN' = 0x28; 'LEFT' = 0x25; 'RIGHT' = 0x27
  'CAPSLOCK' = 0x14; 'PRINTSCREEN' = 0x2C
  'F1' = 0x70; 'F2' = 0x71; 'F3' = 0x72; 'F4' = 0x73; 'F5' = 0x74; 'F6' = 0x75
  'F7' = 0x76; 'F8' = 0x77; 'F9' = 0x78; 'F10' = 0x79; 'F11' = 0x7A; 'F12' = 0x7B
}

function Get-Vk([string]$token) {
  $t = $token.Trim().ToUpperInvariant()
  if ($script:VkMap.ContainsKey($t)) { return [int]$script:VkMap[$t] }
  if ($t.Length -eq 1) {
    $code = [int][char]$t
    if (($code -ge 65 -and $code -le 90) -or ($code -ge 48 -and $code -le 57)) { return $code }
  }
  throw "unknown key token in combo: $token"
}

function Get-Prop($obj, [string]$name) {
  if ($obj -eq $null) { return $null }
  $p = $obj.PSObject.Properties[$name]
  if ($p) { return $p.Value }
  return $null
}

function Invoke-Input {
  Initialize-Uia
  $spec = Read-Spec
  $actions = $spec['actions']
  if (-not $actions) { Fail 'input requires an actions array' }
  if ($actions -isnot [array]) { $actions = @($actions) }
  $dryRun = $false
  if ($spec.ContainsKey('dryRun') -and $spec['dryRun']) { $dryRun = $true }

  $results = @()
  $i = 0
  $userFront = [CuNative]::GetForegroundWindow()
  $cursorBefore = New-Object CuNative+POINT
  [void][CuNative]::GetCursorPos([ref]$cursorBefore)
  foreach ($a in $actions) {
    $i++
    $type = [string]$a.type
    $entry = @{ i = $i; type = $type; ok = $false }
    try {
      switch ($type) {
        'activate' {
          $h = ConvertTo-Handle ([string]$a.h)
          $entry['ok'] = [bool][CuNative]::Activate($h)
          Start-Sleep -Milliseconds 180
          $entry['foreground'] = Get-WindowSnapshot ([CuNative]::GetForegroundWindow())
          if (-not $entry['ok']) { $entry['error'] = 'could not bring the target window to the foreground (foreground lock or UIPI)' }
        }
        'move' {
          $entry['ok'] = [bool][CuNative]::MoveTo([int]$a.x, [int]$a.y)
          if (-not $entry['ok']) { $entry['error'] = 'cursor move was refused; synthetic input is blocked for this process' }
        }
        'click' {
          $x = [int]$a.x; $y = [int]$a.y
          $button = [string](Get-Prop $a 'button'); if (-not $button) { $button = 'left' }
          $count = 1; $c = Get-Prop $a 'count'; if ($c) { $count = [int]$c }
          $expectRaw = [string](Get-Prop $a 'expectH')
          if ($expectRaw) {
            $expect = ConvertTo-Handle $expectRaw
            $pt = New-Object CuNative+POINT
            $pt.X = $x; $pt.Y = $y
            $hit = [CuNative]::WindowFromPoint($pt)
            $hitRoom = [CuNative]::RoomOf($hit)
            $entry['hitWindow'] = @{ h = (Convert-Handle $hitRoom); title = [CuNative]::Title($hitRoom) }
            if ($hitRoom -ne $expect -and -not [CuNative]::OwnedBy($hitRoom, $expect)) {
              $entry['error'] = "point $x,$y belongs to window $(Convert-Handle $hitRoom) ('$([CuNative]::Title($hitRoom))'), not the expected $expectRaw; blind coordinate click refused"
              break
            }
            if ($hitRoom -ne $expect) { $entry['detail'] = 'click landed on an owned popup of the target window' }
          }
          if ($dryRun) { $entry['ok'] = $true; $entry['detail'] = 'dryRun'; break }
          $entry['ok'] = [bool][CuNative]::Click($x, $y, $button, $count)
          if (-not $entry['ok']) { $entry['error'] = 'synthetic click was refused (UIPI or a secure desktop)' }
        }
        'scroll' {
          if ($dryRun) { $entry['ok'] = $true; $entry['detail'] = 'dryRun'; break }
          $entry['ok'] = [bool][CuNative]::Scroll([int]$a.x, [int]$a.y, [int]$a.delta)
        }
        'drag' {
          if ($dryRun) { $entry['ok'] = $true; $entry['detail'] = 'dryRun'; break }
          $entry['ok'] = [bool][CuNative]::Drag([int]$a.x1, [int]$a.y1, [int]$a.x2, [int]$a.y2)
        }
        'type' {
          $expectRaw = [string](Get-Prop $a 'expectH')
          $expect = [IntPtr]::Zero
          if ($expectRaw) { $expect = ConvertTo-Handle $expectRaw }
          if ($expect -ne [IntPtr]::Zero) {
            if (-not [CuNative]::Activate($expect)) {
              $entry['error'] = "could not bring the target window to the foreground; refusing to type blindly ($expectRaw)"
              break
            }
            Start-Sleep -Milliseconds 160
            $fgRoom = [CuNative]::RoomOf([CuNative]::GetForegroundWindow())
            if ($fgRoom -ne $expect) {
              $entry['error'] = "foreground window is $(Convert-Handle $fgRoom) ('$([CuNative]::Title($fgRoom))'), not the target $expectRaw; refusing to type blindly"
              break
            }
          }
          # Hard red line: never type into a focused password field.
          try {
            $fgEl = [System.Windows.Automation.AutomationElement]::FocusedElement
            if ($fgEl -ne $null -and [bool]$fgEl.Current.IsPassword) {
              $entry['error'] = 'the focused element is a password field; typing is forbidden (hard red line)'
              break
            }
          } catch { }
          if ($dryRun) { $entry['ok'] = $true; $entry['detail'] = 'dryRun'; break }
          $n = [CuNative]::TypeText([string]$a.text)
          $entry['ok'] = ($n -gt 0)
          $entry['detail'] = "typed=$n"
        }
        'key' {
          $expectRaw = [string](Get-Prop $a 'expectH')
          $expect = [IntPtr]::Zero
          if ($expectRaw) { $expect = ConvertTo-Handle $expectRaw }
          if ($expect -ne [IntPtr]::Zero) {
            if (-not [CuNative]::Activate($expect)) { $entry['error'] = 'could not focus the target window; refusing to send keys blindly'; break }
            Start-Sleep -Milliseconds 160
            if ([CuNative]::RoomOf([CuNative]::GetForegroundWindow()) -ne $expect) {
              $entry['error'] = 'foreground window is not the target window; refusing to send keys blindly'
              break
            }
          }
          $combo = [string]$a.combo
          $parts = $combo.Split('+')
          $mods = @(); $keys = @()
          for ($k = 0; $k -lt $parts.Count; $k++) {
            $vk = Get-Vk $parts[$k]
            if ($k -lt $parts.Count - 1) { $mods += $vk } else { $keys += $vk }
          }
          if ($dryRun) { $entry['ok'] = $true; $entry['detail'] = "dryRun mods=$($mods -join ',') keys=$($keys -join ',')"; break }
          $n = [CuNative]::KeyCombo([int[]]$mods, [int[]]$keys)
          $entry['ok'] = ($n -gt 0)
          $entry['detail'] = "keys=$combo"
        }
        default { $entry['error'] = "unknown input.type: $type" }
      }
    } catch {
      $entry['ok'] = $false
      $entry['error'] = $_.Exception.Message
    }
    $results += $entry
    if (-not $entry['ok']) { break }
    Assert-NotStopped
    Start-Sleep -Milliseconds 60
  }

  $okAll = $true
  foreach ($r in $results) { if (-not $r['ok']) { $okAll = $false } }
  $last = $results[$results.Count - 1]

  # This verb borrows the real pointer and keyboard, so always give them back.
  $restoreReport = @{}
  if ($results.Count -gt 0) {
    $moved = New-Object CuNative+POINT
    [void][CuNative]::GetCursorPos([ref]$moved)
    $restoreReport = Restore-Borrowed @{
      cursorAt  = $cursorBefore
      movedAt   = $moved
      userFront = $userFront
      borrowed  = $true
      target    = [IntPtr]::Zero
    }
  }

  $payload = @{
    ok   = $okAll
    data = @{
      results    = $results
      done       = $results.Count
      total      = $actions.Count
      verification = $(if ($okAll) { 'sent' } else { 'failed' })
      restore    = $restoreReport
      foreground = (Get-WindowSnapshot ([CuNative]::GetForegroundWindow()))
    }
  }
  if (-not $okAll -and $last.ContainsKey('error')) { $payload['error'] = $last['error'] }
  Write-Result $payload
}

# ---------------------------------------------------------------- verb: spawn
# Launch an app the way the shell would (PATH / App Paths / associations), from the
# same PowerShell context as the rest of the desktop automation.
function Invoke-Spawn {
  $spec = Read-Spec
  $exe = [string]$spec['exe']
  if (-not $exe) { Fail 'spawn requires exe' }
  $rawArgs = @()
  if ($spec['args']) { $rawArgs = @($spec['args']) }
  $quoted = @()
  foreach ($a in $rawArgs) {
    $text = [string]$a
    if ($text -match '\s' -and -not ($text.StartsWith('"') -and $text.EndsWith('"'))) {
      $quoted += ('"' + $text + '"')
    } else {
      $quoted += $text
    }
  }
  try {
    if ($quoted.Count -gt 0) {
      $proc = Start-Process -FilePath $exe -ArgumentList $quoted -WindowStyle Normal -PassThru -ErrorAction Stop
    } else {
      $proc = Start-Process -FilePath $exe -WindowStyle Normal -PassThru -ErrorAction Stop
    }
  } catch {
    Fail "cannot start $exe : $($_.Exception.Message)" @('give an absolute path, or a name that exists in PATH')
  }
  Start-Sleep -Milliseconds 200
  $exited = $true
  try { $exited = $proc.HasExited } catch { }
  Write-Result @{
    ok   = $true
    data = @{
      pid      = [int]$proc.Id
      exe      = $exe
      hasExited = [bool]$exited
    }
  }
}

# ---------------------------------------------------------------- verb: hit
# Which window owns this screen point? Lets the caller bind a blind coordinate
# click to a concrete window before injecting input.
function Invoke-HitTest {
  $spec = Read-Spec
  $pt = New-Object CuNative+POINT
  $pt.X = [int]$spec['x']; $pt.Y = [int]$spec['y']
  $hit = [CuNative]::WindowFromPoint($pt)
  $room = [CuNative]::RoomOf($hit)
  Write-Result @{
    ok   = $true
    data = @{
      x       = $pt.X
      y       = $pt.Y
      h       = (Convert-Handle $hit)
      room    = (Convert-Handle $room)
      title   = [CuNative]::Title($room)
      cls     = [CuNative]::ClassName($room)
      window  = (Get-WindowSnapshot $room)
    }
  }
}

# ---------------------------------------------------------------- verb: window
function Invoke-WindowVerb {
  $spec = Read-Spec
  $h = ConvertTo-Handle ([string]$spec['h'])
  if ($h -eq [IntPtr]::Zero) { Fail 'window requires h' }
  if (-not [CuNative]::IsWindow($h)) { Fail "window handle is invalid or closed: $($spec['h'])" }
  $action = 'activate'
  if ($spec.ContainsKey('action') -and $spec['action']) { $action = [string]$spec['action'] }
  $before = Get-WindowSnapshot $h
  $detail = ''
  switch ($action) {
    'activate' { $detail = "activated=$([CuNative]::Activate($h))" }
    'minimize' { $detail = "shown=$([CuNative]::ShowWindow($h, 6))" }
    'maximize' { $detail = "shown=$([CuNative]::ShowWindow($h, 3))" }
    'restore' { $detail = "shown=$([CuNative]::ShowWindow($h, 9))" }
    'show' {
      # SW_SHOWNOACTIVATE + SWP_NOACTIVATE: make a just-launched window visible and raised
      # WITHOUT taking the foreground, so the user keeps their focus and typing.
      [void][CuNative]::ShowWindow($h, 4)
      [void][CuNative]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x0053)
      $detail = 'shown without activating'
    }
    'close' {
      # Structured close: prefer the UI Automation WindowPattern, fall back to WM_CLOSE.
      $closed = $false
      try {
        Initialize-Uia
        $el = [System.Windows.Automation.AutomationElement]::FromHandle($h)
        $wp = $el.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
        $wp.Close()
        $closed = $true
        $detail = 'closed via WindowPattern'
      } catch {
        [void][CuNative]::PostMessageW($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
        $detail = 'sent WM_CLOSE'
      }
    }
    default { Fail "unknown window.action: $action (activate / minimize / maximize / restore / close)" }
  }
  Start-Sleep -Milliseconds 200
  Write-Result @{
    ok   = $true
    data = @{
      action     = $action
      detail     = $detail
      before     = $before
      after      = (Get-WindowSnapshot $h)
      foreground = (Get-WindowSnapshot ([CuNative]::GetForegroundWindow()))
    }
  }
}

# ---------------------------------------------------------------- verb: activate
function Invoke-ActivateVerb {
  $spec = Read-Spec
  $h = ConvertTo-Handle ([string]$spec['h'])
  if ($h -eq [IntPtr]::Zero) { Fail 'activate requires h' }
  $ok = [bool][CuNative]::Activate($h)
  Start-Sleep -Milliseconds 160
  Write-Result @{
    ok   = $true
    data = @{
      activated  = $ok
      foreground = (Get-WindowSnapshot ([CuNative]::GetForegroundWindow()))
    }
  }
}

# ---------------------------------------------------------------- verb: wait
# Poll a condition inside ONE process: waiting across separate calls would pay the
# PowerShell start-up cost on every poll. The stop marker aborts the wait too.
function Invoke-Wait {
  $spec = Read-Spec
  $kind = 'window'; if ($spec.ContainsKey('kind') -and $spec['kind']) { $kind = [string]$spec['kind'] }
  $timeoutMs = 15000; if ($spec.ContainsKey('timeoutMs')) { $timeoutMs = [int]$spec['timeoutMs'] }
  $pollMs = 250; if ($spec.ContainsKey('pollMs')) { $pollMs = [int]$spec['pollMs'] }
  if ($timeoutMs -lt 500) { $timeoutMs = 500 }
  if ($timeoutMs -gt 300000) { $timeoutMs = 300000 }

  $titlePattern = ''; if ($spec.ContainsKey('title')) { $titlePattern = [string]$spec['title'] }
  $path = ''; if ($spec.ContainsKey('path')) { $path = [string]$spec['path'] }
  $wantGone = ($spec.ContainsKey('gone') -and $spec['gone'])
  $rolePattern = ''; if ($spec.ContainsKey('role')) { $rolePattern = [string]$spec['role'] }
  $namePattern = ''; if ($spec.ContainsKey('name')) { $namePattern = [string]$spec['name'] }

  if ($kind -eq 'window' -and -not $titlePattern) { Fail 'wait kind=window requires title (a regular expression)' }
  if ($kind -eq 'file' -and -not $path) { Fail 'wait kind=file requires path' }
  if ($kind -eq 'control' -and -not $rolePattern -and -not $namePattern) { Fail 'wait kind=control requires role and/or name' }

  if ($kind -eq 'control') { Initialize-Uia }
  $watch = [System.Diagnostics.Stopwatch]::StartNew()

  function Test-Condition {
    switch ($kind) {
      'window' {
        foreach ($h in [CuNative]::TopLevel()) {
          if (-not [CuNative]::IsWindowVisible($h)) { continue }
          $t = [CuNative]::Title($h)
          if ($t.Length -eq 0) { continue }
          if ($t -match $titlePattern) {
            if ($wantGone) { return $null }
            return (Get-WindowSnapshot $h)
          }
        }
        return $null
      }
      'file' {
        $exists = Test-Path -LiteralPath $path
        if ($wantGone) { if (-not $exists) { return @{ path = $path; exists = $false } } return $null }
        if (-not $exists) { return $null }
        try {
          $item = Get-Item -LiteralPath $path -ErrorAction Stop
          return @{ path = $item.FullName; exists = $true; size = $item.Length; isDir = $item.PSIsContainer }
        } catch { return @{ path = $path; exists = $true } }
      }
      'control' {
        $handle = ConvertTo-Handle ([string]$spec['h'])
        if ($handle -eq [IntPtr]::Zero -or -not [CuNative]::IsWindow($handle)) { return $null }
        try { $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle) } catch { return $null }
        if ($root -eq $null) { return $null }
        $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
        $stack = New-Object System.Collections.Stack
        $stack.Push(@{ el = $root; path = 'root'; depth = 0 })
        $visited = 0
        while ($stack.Count -gt 0 -and $visited -lt 700) {
          $visited++
          $frame = $stack.Pop()
          if ($frame.depth -ge 12) { continue }
          try { $child = $walker.GetFirstChild($frame.el) } catch { $child = $null }
          $i = 0
          while ($null -ne $child) {
            $childPath = if ($frame.path -eq 'root') { "$i" } else { "$($frame.path)/$i" }
            $i++
            $role = ''; $name = ''
            try { $role = Get-RoleName $child; $name = [string]$child.Current.Name } catch { }
            $match = $true
            if ($rolePattern -and $role -notmatch $rolePattern) { $match = $false }
            if ($match -and $namePattern -and $name -notmatch $namePattern) { $match = $false }
            if ($match -and ($rolePattern -or $namePattern)) {
              $node = ConvertTo-Node $child $childPath $false
              $node['h'] = (Convert-Handle $handle)
              return $node
            }
            $stack.Push(@{ el = $child; path = $childPath; depth = $frame.depth + 1 })
            try { $child = $walker.GetNextSibling($child) } catch { break }
          }
        }
        return $null
      }
      default { Fail "unknown wait.kind: $kind (window / control / file)" }
    }
  }

  while ($watch.ElapsedMilliseconds -lt $timeoutMs) {
    Assert-NotStopped
    $found = Test-Condition
    if ($found) {
      Write-Result @{
        ok   = $true
        data = @{ kind = $kind; waitedMs = [int]$watch.ElapsedMilliseconds; found = $found }
      }
      return
    }
    # A "gone" condition already returned above when it was satisfied.
    Start-Sleep -Milliseconds $pollMs
  }

  Write-Result @{
    ok   = $false
    data = @{ kind = $kind; waitedMs = [int]$watch.ElapsedMilliseconds; found = $null; timedOut = $true }
  }
}

# ---------------------------------------------------------------- verb: confirm
function Invoke-Confirm {
  $spec = Read-Spec
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $digest = [string]$spec['digest']

  # Fail closed: without an interactive desktop there is no human to ask.
  if (-not [System.Environment]::UserInteractive) {
    Write-Result @{ ok = $true; data = @{ choice = 'unavailable'; reason = 'no interactive desktop'; digest = $digest; elapsedMs = 0 } }
    return
  }

  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
  Add-Type -AssemblyName System.Drawing -ErrorAction Stop
  [System.Windows.Forms.Application]::EnableVisualStyles()

  $labels = $spec['labels']
  function L([string]$key, [string]$fallback) {
    $v = Get-Prop $labels $key
    if ($v) { return [string]$v }
    return $fallback
  }

  $timeoutMs = 30000
  if ($spec['timeoutMs']) { $timeoutMs = [int]$spec['timeoutMs'] }
  $items = @()
  if ($spec['itemsPreview']) { $items = @($spec['itemsPreview']) }
  $itemsTotal = 0
  if ($spec['itemsTotal']) { $itemsTotal = [int]$spec['itemsTotal'] }

  $level = [string]$spec['level']
  $levelText = L 'levelText' $level

  $form = New-Object System.Windows.Forms.Form
  $form.Text = L 'windowTitle' 'Confirm high-risk action'
  $form.FormBorderStyle = 'FixedDialog'
  $form.StartPosition = 'CenterScreen'
  $form.TopMost = $true
  $form.ShowInTaskbar = $true
  $form.MinimizeBox = $false
  $form.MaximizeBox = $false
  $form.ClientSize = New-Object System.Drawing.Size 660, 448
  $form.AutoScaleMode = 'Dpi'
  $form.BackColor = [System.Drawing.Color]::FromArgb(250, 250, 252)

  $header = New-Object System.Windows.Forms.Label
  $header.Text = L 'header' 'High-risk action pending confirmation'
  $header.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 15, [System.Drawing.FontStyle]::Bold)
  $header.ForeColor = [System.Drawing.Color]::FromArgb(170, 30, 30)
  $header.AutoSize = $true
  $header.Location = New-Object System.Drawing.Point 22, 18
  $form.Controls.Add($header)

  $badge = New-Object System.Windows.Forms.Label
  $badge.Text = $levelText
  $badge.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9, [System.Drawing.FontStyle]::Bold)
  $badge.ForeColor = [System.Drawing.Color]::White
  $badge.BackColor = [System.Drawing.Color]::FromArgb(170, 30, 30)
  $badge.Padding = New-Object System.Windows.Forms.Padding(8, 3, 8, 3)
  $badge.AutoSize = $true
  $badge.Location = New-Object System.Drawing.Point 24, 62
  $form.Controls.Add($badge)

  $sep = New-Object System.Windows.Forms.Panel
  $sep.BackColor = [System.Drawing.Color]::FromArgb(210, 210, 216)
  $sep.Size = New-Object System.Drawing.Size 612, 1
  $sep.Location = New-Object System.Drawing.Point 24, 96
  $form.Controls.Add($sep)

  $fields = @(
    @{ k = (L 'action' 'Action'); v = [string]$spec['action'] },
    @{ k = (L 'scope' 'Scope'); v = [string]$spec['scope'] },
    @{ k = (L 'impact' 'Impact'); v = [string]$spec['impact'] },
    @{ k = (L 'undo' 'Undo'); v = [string]$spec['undo'] }
  )
  $y = 108
  foreach ($f in $fields) {
    $kl = New-Object System.Windows.Forms.Label
    $kl.Text = $f.k
    $kl.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9, [System.Drawing.FontStyle]::Bold)
    $kl.AutoSize = $false
    $kl.TextAlign = 'TopLeft'
    $kl.Size = New-Object System.Drawing.Size 60, 22
    $kl.Location = New-Object System.Drawing.Point 24, $y
    $form.Controls.Add($kl)

    $vl = New-Object System.Windows.Forms.Label
    $vl.Text = $f.v
    $vl.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
    $vl.AutoSize = $true
    $vl.MaximumSize = New-Object System.Drawing.Size 528, 0
    $vl.Location = New-Object System.Drawing.Point 92, $y
    $form.Controls.Add($vl)
    $y = $y + [Math]::Max(26, $vl.PreferredHeight + 8)
  }

  if ($itemsTotal -gt 0 -or $items.Count -gt 0) {
    $countLabel = New-Object System.Windows.Forms.Label
    $countLabel.Text = (L 'items' 'Affected objects') + ": $itemsTotal"
    $countLabel.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
    $countLabel.ForeColor = [System.Drawing.Color]::FromArgb(80, 80, 90)
    $countLabel.AutoSize = $true
    $countLabel.Location = New-Object System.Drawing.Point 92, $y
    $form.Controls.Add($countLabel)
  }

  $countdown = New-Object System.Windows.Forms.Label
  $countdown.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  $countdown.ForeColor = [System.Drawing.Color]::FromArgb(130, 70, 20)
  $countdown.AutoSize = $true
  $countdown.Location = New-Object System.Drawing.Point 24, 372
  $form.Controls.Add($countdown)

  # Cancel sits at the far right; Execute is separated from it by a gap and is never
  # the highlighted default. Default focus goes to Cancel.
  $bCancel = New-Object System.Windows.Forms.Button
  $bCancel.Text = L 'cancel' 'Cancel'
  $bCancel.Size = New-Object System.Drawing.Size 116, 36
  $bCancel.Location = New-Object System.Drawing.Point 520, 396
  $bCancel.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  $form.Controls.Add($bCancel)

  $bView = New-Object System.Windows.Forms.Button
  $bView.Text = L 'view' 'View list'
  $bView.Size = New-Object System.Drawing.Size 116, 36
  $bView.Location = New-Object System.Drawing.Point 24, 396
  $bView.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  $bView.Enabled = ($items.Count -gt 0 -or $itemsTotal -gt 0)
  $form.Controls.Add($bView)

  $bGo = New-Object System.Windows.Forms.Button
  $bGo.Text = L 'execute' 'Execute'
  $bGo.Size = New-Object System.Drawing.Size 116, 36
  $bGo.Location = New-Object System.Drawing.Point 388, 396
  $bGo.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9, [System.Drawing.FontStyle]::Bold)
  $bGo.ForeColor = [System.Drawing.Color]::FromArgb(150, 30, 30)
  $bGo.Enabled = $false
  $form.Controls.Add($bGo)

  $form.AcceptButton = $bCancel
  $form.CancelButton = $bCancel
  $form.ActiveControl = $bCancel

  # Reference-type state: script-block assignments do not flow back to function locals.
  $state = @{
    choice   = 'cancel'
    paused   = $false
    cooldown = 12
    remain   = [int]($timeoutMs / 1000)
  }

  $bCancel.Add_Click({ $state.choice = 'cancel'; $form.Close() })
  $bGo.Add_Click({ $state.choice = 'execute'; $form.Close() })
  $bView.Add_Click({
    $state.paused = $true
    $listForm = New-Object System.Windows.Forms.Form
    $listForm.Text = (L 'listTitle' 'Affected items') + " - 20 / $itemsTotal"
    $listForm.Size = New-Object System.Drawing.Size 720, 470
    $listForm.StartPosition = 'CenterParent'
    $listForm.TopMost = $true
    $listForm.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
    $tbx = New-Object System.Windows.Forms.TextBox
    $tbx.Multiline = $true
    $tbx.ScrollBars = 'Vertical'
    $tbx.ReadOnly = $true
    $tbx.WordWrap = $false
    $tbx.Dock = 'Fill'
    $tbx.Font = New-Object System.Drawing.Font('Consolas', 9)
    $show = @()
    $n = 0
    foreach ($it in $items) {
      if ($n -ge 20) { break }
      $show += [string]$it
      $n++
    }
    $body = ($show -join "`r`n")
    if ($itemsTotal -gt $show.Count) { $body += "`r`n`r`n" + (L 'moreItems' 'more items not expanded here') + ": $($itemsTotal - $show.Count)" }
    $tbx.Text = $body
    $listForm.Controls.Add($tbx)
    [void]$listForm.ShowDialog($form)
    $state.paused = $false
  })

  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 1000
  $timer.Add_Tick({
    # The user can end the wait with the stop button or Esc as well as with Cancel.
    if (Test-StopRequested) { $state.choice = 'cancel'; $form.Close(); return }
    if ($state.cooldown -gt 0) {
      $state.cooldown--
      if ($state.cooldown -eq 0) { $bGo.Enabled = $true; $bGo.Text = (L 'execute' 'Execute') }
    }
    if ($state.paused) { return }
    $state.remain--
    if ($state.remain -le 0) {
      $state.choice = 'timeout_denied'
      $form.Close()
      return
    }
    $countdown.Text = "$($state.remain)" + (L 'timeoutHint' ' s: no input means deny')
  })
  $countdown.Text = "$($state.remain)" + (L 'timeoutHint' ' s: no input means deny')
  $form.Add_Shown({
    # The helper process is started hidden, and children inherit SW_HIDE: without this
    # the dialog would be invisible while its timer still ran to "timeout_denied".
    try { [CuNative]::ForceShowTopMost($form.Handle) } catch { }
    $form.Activate()
    $form.ActiveControl = $bCancel
  })
  $timer.Start()

  try {
    [void]$form.ShowDialog()
  } catch {
    $timer.Stop()
    $form.Dispose()
    Write-Result @{ ok = $true; data = @{ choice = 'unavailable'; reason = $_.Exception.Message; digest = $digest; elapsedMs = $sw.ElapsedMilliseconds } }
    return
  }
  $timer.Stop()
  $form.Dispose()
  $sw.Stop()

  Write-Result @{
    ok   = $true
    data = @{
      choice    = $state.choice
      digest    = $digest
      elapsedMs = $sw.ElapsedMilliseconds
    }
  }
}

# ---------------------------------------------------------------- dispatch
try {
  Initialize-Native
  Initialize-Dpi
  switch ($Verb) {
    'probe' { Invoke-Probe }
    'windows' { Invoke-Windows }
    'shot' { Invoke-Shot }
    'ocr' { Invoke-OcrOnly }
    'uia' { Invoke-Uia }
    'input' { Invoke-Input }
    'wait' { Invoke-Wait }
    'confirm' { Invoke-Confirm }
    'window' { Invoke-WindowVerb }
    'hit' { Invoke-HitTest }
    'spawn' { Invoke-Spawn }
    'activate' { Invoke-ActivateVerb }
    default { Fail "unknown verb: $Verb (probe / windows / shot / ocr / uia / input / wait / confirm / window / hit / spawn / activate)" }
  }
} catch {
  $msg = $_.Exception.Message
  if ($_.Exception.InnerException) { $msg = $msg + ' :: ' + $_.Exception.InnerException.Message }
  try { Write-Result @{ ok = $false; error = $msg; verb = $Verb } } catch { }
  exit 1
}
