import { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, shell } from 'electron'
import { promises as fsp } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import { CH } from '@shared/ipc'
import type { AppSettings, RemoteFileChange, ToolRisk, Workspace } from '@shared/types'
import { err, ok } from '@shared/types'

import { AgentRunner, newRunId } from './agent/runner'
import type { ApprovalRequest } from './agent/toolTypes'
import type { ToolDeps } from './agent/tools'
import { GitHubClient, GitHubError, looksLikeToken } from './github'
import { PluginError, PluginManager } from './plugins'
import {
  ScreenError,
  activeWindow,
  captureScreen,
  click,
  drag,
  listDisplays,
  pressKeys,
  probeCapabilities,
  scroll,
  typeText
} from './screen'
import { sessionStore } from './sessions'
import { ShellError, runCommand } from './shell'
import { SkillError, SkillManager } from './skills'
import {
  DEFAULT_SETTINGS,
  dataDir,
  maskKey,
  providerStore,
  secretStore,
  settingsStore,
  workspaceStore
} from './store'
import { usageStore } from './usage'
import { WorkspaceError, WorkspaceManager, safeResolve } from './workspace'

interface ProviderInput {
  id?: string
  name?: string
  kind: 'openai' | 'anthropic'
  baseURL?: string
  apiKey?: string
  models?: string[]
  enabled?: boolean
  temperature?: number
  maxTokens?: number | null
  headers?: Record<string, string>
}

interface ChatSendPayload {
  sessionId: string
  providerId: string
  model: string
  text: string
  workspaceId?: string | null
  allowWrite: boolean
}

/** 最近一次截图的位置与缩放信息，用于把模型给的截图坐标换算回屏幕坐标 */
interface LastCapture {
  at: number
  width: number
  height: number
  originX: number
  originY: number
  scale: number
}

/* ------------------------------------------------------------------ */
/* 审批桥：主进程发起 → 渲染进程确认 → 回填 Promise                     */
/* ------------------------------------------------------------------ */

const wsManager = new WorkspaceManager(DEFAULT_SETTINGS.ignore)
const skillManager = new SkillManager()
const github = new GitHubClient()
const pluginManager = new PluginManager()
let lastCapture: LastCapture | null = null

let mainWindow: BrowserWindow | null = null
const pendingApprovals = new Map<string, { resolve: (v: boolean) => void; timer: NodeJS.Timeout }>()
const activeRuns = new Map<string, AbortController>()
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1_000

function sendToRenderer(event: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(CH.chatEvent, event)
  }
}

function requestApprovalFor(runId: string, request: ApprovalRequest): Promise<boolean> {
  const requestId = `ap_${randomUUID().slice(0, 8)}`
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(requestId)
      sendToRenderer({
        type: 'approval_resolved',
        requestId,
        approved: false,
        reason: '等待确认超时（5 分钟），已按拒绝处理'
      })
      resolve(false)
    }, APPROVAL_TIMEOUT_MS)
    pendingApprovals.set(requestId, { resolve, timer })
    sendToRenderer({
      type: 'approval',
      runId,
      requestId,
      tool: request.tool,
      title: request.title,
      detail: request.detail,
      risk: request.risk
    })
  })
}

function rejectAllPending(reason: string): void {
  for (const [id, p] of pendingApprovals) {
    clearTimeout(p.timer)
    p.resolve(false)
    sendToRenderer({ type: 'approval_resolved', requestId: id, approved: false, reason })
  }
  pendingApprovals.clear()
}

/**
 * 统一 IPC 包装：异常转成 Result，绝不穿透成渲染进程的未捕获错误。
 * 必须透传 (event, ...args)，否则带参通道会静默拿到 undefined。
 * 泛型 A 保留被包装函数的参数类型，让 tsc 能校验每个 handler 的入参。
 */
function wrap<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  return async (_event: unknown, ...args: A) => {
    try {
      return ok(await fn(...args))
    } catch (e) {
      // 直接透传；其余异常统一按 Error.message 处理，避免穿透成未捕获错误
      const message =
        e instanceof WorkspaceError ||
        e instanceof SkillError ||
        e instanceof GitHubError ||
        e instanceof PluginError ||
        e instanceof ScreenError ||
        e instanceof ShellError
          ? e.message
          : ((e as Error)?.message ?? String(e))
      return err(message)
    }
  }
}

/* ------------------------------------------------------------------ */
/* 端到端烟雾测试：加载真实页面，在渲染上下文里跑一遍关键链路。          */
/* 只在 LAGENT_SMOKE=1 时启用，生产构建不会执行。                        */
/* ------------------------------------------------------------------ */

