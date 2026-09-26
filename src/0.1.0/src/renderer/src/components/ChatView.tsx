import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ChatMessage,
  ProviderConfig,
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
import { IconStop } from './icons'

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
  activeModel
}: {
  session: Session
  onSessionUpdated: (s: Session) => void
  providers: ProviderConfig[]
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  activeProviderId: string | null
  activeModel: string | null
}): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>(session.messages)
  const [stream, setStream] = useState<StreamingState | null>(null)
  const [approvals, setApprovals] = useState<ApprovalItem[]>([])
  const [input, setInput] = useState('')
  const [allowWrite, setAllowWrite] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const runIdRef = useRef<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 切换会话时同步消息列表
  useEffect(() => {
    setMessages(session.messages)
    setStream(null)
    setApprovals([])
    setError(null)
    runIdRef.current = null
  }, [session.id])

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
          workspaceId: activeWorkspaceId,
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
  }, [input, stream, activeProviderId, activeModel, providers, session.id, activeWorkspaceId, allowWrite])

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
              {selectedWs ? (
                <>
                  <br />
                  <span className="tiny">
                    工作区 <span className="mono">{selectedWs.name}</span>，助手可直接读写其中文件。
                  </span>
                </>
              ) : (
                <>
                  <br />
                  <span className="tiny">在「工作区」添加目录后，助手才能读写本地文件。</span>
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
              {selectedWs ? <span className="pill tiny">{selectedWs.name}</span> : null}
              <div className="topbar-spacer" />
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
