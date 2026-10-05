import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ChatMessage,
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
import { Alert, Button, Empty } from './ui'
import { IconBranch, IconGithub, IconStop } from './icons'

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
  onOpenGitHub
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
}): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>(session.messages)
  const [stream, setStream] = useState<StreamingState | null>(null)
  const [approvals, setApprovals] = useState<ApprovalItem[]>([])
  const [input, setInput] = useState('')
  const [allowWrite, setAllowWrite] = useState(true)
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
   */
  useEffect(() => {
    if (runIdRef.current) return
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
          break

        case 'done':
          setStream(null)
          runIdRef.current = null
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

  const stop = useCallback(async () => {
    const runId = runIdRef.current
    if (runId) await api.chat.abort(runId)
  }, [])

  const decide = useCallback(async (requestId: string, ok: boolean) => {
    await api.chat.respondApproval(requestId, ok)
  }, [])

  // Ctrl/Cmd+Enter 发送，Enter 换行
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void send()
    }
  }

  const busy = stream !== null
  const pendingApprovals = approvals.filter((a) => !a.resolved)
  const selectedWs = workspaces.find((w) => w.id === activeWorkspaceId)

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

          {messages.map((m) => (
            <MessageView key={m.id} message={m} />
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
            <textarea
              ref={textareaRef}
              className="composer-input"
              value={input}
              placeholder={
                busy
                  ? '正在处理…'
                  : '描述任务。可以读写文件、执行命令、点击屏幕、提交到 GitHub。'
              }
              rows={1}
              onChange={(e) => {
                setInput(e.target.value)
                const el = e.target
                el.style.height = 'auto'
                el.style.height = `${Math.min(el.scrollHeight, 260)}px`
              }}
              onKeyDown={onKeyDown}
              disabled={busy}
            />
            <div className="composer-bar">
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
                <Button size="sm" variant="danger" onClick={() => void stop()}>
                  <IconStop size={11} /> 停止
                </Button>
              ) : (
                <Button size="sm" variant="primary" onClick={() => void send()} disabled={!input.trim()}>
                  发送
                </Button>
              )}
              <span className="composer-hint">
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
