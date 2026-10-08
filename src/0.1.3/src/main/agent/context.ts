import type { AppSettings, ChatMessage, ChatMode, PermissionMode } from '@shared/types'
import { describeMode } from './permissions'

export interface ContextOptions {
  settings: AppSettings
  workspaceName: string | null
  workspacePath: string | null
  fileTree: string[] | null
  skills: string[]
  /** 会话绑定仓库信息（若通过 gh_ 工具操作远端，给它一个提示） */
  repoHint: string | null
  /** 当前权限档位，决定行为约定 */
  permissionMode: PermissionMode
  /** 控制台环境说明，未开启控制台时为 null */
  shellHint: string | null
  /** 屏幕能力说明，未开启时为 null */
  screenHint: string | null
  /** 聊天模式：standard 不变；ptc 追加 PTC 确认约定；minimal 压缩短指令 */
  chatMode?: ChatMode
}

/**
 * 组装系统提示词。
 * 顺序固定：角色设定 → 权限约定 → 环境事实 → 可用能力 → 工作区 → skill → 仓库提示。
 * 这样前缀稳定，便于供应商侧前缀缓存命中（直接影响 cached_tokens 命中率）。
 */
export function buildSystemPrompt(o: ContextOptions): string {
  // minimal 模式：只用 5 行内短指令，避免长上下文开销
  if ((o.chatMode ?? 'standard') === 'minimal') {
    const top = (o.fileTree ?? []).filter((p) => !p.includes('/')).slice(0, 30)
    const lines = [
      '你是 lagent，简洁回答，中文优先。',
      '只调必要工具；path 用工作区相对路径。',
      '本模式只有基础编码工具（读/写/查文件），没有删除、命令、屏幕、远端与派生能力；超出能力时直说并建议用户切标准模式。',
      o.workspaceName ? `工作区：${o.workspaceName}` : '无工作区；需读写文件时先提示添加。',
      top.length ? `顶层文件：${top.join('、')}` : '无文件清单。',
      o.repoHint ? `仓库：${o.repoHint}` : '无仓库绑定。'
    ]
    return lines.join('\n')
  }
  const parts: string[] = [o.settings.systemPrompt.trim()]
  // PTC（Plan-Then-Confirm）：先交计划等确认，再动工
  if ((o.chatMode ?? 'standard') === 'ptc') {
    parts.push(
      '## PTC 约定（Plan-Then-Confirm）\n动工前先调 propose_plan 提交分步计划并等用户确认；确认前只做只读探查。确认后再调写工具（写文件/删除/提交/命令/屏幕操作），执行中用 update_plan_step 同步进度。'
    )
  }

  const permissions = describeMode(o.permissionMode)
  if (permissions) parts.push(`## 权限\n${permissions}`)

  const env: string[] = []
  env.push(`当前时间：${new Date().toLocaleString('zh-CN')}`)
  env.push(`操作系统：${process.platform}`)
  if (o.workspaceName && o.workspacePath) {
    env.push(`已绑定工作区：${o.workspaceName}（根目录 ${o.workspacePath}）`)
    env.push('工作区工具的 path 参数一律使用相对根目录的路径。')
  } else {
    env.push('当前没有绑定工作区；需要读写本地文件时，先提示用户在「工作区」面板添加目录。')
  }
  if (o.repoHint) env.push(`已连接仓库：${o.repoHint}`)
  parts.push(`## 运行环境\n${env.join('\n')}`)

  const caps: string[] = []
  if (o.shellHint) caps.push(`### 控制台\n${o.shellHint}`)
  if (o.screenHint) caps.push(`### 屏幕\n${o.screenHint}`)
  if (caps.length) parts.push(`## 可用能力\n${caps.join('\n\n')}`)

  if (o.fileTree && o.fileTree.length) {
    parts.push(
      `## 工作区文件清单（截取，完整内容用 list_all_files）\n\`\`\`\n${o.fileTree.join('\n')}\n\`\`\``
    )
  }

  if (o.skills.length) {
    parts.push(
      `## 已加载的 Skill 指令\n以下 Skill 是用户安装的可复用任务指令。当任务与其描述匹配时，遵循其流程与约定。\n\n${o.skills.join('\n\n')}`
    )
  }

  return parts.filter(Boolean).join('\n\n')
}