async function runSmokeTest(): Promise<void> {
  const fail = (why: string): void => {
    console.log(`SMOKE_FAIL ${why}`)
    setTimeout(() => app.exit(1), 100)
  }
  if (!mainWindow) return fail('主窗口未创建')
  const wc = mainWindow.webContents
  const pageErrors: string[] = []
  wc.on('console-message', (_e, level, message) => {
    // React 的严格模式警告也会走 console，只有 error 级别算失败
    if (level >= 3) pageErrors.push(message)
  })
  wc.on('render-process-gone', (_e, d) => fail(`渲染进程退出：${d.reason}`))
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('页面加载超时')), 30_000)
      if (!wc.isLoading()) {
        clearTimeout(timer)
        resolve()
        return
      }
      wc.once('did-finish-load', () => {
        clearTimeout(timer)
        resolve()
      })
      wc.once('did-fail-load', (_e, code, desc) => {
        clearTimeout(timer)
        reject(new Error(`加载失败 ${code} ${desc}`))
      })
    })
    // 等 React 完成挂载
    await new Promise((r) => setTimeout(r, 1200))
    // 在渲染上下文里跑一遍关键链路：preload 暴露面、React 挂载、各 IPC 通道的真实往返
    const report = (await wc.executeJavaScript(
      `(async () => {
         const out = { ok: true, issues: [] };
         try {
           const need = ['settings','providers','sessions','chat','usage','workspace','skills','plugins','screen','github','app'];
           for (const k of need) {
             if (!window.lagent || typeof window.lagent[k] !== 'object') { out.ok = false; out.issues.push('缺少 API: ' + k); }
           }
           const root = document.getElementById('root');
           if (!root || root.childElementCount === 0) { out.ok = false; out.issues.push('React 未渲染'); }
           if (!document.querySelector('.sidebar')) { out.ok = false; out.issues.push('侧边栏未渲染'); }
           const s = await window.lagent.settings.get();
           if (!s.ok) out.issues.push('settings.get 失败: ' + s.error);
           else {
             // 权限档位必须能从设置里读出来，否则权限判定拿到 undefined 会静默失败
             if (!['full','workspace','smart'].includes(s.value.permissionMode)) {
               out.issues.push('permissionMode 非法: ' + String(s.value.permissionMode));
             }
             if (typeof s.value.shellEnabled !== 'boolean') out.issues.push('shellEnabled 缺失');
             if (typeof s.value.screenCapture !== 'boolean') out.issues.push('screenCapture 缺失');
           }
           const created = await window.lagent.sessions.create({ workspaceId: null });
           if (!created.ok) out.issues.push('sessions.create 失败: ' + created.error);
           else {
             const back = await window.lagent.sessions.get(created.value.id);
             if (!back.ok || !back.value) out.issues.push('sessions.get 失败');
           }
           const st = await window.lagent.usage.stats();
           if (!st.ok || typeof st.value.cacheHitRate !== 'number') out.issues.push('usage.stats 异常');
           const g = await window.lagent.github.authState();
           if (!g.ok) out.issues.push('github.authState 失败: ' + g.error);
           const sk = await window.lagent.skills.list();
           if (!sk.ok) out.issues.push('skills.list 失败: ' + sk.error);
           const w = await window.lagent.workspace.list();
           if (!w.ok) out.issues.push('workspace.list 失败: ' + w.error);
           const pl = await window.lagent.plugins.list();
           if (!pl.ok || !Array.isArray(pl.value)) out.issues.push('plugins.list 异常');
           // 屏幕能力探测要在无头环境下也能安全返回，不能抛错
           const sl = await window.lagent.screen.list();
           if (!sl.ok) out.issues.push('screen.list 失败: ' + sl.error);
           else if (!sl.value || !sl.value.capabilities || typeof sl.value.capabilities.capture !== 'boolean') {
             out.issues.push('screen.list 返回结构异常');
           }
         } catch (e) { out.ok = false; out.issues.push('异常: ' + (e && e.message ? e.message : String(e))); }
         return out;
       })()`,
      true
    )) as { ok: boolean; issues: string[] }
    if (pageErrors.length) {
      return fail(`页面报错：${pageErrors.slice(0, 3).join(' | ')}`)
    }
    if (!report.ok || report.issues.length) {
      return fail(`自检问题：${report.issues.join('; ')}`)
    }
    console.log('SMOKE_OK 所有链路通过')
    setTimeout(() => app.exit(0), 100)
  } catch (e) {
    fail((e as Error).message)
  }
}

/* ------------------------------------------------------------------ */
/* 构造送给 runner 的 ToolDeps                                          */
/*                                                                    */
/* 关键：能力开关在这里「求值一次」并固化进 deps。                       */
/* 因此一次 run 内权限设置不会中途变化，模型看到的工具集与判定依据始终一致。*/
/* ------------------------------------------------------------------ */

async function requireWorkspace(id: string): Promise<Workspace> {
  const list = await workspaceStore.list()
  const ws = list.find((w) => w.id === id)
  if (!ws) throw new Error('工作区不存在，请重新选择')
  return ws
}

