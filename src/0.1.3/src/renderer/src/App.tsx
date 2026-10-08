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
import { ShortcutsModal } from './components/ShortcutsModal'
import { GroupView } from './components/GroupView'
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
  IconPin,
  IconPlugin,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSkill
} from './components/icons'

type Page = 'chat' | 'group' | 'workspace' | 'skills' | 'plugins' | 'github' | 'usage' | 'settings'

const NAV: { id: Page; label: string; Icon: (p: { size?: number }) => React.JSX.Element }[] = [
  { id: 'chat', label: '对话', Icon: IconChat },
  // 群聊复用对话图标，避免新增图标资产
  { id: 'group', label: '群聊', Icon: IconChat },
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

/** 左栏排序：置顶优先，再按更新时间倒序（与主进程 sessionStore 保持一致） */
function sortSessionList(list: SessionSummary[]): SessionSummary[] {
  return [...list].sort((a, b) => {
    const pa = a.pinned ? 1 : 0
    const pb = b.pinned ? 1 : 0
    if (pa !== pb) return pb - pa
    return b.updatedAt - a.updatedAt
  })
}

interface PaletteCommand {
  id: string
  label: string
  hint: string
  run: () => void
}

/**
 * 命令面板：Ctrl+K 唤起，输入过滤，上下键 + 回车执行。
 * 命令只做已有操作的直达入口（新建会话、跳页面、换主题、置顶），不引入新状态机。
 */
function CommandPalette({
  commands,
  onClose
}: {
  commands: PaletteCommand[]
  onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q
      ? commands.filter(
          (c) => c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q)
        )
      : commands
    return list
  }, [commands, query])

  useEffect(() => {
    setSelected(0)
  }, [query, commands])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const runAt = (idx: number): void => {
    const cmd = filtered[idx]
    if (!cmd) return
    onClose()
    cmd.run()
  }

  return (
    <div className="overlay" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose()
    }}>
      <div className="modal" style={{ maxWidth: 480 }} role="dialog" aria-label="命令面板">
        <div className="modal-head">
          <span className="session-search-icon">
            <IconSearch size={13} />
          </span>
          <input
            ref={inputRef}
            className="session-search-input"
            style={{ fontSize: 'var(--text-body)' }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入命令：新建会话、换主题、跳页面…"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSelected((s) => Math.min(s + 1, filtered.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSelected((s) => Math.max(s - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                runAt(selected)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              }
            }}
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="modal-body palette-list">
          {filtered.length === 0 ? (
            <div className="muted tiny" style={{ padding: 10 }}>
              没有匹配「{query.trim()}」的命令
            </div>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                className={`palette-item${i === selected ? ' selected' : ''}`}
                onMouseEnter={() => setSelected(i)}
                onClick={() => runAt(i)}
              >
                <span className="palette-item-main">
                  <span className="palette-item-title">{c.label}</span>
                  <span className="palette-item-hint">{c.hint}</span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
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
  /** 左栏会话搜索框 */
  const [sessionQuery, setSessionQuery] = useState('')
  /** 正在重命名的会话 id（行内输入框） */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  /** 命令面板开关 */
  const [paletteOpen, setPaletteOpen] = useState(false)
  /** 快捷键总览弹窗：Ctrl+/、命令面板、输入框 /help 与 ? 钮共用 */
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

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
        if (idx < 0) return sortSessionList([e.summary, ...prev])
        const next = [...prev]
        next[idx] = e.summary
        return sortSessionList(next)
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

  /* ---------------- 主题 ---------------- */
  /**
   * 把 settings.theme 落到 <html data-theme> 上，CSS 变量随之切换。
   * 'system' 时跟随操作系统浅色/深色，且系统切换时自动跟变。
   */
  useEffect(() => {
    const theme = settings?.theme ?? 'dark'
    const root = document.documentElement
    if (theme !== 'system') {
      root.setAttribute('data-theme', theme)
      return
    }
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const apply = (light: boolean): void => root.setAttribute('data-theme', light ? 'light' : 'dark')
    apply(mq.matches)
    const onChange = (e: MediaQueryListEvent): void => apply(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [settings?.theme])

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
    // 选了工作区就不再挂仓库，两者互斥；落盘也要同步，否则下次打开会话恢复的是旧目标
    if (id) setRepoTarget(null)
    if (session) {
      const next = { ...session, workspaceId: id, repoTarget: id ? null : session.repoTarget }
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
      const next = { ...session, workspaceId: r ? null : session.workspaceId, repoTarget: r }
      setSession(next)
      void api.sessions.save(next)
    }
  }

  /* ---------------- 会话操作 ---------------- */
  const newSession = async (): Promise<void> => {
    try {
      const s = await unwrap(api.sessions.create({ workspaceId: workspaceRef.current }))
      setSession(s)
      // 新会话默认回到本地目标：否则还挂着上一个会话的仓库，下一次发送会提交错地方
      setRepoTarget(null)
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

  /** 置顶/取消置顶：只翻标记，不碰更新时间；列表用摘要就地更新，不重拉 */
  const togglePin = async (id: string, pinned: boolean): Promise<void> => {
    try {
      await unwrap(api.sessions.pin(id, !pinned))
      setSessions((prev) =>
        sortSessionList(prev.map((s) => (s.id === id ? { ...s, pinned: !pinned } : s)))
      )
    } catch (e) {
      notify(messageOf(e), 'error')
    }
  }

  /** 重命名：空标题直接收起输入框，不洗掉原标题 */
  const renameSession = async (id: string): Promise<void> => {
    const t = editingTitle.trim().slice(0, 200)
    setEditingId(null)
    if (!t) return
    try {
      await unwrap(api.sessions.rename(id, t))
      const next = await unwrap(api.sessions.list())
      setSessions(next)
      if (session?.id === id) {
        const full = await unwrap(api.sessions.get(id))
        if (full) setSession(full)
      }
    } catch (e) {
      notify(messageOf(e), 'error')
    }
  }

  /** 清空消息：误发后一键重来，会话本身保留（目标/模式不动） */
  const clearSession = async (id: string): Promise<void> => {
    if (!window.confirm('清空该会话的全部消息？此操作不可撤销，会话本身会保留。')) return
    try {
      await unwrap(api.sessions.clear(id))
      if (session?.id === id) {
        const full = await unwrap(api.sessions.get(id))
        if (full) setSession(full)
      }
      await reloadSessions()
    } catch (e) {
      notify(messageOf(e), 'error')
    }
  }

  /** 左栏搜索：按标题子串过滤，不区分大小写；置顶排序保持不变 */
  const visibleSessions = useMemo(() => {
    const q = sessionQuery.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter((s) => s.title.toLowerCase().includes(q))
  }, [sessions, sessionQuery])

  const onSessionUpdated = useCallback((s: Session) => {
    setSession(s)
    void reloadSessions().catch(() => undefined)
  }, [reloadSessions])

  const setTheme = useCallback(
    (theme: AppSettings['theme']) => {
      if (settings) setSettings({ ...settings, theme })
      void api.settings.update({ theme })
    },
    [settings]
  )

  /**
   * 命令面板的命令表：只收编已有操作的新入口。
   * useMemo 包一层，否则每次渲染都生成新数组，面板的 selected 会乱跳。
   */
  const paletteCommands: PaletteCommand[] = useMemo(
    () => [
      { id: 'new-session', label: '新建会话', hint: '开一个空白对话', run: () => void newSession() },
      { id: 'go-chat', label: '前往：对话', hint: '回到聊天页', run: () => setPage('chat') },
      {
        id: 'go-workspace',
        label: '前往：工作区',
        hint: '管理工作区目录',
        run: () => setPage('workspace')
      },
      { id: 'go-skills', label: '前往：Skill', hint: '管理技能', run: () => setPage('skills') },
      { id: 'go-plugins', label: '前往：插件', hint: '管理插件', run: () => setPage('plugins') },
      { id: 'go-github', label: '前往：GitHub', hint: '连接与仓库操作', run: () => setPage('github') },
      { id: 'go-usage', label: '前往：用量', hint: '查看 token 与成本', run: () => setPage('usage') },
      { id: 'go-settings', label: '前往：设置', hint: '供应商与权限', run: () => setPage('settings') },
      { id: 'theme-dark', label: '主题：深暖', hint: '暖陶土深底', run: () => setTheme('dark') },
      { id: 'theme-light', label: '主题：米纸', hint: '浅纸张', run: () => setTheme('light') },
      { id: 'theme-system', label: '主题：跟随系统', hint: '随操作系统切换', run: () => setTheme('system') },
      { id: 'shortcuts', label: '快捷键一览', hint: '发送/停止/斜杠命令', run: () => setShortcutsOpen(true) },
      ...(session
        ? [
            {
              id: 'pin-current',
              label: session.pinned ? '取消置顶当前会话' : '置顶当前会话',
              hint: session.title,
              run: () => void togglePin(session.id, session.pinned ?? false)
            }
          ]
        : [])
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings?.theme, session?.id, session?.pinned, session?.title]
  )

  /* ---------------- 全局快捷键 ---------------- */
  /**
   * Ctrl/Cmd+K 开关命令面板；面板打开时 Esc 关闭（面板自己处理）。
   * Ctrl/Cmd+/ 开关快捷键总览。输入框里也照常生效——面板就是要在打字时随手唤起。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      } else if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault()
        setShortcutsOpen((v) => !v)
      } else if (e.key === 'Escape' && shortcutsOpen) {
        setShortcutsOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shortcutsOpen])

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
        {sessions.length > 3 ? (
          <div className="session-search">
            <span className="session-search-icon">
              <IconSearch size={12} />
            </span>
            <input
              className="session-search-input"
              value={sessionQuery}
              onChange={(e) => setSessionQuery(e.target.value)}
              placeholder="搜索会话…"
              title="按标题搜索会话"
            />
            {sessionQuery ? (
              <button
                className="btn btn-ghost btn-sm btn-icon"
                title="清空搜索"
                onClick={() => setSessionQuery('')}
              >
                <IconClose size={11} />
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="session-list">
          {sessions.length === 0 ? (
            <div className="muted tiny" style={{ padding: 8 }}>
              暂无会话
            </div>
          ) : visibleSessions.length === 0 ? (
            <div className="muted tiny" style={{ padding: 8 }}>
              没有匹配「{sessionQuery.trim()}」的会话
            </div>
          ) : (
            visibleSessions.map((s) => (
              <div
                key={s.id}
                className={`session-item${session?.id === s.id ? ' active' : ''}${s.pinned ? ' pinned' : ''}`}
                onClick={() => void openSession(s.id)}
                title={`${s.pinned ? '已置顶 · ' : ''}${s.messageCount} 条消息 · ${s.totalTokens} tokens`}
              >
                <span className="session-main">
                  {editingId === s.id ? (
                    <input
                      className="session-search-input"
                      style={{ fontSize: 12 }}
                      value={editingTitle}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void renameSession(s.id)
                        else if (e.key === 'Escape') setEditingId(null)
                      }}
                      onBlur={() => void renameSession(s.id)}
                    />
                  ) : (
                    <span
                      className="session-title"
                      onDoubleClick={(e) => {
                        e.stopPropagation()
                        setEditingId(s.id)
                        setEditingTitle(s.title)
                      }}
                      title="双击重命名"
                    >
                      {s.pinned ? <span className="pin-dot" title="已置顶" /> : null}
                      {s.title}
                    </span>
                  )}
                  <span className="session-meta">
                    {s.messageCount} 条 · {formatRelative(s.updatedAt)}
                  </span>
                </span>
                <button
                  className="btn btn-ghost btn-sm"
                  title="重命名会话"
                  onClick={(e) => {
                    e.stopPropagation()
                    setEditingId(s.id)
                    setEditingTitle(s.title)
                  }}
                >
                  改名
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  title="清空该会话的全部消息"
                  onClick={(e) => {
                    e.stopPropagation()
                    void clearSession(s.id)
                  }}
                >
                  清空
                </button>
                <button
                  className={`btn btn-ghost btn-sm btn-icon pin-btn${s.pinned ? ' on' : ''}`}
                  title={s.pinned ? '取消置顶' : '置顶会话'}
                  onClick={(e) => {
                    e.stopPropagation()
                    void togglePin(s.id, s.pinned ?? false)
                  }}
                >
                  <IconPin size={11} />
                </button>
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
            className="btn btn-ghost btn-sm"
            title="命令面板（Ctrl+K）：新建会话、换主题、跳页面"
            onClick={() => setPaletteOpen(true)}
          >
            <IconSearch size={12} /> 命令
            <span className="kbd" style={{ marginLeft: 4 }}>Ctrl K</span>
          </button>

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
          {/* 页面常驻不卸载：run 进行中切页回来，流式气泡/审批卡/停止键都在。
              卸载会丢掉 ChatView 本地状态（stream、approvals、runId），事件就对不上了。 */}
          <div className="page-keep" style={{ display: page === 'chat' ? undefined : 'none' }}>
            {session ? (
              <ChatView
                session={session}
                onSessionUpdated={onSessionUpdated}
                providers={providers}
                workspaces={workspaces}
                activeWorkspaceId={activeWorkspaceId}
                activeModel={activeModel}
                activeProviderId={activeProviderId}
                repoTarget={repoTarget}
                onRepoTargetChange={pickRepoTarget}
                onPickWorkspace={pickWorkspace}
                onOpenGitHub={() => setPage('github')}
                onOpenShortcuts={() => setShortcutsOpen(true)}
              />
            ) : (
              <div className="page">
                <Spinner />
              </div>
            )}
          </div>

          <div className="page-keep" style={{ display: page === 'group' ? undefined : 'none' }}>
            <GroupView
              sessions={sessions}
              activeProviderId={activeProviderId}
              activeModel={activeModel}
              onNotice={notify}
            />
          </div>

          <div className="page-keep" style={{ display: page === 'workspace' ? undefined : 'none' }}>
            <WorkspaceView
              workspaces={workspaces}
              activeId={activeWorkspaceId}
              onSelect={pickWorkspace}
              onChanged={() => void reloadWorkspaces()}
              onNotice={notify}
            />
          </div>

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

      {paletteOpen ? (
        <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />
      ) : null}
      {shortcutsOpen ? <ShortcutsModal onClose={() => setShortcutsOpen(false)} /> : null}
    </div>
  )
}
