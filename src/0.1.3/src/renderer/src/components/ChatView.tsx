import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChatMessage,
  ChatMode,
  ProviderConfig,
  RepoRef,
  RepoTarget,
  SelfAssessedRisk,
  Session,
  StreamEvent,
  ToolRisk,
  UsageRecord,
  Workspace
} from '@shared/types'
import { api, messageOf, unwrap } from '../lib/api'
import { formatCost, formatInt, formatMs, formatPercent } from '../lib/format'
import { ApprovalCard, StreamingBubble, useAutoScroll, MessageView, type StreamingState } from './Message'
import { groupMessagesForView } from '../lib/footprint'
import { Alert, Button, Empty } from './ui'
import { IconBranch, IconGithub, IconStop } from './icons'
import { SlashMenu, detectSlashToken, type SlashCommand, type SlashMenuHandle } from './SlashMenu'

interface ApprovalItem {
  requestId: string
  runId: string
  title: string
  detail: string
  risk: ToolRisk
  selfAssessed?: SelfAssessedRisk
  resolved: boolean
  approved?: boolean
}

export function ChatView({
  session,
  onSessionUpdated,
  providers,
  workspaces,
  activeWorkspaceId,
  activeProviderId,
  activeModel,
  repoTarget,
  onRepoTargetChange,
  onPickWorkspace,
  onOpenGitHub,
  onOpenShortcuts
}: {
  session: Session
  onSessionUpdated: (s: Session) => void
  providers: ProviderConfig[]
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  activeProviderId: string | null
  activeModel: string | null
  /** 选中的远端仓库；与 activeWorkspaceId 二选一 */
  repoTarget: RepoTarget | null
  onRepoTargetChange: (r: RepoTarget | null) => void
  onPickWorkspace: (id: string | null) => void
  onOpenGitHub: () => void
  /** 打开快捷键总览（App 级弹窗，命令面板也能进） */
  onOpenShortcuts: () => void
}): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>(session.messages)
  const [stream, setStream] = useState<StreamingState | null>(null)
  const [approvals, setApprovals] = useState<ApprovalItem[]>([])
  const [input, setInput] = useState('')
  const [allowWrite, setAllowWrite] = useState(true)
  // 三模式：standard 标准 / ptc PTC / minimal 极简，随会话落盘
  const [chatMode, setChatMode] = useState<ChatMode>(session.chatMode ?? 'standard')
  const [error, setError] = useState<string | null>(null)
  const runIdRef = useRef<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  /* 仓库模式：仓库列表 / 分支列表按需拉取，不在首帧就打扰 GitHub */
  const [repos, setRepos] = useState<RepoRef[]>([])
  const [reposLoading, setReposLoading] = useState(false)
  const [branches, setBranches] = useState<string[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [repoError, setRepoError] = useState<string | null>(null)

  /** 拉分支列表；失败时至少保留当前分支，别把选择框清空 */
  const loadBranches = useCallback(
    async (owner: string, repo: string, current: string): Promise<void> => {
      setBranchesLoading(true)
      try {
        const list = (await unwrap(api.github.branches(owner, repo))) as string[]
        setBranches(list.length ? list : [current])
      } catch {
        setBranches([current])
      } finally {
        setBranchesLoading(false)
      }
    },
    []
  )

  /**
   * 打开仓库选择：默认选第一个仓库并带出它的默认分支。
   * 未连接 GitHub 时把错误摆到界面上，给一条去连接的路。
   */
  const openRepoPicker = useCallback(async (): Promise<void> => {
    setRepoError(null)
    setReposLoading(true)
    try {
      const list = (await unwrap(api.github.repos(1))) as RepoRef[]
      setRepos(list)
      if (!list.length) {
        setRepoError('该账号下没有可用仓库')
        return
      }
      const first = list[0]
      onRepoTargetChange({
        owner: first.owner,
        repo: first.name,
        fullName: first.fullName,
        branch: first.defaultBranch
      })
      await loadBranches(first.owner, first.name, first.defaultBranch)
    } catch (e) {
      setRepoError(messageOf(e))
    } finally {
      setReposLoading(false)
    }
  }, [loadBranches, onRepoTargetChange])

  // 已选中仓库但列表还没拉过（例如会话切换后恢复），补一次列表
  useEffect(() => {
    if (!repoTarget || repos.length) return
    setReposLoading(true)
    void unwrap(api.github.repos(1))
      .then((list) => {
        const rows = list as RepoRef[]
        setRepos(rows)
        if (rows.length) void loadBranches(repoTarget.owner, repoTarget.repo, repoTarget.branch)
      })
      .catch((e) => setRepoError(messageOf(e)))
      .then(() => setReposLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoTarget?.fullName])

  // 切换会话：整块重置（切走时必须丢掉上一个会话的流式态）。
  // 输入框走按会话隔离的草稿：先存旧会话、再读新会话，避免切会话串稿或丢稿。
  useEffect(() => {
    try {
      const prevId = (window as unknown as { __lagentDraftSession?: string }).__lagentDraftSession
      if (prevId && prevId !== session.id) {
        // 上个会话的 input state 在这次 effect 跑之前还是旧值，读 ref 兜住它
        const ta = textareaRef.current
        if (ta) localStorage.setItem(`lagent:draft:${prevId}`, ta.value)
      }
    } catch {
      /* 草稿存不下不影响正事 */
    }
    try {
      setInput(localStorage.getItem(`lagent:draft:${session.id}`) ?? '')
    } catch {
      setInput('')
    }
    ;(window as unknown as { __lagentDraftSession?: string }).__lagentDraftSession = session.id
    setChatMode(session.chatMode ?? 'standard')
    setMessages(session.messages)
    setStream(null)
    setApprovals([])
    setError(null)
    runIdRef.current = null
  }, [session.id])

  /**
   * 草稿持续保存：每敲一个字都落到 localStorage（按会话隔离）。
   * 只靠「切换会话时存一次」不够——崩溃/杀进程时切换回调根本跑不到，
   * 输入框里没发出去的半截话就丢了。这里随打随存，崩了重开还能找回来。
   */
  useEffect(() => {
    try {
      const key = `lagent:draft:${session.id}`
      if (input) localStorage.setItem(key, input)
      else localStorage.removeItem(key)
    } catch {
      /* 草稿存不下不影响正事 */
    }
  }, [input, session.id])

  /**
   * 同一个会话被主进程推送了新内容：用服务端全量覆盖本地。
   *
   * 只在「这一轮已结束」时同步——流式过程中本地还握着乐观插入的用户消息，
   * 此时若被覆盖，用户会看到自己刚发的话消失（就是那个「被吞」的观感）。
   * updatedAt 变化说明磁盘上确实有了新版本，覆盖是安全的。
   * sendRequestedRef 补上点击发送→start 事件到达的窗口期：runId 还没建立，
   * 但乐观消息已在本地，此时覆盖同样会闪没。
   */
  useEffect(() => {
    if (runIdRef.current || sendRequestedRef.current) return
    setMessages(session.messages)
  }, [session.id, session.updatedAt])

  /* ---------------- 流式事件订阅 ---------------- */
  useEffect(() => {
    const off = api.chat.onEvent((e: StreamEvent) => {
      switch (e.type) {
        case 'start':
          runIdRef.current = e.runId
          setStream({
            runId: e.runId,
            text: '',
            reasoning: '',
            tools: [],
            usage: null,
            error: null,
            startedAt: Date.now()
          })
          break

        case 'delta':
          setStream((s) => (s ? { ...s, text: s.text + e.text } : s))
          break

        case 'reasoning':
          setStream((s) => (s ? { ...s, reasoning: s.reasoning + e.text } : s))
          break

        case 'tool_call':
          setStream((s) =>
            s
              ? {
                  ...s,
                  tools: s.tools.some((t) => t.id === e.id)
                    ? s.tools
                    : [...s.tools, { id: e.id, name: e.name, state: 'running', summary: '' }]
                }
              : s
          )
          break

        case 'tool_result':
          setStream((s) =>
            s
              ? {
                  ...s,
                  tools: s.tools.map((t) =>
                    t.id === e.id
                      ? { ...t, state: e.ok ? 'done' : 'failed', summary: e.summary }
                      : t
                  )
                }
              : s
          )
          break

        case 'usage':
          // 保留最近一次服务端上报的用量，先按 UsageRecord 的缺省字段填充，
          // done 时会用完整记录（含延迟/成本）覆盖
          setStream((s) =>
            s
              ? {
                  ...s,
                  usage: s.usage
                    ? {
                        ...s.usage,
                        ...e.usage,
                        latencyMs: Date.now() - s.startedAt
                      }
                    : {
                        ...e.usage,
                        id: 'streaming',
                        at: Date.now(),
                        providerId: '',
                        providerName: '',
                        kind: 'openai',
                        model: '',
                        latencyMs: Date.now() - s.startedAt,
                        firstTokenMs: null,
                        tokensPerSecond: null,
                        costUSD: null,
                        sessionId: '',
                        failed: false
                      }
                }
              : s
          )
          break

        case 'approval':
          setApprovals((list) => [
            ...list,
            {
              requestId: e.requestId,
              runId: e.runId,
              title: e.title,
              detail: e.detail,
              risk: e.risk,
              selfAssessed: e.selfAssessed,
              resolved: false
            }
          ])
          break

        case 'approval_resolved':
          setApprovals((list) =>
            list.map((a) => (a.requestId === e.requestId ? { ...a, resolved: true, approved: e.approved } : a))
          )
          break

        case 'error':
          setStream((s) => (s ? { ...s, error: e.message } : s))
          sendRequestedRef.current = false
          break

        case 'done':
          setStream(null)
          runIdRef.current = null
          sendRequestedRef.current = false
          // 用本轮聚合用量覆盖最后一条助手消息的用量，
          // 多轮工具调用时这样才反映整轮的真实消耗
          setMessages((prev) => {
            const next = [...prev, { ...e.message, usage: e.usage }]
            return next
          })
          setReloadTick((n) => n + 1)
          break
      }
    })
    return off
  }, [])

  // done 之后用一个计数器触发一次重新拉取，保证与服务端一致。
  // 注意不能依赖 stream 对象本身——每个 token 增量都会产生新对象，那样会疯狂打 IPC。
  const [reloadTick, setReloadTick] = useState(0)
  useEffect(() => {
    if (reloadTick === 0) return
    let cancelled = false
    void (async () => {
      try {
        const s = await unwrap(api.sessions.get(session.id))
        if (!cancelled && s) {
          setMessages(s.messages)
          onSessionUpdated(s)
        }
      } catch {
        /* 拉取失败不影响已渲染内容 */
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadTick])

  const scrollRef = useAutoScroll([messages.length, stream?.text, stream?.tools.length, approvals.length])

  /* ---------------- 发送 ---------------- */
  // 已点发送、start 事件还没到的窗口期：广播推来的 session 快照不得覆盖乐观消息，
  // 否则用户刚发的话会闪没（"被吞"观感），done/error 落定后清掉
  const sendRequestedRef = useRef(false)
  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || stream) return

    if (!activeProviderId || !activeModel) {
      setError('请先在顶部选择供应商与模型')
      return
    }
    const provider = providers.find((p) => p.id === activeProviderId)
    if (!provider) {
      setError('所选供应商不存在')
      return
    }

    setError(null)
    setInput('')
    sendRequestedRef.current = true
    try {
      // 发出去的就不再是草稿：地毯式清掉，避免回来还躺着半截旧话
      localStorage.removeItem(`lagent:draft:${session.id}`)
    } catch {
      /* 清不掉下次覆盖也一样 */
    }
    // 乐观插入用户消息，避免等待 IPC 往返造成空档
    const optimistic: ChatMessage = {
      id: `local_${Date.now()}`,
      role: 'user',
      content: text,
      createdAt: Date.now()
    }
    setMessages((prev) => [...prev, optimistic])

    try {
      await unwrap(
        api.chat.send({
          sessionId: session.id,
          providerId: activeProviderId,
          model: activeModel,
          text,
          // 二选一：选了仓库就交仓库坐标，主进程直接用 gh_* 工具在远端改
          workspaceId: repoTarget ? null : activeWorkspaceId,
          repo: repoTarget
            ? { owner: repoTarget.owner, repo: repoTarget.repo, branch: repoTarget.branch }
            : null,
          allowWrite
        })
      )
    } catch (e) {
      setError(messageOf(e))
      setStream(null)
      runIdRef.current = null
      sendRequestedRef.current = false
      // 回滚乐观消息，避免留下发不出去的气泡
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id))
      setInput(text)
    }
  }, [
    input,
    stream,
    activeProviderId,
    activeModel,
    providers,
    session.id,
    activeWorkspaceId,
    repoTarget,
    allowWrite
  ])

  /** 切换聊天模式：调主进程落盘，本地同步，避免闪回旧值 */
  const switchMode = useCallback(
    async (m: ChatMode) => {
      if (m === chatMode) return
      setChatMode(m)
      try {
        await unwrap(api.sessions.setMode(session.id, m))
        onSessionUpdated({ ...session, chatMode: m })
      } catch (e) {
        setError(messageOf(e))
        setChatMode(session.chatMode ?? 'standard')
      }
    },
    [chatMode, session, onSessionUpdated]
  );

  const stop = useCallback(async () => {
    const runId = runIdRef.current
    if (runId) await api.chat.abort(runId)
  }, [])

  /* ---------------- 斜杠命令：键盘直达，不用找按钮 ---------------- */
  const [slash, setSlash] = useState<{ query: string; start: number; end: number } | null>(null)
  const slashRef = useRef<SlashMenuHandle | null>(null)

  const slashCommands: SlashCommand[] = useMemo(
    () => [
      {
        id: 'mode',
        name: 'mode',
        aliases: ['模式', '标准', 'std', 'ptc', '极简', 'mini', 'minimal'],
        hint: '切模式：/mode ptc（空参轮换 标准→PTC→极简）',
        run: (arg) => {
          const a = arg.trim().toLowerCase()
          const cycle = (): void => {
            void switchMode(chatMode === 'standard' ? 'ptc' : chatMode === 'ptc' ? 'minimal' : 'standard')
          }
          if (a === 'ptc') void switchMode('ptc')
          else if (a === 'mini' || a === 'minimal' || a === '极简') void switchMode('minimal')
          else if (a === 'std' || a === 'standard' || a === '标准') void switchMode('standard')
          // 空参，或参数就是命令名本身（刚打出 /mode 回车）：轮换
          else if (!a || a === 'mode' || a === '模式') cycle()
          else setError(`未知模式「${arg}」，用 标准 / PTC / 极简`)
        }
      },
      {
        id: 'help',
        name: 'help',
        aliases: ['帮助', '?', 'shortcuts', '快捷键'],
        hint: '快捷键一览',
        run: () => onOpenShortcuts()
      }
    ],
    [switchMode, chatMode, onOpenShortcuts]
  )

  /** 选中斜杠命令：先吃掉输入里的 /token（草稿其余部分不动），再执行 */
  const pickSlash = useCallback(
    (c: SlashCommand, arg: string) => {
      if (slash) {
        const { start, end } = slash
        setInput((text) => text.slice(0, start) + text.slice(end))
      }
      setSlash(null)
      c.run(arg)
      requestAnimationFrame(() => textareaRef.current?.focus())
    },
    [slash]
  )

  const decide = useCallback(async (requestId: string, ok: boolean) => {
    try {
      await unwrap(api.chat.respondApproval(requestId, ok))
    } catch (e) {
      // 卡片过期（run 已结束/已中断）：让用户知道点也没用，而不是静默吞掉
      setError(`确认已失效：${messageOf(e)}`)
    }
  }, [])

  // Ctrl/Cmd+Enter 发送，Enter 换行；斜杠菜单打开时方向键/回车/Tab/Esc 先归菜单
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (slash && slashRef.current?.handleKey(e.key, e.shiftKey)) {
      e.preventDefault()
      return
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void send()
    } else if (e.key === 'Escape' && !slash && stream !== null) {
      // 免找停止键：忙碌时 Esc 直接停
      e.preventDefault()
      void stop()
    }
  }

  const busy = stream !== null
  const pendingApprovals = approvals.filter((a) => !a.resolved)
  const selectedWs = workspaces.find((w) => w.id === activeWorkspaceId)

  /** 跳到最新审批卡：用户翻上去看历史时，新卡片不会被错过 */
  const jumpToLatestApproval = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-inner">
          {messages.length === 0 && !stream ? (
            <Empty title="开始对话">
              在顶部选择供应商与模型后直接提问。
              {repoTarget ? (
                <>
                  <br />
                  <span className="tiny">
                    目标仓库 <span className="mono">{repoTarget.fullName}</span>（分支{' '}
                    <span className="mono">{repoTarget.branch}</span>）：助手直接读远端文件并提交回仓库，
                    不会下载到本地。
                  </span>
                </>
              ) : selectedWs ? (
                <>
                  <br />
                  <span className="tiny">
                    工作区 <span className="mono">{selectedWs.name}</span>，助手可直接读写其中文件。
                  </span>
                </>
              ) : (
                <>
                  <br />
                  <span className="tiny">
                    在下方选择工作区或 GitHub 仓库后，助手才能读写文件。
                  </span>
                </>
              )}
              <br />
              <span className="tiny">
                开启「控制台」和「屏幕」后，助手还能执行命令、查看屏幕并真实点击操作。
              </span>
            </Empty>
          ) : null}

          {/* tool 消息不再整条展示：挂到所属 assistant 消息下，只留一行足迹 */}
          {groupMessagesForView(messages).map((g) => (
            <MessageView key={g.msg.id} message={g.msg} tools={g.tools} />
          ))}

          {pendingApprovals.map((a) => (
            <ApprovalCard
              key={a.requestId}
              title={a.title}
              detail={a.detail}
              risk={a.risk}
              selfAssessed={a.selfAssessed}
              onDecide={(ok) => void decide(a.requestId, ok)}
            />
          ))}

          {stream ? <StreamingBubble state={stream} /> : null}

          {error ? <Alert kind="error">{error}</Alert> : null}
        </div>
      </div>

      <div className="composer">
        <div className="composer-inner">
          <div className="composer-box">
            {slash ? (
              <SlashMenu
                ref={slashRef}
                query={slash.query}
                commands={slashCommands}
                onPick={pickSlash}
                onClose={() => setSlash(null)}
              />
            ) : null}
            <textarea
              ref={textareaRef}
              className="composer-input"
              value={input}
              placeholder={
                busy
                  ? '正在处理…（Esc 停止）'
                  : '描述任务。行首输入 / 切模式、看帮助。'
              }
              rows={1}
              onChange={(e) => {
                const v = e.target.value
                setInput(v)
                const el = e.target
                el.style.height = 'auto'
                el.style.height = `${Math.min(el.scrollHeight, 260)}px`
                // 行首 / 或空白后的 / 才开菜单，URL 里的斜杠不误触
                const caret = el.selectionStart ?? v.length
                const hit = detectSlashToken(v, caret)
                setSlash(hit ? { query: hit.query, start: hit.start, end: hit.end } : null)
              }}
              onKeyDown={onKeyDown}
              disabled={busy}
            />
            <div className="composer-bar">
              {/* 三模式切换：standard 标准 / ptc PTC / minimal 极简；键盘党直接输入 /mode */}
              <div className="target-pick" title="聊天模式：标准 / PTC / 极简（或输入 /mode 切换）">
                {(
                  [
                    { id: 'standard', label: '标准' },
                    { id: 'ptc', label: 'PTC' },
                    { id: 'minimal', label: '极简' }
                  ] as { id: ChatMode; label: string }[]
                ).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`target-mode${chatMode === m.id ? ' active' : ''}`}
                    onClick={() => void switchMode(m.id)}
                    disabled={busy}
                    title={
                      m.id === 'standard'
                        ? '标准模式：原有全部工具'
                        : m.id === 'ptc'
                          ? 'PTC：全部工具+计划确认（先交计划等确认，有 propose_plan/update_plan_step）'
                          : '极简模式：只给基础编码工具（读写查文件）'
                    }
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <label
                className="row-clickable tiny"
                style={{ gap: 5 }}
                title="关闭后助手无法写文件或提交仓库"
              >
                <input
                  type="checkbox"
                  checked={allowWrite}
                  onChange={(e) => setAllowWrite(e.target.checked)}
                />
                允许写入
              </label>
              <div className="topbar-spacer" />

              {/* 目标二选一：本地工作区 或 GitHub 仓库。
                  选仓库时助手直接用 gh_* 工具在远端读写并提交，不下载回本地。 */}
              <div className="target-pick">
                <button
                  type="button"
                  className={`target-mode${repoTarget ? '' : ' active'}`}
                  onClick={() => onRepoTargetChange(null)}
                  title="在本地工作区读写文件"
                >
                  工作区
                </button>
                <button
                  type="button"
                  className={`target-mode${repoTarget ? ' active' : ''}`}
                  onClick={() => {
                    if (!repoTarget) void openRepoPicker()
                  }}
                  title="直接在 GitHub 仓库里改，不下载回本地"
                >
                  <IconGithub size={11} /> 仓库
                </button>

                {repoTarget ? (
                  <>
                    <select
                      className="select select-tight"
                      value={`${repoTarget.owner}/${repoTarget.repo}`}
                      onChange={(e) => {
                        const hit = repos.find((r) => `${r.owner}/${r.name}` === e.target.value)
                        if (hit) {
                          void onRepoTargetChange({
                            owner: hit.owner,
                            repo: hit.name,
                            fullName: hit.fullName,
                            branch: hit.defaultBranch
                          })
                          void loadBranches(hit.owner, hit.name, hit.defaultBranch)
                        }
                      }}
                      disabled={busy || reposLoading}
                      title="选择要编辑的仓库"
                    >
                      {reposLoading ? <option value="">加载中…</option> : null}
                      {!reposLoading && repos.length === 0 ? <option value="">无可用仓库</option> : null}
                      {repos.map((r) => (
                        <option key={r.fullName} value={`${r.owner}/${r.name}`}>
                          {r.fullName}
                          {r.private ? ' (私有)' : ''}
                        </option>
                      ))}
                    </select>

                    <span className="branch-pick" title="提交到该分支">
                      <IconBranch size={11} />
                      <select
                        className="select select-tight"
                        value={repoTarget.branch}
                        onChange={(e) =>
                          onRepoTargetChange({ ...repoTarget, branch: e.target.value })
                        }
                        disabled={busy || branchesLoading}
                      >
                        {branchesLoading ? <option value="">加载中…</option> : null}
                        {branches.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </select>
                    </span>
                  </>
                ) : (
                  <select
                    className="select select-tight"
                    value={activeWorkspaceId ?? ''}
                    onChange={(e) => onPickWorkspace(e.target.value || null)}
                    disabled={busy}
                    title="选择本地工作区目录"
                  >
                    <option value="">不限定工作区</option>
                    {workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                )}

                {repoError ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={onOpenGitHub}
                    title={repoError}
                  >
                    去连接 GitHub
                  </button>
                ) : null}
              </div>
              {busy ? (
                <Button size="sm" variant="danger" onClick={() => void stop()} title="停止本轮（Esc）">
                  <IconStop size={11} /> 停止
                </Button>
              ) : (
                <Button size="sm" variant="primary" onClick={() => void send()} disabled={!input.trim()} title="发送（Ctrl+Enter）">
                  发送
                </Button>
              )}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={onOpenShortcuts}
                title="快捷键一览（Ctrl+/）"
              >
                ?
              </button>
              {pendingApprovals.length ? (
                <button
                  type="button"
                  className="btn btn-sm approval-pill"
                  onClick={jumpToLatestApproval}
                  title="有待确认的操作，点击跳到确认卡"
                >
                  待确认（{pendingApprovals.length}）
                </button>
              ) : null}
              <span className="composer-hint" title="Ctrl+Enter 发送，Enter 换行">
                <span className="kbd">Ctrl</span>
                <span className="kbd">Enter</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 顶部栏中显示的当前轮次实时用量（流式时给即时反馈） */
export function LiveMeter({ usage }: { usage: UsageRecord | null }): React.JSX.Element | null {
  if (!usage) return null
  return (
    <span className="pill tiny">
      ↑{formatInt(usage.inputTokens)} ↓{formatInt(usage.outputTokens)} 命中
      {formatPercent(usage.cachedInputTokens / Math.max(usage.inputTokens, 1), 0)} ·{' '}
      {formatMs(usage.firstTokenMs)} · {formatCost(usage.costUSD)}
    </span>
  )
}
