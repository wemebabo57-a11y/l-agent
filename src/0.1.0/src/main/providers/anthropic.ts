import type { ChatMessage, StreamEvent, ToolCall, Usage } from '@shared/types'
import { parseSse } from './sse'
import {
  describeHttpError,
  estimateUsage,
  ProviderError,
  type ChatRequest,
  type ChatResult,
  type ProviderAdapter,
  type ToolSchema
} from './types'

/**
 * Anthropic Messages API 适配器。
 *
 * 结构差异（与 OpenAI 协议对比）：
 * - system 是顶层字段，不是 messages 里的一条
 * - 工具调用/结果是 content block，不是独立角色
 * - 缓存用量字段：cache_creation_input_tokens / cache_read_input_tokens
 * - 输入 token 总数 = input_tokens + cache_read + cache_creation
 */

interface AnthropicBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

interface AnthropicEvent {
  type: string
  index?: number
  message?: {
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
  content_block?: AnthropicBlock
  delta?: {
    type?: string
    text?: string
    thinking?: string
    partial_json?: string
    stop_reason?: string | null
  }
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  error?: { type?: string; message?: string }
}

function toAnthropicContent(m: ChatMessage): unknown[] | string {
  if (m.role === 'tool') {
    return [
      {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content || '(无输出)'
      }
    ]
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    const blocks: unknown[] = []
    if (m.content) blocks.push({ type: 'text', text: m.content })
    for (const tc of m.toolCalls) {
      let parsed: unknown = {}
      try {
        parsed = tc.argsJson ? JSON.parse(tc.argsJson) : {}
      } catch {
        parsed = {}
      }
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: parsed })
    }
    return blocks
  }
  // 带图消息必须转成 content block 数组：图片块在前、文本在后，
  // 这是 Anthropic 推荐的顺序，图片在前时对图文关联的理解更稳
  if (m.images?.length) {
    const blocks: unknown[] = m.images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data }
    }))
    if (m.content) blocks.push({ type: 'text', text: m.content })
    return blocks
  }
  return m.content
}

function toAnthropicMessages(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      // 多个连续的 tool_result 必须合并进同一条 user 消息
      const last = out[out.length - 1] as { role?: string; content?: unknown } | undefined
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content || '(无输出)' }
      if (last?.role === 'user' && Array.isArray(last.content)) {
        ;(last.content as unknown[]).push(block)
      } else {
        out.push({ role: 'user', content: [block] })
      }
      continue
    }
    if (m.role === 'assistant') {
      if (!m.content && !m.toolCalls?.length) continue
      out.push({ role: 'assistant', content: toAnthropicContent(m) })
      continue
    }
    out.push({ role: 'user', content: toAnthropicContent(m) })
  }
  return out
}

