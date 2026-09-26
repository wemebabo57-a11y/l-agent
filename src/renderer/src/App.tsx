import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppSettings,
  PermissionMode,
  ProviderConfig,
  RepoTarget,
  Session,
  SessionSummary,
  Workspace
} from '@shared/types'
import { api, messageOf, unwrap } from './lib/api'
import { formatRelative } from './lib/format'
import { Alert, Button, Spinner } from './components/ui'
import { ChatView } from './components/ChatView'
import { UsageView } from './components/UsageView'
import { WorkspaceView } from './components/WorkspaceView'
import { SkillView } from './components/SkillView'
import { PluginView } from './components/PluginView'
import { GitHubView } from './components/GitHubView'
import { SettingsView } from './components/SettingsView'
import {
  IconChart,
  IconChat,
  IconClose,
  IconFolder,
  IconGithub,
  IconPlugin,
  IconPlus,
  IconSettings,
  IconSkill
} from './components/icons'

type Page = 'chat' | 'workspace' | 'skills' | 'plugins' | 'github' | 'usage' | 'settings'

const NAV: { id: Page; label: string; Icon: (p: { size?: number }) => React.JSX.Element }[] = [
  { id: 'chat', label: '对话', Icon: IconChat },
  { id: 'workspace', label: '工作区', Icon: IconFolder },
  { id: 'skills', label: 'Skill', Icon: IconSkill },
  { id: 'plugins', label: '插件', Icon: IconPlugin },
  { id: 'github', label: 'GitHub', Icon: IconGithub },
  { id: 'usage', label: '用量', Icon: IconChart },
  { id: 'settings', label: '设置', Icon: IconSettings }
]

/** 权限档位的界面呈现：颜色 + 一句人话，让用户随时知道助手能做什么 */
const MODE_INFO: Record<PermissionMode, { label: string; hint: string; tone: 'ok' | 'warn' | 'danger' }> = {
  full: { label: '完全权限', hint: '所有操作直接执行，不再询问', tone: 'danger' },
  workspace: { label: '工作区内更改', hint: '工作区内自由读写，其余操作需确认', tone: 'warn' },
  smart: { label: '智能', hint: '按操作风险分级，有副作用的会询问', tone: 'ok' }
}

