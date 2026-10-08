import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FileContent, FileNode, SearchHit, Workspace } from '@shared/types'

/** 单个目录最多列出的子项，避免超大目录卡死渲染 */
const MAX_ENTRIES_PER_DIR = 2000
/** 文件树最大深度，防止 node_modules 类深井 */
const MAX_DEPTH = 12
/** 搜索时单文件读取上限 */
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

/**
 * 路径安全核心：把用户/模型给的相对路径解析为绝对路径，
 * 并确认它没有逃出工作区根目录（含 ../ 与符号链接穿越）。
 *
 * 关键行为：绝对路径一律拒绝，而不是"剥掉前导斜杠后当相对路径用"。
 * 后者虽然最终仍落在工作区内（不会越界），但会静默改变调用者的语义：
 * 请求 /etc/passwd 却读到了 <ws>/etc/passwd，属于危险的意外行为。
 */
export function safeResolve(root: string, relative: string): string {
  if (typeof relative !== 'string') throw new WorkspaceError('路径必须是字符串')
  if (relative.includes('\0')) throw new WorkspaceError('路径包含非法字符')

  const normalizedRoot = path.resolve(root)
  const unified = relative.replace(/\\/g, '/')

  // 拒绝绝对路径：POSIX 风格（/x）、Windows 盘符（C:/x）、UNC（//server/share）
  if (unified.startsWith('/') || /^[a-zA-Z]:\//.test(unified)) {
    throw new WorkspaceError(`不接受绝对路径，请提供相对工作区根目录的路径：${relative}`)
  }

  const cleaned = unified.replace(/^\.\/+/, '')
  const target = path.resolve(normalizedRoot, cleaned)

  const rel = path.relative(normalizedRoot, target)
  if (rel === '') return normalizedRoot
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new WorkspaceError(`路径越界，拒绝访问工作区外的位置：${relative}`)
  }
  return target
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

export function relativeTo(root: string, absolute: string): string {
  return toPosix(path.relative(path.resolve(root), path.resolve(absolute)))
}

function shouldIgnore(name: string, ignore: Set<string>): boolean {
  return ignore.has(name)
}

