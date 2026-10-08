/**
 * spawn_subagent 的宿主实现：有界子代理。
 *
 * 定位：主代理把"可独立完成的子任务"（先读 N 个文件再汇总、先全仓搜索再定位等）
 * 派给子代理并行/串行完成，主循环继续做别的。子代理跑的是**同一个供应商/模型**，
 * 工具是内置工具的子集（只读 + 受控写），深度只允许 1 层（子代理内没有
 * spawn_subagent，避免递归派生打爆 token）。
 *
 * 安全：子代理继承父 run 的 workspace / allowWrite / permissionMode /
 * requestApproval——它内部的有副作用操作照样逐个弹用户确认，不存在降级。
 */
import { randomUUID } from 'node:crypto'
import type { AppSettings, ChatImage, ChatMessage, ChatMode, ProviderConfig, Usage } from '@shared/types'
import { addUsage, emptyUsage } from '@shared/pricing'
import { AnthropicAdapter } from '../providers/anthropic'
import { OpenAIAdapter } from '../providers/openai'
import type { ChatRequest, ProviderAdapter } from '../providers/types'
import { buildTools, PTC_TOOL_NAMES, toolsForMode, type ToolDeps } from './tools'
import { buildSystemPrompt, repairToolPairing, trimMessages } from './context'
import type { ApprovalDecider, ToolContext, ToolDefinition } from './toolTypes'

export interface SubagentHost {
  provider: ProviderConfig
  apiKey: string
  model: string
  settings: AppSettings
  workspace: { id: string; name: string; path: string } | null
  chatMode: ChatMode
  repoHint: string | null
  fileTree: string[] | null
  skills: string[]
  toolDeps: ToolDeps
  sessionId: string
  runId: string
  allowWrite: boolean
  permissionMode: AppSettings['permissionMode']
  requestApproval: ApprovalDecider
  emit: (type: 'reasoning' | 'tool_result', text: string) => void
  signal: AbortSignal
}

export interface SubagentJob {
  goal: string
  context?: string
  maxRounds?: number
}

/** 子代理不允许再派生：工具集里剔掉 spawn_subagent，深度恒为 1 */
export const SUBAGENT_BANNED_TOOLS: ReadonlySet<string> = new Set(['spawn_subagent'])

const SUBAGENT_MAX_ROUNDS_HARD = 10
const SUBAGENT_DEFAULT_ROUNDS = 6
const SUBAGENT_RESULT_CHARS = 6000

function makeAdapter(kind: ProviderConfig['kind']): ProviderAdapter {
  return kind === 'anthropic' ? new AnthropicAdapter() : new OpenAIAdapter()
}

/** 本地 JSON 解析（不从 runner import parseToolArgs，避免 runner↔subagent 循环依赖） */
function parseArgs(json: string): Record<string, unknown> {
  if (!json || !json.trim()) return {}
  let text = json.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text)
  if (fence) text = fence[1].trim()
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    const fixed = text.replace(/,\s*([}\]])/g, '$1')
    const v = JSON.parse(fixed) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    throw new Error(`工具参数不是合法 JSON：${json.slice(0, 160)}`)
  }
}

export function clampSubagentRounds(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return SUBAGENT_DEFAULT_ROUNDS
  return Math.max(1, Math.min(Math.floor(n), SUBAGENT_MAX_ROUNDS_HARD))
}

export interface SubagentResult {
  text: string
  usage: Usage
}

/** 图片挂到末尾最后一条非 tool 消息（两家协议的 tool 结果都不支持带图），与主 runner 同规则 */
function attachImages(messages: ChatMessage[], images: ChatImage[]): ChatMessage[] {
  if (!images.length) return messages
  const out = [...messages]
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === 'tool') continue
    out[i] = { ...out[i], images: [...(out[i].images ?? []), ...images] }
    return out
  }
  out.push({ id: randomUUID(), role: 'user', content: '', images: [...images], createdAt: Date.now() })
  return out
}

