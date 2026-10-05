import type { ModelPrice, Usage, UsageRecord, UsageStats } from './types'

/**
 * 内置价格表，单位：USD / 每 100 万 token。
 * 数据来源为各厂商公开定价页，仅作估算用途；用户可在供应商配置里覆盖。
 * 未命中时返回 null —— 宁可显示"未知"，也不编一个假数字。
 */
export const PRICE_TABLE: Record<string, ModelPrice> = {
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10, cachedInput: 1.25 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cachedInput: 0.075 },
  'gpt-4.1': { input: 2, output: 8, cachedInput: 0.5 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cachedInput: 0.1 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4, cachedInput: 0.025 },
  'o3': { input: 2, output: 8, cachedInput: 0.5 },
  'o4-mini': { input: 1.1, output: 4.4, cachedInput: 0.275 },
  // Anthropic
  'claude-opus-4': { input: 15, output: 75, cachedInput: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4': { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cachedInput: 0.08, cacheWrite: 1 },
  // DeepSeek
  'deepseek-chat': { input: 0.27, output: 1.1, cachedInput: 0.07 },
  'deepseek-reasoner': { input: 0.55, output: 2.19, cachedInput: 0.14 },
  // 通义千问
  'qwen-max': { input: 1.6, output: 6.4 },
  'qwen-plus': { input: 0.4, output: 1.2 },
  // 月之暗面
  'moonshot-v1-128k': { input: 1.68, output: 1.68 },
  // 智谱
  'glm-4-plus': { input: 0.7, output: 0.7 }
}

/** 前缀匹配：claude-sonnet-4-20250514 也能命中 claude-sonnet-4 */
export function lookupPrice(model: string): ModelPrice | null {
  if (!model) return null
  const key = model.toLowerCase()
  if (PRICE_TABLE[key]) return PRICE_TABLE[key]
  let best: ModelPrice | null = null
  let bestLen = 0
  for (const [name, price] of Object.entries(PRICE_TABLE)) {
    if (key.startsWith(name) && name.length > bestLen) {
      best = price
      bestLen = name.length
    }
  }
  return best
}

/** 按价格表估算单次请求费用；无价格返回 null */
export function estimateCost(usage: Usage, model: string): number | null {
  const price = lookupPrice(model)
  if (!price) return null
  const M = 1_000_000
  // 缓存读取部分按 cachedInput 计价，其余输入按 input 计价，避免重复计费
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens)
  const fresh = Math.max(usage.inputTokens - cached, 0)
  const inputCost =
    (fresh / M) * price.input +
    (cached / M) * (price.cachedInput ?? price.input) +
    (usage.cacheWriteTokens / M) * (price.cacheWrite ?? price.input)
  const outputCost = ((usage.outputTokens + usage.reasoningTokens) / M) * price.output
  return inputCost + outputCost
}

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimated: false
  }
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    estimated: a.estimated || b.estimated
  }
}

/** 缓存命中率 = 命中缓存的输入 token / 总输入 token */
export function cacheHitRate(usage: Pick<Usage, 'inputTokens' | 'cachedInputTokens'>): number {
  if (!usage.inputTokens) return 0
  return usage.cachedInputTokens / usage.inputTokens
}

export function aggregate(records: UsageRecord[]): UsageStats {
  const stats: UsageStats = {
    requests: records.length,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUSD: 0,
    cacheHitRate: 0,
    avgFirstTokenMs: 0,
    avgTokensPerSecond: 0
  }
  let firstTokenSum = 0
  let firstTokenCount = 0
  let tpsSum = 0
  let tpsCount = 0
  for (const r of records) {
    stats.inputTokens += r.inputTokens
    stats.outputTokens += r.outputTokens
    stats.cachedInputTokens += r.cachedInputTokens
    stats.cacheWriteTokens += r.cacheWriteTokens
    stats.reasoningTokens += r.reasoningTokens
    stats.costUSD += r.costUSD ?? 0
    if (r.firstTokenMs != null) {
      firstTokenSum += r.firstTokenMs
      firstTokenCount++
    }
    if (r.tokensPerSecond != null) {
      tpsSum += r.tokensPerSecond
      tpsCount++
    }
  }
  stats.cacheHitRate = cacheHitRate(stats)
  stats.avgFirstTokenMs = firstTokenCount ? Math.round(firstTokenSum / firstTokenCount) : 0
  stats.avgTokensPerSecond = tpsCount ? Math.round((tpsSum / tpsCount) * 10) / 10 : 0
  return stats
}