/**
 * 裁剪历史消息以适应上下文窗口。
 * 规则：
 * 1. 始终保留最近 N 条；
 * 2. 绝不产生"孤立的 tool 结果"——tool 消息必须与触发它的 assistant.toolCalls 同生共死，
 *    否则 Anthropic 会因为 tool_use 缺失而直接 400。
 */
export function trimMessages(messages: ChatMessage[], limit: number): ChatMessage[] {
  if (!limit || messages.length <= limit) return messages

  let start = messages.length - limit
  // 向前回退，确保不切断 assistant(tool_calls) 与其 tool 结果
  while (start > 0) {
    const first = messages[start]
    if (first.role === 'tool') {
      start--
      continue
    }
    break
  }
  // 若被切断的前一条 assistant 带 toolCalls，需要把它一并纳入或整体丢弃
  if (start > 0) {
    const prev = messages[start - 1]
    if (prev.role === 'assistant' && prev.toolCalls?.length) {
      const ids = new Set(prev.toolCalls.map((t) => t.id))
      const resultsIncluded = messages
        .slice(start)
        .some((m) => m.role === 'tool' && m.toolCallId && ids.has(m.toolCallId))
      if (resultsIncluded) start--
      else {
        // 丢弃这条 assistant 及其后续孤立 tool 结果
        while (start < messages.length && messages[start].role === 'tool') start++
      }
    }
  }

  const sliced = messages.slice(start)
  // 首条不能是 tool 结果（同样的孤立问题）
  let i = 0
  while (i < sliced.length && sliced[i].role === 'tool') i++
  return sliced.slice(i)
}

/**
 * 校验消息序列对两家协议的合法性，返回问题描述数组。
 * 主要防的是"孤立 tool 结果"和"assistant 有 toolCalls 但缺结果"。
 */
export function validateToolPairing(messages: ChatMessage[]): string[] {
  const problems: string[] = []
  const pending = new Map<string, number>()
  messages.forEach((m, idx) => {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      for (const tc of m.toolCalls) pending.set(tc.id, idx)
    } else if (m.role === 'tool' && m.toolCallId) {
      if (!pending.has(m.toolCallId)) {
        problems.push(`第 ${idx + 1} 条 tool 消息的 toolCallId=${m.toolCallId} 找不到对应的 assistant 工具调用`)
      } else {
        pending.delete(m.toolCallId)
      }
    }
  })
  for (const [id] of pending) {
    problems.push(`工具调用 ${id} 缺少对应的结果消息`)
  }
  return problems
}

/**
 * 修复配对问题：删掉孤立 tool 消息，把缺结果的 assistant.toolCalls 降级为纯文本。
 * 这两家在遇到不配对时报的是 400 且信息含糊，主动修掉比让用户看报错划算。
 */
export function repairToolPairing(messages: ChatMessage[]): { messages: ChatMessage[]; repairs: string[] } {
  const repairs: string[] = []
  const out: ChatMessage[] = []

  // 先收集"有结果的"工具调用 id
  const resultIds = new Set(
    messages.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => m.toolCallId as string)
  )

  for (const m of messages) {
    if (m.role === 'tool') {
      if (!m.toolCallId || !resultIds.has(m.toolCallId)) continue
      // 确认前面确实有对应的 assistant 调用，否则丢弃
      const hasCaller = out.some(
        (prev) => prev.role === 'assistant' && prev.toolCalls?.some((tc) => tc.id === m.toolCallId)
      )
      if (!hasCaller) {
        repairs.push(`丢弃孤立的工具结果 ${m.toolName ?? m.toolCallId}`)
        continue
      }
      out.push(m)
      continue
    }

    if (m.role === 'assistant' && m.toolCalls?.length) {
      const keep = m.toolCalls.filter((tc) => resultIds.has(tc.id))
      if (keep.length === m.toolCalls.length) {
        out.push(m)
        continue
      }
      repairs.push(`助手消息的 ${m.toolCalls.length - keep.length} 个工具调用缺少结果，已从上下文中剔除`)
      if (!keep.length) {
        // 没有可保留的调用：若还有文本就降级为普通消息，否则整条丢弃
        if (m.content.trim()) out.push({ ...m, toolCalls: undefined })
        continue
      }
      out.push({ ...m, toolCalls: keep })
      continue
    }

    out.push(m)
  }

  return { messages: out, repairs }
}
