import type {
  GitHubAuthState,
  RemoteCommitInput,
  RemoteCommitResult,
  RemoteFileContent,
  RemoteFileNode,
  RepoRef
} from '@shared/types'
import { dataDir, secretStore } from './store'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly detail?: string
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

const SECRET_ID = 'github-token'
const USER_AGENT = 'lagent'
/** GitHub 建议的文件内容上限（Contents API 单文件 ~1MB 更稳） */
const MAX_API_FILE_BYTES = 1_000_000

interface GitHubUser {
  login: string
  name: string | null
  avatar_url: string
}

function b64ToUtf8Safe(b64: string): { text: string; binary: boolean } {
  const raw = Buffer.from(b64.replace(/\s/g, ''), 'base64')
  // 含 NUL 判定为二进制，不返回文本以免污染 UI
  for (let i = 0; i < Math.min(raw.length, 8000); i++) {
    if (raw[i] === 0) return { text: '', binary: true }
  }
  return { text: raw.toString('utf8'), binary: false }
}

/**
 * GitHub REST API 客户端。
 *
 * 设计要点：所有读写都通过 HTTP API 完成，**不在本地创建任何 clone**。
 * 因此这里不依赖 git 可执行文件，也不需要磁盘暂存区：
 * 文件内容在内存中以字符串/base64 形式流转。
 */
export class GitHubClient {
  private token: string | null = null
  private cachedUser: GitHubUser | null = null
  private baseURL = 'https://api.github.com'

  setBaseURL(url: string): void {
    this.baseURL = (url || 'https://api.github.com').replace(/\/+$/, '')
  }

  getBaseURL(): string {
    return this.baseURL
  }

  async loadToken(): Promise<string | null> {
    if (this.token) return this.token
    this.token = await secretStore.get(SECRET_ID)
    return this.token
  }

  async saveToken(token: string): Promise<GitHubAuthState> {
    const trimmed = token.trim()
    if (!trimmed) throw new GitHubError('令牌不能为空')
    // 先验证再落盘，避免存进一个坏令牌
    const previous = this.token
    this.token = trimmed
    this.cachedUser = null
    try {
      const user = await this.fetchUser()
      await secretStore.set(SECRET_ID, trimmed)
      return await this.authState(user)
    } catch (e) {
      this.token = previous
      this.cachedUser = null
      throw e
    }
  }

  async logout(): Promise<void> {
    this.token = null
    this.cachedUser = null
    await secretStore.remove(SECRET_ID)
  }

  private async fetchUser(): Promise<GitHubUser> {
    if (this.cachedUser) return this.cachedUser
    const { data } = await this.request<GitHubUser>('GET', '/user')
    this.cachedUser = data
    return data
  }

  async authState(knownUser?: GitHubUser): Promise<GitHubAuthState> {
    const token = await this.loadToken()
    if (!token) {
      return {
        authenticated: false,
        login: null,
        name: null,
        avatarUrl: null,
        scopes: [],
        tokenKind: null,
        rateLimit: null,
        baseURL: this.baseURL
      }
    }
    try {
      const user = knownUser ?? (await this.fetchUser())
      const scopes = this.lastScopes
      const rate = await this.rateLimit()
      return {
        authenticated: true,
        login: user.login,
        name: user.name,
        avatarUrl: user.avatar_url,
        scopes,
        // classic PAT 以 ghp_ 开头，fine-grained 以 github_pat_ 开头，OAuth 为 gho_
        tokenKind: token.startsWith('gho_') ? 'oauth' : 'pat',
        rateLimit: rate,
        baseURL: this.baseURL
      }
    } catch {
      return {
        authenticated: false,
        login: null,
        name: null,
        avatarUrl: null,
        scopes: [],
        tokenKind: null,
        rateLimit: null,
        baseURL: this.baseURL
      }
    }
  }

  private lastScopes: string[] = []

