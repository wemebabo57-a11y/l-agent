/**
 * lagent 共享类型契约
 * 主进程与渲染进程共用；此文件不得 import 任何 Node/Electron/DOM 专有 API。
 */

/* ------------------------------------------------------------------ */
/* AI 供应商                                                            */
/* ------------------------------------------------------------------ */

/** 适配器种类：OpenAI 兼容协议 / Anthropic Messages 协议 */
export type ProviderKind = 'openai' | 'anthropic'

/* ------------------------------------------------------------------ */
/* 权限                                                                */
/* ------------------------------------------------------------------ */

/**
 * 工具的风险等级。由工具实现静态声明，模型无法改写——
 * 这是权限判定的唯一可信输入。
 */
export type ToolRisk = 'read' | 'write' | 'delete' | 'remote' | 'shell' | 'screen'

/**
 * 权限模式。三档递进放宽：
 * - full：完全权限。所有工具直接执行，不打断。
 * - workspace：在工作区内更改。工作区内的文件写入放行，越界写入 / 命令 / 屏幕操作仍需确认。
 * - smart：智能。结合工具的静态风险等级与模型自评的风险分决定是否拦截。
 */
export type PermissionMode = 'full' | 'workspace' | 'smart'

/** 模型对本次调用自评的风险（仅 smart 模式采集） */
export interface SelfAssessedRisk {
  level: 'low' | 'medium' | 'high'
  reason: string
}

/** 供应商连接配置（apiKey 密文仅存主进程，渲染进程只拿到掩码） */
export interface ProviderConfig {
  id: string
  /** 展示名，如 "OpenAI"、"DeepSeek"、"本地 Ollama" */
  name: string
  kind: ProviderKind
  /** 形如 https://api.openai.com/v1 ，不含末尾斜杠 */
  baseURL: string
  /** 已保存的密文是否存在 */
  hasKey: boolean
  /** 掩码，如 sk-…9f2a；无 key 时为 null */
  keyMask: string | null
  /** 常用模型名列表，供 UI 下拉 */
  models: string[]
  /** 是否启用（禁用的供应商不出现在选择器里） */
  enabled: boolean
  /** 默认温度 */
  temperature: number
  /** 默认最大输出 token，null 表示不限制（交给服务端默认） */
  maxTokens: number | null
  /** 附加请求头（如自定义网关鉴权） */
  headers?: Record<string, string>
}

/** 新建/更新供应商时传入，apiKey 为明文，只在此方向传输一次 */
export interface ProviderInput {
  id?: string
  name: string
  kind: ProviderKind
  baseURL: string
  /** 明文 key；undefined 表示不修改已存的 key */
  apiKey?: string
  models: string[]
  enabled: boolean
  temperature: number
  maxTokens: number | null
  headers?: Record<string, string>
}

/* ------------------------------------------------------------------ */
/* 消息与用量                                                           */
/* ------------------------------------------------------------------ */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  name: string
  /** 原始 JSON 字符串，流式拼接过程中可能不完整 */
  argsJson: string
}

export interface ChatMessage {
  id: string
  role: Role
  content: string
  /** assistant 消息可能携带工具调用 */
  toolCalls?: ToolCall[]
  /** role === 'tool' 时对应哪个 toolCall */
  toolCallId?: string
  toolName?: string
  /** 该消息附带的文件/图片引用（工作区相对路径） */
  attachments?: string[]
  /**
   * 主进程在本轮请求中临时附带的图片（屏幕截图等）。
   * 只存在于内存，落盘前会被剥离，避免把整屏截图写进会话历史。
   */
  images?: ChatImage[]
  createdAt: number
  /** 本次请求的用量（仅 assistant 且有 usage 时存在） */
  usage?: Usage
  /** 供应商原始错误信息，用于 UI 红字提示 */
  error?: string
}

/** 发给视觉模型的图片。data 为不含 data: 前缀的 base64 */
export interface ChatImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  data: string
  /** 给模型看的简短说明，例如截图来源、裁剪区域与时间 */
  caption?: string
  createdAt: number
}

/** 归一化后的用量。两家协议字段不同，统一到这里 */
export interface Usage {
  /** 输入 token（Anthropic 为 input_tokens + cache_read + cache_creation） */
  inputTokens: number
  /** 输出 token */
  outputTokens: number
  /** 命中缓存的输入 token（OpenAI: prompt_tokens_details.cached_tokens） */
  cachedInputTokens: number
  /** 写入缓存的输入 token（Anthropic: cache_creation_input_tokens） */
  cacheWriteTokens: number
  /** 推理 token（OpenAI 兼容的 reasoning_tokens），无则为 0 */
  reasoningTokens: number
  /** 是否为估算值（流式响应未带 usage 时由字符数推算） */
  estimated: boolean
}

