import { randomUUID } from 'node:crypto'
import type {
  AppSettings,
  ChatImage,
  ChatMessage,
  ChatMode,
  ProviderConfig,
  StreamEvent,
  ToolCall,
  UsageRecord
} from '@shared/types'
import { addUsage, emptyUsage, estimateCost } from '@shared/pricing'
import { AnthropicAdapter } from '../providers/anthropic'
import { OpenAIAdapter } from '../providers/openai'
import type { ChatRequest, ProviderAdapter, ToolSchema } from '../providers/types'
import { ProviderError } from '../providers/types'
import { buildTools, toolsForMode, type ToolDeps } from './tools'
import { buildSystemPrompt, repairToolPairing, trimMessages } from './context'
import { clearPlan } from './ptcPlan'
import { reviewRiskyAction } from './reviewer'
import { runSubagentTask } from './subagent'
import type { ApprovalDecider, ToolContext, ToolDefinition } from './toolTypes'

export interface RunInput {
  sessionId: string
  provider: ProviderConfig
  apiKey: string
  model: string
  /** 会话历史上的全部消息（含本轮用户输入） */
  messages: ChatMessage[]
  settings: AppSettings
  workspace: { id: string; name: string; path: string } | null
  /** 聊天模式：standard/ptc/minimal，缺省 standard */
  chatMode?: ChatMode
  repoHint: string | null
  fileTree: string[] | null
  skills: string[]
  toolDeps: ToolDeps
  /** 插件注册的工具，与内置工具合并后一起提供给模型 */
  pluginTools?: ToolDefinition[]
  allowWrite: boolean
  requestApproval: ApprovalDecider
  onEvent: (e: StreamEvent) => void
  signal: AbortSignal
}

export interface RunOutput {
  /** 本轮新增的 assistant/tool 消息（按顺序） */
  appended: ChatMessage[]
  /** 汇总的用量 */
  usage: UsageRecord
}

function makeAdapter(kind: ProviderConfig['kind']): ProviderAdapter {
  return kind === 'anthropic' ? new AnthropicAdapter() : new OpenAIAdapter()
}

function collectToolSchemas(
  deps: ToolDeps,
  extra: ToolDefinition[],
  mode: ChatMode
): {
  schemas: ToolSchema[]
  defs: Map<string, ToolDefinition>
} {
  // 极简模式连插件工具都不给：minimal 就是"只给基础编码能力"，不留后门
  const tools = [...toolsForMode(buildTools(deps), mode), ...(mode === 'minimal' ? [] : extra)]
  const defs = new Map<string, ToolDefinition>()
  const schemas: ToolSchema[] = []
  for (const t of tools) {
    // 同名工具后者不覆盖前者：名字冲突在插件注册时已被拦过，
    // 这里再兜一次，避免插件意外遮蔽内置工具
    if (defs.has(t.schema.name)) continue
    defs.set(t.schema.name, t)
    schemas.push(t.schema)
  }
  return { schemas, defs }
}

/** 安全解析模型给的 JSON；模型偶尔会输出 ```json 包裹或尾随逗号 */
export function parseToolArgs(json: string): Record<string, unknown> {
  if (!json || !json.trim()) return {}
  let text = json.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text)
  if (fence) text = fence[1].trim()
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    // 去掉尾随逗号后重试一次
    try {
      const fixed = text.replace(/,\s*([}\]])/g, '$1')
      const v = JSON.parse(fixed)
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
    } catch {
      throw new Error(`工具参数不是合法 JSON：${json.slice(0, 160)}`)
    }
  }
}

export class AgentRunner {
  // 显式字段而非参数属性：兼容 Node 的 strip-only TS 执行模式（供单元测试直接 import）
  private readonly runId: string
  private readonly emit: (e: StreamEvent) => void

  constructor(runId: string, emit: (e: StreamEvent) => void) {
    this.runId = runId
    this.emit = emit
  }

