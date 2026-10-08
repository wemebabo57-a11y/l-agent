/**
 * 控制台命令执行。
 *
 * 安全边界：
 * 1. 命令以**数组形式**传给 shell 之前先过白/黑名单（比对首个 token 的 basename）。
 * 2. 默认禁用管道与重定向（allowPipe=false），因为它们能把无害命令串成危险命令。
 * 3. 超时后连同子进程树一起杀掉，避免留下孤儿进程。
 * 4. 输出有硬上限，防止 `yes` 之类命令把内存吃光。
 */
import { spawn } from 'node:child_process'
import type { ShellResult } from '@shared/types'

export class ShellError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ShellError'
  }
}

const MAX_OUTPUT_CHARS = 200_000
const HARD_TIMEOUT_CAP_MS = 10 * 60 * 1000

export interface ShellPolicy {
  allowlist: string[]
  denylist: string[]
  /** 是否允许管道 / 重定向 / 命令串联 */
  allowPipe: boolean
}

export interface ShellRunOptions {
  cwd: string
  timeoutMs: number
  policy: ShellPolicy
  signal?: AbortSignal
  /** 显式指定解释器：cmd / powershell / bash / sh */
  interpreter?: string
}

/**
 * 危险模式：无 allowPipe 时一律拒绝。
 *
 * 这些检查是**全字符串**扫描，不去除引号内的片段。看起来过于严格——比如
 * `node -e "if (a > b)"` 也会被拒——但这是有意为之：Windows 的 cmd.exe 会处理
 * 双引号**内部**的重定向符（`echo "a>b"` 真的会创建文件），所以"引号里的字符安全"
 * 这个前提在目标平台上根本不成立。宁可让模型把命令拆成几条，也不要留下一条
 * 能被引号绕过的重定向通道。
 */
