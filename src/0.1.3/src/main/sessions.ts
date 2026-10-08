import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { dataDir } from './store'
import type { ChatMode, RepoTarget, Session, SessionSummary } from '@shared/types'

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
    // 文件损坏：备份后回退为空。直接返回 [] 会让下一次写入永久丢掉全部会话，
    // 先留一个带时间戳的备份，用户至少还能手动抢救。
    try {
      await fs.mkdir(path.dirname(file()), { recursive: true })
      await fs.rename(file(), `${file()}.corrupt-${Date.now()}`)
    } catch {
      /* 备份失败不阻断启动 */
    }
    return []
  }
}

/**
 * 写序列化：所有读-改-写走同一条队列。
 * chatSend、groupSend、目标切换 save 可能并发打到同一个 sessions.json，
 * 不串行就会互相覆盖（后写者用旧快照盖掉先写者的新消息）。
 */
let writeQueue: Promise<void> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(fn, fn)
  writeQueue = run.then(
    () => undefined,
    () => undefined
  )
  return run
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
      chatMode?: ChatMode
    } = {}
  ): Promise<Session> {
    return serialized(async () => {
      const now = Date.now()
      const session: Session = {
        id: randomUUID(),
        title: (init.title ?? '新会话').trim().slice(0, 200) || '新会话',
        workspaceId: init.workspaceId ?? null,
        repoTarget: init.repoTarget ?? null,
        providerId: init.providerId ?? null,
        model: init.model ?? null,
        // 聊天模式缺省 standard，老数据读到 undefined 也按 standard 处理
        chatMode: init.chatMode ?? 'standard',
        messages: [],
        createdAt: now,
        updatedAt: now
      }
      const all = await readAll()
      all.push(session)
      await writeAll(all)
      return session
    })
  },

  async save(session: Session): Promise<void> {
    return serialized(async () => {
      const all = await readAll()
      const idx = all.findIndex((s) => s.id === session.id)
      const prev = idx >= 0 ? all[idx] : null
      // pinned 来自磁盘旧 record：渲染进程传回的 Session 可能不带该字段，不能直接覆盖
      const prevPinned = prev?.pinned ?? false
      // 兼容旧渲染进程：传回的 Session 可能不带 chatMode，此时沿用磁盘旧值
      const prevMode = prev?.chatMode ?? 'standard'
      // 截图只活在内存：任何经 save 落盘的消息都必须先剥 images，
      // 否则 session:save 通道可把整屏截图永久写进会话文件（隐私泄漏）
      const cleanMessages = session.messages.map(({ images: _images, ...rest }) => rest)
      // 只换目标（工作区/仓库/模式）不顶到列表前面：内容没动就不碰 updatedAt，
      // 否则每次切目标会话都会跳到最前，左栏顺序抖个不停
      const lastPrev = prev && prev.messages.length ? prev.messages[prev.messages.length - 1].id : null
      const lastNext = cleanMessages.length ? cleanMessages[cleanMessages.length - 1].id : null
      const contentSame =
        prev !== null &&
        prev.messages.length === cleanMessages.length &&
        lastPrev === lastNext &&
        prev.title === session.title
      const trimmed: Session = {
        ...session,
        pinned: session.pinned ?? prevPinned,
        chatMode: session.chatMode ?? prevMode,
        messages: cleanMessages.slice(-PERSIST_MESSAGE_LIMIT),
        updatedAt: contentSame && prev ? prev.updatedAt : Date.now()
      }
      if (idx >= 0) all[idx] = trimmed
      else all.push(trimmed)
      await writeAll(all)
    })
  },

  async rename(id: string, title: string): Promise<void> {
    return serialized(async () => {
      const all = await readAll()
      const hit = all.find((s) => s.id === id)
      if (!hit) return
      // 空标题直接忽略：误触清空输入框不该把标题洗成空字符串
      const t = title.trim().slice(0, 200)
      if (!t || t === hit.title) return
      hit.title = t
      hit.updatedAt = Date.now()
      await writeAll(all)
    })
  },

  /** 置顶/取消置顶：只翻标记，不碰更新时间，避免把旧会话顶到时间排序前面 */
  async pin(id: string, pinned: boolean): Promise<void> {
    return serialized(async () => {
      const all = await readAll()
      const hit = all.find((s) => s.id === id)
      if (!hit) return
      hit.pinned = pinned
      await writeAll(all)
    })
  },

  async remove(id: string): Promise<void> {
    return serialized(async () => {
      const all = await readAll()
      await writeAll(all.filter((s) => s.id !== id))
    })
  },

  async clearMessages(id: string): Promise<void> {
    return serialized(async () => {
      const all = await readAll()
      const hit = all.find((s) => s.id === id)
      if (!hit) return
      hit.messages = []
      hit.updatedAt = Date.now()
      await writeAll(all)
    })
  }
}