/** 一次助手回复的用量记录，用于统计面板 */
export interface UsageRecord extends Usage {
  id: string
  at: number
  providerId: string
  providerName: string
  kind: ProviderKind
  model: string
  /** 本次请求耗时（ms） */
  latencyMs: number
  /** 首 token 延迟（ms），无输出时为 null */
  firstTokenMs: number | null
  /** 输出速度 tok/s */
  tokensPerSecond: number | null
  /** 估算费用（美元），价格缺失时为 null */
  costUSD: number | null
  sessionId: string
  /** 是否由于错误提前终止 */
  failed: boolean
}

/** 统计聚合 */
export interface UsageStats {
  requests: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  costUSD: number
  /** 缓存命中率 = cachedInputTokens / inputTokens */
  cacheHitRate: number
  /** 平均首 token 延迟 */
  avgFirstTokenMs: number
  /** 平均输出速度 */
  avgTokensPerSecond: number
}

/** 模型价格（USD / 每 100 万 token） */
export interface ModelPrice {
  input: number
  output: number
  /** 缓存读取价，通常为 input 的 10%~50% */
  cachedInput?: number
  /** 缓存写入价，Anthropic 为 input 的 125% */
  cacheWrite?: number
}

/* ------------------------------------------------------------------ */
/* 流式事件                                                            */
/* ------------------------------------------------------------------ */

export type StreamEvent =
  /** 本轮开始 */
  | { type: 'start'; runId: string; model: string; providerName: string }
  /** 正文增量 */
  | { type: 'delta'; text: string }
  /** 推理过程增量（Anthropic extended thinking / OpenAI reasoning） */
  | { type: 'reasoning'; text: string }
  /** 工具调用增量（用于 UI 实时显示"正在调用 xx"） */
  | { type: 'tool_call'; id: string; name: string }
  /** 工具执行结果摘要 */
  | { type: 'tool_result'; id: string; name: string; ok: boolean; summary: string }
  /** 服务端返回的用量 */
  | { type: 'usage'; usage: Usage }
  /** 危险操作待用户确认（写文件 / 删除 / 远端提交 / 命令 / 屏幕） */
  | {
      type: 'approval'
      runId: string
      requestId: string
      tool: string
      title: string
      detail: string
      risk: ToolRisk
      /** 智能模式下模型自评的风险分与理由，让用户判断依据可见 */
      selfAssessed?: { level: 'low' | 'medium' | 'high'; reason: string }
    }
  /** 审批已被处理，UI 收起确认卡片 */
  | { type: 'approval_resolved'; requestId: string; approved: boolean; reason?: string }
  /** 本轮结束 */
  | { type: 'done'; runId: string; message: ChatMessage; usage: UsageRecord }
  /** 出错终止 */
  | { type: 'error'; runId: string; message: string }

/* ------------------------------------------------------------------ */
/* 工作区                                                              */
/* ------------------------------------------------------------------ */

export interface Workspace {
  id: string
  name: string
  /** 绝对路径 */
  path: string
  addedAt: number
  /** 忽略的 glob 目录名，默认 node_modules/.git 等 */
  ignore: string[]
}

export interface FileNode {
  /** 相对工作区根目录的路径，POSIX 分隔符 */
  path: string
  name: string
  isDir: boolean
  size: number
  modifiedAt: number
  /** 子节点，仅在目录且已展开时存在 */
  children?: FileNode[]
  /** 是否因忽略规则被隐藏 */
  ignored?: boolean
}

export interface FileContent {
  path: string
  text: string
  size: number
  modifiedAt: number
  /** 是否被截断（超过 maxBytes） */
  truncated: boolean
  /** 二进制文件不返回文本 */
  binary: boolean
}

export interface SearchHit {
  path: string
  matches: {
    line: number
    text: string
    /** 命中片段在主串中的起始列 */
    column: number
  }[]
}

/* ------------------------------------------------------------------ */
/* Skill                                                               */
/* ------------------------------------------------------------------ */

