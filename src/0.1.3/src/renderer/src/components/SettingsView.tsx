import { useEffect, useState } from 'react'
import type {
  AppSettings,
  BackupStatus,
  BackupTarget,
  CapabilityReport,
  PermissionMode,
  ProviderConfig,
  ProviderInput,
  ProviderKind,
  ScreenInfo,
  ActiveWindowInfo,
  ToolCatalogEntry
} from '@shared/types'
import { api, messageOf, unwrap } from '../lib/api'
import { Alert, Button, Empty, Field, Modal, Pill, Spinner, Switch } from './ui'
import { IconAlert, IconCheck, IconRefresh, IconScreen, IconTerminal } from './icons'

/** 常见供应商预设，减少手填 baseURL 出错 */
const PRESETS: { name: string; kind: ProviderKind; baseURL: string; models: string[]; note: string }[] = [
  {
    name: 'OpenAI',
    kind: 'openai',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o3', 'o4-mini'],
    note: '官方接口，支持 prompt caching 自动命中'
  },
  {
    name: 'Anthropic',
    kind: 'anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    models: ['claude-opus-4-20250514', 'claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022'],
    note: '需要显式设置 cache_control 才有缓存命中'
  },
  {
    name: 'DeepSeek',
    kind: 'openai',
    baseURL: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    note: '上下文硬盘缓存自动生效，价格低廉'
  },
  {
    name: '阿里云通义千问',
    kind: 'openai',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
    note: 'OpenAI 兼容模式'
  },
  {
    name: '月之暗面 Kimi',
    kind: 'openai',
    baseURL: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-128k', 'moonshot-v1-32k'],
    note: ''
  },
  {
    name: '智谱 GLM',
    kind: 'openai',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-air'],
    note: ''
  },
  {
    name: '本地 Ollama',
    kind: 'openai',
    baseURL: 'http://localhost:11434/v1',
    models: ['qwen2.5-coder:14b', 'llama3.1:8b'],
    note: '无需 API Key，模型名需与本地已拉取的一致'
  },
  {
    name: '自定义 / 网关',
    kind: 'openai',
    baseURL: '',
    models: [],
    note: '任何 OpenAI 兼容端点'
  }
]

/** 附加请求头：文本（每行 Name: value）与对象的互转 */
function headersToText(h?: Record<string, string>): string {
  if (!h) return ''
  return Object.entries(h)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}