export async function runSubagentTask(host: SubagentHost, job: SubagentJob): Promise<SubagentResult> {
  const goal = job.goal.trim()
  if (!goal) throw new Error('子任务描述不能为空')
  if (goal.length > 8000) throw new Error('子任务描述过长（上限 8000 字符）')
  const maxRounds = clampSubagentRounds(job.maxRounds ?? SUBAGENT_DEFAULT_ROUNDS)

  const all = buildTools(host.toolDeps)
  const schemas = []
  const defs = new Map<string, ToolDefinition>()
  // 子代理是执行器：继承父 run 的模式，但永远拿不到再派生（spawn）与计划确认（ptc）工具
  const visible = toolsForMode(all, host.chatMode === 'ptc' ? 'standard' : host.chatMode)
  for (const t of visible) {
    if (SUBAGENT_BANNED_TOOLS.has(t.schema.name) || PTC_TOOL_NAMES.has(t.schema.name)) continue
    if (defs.has(t.schema.name)) continue
    defs.set(t.schema.name, t)
    schemas.push(t.schema)
  }
  const adapter = makeAdapter(host.provider.kind)

  const seed: ChatMessage[] = [
    {
      id: randomUUID(),
      role: 'user',
      content: [`子任务：${goal}`, job.context?.trim() ? `背景：${job.context.trim()}` : ''].filter(Boolean).join('\n\n'),
      createdAt: Date.now()
    }
  ]
  const system = [
    buildSystemPrompt({
      settings: host.settings,
      workspaceName: host.workspace?.name ?? null,
      workspacePath: host.workspace?.path ?? null,
      fileTree: host.settings.injectWorkspaceTree ? host.fileTree : null,
      skills: host.skills,
      repoHint: host.repoHint,
      permissionMode: host.permissionMode,
      chatMode: host.chatMode,
      shellHint: host.toolDeps.shell?.describe() ?? null,
      screenHint: null
    }),
    '你是被派生的子代理：只完成上面这一个子任务，把结论写成给主代理的文字摘要，不要闲聊。需要确认的操作会弹给用户，你只管继续。'
  ].join('\n')

  const ctx: ToolContext = {
    workspace: host.workspace,
    sessionId: host.sessionId,
    emit: () => undefined,
    runId: host.runId,
    requestApproval: host.requestApproval,
    allowWrite: host.allowWrite,
    permissionMode: host.permissionMode,
    signal: host.signal
    // spawnSubagent / reviewAction 故意不传：深度 1 + 子代理内不做机器预审（省 token，结果仍受人工审批约束）
  }

  const working = trimMessages(repairToolPairing(seed).messages, 0)
  const appended: ChatMessage[] = []
  const pendingImages: ChatImage[] = []
  let totalUsage = emptyUsage()

  for (let round = 0; round < maxRounds; round++) {
    if (host.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    let roundContent = ''
    const req: ChatRequest = {
      model: host.model,
      system,
      messages: attachImages([...working, ...appended], pendingImages),
      tools: schemas,
      temperature: host.provider.temperature,
      maxTokens: host.provider.maxTokens,
      headers: host.provider.headers ?? {},
      signal: host.signal,
      onEvent: (e) => {
        if (e.type === 'delta') roundContent += e.text
      }
    }
    const result = await adapter.chat(host.provider.baseURL, host.apiKey, req)
    totalUsage = addUsage(totalUsage, result.usage)
    const content = result.content || roundContent
    const assistantMsg: ChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      content,
      toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
      createdAt: Date.now()
    }
    appended.push(assistantMsg)
    if (!result.toolCalls.length) break

    for (const call of result.toolCalls) {
      if (host.signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const def = defs.get(call.name)
      if (!def) {
        appended.push({ id: randomUUID(), role: 'tool', content: `未知工具 ${call.name}`, toolCallId: call.id, toolName: call.name, createdAt: Date.now() })
        continue
      }
      let r: { ok: boolean; content: string; summary: string; images?: ChatImage[] }
      try {
        r = await def.run(parseArgs(call.argsJson), ctx)
      } catch (e) {
        r = { ok: false, content: `工具执行异常：${(e as Error).message}`, summary: `${call.name} 异常` }
      }
      appended.push({ id: randomUUID(), role: 'tool', content: r.content, toolCallId: call.id, toolName: call.name, createdAt: Date.now() })
      if (r.images?.length) {
        pendingImages.push(...r.images)
        while (pendingImages.length > 3) pendingImages.shift()
      }
      host.emit('tool_result', `（子代理）${r.summary}`)
    }
  }

  const last = [...appended].reverse().find((m) => m.role === 'assistant' && m.content.trim())
  const raw = (last?.content ?? '（子代理未产生文本结论）').trim()
  const text = raw.length > SUBAGENT_RESULT_CHARS ? `${raw.slice(0, SUBAGENT_RESULT_CHARS)}\n…（已截断）` : raw
  // 用量回灌给主 run：子代理烧的 token 不能凭空消失，否则统计面板长期对不上账单
  return { text, usage: totalUsage }
}
