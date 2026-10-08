/**
 * 自动备份：把全部工作区定时提交并推送到 git 远端。
 *
 * 目标三选一：本地裸仓库 / GitHub 仓库 / 自定义远端（GitCode、自建 GitLab 等）。
 * 刻意不用第三方 git 库：只要系统装了 git 就能跑，少一个供应链依赖。
 *
 * 安全边界（备份是高频自动动作，绝不能搞坏用户仓库）：
 * 1. 所有 git 调用走 argv 数组，不经过 shell，没有注入面。
 * 2. 只用独立远端名 `lagent-backup`，绝不碰用户的 `origin`。
 * 3. 推送固定打到 `HEAD:refs/heads/<branch>`（默认 lagent-backup 分支），
 *    不污染用户自己的分支；从不 force push，远端分叉就报错等人看。
 * 4. 含令牌的远端 URL 只活在内存里，进日志/报错前先脱敏。
 * 5. GIT_TERMINAL_PROMPT=0：没配好凭据就直接失败，绝不弹框卡住主进程。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { BackupConfig, BackupEvent, BackupRunSummary, BackupStatus, BackupWorkspaceResult, Workspace } from '@shared/types'

export class BackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupError'
  }
}

/** 主进程注入的依赖：保持本模块可被单元测试直接 import（不碰 electron） */
export interface BackupDeps {
  getBackupConfig: () => Promise<BackupConfig>
  listWorkspaces: () => Promise<Workspace[]>
  /** GitHub 页保存的 PAT（github 模式用） */
  getGitHubToken: () => Promise<string | null>
  /** 自定义远端令牌 */
  getCustomToken: () => Promise<string | null>
  setCustomToken: (token: string | null) => Promise<void>
  /** GitHub 仓库是否存在（走 API，404 返回 false，其余错误抛出） */
  repoExists: (owner: string, repo: string) => Promise<boolean>
  /** GitHub 建空私有库（仅 github 模式的一键建库用） */
  createRepo: (name: string) => Promise<{ fullName: string; url: string }>
  /** 进度推送（主进程转给渲染进程，备份长耗时不能靠轮询猜） */
  emit: (e: BackupEvent) => void
  /** 备份状态落盘路径（dataDir 下） */
  statusFile: () => string
}

export const BACKUP_REMOTE_NAME = 'lagent-backup'
export const BACKUP_USER = 'lagent'
export const CUSTOM_TOKEN_LABEL = 'oauth2'
const GIT_TIMEOUT_MS = 180_000
const MAX_GIT_OUTPUT = 32_000
const SCHED_TICK_MS = 30_000
const STATUS_CACHE_MS = 60_000

/* ------------------------------------------------------------------ */
/* 纯函数：校验、URL 组装、脱敏（单测直接覆盖）                           */
/* ------------------------------------------------------------------ */

/** 间隔钳制到 5~1440 分钟，非法值回落 30 */
export function clampIntervalMinutes(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return 30
  return Math.max(5, Math.min(1440, Math.floor(n)))
}

/** 分支名校验：非法直接抛，调用方转成中文提示 */
export function sanitizeBranch(raw: string): string {
  const name = raw.trim()
  if (!name) throw new BackupError('分支名不能为空')
  if (name === 'HEAD') throw new BackupError('分支名不能是 HEAD')
  // git check-ref-format 的核心子集：..、控制字符、~ ^ : ? * [、首尾斜杠/点、.lock 结尾
  if (
    name.includes('..') ||
    /[\x00-\x20~^:?*[\]\\]/.test(name) ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.endsWith('.') ||
    name.endsWith('.lock') ||
    name.startsWith('-')
  ) {
    throw new BackupError(`分支名不合法：${name}`)
  }
  if (name.length > 200) throw new BackupError('分支名过长（上限 200 字符）')
  return name
}

