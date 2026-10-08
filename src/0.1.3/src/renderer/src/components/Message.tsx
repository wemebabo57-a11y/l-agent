import { useEffect, useRef, useState } from 'react'
import type { ChatMessage, SelfAssessedRisk, ToolRisk, UsageRecord } from '@shared/types'
import { formatCost, formatInt, formatMs, formatPercent, formatTime } from '../lib/format'
import { summarizeTools, toolLabel } from '../lib/footprint'
import { Button } from './ui'
import { IconAlert, IconCheck, IconClose } from './icons'

/** 流式过程中累积的中间态，消息落库前的展示来源 */
export interface StreamingState {
  runId: string
  text: string
  reasoning: string
  tools: { id: string; name: string; state: 'running' | 'done' | 'failed'; summary: string }[]
  usage: UsageRecord | null
  error: string | null
  startedAt: number
}

/** 工具名中文对照已收敛到 lib/footprint（足迹与工具卡片共用同一份），此处不再重复定义 */

/**
 * 消息正文渲染。
 *
 * 不引入 markdown 库：那会把内容变成 HTML，在本地工具里等于把模型输出
 * 直接当代码执行面。这里只做保守的分段与围栏代码块识别，
 * 输出全部是文本节点，不存在注入路径。
 */
function renderContent(text: string): React.JSX.Element {
  const blocks: { kind: 'text' | 'code'; lang: string; body: string }[] = []
  const lines = text.split('\n')
  let buf: string[] = []
  let inCode = false
  let lang = ''

  for (const line of lines) {
    const fence = /^```(\w*)\s*$/.exec(line)
    if (fence) {
      if (inCode) {
        blocks.push({ kind: 'code', lang, body: buf.join('\n') })
        buf = []
        inCode = false
        lang = ''
      } else {
        if (buf.length) blocks.push({ kind: 'text', lang: '', body: buf.join('\n') })
        buf = []
        inCode = true
        lang = fence[1] ?? ''
      }
      continue
    }
    buf.push(line)
  }
  if (buf.length) blocks.push({ kind: inCode ? 'code' : 'text', lang, body: buf.join('\n') })

  return (
    <>
      {blocks.map((b, i) =>
        b.kind === 'code' ? (
          <pre key={i} className="msg-code">
            <code>{b.body}</code>
          </pre>
        ) : (
          <span key={i}>{b.body}</span>
        )
      )}
    </>
  )
}

export function MessageView({
  message,
  streaming,
  tools
}: {
  message: ChatMessage
  streaming?: boolean
  /** 紧随其后的 tool 消息：折成一行足迹，不再整条展示 */
  tools?: ChatMessage[]
}): React.JSX.Element {
  const isUser = message.role === 'user'
  // 足迹只挂在 assistant 消息下：调用了什么工具、改了哪些文件，一行淡字交代
  const footprint = !isUser && message.role === 'assistant' ? summarizeTools(message, tools ?? []) : null
  return (
    <div className={`msg ${isUser ? 'msg-user' : 'msg-assistant'}`}>
      <div className="msg-gutter">
        <span className="msg-avatar">{isUser ? '你' : 'L'}</span>
      </div>
      <div className="msg-body">
        <div className="msg-meta">
          <span className="msg-who">{isUser ? '你' : 'lagent'}</span>
          <span className="msg-time">{formatTime(message.createdAt)}</span>
          {message.usage?.estimated ? <span className="pill pill-warn tiny">估算用量</span> : null}
        </div>
        <div className={`msg-content${streaming ? ' cursor-blink' : ''}`}>
          {renderContent(message.content)}
        </div>
        {footprint ? (
          <div
            className="msg-footprint"
            title={footprint.tools.map((t) => `${t.label}×${t.count}`).join('、')}
          >
            <span>调用 {footprint.tools.map((t) => `${t.label}${t.count > 1 ? `×${t.count}` : ''}`).join('、')}</span>
            {footprint.files.length ? <span> · 改动 {footprint.files.join('、')}</span> : null}
            {footprint.filesTruncated ? <span> 等 {footprint.filesTruncated} 个</span> : null}
            {footprint.failures ? (
              <span className="msg-footprint-fail"> · {footprint.failures} 个失败</span>
            ) : null}
            {footprint.unknown ? <span> · {footprint.unknown} 个无结果</span> : null}
          </div>
        ) : null}
        {message.usage ? (
          <div className="msg-usage">
            <span title="输入 token">↑ {formatInt(message.usage.inputTokens)}</span>
            <span title="输出 token">↓ {formatInt(message.usage.outputTokens)}</span>
            {message.usage.cachedInputTokens > 0 ? (
              <span title="命中缓存的输入 token" style={{ color: 'var(--ok)' }}>
                缓存 {formatInt(message.usage.cachedInputTokens)}（
                {formatPercent(message.usage.cachedInputTokens / Math.max(message.usage.inputTokens, 1))}）
              </span>
            ) : null}
          </div>
        ) : null}
        {message.error ? <div className="msg-error">{message.error}</div> : null}
      </div>
    </div>
  )
}

/** 流式中的临时气泡：正文增量 + 推理增量 + 工具调用状态 */
export function StreamingBubble({ state }: { state: StreamingState }): React.JSX.Element {
  const [showReasoning, setShowReasoning] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // 计时器：让耗时读数持续走动
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [])

  const hasContent = Boolean(state.text || state.reasoning || state.tools.length)
  const elapsed = (now - state.startedAt) / 1000

  return (
    <div className="msg msg-assistant">
      <div className="msg-gutter">
        <span className="msg-avatar">L</span>
      </div>
      <div className="msg-body">
        <div className="msg-meta">
          <span className="msg-who">lagent</span>
          <span className="pill pill-accent tiny">
            <span className="spin" style={{ width: 7, height: 7, borderWidth: 1.5 }} />
            {state.tools.some((t) => t.state === 'running') ? '执行中' : '生成中'} {elapsed.toFixed(1)}s
          </span>
        </div>

        {state.tools.map((t) => (
          <div key={t.id} className={`tool-card${t.state === 'running' ? ' tool-running' : ''}`}>
            <div className="tool-card-head">
              <span className="tool-name">{toolLabel(t.name)}</span>
              <span className="mono tiny muted">{t.name}</span>
              <div className="topbar-spacer" />
              {t.state === 'running' ? <span className="muted tiny">执行中</span> : null}
              {t.state === 'done' ? (
                <span className="tiny" style={{ color: 'var(--ok)' }}>
                  <IconCheck size={11} /> 完成
                </span>
              ) : null}
              {t.state === 'failed' ? (
                <span className="tiny" style={{ color: 'var(--danger)' }}>
                  <IconClose size={11} /> 失败
                </span>
              ) : null}
            </div>
            {t.summary ? (
              <div className="muted tiny" style={{ marginTop: 3 }}>
                {t.summary}
              </div>
            ) : null}
          </div>
        ))}

        {state.reasoning ? (
          <div className="reasoning">
            <div className="reasoning-head" onClick={() => setShowReasoning((v) => !v)}>
              {showReasoning ? '收起' : '展开'}思考过程（{state.reasoning.length} 字）
            </div>
            {showReasoning ? state.reasoning : null}
          </div>
        ) : null}

        {state.text ? (
          <div className="msg-content cursor-blink">{renderContent(state.text)}</div>
        ) : !hasContent ? (
          <div className="muted" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="spin" />
            等待响应…
          </div>
        ) : null}

        {state.error ? <div className="msg-error">{state.error}</div> : null}

        {state.usage ? (
          <div className="msg-usage">
            <span>↑ {formatInt(state.usage.inputTokens)}</span>
            <span>↓ {formatInt(state.usage.outputTokens)}</span>
            <span>缓存 {formatInt(state.usage.cachedInputTokens)}</span>
            <span>首字 {formatMs(state.usage.firstTokenMs)}</span>
            {state.usage.tokensPerSecond != null ? (
              <span>{state.usage.tokensPerSecond} tok/s</span>
            ) : null}
            <span>{formatCost(state.usage.costUSD)}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** 各风险等级的呈现文案 */
const RISK_INFO: Record<ToolRisk, { label: string; desc: string }> = {
  read: { label: '只读', desc: '不会改变任何东西' },
  write: { label: '写入', desc: '会创建或修改文件' },
  delete: { label: '删除', desc: '会移除数据' },
  remote: { label: '远端', desc: '会推送到 GitHub' },
  shell: { label: '执行命令', desc: '会在你的电脑上运行命令行' },
  screen: { label: '屏幕操作', desc: '会真实操作你的鼠标键盘' }
}

/** 危险操作的确认卡片 */
export function ApprovalCard({
  title,
  detail,
  risk,
  selfAssessed,
  resolved,
  approved,
  onDecide
}: {
  title: string
  detail: string
  risk: ToolRisk
  selfAssessed?: SelfAssessedRisk
  resolved?: boolean
  approved?: boolean
  onDecide: (ok: boolean) => void
}): React.JSX.Element {
  const info = RISK_INFO[risk] ?? RISK_INFO.write
  // 屏幕与命令是"会在你眼皮底下操作电脑"的等级，用最高视觉权重
  const severe = risk === 'screen' || risk === 'shell' || risk === 'delete' || risk === 'remote'

  return (
    <div className={`approval${severe ? ' approval-severe' : ''}`}>
      <div className="approval-title">
        <IconAlert size={14} />
        <span style={{ flex: 1 }}>{title}</span>
        <span className="pill pill-warn tiny" title={info.desc}>
          {info.label}
        </span>
      </div>
      <div className="approval-detail">{detail}</div>

      {selfAssessed ? (
        <div className={`self-risk level-${selfAssessed.level}`}>
          <span className="tiny">模型自评风险：{selfAssessed.level === 'high' ? '高' : selfAssessed.level === 'medium' ? '中' : '低'}</span>
          {selfAssessed.reason ? <span className="tiny muted">｜{selfAssessed.reason}</span> : null}
        </div>
      ) : null}

      {resolved ? (
        <div className="tiny" style={{ color: approved ? 'var(--ok)' : 'var(--danger)' }}>
          {approved ? '已批准并执行' : '已拒绝'}
        </div>
      ) : (
        <div className="row">
          <Button variant="primary" size="sm" onClick={() => onDecide(true)}>
            允许
          </Button>
          <Button variant="danger" size="sm" onClick={() => onDecide(false)}>
            拒绝
          </Button>
        </div>
      )}
    </div>
  )
}

/** 自动滚底：仅当用户本来就贴着底部时才滚，避免打断向上翻阅 */
export function useAutoScroll(deps: unknown[]): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = (): void => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return ref
}