  private async rateLimit(): Promise<GitHubAuthState['rateLimit']> {
    try {
      const { headers } = await this.request<unknown>('GET', '/rate_limit')
      const limit = Number(headers.get('x-ratelimit-limit') ?? 0)
      const remaining = Number(headers.get('x-ratelimit-remaining') ?? 0)
      const reset = Number(headers.get('x-ratelimit-reset') ?? 0)
      if (!Number.isFinite(limit) || limit <= 0) return null
      return { limit, remaining, resetAt: reset * 1000 }
    } catch {
      return null
    }
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    options: { raw?: boolean; accept?: string; allow404?: boolean } = {}
  ): Promise<{ data: T; headers: Headers; status: number }> {
    const token = await this.loadToken()
    if (!token) throw new GitHubError('尚未连接 GitHub，请先在「GitHub」页填入访问令牌')

    const res = await fetch(`${this.baseURL}${endpoint}`, {
      method,
      headers: {
        Accept: options.accept ?? 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    })

    const scopeHeader = res.headers.get('x-oauth-scopes')
    if (scopeHeader != null) {
      this.lastScopes = scopeHeader
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    }

    if (options.allow404 && res.status === 404) {
      return { data: null as T, headers: res.headers, status: 404 }
    }
    if (!res.ok) throw await this.toError(res)
    if (res.status === 204) return { data: null as T, headers: res.headers, status: 204 }

    if (options.raw) {
      return { data: (await res.text()) as unknown as T, headers: res.headers, status: res.status }
    }
    return { data: (await res.json()) as T, headers: res.headers, status: res.status }
  }

  private async toError(res: Response): Promise<GitHubError> {
    const text = await res.text().catch(() => '')
    let detail = text.slice(0, 600)
    try {
      const j = JSON.parse(text) as { message?: string; documentation_url?: string }
      detail = j.message ?? detail
    } catch {
      /* 保留原文 */
    }
    const hint =
      res.status === 401
        ? '令牌无效或已过期'
        : res.status === 403
          ? '权限不足、被限流，或组织开启了 SSO 限制'
          : res.status === 404
            ? '仓库或路径不存在（也可能是令牌无权访问私有仓库）'
            : res.status === 409
              ? '分支冲突：目标分支已存在或为空仓库'
              : res.status === 422
                ? '请求内容不合法（如分支名非法、文件过大、SHA 不匹配）'
                : `GitHub 请求失败`
    return new GitHubError(`${hint}（HTTP ${res.status}）`, res.status, detail)
  }

  /* ---------------------------------------------------------------- */
  /* 仓库                                                              */
  /* ---------------------------------------------------------------- */

  async listRepos(perPage = 100, page = 1): Promise<RepoRef[]> {
    const { data } = await this.request<
      {
        full_name: string
        owner: { login: string }
        name: string
        default_branch: string
        private: boolean
        description: string | null
        updated_at: string
      }[]
    >('GET', `/user/repos?sort=updated&per_page=${perPage}&page=${page}`)
    return data.map((r) => ({
      fullName: r.full_name,
      owner: r.owner.login,
      name: r.name,
      defaultBranch: r.default_branch,
      private: r.private,
      description: r.description,
      updatedAt: r.updated_at
    }))
  }

  async searchRepos(query: string, perPage = 30): Promise<RepoRef[]> {
    const q = encodeURIComponent(query)
    const { data } = await this.request<{
      items: {
        full_name: string
        owner: { login: string }
        name: string
        default_branch: string
        private: boolean
        description: string | null
        updated_at: string
      }[]
    }>('GET', `/search/repositories?q=${q}&per_page=${perPage}`)
    return data.items.map((r) => ({
      fullName: r.full_name,
      owner: r.owner.login,
      name: r.name,
      defaultBranch: r.default_branch,
      private: r.private,
      description: r.description,
      updatedAt: r.updated_at
    }))
  }

  async getRepo(owner: string, repo: string): Promise<RepoRef> {
    const { data } = await this.request<{
      full_name: string
      owner: { login: string }
      name: string
      default_branch: string
      private: boolean
      description: string | null
      updated_at: string
    }>('GET', `/repos/${owner}/${repo}`)
    return {
      fullName: data.full_name,
      owner: data.owner.login,
      name: data.name,
      defaultBranch: data.default_branch,
      private: data.private,
      description: data.description,
      updatedAt: data.updated_at
    }
  }

  /**
   * 创建空私有仓库（给自动备份一键建库用）。
   * 默认私有：备份内容不应该默认公开，改公开请去网页上手动操作。
   */
  async createRepo(name: string): Promise<{ fullName: string; url: string; private: boolean }> {
    const clean = name.trim()
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(clean)) {
      throw new GitHubError('仓库名只能包含字母、数字、. _ -（100 字以内）')
    }
    const { data } = await this.request<{ full_name: string; html_url: string; private: boolean }>(
      'POST',
      '/user/repos',
      { name: clean, private: true, auto_init: false }
    )
    return { fullName: data.full_name, url: data.html_url, private: data.private }
  }

