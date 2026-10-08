import type { Result } from '@shared/types'

/** 解包主进程返回的 Result，失败即抛错（由调用方 try/catch 统一提示） */
export async function unwrap<T>(p: Promise<Result<T>>): Promise<T> {
  const r = await p
  if (!r.ok) throw new Error(r.error)
  return r.value
}

/** 统一的错误文案提取 */
export function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

export const api = window.lagent
