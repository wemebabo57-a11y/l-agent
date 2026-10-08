/**
 * 屏幕读取与输入模拟。
 *
 * 不引入任何原生 npm 依赖：截图与输入都通过 spawn 系统自带工具完成。
 * - Windows：PowerShell + Add-Type 内联 P/Invoke（SendInput / SetCursorPos / GetForegroundWindow）
 * - macOS：screencapture / osascript
 * - Linux：gnome-screenshot（或 scrot / import）+ xdotool
 *
 * 所有对外方法返回结构化结果，平台不支持时给出明确原因而不是抛原生错误。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ActiveWindowInfo, CapabilityReport, ScreenInfo, ScreenSnapshot } from '@shared/types'

export type { CapabilityReport }

export class ScreenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScreenError'
  }
}

export interface RunOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** PowerShell 脚本包一层，避免中文输出被按 ANSI 解码成乱码 */
function psEncodedCommand(script: string): string[] {
  const wrapped = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;${script}`
  const b64 = Buffer.from(wrapped, 'utf16le').toString('base64')
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    b64
  ]
}

function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 15000
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, signal: opts.signal })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => {
      stdout += d
      if (stdout.length > 4_000_000) {
        stdout = stdout.slice(0, 4_000_000)
        child.kill()
      }
    })
    child.stderr?.on('data', (d: string) => {
      stderr += d.slice(0, 8000)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

/* ------------------------------------------------------------------ */
/* Windows 输入模拟：SendInput / SetCursorPos                          */
/* ------------------------------------------------------------------ */

/**
 * 一段常驻的 Add-Type 定义。每次都内联发送会重复编译导致明显延迟，
 * 因此把定义写成常量，由调用脚本自己 include。
 *
 * INPUT 必须是 type + 联合体的形式。曾把联合体写成单个 mi 字段、
 * 又在键盘方法里访问 i.kb，导致整段 C# 编译失败——因为 Add-Type 失败
 * 只体现在退出码上，表现是「点击和截图全都不工作」，排查成本很高。
 * 这里用 Explicit 布局的 InputUnion，x86/x64 的偏移都自动正确。
 */
const WIN_INPUT_PRELUDE = `
Add-Type -AssemblyName System.Windows.Forms
if (-not ([System.Management.Automation.PSTypeName]'LagentInput').Type) {
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class LagentInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx, dy; public uint mouseData, dwFlags, time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public InputUnion U;
  }

  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  public const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
  public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
  public const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000;
  public const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

  static INPUT Mouse(uint flags) {
    INPUT i = new INPUT();
    i.type = INPUT_MOUSE;
    i.U.mi.dwFlags = flags;
    return i;
  }

  static INPUT Wheel(uint flags, int delta) {
    INPUT i = new INPUT();
    i.type = INPUT_MOUSE;
    i.U.mi.dwFlags = flags;
    i.U.mi.mouseData = (uint)delta;
    return i;
  }

  static INPUT Key(ushort vk, uint flags) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.U.ki.wVk = vk;
    i.U.ki.dwFlags = flags;
    return i;
  }

  static INPUT Uni(ushort ch, uint flags) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.U.ki.wScan = ch;
    i.U.ki.dwFlags = flags | KEYEVENTF_UNICODE;
    return i;
  }

  static int Sz() { return Marshal.SizeOf(typeof(INPUT)); }

  public static void Click(int x, int y, string button, int count) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(40);
    for (int n = 0; n < count; n++) {
      uint down = MOUSEEVENTF_LEFTDOWN, up = MOUSEEVENTF_LEFTUP;
      if (button == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
      else if (button == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }
      SendInput(1, new INPUT[] { Mouse(down) }, Sz());
      System.Threading.Thread.Sleep(35);
      SendInput(1, new INPUT[] { Mouse(up) }, Sz());
      System.Threading.Thread.Sleep(90);
    }
  }

  public static void MoveTo(int x, int y) { SetCursorPos(x, y); }

  public static void Scroll(int amount) {
    SendInput(1, new INPUT[] { Wheel(MOUSEEVENTF_WHEEL, amount) }, Sz());
  }

  public static void KeyDown(ushort vk) { SendInput(1, new INPUT[] { Key(vk, 0) }, Sz()); }
  public static void KeyUp(ushort vk) { SendInput(1, new INPUT[] { Key(vk, KEYEVENTF_KEYUP) }, Sz()); }

  public static void LeftDown() { SendInput(1, new INPUT[] { Mouse(MOUSEEVENTF_LEFTDOWN) }, Sz()); }
  public static void LeftUp() { SendInput(1, new INPUT[] { Mouse(MOUSEEVENTF_LEFTUP) }, Sz()); }

  public static void TypeText(string text) {
    foreach (char c in text) {
      SendInput(1, new INPUT[] { Uni(c, 0) }, Sz());
      System.Threading.Thread.Sleep(12);
      SendInput(1, new INPUT[] { Uni(c, KEYEVENTF_KEYUP) }, Sz());
      System.Threading.Thread.Sleep(18);
    }
  }

  public static string Foreground() {
    IntPtr h = GetForegroundWindow();
    System.Text.StringBuilder sb = new System.Text.StringBuilder(512);
    GetWindowTextW(h, sb, 512);
    RECT r; GetWindowRect(h, out r);
    return sb.ToString() + "|" + r.Left + "," + r.Top + "," + (r.Right - r.Left) + "," + (r.Bottom - r.Top);
  }
}
"@
}
`

/** 鼠标按钮名 → Windows 事件常量（由 PowerShell 侧映射，这里只做合法性校验） */
const BUTTONS = new Set(['left', 'right', 'middle'])

/** 常用键名 → Windows 虚拟键码 */
const VK: Record<string, number> = {
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  escape: 0x1b,
  esc: 0x1b,
  space: 0x20,
  backspace: 0x08,
  delete: 0x2e,
  del: 0x2e,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  shift: 0x10,
  ctrl: 0x11,
  control: 0x11,
  alt: 0x12,
  win: 0x5b,
  f1: 0x70,
  f2: 0x71,
  f3: 0x72,
  f4: 0x73,
  f5: 0x74,
  f6: 0x75,
  f7: 0x76,
  f8: 0x77,
  f9: 0x78,
  f10: 0x79,
  f11: 0x7a,
  f12: 0x7b
}

export function resolveVirtualKey(name: string): number | null {
  const key = name.trim().toLowerCase()
  if (VK[key] != null) return VK[key]
  // 单字符：字母与数字直接映射 ASCII
  if (key.length === 1) {
    const c = key.toUpperCase().charCodeAt(0)
    if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a)) return c
  }
  return null
}

/* ------------------------------------------------------------------ */
/* 工具可用性探测                                                      */
/* ------------------------------------------------------------------ */

async function hasCommand(cmd: string): Promise<boolean> {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  try {
    const r = await run(finder, [cmd], { timeoutMs: 4000 })
    return r.code === 0
  } catch {
    return false
  }
}

let linuxShotTool: string | null | undefined

/** Linux 上挑一个可用的截图工具；结果缓存，避免每次截图都探测 */
async function pickLinuxShotTool(): Promise<string | null> {
  if (linuxShotTool !== undefined) return linuxShotTool
  for (const tool of ['gnome-screenshot', 'scrot', 'import', 'grim', 'spectacle']) {
    if (await hasCommand(tool)) {
      linuxShotTool = tool
      return tool
    }
  }
  linuxShotTool = null
  return null
}

/** 探测当前平台能做什么，供设置页展示与工具内快速失败 */
export async function probeCapabilities(): Promise<CapabilityReport> {
  if (process.platform === 'win32') {
    return { capture: true, input: true, note: 'Windows：支持截图与鼠标键盘模拟（PowerShell + Win32 API）' }
  }
  if (process.platform === 'darwin') {
    const shot = await hasCommand('screencapture')
    const osa = await hasCommand('osascript')
    return {
      capture: shot,
      input: osa,
      note: [
        shot ? '截图可用（screencapture）' : '截图不可用：缺少 screencapture',
        osa ? '输入模拟可用（osascript）' : '输入模拟不可用：缺少 osascript',
        '首次使用需在「系统设置 → 隐私与安全性 → 辅助功能 / 屏幕录制」中授权本应用'
      ].join('；')
    }
  }
  const shot = await pickLinuxShotTool()
  const xdo = await hasCommand('xdotool')
  return {
    capture: Boolean(shot),
    input: xdo,
    note: [
      shot ? `截图可用（${shot}）` : '截图不可用：请安装 gnome-screenshot / scrot / imagemagick',
      xdo ? '输入模拟可用（xdotool）' : '输入模拟不可用：请安装 xdotool',
      'Wayland 会话下这些工具通常受限，建议改用 X11 会话'
    ].join('；')
  }
}

/* ------------------------------------------------------------------ */
/* 屏幕枚举与截图                                                      */
/* ------------------------------------------------------------------ */

/**
 * 枚举显示器。Windows 走 PowerShell 查询 WMI，
 * 其他平台返回单个"虚拟全屏"，因为下游截图工具本身就会抓全部屏幕。
 */
export async function listDisplays(): Promise<ScreenInfo[]> {
  if (process.platform !== 'win32') {
    return [{ id: 0, label: '主屏幕', bounds: { x: 0, y: 0, width: 0, height: 0 }, scaleFactor: 1, primary: true }]
  }
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$i = 0
$out = @()
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  $out += [pscustomobject]@{
    id = $i
    label = $s.DeviceName
    x = $s.Bounds.X; y = $s.Bounds.Y
    width = $s.Bounds.Width; height = $s.Bounds.Height
    primary = $s.Primary
  }
  $i++
}
$out | ConvertTo-Json -Compress
`
  try {
    const r = await run('powershell.exe', psEncodedCommand(script), { timeoutMs: 15000 })
    if (r.code !== 0) throw new ScreenError(r.stderr.trim() || '枚举显示器失败')
    const raw = JSON.parse(r.stdout.trim() || '[]') as
      | { id: number; label: string; x: number; y: number; width: number; height: number; primary: boolean }
      | { id: number; label: string; x: number; y: number; width: number; height: number; primary: boolean }[]
    const list = Array.isArray(raw) ? raw : [raw]
    return list.map((s) => ({
      id: s.id,
      label: s.label || `显示器 ${s.id + 1}`,
      bounds: { x: s.x, y: s.y, width: s.width, height: s.height },
      scaleFactor: 1,
      primary: s.primary
    }))
  } catch (e) {
    if (e instanceof ScreenError) throw e
    throw new ScreenError(`枚举显示器失败：${(e as Error).message}`)
  }
}

