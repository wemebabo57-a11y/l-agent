/**
 * 从远端仓库（GitHub）解析 Skill 定位信息的纯函数模块。
 *
 * 刻意不 import 任何 Electron/网络依赖：解析逻辑要能被 scripts/unit.mjs
 * 直接 import 测试，下载 zipball 的网络代码放在 skills/index.ts。
 *
 * 支持的链接形态：
 * - https://github.com/{owner}/{repo}
 * - https://github.com/{owner}/{repo}.git
 * - https://github.com/{owner}/{repo}/tree/{ref}/{subpath}
 * - https://github.com/{owner}/{repo}/blob/{ref}/{file}
 * - https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
 * - git@github.com:{owner}/{repo}.git
 * - 简写 owner/repo
 */

export interface SkillRepoTarget {
  owner: string
  repo: string
  /** 分支 / 标签 / 提交；null 表示用仓库默认分支 */
  ref: string | null
  /** 仓库内子路径（目录或文件）；null 表示仓库根 */
  path: string | null
}

const NAME_RE = /^[\w.-]+$/

export function parseSkillRepoUrl(input: string): SkillRepoTarget {
  const raw = input.trim()
  if (!raw) throw new Error('仓库链接不能为空')

  // 1) 简写 owner/repo（第一段不含点 => 是 owner 而不是域名；owner 名不允许含点）
  const shorthand = /^([\w-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(raw)
  if (shorthand) return { owner: shorthand[1], repo: shorthand[2], ref: null, path: null }

  // 2) SSH 形式
  const ssh = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(raw)
  if (ssh) return { owner: ssh[1], repo: ssh[2], ref: null, path: null }

  // 3) URL（允许省略协议，如 github.com/owner/repo）
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    throw new Error(`无法解析链接：${raw}`)
  }

  const host = url.hostname.toLowerCase()
  const segs = url.pathname.split('/').filter(Boolean)

  if (host === 'raw.githubusercontent.com') {
    // /{owner}/{repo}/{ref}/{path...}
    if (segs.length < 3) throw new Error('raw 链接缺少 owner/repo/ref 段')
    const [owner, repoRaw, ref] = segs
    const repo = repoRaw.replace(/\.git$/, '')
    if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) throw new Error('链接中的 owner/repo 不合法')
    return { owner, repo, ref, path: segs.slice(3).join('/') || null }
  }

  if (host === 'github.com' || host === 'www.github.com') {
    if (segs.length < 2) throw new Error('链接缺少 owner/repo 段')
    const repo = segs[1].replace(/\.git$/, '')
    if (!NAME_RE.test(segs[0]) || !NAME_RE.test(repo)) throw new Error('链接中的 owner/repo 不合法')
    const kind = segs[2]
    if (kind === 'tree' || kind === 'blob') {
      if (segs.length < 4) throw new Error(`${kind} 链接缺少 ref 与路径`)
      const ref = segs[3]
      if (!NAME_RE.test(ref)) throw new Error('链接中的分支名不合法')
      return { owner: segs[0], repo, ref, path: segs.slice(4).join('/') || null }
    }
    return { owner: segs[0], repo, ref: null, path: null }
  }

  throw new Error(`不支持的域名：${url.hostname}（仅支持 github.com 与 raw.githubusercontent.com）`)
}

/**
 * 在解压后的文件列表中定位所有 skill 根（含 SKILL.md 的目录）。
 * 祖先目录也含 SKILL.md 时，后代视为其子 Skill 的一部分而被剔除（祖先优先）。
 * 返回仓库内相对目录路径（'' 表示仓库根），按深度升序。
 */
export function findSkillRoots(relPaths: string[]): string[] {
  const roots = new Set<string>()
  for (const p of relPaths) {
    const norm = p.replace(/\\/g, '/')
    const segs = norm.split('/')
    if (segs[segs.length - 1].toLowerCase() !== 'skill.md') continue
    roots.add(segs.slice(0, -1).join('/'))
  }
  const list = [...roots].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
  const kept: string[] = []
  for (const r of list) {
    const isDescendant = kept.some((k) => r.startsWith(k ? `${k}/` : ''))
    if (!isDescendant) kept.push(r)
  }
  return kept
}

/**
 * 去掉 zipball 的公共顶层目录（如 owner-repo-abc1234/），
 * 并跳过越界/隐藏/目录条目。返回 {相对路径, 数据} 列表。
 */
export function stripZipRoot(
  entries: { name: string; isDir: boolean; data: Buffer }[]
): { path: string; data: Buffer }[] {
  const files = entries.filter((e) => !e.isDir && e.data.length > 0)
  if (!files.length) return []

  // 公共顶层目录：所有条目首段相同且都包含 '/'
  const firstSegs = new Set(
    files.map((e) => {
      const norm = e.name.replace(/\\/g, '/').replace(/^\/+/, '')
      return norm.split('/')[0]
    })
  )
  let prefix = ''
  if (firstSegs.size === 1 && files.every((e) => e.name.replace(/\\/g, '/').includes('/'))) {
    prefix = [...firstSegs][0] + '/'
  }

  const out: { path: string; data: Buffer }[] = []
  for (const e of files) {
    let rel = e.name.replace(/\\/g, '/').replace(/^\/+/, '')
    if (prefix && rel.startsWith(prefix)) rel = rel.slice(prefix.length)
    if (!rel || rel.startsWith('__MACOSX/') || rel.split('/').some((s) => s === '..')) continue
    out.push({ path: rel, data: e.data })
  }
  return out
}
