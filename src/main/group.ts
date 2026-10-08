import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { dataDir } from './store'
import type { Group } from '@shared/types'

/** 群组落盘文件 */
function file(): string {
  return path.join(dataDir(), 'groups.json')
}

async function readAll(): Promise<Group[]> {
  try {
    const raw = await fs.readFile(file(), 'utf8')
    const parsed = JSON.parse(raw) as { groups?: Group[] }
    return Array.isArray(parsed.groups) ? parsed.groups : []
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    return []
  }
}

async function writeAll(groups: Group[]): Promise<void> {
  await fs.mkdir(path.dirname(file()), { recursive: true })
  const tmp = `${file()}.tmp`
  await fs.writeFile(tmp, JSON.stringify({ groups }, null, 2), 'utf8')
  await fs.rename(tmp, file())
}

/** 群聊组存储：memberIds 存 sessionId */
export const groupStore = {
  async list(): Promise<Group[]> {
    const all = await readAll()
    return [...all].sort((a, b) => b.createdAt - a.createdAt)
  },
  async get(id: string): Promise<Group | null> {
    const all = await readAll()
    return all.find((x) => x.id === id) ?? null
  },
  async create(name: string): Promise<Group> {
    const now = Date.now()
    const g: Group = { id: randomUUID(), name: name.trim().slice(0, 100) || '新群聊', memberIds: [], createdAt: now }
    const all = await readAll()
    all.push(g)
    await writeAll(all)
    return g
  },
  async rename(id: string, name: string): Promise<void> {
    const all = await readAll()
    const hit = all.find((x) => x.id === id)
    if (!hit) return
    hit.name = name.trim().slice(0, 100) || hit.name
    await writeAll(all)
  },
  async remove(id: string): Promise<void> {
    await writeAll((await readAll()).filter((x) => x.id !== id))
  },
  async addMember(id: string, sessionId: string): Promise<Group | null> {
    const all = await readAll()
    const hit = all.find((x) => x.id === id)
    if (!hit) return null
    if (!hit.memberIds.includes(sessionId)) hit.memberIds.push(sessionId)
    await writeAll(all)
    return hit
  },
  async removeMember(id: string, sessionId: string): Promise<Group | null> {
    const all = await readAll()
    const hit = all.find((x) => x.id === id)
    if (!hit) return null
    hit.memberIds = hit.memberIds.filter((m) => m !== sessionId)
    await writeAll(all)
    return hit
  }
}