const PIPE_PATTERNS = [
  { re: /[|;&]/, what: '管道、命令串联或后台执行（| ; &）' },
  { re: />>|>|<(?![&])/, what: '输出重定向（> >> <）' },
  { re: /`/, what: '反引号命令替换' },
  { re: /\$\(/, what: '命令替换 $( )' },
  { re: /\n/, what: '多行命令' }
]

/**
 * 取出命令的首个 token（可执行文件名），用于白/黑名单比对。
 * 只做保守的引号剥离，不做完整 shell 解析——解析器和真实 shell 的行为差异
 * 本身就是绕过风险，宁可拒绝也不要错误地"理解"。
 */
export function firstToken(command: string): string {
  const trimmed = command.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0]
    const end = trimmed.indexOf(quote, 1)
    if (end > 0) return basename(trimmed.slice(1, end))
  }
  const m = /^[^\s]+/.exec(trimmed)
  return m ? basename(m[0]) : ''
}

function basename(p: string): string {
  const seg = p.split(/[\\/]/).pop() ?? p
  return seg.toLowerCase().replace(/\.(exe|cmd|bat|ps1|sh)$/, '')
}

/**
 * 名单项归一化：与 token 走同一条 basename 变换。
 * 否则名单里写 shutdown.exe 永远命中不了 token shutdown（扩展名已被脱掉），
 * 管理员以为拦住了、实际没拦住，是静默旁路。
 */
export function normalizeListName(raw: string): string {
  return basename(raw.trim().toLowerCase())
}

export interface PolicyVerdict {
  ok: boolean
  reason?: string
}

/** 纯函数形式的策略校验，便于单测覆盖所有拒绝路径 */
export function checkPolicy(command: string, policy: ShellPolicy): PolicyVerdict {
  if (!command.trim()) return { ok: false, reason: '命令不能为空' }
  if (command.length > 8000) return { ok: false, reason: '命令过长（上限 8000 字符）' }
  if (command.includes('\0')) return { ok: false, reason: '命令包含非法字符' }

  const token = firstToken(command)
  if (!token) return { ok: false, reason: '无法解析出可执行文件名' }

  const deny = policy.denylist.map(normalizeListName).filter(Boolean)
  if (deny.some((d) => token === d)) {
    return { ok: false, reason: `命令 ${token} 命中黑名单，已拒绝` }
  }

  const allow = policy.allowlist.map(normalizeListName).filter(Boolean)
  if (allow.length && !allow.some((a) => token === a)) {
    return { ok: false, reason: `命令 ${token} 不在白名单内（当前白名单：${allow.join(', ')}）` }
  }

  if (!policy.allowPipe) {
    for (const { re, what } of PIPE_PATTERNS) {
      if (re.test(command)) {
        return {
          ok: false,
          reason: `命令包含${what}。为安全起见，助手只能一次执行一条不含管道/重定向的命令；请拆成多次单独调用。`
        }
      }
    }
  }

  return { ok: true }
}

/**
 * 按平台挑默认解释器。
 *
 * Windows / cmd.exe 的引号处理需要特别说明：`cmd /d /s /c <cmd>` 在 Node 默认的
 * 参数转义下会把内层引号吃掉。实测 `node -e "process.exit(3)"` 会以 0 退出——
 * 退出码是错的，而这类错误不会报错、只会静默给出错误的结论。所以 Windows 分支
 * 用 windowsVerbatimArguments 原样传递命令行，并自己把命令包进一对引号，
 * 这与 cmd 对 /s 的约定一致。见 runCommand 里的注释。
 */
function defaultInterpreter(explicit?: string): {
  file: string
  args: (cmd: string) => string[]
  label: string
  verbatim: boolean
} {
  const want = explicit?.trim().toLowerCase()
  if (process.platform === 'win32') {
    if (want === 'powershell' || want === 'pwsh') {
      const file = want === 'pwsh' ? 'pwsh.exe' : 'powershell.exe'
      return { file, args: (c) => ['-NoProfile', '-NonInteractive', '-Command', c], label: file, verbatim: false }
    }
    // 默认走 cmd：启动快、行为可预期
    return {
      file: 'cmd.exe',
      args: (c) => ['/d', '/s', '/c', `"${c}"`],
      label: 'cmd.exe',
      verbatim: true
    }
  }
  if (want === 'powershell' || want === 'pwsh') {
    const file = want === 'pwsh' ? 'pwsh' : 'powershell'
    return { file, args: (c) => ['-NoProfile', '-NonInteractive', '-Command', c], label: file, verbatim: false }
  }
  if (want === 'bash') return { file: '/bin/bash', args: (c) => ['-lc', c], label: 'bash', verbatim: false }
  return { file: '/bin/sh', args: (c) => ['-c', c], label: 'sh', verbatim: false }
}

export async function runCommand(command: string, opts: ShellRunOptions): Promise<ShellResult> {
  const verdict = checkPolicy(command, opts.policy)
  if (!verdict.ok) throw new ShellError(verdict.reason ?? '命令被策略拒绝')

  const timeoutMs = Math.max(1000, Math.min(opts.timeoutMs, HARD_TIMEOUT_CAP_MS))
  const interp = defaultInterpreter(opts.interpreter)
  const started = Date.now()

  return new Promise<ShellResult>((resolve, reject) => {
    const child = spawn(interp.file, interp.args(command), {
      cwd: opts.cwd,
      windowsHide: true,
      // POSIX 上要自成进程组，超时才能用 -pid 把整棵子树杀掉
      detached: process.platform !== 'win32',
      // cmd.exe 需要原样命令行，否则内层引号被吞、退出码失真
      windowsVerbatimArguments: interp.verbatim,
      // 不传 shell:true：命令已经交给解释器，再套一层会引入二次解析
      env: { ...process.env, LAGENT: '1' }
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const appendCapped = (current: string, chunk: string): string =>
      current.length >= MAX_OUTPUT_CHARS ? current : (current + chunk).slice(0, MAX_OUTPUT_CHARS)

    const killTree = (): void => {
      if (child.pid == null) return
      if (process.platform === 'win32') {
        // Windows 上 child.kill 只杀 shell 本身，孙进程会残留
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }).on('error', () => undefined)
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, timeoutMs)

    const onAbort = (): void => {
      killTree()
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      stdout = appendCapped(stdout, d)
    })
    child.stderr.on('data', (d: string) => {
      stderr = appendCapped(stderr, d)
    })

    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      reject(new ShellError(`无法启动 ${interp.label}：${e.message}`))
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
        command,
        cwd: opts.cwd
      })
    })
  })
}

/** 把命令的结果渲染成回灌给模型的文本 */
export function renderShellResult(r: ShellResult): string {
  const parts: string[] = []
  parts.push(`$ ${r.command}`)
  parts.push(`（目录 ${r.cwd}，退出码 ${r.exitCode ?? '未知'}，耗时 ${r.durationMs}ms${r.timedOut ? '，已因超时终止' : ''}）`)
  if (r.stdout.trim()) parts.push(`--- stdout ---\n${r.stdout.trimEnd()}`)
  if (r.stderr.trim()) parts.push(`--- stderr ---\n${r.stderr.trimEnd()}`)
  if (!r.stdout.trim() && !r.stderr.trim()) parts.push('（无输出）')
  return parts.join('\n')
}