  /* ---------------------------------------------------------------- */
  /* 树与文件                                                          */
  /* ---------------------------------------------------------------- */

  /** 列出一层目录（用 contents API，比 tree API 更省流量且能拿 size） */
  async listDir(owner: string, repo: string, ref: string, dirPath: string): Promise<RemoteFileNode[]> {
    const clean = dirPath.replace(/^\/+|\/+$/g, '')
    const endpoint = `/repos/${owner}/${repo}/contents/${encodeURI(clean)}?ref=${encodeURIComponent(ref)}`
    const { data } = await this.request<
      | { name: string; path: string; type: string; size: number; sha: string }[]
      | { name: string; path: string; type: string; size: number; sha: string }
    >('GET', endpoint)

    const list = Array.isArray(data) ? data : [data]
    return list
      .map((n) => ({
        path: n.path,
        name: n.name,
        type: n.type === 'dir' ? ('tree' as const) : ('blob' as const),
        size: typeof n.size === 'number' ? n.size : null,
        sha: n.sha
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'tree' ? -1 : 1
        return a.name.localeCompare(b.name, 'zh-CN')
      })
  }

  /** 递归取整棵树的路径（默认只取 blob，用于快速索引/搜索） */
  async tree(
    owner: string,
    repo: string,
    ref: string,
    recursive = true
  ): Promise<{ path: string; type: 'blob' | 'tree'; size: number | null; sha: string }[]> {
    const { data } = await this.request<{
      tree: { path: string; type: string; size?: number; sha: string }[]
      truncated?: boolean
    }>('GET', `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}${recursive ? '?recursive=1' : ''}`)
    return data.tree
      .filter((t) => t.type === 'blob' || t.type === 'tree')
      .map((t) => ({
        path: t.path,
        type: t.type === 'tree' ? ('tree' as const) : ('blob' as const),
        size: t.size ?? null,
        sha: t.sha
      }))
  }

  async readFile(
    owner: string,
    repo: string,
    filePath: string,
    ref: string
  ): Promise<RemoteFileContent> {
    const clean = filePath.replace(/^\/+/, '')
    const { data } = await this.request<{
      content: string
      encoding: string
      sha: string
      size: number
      type: string
    }>(
      'GET',
      `/repos/${owner}/${repo}/contents/${encodeURI(clean)}?ref=${encodeURIComponent(ref)}`
    )
    if (data.type === 'dir') throw new GitHubError(`${filePath} 是目录`)
    if (data.size > MAX_API_FILE_BYTES) {
      throw new GitHubError(
        `文件 ${filePath} 大小 ${(data.size / 1024).toFixed(0)}KB，超过 Contents API 可读上限（约 1MB）`
      )
    }
    const { text, binary } = b64ToUtf8Safe(data.content ?? '')
    return {
      path: data.type ? clean : filePath,
      ref,
      text,
      sha: data.sha,
      size: data.size,
      binary,
      encoding: data.encoding ?? 'base64'
    }
  }

  /** 全站代码搜索（需要令牌，无令牌直接报错让调用方给出提示） */
  async searchCode(query: string, limit = 30): Promise<{ path: string; repo: string; name: string; url: string | null }[]> {
    const q = encodeURIComponent(query)
    const { data } = await this.request<{
      items: { path: string; repository: { full_name: string; name: string }; html_url: string }[]
    }>('GET', `/search/code?q=${q}&per_page=${Math.min(Math.max(limit, 1), 100)}`)
    return (data.items ?? []).map((i) => ({
      path: i.path,
      repo: i.repository.full_name,
      name: i.repository.name,
      url: i.html_url ?? null
    }))
  }

  async listBranches(owner: string, repo: string): Promise<string[]> {
    const { data } = await this.request<{ name: string }[]>(
      'GET',
      `/repos/${owner}/${repo}/branches?per_page=100`
    )
    return data.map((b) => b.name)
  }

  /* ---------------------------------------------------------------- */
  /* 提交（多文件 → 单次原子提交）                                       */
  /* ---------------------------------------------------------------- */

  /**
   * 用 Git Data API 构造一次提交。
   *
   * 为什么不用 Contents API 逐文件 PUT：那会产生 N 次提交，
   * 且中途失败会留下半完成的改动。这里改为
   * 「blob → tree → commit → 移动 ref」，整批改动要么全成要么全不成。
   */
  async commit(input: RemoteCommitInput): Promise<RemoteCommitResult> {
    const { owner, repo, changes } = input
    if (!changes.length) throw new GitHubError('没有需要提交的文件变更')

    const repoInfo = await this.getRepo(owner, repo)
    const baseBranch = input.baseBranch ?? repoInfo.defaultBranch
    const targetBranch = input.branch

    // 1) 取基准分支的最新提交与它的 tree
    const baseRef = await this.getRef(owner, repo, baseBranch)
    if (!baseRef) {
      throw new GitHubError(
        `找不到基准分支 ${baseBranch}（可能是空仓库，或令牌无权读取该分支）`,
        404
      )
    }
    const baseCommit = await this.getCommit(owner, repo, baseRef.sha)
    const baseTreeSha = baseCommit.tree.sha

    // 2) 每个变更生成/复用 blob
    const blobs = await Promise.all(
      changes.map(async (c) => {
        if (c.delete) return { path: c.path, sha: null as string | null, mode: '100644' }
        if (c.encoding === 'base64') {
          const { data } = await this.request<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/blobs`, {
            content: c.content ?? '',
            encoding: 'base64'
          })
          return { path: c.path, sha: data.sha, mode: '100644' }
        }
        const { data } = await this.request<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/blobs`, {
          content: c.content ?? '',
          encoding: 'utf-8'
        })
        return { path: c.path, sha: data.sha, mode: '100644' }
      })
    )

    // 3) 构造新 tree：删除用 sha=null 表达
    const treeEntries = blobs.map((b) => ({
      path: b.path.replace(/^\/+/, ''),
      mode: b.mode,
      type: 'blob' as const,
      sha: b.sha
    }))

    const { data: newTree } = await this.request<{ sha: string }>(
      'POST',
      `/repos/${owner}/${repo}/git/trees`,
      { base_tree: baseTreeSha, tree: treeEntries }
    )

    // 4) 判断目标分支状态：已存在则作为父提交，否则新建分支
    const existingRef = await this.getRef(owner, repo, targetBranch, true)
    const parents = existingRef ? [existingRef.sha] : [baseRef.sha]

    // 若沿用已有分支，tree 必须基于该分支的 tree，否则会回退别人的改动
    let finalTreeSha = newTree.sha
    if (existingRef && existingRef.sha !== baseRef.sha) {
      const targetCommit = await this.getCommit(owner, repo, existingRef.sha)
      const { data: rebasedTree } = await this.request<{ sha: string }>(
        'POST',
        `/repos/${owner}/${repo}/git/trees`,
        {
          base_tree: targetCommit.tree.sha,
          tree: treeEntries
        }
      )
      finalTreeSha = rebasedTree.sha
    }

    const { data: commit } = await this.request<{
      sha: string
      html_url: string
    }>('POST', `/repos/${owner}/${repo}/git/commits`, {
      message: input.message,
      tree: finalTreeSha,
      parents
    })

    // 5) 更新或创建 ref
    if (existingRef) {
      await this.request('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${encodeURI(targetBranch)}`, {
        sha: commit.sha,
        force: false
      })
    } else {
      await this.request('POST', `/repos/${owner}/${repo}/git/refs`, {
        ref: `refs/heads/${targetBranch}`,
        sha: commit.sha
      })
    }

    let pr: RemoteCommitResult['pulledRequest'] = null
    if (input.openPR) {
      try {
        const { data } = await this.request<{ number: number; html_url: string; title: string }>(
          'POST',
          `/repos/${owner}/${repo}/pulls`,
          {
            title: input.prTitle ?? input.message.split('\n')[0].slice(0, 120),
            body: input.prBody ?? '',
            head: targetBranch,
            base: baseBranch,
            draft: input.prDraft ?? false
          }
        )
        pr = { number: data.number, url: data.html_url, title: data.title }
      } catch (e) {
        // 提交已经成功，PR 失败不应让整个操作报错——但要如实告知
        const reason = e instanceof GitHubError ? e.message : String(e)
        throw new GitHubError(
          `代码已提交到分支 ${targetBranch}，但创建 PR 失败：${reason}`,
          e instanceof GitHubError ? e.status : undefined,
          commit.sha
        )
      }
    }

    return {
      commitSha: commit.sha,
      commitUrl: commit.html_url ?? null,
      branch: targetBranch,
      pulledRequest: pr
    }
  }