function parseHeaders(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const i = t.indexOf(':')
    if (i <= 0) throw new Error(`请求头格式错误：${t}（应为 Name: value，每行一个）`)
    const k = t.slice(0, i).trim()
    const v = t.slice(i + 1).trim()
    if (!k || !v) throw new Error(`请求头格式错误：${t}（名与值都不能为空）`)
    out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

export function SettingsView({
  settings,
  providers,
  onSettingsChanged,
  onProvidersChanged,
  onNotice,
  weakKeyStorage
}: {
  settings: AppSettings
  providers: ProviderConfig[]
  onSettingsChanged: (s: AppSettings) => void
  onProvidersChanged: () => void
  onNotice: (m: string, k?: 'error' | 'info') => void
  weakKeyStorage: boolean
}): React.JSX.Element {
  const [editing, setEditing] = useState<ProviderInput | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  /** 附加请求头的文本形态（每行 Name: value），保存时再解析 */
  const [headersText, setHeadersText] = useState('')
  const [testing, setTesting] = useState<string | null>(null)
  /** 供应商连通性测试结果：ok 决定图标与配色，text 是给人看的说明 */
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; text: string } | undefined>>({})
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<ProviderConfig | null>(null)

  const [appInfo, setAppInfo] = useState<Record<string, unknown> | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        setAppInfo(await unwrap(api.app.info()))
      } catch {
        /* 忽略 */
      }
    })()
  }, [])

  const startNew = (preset?: (typeof PRESETS)[number]): void => {
    setFormError(null)
    setEditingId(null)
    setHeadersText('')
    setEditing({
      name: preset?.name ?? '',
      kind: preset?.kind ?? 'openai',
      baseURL: preset?.baseURL ?? '',
      apiKey: '',
      models: preset?.models ?? [],
      enabled: true,
      temperature: 0.7,
      maxTokens: null,
      headers: undefined
    })
  }

  const startEdit = (p: ProviderConfig): void => {
    setFormError(null)
    setEditingId(p.id)
    setHeadersText(headersToText(p.headers))
    setEditing({
      id: p.id,
      name: p.name,
      kind: p.kind,
      baseURL: p.baseURL,
      // 留空表示不修改已存的 key
      apiKey: undefined,
      models: [...p.models],
      enabled: p.enabled,
      temperature: p.temperature,
      maxTokens: p.maxTokens,
      headers: p.headers
    })
  }

  const save = async (): Promise<void> => {
    if (!editing) return
    let headers: Record<string, string> | undefined
    try {
      headers = parseHeaders(headersText)
    } catch (e) {
      setFormError(messageOf(e))
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      await unwrap(api.providers.save({ ...editing, headers }))
      setEditing(null)
      onProvidersChanged()
      onNotice('供应商已保存')
    } catch (e) {
      setFormError(messageOf(e))
    } finally {
      setSaving(false)
    }
  }

  const test = async (p: ProviderConfig): Promise<void> => {
    setTesting(p.id)
    setTestResult((r) => ({ ...r, [p.id]: undefined }))
    try {
      const res = await unwrap(api.providers.test(p.id))
      setTestResult((r) => ({ ...r, [p.id]: { ok: true, text: `${res.message}（${res.latencyMs}ms）` } }))
    } catch (e) {
      setTestResult((r) => ({ ...r, [p.id]: { ok: false, text: messageOf(e) } }))
    } finally {
      setTesting(null)
    }
  }

  const remove = async (): Promise<void> => {
    if (!confirmDelete) return
    try {
      await unwrap(api.providers.remove(confirmDelete.id))
      setConfirmDelete(null)
      onProvidersChanged()
      onNotice('已删除供应商及其密钥')
    } catch (e) {
      onNotice(messageOf(e), 'error')
    }
  }

  const updateSettings = async (patch: Partial<AppSettings>): Promise<void> => {
    try {
      const next = await unwrap(api.settings.update(patch))
      onSettingsChanged(next)
    } catch (e) {
      onNotice(messageOf(e), 'error')
    }
  }

  /** PermissionSection / CapabilitySection 的统一写入口 */
  const patchSettings = updateSettings

  const fetchModels = async (): Promise<void> => {
    if (!editing?.id) {
      setFormError('请先保存该供应商，再拉取模型列表')
      return
    }
    setSaving(true)
    try {
      const models = await unwrap(api.providers.models(editing.id))
      setEditing({ ...editing, models })
      onNotice(`已拉取 ${models.length} 个模型`)
    } catch (e) {
      setFormError(messageOf(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page">
      <div className="page-narrow">
        {weakKeyStorage ? (
          <Alert kind="warn">
            当前系统未提供可用的密钥加密后端（常见于无桌面环境的 Linux），API Key 与 GitHub 令牌仅以 Base64
            编码存储，<strong>不具备真实加密保护</strong>。请勿在共享机器上使用。
          </Alert>
        ) : null}

        <AppearanceSection settings={settings} onChange={(patch) => void patchSettings(patch)} />
        <PermissionSection settings={settings} onChange={(patch) => void patchSettings(patch)} />
        <CapabilitySection settings={settings} onChange={(patch) => void patchSettings(patch)} onNotice={onNotice} />
        <ToolCatalogSection />
        <BackupSection settings={settings} onChange={(patch) => void patchSettings(patch)} onNotice={onNotice} />

        <div className="row" style={{ marginBottom: 14 }}>
          <h2 className="page-title">AI 供应商</h2>
          <span className="muted tiny">{providers.length} 个已配置</span>
          <div className="topbar-spacer" />
          <Button size="sm" variant="primary" onClick={() => startNew()}>
            添加供应商
          </Button>
        </div>

        <div className="card">
          <div className="card-head">
            <span className="card-title">快速添加</span>
            <span className="muted tiny">选一个预设，只需填 API Key</span>
          </div>
          <div className="row row-wrap">
            {PRESETS.map((p) => (
              <Button key={p.name} size="sm" onClick={() => startNew(p)} title={p.note}>
                {p.name}
              </Button>
            ))}
          </div>
        </div>

        {providers.length === 0 ? (
          <Empty title="还没有配置任何 AI 供应商">
            添加一个供应商并填入 API Key，即可开始对话。支持 OpenAI 兼容协议与 Anthropic 协议。
          </Empty>
        ) : (
          providers.map((p) => (
            <div key={p.id} className="card">
              <div className="row row-wrap">
                <strong>{p.name}</strong>
                <Pill kind={p.kind === 'anthropic' ? 'accent' : undefined}>
                  {p.kind === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'}
                </Pill>
                {p.enabled ? <Pill kind="ok">启用</Pill> : <Pill>停用</Pill>}
                {p.hasKey ? (
                  <Pill kind="ok">密钥 {p.keyMask}</Pill>
                ) : (
                  <Pill kind="warn">无密钥</Pill>
                )}
                <div className="topbar-spacer" />
                <Button size="sm" onClick={() => void test(p)} disabled={testing === p.id}>
                  {testing === p.id ? <Spinner /> : null} 测试连接
                </Button>
                <Button size="sm" onClick={() => startEdit(p)}>
                  编辑
                </Button>
                <Button size="sm" variant="danger" onClick={() => setConfirmDelete(p)}>
                  删除
                </Button>
              </div>
              <div className="muted tiny mono" style={{ marginTop: 6 }}>
                {p.baseURL}
              </div>
              <div className="muted tiny" style={{ marginTop: 3 }}>
                模型：{p.models.length ? p.models.slice(0, 5).join('、') + (p.models.length > 5 ? ` 等 ${p.models.length} 个` : '') : '（未配置，需手动输入模型名）'}
                {p.maxTokens ? ` · 最大输出 ${p.maxTokens}` : ''} · 温度 {p.temperature}
                {p.headers && Object.keys(p.headers).length ? ` · 请求头 ${Object.keys(p.headers).length} 个` : ''}
              </div>
              {testResult[p.id] ? (
                <div
                  className="tiny row"
                  style={{
                    marginTop: 6,
                    gap: 5,
                    color: testResult[p.id]!.ok ? 'var(--ok)' : 'var(--danger)'
                  }}
                >
                  {testResult[p.id]!.ok ? <IconCheck size={12} /> : <IconAlert size={12} />}
                  <span>{testResult[p.id]!.text}</span>
                </div>
              ) : null}
            </div>
          ))
        )}

        <h2 className="page-title" style={{ marginTop: 22, marginBottom: 12 }}>关于</h2>
        <div className="card">
          {appInfo ? (
            <div className="muted tiny mono" style={{ lineHeight: 1.9 }}>
              lagent v{String(appInfo.version)} · Electron {String(appInfo.electron)} · Node{' '}
              {String(appInfo.node)} · Chromium {String(appInfo.chrome)}
              <br />
              数据目录：{String(appInfo.dataDir)}
              <br />
              密钥加密：{appInfo.encryptionAvailable ? '系统密钥链可用' : '不可用（降级为编码存储）'}
            </div>
          ) : (
            <Spinner />
          )}
        </div>
      </div>

      {editing ? (
        <Modal
          title={editingId ? '编辑供应商' : '添加供应商'}
          onClose={() => setEditing(null)}
          wide
          footer={
            <>
              <Button onClick={() => setEditing(null)} disabled={saving}>
                取消
              </Button>
              <Button variant="primary" onClick={() => void save()} disabled={saving}>
                {saving ? <Spinner /> : null} 保存
              </Button>
            </>
          }
        >
          {formError ? <Alert kind="error">{formError}</Alert> : null}

          <div className="row" style={{ gap: 10 }}>
            <div style={{ flex: 1 }}>
              <Field label="名称">
                <input
                  className="input"
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="例如 我的 OpenAI"
                />
              </Field>
            </div>
            <div style={{ flex: 1 }}>
              <Field label="协议" hint="决定请求体与用量字段的解析方式">
                <select
                  className="select"
                  value={editing.kind}
                  onChange={(e) => setEditing({ ...editing, kind: e.target.value as ProviderKind })}
                >
                  <option value="openai">OpenAI 兼容（/chat/completions）</option>
                  <option value="anthropic">Anthropic（/messages）</option>
                </select>
              </Field>
            </div>
          </div>

          <Field
            label="Base URL"
            hint="不含末尾斜杠。OpenAI 兼容需以 /v1 结尾；Anthropic 为 https://api.anthropic.com/v1"
          >
            <input
              className="input mono"
              value={editing.baseURL}
              onChange={(e) => setEditing({ ...editing, baseURL: e.target.value })}
              placeholder="https://api.openai.com/v1"
            />
          </Field>

          <Field
            label={editingId ? 'API Key（留空则不修改）' : 'API Key'}
            hint={
              editing.kind === 'anthropic'
                ? 'Anthropic 必须提供密钥。缓存用量会从 cache_read / cache_creation 字段读取。'
                : '本地服务（如 Ollama）可留空。缓存命中率从 prompt_tokens_details.cached_tokens 读取。'
            }
          >
            <input
              className="input mono"
              type="password"
              value={editing.apiKey ?? ''}
              onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
              placeholder={editingId ? '（不修改）' : 'sk-…'}
            />
          </Field>

          <Field label="附加请求头" hint="自定义网关鉴权用，每行一个 Name: value。会随每次请求发送，测试连接与拉模型同样携带">
            <textarea
              className="textarea mono"
              rows={2}
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              placeholder={'X-Api-Key: xxx\nX-Custom-Header: yyy'}
            />
          </Field>

          <div className="row" style={{ gap: 10 }}>
            <div style={{ flex: 1 }}>
              <Field label="温度" hint="0~2，Anthropic 会被限制在 1 以内">
                <input
                  className="input"
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  value={editing.temperature}
                  onChange={(e) => setEditing({ ...editing, temperature: Number(e.target.value) })}
                />
              </Field>
            </div>
            <div style={{ flex: 1 }}>
              <Field label="最大输出 token" hint="留空用服务端默认">
                <input
                  className="input"
                  type="number"
                  min="1"
                  value={editing.maxTokens ?? ''}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      maxTokens: e.target.value === '' ? null : Number(e.target.value)
                    })
                  }
                />
              </Field>
            </div>
          </div>

          <Field label="模型列表" hint="每行一个。可点下方按钮从 /models 拉取。">
            <textarea
              className="textarea"
              rows={5}
              value={editing.models.join('\n')}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  models: e.target.value
                    .split('\n')
                    .map((s) => s.trim())
                    .filter(Boolean)
                })
              }
              placeholder={'gpt-4o\ngpt-4o-mini'}
            />
          </Field>
          <Button size="sm" onClick={() => void fetchModels()} disabled={saving}>
            从 /models 拉取模型列表
          </Button>

          <label className="row" style={{ gap: 8, cursor: 'pointer', marginTop: 14 }}>
            <input
              type="checkbox"
              checked={editing.enabled}
              onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
            />
            <span>启用该供应商</span>
          </label>
        </Modal>
      ) : null}

      {confirmDelete ? (
        <Modal
          title="删除供应商"
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <Button onClick={() => setConfirmDelete(null)}>取消</Button>
              <Button variant="danger" onClick={() => void remove()}>
                确认删除
              </Button>
            </>
          }
        >
          将删除 <strong>{confirmDelete.name}</strong> 及其保存的 API Key。此操作不可撤销。
        </Modal>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 工具目录                                                           */
/* ------------------------------------------------------------------ */

/** 风险等级的中文：在工具目录里让用户一眼看懂每个工具的危险程度 */
const TOOL_RISK_LABEL: Record<ToolCatalogEntry['risk'], string> = {
  read: '只读',
  write: '写入',
  delete: '删除',
  remote: '远端',
  shell: '命令',
  screen: '屏幕'
}

/**
 * 工具目录：当前设置下助手实际能用的工具一览。
 * 能力开关（控制台/屏幕）关闭时，对应工具根本不会出现在这里——
 * 所见即模型可见，避免「以为有其实没有」的误解。
 */
function ToolCatalogSection(): React.JSX.Element {
  const [tools, setTools] = useState<ToolCatalogEntry[] | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        setTools(await unwrap(api.tools.list()))
      } catch {
        setTools([])
      }
    })()
  }, [])

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 className="page-title">工具目录</h2>
        <span className="muted tiny">{tools ? `${tools.length} 个可用` : '读取中…'}</span>
      </div>

      <div className="card">
        {!tools ? (
          <Spinner />
        ) : tools.length === 0 ? (
          <div className="muted tiny">当前没有可用工具（请检查能力开关）</div>
        ) : (
          tools.map((t) => (
            <div key={t.name} className="row" style={{ gap: 8, padding: '5px 0', alignItems: 'baseline' }}>
              <span className="mono" style={{ minWidth: 130, fontSize: 12 }}>
                {t.name}
              </span>
              <Pill>{TOOL_RISK_LABEL[t.risk] ?? t.risk}</Pill>
              <span className="muted tiny" style={{ flex: 1 }}>
                {t.description}
                {t.note ? `（${t.note}）` : ''}
              </span>
            </div>
          ))
        )}
        <div className="field-hint" style={{ marginTop: 8 }}>
          风险等级由工具实现静态声明，模型无法改写；实际执行仍受上方权限档位约束。
        </div>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* 自动备份（git 仓库：本地 / GitHub / 自定义远端）                      */
