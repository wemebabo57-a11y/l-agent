/**
 * 插件宿主。
 *
 * 插件是用户安装的可执行扩展，和 Skill 不同：Skill 只是文本指令，插件可以注册工具和面板。
 * 工具在独立 Node 子进程里执行，主进程按 manifest 的权限白名单转发，不把 Electron、密钥或任意文件访问交给插件。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import type { PluginMeta, PluginPermission, ToolRisk, Workspace } from '@shared/types'
import { dataDir } from '../store'
import { extractZip, isZip, readZip } from '../skills/zip'
import type { ToolContext, ToolDefinition, ToolResult } from '../agent/toolTypes'
import { readSelfAssessment } from '../agent/toolTypes'
import { decide } from '../agent/permissions'
import type { ToolDeps } from '../agent/tools'
import type { ToolSchema } from '../providers/types'

const PLUGIN_PERMISSIONS = new Set<PluginPermission>([
  'workspace.read',
  'workspace.write',
  'network',
  'ui',
  'screen.capture',
  'screen.input',
  'shell'
])
const PLUGIN_RISKS = new Set<ToolRisk>(['read', 'write', 'delete', 'remote', 'shell', 'screen'])

/**
 * 插件权限 → 该插件工具的最低风险等级。
 * 插件的风险由它申请的权限推导，而不是由插件自己声明——
 * 否则插件可以把「执行命令」标成 read 来绕过确认。
 */
function riskFromPermissions(perms: PluginPermission[]): ToolRisk {
  if (perms.includes('shell')) return 'shell'
  if (perms.includes('screen.input') || perms.includes('screen.capture')) return 'screen'
  if (perms.includes('workspace.write')) return 'write'
  if (perms.includes('network')) return 'remote'
  return 'read'
}

const MAX_PLUGIN_BYTES = 8 * 1024 * 1024
const MAX_PLUGIN_FILES = 400
const TOOL_TIMEOUT_MS = 20_000
const MAX_RESULT_CHARS = 24_000

interface PluginManifest {
  name: string
  version: string
  description: string
  main?: string
  permissions: PluginPermission[]
  tools: { name: string; description: string; parameters?: ToolSchema['parameters']; risk?: ToolRisk }[]
  panel?: string
}

interface StoredPlugin extends PluginMeta {
  dirName: string
  main: string | null
  panel: string | null
  toolSchemas: ToolSchema[]
}

export class PluginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginError'
  }
}

function pluginsRoot(): string {
  return path.join(dataDir(), 'plugins')
}

function indexFile(): string {
  return path.join(dataDir(), 'plugins.json')
}

function fail(message: string): ToolResult {
  return { ok: false, content: `操作失败：${message}`, summary: message }
}

function done(content: string, summary: string): ToolResult {
  return { ok: true, content, summary }
}

