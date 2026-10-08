/**
 * PTC 模式的计划表：run 级暂存，run 结束即清。
 *
 * PTC = Plan-Then-Confirm：模型动工前必须调 propose_plan 把分步计划交用户确认，
 * 执行中用 update_plan_step 同步进度。计划只活在内存，不落盘——它是对"这一轮
 * 要做什么"的约定，不是会话资产。
 */
export type PlanStepStatus = 'todo' | 'doing' | 'done' | 'blocked'

export interface PlanStep {
  title: string
  detail?: string
  status: PlanStepStatus
}

interface StoredPlan {
  steps: PlanStep[]
  /** 用户是否已确认（propose_plan 走审批卡片确认后置 true） */
  confirmed: boolean
  updatedAt: number
}

const MAX_STEPS = 20
const MAX_TITLE_CHARS = 200
const MAX_DETAIL_CHARS = 2000

const store = new Map<string, StoredPlan>()

/** 纯校验 + 入库，输入非法时抛错（工具层转成 fail 回灌模型） */
export function setPlan(runId: string, steps: { title?: unknown; detail?: unknown }[]): StoredPlan {
  if (!Array.isArray(steps) || !steps.length) throw new Error('计划至少要有一个步骤')
  if (steps.length > MAX_STEPS) throw new Error(`计划最多 ${MAX_STEPS} 步，实际 ${steps.length} 步`)
  const clean = steps.map((s, i) => {
    const title = typeof s.title === 'string' ? s.title.trim() : ''
    if (!title) throw new Error(`第 ${i + 1} 步缺少 title`)
    if (title.length > MAX_TITLE_CHARS) throw new Error(`第 ${i + 1} 步 title 过长（上限 ${MAX_TITLE_CHARS} 字）`)
    const detail = typeof s.detail === 'string' ? s.detail.trim().slice(0, MAX_DETAIL_CHARS) : undefined
    return { title: title.slice(0, MAX_TITLE_CHARS), detail, status: 'todo' as PlanStepStatus }
  })
  const plan: StoredPlan = { steps: clean, confirmed: false, updatedAt: Date.now() }
  store.set(runId, plan)
  return plan
}

export function confirmPlan(runId: string): StoredPlan | null {
  const p = store.get(runId)
  if (!p) return null
  p.confirmed = true
  p.updatedAt = Date.now()
  return p
}

export function getPlan(runId: string): StoredPlan | null {
  return store.get(runId) ?? null
}

export function updatePlanStep(runId: string, index: number, status: PlanStepStatus, note?: string): StoredPlan {
  const p = store.get(runId)
  if (!p) throw new Error('本轮还没有计划，先调用 propose_plan 提交计划')
  if (!Number.isInteger(index) || index < 1 || index > p.steps.length) {
    throw new Error(`步骤序号越界：${index}（共 ${p.steps.length} 步，序号从 1 开始）`)
  }
  if (status !== 'todo' && status !== 'doing' && status !== 'done' && status !== 'blocked') {
    throw new Error(`未知状态 ${status}（只允许 todo/doing/done/blocked）`)
  }
  const step = p.steps[index - 1]
  step.status = status
  if (note?.trim()) step.detail = `${step.detail ? `${step.detail}\n` : ''}进展：${note.trim().slice(0, 500)}`
  p.updatedAt = Date.now()
  return p
}

/** run 结束调用，防止 runId→计划 无限堆积 */
export function clearPlan(runId: string): void {
  store.delete(runId)
}

export function formatPlan(p: StoredPlan): string {
  return p.steps.map((s, i) => `${i + 1}. [${s.status}] ${s.title}${s.detail ? ` —— ${s.detail}` : ''}`).join('\n')
}