function sanitizeOwnerRepo(value: string, label: string): string {
  const v = value.trim()
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(v)) {
    throw new BackupError(`${label}只能包含字母、数字、. _ -（100 字以内）`)
  }
  return v
}

/** 配置校验：第一处问题直接抛，渲染层原样展示 */
export function validateBackupConfig(cfg: BackupConfig): void {
  sanitizeBranch(cfg.branch)
  clampIntervalMinutes(cfg.intervalMinutes)
  if (cfg.target === 'local') {
    if (!cfg.localPath.trim()) throw new BackupError('本地模式需要选择一个裸仓库目录')
  } else if (cfg.target === 'github') {
    sanitizeOwnerRepo(cfg.githubOwner, '仓库所有者')
    sanitizeOwnerRepo(cfg.githubRepo, '仓库名')
  } else if (cfg.target === 'custom') {
    const url = cfg.customUrl.trim()
    if (!url) throw new BackupError('自定义模式需要填写远端 URL')
    if (url.includes('\n') || url.includes('\0')) throw new BackupError('远端 URL 包含非法字符')
    if (/^https?:\/\//i.test(url)) {
      // ok：https 远端，凭据走令牌注入或 URL 自带
    } else if (/^(ssh:\/\/|git@)/i.test(url)) {
      // ok：ssh 远端，走用户自己的 key/agent
    } else if (/^[A-Za-z0-9_.-]+@[^:]+:.+/.test(url)) {
      // ok：user@host:path 形式的 ssh 简写
    } else {
      throw new BackupError('远端 URL 格式不支持（应为 https://…、git@… 或 ssh://…）')
    }
  } else {
    throw new BackupError('未知的备份目标类型')
  }
}

/** 提交信息：固定前缀 + 本地时间，方便在远端一眼认出 */
export function formatBackupMessage(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `lagent 自动备份 ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`
}

export interface BackupTokens {
  github: string | null
  custom: string | null
}

/**
 * 按配置组装推送用远端 URL（含凭据，调用后只传给 git，绝不落盘/进日志）。
 * 本地模式直接返回目录；ssh 远端原样返回（走 key/agent）。
 */
export function buildBackupRemoteUrl(cfg: BackupConfig, tokens: BackupTokens): string {
  if (cfg.target === 'local') {
    const p = cfg.localPath.trim()
    if (!p) throw new BackupError('本地模式需要选择一个裸仓库目录')
    return p
  }
  if (cfg.target === 'github') {
    const token = tokens.github?.trim()
    if (!token) throw new BackupError('GitHub 模式需要先在「GitHub」页填入访问令牌')
    const owner = sanitizeOwnerRepo(cfg.githubOwner, '仓库所有者')
    const repo = sanitizeOwnerRepo(cfg.githubRepo, '仓库名')
    return `https://x-access-token:${encodeURIComponent(token)}@github.com/${owner}/${repo}.git`
  }
  const url = cfg.customUrl.trim()
  if (!url) throw new BackupError('自定义模式需要填写远端 URL')
  // URL 自带凭据（…://user:pass@…）就原样用，不二次注入
  if (/^[a-z]+:\/\/[^/\s]+@/i.test(url)) return url
  if (/^(ssh:\/\/|git@)/i.test(url) || /^[A-Za-z0-9_.-]+@[^:]+:.+/.test(url)) return url
  const token = tokens.custom?.trim()
  if (token && /^https:\/\//i.test(url)) {
    // 通用注入：oauth2:令牌（兼容 GitLab / GitCode / Gitee 系；不兼容就把凭据直接写进 URL）
    return url.replace(/^https:\/\//i, `https://${CUSTOM_TOKEN_LABEL}:${encodeURIComponent(token)}@`)
  }
  return url
}

/** 日志/报错脱敏：把 URL 里的 userinfo 段替换掉，令牌泄漏止于此 */
export function redactSecrets(text: string): string {
  return text.replace(/(https?:\/\/)[^/\s@]+@/gi, '$1***@')
}

/* ------------------------------------------------------------------ */
/* git 调用层                                                           */
/* ------------------------------------------------------------------ */

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
    let stdout = ''
    let stderr = ''
    let killed = false
    const append = (cur: string, chunk: string): string =>
      cur.length >= MAX_GIT_OUTPUT ? cur : (cur + chunk).slice(0, MAX_GIT_OUTPUT)
    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, GIT_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      stdout = append(stdout, d)
    })
    child.stderr.on('data', (d: string) => {
      stderr = append(stderr, d)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new BackupError(`无法启动 git：${e.message}（请先安装 https://git-scm.com/downloads）`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      if (killed) {
        reject(new BackupError(`git ${args[0]} 执行超时（${Math.round(GIT_TIMEOUT_MS / 1000)} 秒），已终止`))
        return
      }
      const detail = redactSecrets((stderr || stdout).trim().split('\n').slice(0, 4).join('\n'))
      reject(new BackupError(detail ? `git ${args[0]} 失败：${detail}` : `git ${args[0]} 失败（退出码 ${code}）`))
    })
  })
}

