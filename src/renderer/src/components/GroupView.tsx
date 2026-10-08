import { useEffect, useState } from 'react'
import type { ChatMessage, Group, SessionSummary } from '@shared/types'
import { api, messageOf, unwrap } from '../lib/api'
import { Alert, Button, Empty } from './ui'
import { MessageView } from './Message'
import { groupMessagesForView } from '../lib/footprint'

/**
 * 群聊视图：左侧群组列表＋成员管理，右侧消息区。
 * 样式跟随 ChatView 深色卡片（card/page/btn 等现有类）。
 */
export function GroupView({
  sessions,
  activeProviderId,
  activeModel,
  onNotice
}: {
  sessions: SessionSummary[]
  activeProviderId: string | null
  activeModel: string | null
  onNotice: (text: string, kind?: 'info' | 'error') => void
}): React.JSX.Element {
  const [groups, setGroups] = useState<Group[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [replies, setReplies] = useState<ChatMessage[]>([])
  const [newName, setNewName] = useState('')
  const [addSessionId, setAddSessionId] = useState('')

  const reload = async (): Promise<void> => {
    try {
      setGroups(await unwrap(api.groups.list()))
    } catch (e) {
      setError(messageOf(e))
    }
  }

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const active = groups.find((x) => x.id === activeId) ?? null

  const create = async (): Promise<void> => {
    try {
      const g = await unwrap(api.groups.create(newName.trim() || '新群聊'))
      setNewName('')
      setGroups((prev) => [g, ...prev])
      setActiveId(g.id)
    } catch (e) {
      onNotice(messageOf(e), 'error')
    }
  }

  const remove = async (id: string): Promise<void> => {
    try {
      await unwrap(api.groups.remove(id))
      setGroups((prev) => prev.filter((x) => x.id !== id))
      if (activeId === id) {
        setActiveId(null)
        setReplies([])
      }
    } catch (e) {
      onNotice(messageOf(e), 'error')
    }
  }

  const addMember = async (): Promise<void> => {
    if (!active || !addSessionId) return
    try {
      const g = await unwrap(api.groups.addMember(active.id, addSessionId))
      setGroups((prev) => prev.map((x) => (x.id === g.id ? g : x)))
      setAddSessionId('')
    } catch (e) {
      onNotice(messageOf(e), 'error')
    }
  }

  const removeMember = async (sessionId: string): Promise<void> => {
    if (!active) return
    try {
      const g = await unwrap(api.groups.removeMember(active.id, sessionId))
      setGroups((prev) => prev.map((x) => (x.id === g.id ? g : x)))
    } catch (e) {
      onNotice(messageOf(e), 'error')
    }
  }

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!text || busy || !active) return
    if (!activeProviderId || !activeModel) {
      setError('请先在顶部选择供应商与模型')
      return
    }
    if (!active.memberIds.length) {
      setError('群聊还没有成员，先从下方添加会话')
      return
    }
    setError(null)
    setBusy(true)
    setInput('')
    try {
      const r = await unwrap(
        api.groups.send({ groupId: active.id, text, providerId: activeProviderId, model: activeModel })
      )
      setReplies((prev) => [...prev, ...(r.appended as ChatMessage[])])
    } catch (e) {
      setError(messageOf(e))
      setInput(text)
    } finally {
      setBusy(false)
    }
  }

  const memberName = (id: string): string => sessions.find((s) => s.id === id)?.title ?? id.slice(0, 8)

  return (
    <div className="page">
      <div className="page-title">群聊</div>
      <div className="tiny muted" style={{ marginBottom: 10 }}>
        把多个会话拉进一组，一句话同时问所有成员，结果按成员名前缀拼成多条回复。
      </div>
      {error ? <Alert kind="error">{error}</Alert> : null}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        {/* 左：群组列表＋新建 */}
        <div className="card" style={{ width: 300, flexShrink: 0 }}>
          <div className="card-head">
            <span className="card-title">群组</span>
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <input
              className="session-search-input"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="新群聊名称"
              style={{ flex: 1 }}
            />
            <Button size="sm" variant="primary" onClick={() => void create()}>
              新建
            </Button>
          </div>
          {groups.length === 0 ? (
            <Empty title="暂无群聊">先建一个群聊，再把会话加进来。</Empty>
          ) : (
            groups.map((x) => (
              <div
                key={x.id}
                className={`session-item${x.id === activeId ? ' active' : ''}`}
                onClick={() => {
                  setActiveId(x.id)
                  setReplies([])
                  setError(null)
                }}
              >
                <span className="session-main">
                  <span className="session-title">{x.name}</span>
                  <span className="session-meta">{x.memberIds.length} 个成员</span>
                </span>
                <button
                  className="btn btn-ghost btn-sm btn-icon"
                  title="删除群聊"
                  onClick={(e) => {
                    e.stopPropagation()
                    void remove(x.id)
                  }}
                >
                  ×
                </button>
              </div>
            ))
          )}
          {active ? (
            <div style={{ marginTop: 10 }}>
              <div className="tiny muted" style={{ marginBottom: 4 }}>
                成员（存 sessionId）
              </div>
              {active.memberIds.length === 0 ? <div className="tiny muted">暂无成员</div> : null}
              {active.memberIds.map((m) => (
                <div key={m} className="session-item">
                  <span className="session-main">
                    <span className="session-title">{memberName(m)}</span>
                  </span>
                  <button
                    className="btn btn-ghost btn-sm btn-icon"
                    title="移出成员"
                    onClick={() => void removeMember(m)}
                  >
                    ×
                  </button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <select
                  className="select select-tight"
                  style={{ flex: 1 }}
                  value={addSessionId}
                  onChange={(e) => setAddSessionId(e.target.value)}
                >
                  <option value="">选择会话加入…</option>
                  {sessions
                    .filter((s) => !active.memberIds.includes(s.id))
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title}
                      </option>
                    ))}
                </select>
                <Button size="sm" onClick={() => void addMember()} disabled={!addSessionId}>
                  加入
                </Button>
              </div>
            </div>
          ) : null}
        </div>
        {/* 右：消息区 */}
        <div className="card" style={{ flex: 1 }}>
          <div className="card-head">
            <span className="card-title">{active ? active.name : '消息'}</span>
          </div>
          {!active ? (
            <Empty title="选择一个群聊">左侧选组后，在下方一次提问所有成员。</Empty>
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
                {replies.length === 0 ? (
                  <div className="tiny muted">还没有回复，在下方输入第一条群发消息。</div>
                ) : (
                  groupMessagesForView(replies).map((g) => (
                    <MessageView key={g.msg.id} message={g.msg} tools={g.tools} />
                  ))
                )}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="session-search-input"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={busy ? '成员正在回答…' : '群发一条消息…'}
                  disabled={busy}
                  style={{ flex: 1 }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void send()
                    }
                  }}
                />
                <Button size="sm" variant="primary" onClick={() => void send()} disabled={busy || !input.trim()}>
                  {busy ? '发送中' : '群发'}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
