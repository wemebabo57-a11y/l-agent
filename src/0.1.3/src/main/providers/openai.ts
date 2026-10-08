import type { ChatMessage, StreamEvent, ToolCall, Usage } from '@shared/types'
import { emptyUsage } from '@shared/pricing'
import { parseSse } from './sse'
import {
  describeHttpError,
  estimateUsage,
  ProviderError,
  withTransientRetry,
  type ChatRequest,
  type ChatResult,
  type ProviderAdapter
} from './types'

interface OpenAIToolCallDelta {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface OpenAIChoiceDelta {
  role?: string
  content?: string | null
  /** DeepSeek / 部分网关 */
  reasoning_content?: string | null
  /** 其他网关的别名 */
  reasoning?: string | null
  tool_calls?: OpenAIToolCallDelta[]
}

interface OpenAIChunk {
  id?: string
  choices?: { index?: number; delta?: OpenAIChoiceDelta; finish_reason?: string | null }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
  }
  error?: { message?: string; type?: string }
}

/** 把内部消息模型转成 OpenAI 的 messages 数组 */
function toOpenAIMessages(system: string, messages: ChatMessage[]): unknown[] {
  const out: unknown[] = []
  if (system.trim()) out.push({ role: 'system', content: system })
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: m.content || '(无输出)'
      })
      continue
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      out.push({
        role: 'assistant',
        // tool_calls 存在时 content 允许为 null
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.argsJson || '{}' }
        }))
      })
      continue
    }
    // 带图消息要转成 content parts 数组；纯文本消息保持字符串形式，
    // 因为部分网关对 content 数组支持不完整，能不数组就不数组
    if (m.images?.length) {
      const parts: unknown[] = []
      for (const img of m.images) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${img.mediaType};base64,${img.data}`, detail: 'high' }
        })
      }
      if (m.content) parts.push({ type: 'text', text: m.content })
      out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: parts })
      continue
    }
    if (m.role === 'assistant' || m.role === 'user' || m.role === 'system') {
      if (!m.content && m.role === 'assistant') continue
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}

function normalizeUsage(raw: OpenAIChunk['usage'], fallbackText: string, promptText: string): Usage {
  if (!raw) return estimateUsage(promptText, fallbackText)
  const cached = raw.prompt_tokens_details?.cached_tokens ?? 0
  return {
    inputTokens: raw.prompt_tokens ?? 0,
    outputTokens: raw.completion_tokens ?? 0,
    cachedInputTokens: cached,
    cacheWriteTokens: 0, // OpenAI 协议不单独上报缓存写入
    reasoningTokens: raw.completion_tokens_details?.reasoning_tokens ?? 0,
    estimated: false
  }
}

function joinPromptText(system: string, messages: ChatMessage[]): string {
  let s = system
  for (const m of messages) s += `\n${m.content}`
  return s
}

/** 兼容性 400 是否值得换 variant 重试：仅 stream_options / max_tokens / temperature 相关才重试 */
export function isCompat400Error(e: ProviderError): boolean {
  const text = `${e.message ?? ''} ${e.detail ?? ''}`.toLowerCase()
  return (
    text.includes('stream_options') ||
    text.includes('include_usage') ||
    text.includes('max_tokens') ||
    text.includes('max_completion_tokens') ||
    text.includes('temperature')
  )
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly kind = 'openai' as const

  async listModels(
    baseURL: string,
    apiKey: string,
    headers: Record<string, string>
  ): Promise<string[]> {
    const res = await fetch(`${baseURL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, ...headers }
    })
    if (!res.ok) throw await describeHttpError(res)
    const json = (await res.json()) as { data?: { id?: string }[] }
    return (json.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => Boolean(id))
      .sort()
  }

  async chat(baseURL: string, apiKey: string, req: ChatRequest): Promise<ChatResult> {
    // 兼容性重试：不同网关对 stream_options / max_tokens 的接受度不同
    const variants: { streamUsage: boolean; maxTokensField: 'max_tokens' | 'max_completion_tokens' }[] = [
      { streamUsage: true, maxTokensField: 'max_tokens' },
      { streamUsage: false, maxTokensField: 'max_tokens' },
      { streamUsage: false, maxTokensField: 'max_completion_tokens' }
    ]

    let lastError: unknown = null
    for (let i = 0; i < variants.length; i++) {
      const variant = variants[i]
      try {
        return await this.attempt(baseURL, apiKey, req, variant)
      } catch (e) {
        lastError = e
        if (req.signal.aborted) throw e
        if (!(e instanceof ProviderError) || e.status !== 400) throw e
        // 400 收敛：只有兼容性参数相关的 400 才换 variant，其它 400 直接抛
        if (!isCompat400Error(e)) throw e
        // 400 且还有备选形态才继续，否则立刻抛出真实原因
        const more = i < variants.length - 1
        if (!more) throw e
      }
    }
    throw lastError instanceof Error ? lastError : new ProviderError('请求失败')
  }

  private async attempt(
    baseURL: string,
    apiKey: string,
    req: ChatRequest,
    variant: { streamUsage: boolean; maxTokensField: 'max_tokens' | 'max_completion_tokens' }
  ): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAIMessages(req.system, req.messages),
      stream: true
    }
    if (req.temperature !== undefined && req.temperature !== null) body.temperature = req.temperature
    if (variant.streamUsage) body.stream_options = { include_usage: true }
    if (req.maxTokens != null) body[variant.maxTokensField] = req.maxTokens
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }))
      body.tool_choice = 'auto'
    }

    // 瞬时故障（429/5xx/断网）在建连阶段重试；流开始后不重放，避免 UI 收到重复 delta
    const res = await withTransientRetry(
      () =>
        fetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            Authorization: `Bearer ${apiKey}`,
            ...req.headers
          },
          body: JSON.stringify(body),
          signal: req.signal
        }),
      { signal: req.signal }
    )

    if (!res.ok) throw await describeHttpError(res)
    if (!res.body) throw new ProviderError('响应没有可读取的流')

    let content = ''
    let reasoning = ''
    let finishReason: string | null = null
    let rawUsage: OpenAIChunk['usage'] | undefined
    const toolAcc = new Map<number, ToolCall>()
    const announced = new Set<number>()

    for await (const frame of parseSse(res.body, req.signal)) {
      if (frame.data === '[DONE]') break
      let chunk: OpenAIChunk
      try {
        chunk = JSON.parse(frame.data) as OpenAIChunk
      } catch {
        continue // 忽略无法解析的帧（部分网关会插入非 JSON 心跳）
      }
      if (chunk.error) throw new ProviderError(chunk.error.message ?? '供应商返回错误')
      if (chunk.usage) rawUsage = chunk.usage

      const choice = chunk.choices?.[0]
      if (!choice) continue
      const delta = choice.delta
      if (choice.finish_reason) finishReason = choice.finish_reason
      if (!delta) continue

      const reasoningDelta = delta.reasoning_content ?? delta.reasoning
      if (reasoningDelta) {
        reasoning += reasoningDelta
        req.onEvent({ type: 'reasoning', text: reasoningDelta })
      }

      if (delta.content) {
        content += delta.content
        req.onEvent({ type: 'delta', text: delta.content })
      }

      for (const tc of delta.tool_calls ?? []) {
        const index = tc.index ?? 0
        let entry = toolAcc.get(index)
        if (!entry) {
          entry = { id: tc.id ?? `call_${index}_${Date.now().toString(36)}`, name: '', argsJson: '' }
          toolAcc.set(index, entry)
        }
        if (tc.id) entry.id = tc.id
        if (tc.function?.name) entry.name += tc.function.name
        if (tc.function?.arguments) entry.argsJson += tc.function.arguments

        // 名字首次确定时通知 UI（增量拼名字，等到完整再报会太晚）
        if (entry.name && !announced.has(index)) {
          announced.add(index)
          req.onEvent({ type: 'tool_call', id: entry.id, name: entry.name })
        }
      }
    }

    const toolCalls = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v)
      .filter((tc) => tc.name)

    const usage = normalizeUsage(rawUsage, content + reasoning, joinPromptText(req.system, req.messages))
    req.onEvent({ type: 'usage', usage })

    return { content, toolCalls, usage, finishReason }
  }
}

/** 供适配器共享：流式事件里已经收到过 usage 时不要再估算 */
export function emitUsageOnce(onEvent: (e: StreamEvent) => void, usage: Usage): void {
  onEvent({ type: 'usage', usage: usage ?? emptyUsage() })
}