async function probeGit(): Promise<boolean> {
  try {
    await runGit(['--version'], process.cwd())
    return true
  } catch {
    return false
  }
}

/** 工作区没有 .gitignore 时自动建一份：否则 node_modules/dist 会把备份撑爆 */
const SANE_GITIGNORE = `# 由 lagent 自动备份创建：防止构建产物与依赖进入备份
node_modules/
dist/
out/
build/
release/
.next/
.nuxt/
.venv/
venv/
__pycache__/
.idea/
.vscode/
target/
vendor/
*.log
.DS_Store
`;

async function ensureSaneGitignore(wsPath: string): Promise<boolean> {
  const file = path.join(wsPath, '.gitignore')
  try {
    await fs.access(file)
    return false
  } catch {
    await fs.writeFile(file, SANE_GITIGNORE, 'utf8')
    return true
  }
}

/* ------------------------------------------------------------------ */
/* 管理器                                                               */
/* ------------------------------------------------------------------ */

interface PersistedRun {
  at: number
  results: BackupWorkspaceResult[]
  /** 最近运行摘要（新在前，最多 10 条，老版本文件缺这个字段时按空处理） */
  history?: BackupRunSummary[]
}

/** 历史保留条数：状态文件只留摘要，不膨胀 */
const MAX_HISTORY = 10

export class BackupManager {
  private running = false
  private timer: NodeJS.Timeout | null = null
  private gitCache: { at: number; ok: boolean } | null = null
  // 显式字段而非参数属性：兼容 Node 的 strip-only TS 执行模式（供单元测试直接 import）
  private readonly deps: BackupDeps

  constructor(deps: BackupDeps) {
    this.deps = deps
  }

