import { promises as fs } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { dataDir } from '../store'
import { extractZip, isZip, readZip, ZipError } from './zip'
import { parseSkillMarkdown, pickEntry as pickEntryFrom } from './frontmatter'
import { findSkillRoots, parseSkillRepoUrl, stripZipRoot } from './repo'
import type { ParsedSkill } from './frontmatter'
import type { SkillImportRepoResult, SkillMeta, SkillRepoOrigin, SkillSyncResult } from '@shared/types'

/** 单个 skill 目录体积上限 */
const MAX_SKILL_BYTES = 32 * 1024 * 1024
const MAX_SKILL_FILES = 2000

export { parseSkillMarkdown }
export type { ParsedSkill } from './frontmatter'

/** 远端 zipball 下载上限（仓库整包，含历史无关文件，卡紧一点） */
const MAX_REPO_ZIP_BYTES = 64 * 1024 * 1024
const FETCH_TIMEOUT_MS = 60_000

export class SkillError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillError'
  }
}

/** 入口挑选：统一包一层，把纯函数的 Error 转成 SkillError */
async function pickEntry(files: string[]): Promise<string> {
  try {
    return await pickEntryFrom(files)
  } catch (e) {
    throw new SkillError((e as Error).message)
  }
}

/* ------------------------------------------------------------------ */
/* 元数据持久化                                                        */
/* ------------------------------------------------------------------ */

type StoredSkill = SkillMeta

function skillsRoot(): string {
  return path.join(dataDir(), 'skills')
}

function metaFile(): string {
  return path.join(dataDir(), 'skills.json')
}

async function readMeta(): Promise<StoredSkill[]> {
  try {
    return JSON.parse(await fs.readFile(metaFile(), 'utf8')) as StoredSkill[]
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    return []
  }
}