/** 当前前台窗口。用于屏幕操作白名单与给模型提供定位上下文 */
export async function activeWindow(): Promise<ActiveWindowInfo | null> {
  try {
    if (process.platform === 'win32') {
      const script = `${WIN_INPUT_PRELUDE}
Write-Output ([LagentInput]::Foreground())
`
      const r = await run('powershell.exe', psEncodedCommand(script), { timeoutMs: 15000 })
      if (r.code !== 0) return null
      const [title, rect] = r.stdout.trim().split('|')
      const b = (rect ?? '').split(',').map(Number)
      return {
        title: (title ?? '').trim(),
        processName: null,
        bounds:
          b.length === 4 && b.every((n) => Number.isFinite(n))
            ? { x: b[0], y: b[1], width: b[2], height: b[3] }
            : null
      }
    }
    if (process.platform === 'darwin') {
      const r = await run(
        'osascript',
        ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'],
        { timeoutMs: 8000 }
      )
      return r.code === 0 ? { title: r.stdout.trim(), processName: null, bounds: null } : null
    }
    const r = await run('xdotool', ['getactivewindow', 'getwindowname'], { timeoutMs: 5000 })
    return r.code === 0 ? { title: r.stdout.trim(), processName: null, bounds: null } : null
  } catch {
    return null
  }
}

