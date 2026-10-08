import { randomUUID } from 'node:crypto'
import type { ChatImage, PermissionMode, SelfAssessedRisk, StreamEvent, ToolRisk, Usage } from '@shared/types'
import type { ToolSchema } from '../providers/types'

/** 危险操作的审批请求 */
export interface ApprovalRequest {
  tool: string
  title: string
  detail: string
  risk: ToolRisk
  /** 智能模式下模型自评的风险，展示在确认卡片上 */
  selfAssessed?: SelfAssessedRisk | undefined
}

export type ApprovalDecider = (req: ApprovalRequest) => Promise<boolean>

export interface ToolContext {
  /** 当前会话绑定的工作区（可能为 null） */
  workspace: { id: string; name: string; path: string } | null
  /** 本次运行所属会话 */
  sessionId: string
  /** 流式事件出口 */
  emit: (event: StreamEvent) => void
  /** 运行 id，用于事件关联 */
  runId: string
  /** 请求用户审批；未提供时按拒绝处理（fail-closed） */
  requestApproval?: ApprovalDecider
  /** 是否允许写操作（用户关闭"允许写"时全部拒绝） */
  allowWrite: boolean
  /** 当前权限档位 */
  permissionMode: PermissionMode
  /** 当前 run 的取消信号 */
  signal: AbortSignal
  /**
   * 派生子代理执行子任务（runner 注入，深度只允许 1 层）。
   * 未注入时工具应明确报错，而不是静默跳过。
   */
  spawnSubagent?: (job: SubagentJob) => Promise<{ text: string; usage: Usage }>
  /**
   * 智能模式下的机器预审（runner 注入）。
   * 返回 null 表示评审基础设施失败，调用方按原流程走用户审批（fail-open 到人工）。
   */
  reviewAction?: (query: ReviewQuery) => Promise<ReviewAnswer | null>
}

/** 派生子代理的任务描述 */
export interface SubagentJob {
  /** 要完成的子任务（必填） */
  goal: string
  /** 补充背景（可选） */
  context?: string
  /** 子代理最多工具轮数，默认 6，上限 10 */
  maxRounds?: number
}

/** 智能模式机器预审的输入 */
export interface ReviewQuery {
  tool: string
  title: string
  detail: string
  risk: ToolRisk
}

/** 机器预审的结论：deny 直接拦截，approve/escalate 继续走用户审批 */
export interface ReviewAnswer {
  verdict: 'approve' | 'deny' | 'escalate'
  reason: string
}

export interface ToolResult {
  ok: boolean
  /** 回灌给模型的文本 */
  content: string
  /** UI 上显示的一行摘要 */
  summary: string
  /** 只在下一轮请求里附给视觉模型，不写入会话 */
  images?: ChatImage[]
}

export interface ToolDefinition {
  schema: ToolSchema
  /**
   * 工具的静态风险等级。权限判定只认它，模型的参数改不了——
   * 这是整个权限模型可信的基础。
   */
  risk: ToolRisk
  /**
   * 本次调用是否会改动工作区之外的位置。默认实现按参数里的路径判断，
   * 个别工具（如命令执行）可覆盖为更严格的自定义判断。
   */
  escapesWorkspace?: (args: Record<string, unknown>, ctx: ToolContext) => boolean
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

/** 智能模式下模型需要额外填写的风险自评参数，拼进某些工具的 schema */
export const SELF_RISK_PROPS = {
  risk_level: {
    type: 'string',
    description:
      '你对本次调用风险的自评：low（无副作用或可轻易撤销）/ medium（会改动文件或系统状态）/ high（删除、覆盖用户数据、影响工作区之外）。用户会看到这个判断，请如实填写。',
    enum: ['low', 'medium', 'high']
  },
  risk_reason: {
    type: 'string',
    description: '一句话说明你为什么这样评级，面向用户，不要复述参数。'
  }
} as const

/** 从工具参数里提取模型自评风险 */
export function readSelfAssessment(args: Record<string, unknown>): SelfAssessedRisk | undefined {
  const level = args.risk_level
  if (level !== 'low' && level !== 'medium' && level !== 'high') return undefined
  const reason = typeof args.risk_reason === 'string' ? args.risk_reason.trim().slice(0, 200) : ''
  return { level, reason }
}

export function newRequestId(): string {
  return `ap_${randomUUID().slice(0, 8)}`
}