async function sanitizeProvider<T extends { id: string }>(
  p: T
): Promise<T & { hasKey: boolean; keyMask: string | null }> {
  const key = await secretStore.get(p.id)
  return { ...p, hasKey: Boolean(key), keyMask: key ? maskKey(key) : null }
}

async function assembleDeps(settings: AppSettings, workspace: Workspace | null): Promise<ToolDeps> {
  const ws: ToolDeps['ws'] = {
    listDir: (w, rel, depth) => wsManager.listDir(w as Workspace, rel, depth),
    readFile: (w, rel, max) => wsManager.readFile(w as Workspace, rel, max),
    writeFile: (w, rel, text, o) => wsManager.writeFile(w as Workspace, rel, text, o),
    search: (w, q, o) => wsManager.search(w as Workspace, q, o),
    collectFiles: (w, limit) => wsManager.collectFiles(w as Workspace, limit)
  }

  const githubDeps: ToolDeps['github'] = {
    enabled: () => true,
    listDir: (owner, repo, ref, p) => github.listDir(owner, repo, ref, p),
    readFile: (owner, repo, p, ref) => github.readFile(owner, repo, p, ref),
    writeFiles: async (
      owner: string,
      repo: string,
      branch: string,
      message: string,
      changes: RemoteFileChange[],
      baseBranch?: string
    ) => {
      const r = await github.commit({ owner, repo, branch, baseBranch, message, changes, openPR: false })
      return { commitSha: r.commitSha, commitUrl: r.commitUrl, branch: r.branch }
    }
  }

  const shellDep: ToolDeps['shell'] = settings.shellEnabled
    ? {
        enabled: () => true,
        cwd: () => resolveShellCwd(settings, workspace),
        policy: () => ({
          allowlist: settings.shellAllowlist ?? [],
          denylist: settings.shellDenylist ?? [],
          allowPipe: false
        }),
        timeoutMs: () => settings.shellTimeoutMs,
        run: (command, signal) =>
          runCommand(command, {
            cwd: resolveShellCwd(settings, workspace),
            timeoutMs: settings.shellTimeoutMs,
            policy: {
              allowlist: settings.shellAllowlist ?? [],
              denylist: settings.shellDenylist ?? [],
              // 管道与重定向默认关闭：它们能把无害命令串成危险命令
              allowPipe: false
            },
            signal
          }),
        describe: () => {
          const cwd = resolveShellCwd(settings, workspace)
          const interp = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
          const lines = [
            `可以执行命令（shell_run）。解释器：${interp}，默认目录：${cwd}，单条超时 ${Math.round(
              settings.shellTimeoutMs / 1_000
            )} 秒。`,
            '管道、重定向与命令串联默认不可用；一条命令只做一件事。'
          ]
          if (settings.shellAllowlist?.length) lines.push(`白名单：${settings.shellAllowlist.join('、')}`)
          if (settings.shellDenylist?.length)
            lines.push(`黑名单（会被直接拒绝）：${settings.shellDenylist.join('、')}`)
          return lines.join('\n')
        }
      }
    : undefined

  const screenDep: ToolDeps['screen'] =
    settings.screenCapture || settings.screenInput
      ? {
          captureEnabled: () => settings.screenCapture,
          inputEnabled: () => settings.screenInput,
          humanize: () => settings.screenHumanize,
          maxEdge: () => settings.screenMaxEdge,
          displayId: () => settings.screenDisplayId,
          allowedWindows: () => settings.screenWindowAllowlist ?? [],
          capabilities: () => probeCapabilities(),
          capture: async (signal) => {
            const shot = await captureScreen({
              displayId: settings.screenDisplayId,
              maxEdge: settings.screenMaxEdge,
              signal
            })
            lastCapture = {
              at: shot.capturedAt,
              width: shot.width,
              height: shot.height,
              originX: shot.originX,
              originY: shot.originY,
              scale: shot.scale
            }
            const w = Math.round(shot.width / shot.scale)
            const h = Math.round(shot.height / shot.scale)
            return {
              b64: shot.data,
              caption: `屏幕截图 ${shot.width}×${shot.height}（原分辨率 ${w}×${h}），截于 ${new Date(
                shot.capturedAt
              ).toLocaleTimeString('zh-CN')}`,
              text: [
                `已截取屏幕，图片尺寸 ${shot.width}×${shot.height} 像素。`,
                '坐标说明：你在图上量到的像素坐标可直接用于 screen_click / screen_drag，程序会自动换算回屏幕实际坐标。',
                '如果界面在这之后发生了变化，请重新截图——旧的坐标可能点错位置。'
              ].join('\n')
            }
          },
          click: (p, o, signal) => click(p, { ...o, humanize: settings.screenHumanize, signal }),
          type: (text, signal) => typeText(text, { signal }),
          keys: (keys, signal) => pressKeys(keys, { signal }),
          scroll: (amount, at, signal) => scroll(amount, at ?? undefined, { signal }),
          drag: (from, to, signal) => drag({ from, to, signal }),
          activeWindow: () => activeWindow(),
          toScreen: (x, y) => toScreenCoords(x, y),
          lastCapture: () =>
            lastCapture
              ? { at: lastCapture.at, width: lastCapture.width, height: lastCapture.height }
              : null
        }
      : undefined

  return { ws, maxReadBytes: settings.maxReadBytes, github: githubDeps, shell: shellDep, screen: screenDep }
}

