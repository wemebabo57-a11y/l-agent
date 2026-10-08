/**
 * AI 任务足迹：把"调了哪些工具、改了哪些文件"压成一行淡字。
 *
 * 背景：tool 角色消息以前是按整条气泡渲染的，一次多轮调用下来满屏都是
 * 文件原文和命令输出，真正想看的"干了什么"反而被淹没。现在 tool 消息
 * 不再整条展示，只在所属 assistant 消息下方留一行足迹。
 *
 * 纯函数模块（无 JSX），单元测试直接 import 覆盖。
 */
import type { ChatMessage } from '@shared/types'

/** 工具名的中文对照，让足迹一眼看懂在做什么 */
const TOOL_LABEL: Record<string, string> = {
  file_stat: '查看文件信息',
  list_dir: '列出目录',
  read_file: '读取文件',
  write_file: '写入文件',
  move_path: '移动文件',
  delete_path: '删除文件',
  search_code: '搜索代码',
  list_all_files: '文件清单',
  skill_read: '读取 Skill',
  shell_run: '执行命令',
  screen_look: '查看屏幕',
  screen_click: '点击屏幕',
  screen_type: '输入文本',
  screen_key: '按键',
  screen_scroll: '滚动',
  screen_drag: '拖拽',
  gh_list_dir: '列出远端目录',
  gh_read_file: '读取远端文件',
  gh_search_code: '搜索 GitHub 代码',
  gh_commit: '提交到 GitHub',
  propose_plan: '提交计划',
  update_plan_step: '更新计划',
  spawn_subagent: '派生子代理'
}

export function toolLabel(name: string): string {
  if (TOOL_LABEL[name]) return TOOL_LABEL[name]
  // 插件工具：plugin_<id>_<name>。id 与工具名都允许下划线，无法完美切分，
  // 取首段当 id：工具名带下划线是常态（count_lines），id 带下划线是少数。
  const m = /^plugin_([^_]+)_(.+)$/.exec(name)
  if (m) return `插件 ${m[1]} · ${m[2]}`
  return name
}

export interface FootprintTool {
  name: string
  label: string
  count: number
  /** 至少有一次失败 */
  failed: boolean
}

export interface MessageFootprint {
  tools: FootprintTool[]
  /** 改动过的文件（去重，只收录成功执行的写入类操作） */
  files: string[]
  /** 文件过多被截断的数量 */
  filesTruncated: number
  /** 失败的调用次数（含拒绝与评审拦截） */
  failures: number
  /** 发起了调用但没见到结果的数量（轮次被中断时） */
  unknown: number
}

function parseArgs(json: string | undefined): Record<string, unknown> {
  if (!json) return {}
  try {
    const v = JSON.parse(json) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function strArg(args: Record<string, unknown>, key: string): string | null {
  const v = args[key]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** 写人类工具触及的文件；读操作不算"改动"，不进这份名单 */
function modifiedFilesOf(name: string, args: Record<string, unknown>): string[] {
  if (name === 'write_file' || name === 'delete_path') {
    const p = strArg(args, 'path')
    return p ? [p] : []
  }
  if (name === 'move_path') {
    const out: string[] = []
    const from = strArg(args, 'from')
    const to = strArg(args, 'to')
    if (from) out.push(from)
    if (to && to !== from) out.push(to)
    return out
  }
  if (name === 'gh_commit') {
    const raw = strArg(args, 'files')
    if (!raw) return []
    try {
      const list = JSON.parse(raw) as unknown
      if (!Array.isArray(list)) return []
      return list
        .slice(0, 20)
        .map((item) => (item && typeof item === 'object' ? (item as { path?: unknown }).path : null))
        .filter((p): p is string => typeof p === 'string' && Boolean(p.trim()))
    } catch {
      return []
    }
  }
  return []
}

/** 工具失败的固定前缀（见 tools.ts fail/gate/评审拦截文案），换文案时这里要同步 */
const FAILED_PREFIX = /^(操作失败|用户拒绝|安全评审拦截)/

/**
 * 为一条 assistant 消息汇总足迹。
 * toolMsgs 是紧随其后的 tool 角色消息（按 toolCallId 配对，多余的忽略）。
 * 没有 toolCalls 返回 null，调用方不渲染足迹行。
 */
export function summarizeTools(
  assistant: { toolCalls?: { id: string; name: string; argsJson: string }[] },
  toolMsgs: Pick<ChatMessage, 'toolCallId' | 'content'>[]
): MessageFootprint | null {
  const calls = assistant.toolCalls ?? []
  if (!calls.length) return null
  const byId = new Map<string, Pick<ChatMessage, 'toolCallId' | 'content'>[]>()
  for (const m of toolMsgs) {
    if (!m.toolCallId) continue
    const list = byId.get(m.toolCallId) ?? []
    list.push(m)
    byId.set(m.toolCallId, list)
  }
  const tools: FootprintTool[] = []
  const files: string[] = []
  const seenFiles = new Set<string>()
  let failures = 0
  let unknown = 0
  for (const call of calls) {
    const results = byId.get(call.id) ?? []
    let entry = tools.find((t) => t.name === call.name)
    if (!entry) {
      entry = { name: call.name, label: toolLabel(call.name), count: 0, failed: false }
      tools.push(entry)
    }
    entry.count += 1
    if (!results.length) {
      unknown += 1
      continue
    }
    const args = parseArgs(call.argsJson)
    for (const r of results) {
      if (FAILED_PREFIX.test(r.content)) {
        failures += 1
        entry.failed = true
      } else {
        for (const f of modifiedFilesOf(call.name, args)) {
          if (!seenFiles.has(f)) {
            seenFiles.add(f)
            files.push(f)
          }
        }
      }
    }
  }
  const MAX_FILES = 8
  const filesTruncated = files.length > MAX_FILES ? files.length - MAX_FILES : 0
  return { tools, files: files.slice(0, MAX_FILES), filesTruncated, failures, unknown }
}

export interface MessageGroup {
  msg: ChatMessage
  /** 紧随其后的 tool 消息（渲染时折进足迹，不再整条展示） */
  tools: ChatMessage[]
}

/**
 * 把消息列表分组：tool 消息挂到上一条 assistant 消息下。
 * 找不到归属的孤立 tool 消息直接丢弃（配对修复的漏网之鱼，不值得整条展示）。
 */
export function groupMessagesForView(messages: ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  for (const m of messages) {
    if (m.role === 'tool') {
      const last = groups[groups.length - 1]
      if (last && last.msg.role === 'assistant') last.tools.push(m)
      continue
    }
    groups.push({ msg: m, tools: [] })
  }
  return groups
}
