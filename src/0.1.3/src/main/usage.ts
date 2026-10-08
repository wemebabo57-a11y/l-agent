import { promises as fs } from 'node:fs'
import path from 'node:path'
import { dataDir } from './store'
import type { UsageRecord, UsageStats } from '@shared/types'
import { aggregate } from '@shared/pricing'

/**
 * 用量记录存储。
 * 采用 JSONL 追加写：崩溃时最多丢最后一行，不会像整体 JSON 那样全废。
 * 内存里保留最近 N 条用于列表与聚合，避免每次读全文件。
 * 磁盘文件按大小轮转（usage.jsonl → .1 → .2 …，最多保留 MAX_FILES 个），
 * 否则长期运行 JSONL 无限涨。注意：stats 只统计当前主文件 + 内存窗口，
 * 轮转掉的老文件不再计入——统计是"近期用量"口径，不是全历史账单。
 */
const MAX_IN_MEMORY = 1000
/** 单个 JSONL 写到多大就轮转 */
const MAX_FILE_BYTES = 5 * 1024 * 1024
/** 主文件 + 轮转文件总数上限 */
const MAX_FILES = 5

class UsageStore {
  private cache: UsageRecord[] | null = null
  private file(): string {
    return path.join(dataDir(), 'usage.jsonl')
  }

  private async load(): Promise<UsageRecord[]> {
    if (this.cache) return this.cache
    try {
      const raw = await fs.readFile(this.file(), 'utf8')
      const lines = raw.split('\n').filter((l) => l.trim())
      const records: UsageRecord[] = []
      for (const line of lines) {
        try {
          records.push(JSON.parse(line) as UsageRecord)
        } catch {
          // 跳过损坏行，不因一行坏数据丢掉整个统计
        }
      }
      this.cache = records.slice(-MAX_IN_MEMORY)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      this.cache = []
    }
    return this.cache
  }

  async append(record: UsageRecord): Promise<void> {
    const records = await this.load()
    records.push(record)
    if (records.length > MAX_IN_MEMORY) records.splice(0, records.length - MAX_IN_MEMORY)
    await fs.mkdir(path.dirname(this.file()), { recursive: true })
    await this.rotateIfNeeded()
    await fs.appendFile(this.file(), `${JSON.stringify(record)}\n`, 'utf8')
  }

  /**
   * 大小轮转：best-effort，失败不抛（不能因轮转失败丢掉本条用量）。
   * 单进程主进程内串行调用，无并发竞态。
   */
  private async rotateIfNeeded(): Promise<void> {
    let size = 0
    try {
      size = (await fs.stat(this.file())).size
    } catch {
      return // 文件还不存在，无需轮转
    }
    if (size < MAX_FILE_BYTES) return
    try {
      await fs.rm(`${this.file()}.${MAX_FILES - 1}`, { force: true })
      for (let i = MAX_FILES - 2; i >= 1; i--) {
        try {
          await fs.rename(`${this.file()}.${i}`, `${this.file()}.${i + 1}`)
        } catch {
          // 中间代缺失是正常态（还没涨到那么多），跳过
        }
      }
      await fs.rename(this.file(), `${this.file()}.1`)
    } catch {
      // 轮转失败吞掉：下次 append 会再试
    }
  }

  async list(limit = 200): Promise<UsageRecord[]> {
    const records = await this.load()
    return records.slice(-limit).reverse()
  }

  async stats(): Promise<UsageStats> {
    return aggregate(await this.load())
  }

  async clear(): Promise<void> {
    this.cache = []
    await fs.mkdir(path.dirname(this.file()), { recursive: true })
    await fs.writeFile(this.file(), '', 'utf8')
  }
}

export const usageStore = new UsageStore()