/** 命令工作目录：显式设置 > 工作区根 > 用户主目录 */
function resolveShellCwd(settings: AppSettings, workspace: Workspace | null): string {
  if (settings.shellCwd && settings.shellCwd.trim()) return settings.shellCwd.trim()
  if (workspace) return workspace.path
  return os.homedir()
}

/**
 * 截图坐标 → 屏幕坐标。
 * 模型在缩放后的图上量坐标，换算两步：先除以缩放比回到物理像素，再加回截图原点。
 */
function toScreenCoords(x: number, y: number): { x: number; y: number } {
  if (!lastCapture) return { x, y }
  const { originX, originY, scale } = lastCapture
  const s = scale > 0 ? scale : 1
  return { x: Math.round(originX + x / s), y: Math.round(originY + y / s) }
}

/* ------------------------------------------------------------------ */
/* 注册自定义协议供插件面板加载自己的 HTML 与静态资源。                  */
/*                                                                    */
/* 为什么不走 srcdoc：srcdoc iframe 会继承宿主 CSP，而宿主设了          */
/* script-src 'self'，面板里任何内联脚本都会被拦掉。                     */
/* 为什么不走 file://：那会让面板拿到 file 源的权限，能顺着路径读到任意本地文件。*/
/*                                                                    */
/* 并给响应一个不透明的 origin，面板拿不到宿主的数据。                    */
/* ------------------------------------------------------------------ */

const PLUGIN_SCHEME = 'lagent-plugin'

