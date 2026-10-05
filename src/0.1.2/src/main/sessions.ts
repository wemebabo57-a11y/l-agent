import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { dataDir } from './store'
import type { RepoTarget, Session, SessionSummary } from '@shared/types'

/** 落盘时每个会话保留的最大消息数（防止 session 文件无限膨胀） */
const PERSIST_MESSAGE_LIMIT = 200

interface SessionFile {
  sessions: Session[]
}

function file(): string {
  return path.join(dataDir(), 'sessions.json')
}

async function readAll(): Promise<Session[]> {
  try {
    const raw = await fs.readFile(file(), 'utf8')
    const parsed = JSON.parse(raw) as SessionFile
    return Array.isArray(parsed.sessions) ? parsed.sessions : []
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    return []
  }
}

async function writeAll(sessions: Session[]): Promise<void> {
  await fs.mkdir(path.dirname(file()), { recursive: true })
  const tmp = `${file()}.tmp`
  await fs.writeFile(tmp, JSON.stringify({ sessions }, null, 2), 'utf8')
  await fs.rename(tmp, file())
}

function summarize(s: Session): SessionSummary {
  const totalTokens = s.messages.reduce(
    (n, m) => n + (m.usage ? m.usage.inputTokens + m.usage.outputTokens : 0),
    0
  )
  return {
    id: s.id,
    title: s.title,
    workspaceId: s.workspaceId,
    updatedAt: s.updatedAt,
    messageCount: s.messages.length,
    totalTokens,
    pinned: s.pinned ?? false
  }
}

/** 置顶优先，再按更新时间倒序 */
function sortSummaries(all: SessionSummary[]): SessionSummary[] {
  return all.sort((a, b) => {
    const pa = a.pinned ? 1 : 0
    const pb = b.pinned ? 1 : 0
    if (pa !== pb) return pb - pa
    return b.updatedAt - a.updatedAt
  })
}

export const sessionStore = {
  async list(): Promise<SessionSummary[]> {
    const all = await readAll()
    return sortSummaries(all.map(summarize))
  },

  async get(id: string): Promise<Session | null> {
    const all = await readAll()
    return all.find((s) => s.id === id) ?? null
  },

  async create(
    init: {
      workspaceId?: string | null
      repoTarget?: RepoTarget | null
      providerId?: string | null
      model?: string | null
      title?: string
    } = {}
  ): Promise<Session> {
    const now = Date.now()
    const session: Session = {
      id: randomUUID(),
      title: init.title ?? '新会话',
      workspaceId: init.workspaceId ?? null,
      repoTarget: init.repoTarget ?? null,
      providerId: init.providerId ?? null,
      model: init.model ?? null,
      messages: [],
      createdAt: now,
      updatedAt: now
    }
    const all = await readAll()
    all.push(session)
    await writeAll(all)
    return session
  },

  async save(session: Session): Promise<void> {
    const all = await readAll()
    const idx = all.findIndex((s) => s.id === session.id)
    // pinned 来自磁盘旧 record：渲染进程传回的 Session 可能不带该字段，不能直接覆盖
    const prevPinned = idx >= 0 ? (all[idx].pinned ?? false) : false
    const trimmed: Session = {
      ...session,
      pinned: session.pinned ?? prevPinned,
      messages: session.messages.slice(-PERSIST_MESSAGE_LIMIT),
      updatedAt: Date.now()
    }
    if (idx >= 0) all[idx] = trimmed
    else all.push(trimmed)
    await writeAll(all)
  },

  async rename(id: string, title: string): Promise<void> {
    const all = await readAll()
    const hit = all.find((s) => s.id === id)
    if (!hit) return
    hit.title = title.slice(0, 200)
    hit.updatedAt = Date.now()
    await writeAll(all)
  },

  /** 置顶/取消置顶：只翻标记，不碰更新时间，避免把旧会话顶到时间排序前面 */
  async pin(id: string, pinned: boolean): Promise<void> {
    const all = await readAll()
    const hit = all.find((s) => s.id === id)
    if (!hit) return
    hit.pinned = pinned
    await writeAll(all)
  },

  async remove(id: string): Promise<void> {
    const all = await readAll()
    await writeAll(all.filter((s) => s.id !== id))
  },

  async clearMessages(id: string): Promise<void> {
    const all = await readAll()
    const hit = all.find((s) => s.id === id)
    if (!hit) return
    hit.messages = []
    hit.updatedAt = Date.now()
    await writeAll(all)
  }
}