export interface SkillMeta {
  id: string
  /** 目录名或文件名（不含扩展名），SKILL.md 的 name 字段优先 */
  name: string
  description: string
  /** 来源：文件夹 / 单文件 / zip 包 */
  source: 'folder' | 'file' | 'zip'
  /** 本地存储目录（绝对路径） */
  dir: string
  /** 入口文件名，通常 SKILL.md */
  entry: string
  /** 内嵌的资源文件相对路径列表 */
  resources: string[]
  enabled: boolean
  sizeBytes: number
  installedAt: number
  /** frontmatter 中的额外键值（如 version、author） */
  extra: Record<string, string>
}

/* ------------------------------------------------------------------ */
/* GitHub                                                             */
/* ------------------------------------------------------------------ */

export interface GitHubAuthState {
  authenticated: boolean
  login: string | null
  name: string | null
  avatarUrl: string | null
  scopes: string[]
  /** 使用的 token 种类：pat（个人访问令牌）或 oauth */
  tokenKind: 'pat' | 'oauth' | null
  /** 剩余配额，可能为 null（企业版/未返回） */
  rateLimit: { limit: number; remaining: number; resetAt: number } | null
  baseURL: string
}

export interface RepoRef {
  fullName: string
  owner: string
  name: string
  defaultBranch: string
  private: boolean
  description: string | null
  updatedAt: string | null
}

export interface RemoteFileNode {
  path: string
  name: string
  type: 'blob' | 'tree'
  size: number | null
  sha: string
}

export interface RemoteFileContent {
  path: string
  ref: string
  text: string
  sha: string
  size: number
  binary: boolean
  encoding: string
}

/** 待提交的远端文件变更（内容在主进程内生成，不落本地磁盘） */
export interface RemoteFileChange {
  path: string
  /** 新内容；delete 为 true 时可省略 */
  content?: string
  /** base64 编码（用于二进制） */
  encoding?: 'utf-8' | 'base64'
  delete?: boolean
}

export interface RemoteCommitInput {
  owner: string
  repo: string
  /** 直提模式：目标分支；PR 模式：新分支名 */
  branch: string
  /** 从哪个分支/提交拉出新分支，缺省用目标分支 */
  baseBranch?: string
  message: string
  changes: RemoteFileChange[]
  /** 是否开 PR（此时 branch 作为 head，base 取 baseBranch 或默认分支） */
  openPR?: boolean
  prTitle?: string
  prBody?: string
  prDraft?: boolean
}

export interface RemoteCommitResult {
  commitSha: string
  commitUrl: string | null
  branch: string
  pulledRequest: { number: number; url: string; title: string } | null
}

/** 创建 GitHub Release 的入参 */
export interface ReleaseInput {
  owner: string
  repo: string
  /** tag 名，如 v0.2.0；不存在时 GitHub 会按 targetCommitish 自动创建 */
  tag: string
  name?: string
  body?: string
  /** 从哪个分支/提交打 tag，缺省用默认分支 */
  targetCommitish?: string
  draft?: boolean
  prerelease?: boolean
}

/** 仓库目标：聊天区下方选择器选中的远端仓库 */
export interface RepoTarget {
  owner: string
  repo: string
  /** fullName，如 owner/repo，用于展示 */
  fullName: string
  branch: string
}

/* ------------------------------------------------------------------ */
/* 设置                                                               */
/* ------------------------------------------------------------------ */

export interface AppSettings {
  /** 当前选中的供应商 id */
  activeProviderId: string | null
  /** 当前模型名 */
  activeModel: string | null
  /** 系统提示词 */
  systemPrompt: string
  /** Agent 工具循环上限 */
  maxToolRounds: number
  /** 上下文保留的最大消息数（0 表示不裁剪） */
  contextWindow: number
  /** 是否在回答前注入工作区文件树摘要 */
  injectWorkspaceTree: boolean
  /** 单次读取文件最大字节 */
  maxReadBytes: number
  /** 全局忽略规则 */
  ignore: string[]
  githubBaseURL: string

  /* ---- 权限 ---- */

  /** 当前权限档位，决定哪些工具需要人工确认 */
  permissionMode: PermissionMode

  /* ---- 控制台 ---- */

  /** 允许执行控制台命令 */
  shellEnabled: boolean
  /** 命令默认工作目录；null 表示用工作区根目录（无工作区时用用户主目录） */
  shellCwd: string | null
  /** 单条命令超时（毫秒） */
  shellTimeoutMs: number
  /** 命令白名单：非空时只允许这些可执行文件（比对 basename） */
  shellAllowlist: string[]
  /** 命令黑名单：命中即拒绝，优先级高于白名单 */
  shellDenylist: string[]

  /* ---- 屏幕 ---- */