export default function App(): React.JSX.Element {
  const [page, setPage] = useState<Page>('chat')
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [weakKeyStorage, setWeakKeyStorage] = useState(false)
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [session, setSession] = useState<Session | null>(null)
  /** 聊天框下方的目标二选一：本地工作区或远端仓库（选了仓库就直接在仓库改） */
  const [repoTarget, setRepoTarget] = useState<RepoTarget | null>(null)
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null)
  const [activeModel, setActiveModel] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; kind: 'info' | 'error' } | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  const notify = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    setNotice({ text, kind })
    // 错误留下让用户看清；普通提示 3.5s 自动消失
    if (kind === 'info') setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 3500)
  }, [])

  const reloadProviders = useCallback(async () => {
    setProviders(await unwrap(api.providers.list()))
  }, [])

  const reloadWorkspaces = useCallback(async () => {
    setWorkspaces(await unwrap(api.workspace.list()))
  }, [])

  const reloadSessions = useCallback(async () => {
    setSessions(await unwrap(api.sessions.list()))
  }, [])

  /* ---------------- 启动初始化 ---------------- */
  useEffect(() => {
    void (async () => {
      try {
        const s = await unwrap(api.settings.get())
        const { weakKeyStorage: weak, ...rest } = s
        setSettings(rest)
        setWeakKeyStorage(Boolean(weak))
        setActiveProviderId(s.activeProviderId)
        setActiveModel(s.activeModel)

        const [p, w, sess] = await Promise.all([
          unwrap(api.providers.list()),
          unwrap(api.workspace.list()),
          unwrap(api.sessions.list())
        ])
        setProviders(p)
        setWorkspaces(w)
        setSessions(sess)

        // 指定工作区：优先用设置里的，否则用第一个
        const wsId = w[0]?.id ?? null
        setActiveWorkspaceId(wsId)

        // 会话：复用最近的，没有就新建
        if (sess.length) {
          const full = await unwrap(api.sessions.get(sess[0].id))
          if (full) setSession(full)
          else setSession(await unwrap(api.sessions.create({ workspaceId: wsId })))
        } else {
          setSession(await unwrap(api.sessions.create({ workspaceId: wsId })))
        }

        // 供应商/模型的默认选择：设置里的若失效则回落到第一个可用项
        const usable = p.filter((x) => x.enabled)
        const pid = p.some((x) => x.id === s.activeProviderId) ? s.activeProviderId : (usable[0]?.id ?? null)
        setActiveProviderId(pid)
        const prov = p.find((x) => x.id === pid)
        const model = prov?.models.includes(s.activeModel ?? '') ? s.activeModel : (prov?.models[0] ?? null)
        setActiveModel(model)

        setReady(true)
      } catch (e) {
        setBootError(messageOf(e))
        setReady(true)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 追踪当前会话 id。用 ref 而不是闭包变量，订阅只建立一次，
   * 不会因为切会话反复拆装监听器（漏事件就是这么来的）。
   */
  const sessionRef = useRef<string | null>(null)
  useEffect(() => {
    sessionRef.current = session?.id ?? null
  }, [session?.id])

  /**
   * 同上：订阅回调只建立一次，newSession 需要拿到最新的工作区，
   * 用 ref 兜住，免得闭包停在首帧的空值上。
   */
  const workspaceRef = useRef<string | null>(null)
  useEffect(() => {
    workspaceRef.current = activeWorkspaceId
  }, [activeWorkspaceId])

  /**
   * 本端正在删除的会话 id。删当前会话时 removeSession 自己会切到下一條，
   * 推送回调不该再切一次——否则可能多出一个空白会话。
   */
  const deletingRef = useRef<string | null>(null)

  /**
   * 订阅主进程的会话变更推送。
   *
   * 没有这段时：助手回复是在 chat:send 这个 invoke 里跑完才落盘的，
   * 而 invoke 的 Promise 要到整轮结束才 resolve；这期间渲染进程既不重拉，
   * 也收不到任何通知——表现就是「消息被吞了，重新进一次会话才显示」。
   * 这里在每次写盘后按需拉全量，左栏列表用事件自带的摘要就地更新。
   */
  useEffect(() => {
    const off = api.sessions.onChanged((e) => {
      // 左栏列表：摘要在事件里，就地更新，避免每次都重拉整个列表
      setSessions((prev) => {
        if (!e.summary) return prev.filter((s) => s.id !== e.sessionId)
        const idx = prev.findIndex((s) => s.id === e.sessionId)
        if (idx < 0) return [e.summary, ...prev]
        const next = [...prev]
        next[idx] = e.summary
        return next.sort((a, b) => b.updatedAt - a.updatedAt)
      })

      // 当前会话：拉全量。事件只带摘要，避免把带工具结果的超大会话塞进 IPC
      if (sessionRef.current !== e.sessionId) return
      if (!e.summary) {
        // 自己刚点的删除由 removeSession 收尾，这里不重复切
        if (deletingRef.current === e.sessionId) return
        // 当前会话被别处删掉：换一条，没有就新建，别停在已不存在的会话上
        void (async () => {
          try {
            const next = await unwrap(api.sessions.list())
            if (next.length) await openSession(next[0].id)
            else await newSession()
          } catch {
            /* 交给用户下一步操作兜底 */
          }
        })()
        return
      }
      void unwrap(api.sessions.get(e.sessionId))
        .then((full) => {
          if (full && sessionRef.current === full.id) setSession(full)
        })
        .catch(() => undefined)
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ---------------- 顶部选择器联动 ---------------- */
  useEffect(() => {
    if (!ready) return
    const prov = providers.find((p) => p.id === activeProviderId)
    if (!prov) return
    const model = prov.models.includes(activeModel ?? '') ? activeModel : (prov.models[0] ?? null)
    if (model !== activeModel) setActiveModel(model)
    void api.settings.update({ activeProviderId, activeModel: model })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProviderId, ready])

  const pickModel = (m: string): void => {
    setActiveModel(m)
    void api.settings.update({ activeModel: m })
  }

  const pickWorkspace = (id: string | null): void => {
    setActiveWorkspaceId(id)
    // 选了仓库就不再挂工作区，两者互斥
    if (id) setRepoTarget(null)
    if (session) {
      const next = { ...session, workspaceId: id }
      setSession(next)
      void api.sessions.save(next)
    }
  }

  /**
   * 目标切换：选仓库时把工作区让出去，反之亦然，保证始终只有一个目标。
   * 目标随会话一起落盘，下次打开还是这个仓库/工作区。
   */
  const pickRepoTarget = (r: RepoTarget | null): void => {
    setRepoTarget(r)
    if (session) {
      const next = { ...session, workspaceId: r ? null : session.workspaceId }
      setSession(next)
      void api.sessions.save(next)
    }
  }

  /* ---------------- 会话操作 ---------------- */
  const newSession = async (): Promise<void> => {
    try {
      const s = await unwrap(api.sessions.create({ workspaceId: workspaceRef.current }))
      setSession(s)
      await reloadSessions()
      setPage('chat')
    } catch (e) {
      notify(messageOf(e), 'error')
    }
  }

  const openSession = async (id: string): Promise<void> => {
    try {
      const s = await unwrap(api.sessions.get(id))
      if (s) {
        setSession(s)
        if (s.workspaceId) setActiveWorkspaceId(s.workspaceId)
        setRepoTarget(s.repoTarget ?? null)
        setPage('chat')
      }
    } catch (e) {
      notify(messageOf(e), 'error')
    }
  }

  const removeSession = async (id: string): Promise<void> => {
    try {
      deletingRef.current = id
      await unwrap(api.sessions.remove(id))
      const next = await unwrap(api.sessions.list())
      setSessions(next)
      if (session?.id === id) {
        if (next.length) await openSession(next[0].id)
        else await newSession()
      }
    } catch (e) {
      notify(messageOf(e), 'error')
    } finally {
      deletingRef.current = null
    }
  }

  const onSessionUpdated = useCallback((s: Session) => {
    setSession(s)
    void reloadSessions().catch(() => undefined)
  }, [reloadSessions])

  const activeProvider = useMemo(
    () => providers.find((p) => p.id === activeProviderId) ?? null,
    [providers, activeProviderId]
  )

  const enabledProviders = providers.filter((p) => p.enabled)

  /* ---------------- 渲染 ---------------- */

  if (!ready || !settings) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh', gap: 12 }}>
        <div style={{ textAlign: 'center' }}>
          <Spinner />
          <div className="muted" style={{ marginTop: 10 }}>
            正在启动…
          </div>
        </div>
      </div>
    )
  }

  if (bootError) {
    return (
      <div style={{ padding: 30 }}>
        <Alert kind="error">
          初始化失败：{bootError}
          <br />
          重启应用通常可以恢复；若反复失败，可删除应用数据目录后重试。
        </Alert>
      </div>
    )
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">L</div>
          <div className="brand-name">lagent</div>
        </div>

        <nav className="nav">
          {NAV.map((n) => (
            <button
              key={n.id}
              className={`nav-item${page === n.id ? ' active' : ''}`}
              onClick={() => setPage(n.id)}
            >
              <span className="nav-icon">
                <n.Icon size={15} />
              </span>
              <span>{n.label}</span>
              {n.id === 'workspace' && workspaces.length ? (
                <span className="nav-badge">{workspaces.length}</span>
              ) : null}
            </button>
          ))}
        </nav>

        <div className="sidebar-section-title">
          <span style={{ flex: 1 }}>会话</span>
          <Button size="sm" variant="ghost" onClick={() => void newSession()} title="新建会话">
            <IconPlus size={13} />
          </Button>
        </div>
        <div className="session-list">
          {sessions.length === 0 ? (
            <div className="muted tiny" style={{ padding: 8 }}>
              暂无会话
            </div>
          ) : (
            sessions.map((s) => (
              <div
                key={s.id}
                className={`session-item${session?.id === s.id ? ' active' : ''}`}
                onClick={() => void openSession(s.id)}
                title={`${s.messageCount} 条消息 · ${s.totalTokens} tokens`}
              >
                <span className="session-main">
                  <span className="session-title">{s.title}</span>
                  <span className="session-meta">
                    {s.messageCount} 条 · {formatRelative(s.updatedAt)}
                  </span>
                </span>
                <button
                  className="btn btn-ghost btn-sm btn-icon"
                  title="删除会话"
                  onClick={(e) => {
                    e.stopPropagation()
                    void removeSession(s.id)
                  }}
                >
                  <IconClose size={11} />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="sidebar-foot">
          <span className="mono">{activeProvider ? activeProvider.name : '未选择供应商'}</span>
          <span className="mono" style={{ opacity: 0.8 }}>
            {activeModel ?? '未选择模型'}
          </span>
          <span className={`pill tiny pill-${MODE_INFO[settings.permissionMode].tone}`} title={MODE_INFO[settings.permissionMode].hint}>
            {MODE_INFO[settings.permissionMode].label}
          </span>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <span className="muted tiny">供应商</span>
          <select
            className="select"
            style={{ width: 150 }}
            value={activeProviderId ?? ''}
            onChange={(e) => setActiveProviderId(e.target.value || null)}
          >
            <option value="">未选择</option>
            {enabledProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <span className="muted tiny">模型</span>
          <select
            className="select"
            style={{ width: 210 }}
            value={activeModel ?? ''}
            onChange={(e) => pickModel(e.target.value)}
            disabled={!activeProvider}
          >
            {!activeProvider || activeProvider.models.length === 0 ? (
              <option value="">
                {activeProvider ? '（该供应商未配置模型）' : '（请先选择供应商）'}
              </option>
            ) : (
              activeProvider.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))
            )}
          </select>

          <div className="topbar-spacer" />

          <button
            className={`pill permission-pill tone-${MODE_INFO[settings.permissionMode].tone}`}
            title={`${MODE_INFO[settings.permissionMode].hint}（点击前往设置）`}
            onClick={() => setPage('settings')}
          >
            {MODE_INFO[settings.permissionMode].label}
          </button>

          {providers.length === 0 ? (
            <Button size="sm" variant="primary" onClick={() => setPage('settings')}>
              配置供应商
            </Button>
          ) : null}
        </div>

        {notice ? (
          <div style={{ padding: '10px 14px 0' }}>
            <Alert kind={notice.kind === 'error' ? 'error' : 'info'}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1 }}>{notice.text}</span>
                <button className="btn btn-ghost btn-sm" onClick={() => setNotice(null)} title="关闭">
                  <IconClose size={12} />
                </button>
              </span>
            </Alert>
          </div>
        ) : null}

        <div className="content">
          {page === 'chat' ? (
            session ? (
              <ChatView
                session={session}
                onSessionUpdated={onSessionUpdated}
                providers={providers}
                workspaces={workspaces}
                activeWorkspaceId={activeWorkspaceId}
                activeProviderId={activeProviderId}
                activeModel={activeModel}
                repoTarget={repoTarget}
                onRepoTargetChange={pickRepoTarget}
                onPickWorkspace={pickWorkspace}
                onOpenGitHub={() => setPage('github')}
              />
            ) : (
              <div className="page">
                <Spinner />
              </div>
            )
          ) : null}

          {page === 'workspace' ? (
            <WorkspaceView
              workspaces={workspaces}
              activeId={activeWorkspaceId}
              onSelect={pickWorkspace}
              onChanged={() => void reloadWorkspaces()}
              onNotice={notify}
            />
          ) : null}

          {page === 'skills' ? <SkillView onNotice={notify} /> : null}
          {page === 'plugins' ? <PluginView onNotice={notify} /> : null}
          {page === 'github' ? <GitHubView onNotice={notify} /> : null}
          {page === 'usage' ? <UsageView onNotice={notify} /> : null}

          {page === 'settings' ? (
            <SettingsView
              settings={settings}
              providers={providers}
              weakKeyStorage={weakKeyStorage}
              onSettingsChanged={(s) => setSettings(s)}
              onProvidersChanged={() => void reloadProviders()}
              onNotice={notify}
            />
          ) : null}
        </div>
      </main>
    </div>
  )
}
