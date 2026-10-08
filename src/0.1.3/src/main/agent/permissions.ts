/**
 * 权限判定。
 *
 * 设计要点：
 * 1. 判定只依赖工具的**静态**风险等级（ToolRisk），模型无法通过参数改写它。
 *    模型的"自评风险"仅在 smart 模式作为**加重**信号使用，永远不会放宽判定。
 * 2. 本模块是纯函数，不 import Node/Electron，供单元测试直接跑。
 */

import type { PermissionMode, SelfAssessedRisk, ToolRisk } from '@shared/types'

export type Decision =
  /** 直接执行 */
  | { action: 'allow' }
  /** 需要用户确认 */
  | { action: 'ask'; reason: string; escalate?: boolean }
  /** 直接拒绝，不打扰用户 */
  | { action: 'deny'; reason: string }

export interface PolicyInput {
  mode: PermissionMode
  risk: ToolRisk
  /** 本次调用是否真的会改动工作区之外的位置（由工具自己判断后传入） */
  escapesWorkspace: boolean
  /** 模型自评风险，仅 smart 模式使用 */
  selfAssessed?: SelfAssessedRisk | undefined
  /** 用户是否在 UI 上关掉了写入总开关 */
  allowWrite: boolean
  /** 对应能力的设置开关（内存/命令/屏幕），工具被用户整体禁用时直接拒 */
  capabilityEnabled: boolean
  capabilityLabel: string
}

/**
 * 各风险等级在三种模式下的基础判定。
 *
 * | 风险     | full | workspace | smart |
 * |----------|------|-----------|-------|
 * | read     | 允许 | 允许      | 允许  |
 * | write    | 允许 | 看是否越界| 询问  |
 * | delete   | 允许 | 询问      | 询问  |
 * | remote   | 允许 | 询问      | 询问  |
 * | shell    | 允许 | 询问      | 询问  |
 * | screen   | 允许 | 询问      | 询问  |
 */
export function decide(input: PolicyInput): Decision {
  // 总开关关掉的能力，任何模式都不放行——这是用户的显式意图，不是风险权衡
  if (!input.capabilityEnabled) {
    return { action: 'deny', reason: `${input.capabilityLabel}已在设置中关闭` }
  }

  // 写操作总开关关闭时，一切有副作用的风险等级都拒绝
  if (!input.allowWrite && input.risk !== 'read' && input.risk !== 'screen') {
    return { action: 'deny', reason: '写入已被用户关闭' }
  }

  switch (input.mode) {
    case 'full':
      // 完全权限：只读之外的都直接放行。用户已明确选择信任
      return { action: 'allow' }

    case 'workspace':
      if (input.risk === 'read') return { action: 'allow' }
      if (input.risk === 'write') {
        // 工作区内的写是这一档的核心便利：不打断
        return input.escapesWorkspace
          ? { action: 'ask', reason: '目标路径在工作区之外' }
          : { action: 'allow' }
      }
      // delete / remote / shell / screen 一律确认
      return { action: 'ask', reason: `${label(input.risk)}超出工作区范围` }

    case 'smart': {
      if (input.risk === 'read') return { action: 'allow' }
      // 模型自评 high 时额外提示，让用户在确认卡片上看到「它自己知道这很危险」
      const escalate = input.selfAssessed?.level === 'high'
      const why = input.selfAssessed?.reason ? `｜模型自评：${input.selfAssessed.reason}` : ''
      return {
        action: 'ask',
        reason: `${label(input.risk)}需要确认${why}`,
        escalate
      }
    }

    default: {
      // 未知模式：fail-closed，宁可多问一次
      return { action: 'ask', reason: '权限模式未知' }
    }
  }
}

function label(risk: ToolRisk): string {
  switch (risk) {
    case 'read':
      return '读取'
    case 'write':
      return '写入文件'
    case 'delete':
      return '删除'
    case 'remote':
      return '远端操作'
    case 'shell':
      return '执行命令'
    case 'screen':
      return '屏幕操作'
    default:
      return '该操作'
  }
}

/** 模式的中文名，UI 与系统提示词共用 */
export const PERMISSION_MODE_LABEL: Record<PermissionMode, string> = {
  full: '完全权限',
  workspace: '工作区内更改',
  smart: '智能'
}

/** 模式下发给系统提示词的行为约定，让模型不必反复试探边界 */
export function describeMode(mode: PermissionMode): string {
  switch (mode) {
    case 'full':
      return '当前权限：完全权限。所有工具可直接执行，不必请求确认，也不要在回复里提醒用户去点确认。'
    case 'workspace':
      return '当前权限：工作区内更改。工作区内的文件读写直接执行；命令执行、屏幕操作、删除和远端提交需要用户逐次确认，被拒绝时换一种做法而不要重复请求。'
    case 'smart':
      return '当前权限：智能。只读操作直接执行；有副作用的操作需要用户确认。请为这类工具如实填写 risk_level 与 risk_reason 两个参数——用户会看到你的判断依据，低报风险会让确认卡片失去意义。'
    default:
      return ''
  }
}