  /** 允许截取屏幕并交给视觉模型 */
  screenCapture: boolean
  /** 允许模拟鼠标键盘（真实点击屏幕） */
  screenInput: boolean
  /** 操作之间插入随机延迟，模拟真人节奏 */
  screenHumanize: boolean
  /** 截图最长边像素，超过则等比缩小以节省 token */
  screenMaxEdge: number
  /** 截取的显示器 id；null 表示全部拼接 */
  screenDisplayId: number | null
  /** 屏幕操作白名单：允许点击的窗口标题关键字；为空表示不限制 */
  screenWindowAllowlist: string[]
}

/* ------------------------------------------------------------------ */
/* 会话                                                               */
/* ------------------------------------------------------------------ */

export interface Session {
  id: string
  title: string
  workspaceId: string | null
  /**
   * 聊天目标：选中的远端仓库。与 workspaceId 二选一，
   * 设了它就表示「直接在仓库里改」，助手走 gh_* 工具，不下载回本地。
   */
  repoTarget?: RepoTarget | null
  providerId: string | null
  model: string | null
  /** 仅前端内存保存完整消息；磁盘只存最近若干条 */
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}

/* ------------------------------------------------------------------ */
/* 插件                                                                */
/* ------------------------------------------------------------------ */

/** 插件能申请的权限。未知权限在安装时直接拒绝 */
export type PluginPermission =
  | 'workspace.read'
  | 'workspace.write'
  | 'network'
  | 'ui'
  /** 读取屏幕截图。需用户在设置里同时开启屏幕读取 */
  | 'screen.capture'
  /** 模拟鼠标键盘。需用户在设置里同时开启屏幕操作 */
  | 'screen.input'
  /** 执行控制台命令。需用户在设置里同时开启控制台 */
  | 'shell'

export interface PluginMeta {
  id: string
  name: string
  version: string
  description: string
  enabled: boolean
  permissions: PluginPermission[]
  /** 插件声明的工具名（不含前缀） */
  tools: string[]
  /** 各工具声明的风险等级，用于权限判定 */
  toolRisks: Record<string, ToolRisk>
  /** 是否提供渲染进程面板 */
  hasPanel: boolean
  installedAt: number
  sizeBytes: number
  source: 'folder' | 'zip'
  error: string | null
}

/* ------------------------------------------------------------------ */
/* 屏幕                                                                */
/* ------------------------------------------------------------------ */

export interface ScreenInfo {
  id: number
  label: string
  bounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
  primary: boolean
}

export interface ScreenSnapshot {
  id: string
  displayId: number
  /** 截图像素宽（已按 screenMaxEdge 缩放） */
  width: number
  /** 截图像素高 */
  height: number
  /** 截图区域在虚拟桌面中的原点 */
  originX: number
  originY: number
  /**
   * 缩放比 = 截图像素 / 屏幕物理像素。
   * 模型给出的坐标是相对截图的，换算回屏幕要除以它：
   * screenX = originX + imageX / scale
   */
  scale: number
  capturedAt: number
  mediaType: 'image/png'
  data: string
}

/** 当前前台窗口，供屏幕操作白名单校验与模型定位 */
export interface ActiveWindowInfo {
  title: string
  /** 可执行文件名，取不到时为 null */
  processName: string | null
  bounds: { x: number; y: number; width: number; height: number } | null
}

/** 当前平台能做什么，用于设置页展示与工具内的快速失败 */
export interface CapabilityReport {
  capture: boolean
  input: boolean
  /** 人类可读的能力说明，直接展示给用户 */
  note: string
}

/* ------------------------------------------------------------------ */
/* 控制台                                                              */
/* ------------------------------------------------------------------ */

export interface ShellResult {
  /** 进程退出码；被信号杀死或超时时为 null */
  exitCode: number | null
  stdout: string
  stderr: string
  /** 是否因超时被终止 */
  timedOut: boolean
  durationMs: number
  /** 实际执行的命令与工作目录，便于在 UI 上复核 */
  command: string
  cwd: string
}

export interface SessionSummary {
  id: string
  title: string
  workspaceId: string | null
  updatedAt: number
  messageCount: number
  totalTokens: number
}

/* ------------------------------------------------------------------ */
/* 通用结果                                                            */
/* ------------------------------------------------------------------ */

export interface Ok<T> {
  ok: true
  value: T
}

export interface Err {
  ok: false
  error: string
}

export type Result<T> = Ok<T> | Err

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value }
}

export function err(error: string): Err {
  return { ok: false, error }
}