function toAnthropicTools(
  tools: ToolSchema[]
): { name: string; description: string; input_schema: unknown }[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters
  }))
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly kind = 'anthropic' as const

  private headers(apiKey: string, extra: Record<string, string>): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // 显式声明，让网关/代理不剥离流式
      Accept: 'text/event-stream',
      ...extra
    }
  }

  async listModels(
    baseURL: string,
    apiKey: string,
    headers: Record<string, string>
  ): Promise<string[]> {
    const res = await fetch(`${baseURL}/models`, { headers: this.headers(apiKey, headers) })
    if (!res.ok) throw await describeHttpError(res)
    const json = (await res.json()) as { data?: { id?: string }[] }
    return (json.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id))
  }

  async chat(baseURL: string, apiKey: string, req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 4096, // Anthropic 必填
      messages: toAnthropicMessages(req.messages),
      stream: true,
      temperature: Math.min(req.temperature, 1) // Anthropic 温度上限为 1
    }
    if (req.system.trim()) body.system = req.system
    if (req.tools.length) body.tools = toAnthropicTools(req.tools)

    const res = await fetch(`${baseURL}/messages`, {
      method: 'POST',
      headers: this.headers(apiKey, req.headers),
      body: JSON.stringify(body),
      signal: req.signal
    })
    if (!res.ok) throw await describeHttpError(res)
    if (!res.body) throw new ProviderError('响应没有可读取的流')

    let content = ''
    let reasoning = ''
    let finishReason: string | null = null
    const toolAcc = new Map<number, ToolCall>()
    const announced = new Set<number>()

    /**
     * 用量分两个阶段到达，必须分开累加：
     * - message_start.usage：input_tokens（未命中部分）+ cache_creation/read，output_tokens 只有个位数
     * - message_delta.usage：output_tokens 是累计最终值，需覆盖而非相加
     * 用普通变量而非对象，避免闭包赋值被 TS 控制流分析窄化成 never。
     */
    let freshInput = 0
    let cacheRead = 0
    let cacheWrite = 0
    let outputTokens = 0
    let sawUsage = false

    const applyUsage = (u: AnthropicEvent['usage']): void => {
      if (!u) return
      sawUsage = true
      if (u.input_tokens != null) freshInput = u.input_tokens
      if (u.cache_read_input_tokens != null) cacheRead = u.cache_read_input_tokens
      if (u.cache_creation_input_tokens != null) cacheWrite = u.cache_creation_input_tokens
      // output_tokens 是累计值：取较大者，兼容只上报一次的网关
      if (u.output_tokens != null) outputTokens = Math.max(outputTokens, u.output_tokens)
    }

    for await (const frame of parseSse(res.body, req.signal)) {
      let ev: AnthropicEvent
      try {
        ev = JSON.parse(frame.data) as AnthropicEvent
      } catch {
        continue
      }
      const type = ev.type || frame.event || ''

      switch (type) {
        case 'message_start':
          applyUsage(ev.message?.usage)
          break
        case 'content_block_start': {
          const block = ev.content_block
          if (block?.type === 'tool_use' && block.id && block.name) {
            const index = ev.index ?? 0
            toolAcc.set(index, { id: block.id, name: block.name, argsJson: '' })
            announced.add(index)
            req.onEvent({ type: 'tool_call', id: block.id, name: block.name })
          }
          break
        }
        case 'content_block_delta': {
          const d = ev.delta
          if (d?.type === 'text_delta' && d.text) {
            content += d.text
            req.onEvent({ type: 'delta', text: d.text })
          } else if (d?.type === 'thinking_delta' && d.thinking) {
            reasoning += d.thinking
            req.onEvent({ type: 'reasoning', text: d.thinking })
          } else if (d?.type === 'input_json_delta' && d.partial_json != null) {
            const index = ev.index ?? 0
            const entry = toolAcc.get(index)
            if (entry) entry.argsJson += d.partial_json
          }
          break
        }
        case 'message_delta':
          if (ev.delta?.stop_reason) finishReason = ev.delta.stop_reason
          // 此处的 usage 通常只带 output_tokens（累计值）；input/cache 相关字段保持已有值
          applyUsage(ev.usage)
          break
        case 'message_stop':
          break
        case 'error':
          throw new ProviderError(ev.error?.message ?? 'Anthropic 返回错误')
        default:
          break
      }
    }

    const finalUsage: Usage = sawUsage
      ? {
          // 总输入 = 未命中 + 命中缓存 + 写入缓存
          inputTokens: freshInput + cacheRead + cacheWrite,
          outputTokens,
          cachedInputTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          reasoningTokens: 0,
          estimated: false
        }
      : estimateUsage(
          `${req.system}\n${req.messages.map((m) => m.content).join('\n')}`,
          content + reasoning
        )
    req.onEvent({ type: 'usage', usage: finalUsage })

    const toolCalls = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v)
      .filter((tc) => tc.name)

    return { content, toolCalls, usage: finalUsage, finishReason }
  }
}

/** 供外部判断某个事件是否已被处理（保持与 OpenAI 适配器一致的导出面） */
export function isTextEvent(e: StreamEvent): boolean {
  return e.type === 'delta'
}