async function writeMeta(list: StoredSkill[]): Promise<void> {
  await fs.mkdir(path.dirname(metaFile()), { recursive: true })
  const tmp = `${metaFile()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
  await fs.rename(tmp, metaFile())
}

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'skill'
}

async function ensureUniqueId(base: string, existing: StoredSkill[]): Promise<string> {
  let id = slugify(base)
  let n = 2
  while (existing.some((s) => s.id === id)) {
    id = `${slugify(base)}-${n++}`
  }
  return id
}

/** 递归统计目录体积与文件列表 */
async function scanDir(
  root: string,
  rel = '',
  acc: { files: string[]; bytes: number } = { files: [], bytes: 0 },
  depth = 0
): Promise<{ files: string[]; bytes: number }> {
  if (depth > 8 || acc.files.length > MAX_SKILL_FILES || acc.bytes > MAX_SKILL_BYTES) return acc
  let entries
  try {
    entries = await fs.readdir(path.join(root, rel), { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue
    const relPath = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      await scanDir(root, relPath, acc, depth + 1)
    } else {
      let size = 0
      try {
        size = (await fs.stat(path.join(root, relPath))).size
      } catch {
        continue
      }
      acc.files.push(relPath)
      acc.bytes += size
    }
  }
  return acc
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const e of entries) {
    if (e.isSymbolicLink()) continue
    const s = path.join(src, e.name)
    const d = path.join(dest, e.name)
    if (e.isDirectory()) await copyDir(s, d)
    else await fs.copyFile(s, d)
  }
}

/** 导入后统一"拍平"：若解压结果只有单一顶层目录，则将其内容提升为根 */
async function flattenSingleRoot(dir: string): Promise<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const visible = entries.filter((e) => e.name !== '__MACOSX' && !e.name.startsWith('.'))
  if (visible.length === 1 && visible[0].isDirectory()) {
    const inner = path.join(dir, visible[0].name)
    return inner
  }
  return dir
}

export class SkillManager {
  async list(): Promise<SkillMeta[]> {
    const metas = await readMeta()
    // 过滤掉磁盘上已被手工删除的目录，避免 UI 出现幽灵条目
    const alive: StoredSkill[] = []
    for (const m of metas) {
      try {
        await fs.access(m.dir)
        alive.push(m)
      } catch {
        /* 已不存在，丢弃 */
      }
    }
    if (alive.length !== metas.length) await writeMeta(alive)
    return alive.map(({ ...rest }) => rest).sort((a, b) => b.installedAt - a.installedAt)
  }

  /** 从本地文件夹导入（用户选择的目录会被完整复制到应用数据区） */
  async importFolder(srcDir: string): Promise<SkillMeta> {
    const st = await fs.stat(srcDir)
    if (!st.isDirectory()) throw new SkillError('请选择一个文件夹')

    const scanned = await scanDir(srcDir)
    if (!scanned.files.length) throw new SkillError('该文件夹是空的')
    if (scanned.bytes > MAX_SKILL_BYTES) {
      throw new SkillError(`文件夹体积 ${(scanned.bytes / 1048576).toFixed(1)}MB 超过上限 32MB`)
    }

    const existing = await readMeta()
    const entry = await pickEntry(scanned.files)
    const rawText = await fs.readFile(path.join(srcDir, entry), 'utf8').catch(() => '')
    const parsed = parseSkillMarkdown(rawText)
    const id = await ensureUniqueId(parsed.name ?? path.basename(srcDir), existing)
    const dest = path.join(skillsRoot(), id)

    await fs.rm(dest, { recursive: true, force: true })
    await copyDir(srcDir, dest)

    return this.persist({
      id,
      name: parsed.name ?? path.basename(srcDir),
      description: parsed.description,
      source: 'folder',
      dir: dest,
      entry,
      resources: scanned.files.filter((f) => f !== entry),
      enabled: true,
      sizeBytes: scanned.bytes,
      installedAt: Date.now(),
      extra: parsed.extra
    })
  }

  /** 从若干本地文件导入；若含 zip 则解压 */
  async importFiles(filePaths: string[]): Promise<SkillMeta[]> {
    if (!filePaths.length) throw new SkillError('未选择任何文件')
    const out: SkillMeta[] = []
    // zip 与其他文件分开处理：一个 zip 产生一个 skill，md 各自成为一个 skill
    for (const fp of filePaths) {
      const st = await fs.stat(fp)
      if (st.isDirectory()) {
        out.push(await this.importFolder(fp))
        continue
      }
      const buf = await fs.readFile(fp)
      if (isZip(buf)) {
        out.push(await this.importZipBuffer(buf, path.basename(fp, path.extname(fp))))
        continue
      }
      if (/\.(md|markdown|txt)$/i.test(fp)) {
        out.push(await this.importSingleFile(fp, buf.toString('utf8')))
        continue
      }
      throw new SkillError(`不支持的文件类型：${path.basename(fp)}（仅支持 .md/.markdown/.txt/.zip 或文件夹）`)
    }
    return out
  }

  async importZip(filePath: string): Promise<SkillMeta> {
    const buf = await fs.readFile(filePath)
    if (!isZip(buf)) throw new SkillError('该文件不是有效的 zip 压缩包')
    return this.importZipBuffer(buf, path.basename(filePath, path.extname(filePath)))
  }

  private async importZipBuffer(buf: Buffer, fallbackName: string): Promise<SkillMeta> {
    let entries
    try {
      entries = readZip(buf)
    } catch (e) {
      if (e instanceof ZipError) throw new SkillError(e.message)
      throw e
    }

    const existing = await readMeta()
    const tempName = `tmp-${Date.now().toString(36)}`
    const tempDir = path.join(skillsRoot(), tempName)
    await fs.rm(tempDir, { recursive: true, force: true })
    mkdirSync(tempDir, { recursive: true })

    try {
      const { files, totalBytes } = extractZip(
        entries,
        tempDir,
        { mkdirSync, writeFileSync },
        path
      )
      if (!files.length) throw new SkillError('压缩包内没有文件')

      // 拍平：zip 常见单层包裹（<name>/SKILL.md），拍平后 entry 才是相对根的路径
      const flatDir = await flattenSingleRoot(tempDir)

      // 关键：入口必须相对拍平后的目录重新计算，否则存进 dest 后路径会指向不存在的子目录
      const flatScan = await scanDir(flatDir)
      if (!flatScan.files.length) throw new SkillError('压缩包内没有文件')
      const entry = await pickEntry(flatScan.files)

      const rawText = await fs.readFile(path.join(flatDir, entry), 'utf8').catch(() => '')
      const parsed = parseSkillMarkdown(rawText)
      const id = await ensureUniqueId(parsed.name ?? fallbackName, existing)
      const dest = path.join(skillsRoot(), id)

      await fs.rm(dest, { recursive: true, force: true })
      // 把拍平后的目录整体搬到最终位置；跨设备时 rename 会失败，回落到复制
      await fs.rename(flatDir, dest).catch(async () => {
        await copyDir(flatDir, dest)
      })

      const scanned = await scanDir(dest)
      return await this.persist({
        id,
        name: parsed.name ?? fallbackName,
        description: parsed.description,
        source: 'zip',
        dir: dest,
        entry,
        resources: scanned.files.filter((f) => f !== entry),
        enabled: true,
        // totalBytes 是解压后的实际体积，比压缩包大小更有参考意义
        sizeBytes: scanned.bytes || totalBytes,
        installedAt: Date.now(),
        extra: parsed.extra
      })
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async importSingleFile(filePath: string, text: string): Promise<SkillMeta> {
    const existing = await readMeta()
    const parsed = parseSkillMarkdown(text)
    const stem = path.basename(filePath, path.extname(filePath))
    const id = await ensureUniqueId(parsed.name ?? stem, existing)
    const dest = path.join(skillsRoot(), id)
    await fs.rm(dest, { recursive: true, force: true })
    await fs.mkdir(dest, { recursive: true })
    const entryName = 'SKILL.md'
    await fs.copyFile(filePath, path.join(dest, entryName))
    const stat = await fs.stat(path.join(dest, entryName))

    return this.persist({
      id,
      name: parsed.name ?? stem,
      description: parsed.description,
      source: 'file',
      dir: dest,
      entry: entryName,
      resources: [],
      enabled: true,
      sizeBytes: stat.size,
      installedAt: Date.now(),
      extra: parsed.extra
    })
  }

  private async persist(meta: SkillMeta): Promise<SkillMeta> {
    const list = await readMeta()
    const idx = list.findIndex((s) => s.id === meta.id)
    if (idx >= 0) list[idx] = meta
    else list.push(meta)
    await writeMeta(list)
    return meta
  }

  async toggle(id: string, enabled: boolean): Promise<SkillMeta[]> {
    const list = await readMeta()
    const hit = list.find((s) => s.id === id)
    if (!hit) throw new SkillError(`未找到 skill：${id}`)
    hit.enabled = enabled
    await writeMeta(list)
    return list
  }

  async remove(id: string): Promise<SkillMeta[]> {
    const list = await readMeta()
    const hit = list.find((s) => s.id === id)
    if (hit) {
      await fs.rm(hit.dir, { recursive: true, force: true })
    }
    const next = list.filter((s) => s.id !== id)
    await writeMeta(next)
    return next
  }

  /** 读取 skill 正文（供 UI 预览与注入上下文） */
  async read(id: string, maxBytes = 64 * 1024): Promise<{ meta: SkillMeta; text: string }> {
    const list = await readMeta()
    const meta = list.find((s) => s.id === id)
    if (!meta) throw new SkillError(`未找到 skill：${id}`)
    const abs = path.join(meta.dir, meta.entry)
    const st = await fs.stat(abs).catch(() => null)
    if (!st) throw new SkillError(`入口文件已丢失：${meta.entry}`)
    const buf = await fs.readFile(abs)
    const truncated = buf.length > maxBytes
    return { meta, text: buf.subarray(0, maxBytes).toString('utf8') + (truncated ? '\n…（已截断）' : '') }
  }

  /** 读取 skill 目录内的资源文件（供 skill_read 工具与面板使用，严格限制在目录内） */
  async readResource(id: string, rel: string, maxBytes = 200 * 1024): Promise<string> {
    const list = await readMeta()
    const meta = list.find((s) => s.id === id)
    if (!meta) throw new SkillError(`未找到 skill：${id}`)
    const clean = rel.replace(/\\/g, '/').trim().replace(/^\/+/, '')
    if (!clean || clean.split('/').some((s) => s === '..' || s === '.' || s === '')) {
      throw new SkillError('资源路径不合法')
    }
    const abs = path.resolve(meta.dir, clean)
    const relCheck = path.relative(meta.dir, abs)
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) throw new SkillError('资源路径越界')
    const buf = await fs.readFile(abs).catch(() => null)
    if (!buf) throw new SkillError(`资源不存在：${clean}`)
    const truncated = buf.length > maxBytes
    return buf.subarray(0, maxBytes).toString('utf8') + (truncated ? '\n…（已截断）' : '')
  }

  /**
   * 从远端仓库链接导入 skill（公开仓库，无需令牌）。
   * 流程：解析链接 → 取默认分支 → 下载 zipball → 按 skill 根拆分 → 逐个落盘。
   * 私有仓库会明确报错，不静默产出空结果。
   */
  async importRepo(url: string): Promise<SkillImportRepoResult> {
    const raw = url.trim()
    let target: ReturnType<typeof parseSkillRepoUrl>
    try {
      target = parseSkillRepoUrl(raw)
    } catch (e) {
      throw new SkillError((e as Error).message)
    }
    const { staged, warnings } = await fetchAndStage(target)
    const existing = await readMeta()
    const imported: SkillMeta[] = []
    for (const s of staged) {
      const fallback = target.path?.split('/').pop() || target.repo
      const id = await ensureUniqueId(s.parsed.name ?? fallback, [...existing, ...imported])
      const dest = path.join(skillsRoot(), id)
      await fs.mkdir(dest, { recursive: true })
      for (const f of s.files) {
        const abs = path.join(dest, f.path)
        await fs.mkdir(path.dirname(abs), { recursive: true })
        await fs.writeFile(abs, f.data)
      }
      const meta: SkillMeta = {
        id,
        name: s.parsed.name ?? fallback,
        description: s.parsed.description,
        source: 'repo',
        dir: dest,
        entry: s.entry,
        resources: s.files.map((f) => f.path).filter((f) => f !== s.entry),
        enabled: true,
        sizeBytes: s.bytes,
        installedAt: Date.now(),
        extra: s.parsed.extra,
        origin: {
          url: raw,
          owner: target.owner,
          repo: target.repo,
          ref: target.ref,
          path: target.path
        } satisfies SkillRepoOrigin
      }
      const list = await readMeta()
      list.push(meta)
      await writeMeta(list)
      imported.push(meta)
    }
    return { imported, warnings }
  }

  /** 把一个远端 skill 同步到上游最新版。内容一致时不碰磁盘，返回 changed=false */
  async sync(id: string): Promise<SkillSyncResult> {
    const list = await readMeta()
    const meta = list.find((s) => s.id === id)
    if (!meta) throw new SkillError(`未找到 skill：${id}`)
    if (!meta.origin) throw new SkillError('该 skill 不是从仓库导入的，无法同步')
    let target: ReturnType<typeof parseSkillRepoUrl>
    try {
      target = parseSkillRepoUrl(meta.origin.url)
    } catch (e) {
      throw new SkillError((e as Error).message)
    }
    const { staged } = await fetchAndStage(target)
    if (!staged.length) throw new SkillError('上游已没有可导入的 skill（路径被删或结构变化）')
    // origin.path 为 null 时取唯一 root；多 root 则取与当初相同的那一个
    const want = meta.origin.path ?? ''
    const hit = staged.length === 1 ? staged[0] : staged.find((s) => s.rootRel === want)
    if (!hit) throw new SkillError('上游结构变化，找不到当初导入的那个 skill 目录')
    const disk = await scanDir(meta.dir)
    const diskSet = new Set(disk.files)
    const stagedSet = new Set(hit.files.map((f) => f.path))
    let same =
      diskSet.size === stagedSet.size && [...diskSet].every((f) => stagedSet.has(f))
    if (same) {
      for (const f of hit.files) {
        const buf = await fs.readFile(path.join(meta.dir, f.path)).catch(() => null)
        if (!buf || !buf.equals(f.data)) {
          same = false
          break
        }
      }
    }
    if (same) return { changed: false, meta }
    await fs.rm(meta.dir, { recursive: true, force: true })
    await fs.mkdir(meta.dir, { recursive: true })
    for (const f of hit.files) {
      const abs = path.join(meta.dir, f.path)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, f.data)
    }
    meta.entry = hit.entry
    meta.resources = hit.files.map((f) => f.path).filter((f) => f !== hit.entry)
    meta.sizeBytes = hit.bytes
    meta.name = hit.parsed.name ?? meta.name
    meta.description = hit.parsed.description
    meta.extra = hit.parsed.extra
    await writeMeta(list)
    return { changed: true, meta }
  }

  /** 启用的 skill 会被注入到系统提示词；返回精简后的指令文本 */
  async enabledInstructions(maxTotalBytes = 32 * 1024): Promise<string[]> {
    const list = (await this.list()).filter((s) => s.enabled)
    const out: string[] = []
    let total = 0
    for (const meta of list) {
      try {
        const { text } = await this.read(meta.id, 8 * 1024)
        const block = `### Skill: ${meta.name}\n${meta.description ? `${meta.description}\n` : ''}${text}`
        if (total + block.length > maxTotalBytes) break
        total += block.length
        out.push(block)
      } catch {
        /* 单个 skill 读取失败不影响其他 */
      }
    }
    return out
  }
}

