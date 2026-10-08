import type { ChatImage, RemoteFileChange, ShellResult, SkillMeta } from '@shared/types'
import type { ToolContext, ToolDefinition, ToolResult } from './toolTypes'
import { SELF_RISK_PROPS, readSelfAssessment } from './toolTypes'
import { decide } from './permissions'
import { REVIEW_RISKS } from './reviewer'
import { confirmPlan, formatPlan, setPlan, updatePlanStep } from './ptcPlan'
import type { ChatMode } from '@shared/types'
import { WorkspaceError } from '../workspace'
import { ScreenError, type CapabilityReport } from '../screen'
import { ShellError, renderShellResult, type ShellPolicy } from '../shell'

/* ------------------------------------------------------------------ */
/* 参数校验小工具：避免手写一堆 if (typeof x !== 'string')              */
/* ------------------------------------------------------------------ */

class ArgError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArgError'
  }
}

const str = (
  name: string,
  args: Record<string, unknown>,
  opts: { required?: boolean; max?: number } = {}
): string => {
  const v = args[name]
  if (v == null || v === '') {
    if (opts.required) throw new ArgError(`参数 ${name} 不能为空`)
    return ''
  }
  if (typeof v !== 'string') throw new ArgError(`参数 ${name} 必须是字符串`)
  const max = opts.max ?? 20000
  if (v.length > max) throw new ArgError(`参数 ${name} 过长（${v.length} > ${max}）`)
  return v
}

const num = (name: string, args: Record<string, unknown>, fallback: number): number => {
  const v = args[name]
  if (v == null || v === '') return fallback
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) throw new ArgError(`参数 ${name} 必须是数字`)
  return n
}

const bool = (name: string, args: Record<string, unknown>, fallback: boolean): boolean => {
  const v = args[name]
  if (v == null || v === '') return fallback
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  throw new ArgError(`参数 ${name} 必须是布尔值`)
}

const fail = (message: string): ToolResult => ({ ok: false, content: `操作失败：${message}`, summary: message })
const done = (content: string, summary: string, images?: ChatImage[]): ToolResult =>
  images?.length ? { ok: true, content, summary, images } : { ok: true, content, summary }

/* ------------------------------------------------------------------ */
/* 文件路径标准化：模型有时会给出工作区根目录的绝对路径                   */
/* ------------------------------------------------------------------ */

function normalizeRelPath(raw: string, workspacePath: string): string {
  let p = raw.replace(/\\/g, '/').trim()
  if (!p) return ''
  const root = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '')
  if (p.toLowerCase().startsWith(root.toLowerCase())) {
    p = p.slice(root.length)
  }
  p = p.replace(/^\/+/, '')
  return p
}

/**
 * 判断一个相对路径是否试图逃出工作区。
 * 这里只做静态判断：safeResolve 会在真正读写时再做一次权威校验。
 */
export function pathEscapesWorkspace(rel: string): boolean {
  const norm = rel.replace(/\\/g, '/').trim()
  if (!norm) return false
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) return true
  return norm.split('/').some((seg) => seg === '..')
}

export function requiresWorkspace(ctx: ToolContext): string | ToolResult {
  if (!ctx.workspace) {
    return fail('当前会话未绑定工作区。请先在左侧「工作区」面板添加并选中一个目录。')
  }
  return ctx.workspace.path
}

/* ------------------------------------------------------------------ */
/* 工具实现                                                            */
/* ------------------------------------------------------------------ */

export interface ToolDeps {
  ws: {
    listDir: (ws: { id: string; name: string; path: string }, rel: string, depth?: number) => Promise<unknown>
    readFile: (ws: { id: string; name: string; path: string }, rel: string, maxBytes: number) => Promise<{ text: string; binary: boolean; truncated: boolean; size: number }>
    writeFile: (ws: { id: string; name: string; path: string }, rel: string, text: string, o?: { createDirs?: boolean; append?: boolean }) => Promise<{ size: number; created: boolean }>
    search: (ws: { id: string; name: string; path: string }, q: string, o?: { maxResults?: number; caseSensitive?: boolean; regex?: boolean }) => Promise<{ path: string; matches: { line: number; text: string; column: number }[] }[]>
    collectFiles: (ws: { id: string; name: string; path: string }, limit?: number) => Promise<string[]>
    /** 查看路径元信息（类型/大小/修改时间） */
    stat: (ws: { id: string; name: string; path: string }, rel: string) => Promise<{ path: string; name: string; isDir: boolean; size: number; modifiedAt: number }>
    /** 移动/重命名，拒绝工作区根目录 */
    move: (ws: { id: string; name: string; path: string }, from: string, to: string) => Promise<void>
    /** 删除文件或递归删除目录，拒绝工作区根目录 */
    remove: (ws: { id: string; name: string; path: string }, rel: string) => Promise<{ path: string; isDir: boolean }>
  }
  maxReadBytes: number
  github: {
    enabled: () => boolean
    listDir: (owner: string, repo: string, ref: string, p: string) => Promise<unknown>
    readFile: (owner: string, repo: string, p: string, ref: string) => Promise<{ text: string; binary: boolean; size: number; sha: string }>
    writeFiles: (
      owner: string,
      repo: string,
      branch: string,
      message: string,
      changes: RemoteFileChange[],
      baseBranch?: string
    ) => Promise<{ commitSha: string; commitUrl: string | null; branch: string }>
    /** 代码搜索（需要令牌） */
    searchCode: (query: string, limit: number) => Promise<{ path: string; repo: string; name: string; url: string | null }[]>
  }
  /** 已安装 skill 的读取入口。未提供时 skill_read 工具不注册 */
  skills?: {
    list: () => Promise<SkillMeta[]>
    readEntry: (id: string, maxBytes?: number) => Promise<{ meta: SkillMeta; text: string }>
    readResource: (id: string, rel: string, maxBytes?: number) => Promise<string>
  }
  /** 控制台执行。未提供时 shell_run 工具不注册 */
  shell?: {
    enabled: () => boolean
    cwd: () => string
    policy: () => ShellPolicy
    timeoutMs: () => number
    run: (command: string, signal: AbortSignal) => Promise<ShellResult>
    /** 供系统提示词展示当前环境 */
    describe: () => string
  }
  /** 屏幕能力。未提供时 screen_* 工具不注册 */
  screen?: {
    captureEnabled: () => boolean
    inputEnabled: () => boolean
    humanize: () => boolean
    maxEdge: () => number
    displayId: () => number | null
    allowedWindows: () => string[]
    capabilities: () => Promise<CapabilityReport>
    capture: (signal: AbortSignal) => Promise<{ b64: string; caption: string; text: string }>
    click: (p: { x: number; y: number }, o: { button?: 'left' | 'right' | 'middle'; count?: number }, signal: AbortSignal) => Promise<void>
    type: (text: string, signal: AbortSignal) => Promise<void>
    keys: (keys: string[], signal: AbortSignal) => Promise<void>
    scroll: (amount: number, at: { x: number; y: number } | null, signal: AbortSignal) => Promise<void>
    drag: (from: { x: number; y: number }, to: { x: number; y: number }, signal: AbortSignal) => Promise<void>
    activeWindow: () => Promise<{ title: string; processName: string | null } | null>
    /** 把截图坐标换算回屏幕坐标 */
    toScreen: (x: number, y: number) => { x: number; y: number }
    /** 最近一次截图的信息，用于校验坐标时效性 */
    lastCapture: () => { at: number; width: number; height: number } | null
  }
}