async function readIndex(): Promise<StoredPlugin[]> {
  try {
    const raw = await fs.readFile(indexFile(), 'utf8')
    const parsed = JSON.parse(raw) as StoredPlugin[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function writeIndex(list: StoredPlugin[]): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true })
  const tmp = `${indexFile()}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
  await fs.rename(tmp, indexFile())
}

function assertId(value: string, label: string): string {
  if (!/^[a-z][a-z0-9_-]{0,40}$/.test(value)) {
    throw new PluginError(`${label} 只能使用小写字母、数字、下划线和连字符，且必须以字母开头`)
  }
  return value
}

function parseManifest(raw: string): PluginManifest {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new PluginError('manifest.json 不是合法 JSON')
  }
  const o = json as Partial<PluginManifest>
  if (!o || typeof o !== 'object') throw new PluginError('manifest.json 格式错误')
  const name = assertId(String(o.name ?? ''), '插件名')
  const version = String(o.version ?? '').trim()
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new PluginError('version 必须是 x.y.z')
  const permissions = Array.isArray(o.permissions) ? o.permissions : []
  for (const p of permissions) {
    if (!PLUGIN_PERMISSIONS.has(p)) throw new PluginError(`不支持的权限：${String(p)}`)
  }
  const tools = Array.isArray(o.tools) ? o.tools : []
  if (tools.length > 12) throw new PluginError('单个插件最多注册 12 个工具')
  const seen = new Set<string>()
  for (const tool of tools) {
    const toolName = assertId(String(tool?.name ?? ''), '工具名')
    if (seen.has(toolName)) throw new PluginError(`工具名重复：${toolName}`)
    seen.add(toolName)
    if (!tool.description || tool.description.length > 500) {
      throw new PluginError(`工具 ${toolName} 缺少说明，或说明超过 500 字`)
    }
  }
  return {
    name,
    version,
    description: String(o.description ?? '').trim().slice(0, 400),
    main: o.main ? String(o.main) : undefined,
    permissions,
    tools: tools.map((tool) => {
      const declared = (tool as { risk?: unknown }).risk
      // 插件可以声明更高的风险，但不能低于其权限推导出的下限
      const floor = riskFromPermissions(permissions)
      const risk = typeof declared === 'string' && PLUGIN_RISKS.has(declared as ToolRisk) ? (declared as ToolRisk) : floor
      return {
        name: String(tool.name),
        description: String(tool.description).trim(),
        parameters: tool.parameters,
        risk: riskRank(risk) >= riskRank(floor) ? risk : floor
      }
    }),
    panel: o.panel ? String(o.panel) : undefined
  }
}

/** 风险等级排序，用于取「更严格」的那个 */
function riskRank(r: ToolRisk): number {
  switch (r) {
    case 'read':
      return 0
    case 'write':
      return 1
    case 'delete':
      return 2
    case 'remote':
      return 3
    case 'shell':
      return 4
    case 'screen':
      return 5
    default:
      return 0
  }
}

function contained(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

async function dirSize(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isSymbolicLink()) throw new PluginError('插件内不允许符号链接')
      if (entry.isDirectory()) await walk(full)
      else {
        files += 1
        bytes += (await fs.stat(full)).size
      }
    }
  }
  await walk(dir)
  return { bytes, files }
}

export class PluginManager {
  async list(): Promise<PluginMeta[]> {
    return (await readIndex()).map(toMeta)
  }

  async importFolder(source: string): Promise<PluginMeta> {
    const stat = await fs.stat(source)
    if (!stat.isDirectory()) throw new PluginError('请选择插件文件夹')
    return this.installFromDir(source, 'folder')
  }

  async importZip(file: string): Promise<PluginMeta> {
    const buf = await fs.readFile(file)
    if (!isZip(buf)) throw new PluginError('不是 ZIP 文件')
    const staging = path.join(pluginsRoot(), `.staging-${randomUUID()}`)
    await fs.mkdir(staging, { recursive: true })
    try {
      extractZip(readZip(buf), staging, { mkdirSync, writeFileSync }, path, {
        maxFiles: MAX_PLUGIN_FILES,
        maxTotalBytes: MAX_PLUGIN_BYTES,
        maxFileBytes: 2 * 1024 * 1024
      })
      return await this.installFromDir(staging, 'zip')
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async installFromDir(source: string, sourceKind: 'folder' | 'zip'): Promise<PluginMeta> {
    const manifestPath = await findManifest(source)
    const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'))
    const sourceRoot = path.dirname(manifestPath)
    const measured = await dirSize(sourceRoot)
    if (measured.files > MAX_PLUGIN_FILES || measured.bytes > MAX_PLUGIN_BYTES) {
      throw new PluginError('插件超过 400 个文件或 8 MB')
    }
    const main = manifest.main ? normalizeInside(sourceRoot, manifest.main, '入口文件') : null
    const panel = manifest.panel ? normalizeInside(sourceRoot, manifest.panel, '面板文件') : null
    if (manifest.tools.length && !main) throw new PluginError('声明了工具就必须提供 main 入口')
    if (panel && !manifest.permissions.includes('ui')) {
      throw new PluginError('提供面板时必须声明 ui 权限')
    }

    const id = manifest.name
    const dirName = `${id}-${randomUUID().slice(0, 8)}`
    const dest = path.join(pluginsRoot(), dirName)
    await fs.mkdir(pluginsRoot(), { recursive: true })
    await fs.cp(sourceRoot, dest, { recursive: true, dereference: false })

    const record: StoredPlugin = {
      id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      enabled: false,
      permissions: manifest.permissions,
      tools: manifest.tools.map((tool) => tool.name),
      toolRisks: Object.fromEntries(manifest.tools.map((tool) => [tool.name, tool.risk ?? riskFromPermissions(manifest.permissions)])),
      hasPanel: Boolean(panel),
      installedAt: Date.now(),
      sizeBytes: measured.bytes,
      source: sourceKind,
      error: null,
      dirName,
      main,
      panel,
      toolSchemas: manifest.tools.map((tool) => ({
        name: `plugin_${id}_${tool.name}`,
        description: `[插件 ${manifest.name}] ${tool.description}`,
        parameters: tool.parameters ?? { type: 'object', properties: {} }
      }))
    }
    const list = (await readIndex()).filter((item) => item.id !== id)
    const previous = (await readIndex()).find((item) => item.id === id)
    list.push(record)
    await writeIndex(list)
    if (previous) await fs.rm(path.join(pluginsRoot(), previous.dirName), { recursive: true, force: true })
    return toMeta(record)
  }

  async toggle(id: string, enabled: boolean): Promise<PluginMeta[]> {
    const list = await readIndex()
    const item = list.find((plugin) => plugin.id === id)
    if (!item) throw new PluginError('插件不存在')
    item.enabled = enabled
    item.error = null
    await writeIndex(list)
    return list.map(toMeta)
  }

  async remove(id: string): Promise<PluginMeta[]> {
    const list = await readIndex()
    const item = list.find((plugin) => plugin.id === id)
    if (!item) throw new PluginError('插件不存在')
    await fs.rm(path.join(pluginsRoot(), item.dirName), { recursive: true, force: true })
    const next = list.filter((plugin) => plugin.id !== id)
    await writeIndex(next)
    return next.map(toMeta)
  }

  async panel(id: string): Promise<{ html: string; permissions: PluginPermission[] }> {
    const item = await requirePlugin(id)
    if (!item.enabled) throw new PluginError('插件未启用')
    if (!item.panel || !item.permissions.includes('ui')) throw new PluginError('这个插件没有面板')
    const file = path.join(pluginsRoot(), item.dirName, item.panel)
    if (!contained(path.join(pluginsRoot(), item.dirName), file)) throw new PluginError('面板路径越界')
    const html = await fs.readFile(file, 'utf8')
    if (html.length > 300_000) throw new PluginError('面板文件超过 300 KB')
    return { html, permissions: item.permissions }
  }

  /**
   * 面板的根目录与入口相对路径，供自定义协议读取。
   *
   * 走协议而不是 srcdoc：srcdoc iframe 会继承宿主页面的 CSP，
   * 而宿主的 script-src 'self' 会挡掉面板里的内联脚本，让面板直接白屏。
   */
  async panelFile(id: string): Promise<{ root: string; entry: string } | null> {
    const item = await requirePlugin(id)
    if (!item.enabled || !item.panel || !item.permissions.includes('ui')) return null
    const root = path.join(pluginsRoot(), item.dirName)
    const entry = path.resolve(root, item.panel)
    if (!contained(root, entry)) return null
    return { root, entry }
  }

  /** 插件在磁盘上的目录，供「打开所在文件夹」使用 */
  async dirOf(id: string): Promise<string> {
    const item = await requirePlugin(id)
    return path.join(pluginsRoot(), item.dirName)
  }

  /**
   * 面板调用。
   *
   * 面板没有 ToolContext，因此不能走工具的审批流；这里改为按插件权限做静态判定：
   * 声明了 workspace.write / shell / screen.* 的插件，其面板方法一律要求用户先确认，
   * 由 IPC 层负责弹窗（canApprove 由调用方传入）。
   */
  async invoke(
    pluginId: string,
    method: string,
    payload: unknown,
    workspace: Workspace | null,
    hooks: {
      allowWrite: boolean
      /** 面板要用的依赖；提供后插件才能在面板里访问工作区 */
      deps?: ToolDeps
      requestApproval?: (req: { title: string; detail: string; risk: ToolRisk }) => Promise<boolean>
    } = { allowWrite: true }
  ): Promise<unknown> {
    const item = await requirePlugin(pluginId)
    if (!item.enabled) throw new PluginError('插件未启用')
    if (!item.permissions.includes('ui')) throw new PluginError('插件没有 ui 权限')
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(method)) throw new PluginError('方法名不合法')

    const risk = riskFromPermissions(item.permissions)
    if (risk !== 'read') {
      if (!hooks.allowWrite && (risk === 'write' || risk === 'delete')) {
        throw new PluginError('写操作已被关闭')
      }
      const approved = await hooks.requestApproval?.({
        title: `插件 ${item.name} 的面板请求调用 ${method}`,
        detail: `插件权限：${item.permissions.join('、')}\n\n参数：\n${JSON.stringify(payload).slice(0, 1000)}`,
        risk
      })
      if (!approved) throw new PluginError('用户拒绝了该插件调用')
    }

    // 面板调用同样要接上宿主桥：否则插件在面板里调 api.readFile 会一直等
    // 一个永远不来的 response，最终被子进程超时杀掉，报错还是"退出码 1"这种看不出原因的形式。
    //
    // 未提供 deps 时不挂桥（onRequest 为 undefined），此时 worker 内部
    // canRequest=false，插件调用 api.readFile 会立刻收到"当前上下文不支持与宿主通信"，
    // 而不是静默挂住——明确失败优于静默超时。
    const deps = hooks.deps
    return callPlugin(
      item,
      'panel',
      { method, payload },
      workspace?.path ?? null,
      deps ? async (request) => handlePluginRequest(item, request, workspace, deps) : undefined
    )
  }

  async toolDefinitions(deps: ToolDeps): Promise<ToolDefinition[]> {
    const enabled = (await readIndex()).filter((plugin) => plugin.enabled && !plugin.error && plugin.main)
    // 与 tools.ts 中注册的内置工具名保持同步，避免插件遮蔽内置能力
    const reserved = new Set([
      'list_dir',
      'read_file',
      'search_code',
      'list_all_files',
      'write_file',
      'shell_run',
      'gh_list_dir',
      'gh_read_file',
      'gh_commit',
      'screen_look',
      'screen_click',
      'screen_type',
      'screen_key',
      'screen_scroll',
      'screen_drag'
    ])
    const out: ToolDefinition[] = []
    for (const plugin of enabled) {
      for (const schema of plugin.toolSchemas) {
        if (reserved.has(schema.name) || out.some((tool) => tool.schema.name === schema.name)) {
          plugin.error = `工具名冲突：${schema.name}`
          continue
        }
        const localName = schema.name.slice(`plugin_${plugin.id}_`.length)
        out.push({
          schema,
          risk: plugin.toolRisks?.[localName] ?? riskFromPermissions(plugin.permissions),
          run: (args, ctx) => runPluginTool(plugin, localName, args, ctx, deps)
        })
      }
    }
    return out
  }
}

function toMeta(plugin: StoredPlugin): PluginMeta {
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    enabled: plugin.enabled,
    permissions: plugin.permissions,
    tools: plugin.tools,
    toolRisks: plugin.toolRisks ?? {},
    hasPanel: plugin.hasPanel,
    installedAt: plugin.installedAt,
    sizeBytes: plugin.sizeBytes,
    source: plugin.source,
    error: plugin.error
  }
}

async function requirePlugin(id: string): Promise<StoredPlugin> {
  const item = (await readIndex()).find((plugin) => plugin.id === id)
  if (!item) throw new PluginError('插件不存在')
  return item
}

async function findManifest(root: string): Promise<string> {
  const direct = path.join(root, 'manifest.json')
  try {
    await fs.access(direct)
    return direct
  } catch {
    const entries = await fs.readdir(root, { withFileTypes: true })
    const visible = entries.filter((entry) => entry.isDirectory() && entry.name !== '__MACOSX' && !entry.name.startsWith('.'))
    if (visible.length === 1) {
      const nested = path.join(root, visible[0].name, 'manifest.json')
      try {
        await fs.access(nested)
        return nested
      } catch {
        /* 继续抛统一错误 */
      }
    }
  }
  throw new PluginError('未找到 manifest.json')
}

function normalizeInside(root: string, rel: string, label: string): string {
  if (rel.includes('\0') || path.isAbsolute(rel)) throw new PluginError(`${label} 路径不合法`)
  const target = path.resolve(root, rel)
  if (!contained(root, target)) throw new PluginError(`${label} 路径越界`)
  return path.relative(root, target).replace(/\\/g, '/')
}

async function runPluginTool(
  plugin: StoredPlugin,
  tool: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  deps: ToolDeps
): Promise<ToolResult> {
  try {
    const risk = plugin.toolRisks?.[tool] ?? riskFromPermissions(plugin.permissions)

    // 插件工具同样走统一权限判定：插件的风险由权限推导，插件无法自降等级
    const decision = decide({
      mode: ctx.permissionMode,
      risk,
      escapesWorkspace: false,
      selfAssessed: readSelfAssessment(args),
      allowWrite: ctx.allowWrite,
      capabilityEnabled: true,
      capabilityLabel: `插件 ${plugin.name}`
    })
    if (decision.action === 'deny') return fail(decision.reason)
    if (decision.action === 'ask') {
      const approved = await ctx.requestApproval?.({
        tool: `plugin_${plugin.id}_${tool}`,
        title: `插件 ${plugin.name} 请求执行 ${tool}`,
        detail: [
          `插件声明的权限：${plugin.permissions.join('、') || '无'}`,
          `本次风险等级：${risk}`,
          decision.reason ? `原因：${decision.reason}` : '',
          '',
          '参数：',
          JSON.stringify(args).slice(0, 1200)
        ]
          .filter(Boolean)
          .join('\n'),
        risk,
        selfAssessed: readSelfAssessment(args)
      })
      if (!approved) return fail('用户拒绝了插件操作')
    }

    const value = await callPlugin(plugin, 'tool', { name: tool, args }, ctx.workspace?.path ?? null, async (request) =>
      // ctx.workspace 在判定阶段已由 requiresWorkspace 保证存在
      handlePluginRequest(plugin, request, (ctx.workspace as Workspace | null) ?? null, deps)
    )
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    return done(text.slice(0, MAX_RESULT_CHARS), `${plugin.name}.${tool}`)
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

interface HostRequest {
  op: 'workspace.read' | 'workspace.write' | 'workspace.search'
  path?: string
  query?: string
  content?: string
}

/**
 * 宿主桥的服务端。
 *
 * 只接受 workspace 而不是整个 ToolContext：面板调用（invoke）没有 ToolContext，
 * 但同样需要桥接能力。两者唯一的共同依赖就是"当前工作区"。
 */
async function handlePluginRequest(
  plugin: StoredPlugin,
  request: HostRequest,
  workspace: Workspace | null,
  deps: ToolDeps
): Promise<unknown> {
  if (!workspace) throw new PluginError('当前没有工作区')
  if (request.op === 'workspace.read' || request.op === 'workspace.search') {
    if (!plugin.permissions.includes('workspace.read') && !plugin.permissions.includes('workspace.write')) {
      throw new PluginError('插件没有读取工作区的权限')
    }
  }
  if (request.op === 'workspace.read') {
    const file = await deps.ws.readFile(workspace, String(request.path ?? ''), 128 * 1024)
    if (file.binary) throw new PluginError('插件不能读取二进制文件')
    return { text: file.text, truncated: file.truncated }
  }
  if (request.op === 'workspace.search') {
    return deps.ws.search(workspace, String(request.query ?? ''), { maxResults: 30 })
  }
  if (request.op === 'workspace.write') {
    if (!plugin.permissions.includes('workspace.write')) throw new PluginError('插件没有写入权限')
    return deps.ws.writeFile(workspace, String(request.path ?? ''), String(request.content ?? ''), {
      createDirs: true
    })
  }
  throw new PluginError('插件请求了未知操作')
}

async function callPlugin(
  plugin: StoredPlugin,
  kind: 'tool' | 'panel',
  input: unknown,
  workspacePath: string | null,
  onRequest?: (request: HostRequest) => Promise<unknown>
): Promise<unknown> {
  if (!plugin.main) throw new PluginError('插件没有可执行入口')
  const entry = path.join(pluginsRoot(), plugin.dirName, plugin.main)
  const root = path.join(pluginsRoot(), plugin.dirName)
  if (!contained(root, entry)) throw new PluginError('插件入口越界')

  // 主进程构建产物是 CJS，__dirname 指向 out/main，worker.mjs 由构建脚本复制到同目录。
  // 但测试会以 ESM 直接 import 本模块，那时没有 __dirname。
  // 两种形态都解析到"本文件所在目录"，worker.mjs 始终与之一同分发。
  const here =
    typeof __dirname === 'string' ? __dirname : path.dirname(fileURLToPath(import.meta.url))
  const worker = path.join(here, 'worker.mjs')

  /**
   * 关键：Electron 主进程里的 process.execPath 是 Electron 本体而非 node。
   * 不设 ELECTRON_RUN_AS_NODE 就会再拉起一个 Electron 实例并弹窗口。
   */
  const execArgs = entry.endsWith('.ts') ? ['--experimental-strip-types', worker] : [worker]

  const child = spawn(process.execPath, execArgs, {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      TEMP: process.env.TEMP ?? '',
      TMP: process.env.TMP ?? '',
      ELECTRON_RUN_AS_NODE: '1',
      LAGENT_PLUGIN_ENTRY: pathToFileURL(entry).href,
      LAGENT_PLUGIN_KIND: kind,
      LAGENT_PLUGIN_PERMISSIONS: plugin.permissions.join(',')
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })

  const done = new Promise<unknown>((resolve, reject) => {
    let stderr = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(() => reject(new PluginError(`插件执行超时（${TOOL_TIMEOUT_MS / 1000} 秒）`)))
    }, TOOL_TIMEOUT_MS)

    /**
     * stdout 是双向协议通道：既是 host 请求的来源，也是最终结果。
     * 因此按行解析，把 {type:'request'} 交给桥接处理，其余行累积为最终结果。
     */
    let resultBuffer = ''
    let lineBuffer = ''
    const onStdout = (chunk: string): void => {
      lineBuffer += chunk
      for (;;) {
        const nl = lineBuffer.indexOf('\n')
        if (nl < 0) break
        const line = lineBuffer.slice(0, nl).trim()
        lineBuffer = lineBuffer.slice(nl + 1)
        if (!line) continue

        let parsed: { type?: string; id?: number; op?: string; path?: string; query?: string; content?: string }
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }

        // host 请求：转发给宿主并把结果写回插件 stdin
        if (parsed.type === 'request' && parsed.id != null && onRequest) {
          void onRequest({
            op: (parsed.op ?? '') as HostRequest['op'],
            path: parsed.path,
            query: parsed.query,
            content: parsed.content
          })
            .then((value) => {
              child.stdin.write(`${JSON.stringify({ type: 'response', id: parsed.id, value })}\n`)
            })
            .catch((e: unknown) => {
              child.stdin.write(
                `${JSON.stringify({
                  type: 'response',
                  id: parsed.id,
                  error: e instanceof Error ? e.message : String(e)
                })}\n`
              )
            })
          continue
        }

        // 其余行视为最终结果
        resultBuffer += `${line}\n`
        if (resultBuffer.length > MAX_RESULT_CHARS * 2) {
          child.kill()
          finish(() => reject(new PluginError('插件输出过大')))
        }
      }
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', onStdout)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk.slice(0, 2000)
    })
    child.on('error', (error) => {
      finish(() => reject(error))
    })
    child.on('exit', (code) => {
      finish(() => {
        // 退出前可能还有半行未换行的结果
        const tail = lineBuffer.trim()
        if (tail) resultBuffer += `${tail}\n`

        /**
         * 结果优先级：stdout 的结构化载荷 > stderr > 退出码。
         *
         * worker 在插件抛异常时会先往 stdout 写 {ok:false,error} 再以 1 退出。
         * 若先看退出码就 reject，真实错误会被"插件退出码 1"盖掉——插件作者
         * 看不到自己代码的任何报错信息。所以先尝试解析 stdout。
         */
        let parsed: { ok?: boolean; value?: unknown; error?: string } | null = null
        const raw = resultBuffer.trim()
        if (raw) {
          try {
            parsed = JSON.parse(raw) as { ok?: boolean; value?: unknown; error?: string }
          } catch {
            parsed = null
          }
        }

        if (parsed) {
          if (!parsed.ok) reject(new PluginError(parsed.error || '插件执行失败'))
          else resolve(parsed.value)
          return
        }

        // stdout 没有可解析载荷：只能靠 stderr 与退出码判断
        if (code !== 0) {
          reject(new PluginError(stderr.trim() || `插件退出码 ${code ?? '未知'}`))
          return
        }
        reject(new PluginError(stderr.trim() || '插件没有返回合法结果'))
      })
    })
  })

  // 主进程先发启动请求，随后插件可能继续发 host 请求，因此 stdin 保持可写直到结束
  child.stdin.write(`${JSON.stringify({ input, workspacePath, canRequest: Boolean(onRequest) })}\n`)

  try {
    return await done
  } finally {
    child.stdin.end()
  }
}
