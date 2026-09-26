import { useCallback, useEffect, useState } from 'react'
import type { FileContent, FileNode, SearchHit, Workspace } from '@shared/types'
import { api, messageOf, unwrap } from '../lib/api'
import { formatBytes, formatDateTime, formatRelative, shortPath } from '../lib/format'
import { Alert, Button, Empty, Pill, Spinner } from './ui'
import { IconChevron, IconClose, IconFile, IconFolder, IconRefresh } from './icons'

export function WorkspaceView({
  workspaces,
  activeId,
  onSelect,
  onChanged,
  onNotice
}: {
  workspaces: Workspace[]
  activeId: string | null
  onSelect: (id: string | null) => void
  onChanged: () => void
  onNotice: (m: string, k?: 'error' | 'info') => void
}): React.JSX.Element {
  const [tree, setTree] = useState<FileNode[]>([])
  const [expanded, setExpanded] = useState<Record<string, FileNode[]>>({})
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [file, setFile] = useState<FileContent | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)

  // 编辑态
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const ws = workspaces.find((w) => w.id === activeId) ?? null

  const loadRoot = useCallback(async (wsId: string) => {
    setLoading(true)
    setError(null)
    try {
      setTree((await unwrap(api.workspace.tree(wsId, '', 1))) as FileNode[])
      setExpanded({})
      setOpenDirs(new Set())
      setSelected(null)
      setFile(null)
      setHits(null)
    } catch (e) {
      setError(messageOf(e))
      setTree([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (ws) void loadRoot(ws.id)
    else {
      setTree([])
      setSelected(null)
      setFile(null)
    }
  }, [ws?.id, loadRoot, ws])

  const toggleDir = async (node: FileNode): Promise<void> => {
    if (!ws) return
    if (openDirs.has(node.path)) {
      setOpenDirs((s) => {
        const n = new Set(s)
        n.delete(node.path)
        return n
      })
      return
    }
    setOpenDirs((s) => new Set(s).add(node.path))
    if (!expanded[node.path]) {
      try {
        const children = (await unwrap(api.workspace.tree(ws.id, node.path, 1))) as FileNode[]
        setExpanded((m) => ({ ...m, [node.path]: children }))
      } catch (e) {
        onNotice(messageOf(e), 'error')
      }
    }
  }

  const openFile = async (path: string): Promise<void> => {
    if (!ws) return
    setSelected(path)
    setEditing(false)
    setFile(null)
    try {
      const f = (await unwrap(api.workspace.read(ws.id, path))) as FileContent
      setFile(f)
      setDraft(f.text)
    } catch (e) {
      onNotice(messageOf(e), 'error')
    }
  }

  const save = async (): Promise<void> => {
    if (!ws || !selected) return
    try {
      await unwrap(api.workspace.write(ws.id, selected, draft))
      onNotice(`已保存 ${selected}`)
      setEditing(false)
      await openFile(selected)
      await loadRoot(ws.id)
    } catch (e) {
      onNotice(messageOf(e), 'error')
    }
  }

  const runSearch = async (): Promise<void> => {
    if (!ws || !query.trim()) return
    setSearching(true)
    try {
      setHits((await unwrap(api.workspace.search(ws.id, query))) as SearchHit[])
    } catch (e) {
      onNotice(messageOf(e), 'error')
    } finally {
      setSearching(false)
    }
  }

  const addWorkspace = async (): Promise<void> => {
    try {
      const dir = await unwrap(api.workspace.pick())
      if (!dir) return
      const added = await unwrap(api.workspace.add(dir))
      onChanged()
      onSelect(added.id)
      onNotice(`已添加工作区「${added.name}」`)
    } catch (e) {
      onNotice(messageOf(e), 'error')
    }
  }

  const removeWorkspace = async (id: string): Promise<void> => {
    try {
      await unwrap(api.workspace.remove(id))
      onChanged()
      if (activeId === id) onSelect(null)
      onNotice('已移除工作区（磁盘上的文件不受影响）')
    } catch (e) {
      onNotice(messageOf(e), 'error')
    }
  }

  const renderNode = (node: FileNode, depth: number): React.JSX.Element => {
    const open = openDirs.has(node.path)
    const children = expanded[node.path]
    return (
      <div key={node.path}>
        <div
          className={`tree-node${selected === node.path ? ' selected' : ''}${node.ignored ? ' ignored' : ''}`}
          style={{ paddingLeft: 6 + depth * 12 }}
          onClick={() => (node.isDir ? void toggleDir(node) : void openFile(node.path))}
          title={node.path}
        >
          <span className={`tree-caret${open ? ' open' : ''}`}>
            {node.isDir ? <IconChevron size={11} /> : null}
          </span>
          <span className="tree-icon">{node.isDir ? <IconFolder size={13} /> : <IconFile size={13} />}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
          {!node.isDir ? <span className="muted tiny" style={{ marginLeft: 'auto' }}>{formatBytes(node.size)}</span> : null}
        </div>
        {node.isDir && open && children
          ? children.map((c) => renderNode(c, depth + 1))
          : null}
        {node.isDir && open && !children ? (
          <div className="muted tiny" style={{ paddingLeft: 18 + depth * 12 }}>
            <Spinner /> 加载中
          </div>
        ) : null}
      </div>
    )
  }

  if (!workspaces.length) {
    return (
      <div className="page">
        <div className="page-narrow">
          <Empty title="还没有工作区">
            工作区是助手可以读写文件的本地目录。添加后，助手就能读取代码并直接修改。
            <div style={{ marginTop: 14 }}>
              <Button variant="primary" onClick={() => void addWorkspace()}>
                + 添加工作区目录
              </Button>
            </div>
          </Empty>
        </div>
      </div>
    )
  }

  return (
    <div className="split">
      <div className="split-side">
        <div className="side-head">
          <select
            className="select"
            value={activeId ?? ''}
            onChange={(e) => onSelect(e.target.value || null)}
            style={{ flex: 1, minWidth: 0 }}
          >
            <option value="">未选择</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <Button size="sm" onClick={() => void addWorkspace()} title="添加工作区">
            +
          </Button>
        </div>

        {ws ? (
          <>
            <div className="side-head" style={{ borderTop: 'none' }}>
              <input
                className="input"
                placeholder="搜索内容…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runSearch()
                }}
                style={{ flex: 1, minWidth: 0 }}
              />
              <Button size="sm" onClick={() => void runSearch()} disabled={searching || !query.trim()}>
                {searching ? <Spinner /> : '搜'}
              </Button>
              {hits ? (
                <Button size="sm" variant="ghost" onClick={() => setHits(null)} title="清除搜索结果">
                  <IconClose size={12} />
                </Button>
              ) : null}
            </div>

            <div style={{ padding: '1px 8px 5px', fontSize: 11 }} className="muted mono">
              {shortPath(ws.path, 34)}
            </div>

            <div className="tree">
              {loading ? (
                <div className="muted tiny" style={{ padding: 8 }}>
                  <Spinner /> 读取目录…
                </div>
              ) : hits ? (
                hits.length === 0 ? (
                  <div className="muted tiny" style={{ padding: 8 }}>
                    无匹配结果
                  </div>
                ) : (
                  hits.map((h) => (
                    <div key={h.path} style={{ marginBottom: 6 }}>
                      <div
                        className="tree-node"
                        onClick={() => void openFile(h.path)}
                        style={{ color: 'var(--accent)', gap: 6 }}
                        title={h.path}
                      >
                        <IconFile size={12} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.path}</span>
                      </div>
                      {h.matches.slice(0, 8).map((m, i) => (
                        <div
                          key={i}
                          className="muted tiny mono"
                          style={{ paddingLeft: 14, whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis' }}
                        >
                          {m.line}: {m.text.trim().slice(0, 60)}
                        </div>
                      ))}
                    </div>
                  ))
                )
              ) : (
                tree.map((n) => renderNode(n, 0))
              )}
            </div>

            <div className="side-head" style={{ borderBottom: 'none', borderTop: '1px solid var(--border)' }}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void loadRoot(ws.id)}
                title="刷新目录树"
              >
                <IconRefresh size={11} /> 刷新
              </Button>
              <div className="topbar-spacer" />
              <Button size="sm" variant="danger" onClick={() => void removeWorkspace(ws.id)} title="从列表移除">
                移除
              </Button>
            </div>
          </>
        ) : (
          <div className="muted tiny" style={{ padding: 12 }}>
            请在上方选择或添加一个工作区
          </div>
        )}
      </div>

      <div className="split-main">
        {error ? (
          <div style={{ padding: 12 }}>
            <Alert kind="error">{error}</Alert>
          </div>
        ) : null}

        {!selected ? (
          <Empty title="选择一个文件查看内容">
            左侧目录树支持逐层展开；也可以用搜索框按内容查找。
          </Empty>
        ) : file ? (
          <>
            <div className="side-head">
              <span className="mono" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }} title={selected}>
                {selected}
              </span>
              {file.binary ? <Pill kind="warn">二进制</Pill> : null}
              {file.truncated ? <Pill kind="warn">已截断</Pill> : null}
              <span className="muted tiny">{formatBytes(file.size)}</span>
              <span className="muted tiny">{formatDateTime(file.modifiedAt)}</span>
              {!file.binary ? (
                editing ? (
                  <>
                    <Button size="sm" variant="primary" onClick={() => void save()}>
                      保存
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        setEditing(false)
                        setDraft(file.text)
                      }}
                    >
                      取消
                    </Button>
                  </>
                ) : (
                  <Button size="sm" onClick={() => setEditing(true)}>
                    编辑
                  </Button>
                )
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void api.workspace.reveal(ws!.id, selected)}
                title="在文件管理器中显示"
              >
                定位
              </Button>
            </div>

            {file.binary ? (
              <Empty title="二进制文件">
                该文件包含非文本内容，无法在编辑器中查看。
                <br />
                <span className="tiny">可用「定位」按钮在系统文件管理器中打开。</span>
              </Empty>
            ) : editing ? (
              <textarea
                className="code-view"
                style={{ width: '100%', border: 'none', outline: 'none', resize: 'none' }}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
              />
            ) : (
              <pre className="code-view">{file.text || '（空文件）'}</pre>
            )}
          </>
        ) : (
          <div style={{ padding: 14 }}>
            <Spinner /> 读取中…
          </div>
        )}
      </div>
    </div>
  )
}

/** 供工作区列表页复用：显示已有工作区概览 */
export function WorkspaceList({
  workspaces,
  activeId,
  onSelect,
  onChanged,
  onNotice
}: {
  workspaces: Workspace[]
  activeId: string | null
  onSelect: (id: string | null) => void
  onChanged: () => void
  onNotice: (m: string, k?: 'error' | 'info') => void
}): React.JSX.Element {
  return (
    <div>
      {workspaces.map((w) => (
        <div key={w.id} className="repo-item" onClick={() => onSelect(w.id)} style={{ cursor: 'pointer' }}>
          <div className="repo-name">
            <IconFolder size={13} />
            {w.name}
            {activeId === w.id ? <Pill kind="accent">当前</Pill> : null}
            <div className="topbar-spacer" />
            <span className="muted tiny">{formatRelative(w.addedAt)}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void api.workspace.remove(w.id).then(() => {
                  onChanged()
                  if (activeId === w.id) onSelect(null)
                  onNotice('已移除工作区')
                })
              }}
            >
              移除
            </Button>
          </div>
          <div className="muted tiny mono" style={{ marginTop: 3 }} title={w.path}>
            {w.path}
          </div>
        </div>
      ))}
    </div>
  )
}