/**
 * 统一审批入口：所有需要确认的工具都走这里。
 * 判定交给 permissions.decide，工具只负责声明自己的静态风险。
 */
async function gate(
  ctx: ToolContext,
  req: {
    tool: string
    risk: ToolDefinition['risk']
    title: string
    detail: string
    escapesWorkspace?: boolean
    capabilityEnabled?: boolean
    capabilityLabel?: string
    selfAssessFrom?: Record<string, unknown>
  }
): Promise<ToolResult | null> {
  const decision = decide({
    mode: ctx.permissionMode,
    risk: req.risk,
    escapesWorkspace: req.escapesWorkspace ?? false,
    selfAssessed: req.selfAssessFrom ? readSelfAssessment(req.selfAssessFrom) : undefined,
    allowWrite: ctx.allowWrite,
    capabilityEnabled: req.capabilityEnabled ?? true,
    capabilityLabel: req.capabilityLabel ?? '该能力'
  })

  if (decision.action === 'deny') return fail(decision.reason)
  if (decision.action === 'allow') return null

  // 智能模式机器预审：高风险操作先过一次 reviewer 子代理。
  // deny 直接拦截（省一次打扰用户）；approve/escalate 照常弹确认卡片——
  // 机器永远不能代替用户点"允许"。评审失败则按原流程走（fail-open 到人工）。
  if (ctx.permissionMode === 'smart' && REVIEW_RISKS.has(req.risk) && ctx.reviewAction) {
    try {
      const review = await ctx.reviewAction({ tool: req.tool, title: req.title, detail: req.detail, risk: req.risk })
      if (review && review.verdict === 'deny') {
        return fail(`安全评审拦截：${review.reason}（如确需执行，请换一种更安全的做法）`)
      }
    } catch {
      // 评审异常不卡流程，用户确认卡片还在
    }
  }

  const approved = await ctx.requestApproval?.({
    tool: req.tool,
    title: req.title,
    detail: req.detail,
    risk: req.risk,
    selfAssessed: req.selfAssessFrom ? readSelfAssessment(req.selfAssessFrom) : undefined
  })
  if (!approved) return fail(`用户拒绝了：${req.title}`)
  return null
}