  async run(input: RunInput): Promise<RunOutput> {
    const mode = input.chatMode ?? 'standard'
    const { schemas, defs } = collectToolSchemas(input.toolDeps, input.pluginTools ?? [], mode)
    const adapter = makeAdapter(input.provider.kind)

    const working: ChatMessage[] = [...input.messages]
    const appended: ChatMessage[] = []
    /**
     * 工具产出的图片（截图等）。只活在本次 run 内，不写进 appended，
     * 因此不会污染会话历史，但会让后续每一轮请求都能看到这张图。
     */
    const pendingImages: ChatImage[] = []
    let totalUsage = emptyUsage()
    const startedAt = Date.now()
    let firstTokenMs: number | null = null
    let failed = false

    const system = buildSystemPrompt({
      settings: input.settings,
      workspaceName: input.workspace?.name ?? null,
      workspacePath: input.workspace?.path ?? null,
      fileTree: input.settings.injectWorkspaceTree ? input.fileTree : null,
      skills: input.skills,
      repoHint: input.repoHint,
      permissionMode: input.settings.permissionMode,
      chatMode: mode,
      shellHint: input.toolDeps.shell?.describe() ?? null,
      screenHint: await describeScreen(input.toolDeps)
    })

    // 先修配对再裁剪，顺序不能反：先裁会把半截配对切出来
    const repaired = repairToolPairing(trimMessages(working, input.settings.contextWindow))
    if (repaired.repairs.length) {
      for (const r of repaired.repairs) {
        this.emit({ type: 'reasoning', text: `（上下文修复：${r}）\n` })
      }
    }

    const maxRounds = Math.max(1, Math.min(input.settings.maxToolRounds, 40))

    // 子代理烧的 token 回灌到主 run：否则统计面板长期对不上账单
    let subagentUsage = emptyUsage()

    const ctx: ToolContext = {
      workspace: input.workspace,
      sessionId: input.sessionId,
      emit: this.emit,
      runId: this.runId,
      requestApproval: input.requestApproval,
      allowWrite: input.allowWrite,
      permissionMode: input.settings.permissionMode,
      signal: input.signal,
      // 智能模式机器预审：高风险工具先过 reviewer，deny 直接拦，其余照常弹用户确认
      reviewAction: (q) =>
        reviewRiskyAction(
          { provider: input.provider, apiKey: input.apiKey, model: input.model, headers: input.provider.headers ?? {}, signal: input.signal },
          q
        ),
      // 派生子代理：同供应商/模型、有界轮数、深度 1 层，继承同一套审批与工作区约束
      spawnSubagent: async (job) => {
        const r = await runSubagentTask(
          {
            provider: input.provider,
            apiKey: input.apiKey,
            model: input.model,
            settings: input.settings,
            workspace: input.workspace,
            chatMode: mode,
            repoHint: input.repoHint,
            fileTree: input.fileTree,
            skills: input.skills,
            toolDeps: input.toolDeps,
            sessionId: input.sessionId,
            runId: this.runId,
            allowWrite: input.allowWrite,
            permissionMode: input.settings.permissionMode,
            requestApproval: input.requestApproval,
            emit: (kind, text) => {
              if (kind === 'tool_result') this.emit({ type: 'tool_result', id: `${this.runId}-sub`, name: 'spawn_subagent', ok: true, summary: text })
              else this.emit({ type: 'reasoning', text: `${text}\n` })
            },
            signal: input.signal
          },
          job
        )
        subagentUsage = addUsage(subagentUsage, r.usage)
        return r
      }
    }

    try {
      for (let round = 0; round < maxRounds; round++) {
        if (input.signal.aborted) throw new DOMException('Aborted', 'AbortError')

        let roundContent = ''
        let roundReasoning = ''

        // 把本轮之前工具产出的图片挂到最后一条用户可见消息上。
        // 复制而非原地修改：repaired.messages 可能与 input.messages 共享引用
        const withImages = attachImages(repaired.messages.concat(appended), pendingImages)

        const req: ChatRequest = {
          model: input.model,
          system,
          messages: withImages,
          tools: schemas,
          temperature: input.provider.temperature,
          maxTokens: input.provider.maxTokens,
          headers: input.provider.headers ?? {},
          signal: input.signal,
          onEvent: (e) => {
            if (e.type === 'delta') {
              roundContent += e.text
              if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt
            } else if (e.type === 'reasoning') {
              roundReasoning += e.text
            }
            this.emit(e)
          }
        }

        const result = await adapter.chat(input.provider.baseURL, input.apiKey, req)
        totalUsage = addUsage(totalUsage, result.usage)

        // 合并流式累积与返回值，防止适配器只填了其中一边
        const content = result.content || roundContent
        void roundReasoning

        const assistantMsg: ChatMessage = {
          id: randomUUID(),
          role: 'assistant',
          content,
          toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
          createdAt: Date.now(),
          usage: result.usage
        }
        appended.push(assistantMsg)

        if (!result.toolCalls.length) break

        // 依次执行工具（串行：写操作之间有顺序依赖，并行会互相踩）
        for (const call of result.toolCalls) {
          if (input.signal.aborted) throw new DOMException('Aborted', 'AbortError')
          const toolResult = await this.executeTool(call, defs, ctx)
          const toolMsg: ChatMessage = {
            id: randomUUID(),
            role: 'tool',
            content: toolResult.content,
            toolCallId: call.id,
            toolName: call.name,
            createdAt: Date.now()
          }
          appended.push(toolMsg)

          // 截图等图片累积起来，供后续轮次查看；追加而不是替换，
          // 因为模型可能同时需要「点击前的画面」和「点击后的画面」做对比
          if (toolResult.images?.length) {
            pendingImages.push(...toolResult.images)
            // 只保留最近 3 张，防止长按流程把上下文撑爆
            while (pendingImages.length > 3) pendingImages.shift()
          }

          this.emit({
            type: 'tool_result',
            id: call.id,
            name: call.name,
            ok: toolResult.ok,
            summary: toolResult.summary
          })
        }
      }
    } catch (e) {
      failed = true
      if (e instanceof DOMException && e.name === 'AbortError') {
        // 用户主动中断：不算错误，但如实标记
        this.emit({ type: 'error', runId: this.runId, message: '已中断' })
      } else {
        const msg = e instanceof ProviderError ? `${e.message}${e.detail ? `｜${e.detail}` : ''}` : String((e as Error).message ?? e)
        this.emit({ type: 'error', runId: this.runId, message: msg })
      }
    }

    const latencyMs = Date.now() - startedAt
    // 子代理的用量并入主 run：账单对得上，统计面板才可信
    totalUsage = addUsage(totalUsage, subagentUsage)
    // PTC 计划表是 run 级暂存：结轮即清，不堆积
    clearPlan(this.runId)
    const usage: UsageRecord = {
      ...totalUsage,
      id: randomUUID(),
      at: Date.now(),
      providerId: input.provider.id,
      providerName: input.provider.name,
      kind: input.provider.kind,
      model: input.model,
      latencyMs,
      firstTokenMs,
      tokensPerSecond: latencyMs > 0 && totalUsage.outputTokens > 0 ? Math.round((totalUsage.outputTokens / (latencyMs / 1000)) * 10) / 10 : null,
      costUSD: estimateCost(totalUsage, input.model),
      sessionId: input.sessionId,
      failed
    }

    const finalMessage =
      [...appended].reverse().find((m) => m.role === 'assistant') ??
      ({
        id: randomUUID(),
        role: 'assistant',
        content: failed ? '（本轮未产生回复）' : '',
        createdAt: Date.now()
      } as ChatMessage)

    this.emit({ type: 'done', runId: this.runId, message: finalMessage, usage })
    return { appended, usage }
  }