/** 是否为二进制内容（存在 NUL 字节即判定为二进制） */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export class WorkspaceManager {
  /**
   * 注意：这里显式声明并赋值，而不是用 TS 参数属性语法。
   * 参数属性在 Node 的 --experimental-strip-types（strip-only）模式下不被支持，
   * 而 scripts/unit.mjs 需要直接 import 本模块来测试安全关键逻辑。
   */
  private readonly ignoreDefaults: string[]

  constructor(ignoreDefaults: string[]) {
    this.ignoreDefaults = ignoreDefaults
  }

  private effectiveIgnore(ws: Workspace): Set<string> {
    return new Set([...this.ignoreDefaults, ...(ws.ignore ?? [])].filter(Boolean))
  }

  /** 校验工作区目录仍然存在且可读 */
  async assertUsable(ws: Workspace): Promise<void> {
    try {
      const st = await fs.stat(ws.path)
      if (!st.isDirectory()) throw new WorkspaceError(`工作区路径不是目录：${ws.path}`)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new WorkspaceError(`工作区目录不存在或已被移动：${ws.path}`)
      }
      throw e
    }
  }

  /** 列出目录（懒加载：只列一层，由 UI 决定何时展开下一层） */
  async listDir(ws: Workspace, relDir: string, depth = 1): Promise<FileNode[]> {
    await this.assertUsable(ws)
    const ignore = this.effectiveIgnore(ws)
    const absDir = safeResolve(ws.path, relDir)
    const st = await fs.stat(absDir)
    if (!st.isDirectory()) throw new WorkspaceError(`${relDir} 不是目录`)

    const entries = await fs.readdir(absDir, { withFileTypes: true })
    const nodes: FileNode[] = []

    for (const entry of entries.slice(0, MAX_ENTRIES_PER_DIR)) {
      if (entry.isSymbolicLink()) continue // 不跟随符号链接，避免越界
      const abs = path.join(absDir, entry.name)
      const rel = relativeTo(ws.path, abs)
      let size = 0
      let modifiedAt = 0
      try {
        const s = await fs.stat(abs)
        size = s.size
        modifiedAt = s.mtimeMs
      } catch {
        continue // 权限不足等，跳过
      }
      const node: FileNode = {
        path: rel,
        name: entry.name,
        isDir: entry.isDirectory(),
        size,
        modifiedAt,
        ignored: shouldIgnore(entry.name, ignore)
      }
      if (node.isDir && depth > 1 && !node.ignored && depth <= MAX_DEPTH) {
        try {
          node.children = await this.listDir(ws, rel, depth - 1)
        } catch {
          node.children = []
        }
      }
      nodes.push(node)
    }

    // 目录在前，同类按名称排序
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-CN')
    })
    return nodes
  }

  /** 递归收集所有文件相对路径（供"注入文件树摘要"使用） */
  async collectFiles(ws: Workspace, limit = 400): Promise<string[]> {
    const ignore = this.effectiveIgnore(ws)
    const out: string[] = []
    const walk = async (relDir: string, depth: number): Promise<void> => {
      if (out.length >= limit || depth > MAX_DEPTH) return
      let entries
      try {
        entries = await fs.readdir(safeResolve(ws.path, relDir), { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (out.length >= limit) return
        if (e.isSymbolicLink()) continue
        if (e.isDirectory() && shouldIgnore(e.name, ignore)) continue
        const rel = relDir ? `${relDir}/${e.name}` : e.name
        if (e.isDirectory()) await walk(rel, depth + 1)
        else out.push(rel)
      }
    }
    await walk('', 0)
    return out
  }

  async readFile(ws: Workspace, relPath: string, maxBytes: number): Promise<FileContent> {
    const abs = safeResolve(ws.path, relPath)
    const st = await fs.stat(abs)
    if (st.isDirectory()) throw new WorkspaceError(`${relPath} 是目录，不能当作文件读取`)

    const truncated = st.size > maxBytes
    const handle = await fs.open(abs, 'r')
    try {
      const length = truncated ? maxBytes : st.size
      const buf = Buffer.alloc(Number(length))
      const { bytesRead } = await handle.read(buf, 0, length, 0)
      const slice = buf.subarray(0, bytesRead)
      if (looksBinary(slice)) {
        return {
          path: relPath,
          text: '',
          size: st.size,
          modifiedAt: st.mtimeMs,
          truncated: false,
          binary: true
        }
      }
      return {
        path: relPath,
        text: slice.toString('utf8'),
        size: st.size,
        modifiedAt: st.mtimeMs,
        truncated,
        binary: false
      }
    } finally {
      await handle.close()
    }
  }

  async writeFile(
    ws: Workspace,
    relPath: string,
    text: string,
    options: { createDirs?: boolean; append?: boolean } = {}
  ): Promise<{ size: number; created: boolean }> {
    const abs = safeResolve(ws.path, relPath)
    if (options.createDirs !== false) {
      await fs.mkdir(path.dirname(abs), { recursive: true })
    }
    let created = true
    try {
      await fs.access(abs)
      created = false
    } catch {
      /* 不存在，即新建 */
    }
    if (options.append) await fs.appendFile(abs, text, 'utf8')
    else await fs.writeFile(abs, text, 'utf8')
    const st = await fs.stat(abs)
    return { size: st.size, created }
  }

  /** 全文搜索：逐文件按行匹配正则，带结果上限 */
  async search(
    ws: Workspace,
    query: string,
    opts: { maxResults?: number; caseSensitive?: boolean; regex?: boolean } = {}
  ): Promise<SearchHit[]> {
    const maxResults = opts.maxResults ?? 200
    if (!query) throw new WorkspaceError('搜索内容不能为空')

    let matcher: RegExp
    if (opts.regex) {
      matcher = new RegExp(query, opts.caseSensitive ? 'g' : 'gi')
    } else {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      matcher = new RegExp(escaped, opts.caseSensitive ? 'g' : 'gi')
    }

    const ignore = this.effectiveIgnore(ws)
    const hits: SearchHit[] = []

    const walk = async (relDir: string, depth: number): Promise<void> => {
      if (hits.length >= maxResults || depth > MAX_DEPTH) return
      let entries
      try {
        entries = await fs.readdir(safeResolve(ws.path, relDir), { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (hits.length >= maxResults) return
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          if (shouldIgnore(entry.name, ignore)) continue
          const rel = relDir ? `${relDir}/${entry.name}` : entry.name
          await walk(rel, depth + 1)
          continue
        }
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name
        let buf: Buffer
        try {
          const st = await fs.stat(safeResolve(ws.path, rel))
          if (st.size > MAX_SEARCH_FILE_BYTES) continue
          buf = await fs.readFile(safeResolve(ws.path, rel))
        } catch {
          continue
        }
        if (looksBinary(buf)) continue
        const lines = buf.toString('utf8').split(/\r?\n/)
        const fileMatches: SearchHit['matches'] = []
        for (let i = 0; i < lines.length && hits.length + fileMatches.length < maxResults; i++) {
          const line = lines[i]
          if (line.length > 4000) continue // 压缩过的超大行跳过
          matcher.lastIndex = 0
          const m = matcher.exec(line)
          if (m) {
            fileMatches.push({ line: i + 1, text: line.slice(0, 500), column: m.index + 1 })
          }
        }
        if (fileMatches.length) hits.push({ path: rel, matches: fileMatches })
      }
    }

    await walk('', 0)
    return hits
  }

  /** 查看单个路径的元信息（类型、大小、修改时间），只读不落地 */
  async stat(ws: Workspace, relPath: string): Promise<FileNode> {
    const abs = safeResolve(ws.path, relPath)
    const st = await fs.lstat(abs)
    const name = path.basename(abs)
    const node: FileNode = {
      path: toPosix(relPath) || '.',
      name,
      isDir: st.isDirectory(),
      size: st.size,
      modifiedAt: st.mtimeMs
    }
    return node
  }

  /**
   * 移动/重命名。from/to 都经 safeResolve 校验（不越界）；
   * 拒绝把工作区根目录当 from/to，避免把整个工作区改名或覆盖掉。
   * 目标父目录不存在时自动创建；目标已存在时由 fs.rename 决定（文件被覆盖，目录报错）。
   */
  async move(ws: Workspace, from: string, to: string): Promise<void> {
    const src = safeResolve(ws.path, from)
    const dst = safeResolve(ws.path, to)
    const root = path.resolve(ws.path)
    if (src === root) throw new WorkspaceError('不能移动工作区根目录')
    if (dst === root) throw new WorkspaceError('目标不能是工作区根目录')
    if (src === dst) return
    // 目标已存在时 fs.rename 在 Windows 上对文件是替换、对目录是报错；
    // 交给底层决定，失败时抛出清晰错误。
    await fs.mkdir(path.dirname(dst), { recursive: true })
    try {
      await fs.rename(src, dst)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EEXIST' || code === 'EPERM') {
        throw new WorkspaceError(`目标已存在，无法覆盖：${to}`)
      }
      throw e
    }
  }

  /** 删除文件或目录（递归）。拒绝删除工作区根目录。 */
  async remove(ws: Workspace, relPath: string): Promise<{ path: string; isDir: boolean }> {
    const abs = safeResolve(ws.path, relPath)
    const root = path.resolve(ws.path)
    if (abs === root) throw new WorkspaceError('不能删除工作区根目录')
    const st = await fs.lstat(abs)
    if (st.isDirectory()) {
      await fs.rm(abs, { recursive: true, force: false })
    } else {
      await fs.rm(abs, { force: false })
    }
    return { path: toPosix(relPath), isDir: st.isDirectory() }
  }
}