export interface CaptureOptions {
  displayId?: number | null
  /** 最长边像素上限，超过则等比缩小 */
  maxEdge?: number
  signal?: AbortSignal
}

/**
 * 截图并返回 PNG base64。
 *
 * 缩放交给系统工具完成（Windows 用 .NET Bitmap / Linux 用 ImageMagick），
 * 从而不必在 Node 侧解码 PNG——那需要额外依赖。
 */
export async function captureScreen(opts: CaptureOptions = {}): Promise<ScreenSnapshot> {
  const maxEdge = Math.max(320, Math.min(opts.maxEdge ?? 1600, 4096))
  const tmp = path.join(os.tmpdir(), `lagent-shot-${randomUUID()}.png`)

  try {
    if (process.platform === 'win32') {
      return await captureWindows(tmp, opts.displayId ?? null, maxEdge, opts.signal)
    }
    if (process.platform === 'darwin') {
      return await captureMac(tmp, maxEdge, opts.signal)
    }
    return await captureLinux(tmp, maxEdge, opts.signal)
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
  }
}

async function finishSnapshot(
  file: string,
  displayId: number,
  originX: number,
  originY: number,
  scale: number,
  imageWidth: number,
  imageHeight: number
): Promise<ScreenSnapshot> {
  const buf = await fs.readFile(file)
  if (!buf.length) throw new ScreenError('截图文件为空')
  return {
    id: randomUUID(),
    displayId,
    width: imageWidth,
    height: imageHeight,
    originX,
    originY,
    scale,
    capturedAt: Date.now(),
    mediaType: 'image/png',
    data: buf.toString('base64')
  }
}