function registerPluginProtocol(): void {
  protocol.handle(PLUGIN_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const pluginId = decodeURIComponent(url.hostname)
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const info = await pluginManager.panelFile(pluginId)
      if (!info) return new Response('插件面板不可用', { status: 404 })
      const target = rel ? path.resolve(info.root, rel) : info.entry
      const within = path.relative(info.root, target)
      if (within.startsWith('..') || path.isAbsolute(within)) {
        return new Response('路径越界', { status: 403 })
      }
      const data = await fsp.readFile(target)
      const ext = path.extname(target).toLowerCase()
      const mime =
        ext === '.html'
          ? 'text/html'
          : ext === '.js' || ext === '.mjs'
            ? 'text/javascript'
            : ext === '.css'
              ? 'text/css'
              : ext === '.json'
                ? 'application/json'
                : ext === '.svg'
                  ? 'image/svg+xml'
                  : ext === '.png'
                    ? 'image/png'
                    : 'application/octet-stream'
      return new Response(data, {
        headers: {
          'Content-Type': `${mime}; charset=utf-8`,
          // 面板是独立文档，给它宽松但仅限自身的 CSP：可跑脚本，不能外联
          'Content-Security-Policy': `default-src 'self' 'unsafe-inline' data:; script-src 'self' 'unsafe-inline'; connect-src 'none'; object-src 'none'`
        }
      })
    } catch {
      return new Response('插件资源读取失败', { status: 500 })
    }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0e14',
    title: 'lagent',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  // 外链交给系统浏览器，不在应用内打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith('file://')
    if (!allowed) {
      event.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  /* ---------- 设置 ---------- */
  ipcMain.handle(
    CH.settingsGet,
    wrap(async () => {
      const s = await settingsStore.get()
      return { ...s, weakKeyStorage: await secretStore.isWeaklyProtected() }
    })
  )
  ipcMain.handle(
    CH.settingsUpdate,
    wrap(async (patch: Partial<AppSettings>) => settingsStore.update((s) => ({ ...s, ...patch })))
  )

  /* ---------- 供应商 ---------- */
  ipcMain.handle(
    CH.providerList,
    wrap(async () => {
      const list = await providerStore.list()
      return Promise.all(list.map(sanitizeProvider))
    })
  )
  ipcMain.handle(
    CH.providerSave,
    wrap(async (input: ProviderInput) => {
      const id = input.id ?? randomUUID()
      if (!input.baseURL?.trim()) throw new Error('baseURL 不能为空')
      if (!/^https?:\/\//i.test(input.baseURL)) throw new Error('baseURL 必须以 http:// 或 https:// 开头')
      const record = {
        id,
        name: input.name?.trim() || '未命名供应商',
        kind: input.kind,
        baseURL: input.baseURL.trim().replace(/\/+$/, ''),
        hasKey: false,
        keyMask: null as string | null,
        models: (input.models ?? []).filter(Boolean),
        enabled: input.enabled ?? true,
        temperature: Math.max(0, Math.min(Number(input.temperature ?? 0.7), 2)),
        maxTokens: input.maxTokens ?? null,
        headers: input.headers
      }
      if (input.apiKey !== undefined) {
        if (input.apiKey === '') await secretStore.remove(id)
        else await secretStore.set(id, input.apiKey.trim())
      }
      const hasKey = (await secretStore.get(id)) != null
      if (!hasKey && record.kind === 'anthropic') {
        throw new Error('Anthropic 协议必须提供 API Key')
      }
      await providerStore.save(record)
      return sanitizeProvider(record)
    })
  )
  ipcMain.handle(
    CH.providerDelete,
    wrap(async (id: string) => {
      const list = await providerStore.remove(id)
      const settings = await settingsStore.get()
      if (settings.activeProviderId === id) {
        await settingsStore.update((s) => ({
          ...s,
          activeProviderId: list[0]?.id ?? null,
          activeModel: list[0]?.models[0] ?? null
        }))
      }
      return Promise.all(list.map(sanitizeProvider))
    })
  )
  ipcMain.handle(
    CH.providerTest,
    wrap(async (id: string) => {
      const list = await providerStore.list()
      const p = list.find((x) => x.id === id)
      if (!p) throw new Error('供应商不存在')
      const key = (await secretStore.get(id)) ?? ''
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 20_000)
      const started = Date.now()
      try {
        const res = await fetch(`${p.baseURL}/models`, {
          headers:
            p.kind === 'anthropic'
              ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
              : { Authorization: `Bearer ${key}`, ...(p.headers ?? {}) },
          signal: controller.signal
        })
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          throw new Error(`HTTP ${res.status}：${body.slice(0, 300)}`)
        }
        const json = (await res.json()) as { data?: { id?: string }[] }
        const models = (json.data ?? []).map((m) => m.id).filter((x): x is string => Boolean(x))
        return {
          models,
          latencyMs: Date.now() - started,
          message: `连接成功，发现 ${models.length} 个模型`
        }
      } finally {
        clearTimeout(timer)
      }
    })
  )
  ipcMain.handle(
    CH.providerModels,
    wrap(async (id: string) => {
      const list = await providerStore.list()
      const p = list.find((x) => x.id === id)
      if (!p) throw new Error('供应商不存在')
      const key = (await secretStore.get(id)) ?? ''
      const res = await fetch(`${p.baseURL}/models`, {
        headers:
          p.kind === 'anthropic'
            ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
            : { Authorization: `Bearer ${key}`, ...(p.headers ?? {}) }
      })
      if (!res.ok) throw new Error(`拉取模型列表失败：HTTP ${res.status}`)
      const json = (await res.json()) as { data?: { id?: string }[] }
      return (json.data ?? []).map((m) => m.id).filter((x): x is string => Boolean(x))
    })
  )

  /* ---------- 会话 ---------- */
  ipcMain.handle(CH.sessionList, wrap(() => sessionStore.list()))
  ipcMain.handle(CH.sessionGet, wrap((id: string) => sessionStore.get(id)))
  ipcMain.handle(CH.sessionCreate, wrap((init) => sessionStore.create(init ?? {})))
  ipcMain.handle(CH.sessionDelete, wrap((id: string) => sessionStore.remove(id)))
  ipcMain.handle(
    CH.sessionRename,
    wrap(async (id: string, title: string) => {
      await sessionStore.rename(id, title)
      return true
    })
  )
  ipcMain.handle(
    CH.sessionClear,
    wrap(async (id: string) => {
      await sessionStore.clearMessages(id)
      return true
    })
  )
  ipcMain.handle(CH.sessionSave, wrap((s) => sessionStore.save(s)))

  /* ---------- 用量 ---------- */
  ipcMain.handle(CH.usageList, wrap((limit?: number) => usageStore.list(limit ?? 200)))
  ipcMain.handle(CH.usageStats, wrap(() => usageStore.stats()))
  ipcMain.handle(
    CH.usageClear,
    wrap(async () => {
      await usageStore.clear()
      return true
    })
  )

  /* ---------- 工作区 ---------- */
  ipcMain.handle(CH.wsList, wrap(() => workspaceStore.list()))
  ipcMain.handle(
    CH.wsPick,
    wrap(async () => {
      if (!mainWindow) return null
      const res = await dialog.showOpenDialog(mainWindow, {
        title: '选择工作区目录',
        properties: ['openDirectory', 'createDirectory']
      })
      if (res.canceled || !res.filePaths.length) return null
      return res.filePaths[0]
    })
  )
  ipcMain.handle(
    CH.wsAdd,
    wrap(async (dirPath: string) => {
      const abs = path.resolve(dirPath)
      const st = await fsp.stat(abs).catch(() => null)
      if (!st || !st.isDirectory()) throw new Error(`目录不存在或不可访问：${abs}`)
      const list = await workspaceStore.list()
      const dup = list.find((w) => path.resolve(w.path).toLowerCase() === abs.toLowerCase())
      if (dup) return dup
      const ws: Workspace = {
        id: randomUUID(),
        name: path.basename(abs) || abs,
        path: abs,
        addedAt: Date.now(),
        ignore: []
      }
      await workspaceStore.save(ws)
      return ws
    })
  )
  ipcMain.handle(CH.wsRemove, wrap((id: string) => workspaceStore.remove(id)))
  ipcMain.handle(
    CH.wsTree,
    wrap(async (wsId: string, rel?: string, depth?: number) => {
      const ws = await requireWorkspace(wsId)
      return wsManager.listDir(ws, rel ?? '', depth ?? 1)
    })
  )
  ipcMain.handle(
    CH.wsRead,
    wrap(async (wsId: string, rel: string) => {
      const ws = await requireWorkspace(wsId)
      const settings = await settingsStore.get()
      return wsManager.readFile(ws, rel, settings.maxReadBytes)
    })
  )
  ipcMain.handle(
    CH.wsWrite,
    wrap(async (wsId: string, rel: string, text: string) => {
      const ws = await requireWorkspace(wsId)
      return wsManager.writeFile(ws, rel, text)
    })
  )
  ipcMain.handle(
    CH.wsSearch,
    wrap(
      async (
        wsId: string,
        query: string,
        opts?: { regex?: boolean; caseSensitive?: boolean; maxResults?: number }
      ) => {
        const ws = await requireWorkspace(wsId)
        return wsManager.search(ws, query, opts ?? {})
      }
    )
  )
  ipcMain.handle(
    CH.wsReveal,
    wrap(async (wsId: string, rel: string) => {
      const ws = await requireWorkspace(wsId)
      shell.showItemInFolder(safeResolve(ws.path, rel))
      return true
    })
  )

  /* ---------- Skill ---------- */
  ipcMain.handle(CH.skillList, wrap(() => skillManager.list()))
  ipcMain.handle(
    CH.skillImportFiles,
    wrap(async () => {
      if (!mainWindow) throw new Error('窗口未就绪')
      const res = await dialog.showOpenDialog(mainWindow, {
        title: '选择 Skill 文件（.md / .zip，可多选）',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Skill 文件', extensions: ['md', 'markdown', 'txt', 'zip'] },
          { name: '全部文件', extensions: ['*'] }
        ]
      })
      if (res.canceled || !res.filePaths.length) return []
      return skillManager.importFiles(res.filePaths)
    })
  )
  ipcMain.handle(
    CH.skillImportFolder,
    wrap(async () => {
      if (!mainWindow) throw new Error('窗口未就绪')
      const res = await dialog.showOpenDialog(mainWindow, {
        title: '选择 Skill 文件夹',
        properties: ['openDirectory']
      })
      if (res.canceled || !res.filePaths.length) return []
      return [await skillManager.importFolder(res.filePaths[0])]
    })
  )
  ipcMain.handle(
    CH.skillImportZip,
    wrap(async () => {
      if (!mainWindow) throw new Error('窗口未就绪')
      const res = await dialog.showOpenDialog(mainWindow, {
        title: '选择 Skill 压缩包',
        properties: ['openFile'],
        filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }]
      })
      if (res.canceled || !res.filePaths.length) return []
      return [await skillManager.importZip(res.filePaths[0])]
    })
  )
  ipcMain.handle(
    CH.skillToggle,
    wrap((id: string, enabled: boolean) => skillManager.toggle(id, enabled))
  )
  ipcMain.handle(CH.skillDelete, wrap((id: string) => skillManager.remove(id)))
  ipcMain.handle(CH.skillRead, wrap((id: string) => skillManager.read(id)))

  /* ---------- 插件 ---------- */
  ipcMain.handle(CH.pluginList, wrap(() => pluginManager.list()))
  ipcMain.handle(
    CH.pluginImportFolder,
    wrap(async () => {
      if (!mainWindow) throw new Error('窗口未就绪')
      const res = await dialog.showOpenDialog(mainWindow, {
        title: '选择插件文件夹',
        properties: ['openDirectory']
      })
      if (res.canceled || !res.filePaths.length) throw new Error('已取消')
      return pluginManager.importFolder(res.filePaths[0])
    })
  )
  ipcMain.handle(
    CH.pluginImportZip,
    wrap(async () => {
      if (!mainWindow) throw new Error('窗口未就绪')
      const res = await dialog.showOpenDialog(mainWindow, {
        title: '选择插件压缩包',
        properties: ['openFile'],
        filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }]
      })
      if (res.canceled || !res.filePaths.length) throw new Error('已取消')
      return pluginManager.importZip(res.filePaths[0])
    })
  )
  ipcMain.handle(
    CH.pluginToggle,
    wrap((id: string, enabled: boolean) => pluginManager.toggle(id, enabled))
  )
  ipcMain.handle(CH.pluginDelete, wrap((id: string) => pluginManager.remove(id)))
  ipcMain.handle(CH.pluginPanel, wrap((id: string) => pluginManager.panel(id)))
  ipcMain.handle(
    CH.pluginReveal,
    wrap(async (id: string) => {
      shell.showItemInFolder(path.join(await pluginManager.dirOf(id), 'manifest.json'))
      return true
    })
  )
  ipcMain.handle(
    CH.pluginInvoke,
    wrap(async (id: string, method: string, payload: unknown, workspaceId?: string | null) => {
      const runId = newRunId()
      // 面板要访问工作区就得拿到真实的 Workspace 与 ToolDeps；
      // 之前这里恒传 null 且不附 deps，导致面板里任何读文件都必然失败。
      const workspace = workspaceId ? await requireWorkspace(workspaceId).catch(() => null) : null
      const settings = await settingsStore.get()
      const deps = await assembleDeps(settings, workspace)
      return pluginManager.invoke(id, method, payload, workspace, {
        allowWrite: true,
        deps,
        requestApproval: (req: { title: string; detail: string; risk: ToolRisk }) =>
          requestApprovalFor(runId, {
            tool: `plugin_panel_${id}`,
            title: req.title,
            detail: req.detail,
            risk: req.risk
          })
      })
    })
  )

  /* ---------- 屏幕 ---------- */
  ipcMain.handle(
    CH.screenList,
    wrap(async () => {
      const [displays, caps, active] = await Promise.all([
        listDisplays().catch(() => []),
        probeCapabilities(),
        activeWindow().catch(() => null)
      ])
      return { displays, capabilities: caps, activeWindow: active }
    })
  )
  ipcMain.handle(
    CH.screenActiveWindow,
    wrap(() => activeWindow())
  )
  ipcMain.handle(
    CH.screenCapture,
    wrap(async () => {
      const settings = await settingsStore.get()
      if (!settings.screenCapture) throw new Error('请先开启「允许读取屏幕」')
      const shot = await captureScreen({
        displayId: settings.screenDisplayId,
        maxEdge: settings.screenMaxEdge
      })
      lastCapture = {
        at: shot.capturedAt,
        width: shot.width,
        height: shot.height,
        originX: shot.originX,
        originY: shot.originY,
        scale: shot.scale
      }
      return {
        width: shot.width,
        height: shot.height,
        mediaType: shot.mediaType,
        data: shot.data,
        capturedAt: shot.capturedAt
      }
    })
  )
  ipcMain.handle(
    CH.screenTest,
    wrap(async () => {
      const caps = await probeCapabilities()
      return caps
    })
  )

  /* ---------- GitHub ---------- */
  ipcMain.handle(
    CH.ghAuthState,
    wrap(async () => {
      const settings = await settingsStore.get()
      github.setBaseURL(settings.githubBaseURL)
      return github.authState()
    })
  )
  ipcMain.handle(
    CH.ghSetToken,
    wrap(async (token: string) => {
      const settings = await settingsStore.get()
      github.setBaseURL(settings.githubBaseURL)
      if (!looksLikeToken(token)) {
        throw new Error('令牌格式不像 GitHub Token（应以 ghp_ / github_pat_ / gho_ 开头）')
      }
      return github.saveToken(token)
    })
  )
  ipcMain.handle(
    CH.ghLogout,
    wrap(async () => {
      await github.logout()
      return true
    })
  )
  ipcMain.handle(CH.ghRepos, wrap((page?: number) => github.listRepos(100, page ?? 1)))
  ipcMain.handle(CH.ghSearchRepos, wrap((q: string) => github.searchRepos(q)))
  ipcMain.handle(
    CH.ghRepoTree,
    wrap((owner: string, repo: string, ref?: string) => github.tree(owner, repo, ref || 'HEAD'))
  )
  ipcMain.handle(CH.ghBranches, wrap((owner: string, repo: string) => github.listBranches(owner, repo)))
  ipcMain.handle(
    CH.ghReadFile,
    wrap((owner: string, repo: string, p: string, ref?: string) =>
      github.readFile(owner, repo, p, ref || 'HEAD')
    )
  )
  ipcMain.handle(CH.ghCommit, wrap((input) => github.commit(input)))
  ipcMain.handle(
    CH.ghBlobToWorkspace,
    wrap(async (owner: string, repo: string, p: string, ref: string, wsId: string) => {
      const ws = await requireWorkspace(wsId)
      const target = safeResolve(ws.path, p)
      const abs = await github.saveRemoteFileToWorkspace(owner, repo, p, ref, target)
      return { ...abs, path: p }
    })
  )

  /* ---------- 应用 ---------- */
  ipcMain.handle(
    CH.appInfo,
    wrap(async () => ({
      version: app.getVersion(),
      platform: process.platform,
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      dataDir: dataDir(),
      encryptionAvailable: safeStorage.isEncryptionAvailable()
    }))
  )
  ipcMain.handle(
    CH.openExternal,
    wrap(async (url: string) => {
      if (!/^https?:\/\//i.test(url)) throw new Error('只允许打开 http/https 链接')
      await shell.openExternal(url)
      return true
    })
  )

  /* ---------- 对话 ---------- */
  ipcMain.handle(
    CH.chatApprovalRespond,
    wrap(async (requestId: string, approved: boolean) => {
      const pending = pendingApprovals.get(requestId)
      if (!pending) throw new Error('该确认请求已失效')
      clearTimeout(pending.timer)
      pendingApprovals.delete(requestId)
      pending.resolve(approved)
      sendToRenderer({
        type: 'approval_resolved',
        requestId,
        approved,
        reason: approved ? undefined : '用户拒绝了该操作'
      })
      return true
    })
  )
  ipcMain.handle(
    CH.chatAbort,
    wrap(async (runId: string) => {
      activeRuns.get(runId)?.abort()
      rejectAllPending('本轮已中断')
      return true
    })
  )
  ipcMain.handle(
    CH.chatSend,
    wrap(async (payload: ChatSendPayload) => {
      const settings = await settingsStore.get()
      const providers = await providerStore.list()
      const provider = providers.find((p) => p.id === payload.providerId)
      if (!provider) throw new Error('供应商不存在，请在「设置」中重新选择')
      if (!provider.enabled) throw new Error(`供应商「${provider.name}」已停用`)
      const apiKey = (await secretStore.get(provider.id)) ?? ''
      if (!apiKey && provider.kind === 'anthropic') throw new Error('该供应商缺少 API Key')
      if (!payload.model) throw new Error('未选择模型')
      const session = await sessionStore.get(payload.sessionId)
      if (!session) throw new Error('会话不存在')
      const workspace = payload.workspaceId
        ? await requireWorkspace(payload.workspaceId).catch(() => null)
        : null
      const runId = newRunId()
      const controller = new AbortController()
      activeRuns.set(runId, controller)

      const userMsg = {
        id: randomUUID(),
        role: 'user' as const,
        content: payload.text,
        createdAt: Date.now()
      }
      const history = [...session.messages, userMsg]
      if (session.messages.length === 0) {
        const title = payload.text.replace(/\s+/g, ' ').trim().slice(0, 40) || '新会话'
        await sessionStore.rename(session.id, title)
      }
      let fileTree: string[] | null = null
      if (workspace && settings.injectWorkspaceTree) {
        fileTree = await wsManager.collectFiles(workspace, 300).catch(() => null)
      }
      const skills = await skillManager.enabledInstructions().catch(() => [] as string[])

      sendToRenderer({ type: 'start', runId, model: payload.model, providerName: provider.name })
      const runner = new AgentRunner(runId, sendToRenderer)
      const toolDeps = await assembleDeps(settings, workspace)
      const pluginTools = await pluginManager.toolDefinitions(toolDeps).catch(() => [])
      try {
        const result = await runner.run({
          sessionId: session.id,
          provider,
          apiKey,
          model: payload.model,
          messages: history,
          settings,
          workspace,
          repoHint: null,
          fileTree,
          skills,
          toolDeps,
          pluginTools,
          allowWrite: payload.allowWrite,
          requestApproval: (req) => requestApprovalFor(runId, req),
          onEvent: () => void 0,
          signal: controller.signal
        })
        // 截图只用于本轮推理，不写入会话：持久化前剔除 images
        const persisted = result.appended.map(({ images: _images, ...rest }) => rest)
        await sessionStore.save({ ...session, messages: [...history, ...persisted] })
        await usageStore.append(result.usage)
        return { runId, appended: persisted, usage: result.usage }
      } finally {
        activeRuns.delete(runId)
      }
    })
  )
}

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */

// 烟雾测试：允许用独立 userData 目录启动，避免污染真实数据
if (process.env.LAGENT_USER_DATA) {
  app.setPath('userData', process.env.LAGENT_USER_DATA)
}
// 单实例锁：避免两个实例并发写同一份数据文件
// 烟雾测试下多个 Electron 实例可能并行，跳过锁
const isSmoke = process.env.LAGENT_SMOKE === '1'
// 自定义协议要在 app ready 之前声明为标准协议并赋予独立源，
// 这样面板 iframe 才有一个与宿主隔离的 origin
protocol.registerSchemesAsPrivileged([
  {
    scheme: PLUGIN_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false }
  }
])
if (!isSmoke && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  void app.whenReady().then(async () => {
    registerPluginProtocol()
    await fsp.mkdir(path.join(dataDir(), 'skills'), { recursive: true }).catch(() => undefined)
    registerIpc()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
    if (isSmoke) void runSmokeTest()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('render-process-gone', (_e, _wc, details) => {
    console.error('[lagent] 渲染进程退出：', details.reason)
  })
}
