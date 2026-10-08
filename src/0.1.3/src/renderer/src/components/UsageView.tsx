import { useCallback, useEffect, useState } from 'react'
import type { UsageRecord, UsageStats } from '@shared/types'
import { api, messageOf, unwrap } from '../lib/api'
import { formatCost, formatDateTime, formatInt, formatMs, formatPercent } from '../lib/format'
import { Alert, Button, Empty, Stat } from './ui'

export function UsageView({ onNotice }: { onNotice: (m: string, k?: 'error' | 'info') => void }): React.JSX.Element {
  const [stats, setStats] = useState<UsageStats | null>(null)
  const [records, setRecords] = useState<UsageRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([unwrap(api.usage.stats()), unwrap(api.usage.list(200))])
      setStats(s)
      setRecords(r)
      setError(null)
    } catch (e) {
      setError(messageOf(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
    // 每 5 秒刷新一次，让统计数据在对话中保持鲜活
    const t = setInterval(() => void refresh(), 5000)
    return () => clearInterval(t)
  }, [refresh])

  const clear = async (): Promise<void> => {
    try {
      await unwrap(api.usage.clear())
      setConfirmClear(false)
      await refresh()
      onNotice('用量记录已清空')
    } catch (e) {
      onNotice(messageOf(e), 'error')
    }
  }

  if (error) return <div className="page"><Alert kind="error">{error}</Alert></div>
  if (!stats) return <div className="page"><span className="spin" /></div>

  const hitRate = stats.cacheHitRate
  const estimatedCount = records.filter((r) => r.estimated).length

  return (
    <div className="page">
      <div className="page-narrow">
        <div className="row" style={{ marginBottom: 14 }}>
          <h2 className="page-title">用量统计</h2>
          <span className="muted tiny">共 {stats.requests} 次请求</span>
          <div className="topbar-spacer" />
          <Button size="sm" onClick={() => void refresh()}>
            刷新
          </Button>
          {confirmClear ? (
            <>
              <Button size="sm" variant="danger" onClick={() => void clear()}>
                确认清空
              </Button>
              <Button size="sm" onClick={() => setConfirmClear(false)}>
                取消
              </Button>
            </>
          ) : (
            <Button size="sm" variant="danger" onClick={() => setConfirmClear(true)}>
              清空记录
            </Button>
          )}
        </div>

        {stats.requests === 0 ? (
          <Empty title="还没有用量数据">
            发起一次对话后，这里会显示输入/输出 token、缓存命中率与费用估算。
          </Empty>
        ) : (
          <>
            <div className="stat-grid">
              <Stat
                label="输入 token"
                value={formatInt(stats.inputTokens)}
                sub={`其中命中缓存 ${formatInt(stats.cachedInputTokens)}`}
              />
              <Stat label="输出 token" value={formatInt(stats.outputTokens)} sub={`推理 ${formatInt(stats.reasoningTokens)}`} />
              <Stat
                label="缓存命中率"
                value={formatPercent(hitRate)}
                sub={`命中 ${formatInt(stats.cachedInputTokens)} / 输入 ${formatInt(stats.inputTokens)}`}
                ratio={hitRate}
                tone="ok"
              />
              <Stat
                label="估算费用"
                value={formatCost(stats.costUSD)}
                sub="按内置价格表估算，仅供参考"
              />
              <Stat label="平均首字延迟" value={formatMs(stats.avgFirstTokenMs)} sub="从发起到首个 token" />
              <Stat
                label="平均输出速度"
                value={`${stats.avgTokensPerSecond}`}
                sub="tok/s"
                tone="brass"
              />
            </div>

            {stats.cacheWriteTokens > 0 ? (
              <Alert kind="info">
                缓存写入 token：{formatInt(stats.cacheWriteTokens)}（Anthropic 缓存写入按输入价的 125% 计费）
              </Alert>
            ) : null}

            {estimatedCount > 0 ? (
              <Alert kind="warn">
                有 {estimatedCount} 条记录的用量为估算值——供应商在流式响应中未返回 usage，
                已按字符数推算（CJK 约 1 token/字）。上游若支持 stream_options.include_usage 则会返回实测值。
              </Alert>
            ) : null}

            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ maxHeight: 460, overflowY: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>供应商 / 模型</th>
                      <th className="num">输入</th>
                      <th className="num">输出</th>
                      <th className="num">命中缓存</th>
                      <th className="num">命中率</th>
                      <th className="num">首字</th>
                      <th className="num">tok/s</th>
                      <th className="num">费用</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((r) => (
                      <tr key={r.id}>
                        <td className="muted">{formatDateTime(r.at)}</td>
                        <td>
                          <span className="pill tiny">{r.providerName}</span>{' '}
                          <span className="mono tiny">{r.model}</span>
                          {r.failed ? <span className="pill pill-danger tiny">失败</span> : null}
                        </td>
                        <td className="num">{formatInt(r.inputTokens)}</td>
                        <td className="num">{formatInt(r.outputTokens)}</td>
                        <td className="num" style={{ color: r.cachedInputTokens ? 'var(--ok)' : undefined }}>
                          {formatInt(r.cachedInputTokens)}
                        </td>
                        <td className="num">
                          {formatPercent(r.cachedInputTokens / Math.max(r.inputTokens, 1), 0)}
                        </td>
                        <td className="num">{formatMs(r.firstTokenMs)}</td>
                        <td className="num">{r.tokensPerSecond ?? '—'}</td>
                        <td className="num">{formatCost(r.costUSD)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="tiny muted" style={{ marginTop: 8 }}>
              费用为按公开定价估算，未含批量折扣、阶梯价与代理加价；「—」表示该模型不在内置价格表中。
            </div>
          </>
        )}
      </div>
    </div>
  )
}