/* ------------------------------------------------------------------ */

const BACKUP_TARGETS: { id: BackupTarget; label: string; summary: string }[] = [
  { id: 'local', label: '本地仓库', summary: '推到本机某个目录（空目录会自动建成裸仓库），不经过网络' },
  { id: 'github', label: 'GitHub 仓库', summary: '复用 GitHub 页的令牌推送，不存在可一键建空私有库' },
  { id: 'custom', label: '自定义远端', summary: 'GitCode、自建 GitLab/Gitea 等，填远端 URL（https 或 ssh）' }
]

function BackupSection({
  settings,
  onChange,
  onNotice
}: {
  settings: AppSettings
  onChange: (patch: Partial<AppSettings>) => void
  onNotice: (m: string, k?: 'error' | 'info') => void
}): React.JSX.Element {
  const cfg = settings.backup
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [busy, setBusy] = useState<'test' | 'run' | 'token' | 'repo' | null>(null)
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [showRepoMissing, setShowRepoMissing] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  /** 正在备份中的工作区名（事件驱动，比轮询快半拍） */
  const [activeNames, setActiveNames] = useState<string[]>([])

  const refresh = async (): Promise<void> => {
    try {
      setStatus(await unwrap(api.backup.status()))
    } catch {
      /* 主进程未就绪时保持空白 */
    }
  }

  useEffect(() => {
    void refresh()
    // 进度事件：备份长耗时，靠事件推进度，不靠轮询猜
    const off = api.backup.onEvent((e) => {
      if (e.type === 'workspace-start') {
        setActiveNames((prev) => (prev.includes(e.name) ? prev : [...prev, e.name]))
      } else if (e.type === 'workspace-done') {
        setActiveNames((prev) => prev.filter((n) => n !== e.result.name))
        // 逐个更新结果行，不用等整轮结束
        setStatus((s) =>
          s
            ? { ...s, results: [...s.results.filter((r) => r.workspaceId !== e.result.workspaceId), e.result] }
            : s
        )
      } else if (e.type === 'run-done') {
        setActiveNames([])
        void refresh()
      }
    })
    return off
  }, [])

  // 自适应轮询：跑起来 5s 看一次进度；只开着 60s 看一次；关着就不轮询
  useEffect(() => {
    if (!cfg.enabled && !status?.running) return
    const ms = status?.running ? 5_000 : 60_000
    const timer = setInterval(() => {
      void refresh()
    }, ms)
    return () => clearInterval(timer)
  }, [cfg.enabled, status?.running])

  const patchBackup = (patch: Partial<AppSettings['backup']>): void => {
    onChange({ backup: { ...cfg, ...patch } })
    setTestMsg(null)
    setShowRepoMissing(false)
  }

  const doTest = async (): Promise<void> => {
    setBusy('test')
    setTestMsg(null)
    setShowRepoMissing(false)
    try {
      const r = await unwrap(api.backup.test())
      setTestMsg({ ok: r.ok, text: r.message })
      if (!r.ok && r.code === 'repo-missing') setShowRepoMissing(true)
    } catch (e) {
      setTestMsg({ ok: false, text: messageOf(e) })
    } finally {
      setBusy(null)
    }
  }

  const doRun = async (): Promise<void> => {
    setBusy('run')
    try {
      const s = await unwrap(api.backup.run())
      setStatus(s)
      onNotice(s.message ?? '备份完成', s.results.some((r) => !r.ok) ? 'error' : 'info')
    } catch (e) {
      onNotice(messageOf(e), 'error')
    } finally {
      setBusy(null)
      void refresh()
    }
  }

  const doCreateRepo = async (): Promise<void> => {
    setBusy('repo')
    try {
      const r = await unwrap(api.backup.createRepo())
      onNotice(`已创建私有仓库 ${r.fullName}`)
      setShowRepoMissing(false)
      void doTest()
    } catch (e) {
      onNotice(messageOf(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  const doSaveToken = async (): Promise<void> => {
    if (!tokenInput.trim()) return
    setBusy('token')
    try {
      await unwrap(api.backup.setToken(tokenInput.trim()))
      setTokenInput('')
      onNotice('远端令牌已保存')
      void refresh()
    } catch (e) {
      onNotice(messageOf(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  const doClearToken = async (): Promise<void> => {
    setBusy('token')
    try {
      await unwrap(api.backup.clearToken())
      onNotice('远端令牌已清除')
      void refresh()
    } catch (e) {
      onNotice(messageOf(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  const pickDir = async (): Promise<void> => {
    try {
      const dir = await unwrap(api.backup.pickDir())
      if (dir) patchBackup({ localPath: dir })
    } catch (e) {
      onNotice(messageOf(e), 'error')
    }
  }

  const fmtTime = (t: number | null): string =>
    t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—'

  /** 上次运行里失败的工作区名：钉一个常驻提醒，直到下一次全成功 */
  const lastFailed = (status?.results ?? []).filter((r) => !r.ok).map((r) => r.name)

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 className="page-title">自动备份</h2>
        <span className="muted tiny">定时把全部工作区推到 git 远端，默认关闭</span>
      </div>

      <div className="card">
        <div className="card-head">
          <span className="card-title" style={{ flex: 1 }}>
            备份目标
          </span>
          <Switch
            checked={cfg.enabled}
            onChange={(v) => patchBackup({ enabled: v })}
            title="打开后按间隔自动备份全部工作区"
          />
        </div>
        <div className="field-hint">
          备份只做三件事：提交当前改动（提交信息固定前缀）、推送到独立分支
          <span className="mono"> {cfg.branch || 'lagent-backup'}</span>
          。远端用独立名称，不动你自己的 <span className="mono">origin</span>；从不强推，远端分叉会报错等人看。
          无改动时跳过提交。工作区若没有 <span className="mono">.gitignore</span> 会自动建一份（防
          node_modules 进备份）。
        </div>

        <div className="mode-grid" style={{ marginTop: 10 }}>
          {BACKUP_TARGETS.map((t) => (
            <button
              key={t.id}
              className={`mode-card${cfg.target === t.id ? ' active' : ''}`}
              onClick={() => patchBackup({ target: t.id })}
            >
              <div className="mode-card-head">
                <span className="mode-card-title">{t.label}</span>
                {cfg.target === t.id ? <Pill kind="accent">当前</Pill> : null}
              </div>
              <div className="mode-card-summary">{t.summary}</div>
            </button>
          ))}
        </div>

        {cfg.target === 'local' ? (
          <Field label="本地裸仓库目录" hint="空目录会自动初始化为裸仓库；非空目录必须是裸仓库才会继续">
            <div className="row" style={{ gap: 8 }}>
              <input
                className="input mono"
                style={{ flex: 1 }}
                value={cfg.localPath}
                onChange={(e) => patchBackup({ localPath: e.target.value })}
                placeholder="例如 D:\backup\lagent.git"
              />
              <Button size="sm" onClick={() => void pickDir()}>
                选择目录
              </Button>
            </div>
          </Field>
        ) : null}

        {cfg.target === 'github' ? (
          <>
            <div className="row" style={{ gap: 10 }}>
              <div style={{ flex: 1 }}>
                <Field label="仓库所有者" hint="个人用户名或组织名">
                  <input
                    className="input mono"
                    value={cfg.githubOwner}
                    onChange={(e) => patchBackup({ githubOwner: e.target.value })}
                    placeholder="octocat"
                  />
                </Field>
              </div>
              <div style={{ flex: 1 }}>
                <Field label="仓库名" hint="不存在时可一键创建空私有库">
                  <input
                    className="input mono"
                    value={cfg.githubRepo}
                    onChange={(e) => patchBackup({ githubRepo: e.target.value })}
                    placeholder="lagent-backup"
                  />
                </Field>
              </div>
            </div>
            <div className="field-hint" style={{ marginTop: 0 }}>
              推送复用「GitHub」页已保存的访问令牌（需含 repo 权限）。令牌只活在主进程内存与系统密钥链里，报错信息会自动脱敏。
            </div>
            {showRepoMissing ? (
              <div className="row" style={{ marginTop: 8 }}>
                <Button size="sm" variant="primary" disabled={busy === 'repo'} onClick={() => void doCreateRepo()}>
                  {busy === 'repo' ? <Spinner /> : null} 创建空私有仓库
                </Button>
              </div>
            ) : null}
          </>
        ) : null}

        {cfg.target === 'custom' ? (
          <>
            <Field label="远端 URL" hint="https://gitcode.com/…/.git 或 git@… 形式；ssh 远端走你自己的 key/agent">
              <input
                className="input mono"
                value={cfg.customUrl}
                onChange={(e) => patchBackup({ customUrl: e.target.value })}
                placeholder="https://gitcode.com/username/backup.git"
              />
            </Field>
            <Field
              label="远端令牌"
              hint="https 远端需要鉴权时填写，以 oauth2:令牌 注入（兼容 GitLab / GitCode / Gitee 系）；已可直接写进 URL 的不用填"
            >
              <div className="row" style={{ gap: 8 }}>
                <input
                  className="input mono"
                  style={{ flex: 1 }}
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder={status?.hasCustomToken ? '（已保存，留空则不修改）' : '粘贴个人访问令牌'}
                />
                <Button size="sm" disabled={busy === 'token' || !tokenInput.trim()} onClick={() => void doSaveToken()}>
                  保存令牌
                </Button>
                {status?.hasCustomToken ? (
                  <Button size="sm" variant="danger" disabled={busy === 'token'} onClick={() => void doClearToken()}>
                    清除
                  </Button>
                ) : null}
              </div>
            </Field>
          </>
        ) : null}

        <div className="row" style={{ gap: 10, marginTop: 6 }}>
          <div style={{ flex: 1 }}>
            <Field label="远端分支名" hint="推送到的分支，默认独立分支不污染你的分支">
              <input
                className="input mono"
                value={cfg.branch}
                onChange={(e) => patchBackup({ branch: e.target.value })}
                placeholder="lagent-backup"
              />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="自动间隔（分钟）" hint="5~1440，打开开关后按此间隔轮询">
              <input
                className="input"
                type="number"
                min={5}
                max={1440}
                value={cfg.intervalMinutes}
                onChange={(e) =>
                  patchBackup({ intervalMinutes: Math.min(1440, Math.max(5, Number(e.target.value) || 30)) })
                }
              />
            </Field>
          </div>
        </div>

        <div className="row" style={{ marginTop: 4 }}>
          <Button size="sm" disabled={busy === 'test'} onClick={() => void doTest()}>
            {busy === 'test' ? <Spinner /> : null} 测试连接
          </Button>
          <Button size="sm" variant="primary" disabled={busy === 'run'} onClick={() => void doRun()}>
            {busy === 'run' ? <Spinner /> : null} 立即备份
          </Button>
          {status && !status.gitAvailable ? (
            <span className="tiny" style={{ color: 'var(--danger)' }}>
              未检测到 git，请先安装
            </span>
          ) : null}
        </div>

        {testMsg ? <Alert kind={testMsg.ok ? 'info' : 'error'}>{testMsg.text}</Alert> : null}

        {/* 上次自动备份挂了就钉在这里：用户不点开也看得见，不用靠回忆去翻历史 */}
        {lastFailed.length ? (
          <Alert kind="error">
            上次自动备份 {lastFailed.length} 个工作区失败：{lastFailed.join('、')}。点「立即备份」重试，持续失败请看各行报错。
          </Alert>
        ) : null}

        <div className="muted tiny" style={{ marginTop: 10, lineHeight: 1.9 }}>
          上次备份：{fmtTime(status?.lastRunAt ?? null)}
          {status?.nextRunAt && cfg.enabled ? ` · 下次约 ${fmtTime(status.nextRunAt)}` : ''}
          {status?.running || activeNames.length ? ` · 正在备份 ${activeNames.join('、') || '…'}` : ''}
        </div>
        {(status?.results.length ?? 0) > 0 ? (
          <div style={{ marginTop: 6 }}>
            {status!.results.map((r) => (
              <div key={r.workspaceId} className="row" style={{ gap: 8, padding: '4px 0', alignItems: 'baseline' }}>
                <span style={{ fontSize: 12, minWidth: 90 }}>{r.name}</span>
                {r.ok ? (
                  <Pill kind={r.clean ? undefined : 'ok'}>{r.clean ? '无变化' : '已推送'}</Pill>
                ) : (
                  <Pill kind="warn">失败</Pill>
                )}
                <span className="muted tiny" style={{ flex: 1 }}>
                  {r.message}
                  {r.commitSha ? `（${r.commitSha.slice(0, 7)}）` : ''}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {(status?.history.length ?? 0) > 0 ? (
          <div style={{ marginTop: 8 }}>
            <div className="muted tiny" style={{ marginBottom: 4 }}>
              历史记录（最近 {status!.history.length} 次）
            </div>
            {status!.history.slice(0, 5).map((h) => (
              <div key={h.at} className="row" style={{ gap: 8, padding: '3px 0', alignItems: 'baseline' }}>
                <span className="muted tiny" style={{ minWidth: 130 }}>
                  {fmtTime(h.at)}
                </span>
                {h.failedNames.length ? (
                  <Pill kind="warn">
                    {h.okCount}/{h.total} 成功
                  </Pill>
                ) : (
                  <Pill kind="ok">
                    {h.okCount}/{h.total} 成功
                  </Pill>
                )}
                {h.failedNames.length ? (
                  <span className="tiny" style={{ color: 'var(--danger-text)', flex: 1 }}>
                    失败：{h.failedNames.join('、')}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* 外观                                                                 */
/* ------------------------------------------------------------------ */

const THEMES: { id: AppSettings['theme']; label: string; summary: string }[] = [
  { id: 'dark', label: '深暖', summary: '暖陶土深底，默认' },
  { id: 'light', label: '米纸', summary: '浅纸张，强光下更清楚' },
  { id: 'system', label: '跟随系统', summary: '随操作系统浅色/深色自动切换' }
]

function AppearanceSection({
  settings,
  onChange
}: {
  settings: AppSettings
  onChange: (patch: Partial<AppSettings>) => void
}): React.JSX.Element {
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 className="page-title">外观</h2>
        <span className="muted tiny">深暖 / 米纸 / 跟随系统</span>
      </div>

      <div className="card">
        <div className="mode-grid">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`mode-card${settings.theme === t.id ? ' active' : ''}`}
              onClick={() => onChange({ theme: t.id })}
            >
              <div className="mode-card-head">
                <span className="mode-card-title">{t.label}</span>
                {settings.theme === t.id ? <Pill kind="accent">当前</Pill> : null}
              </div>
              <div className="mode-card-summary">{t.summary}</div>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* 权限档位                                                            */
/* ------------------------------------------------------------------ */

const MODES: {
  id: PermissionMode
  label: string
  summary: string
  allow: string[]
  ask: string[]
}[] = [
  {
    id: 'full',
    label: '完全权限',
    summary: '所有工具直接执行，任何操作都不再询问。',
    allow: ['读写工作区内外的文件', '执行任意控制台命令', '截屏、点击、输入'],
    ask: []
  },
  {
    id: 'workspace',
    label: '在工作区内更改',
    summary: '工作区内的文件操作自由执行，越出工作区的一律确认。',
    allow: ['读取文件', '工作区内新建/修改文件'],
    ask: ['工作区外的写入', '执行命令', '屏幕操作', 'GitHub 远端提交', '删除']
  },
  {
    id: 'smart',
    label: '智能',
    summary: '按操作本身的风险分级：只读放行，有副作用的询问，并显示模型自评的风险。',
    allow: ['读取文件', '搜索代码', '只读查询'],
    ask: ['写入与删除', '执行命令', '屏幕操作', 'GitHub 远端提交']
  }
]

function PermissionSection({
  settings,
  onChange
}: {
  settings: AppSettings
  onChange: (patch: Partial<AppSettings>) => void
}): React.JSX.Element {
  const current = MODES.find((m) => m.id === settings.permissionMode) ?? MODES[2]

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 className="page-title">权限</h2>
        <span className="muted tiny">决定助手做哪些事需要你点头</span>
      </div>

      <div className="card">
        <div className="mode-grid">
          {MODES.map((m) => (
            <button
              key={m.id}
              className={`mode-card${settings.permissionMode === m.id ? ' active' : ''}${m.id === 'full' ? ' mode-danger' : ''}`}
              onClick={() => onChange({ permissionMode: m.id })}
            >
              <div className="mode-card-head">
                <span className="mode-card-title">{m.label}</span>
                {settings.permissionMode === m.id ? <Pill kind="accent">当前</Pill> : null}
              </div>
              <div className="mode-card-summary">{m.summary}</div>
            </button>
          ))}
        </div>

        <div className="mode-detail">
          {current.allow.length ? (
            <div className="row row-wrap" style={{ gap: 6, marginBottom: 6 }}>
              <span className="tiny" style={{ color: 'var(--ok)', minWidth: 52 }}>
                直接执行
              </span>
              {current.allow.map((a) => (
                <span key={a} className="pill tiny">
                  {a}
                </span>
              ))}
            </div>
          ) : null}
          {current.ask.length ? (
            <div className="row row-wrap" style={{ gap: 6 }}>
              <span className="tiny" style={{ color: 'var(--warn)', minWidth: 52 }}>
                需要确认
              </span>
              {current.ask.map((a) => (
                <span key={a} className="pill tiny pill-warn">
                  {a}
                </span>
              ))}
            </div>
          ) : (
            <div className="tiny" style={{ color: 'var(--danger)' }}>
              没有任何操作会被拦截。助手可以在你不知情的情况下改动文件、执行命令、操作鼠标键盘。
            </div>
          )}
        </div>

        {settings.permissionMode === 'full' ? (
          <Alert kind="warn">
            完全权限下，模型的一次错误判断就可能造成不可逆的改动。建议仅在隔离环境或你完全信任当前任务时使用。
          </Alert>
        ) : null}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* 控制台与屏幕能力                                                     */
/* ------------------------------------------------------------------ */

function CapabilitySection({
  settings,
  onChange,
  onNotice
}: {
  settings: AppSettings
  onChange: (patch: Partial<AppSettings>) => void
  onNotice: (m: string, k?: 'error' | 'info') => void
}): React.JSX.Element {
  const [capabilities, setCapabilities] = useState<CapabilityReport | null>(null)
  const [displays, setDisplays] = useState<ScreenInfo[]>([])
  const [active, setActive] = useState<ActiveWindowInfo | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refreshCaps = async (): Promise<void> => {
    try {
      const res = await unwrap(api.screen.list())
      setCapabilities(res.capabilities)
      setDisplays(res.displays)
      setActive(res.activeWindow)
    } catch {
      /* 探测失败不打断设置页 */
    }
  }

  useEffect(() => {
    void refreshCaps()
  }, [])

  const takeShot = async (): Promise<void> => {
    setBusy(true)
    try {
      const shot = await unwrap(api.screen.capture())
      setPreview(`data:${shot.mediaType};base64,${shot.data}`)
      onNotice(`已截取 ${shot.width}×${shot.height} 的屏幕画面`)
    } catch (e) {
      onNotice(messageOf(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  /** 列表编辑：把多行文本转成数组，顺手去掉空行与首尾空格 */
  const listToArray = (text: string): string[] =>
    text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 className="page-title">能力</h2>
        <span className="muted tiny">控制台与屏幕操作，默认全部关闭</span>
      </div>

      {/* ---- 控制台 ---- */}
      <div className="card">
        <div className="card-head">
          <IconTerminal size={15} />
          <span className="card-title" style={{ flex: 1 }}>
            控制台
          </span>
          <Switch
            checked={settings.shellEnabled}
            onChange={(v) => onChange({ shellEnabled: v })}
            title="启用后助手可以执行命令行"
          />
        </div>
        <div className="field-hint">
          开启后助手获得 <span className="mono">shell_run</span> 工具，可以在你的电脑上执行命令行。
          它和你在终端里敲命令的权限完全相同——能删文件、能装东西、能联网。
        </div>

        {settings.shellEnabled ? (
          <>
            <Field label="默认工作目录" hint="留空则使用工作区根目录；没有工作区时用用户主目录">
              <input
                className="input mono"
                value={settings.shellCwd ?? ''}
                placeholder="（留空）"
                onChange={(e) => onChange({ shellCwd: e.target.value || null })}
              />
            </Field>

            <Field label="单条命令超时（秒）" hint="超时后连同子进程一起终止">
              <input
                className="input"
                type="number"
                min={1}
                max={600}
                value={Math.round(settings.shellTimeoutMs / 1000)}
                onChange={(e) => onChange({ shellTimeoutMs: Math.max(1, Number(e.target.value) || 60) * 1000 })}
              />
            </Field>

            <Field
              label="命令白名单"
              hint="每行一个可执行文件名。非空时，只允许运行这些命令。留空表示不限制"
            >
              <textarea
                className="textarea"
                rows={3}
                value={(settings.shellAllowlist ?? []).join('\n')}
                placeholder={'git\nnpm\nnode'}
                onChange={(e) => onChange({ shellAllowlist: listToArray(e.target.value) })}
              />
            </Field>

            <Field label="命令黑名单" hint="每行一个，优先级高于白名单。命中即拒绝">
              <textarea
                className="textarea"
                rows={3}
                value={(settings.shellDenylist ?? []).join('\n')}
                onChange={(e) => onChange({ shellDenylist: listToArray(e.target.value) })}
              />
            </Field>

            <Alert kind="info">
              管道、重定向（<span className="mono">|</span> <span className="mono">&gt;</span>{' '}
              <span className="mono">&lt;</span>）和命令串联默认被拒绝：它们能把多个无害命令拼成一条危险命令。
              当前版本不支持开启。黑名单按可执行文件名比对，无法拦住{' '}
              <span className="mono">cmd /c del</span> 这类嵌套调用——真正的边界是权限档位。
            </Alert>
          </>
        ) : null}
      </div>

      {/* ---- 屏幕 ---- */}
      <div className="card">
        <div className="card-head">
          <IconScreen size={15} />
          <span className="card-title" style={{ flex: 1 }}>
            屏幕
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void refreshCaps()}
            title="重新探测平台能力与前台窗口"
          >
            <IconRefresh size={13} />
          </Button>
        </div>

        {capabilities ? (
          <Alert kind={capabilities.capture || capabilities.input ? 'info' : 'warn'}>
            {capabilities.note}
          </Alert>
        ) : (
          <div className="muted tiny" style={{ marginBottom: 10 }}>
            正在探测平台能力…
          </div>
        )}

        <label className="row" style={{ gap: 8, cursor: 'pointer', marginBottom: 10 }}>
          <input
            type="checkbox"
            checked={settings.screenCapture}
            onChange={(e) => onChange({ screenCapture: e.target.checked })}
          />
          <span style={{ flex: 1 }}>
            <div>允许读取屏幕</div>
            <div className="field-hint" style={{ margin: 0 }}>
              截图会作为图片发送给当前模型。只有支持视觉的模型才看得懂画面，纯文本模型会收到一大段无意义的 base64。
            </div>
          </span>
        </label>

        <label className="row" style={{ gap: 8, cursor: 'pointer', marginBottom: 10 }}>
          <input
            type="checkbox"
            checked={settings.screenInput}
            onChange={(e) => onChange({ screenInput: e.target.checked })}
          />
          <span style={{ flex: 1 }}>
            <div>允许操作鼠标键盘</div>
            <div className="field-hint" style={{ margin: 0 }}>
              助手可以真实移动光标、点击、键入、按键、滚动、拖拽。这会直接操作你眼前的电脑，
              点错位置可能触发不可预期的后果。
            </div>
          </span>
        </label>

        <label className="row" style={{ gap: 8, cursor: 'pointer', marginBottom: 10 }}>
          <input
            type="checkbox"
            checked={settings.screenHumanize}
            onChange={(e) => onChange({ screenHumanize: e.target.checked })}
          />
          <span style={{ flex: 1 }}>
            <div>模拟真人的操作节奏</div>
            <div className="field-hint" style={{ margin: 0 }}>
              点击前让光标沿曲线滑到目标并插入随机停顿，而不是瞬移后立刻按下。
              默认开启；关闭后操作更快，但更容易被界面忽略。
            </div>
          </span>
        </label>

        <Field label="截图最长边（像素）" hint="超过则等比缩小。越小越省 token，但界面文字越难辨认">
          <input
            className="input"
            type="number"
            min={320}
            max={4096}
            step={160}
            value={settings.screenMaxEdge}
            onChange={(e) => onChange({ screenMaxEdge: Math.min(4096, Math.max(320, Number(e.target.value) || 1600)) })}
          />
        </Field>

        {displays.length > 1 ? (
          <Field label="截取的显示器" hint="选择「全部」会把多屏拼在一起截图">
            <select
              className="select"
              value={settings.screenDisplayId ?? ''}
              onChange={(e) => onChange({ screenDisplayId: e.target.value === '' ? null : Number(e.target.value) })}
            >
              <option value="">全部屏幕</option>
              {displays.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}（{d.bounds.width}×{d.bounds.height}）{d.primary ? ' · 主屏' : ''}
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        <Field
          label="窗口白名单"
          hint="每行一个窗口标题关键字。非空时，只有当前前台窗口标题包含其中任一关键字，屏幕操作才被允许。这是防止助手在你不注意时点到别处的最后一道闸"
        >
          <textarea
            className="textarea"
            rows={3}
            value={(settings.screenWindowAllowlist ?? []).join('\n')}
            placeholder={'Visual Studio Code\nChrome'}
            onChange={(e) => onChange({ screenWindowAllowlist: listToArray(e.target.value) })}
          />
        </Field>

        {active ? (
          <div className="tiny muted" style={{ marginBottom: 10 }}>
            当前前台窗口：<span className="mono">{active.title || '（无标题）'}</span>
          </div>
        ) : null}

        <div className="row">
          <Button size="sm" disabled={!settings.screenCapture || busy} onClick={() => void takeShot()}>
            {busy ? <Spinner /> : null} 截一张看看
          </Button>
          {preview ? (
            <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
              清除预览
            </Button>
          ) : null}
        </div>

        {preview ? (
          <div style={{ marginTop: 10 }}>
            <img src={preview} alt="屏幕预览" className="shot-preview" />
            <div className="tiny muted" style={{ marginTop: 6 }}>
              这就是模型会看到的画面。如果这里显示的是空白或黑色，说明系统没给应用屏幕录制权限。
            </div>
          </div>
        ) : null}

        {settings.screenCapture && !settings.screenInput ? (
          <Alert kind="info">
            当前只读了屏幕，还不能操作。助手会告诉你它看到了什么，但无法自己点击。
          </Alert>
        ) : null}
      </div>

      {/* ---- 系统提示词 ---- */}
      <div className="card">
        <div className="card-head">
          <span className="card-title">系统提示词</span>
          <span className="muted tiny">助手每一轮都会收到这段指令</span>
        </div>
        <textarea
          className="textarea"
          rows={9}
          value={settings.systemPrompt}
          onChange={(e) => onChange({ systemPrompt: e.target.value })}
        />
        <div className="field-hint" style={{ marginTop: 6 }}>
          权限档位的说明、工作区路径、已启用的能力会自动追加在这段文字之后，不需要写在这里。
        </div>
      </div>

      {/* ---- 运行参数 ---- */}
      <div className="card">
        <div className="card-head">
          <span className="card-title">运行参数</span>
        </div>
        <Field label="工具调用轮次上限" hint="单次提问中助手最多连续调用多少轮工具，防止任务跑偏后无限循环">
          <input
            className="input"
            type="number"
            min={1}
            max={40}
            value={settings.maxToolRounds}
            onChange={(e) => onChange({ maxToolRounds: Math.min(40, Math.max(1, Number(e.target.value) || 20)) })}
          />
        </Field>
        <Field label="上下文保留消息数" hint="超出后从最早的消息开始裁剪，0 表示不裁剪（可能超出模型窗口）">
          <input
            className="input"
            type="number"
            min={0}
            max={400}
            value={settings.contextWindow}
            onChange={(e) => onChange({ contextWindow: Math.max(0, Number(e.target.value) || 0) })}
          />
        </Field>
        <Field label="单次读取文件上限（KB）" hint="超过会被截断">
          <input
            className="input"
            type="number"
            min={4}
            max={4096}
            value={Math.round(settings.maxReadBytes / 1024)}
            onChange={(e) => onChange({ maxReadBytes: Math.max(4, Number(e.target.value) || 256) * 1024 })}
          />
        </Field>
        <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={settings.injectWorkspaceTree}
            onChange={(e) => onChange({ injectWorkspaceTree: e.target.checked })}
          />
          <span style={{ flex: 1 }}>
            <div>注入工作区文件清单</div>
            <div className="field-hint" style={{ margin: 0 }}>
              在系统提示词里附上文件列表，助手能更快定位。大项目会占用较多 token。
            </div>
          </span>
        </label>
      </div>
    </>
  )
}