export function buildTools(deps: ToolDeps): ToolDefinition[] {
  const tools: ToolDefinition[] = []

  /* ---------------- 工作区读 ---------------- */

  tools.push({
    risk: 'read',
    schema: {
      name: 'file_stat',
      description: '查看一个文件或目录的元信息：类型、大小、修改时间。不读取内容。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区根目录的路径；留空表示根目录' }
        }
      }
    },
    async run(args, ctx) {
      const root = requiresWorkspace(ctx)
      if (typeof root !== 'string') return root
      const rel = normalizeRelPath(str('path', args), root)
      try {
        const st = await deps.ws.stat({ id: 'x', name: 'ws', path: root }, rel)
        const type = st.isDir ? '目录' : '文件'
        const when = st.modifiedAt
          ? new Date(st.modifiedAt).toISOString().replace('T', ' ').slice(0, 19)
          : '未知'
        return done(
          `${type} ${st.path}\n大小：${st.size} 字节\n修改时间：${when}`,
          `${type} ${st.path}：${st.size}B`
        )
      } catch (e) {
        return fail(e instanceof WorkspaceError ? e.message : String(e))
      }
    }
  })

  tools.push({
    risk: 'read',
    schema: {
      name: 'list_dir',
      description: '列出工作区中某个目录的内容。不传 path 时列出工作区根目录。目录在前，文件在后。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区根目录的路径，如 src/main。留空表示根目录' },
          depth: { type: 'number', description: '递归深度，默认 1（只列一层），最大 4' }
        }
      }
    },
    async run(args, ctx) {
      const root = requiresWorkspace(ctx)
      if (typeof root !== 'string') return root
      const rel = normalizeRelPath(str('path', args), root)
      const depth = Math.min(Math.max(num('depth', args, 1), 1), 4)
      try {
        const nodes = (await deps.ws.listDir(
          { id: 'x', name: 'ws', path: root },
          rel,
          depth
        )) as { path: string; name: string; isDir: boolean; size: number; ignored?: boolean }[]

        if (!nodes.length) return done(`目录 ${rel || '.'} 为空`, `空目录 ${rel || '.'}`)

        const lines = nodes.map(
          (n) => `${n.name}${n.isDir ? '/' : ''}${n.isDir ? '' : `  ${n.size}B`}${n.ignored ? '  [已忽略]' : ''}`
        )
        const text = `目录 ${rel || '.'}（共 ${nodes.length} 项）：\n${lines.join('\n')}`
        return done(text, `列出 ${rel || '.'}：${nodes.length} 项`)
      } catch (e) {
        return fail(e instanceof WorkspaceError ? e.message : String(e))
      }
    }
  })

  tools.push({
    risk: 'read',
    schema: {
      name: 'read_file',
      description: '读取工作区中一个文本文件的内容。大文件会被截断并提示。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区根目录的文件路径' },
          start_line: { type: 'number', description: '起始行号（从 1 开始），可选' },
          end_line: { type: 'number', description: '结束行号（含），可选' }
        },
        required: ['path']
      }
    },
    async run(args, ctx) {
      const root = requiresWorkspace(ctx)
      if (typeof root !== 'string') return root
      const rel = normalizeRelPath(str('path', args, { required: true }), root)
      try {
        const file = await deps.ws.readFile({ id: 'x', name: 'ws', path: root }, rel, deps.maxReadBytes)
        if (file.binary) return fail(`${rel} 是二进制文件，无法作为文本读取`)
        const allLines = file.text.split('\n')
        const start = Math.max(1, Math.floor(num('start_line', args, 1)))
        const end = Math.min(allLines.length, Math.floor(num('end_line', args, allLines.length)))
        const slice = allLines.slice(start - 1, end)
        const withNo = slice.map((l, i) => `${start + i}\t${l}`).join('\n')
        const note = file.truncated
          ? `\n\n[注意] 文件共 ${file.size} 字节，已截断，仅读取了前 ${deps.maxReadBytes} 字节`
          : ''
        return done(
          `文件 ${rel}（第 ${start}-${end} 行，共 ${allLines.length} 行）：\n${withNo}${note}`,
          `读取 ${rel}（${slice.length} 行）`
        )
      } catch (e) {
        return fail(e instanceof WorkspaceError ? e.message : String(e))
      }
    }
  })

  tools.push({
    risk: 'read',
    schema: {
      name: 'search_code',
      description: '在工作区中按文本或正则搜索代码。返回文件、行号与命中内容。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索内容（默认按字面量，regex=true 时按正则）' },
          regex: { type: 'boolean', description: '是否按正则表达式搜索，默认 false' },
          case_sensitive: { type: 'boolean', description: '是否区分大小写，默认 false' },
          max_results: { type: 'number', description: '最多返回多少条命中，默认 60，最大 200' }
        },
        required: ['query']
      }
    },
    async run(args, ctx) {
      const root = requiresWorkspace(ctx)
      if (typeof root !== 'string') return root
      const query = str('query', args, { required: true })
      const maxResults = Math.min(Math.max(Math.floor(num('max_results', args, 60)), 1), 200)
      try {
        const hits = await deps.ws.search({ id: 'x', name: 'ws', path: root }, query, {
          maxResults,
          regex: bool('regex', args, false),
          caseSensitive: bool('case_sensitive', args, false)
        })
        if (!hits.length) return done(`未找到匹配「${query}」的内容`, `无匹配：${query}`)
        const text = hits
          .map((h) => `${h.path}\n${h.matches.map((m) => `  ${m.line}: ${m.text.trim().slice(0, 200)}`).join('\n')}`)
          .join('\n\n')
        const total = hits.reduce((n, h) => n + h.matches.length, 0)
        return done(
          `搜索「${query}」命中 ${total} 处，涉及 ${hits.length} 个文件：\n\n${text}`,
          `搜索 ${query}：${total} 处 / ${hits.length} 文件`
        )
      } catch (e) {
        return fail(e instanceof WorkspaceError ? e.message : String(e))
      }
    }
  })

  tools.push({
    risk: 'read',
    schema: {
      name: 'list_all_files',
      description: '递归列出工作区所有文件路径（不含被忽略目录）。用于快速了解项目结构。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '最多返回多少个路径，默认 300' }
        }
      }
    },
    async run(args, ctx) {
      const root = requiresWorkspace(ctx)
      if (typeof root !== 'string') return root
      const limit = Math.min(Math.max(Math.floor(num('limit', args, 300)), 1), 2000)
      const files = await deps.ws.collectFiles({ id: 'x', name: 'ws', path: root }, limit)
      return done(`共 ${files.length} 个文件：\n${files.join('\n')}`, `文件清单：${files.length} 个`)
    }
  })

  /* ---------------- 工作区写 ---------------- */

  tools.push({
    risk: 'write',
    // 越界路径要额外确认，交给 permissions 判定
    escapesWorkspace: (args) => pathEscapesWorkspace(typeof args.path === 'string' ? args.path : ''),
    schema: {
      name: 'write_file',
      description:
        '在工作区写入（覆盖或新建）一个文本文件。修改前应先 read_file 了解原内容。工作区内写入在「工作区内更改」及以上权限下无需确认。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区根目录的文件路径' },
          content: { type: 'string', description: '要写入的完整文件内容' },
          append: { type: 'boolean', description: '是否追加而非覆盖，默认 false' },
          ...SELF_RISK_PROPS
        },
        required: ['path', 'content']
      }
    },
    async run(args, ctx) {
      const root = requiresWorkspace(ctx)
      if (typeof root !== 'string') return root
      const rel = normalizeRelPath(str('path', args, { required: true }), root)
      const content = str('content', args, { max: 4_000_000 })
      const append = bool('append', args, false)

      if (!rel) return fail('文件路径不能为空')

      let before = ''
      let existed = false
      try {
        const old = await deps.ws.readFile({ id: 'x', name: 'ws', path: root }, rel, 200_000)
        before = old.text
        existed = true
      } catch {
        existed = false
      }

      const denied = await gate(ctx, {
        tool: 'write_file',
        risk: 'write',
        title: `${existed ? '修改' : '新建'}文件 ${rel}`,
        detail: existed
          ? `原文件 ${before.split('\n').length} 行 → 新内容 ${content.split('\n').length} 行${append ? '（追加模式）' : ''}`
          : `新建文件，${content.split('\n').length} 行，${Buffer.byteLength(content, 'utf8')} 字节`,
        escapesWorkspace: pathEscapesWorkspace(str('path', args)),
        selfAssessFrom: args
      })
      if (denied) return denied

      try {
        const res = await deps.ws.writeFile({ id: 'x', name: 'ws', path: root }, rel, content, {
          createDirs: true,
          append
        })
        return done(
          `已${res.created ? '创建' : '更新'} ${rel}（${res.size} 字节）`,
          `${res.created ? '新建' : '写入'} ${rel}`
        )
      } catch (e) {
        return fail(e instanceof WorkspaceError ? e.message : String(e))
      }
    }
  })

  /* ---------------- 移动 / 删除 ---------------- */

  tools.push({
    risk: 'write',
    // 任一端越界都要额外确认
    escapesWorkspace: (args) =>
      pathEscapesWorkspace(typeof args.from === 'string' ? args.from : '') ||
      pathEscapesWorkspace(typeof args.to === 'string' ? args.to : ''),
    schema: {
      name: 'move_path',
      description: '移动或重命名文件/目录。目标已存在时会被覆盖（目录除外，目录冲突会报错）。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '源路径（相对工作区根目录）' },
          to: { type: 'string', description: '目标路径（相对工作区根目录）' },
          ...SELF_RISK_PROPS
        },
        required: ['from', 'to']
      }
    },
    async run(args, ctx) {
      const root = requiresWorkspace(ctx)
      if (typeof root !== 'string') return root
      const from = normalizeRelPath(str('from', args, { required: true }), root)
      const to = normalizeRelPath(str('to', args, { required: true }), root)
      if (!from) return fail('源路径不能为空')
      if (!to) return fail('目标路径不能为空')
      if (from === to) return fail('源与目标相同，无需移动')

      const denied = await gate(ctx, {
        tool: 'move_path',
        risk: 'write',
        title: `移动 ${from} → ${to}`,
        detail: `把 ${from} 移动/重命名为 ${to}。目标若已存在会被覆盖。`,
        escapesWorkspace:
          pathEscapesWorkspace(str('from', args)) || pathEscapesWorkspace(str('to', args)),
        selfAssessFrom: args
      })
      if (denied) return denied

      try {
        await deps.ws.move({ id: 'x', name: 'ws', path: root }, from, to)
        return done(`已移动 ${from} → ${to}`, `移动 ${from} → ${to}`)
      } catch (e) {
        return fail(e instanceof WorkspaceError ? e.message : String(e))
      }
    }
  })

  tools.push({
    risk: 'delete',
    // 越界路径要额外确认，交给 permissions 判定
    escapesWorkspace: (args) => pathEscapesWorkspace(typeof args.path === 'string' ? args.path : ''),
    schema: {
      name: 'delete_path',
      description: '删除一个文件或目录（目录会递归删除其中所有内容，不可恢复）。删除前会弹出确认。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要删除的相对工作区根目录路径' },
          ...SELF_RISK_PROPS
        },
        required: ['path']
      }
    },
    async run(args, ctx) {
      const root = requiresWorkspace(ctx)
      if (typeof root !== 'string') return root
      const rel = normalizeRelPath(str('path', args, { required: true }), root)
      if (!rel) return fail('拒绝删除工作区根目录')

      let size = 0
      let isDir = false
      try {
        const st = await deps.ws.stat({ id: 'x', name: 'ws', path: root }, rel)
        size = st.size
        isDir = st.isDir
      } catch {
        return fail(`路径不存在：${rel}`)
      }

      const denied = await gate(ctx, {
        tool: 'delete_path',
        risk: 'delete',
        title: `删除${isDir ? '目录' : '文件'} ${rel}`,
        detail: isDir
          ? `${rel} 是目录，将连同其中所有内容一起删除，不可恢复。`
          : `${rel}（${size} 字节），删除后不可恢复。`,
        escapesWorkspace: pathEscapesWorkspace(str('path', args)),
        selfAssessFrom: args
      })
      if (denied) return denied

      try {
        const r = await deps.ws.remove({ id: 'x', name: 'ws', path: root }, rel)
        return done(`已删除${r.isDir ? '目录' : '文件'} ${r.path}`, `删除 ${r.path}`)
      } catch (e) {
        return fail(e instanceof WorkspaceError ? e.message : String(e))
      }
    }
  })

  /* ---------------- Skill ---------------- */

  if (deps.skills) {
    const skills = deps.skills

    tools.push({
      risk: 'read',
      schema: {
        name: 'skill_read',
        description: [
          '读取已安装 Skill 的内容。Skill 是打包好的可复用操作指令/模板文档。',
          '不传 id 返回已安装 skill 列表；只传 id 读取该 skill 的入口说明（SKILL.md）；',
          '再传 path 读取该 skill 目录内的其他资源文件（模板、示例等）。'
        ].join(''),
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'skill 标识（见列表输出）；留空列出全部 skill' },
            path: { type: 'string', description: 'skill 内资源文件的相对路径；留空读入口说明' }
          }
        }
      },
      async run(args) {
        const id = str('id', args)
        const rel = str('path', args)

        if (!id) {
          try {
            const list = await skills.list()
            if (!list.length) return done('还没有安装任何 skill。', '无 skill')
            const text = list
              .map(
                (s) =>
                  `${s.id}  ${s.name}${s.enabled ? '' : '（已停用）'}${s.description ? ` — ${s.description}` : ''}`
              )
              .join('\n')
            return done(`已安装 ${list.length} 个 skill：\n${text}`, `列出 ${list.length} 个 skill`)
          } catch (e) {
            return fail(String(e instanceof Error ? e.message : e))
          }
        }

        if (rel) {
          try {
            const text = await skills.readResource(id, rel, 200_000)
            return done(`skill ${id} 的 ${rel}：\n${text}`, `读取 ${id}/${rel}`)
          } catch (e) {
            return fail(String(e instanceof Error ? e.message : e))
          }
        }

        try {
          const { meta, text } = await skills.readEntry(id, 64 * 1024)
          return done(`### ${meta.name}（${meta.id}）\n${text}`, `读取 skill ${meta.id}`)
        } catch (e) {
          return fail(String(e instanceof Error ? e.message : e))
        }
      }
    })
  }

  /* ---------------- 控制台 ---------------- */

  if (deps.shell) {
    const shell = deps.shell

    tools.push({
      risk: 'read',
      schema: {
        name: 'shell_run',
        description: [
          '在用户电脑上执行一条控制台命令并返回输出。',
          '这是真实的系统命令行，不是沙箱：命令实际改变系统状态。',
          '默认工作目录见运行环境说明。合理使用场景：运行构建、测试、git 状态查询、安装依赖、调用命令行工具。',
          '不要用它读取工作区文件（用 read_file），不要用它做能被专门工具完成的事。'
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的完整命令行' },
            cwd: {
              type: 'string',
              description: '工作目录绝对路径；留空使用默认目录。不要传相对路径'
            },
            purpose: { type: 'string', description: '一句话说明这条命令要达成什么，展示给用户审核' },
            ...SELF_RISK_PROPS
          },
          required: ['command', 'purpose']
        }
      },
      async run(args, ctx) {
        if (!shell.enabled()) return fail('控制台已在设置中关闭')
        const command = str('command', args, { required: true, max: 8000 })
        const purpose = str('purpose', args, { required: true, max: 300 })
        const cwdArg = str('cwd', args)
        const cwd = cwdArg || shell.cwd()

        const denied = await gate(ctx, {
          tool: 'shell_run',
          risk: 'shell',
          title: `执行命令：${command.split('\n')[0].slice(0, 120)}`,
          detail: [
            `目的：${purpose}`,
            `目录：${cwd}`,
            `超时：${Math.round(shell.timeoutMs() / 1000)} 秒`,
            '',
            '完整命令：',
            command
          ].join('\n'),
          capabilityEnabled: shell.enabled(),
          capabilityLabel: '控制台',
          selfAssessFrom: args
        })
        if (denied) return denied

        try {
          const result = await shell.run(command, ctx.signal)
          return done(renderShellResult(result), `执行 ${command.slice(0, 60)}（退出码 ${result.exitCode ?? '?'}）`)
        } catch (e) {
          return fail(e instanceof ShellError ? e.message : String(e))
        }
      }
    })
  }

  /* ---------------- 屏幕 ---------------- */

  if (deps.screen) {
    const screen = deps.screen

    tools.push({
      risk: 'screen',
      schema: {
        name: 'screen_look',
        description: [
          '截取用户屏幕并直接看到画面（需要支持视觉的模型）。',
          '返回的图片就是用户此刻的屏幕内容，你可以从中读取界面文字、按钮位置和状态。',
          '坐标以本张截图左上角为原点；点击时直接使用你在图上量到的像素坐标即可，换算由程序处理。',
          '重要：截图是某一瞬间的画面。若之后界面可能发生变化（加载完成、弹窗、切换页面），请重新截图再点击。'
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            purpose: { type: 'string', description: '你这次要看什么，例如「查看登录按钮的位置」' }
          },
          required: ['purpose']
        }
      },
      async run(args, ctx): Promise<ToolResult> {
        if (!screen.captureEnabled()) return fail('屏幕读取已在设置中关闭')
        const purpose = str('purpose', args, { required: true, max: 300 })

        const caps = await screen.capabilities()
        if (!caps.capture) return fail(`当前环境不支持截图：${caps.note}`)

        const denied = await gate(ctx, {
          tool: 'screen_look',
          risk: 'screen',
          title: '截取屏幕画面',
          detail: `目的：${purpose}\n\n截图会作为图片发送给当前视觉模型。`,
          capabilityEnabled: screen.captureEnabled(),
          capabilityLabel: '屏幕读取'
        })
        if (denied) return denied

        try {
          const shot = await screen.capture(ctx.signal)
          const active = await screen.activeWindow().catch(() => null)
          const contextLine = active?.title ? `\n当前前台窗口：${active.title}` : ''
          const images: ChatImage[] = [
            { mediaType: 'image/png', data: shot.b64, caption: shot.caption, createdAt: Date.now() }
          ]
          return done(`${shot.text}${contextLine}`, `截屏：${purpose}`, images)
        } catch (e) {
          return fail(e instanceof ScreenError ? e.message : String(e))
        }
      }
    })

    tools.push({
      risk: 'screen',
      schema: {
        name: 'screen_click',
        description: [
          '在屏幕上真实点击。坐标使用你在最近一次 screen_look 截图上量到的像素位置。',
          '点击前会自动把光标沿接近真人的轨迹移动到目标。',
          '必须先截图再用本工具：不截图就没有坐标依据，盲点可能触发不可预期操作。'
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            x: { type: 'number', description: '相对最近一次截图左上角的横坐标，单位像素' },
            y: { type: 'number', description: '相对最近一次截图左上角的纵坐标，单位像素' },
            button: { type: 'string', description: '鼠标键：left / right / middle，默认 left', enum: ['left', 'right', 'middle'] },
            double: { type: 'boolean', description: '是否双击，默认 false' },
            target: { type: 'string', description: '你要点击的是什么，例如「登录按钮」。用于让用户核对坐标是否合理' },
            ...SELF_RISK_PROPS
          },
          required: ['x', 'y', 'target']
        }
      },
      async run(args, ctx) {
        if (!screen.inputEnabled()) return fail('屏幕操作已在设置中关闭')
        const target = str('target', args, { required: true, max: 200 })

        const freshness = checkFreshness(screen, (m) => fail(m))
        if (freshness) return freshness

        const raw = { x: Math.round(num('x', args, NaN)), y: Math.round(num('y', args, NaN)) }
        if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return fail('坐标必须是数字')
        const point = screen.toScreen(raw.x, raw.y)

        const buttonRaw = str('button', args) || 'left'
        const button = buttonRaw === 'right' || buttonRaw === 'middle' ? buttonRaw : 'left'
        const count = bool('double', args, false) ? 2 : 1

        const whitelist = screen.allowedWindows()
        if (whitelist.length) {
          const active = await screen.activeWindow().catch(() => null)
          const title = active?.title ?? ''
          const okWindow = whitelist.some((w) => title.toLowerCase().includes(w.toLowerCase()))
          if (!okWindow) {
            return fail(
              `当前前台窗口「${title || '未知'}」不在屏幕操作白名单内。` +
                `允许的窗口关键字：${whitelist.join('、')}。请先切到允许的窗口。`
            )
          }
        }

        const denied = await gate(ctx, {
          tool: 'screen_click',
          risk: 'screen',
          title: `点击屏幕：${target}`,
          detail: [
            `目标：${target}`,
            `截图坐标：(${raw.x}, ${raw.y})`,
            `屏幕坐标：(${point.x}, ${point.y})`,
            `按键：${button}${count === 2 ? '（双击）' : ''}`
          ].join('\n'),
          capabilityEnabled: screen.inputEnabled(),
          capabilityLabel: '屏幕操作',
          selfAssessFrom: args
        })
        if (denied) return denied

        try {
          await screen.click(point, { button, count }, ctx.signal)
          return done(
            `已点击 (${point.x}, ${point.y})［${target}］。界面可能已变化，下一步操作前请重新截图确认。`,
            `点击 ${target}`
          )
        } catch (e) {
          return fail(e instanceof ScreenError ? e.message : String(e))
        }
      }
    })

    tools.push({
      risk: 'screen',
      schema: {
        name: 'screen_type',
        description: [
          '在当前光标焦点处输入文本，模拟键盘键入。支持中文与任意 Unicode 字符。',
          '输入前请确保目标输入框已获得焦点——通常需要先用 screen_click 点一下。',
          '如果需要先清空原内容，用 screen_key 发 ctrl+a 再输入。'
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要输入的文本' },
            target: { type: 'string', description: '输入到哪里，例如「搜索框」' },
            ...SELF_RISK_PROPS
          },
          required: ['text', 'target']
        }
      },
      async run(args, ctx) {
        if (!screen.inputEnabled()) return fail('屏幕操作已在设置中关闭')
        const text = str('text', args, { required: true, max: 20000 })
        const target = str('target', args, { required: true, max: 200 })

        const denied = await gate(ctx, {
          tool: 'screen_type',
          risk: 'screen',
          title: `输入文本到：${target}`,
          detail: `目标：${target}\n文本（${text.length} 字）：\n${text.slice(0, 600)}${text.length > 600 ? '\n…（已截断预览）' : ''}`,
          capabilityEnabled: screen.inputEnabled(),
          capabilityLabel: '屏幕操作',
          selfAssessFrom: args
        })
        if (denied) return denied

        try {
          await screen.type(text, ctx.signal)
          return done(`已向「${target}」输入 ${text.length} 个字符。`, `输入到 ${target}`)
        } catch (e) {
          return fail(e instanceof ScreenError ? e.message : String(e))
        }
      }
    })

    tools.push({
      risk: 'screen',
      schema: {
        name: 'screen_key',
        description:
          '按下按键或组合键。keys 数组依次按下、逆序释放，因此 ["ctrl","c"] 表示 Ctrl+C，["alt","tab"] 表示切换窗口。可用键名：字母、数字、enter、tab、escape、space、backspace、delete、up/down/left/right、home、end、pageup、pagedown、f1~f12、ctrl、alt、shift、win。',
        parameters: {
          type: 'object',
          properties: {
            keys: {
              type: 'array',
              description: '要按下的键，例如 ["ctrl","c"]',
              items: { type: 'string' }
            },
            target: { type: 'string', description: '作用对象，例如「代码编辑器」' },
            ...SELF_RISK_PROPS
          },
          required: ['keys', 'target']
        }
      },
      async run(args, ctx) {
        if (!screen.inputEnabled()) return fail('屏幕操作已在设置中关闭')
        const raw = args.keys
        if (!Array.isArray(raw) || !raw.length) return fail('keys 必须是非空数组')
        const keys = raw.filter((k): k is string => typeof k === 'string' && Boolean(k.trim()))
        if (!keys.length) return fail('keys 中没有合法的键名')
        const target = str('target', args, { required: true, max: 200 })

        const denied = await gate(ctx, {
          tool: 'screen_key',
          risk: 'screen',
          title: `按键：${keys.join('+')}`,
          detail: `作用对象：${target}`,
          capabilityEnabled: screen.inputEnabled(),
          capabilityLabel: '屏幕操作',
          selfAssessFrom: args
        })
        if (denied) return denied

        try {
          await screen.keys(keys, ctx.signal)
          return done(`已按下 ${keys.join('+')}。`, `按键 ${keys.join('+')}`)
        } catch (e) {
          return fail(e instanceof ScreenError ? e.message : String(e))
        }
      }
    })

    tools.push({
      risk: 'screen',
      schema: {
        name: 'screen_scroll',
        description: '在屏幕上滚动。amount 为负数向下、正数为向上，绝对值约等于像素量（工具会折算成滚轮格数）。',
        parameters: {
          type: 'object',
          properties: {
            amount: { type: 'number', description: '滚动量，负数为向下，如 -300 表示向下滚三格' },
            x: { type: 'number', description: '在哪个位置滚动（截图坐标横轴），留空则用鼠标当前位置' },
            y: { type: 'number', description: '滚动位置（截图坐标纵轴）' },
            target: { type: 'string', description: '滚动的区域，例如「聊天列表」' },
            ...SELF_RISK_PROPS
          },
          required: ['amount', 'target']
        }
      },
      async run(args, ctx) {
        if (!screen.inputEnabled()) return fail('屏幕操作已在设置中关闭')
        const amount = num('amount', args, 0)
        if (!amount) return fail('amount 不能为 0')
        const target = str('target', args, { required: true, max: 200 })
        const hasPoint = args.x != null && args.y != null
        const at = hasPoint ? screen.toScreen(Math.round(num('x', args, 0)), Math.round(num('y', args, 0))) : null

        const denied = await gate(ctx, {
          tool: 'screen_scroll',
          risk: 'screen',
          title: `滚动：${target}`,
          detail: `方向：${amount > 0 ? '向上' : '向下'}\n量：${Math.abs(amount)}${at ? `\n位置：(${at.x}, ${at.y})` : ''}`,
          capabilityEnabled: screen.inputEnabled(),
          capabilityLabel: '屏幕操作',
          selfAssessFrom: args
        })
        if (denied) return denied

        try {
          await screen.scroll(amount, at, ctx.signal)
          return done(`已在「${target}」${amount > 0 ? '向上' : '向下'}滚动。`, `滚动 ${target}`)
        } catch (e) {
          return fail(e instanceof ScreenError ? e.message : String(e))
        }
      }
    })

    tools.push({
      risk: 'screen',
      schema: {
        name: 'screen_drag',
        description:
          '按住拖动。坐标均为最近一次截图上的像素位置。用于拖拽文件、调整滑块、框选区域。',
        parameters: {
          type: 'object',
          properties: {
            from_x: { type: 'number', description: '起点横坐标（截图坐标）' },
            from_y: { type: 'number', description: '起点纵坐标（截图坐标）' },
            to_x: { type: 'number', description: '终点横坐标（截图坐标）' },
            to_y: { type: 'number', description: '终点纵坐标（截图坐标）' },
            target: { type: 'string', description: '拖拽的对象，例如「音量滑块」' },
            ...SELF_RISK_PROPS
          },
          required: ['from_x', 'from_y', 'to_x', 'to_y', 'target']
        }
      },
      async run(args, ctx) {
        if (!screen.inputEnabled()) return fail('屏幕操作已在设置中关闭')
        const target = str('target', args, { required: true, max: 200 })
        const freshness = checkFreshness(screen, (m) => fail(m))
        if (freshness) return freshness

        const from = screen.toScreen(Math.round(num('from_x', args, NaN)), Math.round(num('from_y', args, NaN)))
        const to = screen.toScreen(Math.round(num('to_x', args, NaN)), Math.round(num('to_y', args, NaN)))
        if (![from.x, from.y, to.x, to.y].every(Number.isFinite)) return fail('四个坐标都必须是数字')

        const denied = await gate(ctx, {
          tool: 'screen_drag',
          risk: 'screen',
          title: `拖拽：${target}`,
          detail: `从 (${from.x}, ${from.y}) 拖到 (${to.x}, ${to.y})`,
          capabilityEnabled: screen.inputEnabled(),
          capabilityLabel: '屏幕操作',
          selfAssessFrom: args
        })
        if (denied) return denied

        try {
          await screen.drag(from, to, ctx.signal)
          return done(`已把「${target}」从 (${from.x}, ${from.y}) 拖到 (${to.x}, ${to.y})。`, `拖拽 ${target}`)
        } catch (e) {
          return fail(e instanceof ScreenError ? e.message : String(e))
        }
      }
    })
  }

  /* ---------------- GitHub 读 ---------------- */

  tools.push({
    risk: 'read',
    schema: {
      name: 'gh_list_dir',
      description: '列出 GitHub 仓库某个目录的内容（不下载到本地）。',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '仓库所有者，如 facebook' },
          repo: { type: 'string', description: '仓库名，如 react' },
          path: { type: 'string', description: '仓库内目录路径，留空表示根目录' },
          ref: { type: 'string', description: '分支/标签/提交 SHA，留空用默认分支' }
        },
        required: ['owner', 'repo']
      }
    },
    async run(args, ctx) {
      if (!deps.github.enabled()) return fail('尚未连接 GitHub，请先在「GitHub」页配置访问令牌')
      const owner = str('owner', args, { required: true })
      const repo = str('repo', args, { required: true })
      const p = str('path', args).replace(/^\/+/, '')
      const ref = str('ref', args) || 'HEAD'
      try {
        const nodes = (await deps.github.listDir(owner, repo, ref, p)) as {
          path: string
          name: string
          type: 'blob' | 'tree'
          size: number | null
        }[]
        void ctx
        if (!nodes.length) return done(`目录 ${p || '/'} 为空`, `远端空目录 ${p || '/'}`)
        const text = nodes
          .map((n) => `${n.type === 'tree' ? '[目录]' : '[文件]'} ${n.path}${n.size != null ? `  ${n.size}B` : ''}`)
          .join('\n')
        return done(
          `仓库 ${owner}/${repo} 的 ${p || '/'}（ref=${ref}）：\n${text}`,
          `远端目录 ${p || '/'}：${nodes.length} 项`
        )
      } catch (e) {
        return fail(String(e instanceof Error ? e.message : e))
      }
    }
  })

  tools.push({
    risk: 'read',
    schema: {
      name: 'gh_read_file',
      description: '读取 GitHub 仓库中的文本文件内容（通过 API，不 clone 到本地）。',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '仓库所有者' },
          repo: { type: 'string', description: '仓库名' },
          path: { type: 'string', description: '仓库内文件路径' },
          ref: { type: 'string', description: '分支/标签/提交 SHA，留空用默认分支' }
        },
        required: ['owner', 'repo', 'path']
      }
    },
    async run(args) {
      if (!deps.github.enabled()) return fail('尚未连接 GitHub，请先在「GitHub」页配置访问令牌')
      const owner = str('owner', args, { required: true })
      const repo = str('repo', args, { required: true })
      const p = str('path', args, { required: true })
      const ref = str('ref', args) || 'HEAD'
      try {
        const file = await deps.github.readFile(owner, repo, p, ref)
        if (file.binary) return fail(`${p} 是二进制文件`)
        const text = file.text.length > 200_000 ? `${file.text.slice(0, 200_000)}\n…（已截断）` : file.text
        return done(
          `文件 ${p}（ref=${ref}, sha=${file.sha.slice(0, 8)}）：\n${text}`,
          `读取远端 ${p}`
        )
      } catch (e) {
        return fail(String(e instanceof Error ? e.message : e))
      }
    }
  })

  tools.push({
    risk: 'read',
    schema: {
      name: 'gh_search_code',
      description: [
        '在 GitHub 全站按关键词搜索代码（需要连接 GitHub 令牌）。',
        '返回文件路径、所在仓库与链接。用于查找开源参考实现、API 用法示例。'
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索表达式，如 useEffect 或 repo:owner/name useState language:ts'
          },
          max_results: { type: 'number', description: '最多返回多少条，默认 20，最大 100' }
        },
        required: ['query']
      }
    },
    async run(args) {
      if (!deps.github.enabled()) return fail('尚未连接 GitHub，请先在「GitHub」页配置访问令牌')
      const query = str('query', args, { required: true, max: 500 })
      const limit = Math.min(Math.max(Math.floor(num('max_results', args, 20)), 1), 100)
      try {
        const hits = await deps.github.searchCode(query, limit)
        if (!hits.length) return done(`未找到与「${query}」匹配的代码`, `无代码匹配：${query}`)
        const text = hits
          .map((h) => `${h.repo} · ${h.path}${h.url ? `\n  ${h.url}` : ''}`)
          .join('\n')
        return done(
          `GitHub 代码搜索「${query}」命中 ${hits.length} 条：\n${text}`,
          `GitHub 代码搜索：${hits.length} 条`
        )
      } catch (e) {
        return fail(String(e instanceof Error ? e.message : e))
      }
    }
  })

  /* ---------------- GitHub 写 ---------------- */

  tools.push({
    risk: 'remote',
    schema: {
      name: 'gh_commit',
      description: [
        '直接在 GitHub 仓库上提交文件改动，全程走 API，不在本地 clone。',
        '支持一次提交多个文件，整批是原子的（要么全成要么全不成）。',
        '默认应提交到新分支，由用户决定是否开 PR。'
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '仓库所有者' },
          repo: { type: 'string', description: '仓库名' },
          branch: { type: 'string', description: '目标分支名；要开 PR 时填新分支名' },
          base_branch: { type: 'string', description: '基准分支，留空用仓库默认分支' },
          message: { type: 'string', description: '提交信息' },
          files: {
            type: 'string',
            description:
              '要提交的文件，JSON 数组字符串：[{"path":"src/a.ts","content":"..."},{"path":"old.md","delete":true}]'
          },
          open_pr: { type: 'boolean', description: '是否同时创建 PR，默认 false' },
          pr_title: { type: 'string', description: 'PR 标题' },
          pr_body: { type: 'string', description: 'PR 正文' },
          ...SELF_RISK_PROPS
        },
        required: ['owner', 'repo', 'branch', 'message', 'files']
      }
    },
    async run(args, ctx) {
      if (!deps.github.enabled()) return fail('尚未连接 GitHub，请先在「GitHub」页配置访问令牌')

      const owner = str('owner', args, { required: true })
      const repo = str('repo', args, { required: true })
      const branch = str('branch', args, { required: true })
      const message = str('message', args, { required: true, max: 2000 })
      const openPR = bool('open_pr', args, false)

      let parsed: unknown
      try {
        parsed = JSON.parse(str('files', args, { required: true, max: 2_000_000 }))
      } catch {
        return fail('files 参数不是合法 JSON')
      }
      if (!Array.isArray(parsed) || !parsed.length) return fail('files 必须是非空数组')

      const changes: RemoteFileChange[] = []
      for (const item of parsed) {
        const o = item as { path?: unknown; content?: unknown; delete?: unknown }
        if (typeof o.path !== 'string' || !o.path.trim()) return fail('files 中每项都必须有 path')
        changes.push({
          path: o.path.replace(/^\/+/, ''),
          content: typeof o.content === 'string' ? o.content : undefined,
          encoding: 'utf-8',
          delete: o.delete === true
        })
      }

      const denied = await gate(ctx, {
        tool: 'gh_commit',
        risk: 'remote',
        title: `提交到 ${owner}/${repo}@${branch}`,
        detail: [
          `提交信息：${message.split('\n')[0]}`,
          `文件数：${changes.length}`,
          changes
            .slice(0, 12)
            .map((c) => `  ${c.delete ? '删除' : '写入'} ${c.path}`)
            .join('\n'),
          changes.length > 12 ? `  …还有 ${changes.length - 12} 个` : '',
          openPR ? '将同时创建 Pull Request' : '仅推送到分支，不创建 PR'
        ]
          .filter(Boolean)
          .join('\n'),
        selfAssessFrom: args
      })
      if (denied) return denied

      try {
        const res = await deps.github.writeFiles(
          owner,
          repo,
          branch,
          message,
          changes,
          str('base_branch', args) || undefined
        )
        return done(
          `已提交到 ${owner}/${repo} 分支 ${res.branch}，commit ${res.commitSha.slice(0, 8)}${res.commitUrl ? `\n${res.commitUrl}` : ''}`,
          `远端提交 ${res.commitSha.slice(0, 8)} → ${res.branch}`
        )
      } catch (e) {
        return fail(String(e instanceof Error ? e.message : e))
      }
    }
  })

  /* ---------------- PTC 专属：计划确认 ---------------- */

  tools.push({
    // 计划本身不产生副作用，标 read；但 PTC 语义要求"永远先问用户"，
    // 所以这里不走 gate，直接调 requestApproval（full 模式下也照样问）。
    risk: 'read',
    schema: {
      name: 'propose_plan',
      description: [
        '【PTC 模式专用】动工前把分步计划交用户确认：每步一句话 title + 可选 detail。',
        '调用后会弹出确认卡片，用户点"允许"才算确认；被拒绝就换方案，不要重复提交同一计划。',
        '确认前只做只读探查，不要调写工具。'
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'string',
            description: '计划步骤，JSON 数组字符串：[{"title":"第一步做什么","detail":"补充说明"}]，1~20 步'
          }
        },
        required: ['steps']
      }
    },
    async run(args, ctx) {
      let parsed: unknown
      try {
        parsed = JSON.parse(str('steps', args, { required: true, max: 20000 }))
      } catch {
        return fail('steps 参数不是合法 JSON')
      }
      if (!Array.isArray(parsed)) return fail('steps 必须是非空数组')
      let plan
      try {
        plan = setPlan(ctx.runId, parsed as { title?: unknown; detail?: unknown }[])
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
      if (!ctx.requestApproval) return fail('当前环境无法请求确认，计划不能生效')
      const approved = await ctx.requestApproval({
        tool: 'propose_plan',
        title: `计划确认（共 ${plan.steps.length} 步）`,
        detail: `请确认以下计划，确认后我才会动工：\n${formatPlan(plan)}`,
        risk: 'write'
      })
      if (!approved) {
        // 中断/超时与用户点拒绝走的是同一个 false：被中断时别甩锅给用户
        if (ctx.signal.aborted) return fail('任务已停止，计划未确认。如需继续，重新发送需求即可。')
        return fail('用户未确认该计划。请根据情况调整计划重提，或改用只读方式回答。')
      }
      confirmPlan(ctx.runId)
      return done(`计划已确认，共 ${plan.steps.length} 步，开始执行。执行中记得用 update_plan_step 同步进度。`, `计划已确认（${plan.steps.length} 步）`)
    }
  })

  tools.push({
    // 纯本地记账，不碰审批
    risk: 'read',
    schema: {
      name: 'update_plan_step',
      description: '【PTC 模式专用】同步计划进度：标记某一步为 doing/done/blocked，可附一句话进展。序号从 1 开始。',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'number', description: '步骤序号，从 1 开始' },
          status: { type: 'string', description: '新状态', enum: ['todo', 'doing', 'done', 'blocked'] },
          note: { type: 'string', description: '一句话进展说明，可选' }
        },
        required: ['index', 'status']
      }
    },
    async run(args, ctx) {
      const index = Math.floor(num('index', args, NaN))
      const status = str('status', args, { required: true })
      const note = str('note', args, { max: 500 })
      if (!Number.isFinite(index)) return fail('index 必须是数字')
      try {
        const plan = updatePlanStep(
          ctx.runId,
          index,
          status as 'todo' | 'doing' | 'done' | 'blocked',
          note || undefined
        )
        return done(`进度已更新：\n${formatPlan(plan)}`, `第 ${index} 步 → ${status}`)
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    }
  })

  /* ---------------- 子代理 ---------------- */

  tools.push({
    // spawn 本身不产生副作用；子代理内部的有副作用操作仍逐个走 gate（继承同一套审批）。
    // 因此这里标 read：在 smart 模式下派生不需要预审，否则每个子任务都要被审两次。
    risk: 'read',
    schema: {
      name: 'spawn_subagent',
      description: [
        '派生一个子代理去独立完成子任务（如先读多个文件再汇总、先全仓搜索再定位问题），完成后返回文字结论，你根据结论继续干活。',
        '适合"可独立描述、不需要中途插手"的杂活；需要用户确认的危险操作子代理会自己弹窗，不必你代劳。',
        '子代理看不到你的完整上下文，把它需要的前因后果写进 task 与 context。'
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '子任务描述：要做什么、做到什么算完成（必填）' },
          context: { type: 'string', description: '补充背景：相关文件、已查到的信息、注意事项' },
          max_rounds: { type: 'number', description: '子代理最多工具轮数，默认 6，最大 10' }
        },
        required: ['task']
      }
    },
    async run(args, ctx) {
      if (!ctx.spawnSubagent) return fail('当前环境不支持子代理（宿主未注入执行器）')
      const task = str('task', args, { required: true, max: 8000 })
      const context = str('context', args, { max: 20000 })
      const rawRounds = args.max_rounds
      const maxRounds =
        rawRounds == null || rawRounds === ''
          ? 6
          : Math.max(1, Math.min(Math.floor(Number(rawRounds)) || 6, 10))
      try {
        const r = await ctx.spawnSubagent({ goal: task, context, maxRounds })
        return done(`子代理结论：\n${r.text}`, `子代理完成：${task.slice(0, 60)}`)
      } catch (e) {
        return fail(`子代理失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  })

  return tools
}

/**
 * 按聊天模式过滤工具集。
 *
 * - minimal（极简）：只给基础编码能力——读/写/查文件。没有删除、命令、
 *   屏幕、远端、子代理与 PTC 计划工具；超出能力时模型应直说并建议切标准模式。
 * - standard（标准）：原有全部能力，但不含 PTC 专属的计划工具。
 * - ptc：标准全部 + PTC 专属（propose_plan / update_plan_step）。
 */
export const MINIMAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'file_stat',
  'list_dir',
  'read_file',
  'search_code',
  'list_all_files',
  'write_file',
  'move_path',
  'skill_read'
])

export const PTC_TOOL_NAMES: ReadonlySet<string> = new Set(['propose_plan', 'update_plan_step'])

export function toolsForMode(tools: ToolDefinition[], mode: ChatMode): ToolDefinition[] {
  if (mode === 'minimal') return tools.filter((t) => MINIMAL_TOOL_NAMES.has(t.schema.name))
  if (mode === 'ptc') return [...tools]
  return tools.filter((t) => !PTC_TOOL_NAMES.has(t.schema.name))
}

/**
 * 坐标时效性校验：截图太旧就不能再点。
 * 屏幕随时会变，用一张 30 秒前的图定位等于盲点。
 */
const CAPTURE_MAX_AGE_MS = 45_000

function checkFreshness(
  screen: NonNullable<ToolDeps['screen']>,
  failWith: (m: string) => ToolResult
): ToolResult | null {
  const last = screen.lastCapture()
  if (!last) {
    return failWith('还没有截图，无法确定点击位置。请先调用 screen_look 查看屏幕。')
  }
  const age = Date.now() - last.at
  if (age > CAPTURE_MAX_AGE_MS) {
    return failWith(
      `最近一次截图是 ${Math.round(age / 1000)} 秒前的，界面很可能已经变化。请重新调用 screen_look 截图后再操作。`
    )
  }
  return null
}