  /** 定时轮询启动（主进程 ready 后调一次即可，重复调用无副作用） */
  startScheduler(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined)
    }, SCHED_TICK_MS)
    this.timer.unref?.()
    // 启动即检查一次：把应用关闭期间错过的周期补上
    void this.tick().catch(() => undefined)
  }

  private async tick(): Promise<void> {
    if (this.running) return
    const cfg = await this.deps.getBackupConfig().catch(() => null)
    if (!cfg || !cfg.enabled) return
    const last = await this.readPersisted().catch(() => null)
    if (last && Date.now() - last.at < clampIntervalMinutes(cfg.intervalMinutes) * 60_000) return
    await this.runNow().catch(() => undefined)
  }

  private async gitAvailable(): Promise<boolean> {
    if (this.gitCache && Date.now() - this.gitCache.at < STATUS_CACHE_MS) return this.gitCache.ok
    const ok = await probeGit()
    this.gitCache = { at: Date.now(), ok }
    return ok
  }

  private async readPersisted(): Promise<PersistedRun | null> {
    try {
      const raw = await fs.readFile(this.deps.statusFile(), 'utf8')
      const parsed = JSON.parse(raw) as PersistedRun
      if (typeof parsed.at !== 'number' || !Array.isArray(parsed.results)) return null
      return parsed
    } catch {
      return null
    }
  }

  private async writePersisted(run: PersistedRun): Promise<void> {
  // 每次运行追加一条摘要（新在前，上限 10 条），历史重启不丢
  const prev = await this.readPersisted().catch(() => null)
  const summary: BackupRunSummary = {
    at: run.at,
    okCount: run.results.filter((r) => r.ok).length,
    total: run.results.length,
    failedNames: run.results.filter((r) => !r.ok).map((r) => r.name)
  }
  const withHistory: PersistedRun = {
    ...run,
    history: [summary, ...(prev?.history ?? [])].slice(0, MAX_HISTORY)
  }
  try {
    await fs.mkdir(path.dirname(this.deps.statusFile()), { recursive: true })
    await fs.writeFile(this.deps.statusFile(), JSON.stringify(withHistory), 'utf8')
  } catch {
    /* 状态落盘失败不影响备份本身 */
  }
  }

  async status(): Promise<BackupStatus> {
    const [cfg, persisted, gitOk, customToken] = await Promise.all([
      this.deps.getBackupConfig().catch(() => null),
      this.readPersisted(),
      this.gitAvailable(),
      this.deps.getCustomToken().catch(() => null)
    ])
    const enabled = cfg?.enabled ?? false
    const lastRunAt = persisted?.at ?? null
    const nextRunAt =
      enabled && cfg ? (lastRunAt ?? Date.now()) + clampIntervalMinutes(cfg.intervalMinutes) * 60_000 : null
    return {
      enabled,
      running: this.running,
      lastRunAt,
      nextRunAt,
      gitAvailable: gitOk,
      hasCustomToken: Boolean(customToken),
      results: persisted?.results ?? [],
      history: persisted?.history ?? [],
      message: null
    }
  }

  /** 手动立即备份（不受 enabled 开关限制，但配置必须合法） */
  async runNow(): Promise<BackupStatus> {
    if (this.running) {
      const s = await this.status()
      return { ...s, message: '上一次备份仍在进行，稍后再试' }
    }
    this.running = true
    try {
      const cfg = await this.deps.getBackupConfig()
      try {
        validateBackupConfig(cfg)
      } catch (e) {
        return { ...(await this.status()), message: (e as Error).message }
      }
      if (!(await this.gitAvailable())) {
        return { ...(await this.status()), message: '未检测到 git，请先安装后再备份' }
      }
      const remote = await this.resolveRemote(cfg)
      const workspaces = await this.deps.listWorkspaces().catch(() => [] as Workspace[])
      // 并发 2 个：不同仓库相互独立可以并行；再多收益不大，反而让磁盘抖动
      const results = await mapLimit(workspaces, 2, async (ws) => {
        this.deps.emit({ type: 'workspace-start', workspaceId: ws.id, name: ws.name })
        let result: BackupWorkspaceResult
        try {
          result = await this.backupOne(ws, cfg, remote)
        } catch (e) {
          result = {
            workspaceId: ws.id,
            name: ws.name,
            ok: false,
            message: redactSecrets(e instanceof Error ? e.message : String(e)),
            commitSha: null
          }
        }
        this.deps.emit({ type: 'workspace-done', result })
        return result
      })
      const okCount = results.filter((r) => r.ok).length
      const at = Date.now()
      await this.writePersisted({ at, results })
      this.deps.emit({ type: 'run-done', at, okCount, total: results.length })
      const s = await this.status()
      return {
        ...s,
        message: results.length
          ? `备份完成：${okCount}/${results.length} 个工作区成功`
          : '没有可备份的工作区（先在「工作区」页添加目录）'
      }
    } finally {
      this.running = false
    }
  }

  /** 测试连接：只做只读探测，不产生任何提交 */
  async test(): Promise<{ ok: boolean; code: string; message: string }> {
    const cfg = await this.deps.getBackupConfig()
    try {
      validateBackupConfig(cfg)
    } catch (e) {
      return { ok: false, code: 'config', message: (e as Error).message }
    }
    if (!(await this.gitAvailable())) {
      return { ok: false, code: 'no-git', message: '未检测到 git，请先安装 https://git-scm.com/downloads' }
    }
    try {
      const remote = await this.resolveRemote(cfg)
      if (cfg.target === 'github') {
        const exists = await this.deps.repoExists(cfg.githubOwner.trim(), cfg.githubRepo.trim())
        if (!exists) {
          return {
            ok: false,
            code: 'repo-missing',
            message: `GitHub 上没有 ${cfg.githubOwner.trim()}/${cfg.githubRepo.trim()}（或令牌无权访问），可以一键创建空私有仓库`
          }
        }
      }
      await runGit(['ls-remote', remote, 'HEAD'], process.cwd())
      return { ok: true, code: 'ok', message: '连接成功，远端可读' }
    } catch (e) {
      const msg = redactSecrets(e instanceof Error ? e.message : String(e))
      const code =
        cfg.target === 'github' && !msg.includes('git ls-remote')
          ? 'no-access'
          : /启动 git/.test(msg)
            ? 'no-git'
            : 'no-access'
      return {
        ok: false,
        code,
        message:
          cfg.target === 'local'
            ? `本地仓库不可用：${msg}`
            : `远端不可达：${msg}（https 远端请检查 URL 与令牌；ssh 远端请检查 key/agent）`
      }
    }
  }

  /** GitHub 模式：不存在时一键创建空私有仓库 */
  async createRepo(): Promise<{ fullName: string; url: string }> {
    const cfg = await this.deps.getBackupConfig()
    if (cfg.target !== 'github') throw new BackupError('只有 GitHub 模式支持一键建库')
    return this.deps.createRepo(sanitizeOwnerRepo(cfg.githubRepo, '仓库名'))
  }

  async setToken(token: string): Promise<boolean> {
    const t = token.trim()
    if (!t) throw new BackupError('令牌不能为空')
    if (t.includes('\n') || t.includes('\0')) throw new BackupError('令牌包含非法字符')
    await this.deps.setCustomToken(t)
    return true
  }

  async clearToken(): Promise<boolean> {
    await this.deps.setCustomToken(null)
    return true
  }

  /* ---------------- 内部流程 ---------------- */

  /** 解析推送地址；本地模式会顺手把裸仓库准备好 */
  private async resolveRemote(cfg: BackupConfig): Promise<string> {
    const tokens = {
      github: await this.deps.getGitHubToken().catch(() => null),
      custom: await this.deps.getCustomToken().catch(() => null)
    }
    const remote = buildBackupRemoteUrl(cfg, tokens)
    if (cfg.target === 'local') {
      await this.ensureLocalBare(remote)
    }
    return remote
  }

  /** 本地目录不存在则建裸仓库；已存在非仓库则拒绝（避免把用户目录变成 git 仓库） */
  private async ensureLocalBare(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true })
    const entries = await fs.readdir(dir)
    if (!entries.length) {
      await runGit(['init', '--bare', '--initial-branch=main', dir], process.cwd()).catch(async () => {
        // 老版本 git 不认 --initial-branch，退化为默认初始化
        await runGit(['init', '--bare', dir], process.cwd())
      })
      return
    }
    // 非空目录：必须是裸仓库才继续
    try {
      const { stdout } = await runGit(['rev-parse', '--is-bare-repository'], dir)
      if (stdout.trim() !== 'true') {
        throw new BackupError(`本地目录非空且不是裸仓库，已拒绝：${dir}（请另选空目录）`)
      }
    } catch (e) {
      if (e instanceof BackupError) throw e
      throw new BackupError(`本地目录不是可用的 git 仓库：${dir}`)
    }
  }

  private async backupOne(ws: Workspace, cfg: BackupConfig, remote: string): Promise<BackupWorkspaceResult> {
    const fail = (message: string): BackupWorkspaceResult => ({
      workspaceId: ws.id,
      name: ws.name,
      ok: false,
      message,
      commitSha: null
    })
    const st = await fs.stat(ws.path).catch(() => null)
    if (!st || !st.isDirectory()) return fail('目录不存在，已跳过（可能被移走或删除）')

    const branch = sanitizeBranch(cfg.branch)
    const gitignoreCreated = await ensureSaneGitignore(ws.path).catch(() => false)

    // 初始化：没有 .git 就建；-b 让首个提交直接落在备份分支上
    const hasGit = await fs
      .access(path.join(ws.path, '.git'))
      .then(() => true)
      .catch(() => false)
    if (!hasGit) {
      try {
        await runGit(['init', '-b', branch], ws.path)
      } catch {
        await runGit(['init'], ws.path)
      }
    }

    // 远端：只维护 lagent-backup，用户的 origin 原样不动
    const want = remote
    const current = await runGit(['remote', 'get-url', BACKUP_REMOTE_NAME], ws.path)
      .then((r) => r.stdout.trim())
      .catch(() => null)
    if (current !== want) {
      await runGit(['remote', 'remove', BACKUP_REMOTE_NAME], ws.path).catch(() => undefined)
      await runGit(['remote', 'add', BACKUP_REMOTE_NAME, want], ws.path)
    }

    // 先看后加：干净时连 add 都省了，大仓库每次轮询只花一次 status 的扫描
    const { stdout: before } = await runGit(['status', '--porcelain'], ws.path)
    if (!before.trim()) {
      return {
        workspaceId: ws.id,
        name: ws.name,
        ok: true,
        clean: true,
        message: gitignoreCreated ? '工作区干净，无需提交（已自动创建 .gitignore）' : '工作区干净，无需提交',
        commitSha: null
      }
    }
    const changedFiles = before.trim().split('\n').length
    await runGit(['add', '-A'], ws.path)
    const { stdout: porcelain } = await runGit(['status', '--porcelain'], ws.path)
    if (!porcelain.trim()) {
      return {
        workspaceId: ws.id,
        name: ws.name,
        ok: true,
        clean: true,
        message: '工作区干净，无需提交',
        commitSha: null
      }
    }

    await runGit(
      ['-c', `user.name=${BACKUP_USER}`, '-c', `user.email=${BACKUP_USER}@local`, 'commit', '-m', formatBackupMessage()],
      ws.path
    )
    const { stdout: shaOut } = await runGit(['rev-parse', 'HEAD'], ws.path)
    const sha = shaOut.trim()

    try {
      await runGit(['push', BACKUP_REMOTE_NAME, `HEAD:refs/heads/${branch}`], ws.path)
    } catch (e) {
      const msg = redactSecrets(e instanceof Error ? e.message : String(e))
      return {
        workspaceId: ws.id,
        name: ws.name,
        ok: false,
        message: `已提交 ${sha.slice(0, 7)} 但推送失败：${msg}（远端分叉时请手动处理，不要强推）`,
        commitSha: sha
      }
    }
    return {
      workspaceId: ws.id,
      name: ws.name,
      ok: true,
      message: `${gitignoreCreated ? '已自动创建 .gitignore；' : ''}${changedFiles} 个文件有变化，已推送 ${sha.slice(0, 7)} 到 ${branch}`,
      commitSha: sha
    }
  }
}

/**
 * 限流并发：保序（结果顺序与输入一致），其中一个失败不影响其他。
 * 备份场景工作区之间相互独立，并发 2 是磁盘与速度的折中。
 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next
      next += 1
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}