  private async getRef(
    owner: string,
    repo: string,
    branch: string,
    allow404 = false
  ): Promise<{ sha: string } | null> {
    const { data, status } = await this.request<{ object?: { sha: string }; sha?: string }>(
      'GET',
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURI(branch)}`,
      undefined,
      { allow404 }
    )
    if (status === 404) return null
    const sha = data.object?.sha ?? data.sha
    if (!sha) return null
    return { sha }
  }

  private async getCommit(
    owner: string,
    repo: string,
    sha: string
  ): Promise<{ sha: string; tree: { sha: string } }> {
    const { data } = await this.request<{ sha: string; tree: { sha: string } }>(
      'GET',
      `/repos/${owner}/${repo}/git/commits/${encodeURIComponent(sha)}`
    )
    return data
  }

  /* ---------------------------------------------------------------- */
  /* Release                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * 创建 release。
   *
   * tag 不存在时 GitHub 会自动以 targetCommitish 为起点建 tag，
   * 所以这里不用先手工建 tag——少一次可能失败的往返。
   */
  async createRelease(input: {
    owner: string
    repo: string
    tag: string
    name?: string
    body?: string
    targetCommitish?: string
    draft?: boolean
    prerelease?: boolean
  }): Promise<{ id: number; tag: string; name: string | null; url: string; draft: boolean }> {
    const { data } = await this.request<{
      id: number
      tag_name: string
      name: string | null
      html_url: string
      draft: boolean
    }>('POST', `/repos/${input.owner}/${input.repo}/releases`, {
      tag_name: input.tag,
      name: input.name ?? input.tag,
      body: input.body ?? '',
      target_commitish: input.targetCommitish,
      draft: input.draft ?? false,
      prerelease: input.prerelease ?? false
    })
    return {
      id: data.id,
      tag: data.tag_name,
      name: data.name,
      url: data.html_url,
      draft: data.draft
    }
  }

  async listReleases(
    owner: string,
    repo: string,
    perPage = 30
  ): Promise<{ tag: string; name: string | null; url: string; draft: boolean; prerelease: boolean; at: string }[]> {
    const { data } = await this.request<
      {
        tag_name: string
        name: string | null
        html_url: string
        draft: boolean
        prerelease: boolean
        published_at: string | null
        created_at: string
      }[]
    >('GET', `/repos/${owner}/${repo}/releases?per_page=${perPage}`)
    return data.map((r) => ({
      tag: r.tag_name,
      name: r.name,
      url: r.html_url,
      draft: r.draft,
      prerelease: r.prerelease,
      at: r.published_at ?? r.created_at
    }))
  }

  /* ---------------------------------------------------------------- */
  /* 把仓库文件导出到本地工作区（可选能力）                              */
  /* ---------------------------------------------------------------- */

  async saveRemoteFileToWorkspace(
    owner: string,
    repo: string,
    filePath: string,
    ref: string,
    targetAbsPath: string
  ): Promise<{ path: string; bytes: number }> {
    const file = await this.readFile(owner, repo, filePath, ref)
    await fs.mkdir(path.dirname(targetAbsPath), { recursive: true })
    const content = file.binary ? '' : file.text
    await fs.writeFile(targetAbsPath, content, 'utf8')
    return { path: targetAbsPath, bytes: Buffer.byteLength(content, 'utf8') }
  }
}

/** 便捷：读取之前缓存的 token 是否存在（不做网络请求） */
export async function hasGitHubToken(): Promise<boolean> {
  const token = await secretStore.get(SECRET_ID)
  return Boolean(token)
}

/** 应用数据目录下的 github 缓存区（仅用于极少数需要落盘的场景） */
export function gitHubCacheDir(): string {
  return path.join(dataDir(), 'github-cache')
}

/** 判断字符串是否看起来像 GitHub 令牌，用于表单即时校验 */
export function looksLikeToken(v: string): boolean {
  return /^(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(v.trim())
}
