/**
 * Skill 元信息解析：从一个 Markdown 文本里提取 name / description / 额外键。
 *
 * 刻意做成零依赖的纯函数模块：
 * 1) 便于单元测试直接 import（无需 Electron）；
 * 2) 解析规则与文件 IO、存储位置解耦，后续支持其他格式时不必动这块。
 */

export interface ParsedSkill {
  /** frontmatter 的 name，缺失时为 null（由调用方用目录名兜底） */
  name: string | null
  /** 描述：frontmatter 的 description，缺失时取正文首段非标题文字 */
  description: string
  /** frontmatter 中的其他键值（如 version、author） */
  extra: Record<string, string>
  /** 去掉 frontmatter 后的正文 */
  body: string
}

/** 会被当作入口的文件名（按优先级） */
export const ENTRY_CANDIDATES = ['SKILL.md', 'skill.md', 'README.md', 'readme.md', 'index.md']

const BLOCK_SCALAR_MARKERS = new Set(['>', '|', '>-', '|-', '>+', '|+'])

/**
 * 解析 YAML frontmatter 的常用子集。
 * 支持：key: value、成对引号、块标量（> 与 |）、缩进续行。
 * 不支持：嵌套结构、锚点、多文档 —— 遇到就当普通字符串存进 extra，不报错。
 */
export function parseSkillMarkdown(text: string): ParsedSkill {
  const normalized = text.replace(/^\uFEFF/, '')
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(normalized)
  const extra: Record<string, string> = {}
  let name: string | null = null
  let description = ''
  let body = normalized

  if (fmMatch) {
    body = normalized.slice(fmMatch[0].length)
    const lines = fmMatch[1].split(/\r?\n/)
    let currentKey: string | null = null

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '')
      if (!line.trim() || line.trim().startsWith('#')) continue

      const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
      if (kv) {
        const key = kv[1].toLowerCase()
        let value = kv[2].trim()

        // 去掉成对引号
        if (
          value.length >= 2 &&
          ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'")))
        ) {
          value = value.slice(1, -1)
        }

        if (BLOCK_SCALAR_MARKERS.has(value)) {
          // 块标量：后续缩进行归入该键
          extra[key] = ''
          currentKey = key
          continue
        }

        extra[key] = value
        currentKey = null
        continue
      }

      // 块标量的续行（必须有缩进）
      if (currentKey && /^\s+\S/.test(raw)) {
        const piece = line.trim()
        extra[currentKey] = extra[currentKey] ? `${extra[currentKey]} ${piece}` : piece
      }
    }

    name = extra.name && extra.name.trim() ? extra.name.trim() : null
    description = extra.description ?? ''
  }

  if (!description.trim()) {
    // 无 frontmatter 或无 description 时，用正文首个非标题段落兜底
    const firstParagraph = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#') && !l.startsWith('---'))
    description = firstParagraph?.slice(0, 300) ?? ''
  }

  return {
    name,
    description: description.trim().slice(0, 600),
    extra,
    body
  }
}

/**
 * 从候选文件列表中挑出入口文件。
 * 优先根目录的 SKILL.md；其次允许一层嵌套（zip 常见的 <name>/SKILL.md）。
 */
export async function pickEntry(files: string[]): Promise<string> {
  for (const cand of ENTRY_CANDIDATES) {
    if (files.includes(cand)) return cand
  }
  const nested = files.filter((f) => f.split('/').length === 2)
  for (const cand of ENTRY_CANDIDATES) {
    const hit = nested.find((f) => f.endsWith(`/${cand}`))
    if (hit) return hit
  }
  const anyMd = files.find((f) => f.toLowerCase().endsWith('.md'))
  if (anyMd) return anyMd
  throw new Error('未找到 SKILL.md 或任何 Markdown 入口文件')
}