  private async executeTool(
    call: ToolCall,
    defs: Map<string, ToolDefinition>,
    ctx: ToolContext
  ): Promise<{ ok: boolean; content: string; summary: string; images?: ChatImage[] }> {
    const def = defs.get(call.name)
    if (!def) {
      return {
        ok: false,
        content: `未知工具 ${call.name}。可用工具：${[...defs.keys()].join(', ')}`,
        summary: `未知工具：${call.name}`
      }
    }
    let args: Record<string, unknown>
    try {
      args = parseToolArgs(call.argsJson)
    } catch (e) {
      return { ok: false, content: String((e as Error).message), summary: '参数解析失败' }
    }
    try {
      return await def.run(args, ctx)
    } catch (e) {
      return {
        ok: false,
        content: `工具执行异常：${(e as Error).message}`,
        summary: `${call.name} 异常`
      }
    }
  }
}

/**
 * 把待展示的图片挂到消息序列末尾的**最后一条非 tool 消息**上。
 *
 * 不能挂在 tool 消息上：两家协议的 tool 结果都不支持附带图片。
 * 因此挂到其后的下一条 user/assistant 消息；若末尾没有这样的消息
 * （例如恰好停在 tool 结果上），就追加一条空的 user 消息来承载图片。
 */
function attachImages(messages: ChatMessage[], images: ChatImage[]): ChatMessage[] {
  if (!images.length) return messages
  const out = [...messages]
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]
    if (m.role === 'tool') continue
    out[i] = { ...m, images: [...(m.images ?? []), ...images] }
    return out
  }
  out.push({
    id: randomUUID(),
    role: 'user',
    content: '',
    images: [...images],
    createdAt: Date.now()
  })
  return out
}

/** 给系统提示词用的屏幕能力说明，让模型知道有哪些工具可用 */
async function describeScreen(deps: ToolDeps): Promise<string | null> {
  if (!deps.screen) return null
  const capture = deps.screen.captureEnabled()
  const input = deps.screen.inputEnabled()
  if (!capture && !input) return null
  const parts: string[] = []
  if (capture) parts.push('可以截图查看用户屏幕（screen_look）')
  if (input) parts.push('可以真实点击、键入、按键、滚动、拖拽（screen_click / screen_type / screen_key / screen_scroll / screen_drag）')
  const caps = await deps.screen.capabilities().catch(() => null)
  const note = caps && !caps.capture && capture ? `\n注意：当前环境截图不可用——${caps.note}` : ''
  return `${parts.join('；')}。${note}`
}

export function newRunId(): string {
  return randomUUID()
}
