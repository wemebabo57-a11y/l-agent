import { promises as fs } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { dataDir } from '../store'
import { extractZip, isZip, readZip, ZipError } from './zip'
import { parseSkillMarkdown, pickEntry as pickEntryFrom } from './frontmatter'
import type { SkillMeta } from '@shared/types'

/** 单个 skill 目录体积上限 */
const MAX_SKILL_BYTES = 32 * 1024 * 1024
const MAX_SKILL_FILES = 2000

export { parseSkillMarkdown }
export type { ParsedSkill } from './frontmatter'

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