interface StagedSkill {
  /** 在仓库内的 skill 根相对路径（'' 表示仓库根） */
  rootRel: string
  /** 相对 skill 根的文件 */
  files: { path: string; data: Buffer }[]
  entry: string
  parsed: ParsedSkill
  bytes: number
}

/** 无令牌取仓库默认分支。私有仓库/不存在/限流都明确报错 */
async function fetchDefaultBranch(owner: string, repo: string): Promise<string> {
  let res: Response
  try {
    res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(20_000)
    })
  } catch {
    throw new SkillError('连接 GitHub 失败，请检查网络后重试')
  }
  if (res.status === 404) throw new SkillError('仓库不存在或为私有仓库（只支持公开仓库免令牌导入）')
  if (res.status === 403) throw new SkillError('GitHub API 限流，请稍后再试')
  if (!res.ok) throw new SkillError(`获取仓库信息失败：HTTP ${res.status}`)
  const json = (await res.json()) as { default_branch?: unknown }
  if (typeof json.default_branch !== 'string' || !json.default_branch) {
    throw new SkillError('无法确定仓库默认分支')
  }
  return json.default_branch
}

/** 下载 zipball。显式 ref 优先按分支取，失败再试标签与提交 */
async function fetchZipball(owner: string, repo: string, ref: string, explicit: boolean): Promise<Buffer> {
  const candidates = explicit
    ? [
        `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${ref}`,
        `https://codeload.github.com/${owner}/${repo}/zip/refs/tags/${ref}`,
        `https://codeload.github.com/${owner}/${repo}/zip/${ref}`
      ]
    : [`https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${ref}`]
  let lastStatus = 0
  for (const url of candidates) {
    let res: Response
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    } catch {
      throw new SkillError('下载仓库压缩包失败，请检查网络后重试')
    }
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > MAX_REPO_ZIP_BYTES) throw new SkillError('仓库压缩包超过 64 MB，拒绝导入')
      if (!isZip(buf)) throw new SkillError('下载到的不是有效的 zip 包')
      return buf
    }
    lastStatus = res.status
  }
  if (lastStatus === 404) throw new SkillError('仓库或分支不存在（私有仓库不支持免令牌导入）')
  throw new SkillError(`下载仓库压缩包失败：HTTP ${lastStatus}`)
}

