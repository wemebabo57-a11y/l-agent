/** 数字与单位格式化。统一在这里，避免各组件各写一套。 */

export function formatInt(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(Math.round(n))
}

/** 大数压缩：12345 → 1.2万 */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (abs >= 1e4) return `${(n / 1e4).toFixed(2)}万`
  return formatInt(n)
}

export function formatPercent(ratio: number, digits = 1): string {
  if (!Number.isFinite(ratio)) return '—'
  return `${(ratio * 100).toFixed(digits)}%`
}

export function formatCost(usd: number | null): string {
  if (usd == null) return '—'
  if (usd === 0) return '$0'
  if (usd < 0.0001) return `$${usd.toExponential(2)}`
  if (usd < 1) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

export function formatMs(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

/** 相对时间：刚刚 / 3 分钟前 / 2 小时前 / 日期 */
export function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

export function shortPath(p: string, max = 46): string {
  if (p.length <= max) return p
  const parts = p.split(/[/\\]/)
  if (parts.length <= 2) return `…${p.slice(-max)}`
  return `${parts[0]}/…/${parts.slice(-2).join('/')}`
}
