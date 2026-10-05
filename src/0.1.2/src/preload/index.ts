import { contextBridge, ipcRenderer } from 'electron'
import { CH } from '@shared/ipc'
import type {
  AppSettings,
  ChatMessage,
  PluginMeta,
  ProviderConfig,
  ProviderInput,
  ReleaseInput,
  RemoteCommitInput,
  RepoTarget,
  Result,
  Session,
  SessionSummary,
  SkillMeta,
  StreamEvent,
  UsageRecord,
  UsageStats,
  Workspace
} from '@shared/types'

/**
 * 渲染进程只能通过这里暴露的白名单方法访问主进程。
 * 不暴露 ipcRenderer 本体，避免渲染进程任意调用通道。
 */
const api = {
  settings: {
    get: () => ipcRenderer.invoke(CH.settingsGet) as Promise<Result<AppSettings & { weakKeyStorage: boolean }>>,
    update: (patch: Partial<AppSettings>) =>
      ipcRenderer.invoke(CH.settingsUpdate, patch) as Promise<Result<AppSettings>>
  },

  providers: {
    list: () => ipcRenderer.invoke(CH.providerList) as Promise<Result<ProviderConfig[]>>,
    save: (input: ProviderInput) => ipcRenderer.invoke(CH.providerSave, input) as Promise<Result<ProviderConfig>>,
    remove: (id: string) => ipcRenderer.invoke(CH.providerDelete, id) as Promise<Result<ProviderConfig[]>>,
    test: (id: string) =>
      ipcRenderer.invoke(CH.providerTest, id) as Promise<
        Result<{ models: string[]; latencyMs: number; message: string }>
      >,
    models: (id: string) => ipcRenderer.invoke(CH.providerModels, id) as Promise<Result<string[]>>
  },

  sessions: {
    list: () => ipcRenderer.invoke(CH.sessionList) as Promise<Result<SessionSummary[]>>,
    get: (id: string) => ipcRenderer.invoke(CH.sessionGet, id) as Promise<Result<Session | null>>,
    create: (init: { workspaceId?: string | null; repoTarget?: RepoTarget | null }) =>
      ipcRenderer.invoke(CH.sessionCreate, init) as Promise<Result<Session>>,
    remove: (id: string) => ipcRenderer.invoke(CH.sessionDelete, id) as Promise<Result<void>>,
    rename: (id: string, title: string) =>
      ipcRenderer.invoke(CH.sessionRename, id, title) as Promise<Result<boolean>>,
    clear: (id: string) => ipcRenderer.invoke(CH.sessionClear, id) as Promise<Result<boolean>>,
    pin: (id: string, pinned: boolean) =>
      ipcRenderer.invoke(CH.sessionPin, id, pinned) as Promise<Result<boolean>>,
    save: (s: Session) => ipcRenderer.invoke(CH.sessionSave, s) as Promise<Result<void>>,
    /**
     * 订阅会话变更（主进程写盘后推送）。
     * 事件不携带完整会话，只带 id 与摘要，渲染进程按需拉全量——
     * 避免把带工具结果的超大会话每次都塞进 IPC。
     */
    onChanged: (handler: (e: { sessionId: string; summary: SessionSummary | null }) => void): (() => void) => {
      const listener = (_e: unknown, payload: { sessionId: string; summary: SessionSummary | null }): void =>
        handler(payload)
      ipcRenderer.on(CH.sessionChanged, listener)
      return () => ipcRenderer.removeListener(CH.sessionChanged, listener)
    }
  },

  chat: {
    send: (payload: {
      sessionId: string
      providerId: string
      model: string
      text: string
      workspaceId: string | null
      /** 远端仓库目标；与 workspaceId 二选一 */
      repo?: { owner: string; repo: string; branch: string } | null
      allowWrite: boolean
    }) =>
      ipcRenderer.invoke(CH.chatSend, payload) as Promise<
        Result<{ runId: string; appended: ChatMessage[]; usage: UsageRecord }>
      >,
    abort: (runId: string) => ipcRenderer.invoke(CH.chatAbort, runId) as Promise<Result<boolean>>,
    respondApproval: (requestId: string, approved: boolean) =>
      ipcRenderer.invoke(CH.chatApprovalRespond, requestId, approved) as Promise<Result<boolean>>,
    /** 订阅流式事件；返回取消订阅函数 */
    onEvent: (handler: (e: StreamEvent) => void): (() => void) => {
      const listener = (_e: unknown, payload: StreamEvent): void => handler(payload)
      ipcRenderer.on(CH.chatEvent, listener)
      return () => ipcRenderer.removeListener(CH.chatEvent, listener)
    }
  },

  usage: {
    list: (limit?: number) => ipcRenderer.invoke(CH.usageList, limit) as Promise<Result<UsageRecord[]>>,
    stats: () => ipcRenderer.invoke(CH.usageStats) as Promise<Result<UsageStats>>,
    clear: () => ipcRenderer.invoke(CH.usageClear) as Promise<Result<boolean>>
  },

  workspace: {
    list: () => ipcRenderer.invoke(CH.wsList) as Promise<Result<Workspace[]>>,
    pick: () => ipcRenderer.invoke(CH.wsPick) as Promise<Result<string | null>>,
    add: (dir: string) => ipcRenderer.invoke(CH.wsAdd, dir) as Promise<Result<Workspace>>,
    remove: (id: string) => ipcRenderer.invoke(CH.wsRemove, id) as Promise<Result<Workspace[]>>,
    tree: (id: string, rel = '', depth = 1) =>
      ipcRenderer.invoke(CH.wsTree, id, rel, depth) as Promise<Result<unknown[]>>,
    read: (id: string, rel: string) => ipcRenderer.invoke(CH.wsRead, id, rel) as Promise<Result<unknown>>,
    write: (id: string, rel: string, text: string) =>
      ipcRenderer.invoke(CH.wsWrite, id, rel, text) as Promise<Result<unknown>>,
    search: (id: string, q: string, opts?: Record<string, unknown>) =>
      ipcRenderer.invoke(CH.wsSearch, id, q, opts) as Promise<Result<unknown[]>>,
    reveal: (id: string, rel: string) => ipcRenderer.invoke(CH.wsReveal, id, rel) as Promise<Result<boolean>>
  },

  skills: {
    list: () => ipcRenderer.invoke(CH.skillList) as Promise<Result<SkillMeta[]>>,
    importFiles: () => ipcRenderer.invoke(CH.skillImportFiles) as Promise<Result<SkillMeta[]>>,
    importFolder: () => ipcRenderer.invoke(CH.skillImportFolder) as Promise<Result<SkillMeta[]>>,
    importZip: () => ipcRenderer.invoke(CH.skillImportZip) as Promise<Result<SkillMeta[]>>,
    toggle: (id: string, enabled: boolean) =>
      ipcRenderer.invoke(CH.skillToggle, id, enabled) as Promise<Result<SkillMeta[]>>,
    remove: (id: string) => ipcRenderer.invoke(CH.skillDelete, id) as Promise<Result<SkillMeta[]>>,
    read: (id: string) =>
      ipcRenderer.invoke(CH.skillRead, id) as Promise<Result<{ meta: SkillMeta; text: string }>>
  },

  plugins: {
    list: () => ipcRenderer.invoke(CH.pluginList) as Promise<Result<PluginMeta[]>>,
    importFolder: () => ipcRenderer.invoke(CH.pluginImportFolder) as Promise<Result<PluginMeta>>,
    importZip: () => ipcRenderer.invoke(CH.pluginImportZip) as Promise<Result<PluginMeta>>,
    toggle: (id: string, enabled: boolean) =>
      ipcRenderer.invoke(CH.pluginToggle, id, enabled) as Promise<Result<PluginMeta[]>>,
    remove: (id: string) => ipcRenderer.invoke(CH.pluginDelete, id) as Promise<Result<PluginMeta[]>>,
    panel: (id: string) =>
      ipcRenderer.invoke(CH.pluginPanel, id) as Promise<Result<{ html: string; permissions: string[] }>>,
    reveal: (id: string) => ipcRenderer.invoke(CH.pluginReveal, id) as Promise<Result<boolean>>,
    invoke: (id: string, method: string, payload?: unknown, workspaceId?: string | null) =>
      ipcRenderer.invoke(CH.pluginInvoke, id, method, payload, workspaceId ?? null) as Promise<
        Result<unknown>
      >
  },

  screen: {
    /** 显示器列表 + 平台能力探测 + 当前前台窗口 */
    list: () =>
      ipcRenderer.invoke(CH.screenList) as Promise<
        Result<{
          displays: import('@shared/types').ScreenInfo[]
          capabilities: import('@shared/types').CapabilityReport
          activeWindow: import('@shared/types').ActiveWindowInfo | null
        }>
      >,
    activeWindow: () =>
      ipcRenderer.invoke(CH.screenActiveWindow) as Promise<
        Result<import('@shared/types').ActiveWindowInfo | null>
      >,
    test: () =>
      ipcRenderer.invoke(CH.screenTest) as Promise<Result<import('@shared/types').CapabilityReport>>,
    /** 手动截一张，返回 base64 PNG 供设置页预览 */
    capture: () =>
      ipcRenderer.invoke(CH.screenCapture) as Promise<
        Result<{ width: number; height: number; mediaType: string; data: string; capturedAt: number }>
      >
  },

  github: {
    authState: () => ipcRenderer.invoke(CH.ghAuthState) as Promise<Result<unknown>>,
    setToken: (token: string) => ipcRenderer.invoke(CH.ghSetToken, token) as Promise<Result<unknown>>,
    logout: () => ipcRenderer.invoke(CH.ghLogout) as Promise<Result<boolean>>,
    repos: (page?: number) => ipcRenderer.invoke(CH.ghRepos, page) as Promise<Result<unknown[]>>,
    searchRepos: (q: string) => ipcRenderer.invoke(CH.ghSearchRepos, q) as Promise<Result<unknown[]>>,
    tree: (owner: string, repo: string, ref: string) =>
      ipcRenderer.invoke(CH.ghRepoTree, owner, repo, ref) as Promise<Result<unknown[]>>,
    branches: (owner: string, repo: string) =>
      ipcRenderer.invoke(CH.ghBranches, owner, repo) as Promise<Result<string[]>>,
    readFile: (owner: string, repo: string, path: string, ref: string) =>
      ipcRenderer.invoke(CH.ghReadFile, owner, repo, path, ref) as Promise<Result<unknown>>,
    commit: (input: RemoteCommitInput) => ipcRenderer.invoke(CH.ghCommit, input) as Promise<Result<unknown>>,
    createRelease: (input: ReleaseInput) =>
      ipcRenderer.invoke(CH.ghCreateRelease, input) as Promise<Result<unknown>>,
    listReleases: (owner: string, repo: string) =>
      ipcRenderer.invoke(CH.ghListReleases, owner, repo) as Promise<Result<unknown[]>>,
    pullToWorkspace: (owner: string, repo: string, path: string, ref: string, wsId: string) =>
      ipcRenderer.invoke(CH.ghBlobToWorkspace, owner, repo, path, ref, wsId) as Promise<Result<unknown>>
  },

  app: {
    info: () => ipcRenderer.invoke(CH.appInfo) as Promise<Result<Record<string, unknown>>>,
    openExternal: (url: string) => ipcRenderer.invoke(CH.openExternal, url) as Promise<Result<boolean>>
  }
}

contextBridge.exposeInMainWorld('lagent', api)

export type LagentApi = typeof api