/**
 * 下载并拆包到「待落盘」结构，不碰应用数据目录。
 * importRepo 与 sync 共用：前者逐个新建，后者只取当初那一个做比对替换。
 */
async function fetchAndStage(target: {
  owner: string
  repo: string
  ref: string | null
  path: string | null
}): Promise<{ staged: StagedSkill[]; warnings: string[] }> {
  const warnings: string[] = []
  const ref = target.ref ?? (await fetchDefaultBranch(target.owner, target.repo))
  const zipBuf = await fetchZipball(target.owner, target.repo, ref, target.ref !== null)
  let stripped: { path: string; data: Buffer }[]
  try {
    stripped = stripZipRoot(readZip(zipBuf))
  } catch (e) {
    throw new SkillError(e instanceof ZipError ? e.message : String(e))
  }
  if (!stripped.length) throw new SkillError('仓库压缩包内没有文件')

  // 子路径过滤：精确文件直接成一个 skill，目录则取其下全部
  if (target.path) {
    const want = target.path.replace(/^\/+|\/+$/g, '')
    const exact = stripped.find((f) => f.path === want)
    if (exact && /\.(md|markdown|txt)$/i.test(want)) {
      const text = exact.data.toString('utf8')
      const parsed = parseSkillMarkdown(text)
      const base = want.split('/').pop() ?? target.repo
      return {
        staged: [
          {
            rootRel: want,
            files: [{ path: base, data: exact.data }],
            entry: base,
            parsed,
            bytes: exact.data.length
          }
        ],
        warnings
      }
    }
    const prefix = `${want}/`
    const under = stripped.filter((f) => f.path === want || f.path.startsWith(prefix))
    if (!under.length) return { staged: [], warnings: [`路径 ${want} 在仓库中不存在`] }
    stripped = under.map((f) => ({
      path: f.path === want ? f.path.split('/').pop() ?? f.path : f.path.slice(prefix.length),
      data: f.data
    }))
  }

  const roots = findSkillRoots(stripped.map((f) => f.path))
  if (!roots.length) return { staged: [], warnings: ['仓库中未找到 SKILL.md（或同名入口），没有可导入的 skill'] }
  const staged: StagedSkill[] = []
  for (const root of roots) {
    const prefix = root ? `${root}/` : ''
    const files = stripped
      .filter((f) => (root ? f.path === root || f.path.startsWith(prefix) : true))
      .map((f) => ({ path: root ? f.path.slice(prefix.length) : f.path, data: f.data }))
      .filter((f) => f.path && !f.path.endsWith('/'))
    const bytes = files.reduce((n, f) => n + f.data.length, 0)
    if (files.length > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) {
      warnings.push(`跳过 ${root || '根目录'}：${files.length} 个文件 / ${(bytes / 1048576).toFixed(1)}MB，超过上限`)
      continue
    }
    let entry: string
    try {
      entry = await pickEntry(files.map((f) => f.path))
    } catch {
      warnings.push(`跳过 ${root || '根目录'}：其中没有可识别的入口文档`)
      continue
    }
    const entryFile = files.find((f) => f.path === entry)
    const parsed = parseSkillMarkdown(entryFile?.data.toString('utf8') ?? '')
    staged.push({ rootRel: root, files, entry, parsed, bytes })
  }
  return { staged, warnings }
}