async function captureWindows(
  file: string,
  displayId: number | null,
  maxEdge: number,
  signal?: AbortSignal
): Promise<ScreenSnapshot> {
  const displaySel =
    displayId == null
      ? '$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen'
      : `
$screens = [System.Windows.Forms.Screen]::AllScreens
if (${displayId} -ge $screens.Count) { Write-Error "显示器 ${displayId} 不存在"; exit 1 }
$bounds = $screens[${displayId}].Bounds`

  // 缩放后坐标换算：模型看到的是缩放图，点击要用原图坐标反推，
  // 因此把原图尺寸与实际像素比一并回报
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
${displaySel}
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$g.Dispose()
$long = [Math]::Max($bounds.Width, $bounds.Height)
$ratio = 1.0
if ($long -gt ${maxEdge}) { $ratio = ${maxEdge} / $long }
if ($ratio -lt 1.0) {
  $nw = [int]($bounds.Width * $ratio); $nh = [int]($bounds.Height * $ratio)
  $small = New-Object System.Drawing.Bitmap($bmp, $nw, $nh)
  $small.Save("${file.replace(/\\/g, '\\\\')}", [System.Drawing.Imaging.ImageFormat]::Png)
  $small.Dispose()
  $bmp.Dispose()
  Write-Output "$nw|$nh|$ratio"
} else {
  $bmp.Save("${file.replace(/\\/g, '\\\\')}", [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "$($bounds.Width)|$($bounds.Height)|1"
}
Write-Output "$($bounds.X)|$($bounds.Y)"
`
  const r = await run('powershell.exe', psEncodedCommand(script), { timeoutMs: 30000, signal })
  if (r.code !== 0) throw new ScreenError(r.stderr.trim() || '截图失败')
  const lines = r.stdout.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const [w, h, ratio] = (lines[0] ?? '').split('|').map(Number)
  const [ox, oy] = (lines[1] ?? '0|0').split('|').map(Number)
  if (!Number.isFinite(w) || !Number.isFinite(h)) throw new ScreenError('截图返回的尺寸无法解析')
  return finishSnapshot(file, displayId ?? -1, ox || 0, oy || 0, Number.isFinite(ratio) && ratio > 0 ? ratio : 1, w, h)
}

async function captureMac(file: string, maxEdge: number, signal?: AbortSignal): Promise<ScreenSnapshot> {
  const r = await run('screencapture', ['-x', '-t', 'png', file], { timeoutMs: 30000, signal })
  if (r.code !== 0) throw new ScreenError(r.stderr.trim() || '截图失败（可能缺少屏幕录制权限）')
  const dims = await resizeWithSips(file, maxEdge, signal)
  return finishSnapshot(file, -1, 0, 0, dims.scale, dims.width, dims.height)
}

async function captureLinux(file: string, maxEdge: number, signal?: AbortSignal): Promise<ScreenSnapshot> {
  const tool = await pickLinuxShotTool()
  if (!tool) throw new ScreenError('未找到可用的截图工具，请安装 gnome-screenshot、scrot 或 imagemagick')
  const args =
    tool === 'gnome-screenshot'
      ? ['-f', file]
      : tool === 'scrot'
        ? [file]
        : tool === 'grim'
          ? [file]
          : tool === 'spectacle'
            ? ['-b', '-n', '-o', file]
            : ['-window', 'root', file] // imagemagick import
  const r = await run(tool, args, { timeoutMs: 30000, signal })
  if (r.code !== 0) throw new ScreenError(`${tool} 截图失败：${r.stderr.trim()}`)
  const dims = await resizeWithMagick(file, maxEdge, signal)
  return finishSnapshot(file, -1, 0, 0, dims.scale, dims.width, dims.height)
}

/** macOS 用 sips 读取/缩放 */
async function resizeWithSips(
  file: string,
  maxEdge: number,
  signal?: AbortSignal
): Promise<{ width: number; height: number; scale: number }> {
  const info = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { timeoutMs: 10000, signal })
  const w = Number(/pixelWidth:\s*(\d+)/.exec(info.stdout)?.[1] ?? 0)
  const h = Number(/pixelHeight:\s*(\d+)/.exec(info.stdout)?.[1] ?? 0)
  const long = Math.max(w, h)
  if (!long || long <= maxEdge) return { width: w, height: h, scale: 1 }
  const ratio = maxEdge / long
  const nw = Math.round(w * ratio)
  await run('sips', ['-z', String(Math.round(h * ratio)), String(nw), file], { timeoutMs: 15000, signal })
  return { width: nw, height: Math.round(h * ratio), scale: ratio }
}

/** Linux 用 ImageMagick 的 identify / convert */
async function resizeWithMagick(
  file: string,
  maxEdge: number,
  signal?: AbortSignal
): Promise<{ width: number; height: number; scale: number }> {
  const info = await run('identify', ['-format', '%w %h', file], { timeoutMs: 10000, signal }).catch(() => null)
  if (!info || info.code !== 0) return { width: 0, height: 0, scale: 1 }
  const [w, h] = info.stdout.trim().split(/\s+/).map(Number)
  const long = Math.max(w, h)
  if (!long || long <= maxEdge) return { width: w, height: h, scale: 1 }
  const ratio = maxEdge / long
  const nw = Math.round(w * ratio)
  const nh = Math.round(h * ratio)
  await run('convert', [file, '-resize', `${nw}x${nh}`, file], { timeoutMs: 20000, signal }).catch(() => undefined)
  return { width: nw, height: nh, scale: ratio }
}

/* ------------------------------------------------------------------ */
/* 输入模拟                                                            */
/* ------------------------------------------------------------------ */

export interface Point {
  x: number
  y: number
}

export interface ClickOptions extends RunOptions {
  button?: 'left' | 'right' | 'middle'
  count?: number
  /** 是否沿贝塞尔曲线平滑移动光标（更接近真人轨迹） */
  humanize?: boolean
}

/** 无障碍特性：某些窗口需要窗口获得焦点后才接受合成输入 */
async function clickWindows(p: Point, opts: ClickOptions): Promise<void> {
  const button = opts.button && BUTTONS.has(opts.button) ? opts.button : 'left'
  const count = Math.max(1, Math.min(opts.count ?? 1, 3))
  const script = `${WIN_INPUT_PRELUDE}
[LagentInput]::Click(${Math.round(p.x)}, ${Math.round(p.y)}, "${button}", ${count})
`
  const r = await run('powershell.exe', psEncodedCommand(script), { timeoutMs: opts.timeoutMs ?? 20000, signal: opts.signal })
  if (r.code !== 0) throw new ScreenError(r.stderr.trim() || '点击失败')
}

async function clickMac(p: Point, opts: ClickOptions): Promise<void> {
  // cliclick 若存在则优先用（坐标更准），否则回落 osascript
  if (await hasCommand('cliclick')) {
    const button = opts.button === 'right' ? 'rc' : opts.button === 'middle' ? 'mc' : 'c'
    const r = await run('cliclick', [`${button}:${Math.round(p.x)},${Math.round(p.y)}`], {
      timeoutMs: opts.timeoutMs ?? 15000,
      signal: opts.signal
    })
    if (r.code !== 0) throw new ScreenError(r.stderr.trim() || '点击失败')
    return
  }
  const script = `tell application "System Events" to click at {${Math.round(p.x)}, ${Math.round(p.y)}}`
  const r = await run('osascript', ['-e', script], { timeoutMs: opts.timeoutMs ?? 15000, signal: opts.signal })
  if (r.code !== 0) {
    throw new ScreenError(
      `${r.stderr.trim() || '点击失败'}｜macOS 原生点击依赖辅助功能权限；若被拒绝，可安装 cliclick 提升可靠性`
    )
  }
}

async function clickLinux(p: Point, opts: ClickOptions): Promise<void> {
  const button = opts.button === 'right' ? '3' : opts.button === 'middle' ? '2' : '1'
  const args = ['mousemove', String(Math.round(p.x)), String(Math.round(p.y)), 'click', '--repeat', String(Math.max(1, Math.min(opts.count ?? 1, 3))), button]
  const r = await run('xdotool', args, { timeoutMs: opts.timeoutMs ?? 15000, signal: opts.signal })
  if (r.code !== 0) throw new ScreenError(`${r.stderr.trim() || '点击失败'}｜需要 xdotool 且为 X11 会话`)
}

/** 贝塞尔插值点：让光标移动看起来不是瞬移 */
export function bezierPath(from: Point, to: Point, steps = 14): Point[] {
  // 控制点在两点之间随机偏移，产生自然的弧线
  const dx = to.x - from.x
  const dy = to.y - from.y
  const norm = Math.hypot(dx, dy) || 1
  const jitter = Math.min(120, norm * 0.18)
  const ctrl1 = {
    x: from.x + dx * 0.3 + (-dy / norm) * jitter,
    y: from.y + dy * 0.3 + (dx / norm) * jitter
  }
  const ctrl2 = {
    x: from.x + dx * 0.7 + (dy / norm) * jitter,
    y: from.y + dy * 0.7 + (-dx / norm) * jitter
  }
  const out: Point[] = []
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const mt = 1 - t
    out.push({
      x: Math.round(mt * mt * mt * from.x + 3 * mt * mt * t * ctrl1.x + 3 * mt * t * t * ctrl2.x + t * t * t * to.x),
      y: Math.round(mt * mt * mt * from.y + 3 * mt * mt * t * ctrl1.y + 3 * mt * t * t * ctrl2.y + t * t * t * to.y)
    })
  }
  return out
}

/** 读取当前光标位置，供轨迹动画起点使用 */
export async function cursorPos(): Promise<Point | null> {
  try {
    if (process.platform === 'win32') {
      const script = `${WIN_INPUT_PRELUDE}
$p = New-Object 'LagentInput+POINT'
if ([LagentInput]::GetCursorPos([ref]$p)) { Write-Output "$($p.X)|$($p.Y)" }
`
      const r = await run('powershell.exe', psEncodedCommand(script), { timeoutMs: 15000 })
      const [x, y] = r.stdout.trim().split('|').map(Number)
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
    }
    if (process.platform === 'darwin') {
      const r = await run('osascript', ['-e', 'tell application "System Events" to get position of mouse'], { timeoutMs: 8000 })
      const m = /(-?\d+),\s*(-?\d+)/.exec(r.stdout)
      return m ? { x: Number(m[1]), y: Number(m[2]) } : null
    }
    const r = await run('xdotool', ['getmouselocation', '--shell'], { timeoutMs: 5000 })
    const x = Number(/X=(-?\d+)/.exec(r.stdout)?.[1])
    const y = Number(/Y=(-?\d+)/.exec(r.stdout)?.[1])
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
  } catch {
    return null
  }
}

export async function moveMouse(p: Point, opts: RunOptions = {}): Promise<void> {
  if (process.platform === 'win32') {
    const script = `${WIN_INPUT_PRELUDE}
[LagentInput]::MoveTo(${Math.round(p.x)}, ${Math.round(p.y)})
`
    const r = await run('powershell.exe', psEncodedCommand(script), { timeoutMs: opts.timeoutMs ?? 15000, signal: opts.signal })
    if (r.code !== 0) throw new ScreenError(r.stderr.trim() || '移动光标失败')
    return
  }
  if (process.platform === 'darwin') {
    const r = await run('osascript', ['-e', `tell application "System Events" to set position of mouse to {${Math.round(p.x)}, ${Math.round(p.y)}}`], {
      timeoutMs: opts.timeoutMs ?? 15000,
      signal: opts.signal
    })
    if (r.code !== 0) throw new ScreenError(r.stderr.trim() || '移动光标失败')
    return
  }
  const r = await run('xdotool', ['mousemove', String(Math.round(p.x)), String(Math.round(p.y))], {
    timeoutMs: opts.timeoutMs ?? 15000,
    signal: opts.signal
  })
  if (r.code !== 0) throw new ScreenError(r.stderr.trim() || '移动光标失败')
}

/**
 * 点击：先沿贝塞尔轨迹滑到目标再按下，避免"光标瞬移 + 立即点击"
 * 这种人类不会产生的输入模式被风控或 UI 框架忽略。
 */
export async function click(p: Point, opts: ClickOptions = {}): Promise<void> {
  if (opts.humanize !== false) {
    const from = await cursorPos()
    if (from && (Math.abs(from.x - p.x) > 4 || Math.abs(from.y - p.y) > 4)) {
      const path = bezierPath(from, p)
      // 轨迹长度决定步进间隔，让总耗时落在 180~420ms 这个像真人的区间
      const stepDelay = Math.max(6, Math.min(28, Math.round(300 / path.length)))
      const limit = Math.max(1, Math.min(path.length, 18))
      for (let i = 0; i < limit; i++) {
        if (opts.signal?.aborted) throw new ScreenError('操作已中断')
        await moveMouse(path[Math.floor((i / limit) * (path.length - 1))], opts)
        await sleep(stepDelay)
      }
    }
    await sleep(30 + Math.random() * 70)
  }

  if (process.platform === 'win32') return clickWindows(p, opts)
  if (process.platform === 'darwin') return clickMac(p, opts)
  return clickLinux(p, opts)
}

export interface DragOptions extends ClickOptions {
  from: Point
  to: Point
}

/** 拖拽：按住 → 沿轨迹移动 → 松开 */
export async function drag(opts: DragOptions): Promise<void> {
  if (process.platform === 'win32') {
    const path = bezierPath(opts.from, opts.to)
    // 整条轨迹在 PowerShell 侧一次跑完，避免启动几十个进程
    const moves = path
      .slice(0, 20)
      .map((pt) => `[LagentInput]::MoveTo(${pt.x}, ${pt.y}); Start-Sleep -Milliseconds 18`)
      .join('\n')
    // 按住/松开都在 LagentInput 内部实现。不能另起一个 Add-Type 去引用它——
    // C# 编译单元之间不共享类型，第二个 Add-Type 会报「找不到 LagentInput」。
    const script = `${WIN_INPUT_PRELUDE}
[LagentInput]::MoveTo(${opts.from.x}, ${opts.from.y})
Start-Sleep -Milliseconds 90
[LagentInput]::LeftDown()
Start-Sleep -Milliseconds 60
${moves}
Start-Sleep -Milliseconds 60
[LagentInput]::LeftUp()
`
    const r = await run('powershell.exe', psEncodedCommand(script), {
      timeoutMs: opts.timeoutMs ?? 30000,
      signal: opts.signal
    })
    if (r.code !== 0) throw new ScreenError(r.stderr.trim() || '拖拽失败')
    return
  }

  if (process.platform === 'darwin') {
    if (!(await hasCommand('cliclick'))) {
      throw new ScreenError('macOS 拖拽需要 cliclick（brew install cliclick）')
    }
    const steps = bezierPath(opts.from, opts.to).slice(0, 12)
    const r = await run(
      'cliclick',
      [`dd:${opts.from.x},${opts.from.y}`, ...steps.map((p) => `dm:${p.x},${p.y}`), `du:${opts.to.x},${opts.to.y}`],
      { timeoutMs: opts.timeoutMs ?? 25000, signal: opts.signal }
    )
    if (r.code !== 0) throw new ScreenError(r.stderr.trim() || '拖拽失败')
    return
  }

  const path = bezierPath(opts.from, opts.to).slice(0, 14)
  const r1 = await run('xdotool', ['mousemove', String(opts.from.x), String(opts.from.y)], { timeoutMs: 10000, signal: opts.signal })
  if (r1.code !== 0) throw new ScreenError('xdotool 移动失败')
  const down = await run('xdotool', ['mousedown', '1'], { timeoutMs: 10000, signal: opts.signal })
  if (down.code !== 0) throw new ScreenError('xdotool 按下失败')
  for (const p of path) {
    await run('xdotool', ['mousemove', String(p.x), String(p.y)], { timeoutMs: 8000, signal: opts.signal })
    await sleep(20)
  }
  const up = await run('xdotool', ['mouseup', '1'], { timeoutMs: 10000, signal: opts.signal })
  if (up.code !== 0) throw new ScreenError('xdotool 松开失败')
}

export interface TypeOptions extends RunOptions {
  /** 每个字符之间的延迟区间，模拟键入节奏 */
  humanize?: boolean
}

export async function typeText(text: string, opts: TypeOptions = {}): Promise<void> {
  if (!text) return
  if (process.platform === 'win32') {
    // 走 Unicode 注入，中文、emoji 都能直接输入，无需考虑键盘布局
    const escaped = text.replace(/'/g, "''")
    const script = `${WIN_INPUT_PRELUDE}
[LagentInput]::TypeText('${escaped}')
`
    const r = await run('powershell.exe', psEncodedCommand(script), {
      timeoutMs: opts.timeoutMs ?? Math.max(20000, text.length * 120),
      signal: opts.signal
    })
    if (r.code !== 0) throw new ScreenError(r.stderr.trim() || '输入失败')
    return
  }
  if (process.platform === 'darwin') {
    // osascript 的 keystroke 支持任意 Unicode
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const r = await run(
      'osascript',
      ['-e', `tell application "System Events" to keystroke "${escaped}"`],
      { timeoutMs: opts.timeoutMs ?? Math.max(15000, text.length * 120), signal: opts.signal }
    )
    if (r.code !== 0) throw new ScreenError(r.stderr.trim() || '输入失败（可能缺少辅助功能权限）')
    return
  }
  // xdotool type 对非 ASCII 支持不稳，逐字符用 keysym 往往失败；
  // 采用 --clearmodifiers 与 --delay，并对中文给出提示
  const r = await run('xdotool', ['type', '--clearmodifiers', '--delay', '40', text], {
    timeoutMs: opts.timeoutMs ?? Math.max(15000, text.length * 120),
    signal: opts.signal
  })
  if (r.code !== 0) {
    throw new ScreenError(`${r.stderr.trim() || '输入失败'}｜xdotool 对中文输入支持有限，可改用剪贴板粘贴`)
  }
}

/** 组合键：如 ["ctrl","c"]、["alt","tab"] */
export async function pressKeys(keys: string[], opts: RunOptions = {}): Promise<void> {
  const normalized = keys.map((k) => k.trim().toLowerCase()).filter(Boolean)
  if (!normalized.length) throw new ScreenError('未指定按键')

  if (process.platform === 'win32') {
    const codes: number[] = []
    for (const k of normalized) {
      const vk = resolveVirtualKey(k)
      if (vk == null) throw new ScreenError(`不认识的按键：${k}`)
      codes.push(vk)
    }
    const down = codes.map((c) => `[LagentInput]::KeyDown(${c})`).join('; ')
    const up = [...codes].reverse().map((c) => `[LagentInput]::KeyUp(${c})`).join('; ')
    const script = `${WIN_INPUT_PRELUDE}
${down}
Start-Sleep -Milliseconds 55
${up}
`
    const r = await run('powershell.exe', psEncodedCommand(script), { timeoutMs: opts.timeoutMs ?? 15000, signal: opts.signal })
    if (r.code !== 0) throw new ScreenError(r.stderr.trim() || '按键失败')
    return
  }

  if (process.platform === 'darwin') {
    // key code 映射：常用修饰键走 key down/up 序列
    const macMap: Record<string, string> = {
      cmd: 'command',
      command: 'command',
      ctrl: 'control',
      control: 'control',
      alt: 'option',
      option: 'option',
      shift: 'shift',
      enter: 'return',
      return: 'return',
      tab: 'tab',
      escape: 'escape',
      esc: 'escape',
      space: 'space',
      delete: 'delete',
      backspace: 'delete',
      up: 'up arrow',
      down: 'down arrow',
      left: 'left arrow',
      right: 'right arrow'
    }
    const mapped = normalized.map((k) => macMap[k] ?? k)
    const mods = mapped.filter((m) => ['command', 'control', 'option', 'shift'].includes(m))
    const rest = mapped.filter((m) => !mods.includes(m))
    if (!rest.length) throw new ScreenError('组合键需要至少一个非修饰键')
    const using = mods.length ? ` using {${mods.join(', ')} down}` : ''
    const script = `tell application "System Events" to keystroke "${rest[rest.length - 1]}"${using}`
    const r = await run('osascript', ['-e', script], { timeoutMs: opts.timeoutMs ?? 15000, signal: opts.signal })
    if (r.code !== 0) throw new ScreenError(r.stderr.trim() || '按键失败')
    return
  }

  const combo = normalized.map((k) => (k === 'ctrl' ? 'ctrl' : k === 'alt' ? 'alt' : k)).join('+')
  const r = await run('xdotool', ['key', '--clearmodifiers', combo], { timeoutMs: opts.timeoutMs ?? 15000, signal: opts.signal })
  if (r.code !== 0) throw new ScreenError(r.stderr.trim() || '按键失败')
}

export async function scroll(
  amount: number,
  at?: Point,
  opts: RunOptions = {}
): Promise<void> {
  const clicks = Math.max(1, Math.min(Math.abs(Math.round(amount / 100)) || 3, 30))
  const up = amount > 0

  if (process.platform === 'win32') {
    const delta = up ? 120 * clicks : -120 * clicks
    const move = at ? `[LagentInput]::MoveTo(${at.x}, ${at.y}); Start-Sleep -Milliseconds 60; ` : ''
    const script = `${WIN_INPUT_PRELUDE}
${move}[LagentInput]::Scroll(${delta})
`
    const r = await run('powershell.exe', psEncodedCommand(script), { timeoutMs: opts.timeoutMs ?? 15000, signal: opts.signal })
    if (r.code !== 0) throw new ScreenError(r.stderr.trim() || '滚动失败')
    return
  }

  if (process.platform === 'darwin') {
    const script = `tell application "System Events" to scroll ${up ? 'up' : 'down'} ${clicks * 3}`
    const r = await run('osascript', ['-e', script], { timeoutMs: opts.timeoutMs ?? 15000, signal: opts.signal })
    if (r.code !== 0) throw new ScreenError(r.stderr.trim() || '滚动失败')
    return
  }

  if (at) {
    await run('xdotool', ['mousemove', String(at.x), String(at.y)], { timeoutMs: 8000, signal: opts.signal })
  }
  const button = up ? '4' : '5'
  const r = await run('xdotool', ['click', '--repeat', String(clicks), button], {
    timeoutMs: opts.timeoutMs ?? 15000,
    signal: opts.signal
  })
  if (r.code !== 0) throw new ScreenError(r.stderr.trim() || '滚动失败')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
