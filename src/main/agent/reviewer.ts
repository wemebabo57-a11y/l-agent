/**
 * 智能模式的机器预审（reviewer 子代理）。
 *
 * 定位：smart 模式下，高风险工具在**弹出用户确认卡片之前**，
 * 先用一次轻量 LLM 调用做机器审计。deny 直接拦截（不打扰用户），
 * approve/escalate 照常走用户审批——机器永远不能代替用户点"允许"。
 *
 * 失败策略：评审调用本身失败（断网/400/超时）返回 null，
 * 调用方按原流程走用户审批（fail-open 到人工，不因审计设施故障卡死）。
 */
import type { ChatMessage, ProviderConfig, ToolRisk } from '@shared/types'
import { AnthropicAdapter } from '../providers/anthropic'
import { OpenAIAdapter } from '../providers/openai'
import type { ChatRequest, ProviderAdapter } from '../providers/types'
import type { ReviewAnswer, ReviewQuery } from './toolTypes'

/** 需要过机器预审的风险等级：write 除外——写文件的审批卡片已带前后文 diff，再审一次只是重复烧 token */
export const REVIEW_RISKS: ReadonlySet<ToolRisk> = new Set(['shell', 'delete', 'remote', 'screen'])

export interface ReviewDeps {
  provider: ProviderConfig
  apiKey: string
  model: string
  headers?: Record<string, string>
  signal?: AbortSignal
}

export function buildReviewPrompt(q: ReviewQuery): { system: string; user: string } {
  const system = [
    '你是 AI 助手操作的安全评审员。主助手想执行一次有副作用的操作，你负责预审。',
    '只输出一行 JSON，不要输出其他内容：{"verdict":"approve|deny|escalate","reason":"一句话理由"}。',
    'verdict 含义：approve=看起来合理，交给用户最终确认；escalate=拿不准、需要用户仔细看；deny=明显危险必须拦截。',
    'deny 只用于：删除/覆盖用户数据且与目的无关、向工作区外写、把敏感信息发往远端、命令含管道串联/重定向绕过、目的说明与实际操作不符。',
    '不要因为"操作本身有风险"就 deny——风险是已知前提，你只拦"目的与手段不匹配"的离谱调用。'
  ].join('\n')
  const user = [`工具：${q.tool}（风险等级 ${q.risk}）`, `标题：${q.title}`, `明细：`, q.detail].join('\n')
  return { system, user }
}

/** 纯函数：解析 reviewer 的 JSON 输出，格式不对一律按 escalate 处理（交给用户看） */
export function parseReviewVerdict(text: string): ReviewAnswer {
  const fallback = (reason: string): ReviewAnswer => ({ verdict: 'escalate', reason })
  if (!text || !text.trim()) return fallback('评审无输出，转人工确认')
  let body = text.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(body)
  if (fence) body = fence[1].trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return fallback('评审输出非 JSON，转人工确认')
  try {
    const v = JSON.parse(body.slice(start, end + 1)) as { verdict?: unknown; reason?: unknown }
    const verdict = v.verdict === 'approve' || v.verdict === 'deny' || v.verdict === 'escalate' ? v.verdict : 'escalate'
    const reason = typeof v.reason === 'string' && v.reason.trim() ? v.reason.trim().slice(0, 300) : '评审未给理由，转人工确认'
    return { verdict, reason }
  } catch {
    return fallback('评审输出解析失败，转人工确认')
  }
}

function makeAdapter(kind: ProviderConfig['kind']): ProviderAdapter {
  return kind === 'anthropic' ? new AnthropicAdapter() : new OpenAIAdapter()
}

export async function reviewRiskyAction(deps: ReviewDeps, q: ReviewQuery): Promise<ReviewAnswer | null> {
  const { system, user } = buildReviewPrompt(q)
  const userMsg: ChatMessage = { id: 'review-user', role: 'user', content: user, createdAt: Date.now() }
  const req: ChatRequest = {
    model: deps.model,
    system,
    messages: [userMsg],
    tools: [],
    // 沿用业务 temperature：评审失败会退化为 null、照常走用户审批，不会卡死流程
    temperature: deps.provider.temperature,
    maxTokens: 256,
    headers: deps.headers ?? {},
    signal: deps.signal ?? AbortSignal.timeout(60_000),
    onEvent: () => undefined
  }
  try {
    const result = await makeAdapter(deps.provider.kind).chat(deps.provider.baseURL, deps.apiKey, req)
    return parseReviewVerdict(result.content)
  } catch {
    return null
  }
}
