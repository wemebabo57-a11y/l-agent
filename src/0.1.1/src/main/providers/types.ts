import type { ChatMessage, ProviderKind, StreamEvent, ToolCall, Usage } from '@shared/types'
import { emptyUsage } from '@shared/pricing'

/** 工具声明（JSON Schema 子集） */
export interface ToolSchema {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export interface ChatRequest {
  model: string
  system: string
  messages: ChatMessage[]
  tools: ToolSchema[]
  temperature: number
  maxTokens: number | null
  headers: Record<string, string>
  signal: AbortSignal
  /** 流式回调；实现方必须按顺序调用 */
  onEvent: (event: StreamEvent) => void
}

export interface ChatResult {
  content: string
  toolCalls: ToolCall[]
  usage: Usage
  /** 供应商返回的结束原因 */
  finishReason: string | null
}

export interface ProviderAdapter {
  readonly kind: ProviderKind
  /** 用最小请求体验证 key/baseURL 是否可用，返回模型列表 */
  listModels(baseURL: string, apiKey: string, headers: Record<string, string>): Promise<string[]>
  chat(baseURL: string, apiKey: string, req: ChatRequest): Promise<ChatResult>
}

export class ProviderError extends Error {
  readonly status?: number
  readonly detail?: string

  // 显式字段赋值而非参数属性：兼容 Node 的 strip-only TS 执行模式
  constructor(message: string, status?: number, detail?: string) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
    this.detail = detail
  }
}

/** 把 HTTP 错误体里能榨出来的信息拼成一句人话 */
export async function describeHttpError(res: Response): Promise<ProviderError> {
  const text = await res.text().catch(() => '')
  let detail = text.slice(0, 800)
  try {
    const j = JSON.parse(text) as { error?: { message?: string }; message?: string }
    detail = j.error?.message ?? j.message ?? detail
  } catch {
    /* 非 JSON，保留原文 */
  }
  const hint =
    res.status === 401
      ? 'API Key 无效或已过期'
      : res.status === 403
        ? '无权访问该资源，或密钥权限不足'
        : res.status === 404
          ? '接口路径不存在，请检查 baseURL（是否漏了 /v1）'
          : res.status === 429
            ? '触发限流或余额不足'
            : res.status >= 500
              ? '供应商服务端错误'
              : '请求失败'
  return new ProviderError(`${hint}（HTTP ${res.status}）`, res.status, detail)
}

/**
 * 流式响应没有 usage 时，用字符数估算 token。
 * 这是粗略估算：CJK 约 1 token/字，拉丁文约 1 token/4 字符。
 * 结果会标记 estimated = true，UI 明确区分"实测"与"估算"。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch)) cjk++
    else other++
  }
  return Math.max(1, Math.ceil(cjk + other / 4))
}

export function estimateUsage(promptText: string, completionText: string): Usage {
  return {
    ...emptyUsage(),
    inputTokens: estimateTokens(promptText),
    cachedInputTokens: 0,
    outputTokens: estimateTokens(completionText),
    estimated: true
  }
}

export function newRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
