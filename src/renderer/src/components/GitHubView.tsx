import { useCallback, useEffect, useState } from 'react'
import type { GitHubAuthState, RemoteCommitInput, RemoteFileNode, RepoRef } from '@shared/types'
import { api, messageOf, unwrap } from '../lib/api'
import { formatBytes, formatDateTime, formatRelative } from '../lib/format'
import { Alert, Button, Modal, Pill, Spinner } from './ui'
import {
  IconArrowUp,
  IconCheck,
  IconExternal,
  IconFile,
  IconFolder,
  IconGlobe,
  IconLock,
  IconRefresh
} from './icons'

type Tab = 'repos' | 'browse' | 'commit'

export function GitHubView({
  onNotice
}: {
  onNotice: (m: string, k?: 'error' | 'info') => void
}): React.JSX.Element {
  const [auth, setAuth] = useState<GitHubAuthState | null>(null)
  const [tokenInput, setTokenInput] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('repos')

  const [repos, setRepos] = useState<RepoRef[]>([])
  const [repoQuery, setRepoQuery] = useState('')
  const [repo, setRepo] = useState<RepoRef | null>(null)
  const [branches, setBranches] = useState<string[]>([])
  const [ref, setRef] = useState('')

  const [dirPath, setDirPath] = useState('')
  const [entries, setEntries] = useState<RemoteFileNode[]>([])
  const [filePreview, setFilePreview] = useState<{ path: string; text: string; sha: string } | null>(null)
  const [loading, setLoading] = useState(false)

  // 提交表单
  const [editPath, setEditPath] = useState('')
  const [editContent, setEditContent] = useState('')
  const [commitMessage, setCommitMessage] = useState('')
  const [targetBranch, setTargetBranch] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [openPR, setOpenPR] = useState(true)
  const [prTitle, setPrTitle] = useState('')
  const [prBody, setPrBody] = useState('')
  const [confirmCommit, setConfirmCommit] = useState<RemoteCommitInput | null>(null)
  const [committing, setCommitting] = useState(false)
  const [lastResult, setLastResult] = useState<{ commitSha: string; commitUrl: string | null; branch: string; pr: { number: number; url: string } | null } | null>(null)

  const loadAuth = useCallback(async () => {
    try {
      const a = (await unwrap(api.github.authState())) as GitHubAuthState
      setAuth(a)
    } catch (e) {
      setError(messageOf(e))
    }
  }, [])

  useEffect(() => {
    void loadAuth()
  }, [loadAuth])

  const connect = async (): Promise<void> => {
    setConnecting(true)
    setError(null)
    try {
      const a = (await unwrap(api.github.setToken(tokenInput))) as GitHubAuthState
      setAuth(a)
      setTokenInput('')
      onNotice(`已连接 GitHub：${a.login}`)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setConnecting(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    try {
      await unwrap(api.github.logout())
      setAuth(null)
      await loadAuth()
      setRepos([])
      setRepo(null)
      onNotice('已断开 GitHub 连接，本地缓存令牌已清除')
    } catch (e) {
      onNotice(messageOf(e), 'error')
    }
  }

  const loadRepos = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setRepos((await unwrap(api.github.repos(1))) as RepoRef[])
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const searchRepos = async (): Promise<void> => {
    if (!repoQuery.trim()) return
    setLoading(true)
    try {
      setRepos((await unwrap(api.github.searchRepos(repoQuery))) as RepoRef[])
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setLoading(false)
    }
  }

  const selectRepo = async (r: RepoRef): Promise<void> => {
    setRepo(r)
    setRef(r.defaultBranch)
    setBaseBranch(r.defaultBranch)
    setTargetBranch(`lagent/${Date.now().toString(36)}`)
    setDirPath('')
    setFilePreview(null)
    setTab('browse')
    try {
      setBranches(await unwrap(api.github.branches(r.owner, r.name)))
    } catch {
      setBranches([r.defaultBranch])
    }
    await loadDir(r, r.defaultBranch, '')
  }

  const loadDir = async (r: RepoRef, branch: string, p: string): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      // 用整棵 tree 过滤出当前层的直接子项。
      // 注意：GitHub 的 tree API 对超大仓库会返回 truncated，此时深处目录可能缺项，
      // 属于已知限制——用户仍可通过搜索仓库后逐个打开文件。
      const nodes = (await unwrap(api.github.tree(r.owner, r.name, branch))) as {
        path: string
        type: string
        size: number | null
        sha: string
      }[]
      const prefix = p ? `${p}/` : ''
      const direct = nodes.filter((n) => {
        if (!n.path.startsWith(prefix)) return false
        const rest = n.path.slice(prefix.length)
        return rest.length > 0 && !rest.includes('/')
      })
      setEntries(
        direct
          .map((n) => ({
            path: n.path,
            name: n.path.slice(prefix.length),
            type: n.type === 'tree' ? ('tree' as const) : ('blob' as const),
            size: n.size,
            sha: n.sha
          }))
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === 'tree' ? -1 : 1
            return a.name.localeCompare(b.name, 'zh-CN')
          })
      )
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setLoading(false)
    }
  }

  const browseInto = async (path: string): Promise<void> => {
    if (!repo) return
    setDirPath(path)
    await loadDir(repo, ref, path)
  }

  const openRemoteFile = async (path: string): Promise<void> => {
    if (!repo) return
    setLoading(true)
    try {
      const f = (await unwrap(api.github.readFile(repo.owner, repo.name, path, ref))) as {
        text: string
        sha: string
        binary: boolean
      }
      if (f.binary) {
        onNotice(`${path} 是二进制文件，无法预览`, 'error')
        return
      }
      setFilePreview({ path, text: f.text, sha: f.sha })
      // 顺手填入提交表单，便于"读→改→提"连贯操作
      setEditPath(path)
      setEditContent(f.text)
      if (!commitMessage) setCommitMessage(`chore: 更新 ${path}`)
    } catch (e) {
      onNotice(messageOf(e), 'error')
    } finally {
      setLoading(false)
    }
  }

  const buildCommit = (): RemoteCommitInput | null => {
    if (!repo) return null
    if (!editPath.trim()) {
      onNotice('请填写要写入的文件路径', 'error')
      return null
    }
    if (!commitMessage.trim()) {
      onNotice('请填写提交信息', 'error')
      return null
    }
    if (openPR && !prTitle.trim() && !commitMessage.trim()) {
      onNotice('开启 PR 时需要标题', 'error')
      return null
    }
    return {
      owner: repo.owner,
      repo: repo.name,
      branch: targetBranch.trim(),
      baseBranch: baseBranch.trim() || repo.defaultBranch,
      message: commitMessage.trim(),
      changes: [{ path: editPath.trim(), content: editContent, encoding: 'utf-8' }],
      openPR,
      prTitle: prTitle.trim() || commitMessage.split('\n')[0].slice(0, 120),
      prBody: prBody,
      prDraft: false
    }
  }

  const doCommit = async (): Promise<void> => {
    if (!confirmCommit) return
    setCommitting(true)
    setError(null)
    try {
      const r = (await unwrap(api.github.commit(confirmCommit))) as {
        commitSha: string
        commitUrl: string | null
        branch: string
        pulledRequest: { number: number; url: string; title: string } | null
      }
      setLastResult({
        commitSha: r.commitSha,
        commitUrl: r.commitUrl,
        branch: r.branch,
        pr: r.pulledRequest
      })
      setConfirmCommit(null)
      onNotice(
        r.pulledRequest
          ? `已提交并创建 PR #${r.pulledRequest.number}`
          : `已提交到分支 ${r.branch}（commit ${r.commitSha.slice(0, 8)}）`
      )
      // 提交后刷新分支列表，让新分支可选
      if (repo) {
        try {
          setBranches(await unwrap(api.github.branches(repo.owner, repo.name)))
        } catch {
          /* 忽略 */
        }
      }
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setCommitting(false)
    }
  }

  /* ---------------- 未连接：显示令牌入口 ---------------- */

  if (!auth?.authenticated) {
    return (
      <div className="page">
        <div className="page-narrow">
          <h2 className="page-title" style={{ marginTop: 0 }}>连接 GitHub</h2>
          <Alert kind="info">
            lagent 通过 GitHub REST API 直接读写仓库，<strong>不会 clone 到本地</strong>
            。所有改动都以提交的形式落库，本地磁盘不产生任何副本。
          </Alert>

          <div className="card">
            <div className="card-head">
              <span className="card-title">访问令牌</span>
            </div>
            <div className="field">
              <label className="field-label">Personal Access Token</label>
              <input
                className="input mono"
                type="password"
                placeholder="ghp_… 或 github_pat_…"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void connect()
                }}
              />
              <div className="field-hint">
                在 GitHub → Settings → Developer settings → Personal access tokens 创建。
                <br />
                <strong>细粒度令牌</strong>：需要 Contents（读写）、Pull requests（读写）、Metadata（只读）权限。
                <br />
                <strong>经典令牌</strong>：勾选 <span className="mono">repo</span> 范围。
                <br />
                令牌会经系统密钥链加密后保存在本地，不会上传到任何第三方。
              </div>
            </div>
            {error ? <Alert kind="error">{error}</Alert> : null}
            <Button variant="primary" disabled={!tokenInput.trim() || connecting} onClick={() => void connect()}>
              {connecting ? <Spinner /> : null} 连接并验证
            </Button>
          </div>
        </div>
      </div>
    )
  }

  /* ---------------- 已连接 ---------------- */

  return (
    <div className="page">
      <div className="page-narrow">
        <div className="row row-wrap" style={{ marginBottom: 14 }}>
          <img
            src={auth.avatarUrl ?? ''}
            alt=""
            width={26}
            height={26}
            style={{ borderRadius: '50%', background: 'var(--bg-3)' }}
            onError={(e) => {
              ;(e.target as HTMLImageElement).style.visibility = 'hidden'
            }}
          />
          <strong>{auth.login}</strong>
          <Pill kind="ok">已连接</Pill>
          {auth.tokenKind ? <Pill>{auth.tokenKind === 'oauth' ? 'OAuth' : 'PAT'}</Pill> : null}
          {auth.rateLimit ? (
            <Pill kind={auth.rateLimit.remaining < 100 ? 'warn' : undefined}>
              配额 {auth.rateLimit.remaining}/{auth.rateLimit.limit}
            </Pill>
          ) : null}
          <div className="topbar-spacer" />
          <Button size="sm" variant="danger" onClick={() => void disconnect()}>
            断开连接
          </Button>
        </div>

        {error ? <Alert kind="error">{error}</Alert> : null}

        {lastResult ? (
          <Alert kind="info">
            <IconCheck size={13} /> 已提交 <span className="mono">{lastResult.commitSha.slice(0, 8)}</span> 到分支{' '}
            <span className="mono">{lastResult.branch}</span>
            {lastResult.pr ? (
              <>
                ，并创建 PR #{lastResult.pr.number}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void api.app.openExternal(lastResult.pr!.url)}
                >
                  打开 PR <IconExternal size={11} />
                </Button>
              </>
            ) : lastResult.commitUrl ? (
              <Button size="sm" variant="ghost" onClick={() => void api.app.openExternal(lastResult.commitUrl!)}>
                查看提交 <IconExternal size={11} />
              </Button>
            ) : null}
          </Alert>
        ) : null}

        <div className="row" style={{ marginBottom: 12, gap: 4 }}>
          <Button size="sm" variant={tab === 'repos' ? 'primary' : 'default'} onClick={() => setTab('repos')}>
            选择仓库
          </Button>
          <Button
            size="sm"
            variant={tab === 'browse' ? 'primary' : 'default'}
            disabled={!repo}
            onClick={() => setTab('browse')}
          >
            浏览文件
          </Button>
          <Button
            size="sm"
            variant={tab === 'commit' ? 'primary' : 'default'}
            disabled={!repo}
            onClick={() => setTab('commit')}
          >
            编辑并提交
          </Button>
          {repo ? (
            <span className="muted tiny mono" style={{ marginLeft: 8 }}>
              {repo.fullName}
            </span>
          ) : null}
        </div>

        {tab === 'repos' ? (
          <div className="card">
            <div className="row" style={{ marginBottom: 11 }}>
              <input
                className="input"
                placeholder="搜索仓库，或直接加载我的仓库列表…"
                value={repoQuery}
                onChange={(e) => setRepoQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void searchRepos()
                }}
              />
              <Button onClick={() => void searchRepos()} disabled={!repoQuery.trim()}>
                搜索
              </Button>
              <Button onClick={() => void loadRepos()}>我的仓库</Button>
            </div>

            {loading ? (
              <div className="muted">
                <Spinner /> 加载中…
              </div>
            ) : repos.length === 0 ? (
              <div className="muted tiny">点「我的仓库」加载列表，或搜索指定仓库。</div>
            ) : (
              <div style={{ maxHeight: 460, overflowY: 'auto' }}>
                {repos.map((r) => (
                  <div key={r.fullName} className="repo-item" onClick={() => void selectRepo(r)}>
                    <div className="repo-name">
                      <span className="repo-vis" title={r.private ? '私有仓库' : '公开仓库'}>
                        {r.private ? <IconLock size={12} /> : <IconGlobe size={12} />}
                      </span>
                      {r.fullName}
                      <div className="topbar-spacer" />
                      <span className="muted tiny">默认分支 {r.defaultBranch}</span>
                      {r.updatedAt ? <span className="muted tiny">{formatRelative(Date.parse(r.updatedAt))}</span> : null}
                    </div>
                    {r.description ? <div className="muted tiny">{r.description}</div> : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {tab === 'browse' && repo ? (
          <div className="card">
            <div className="row row-wrap" style={{ marginBottom: 10 }}>
              <select className="select" value={ref} onChange={(e) => {
                setRef(e.target.value)
                void loadDir(repo, e.target.value, '')
                setDirPath('')
              }} style={{ maxWidth: 260 }}>
                {(branches.length ? branches : [repo.defaultBranch]).map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
              <span className="mono tiny" style={{ flex: 1 }}>
                /{dirPath}
                {dirPath ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const parent = dirPath.split('/').slice(0, -1).join('/')
                      void browseInto(parent)
                    }}
                  >
                    <IconArrowUp size={11} /> 上级
                  </Button>
                ) : null}
              </span>
              <Button size="sm" onClick={() => void loadDir(repo, ref, dirPath)}>
                <IconRefresh size={11} /> 刷新
              </Button>
            </div>

            {loading ? (
              <div className="muted">
                <Spinner /> 读取中…
              </div>
            ) : entries.length === 0 ? (
              <div className="muted tiny">该目录为空</div>
            ) : (
              <div style={{ maxHeight: 400, overflowY: 'auto' }}>
                {entries.map((e) => (
                  <div
                    key={e.path}
                    className="tree-node"
                    onClick={() => (e.type === 'tree' ? void browseInto(e.path) : void openRemoteFile(e.path))}
                  >
                    <span className="tree-icon">{e.type === 'tree' ? <IconFolder size={13} /> : <IconFile size={13} />}</span>
                    <span>{e.name}</span>
                    {e.size != null ? (
                      <span className="muted tiny" style={{ marginLeft: 'auto' }}>
                        {formatBytes(e.size)}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            )}

            {filePreview ? (
              <div style={{ marginTop: 12 }}>
                <div className="row" style={{ marginBottom: 6 }}>
                  <span className="mono tiny" style={{ flex: 1 }}>
                    {filePreview.path}
                  </span>
                  <span className="muted tiny mono">sha {filePreview.sha.slice(0, 8)}</span>
                  <Button size="sm" onClick={() => setTab('commit')}>
                    编辑此文件
                  </Button>
                </div>
                <pre className="code-view" style={{ maxHeight: 340, border: '1px solid var(--border)', borderRadius: 6 }}>
                  {filePreview.text}
                </pre>
              </div>
            ) : null}
          </div>
        ) : null}

        {tab === 'commit' && repo ? (
          <>
            <div className="card">
              <div className="card-head">
                <span className="card-title">提交内容</span>
                <Pill kind="danger">远端写入</Pill>
              </div>
              <div className="field">
                <label className="field-label">文件路径（仓库内）</label>
                <input
                  className="input mono"
                  placeholder="src/index.ts"
                  value={editPath}
                  onChange={(e) => setEditPath(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-label">
                  文件内容 <span className="muted tiny">（{editContent.split('\n').length} 行）</span>
                </label>
                <textarea
                  className="textarea"
                  rows={14}
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  spellCheck={false}
                />
                <div className="field-hint">
                  留空会写入空文件。删除文件请改用助手的 <span className="mono">gh_commit</span> 工具（支持 delete
                  标记）。
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <span className="card-title">提交设置</span>
              </div>
              <div className="field">
                <label className="field-label">提交信息</label>
                <input
                  className="input"
                  placeholder="fix: 修正参数校验逻辑"
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                />
              </div>
              <div className="row" style={{ gap: 10 }}>
                <div className="field" style={{ flex: 1 }}>
                  <label className="field-label">目标分支</label>
                  <input
                    className="input mono"
                    value={targetBranch}
                    onChange={(e) => setTargetBranch(e.target.value)}
                    list="branch-list"
                  />
                  <datalist id="branch-list">
                    {branches.map((b) => (
                      <option key={b} value={b} />
                    ))}
                  </datalist>
                  <div className="field-hint">
                    已存在的分支会被更新；不存在的分支会从基准分支新建。
                  </div>
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label className="field-label">基准分支</label>
                  <input className="input mono" value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} />
                  <div className="field-hint">新分支的起点，也是 PR 的目标分支。</div>
                </div>
              </div>

              <label className="row" style={{ gap: 7, cursor: 'pointer', marginBottom: 10 }}>
                <input type="checkbox" checked={openPR} onChange={(e) => setOpenPR(e.target.checked)} />
                <span>同时创建 Pull Request</span>
                <span className="muted tiny">（推荐：避免直接改动受保护分支）</span>
              </label>

              {openPR ? (
                <>
                  <div className="field">
                    <label className="field-label">PR 标题</label>
                    <input
                      className="input"
                      placeholder="留空则使用提交信息首行"
                      value={prTitle}
                      onChange={(e) => setPrTitle(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label className="field-label">PR 正文</label>
                    <textarea
                      className="textarea"
                      rows={4}
                      placeholder="说明改动动机与影响范围…"
                      value={prBody}
                      onChange={(e) => setPrBody(e.target.value)}
                    />
                  </div>
                </>
              ) : null}

              <Button
                variant="primary"
                onClick={() => {
                  const c = buildCommit()
                  if (c) setConfirmCommit(c)
                }}
              >
                提交到 GitHub
              </Button>
            </div>
          </>
        ) : null}
      </div>

      {confirmCommit ? (
        <Modal
          title="确认远端提交"
          onClose={() => setConfirmCommit(null)}
          footer={
            <>
              <Button onClick={() => setConfirmCommit(null)} disabled={committing}>
                取消
              </Button>
              <Button variant="danger" onClick={() => void doCommit()} disabled={committing}>
                {committing ? <Spinner /> : null} 确认提交
              </Button>
            </>
          }
        >
          <Alert kind="warn">
            这会在远端仓库创建真实提交，并将改动写入历史。请确认以下内容无误。
          </Alert>
          <div className="approval-detail">
            {[
              `仓库：${confirmCommit.owner}/${confirmCommit.repo}`,
              `目标分支：${confirmCommit.branch}`,
              confirmCommit.openPR ? `PR 目标分支：${confirmCommit.baseBranch}` : `基准分支：${confirmCommit.baseBranch}`,
              `提交信息：${confirmCommit.message.split('\n')[0]}`,
              '',
              ...confirmCommit.changes.map((c) => `写入 ${c.path}（${(c.content ?? '').split('\n').length} 行）`)
            ].join('\n')}
          </div>
          <div className="muted tiny">
            操作时间：{formatDateTime(Date.now())}
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
