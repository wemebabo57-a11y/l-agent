import { useCallback, useEffect, useState } from 'react'
import type { PluginMeta, PluginPermission, ToolRisk } from '@shared/types'
import { api, messageOf, unwrap } from '../lib/api'
import { Alert, Button, Empty, Modal, Pill, Spinner, Switch } from './ui'
import { IconAlert, IconFolder, IconRefresh } from './icons'

/** 权限的中文说明：安装前让用户知道自己在同意什么 */
const PERMISSION_INFO: Record<PluginPermission, { label: string; detail: string; danger: boolean }> = {
  'workspace.read': { label: '读取工作区', detail: '可以读取工作区内的文本文件', danger: false },
  'workspace.write': { label: '写入工作区', detail: '可以创建、修改工作区内的文件', danger: true },
  network: { label: '网络访问', detail: '可以发起网络请求，数据会离开本机', danger: true },
  ui: { label: '界面面板', detail: '可以在应用内渲染自己的操作面板', danger: false },
  'screen.capture': { label: '读取屏幕', detail: '可以截取屏幕画面', danger: true },
  'screen.input': { label: '控制鼠标键盘', detail: '可以真实点击、键入、操作你的电脑', danger: true },
  shell: { label: '执行命令', detail: '可以在你的电脑上运行控制台命令', danger: true }
}

const RISK_LABEL: Record<ToolRisk, string> = {
  read: '只读',
  write: '写入',
  delete: '删除',
  remote: '远端',
  shell: '命令',
  screen: '屏幕'
}

export function PluginView({
  onNotice
}: {
  onNotice: (m: string, k?: 'error' | 'info') => void
}): React.JSX.Element {
  const [plugins, setPlugins] = useState<PluginMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<PluginMeta | null>(null)
  /** 申请了危险权限的插件：启用前先让用户看清自己在同意什么 */
  const [pendingEnable, setPendingEnable] = useState<PluginMeta | null>(null)
  const [panelHtml, setPanelHtml] = useState<{ id: string; html: string } | null>(null)

  const refresh = useCallback(async () => {
    try {
      setPlugins(await unwrap(api.plugins.list()))
      setError(null)
    } catch (e) {
      setError(messageOf(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const importFrom = async (kind: 'folder' | 'zip'): Promise<void> => {
    setBusy(true)
    try {
      const meta = kind === 'folder' ? await unwrap(api.plugins.importFolder()) : await unwrap(api.plugins.importZip())
      await refresh()
      onNotice(`已安装插件 ${meta.name} ${meta.version}，默认未启用`)
    } catch (e) {
      const m = messageOf(e)
      // 用户点取消是正常操作，不该弹错误
      if (!/取消|canceled/i.test(m)) onNotice(m, 'error')
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (p: PluginMeta, enabled: boolean): Promise<void> => {
    try {
      setPlugins(await unwrap(api.plugins.toggle(p.id, enabled)))
    } catch (e) {
      onNotice(messageOf(e), 'error')
    }
  }

  /** 打开开关时：有危险权限先弹确认清单，无危险权限直接开；关闭不需要确认 */
  const requestToggle = (p: PluginMeta, enabled: boolean): void => {
    if (enabled && p.permissions.some((perm) => PERMISSION_INFO[perm]?.danger)) {
      setPendingEnable(p)
      return
    }
    void toggle(p, enabled)
  }

  const remove = async (): Promise<void> => {
    if (!confirmRemove) return
    try {
      await unwrap(api.plugins.remove(confirmRemove.id))
      setConfirmRemove(null)
      await refresh()
      onNotice(`已删除插件 ${confirmRemove.name}`)
    } catch (e) {
      onNotice(messageOf(e), 'error')
    }
  }

  const openPanel = async (p: PluginMeta): Promise<void> => {
    try {
      // 先确认面板可用（会校验启用状态与 ui 权限），再指向协议 URL
      await unwrap(api.plugins.panel(p.id))
      setPanelHtml({ id: p.id, html: `lagent-plugin://${p.id}/` })
    } catch (e) {
      onNotice(messageOf(e), 'error')
    }
  }

  if (error) {
    return (
      <div className="page">
        <div className="page-narrow">
          <Alert kind="error">{error}</Alert>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page-narrow">
        <div className="row" style={{ marginBottom: 14 }}>
          <h2 className="page-title">插件</h2>
          <span className="muted tiny">{plugins ? `${plugins.length} 个已安装` : ''}</span>
          <div className="topbar-spacer" />
          <Button size="sm" onClick={() => void refresh()} title="重新读取插件列表">
            <IconRefresh size={13} /> 刷新
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void importFrom('folder')}>
            安装文件夹
          </Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void importFrom('zip')}>
            {busy ? <Spinner /> : null} 安装 .zip
          </Button>
        </div>

        <Alert kind="warn">
          插件是可执行扩展，能注册工具并调用你授权的系统能力。只安装来源可信的插件——
          它的代码会在你的电脑上运行。安装后默认<b>未启用</b>，需要你手动打开。
        </Alert>

        {!plugins ? (
          <div style={{ padding: 20 }}>
            <Spinner />
          </div>
        ) : plugins.length === 0 ? (
          <Empty title="还没有安装插件">
            插件可以注册自己的工具，让助手获得内置能力之外的操作手段。
            <br />
            <span className="tiny">
              目录结构：<span className="mono">manifest.json</span> + 入口文件（<span className="mono">.js</span> /{' '}
              <span className="mono">.mjs</span> / <span className="mono">.ts</span>）
            </span>
          </Empty>
        ) : (
          plugins.map((p) => (
            <div key={p.id} className={`card${p.enabled ? '' : ' card-dim'}`}>
              <div className="row row-wrap">
                <strong style={{ fontSize: 13 }}>{p.name}</strong>
                <span className="mono tiny muted">v{p.version}</span>
                {p.enabled ? <Pill kind="ok">已启用</Pill> : <Pill>已停用</Pill>}
                <div className="topbar-spacer" />
                {p.hasPanel ? (
                  <Button size="sm" onClick={() => void openPanel(p)} disabled={!p.enabled} title="打开插件面板">
                    面板
                  </Button>
                ) : null}
                <Button size="sm" onClick={() => void api.plugins.reveal(p.id)} title="在文件管理器中显示">
                  <IconFolder size={13} />
                </Button>
                <Button size="sm" variant="danger" onClick={() => setConfirmRemove(p)}>
                  删除
                </Button>
                <Switch checked={p.enabled} onChange={(v) => requestToggle(p, v)} title="启用 / 停用插件" />
              </div>

              {p.description ? (
                <div className="tiny" style={{ marginTop: 7, color: 'var(--fg-1)', lineHeight: 1.6 }}>
                  {p.description}
                </div>
              ) : null}

              {p.error ? (
                <div className="alert alert-error" style={{ marginTop: 9, marginBottom: 0 }}>
                  <span className="row" style={{ gap: 6 }}>
                    <IconAlert size={13} />
                    <span>{p.error}</span>
                  </span>
                </div>
              ) : null}

              <div className="row row-wrap" style={{ marginTop: 9, gap: 6 }}>
                <span className="muted tiny">权限</span>
                {p.permissions.length === 0 ? (
                  <span className="tiny muted">（未申请任何权限）</span>
                ) : (
                  p.permissions.map((perm) => {
                    const info = PERMISSION_INFO[perm]
                    return (
                      <span
                        key={perm}
                        className={`pill tiny${info?.danger ? ' pill-warn' : ''}`}
                        title={info?.detail ?? perm}
                      >
                        {info?.label ?? perm}
                      </span>
                    )
                  })
                )}
              </div>

              {p.tools.length ? (
                <div className="row row-wrap" style={{ marginTop: 7, gap: 6 }}>
                  <span className="muted tiny">注册工具</span>
                  {p.tools.map((t) => (
                    <span key={t} className="pill tiny mono" title={`风险等级：${RISK_LABEL[p.toolRisks[t]] ?? '只读'}`}>
                      {t}
                      <span style={{ color: 'var(--fg-2)' }}>· {RISK_LABEL[p.toolRisks[t]] ?? '只读'}</span>
                    </span>
                  ))}
                </div>
              ) : null}

              <div className="muted tiny" style={{ marginTop: 8 }}>
                来源 {p.source === 'zip' ? '压缩包' : '文件夹'} · {(p.sizeBytes / 1024).toFixed(1)} KB · 安装于{' '}
                {new Date(p.installedAt).toLocaleDateString('zh-CN')}
              </div>
            </div>
          ))
        )}

        <div className="muted tiny" style={{ marginTop: 16, lineHeight: 1.8 }}>
          <b>manifest.json 示例</b>
          <pre className="code-inline">{`{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "做一件有用的事",
  "main": "index.mjs",
  "permissions": ["workspace.read"],
  "tools": [
    {
      "name": "count_lines",
      "description": "统计文件行数",
      "parameters": {
        "type": "object",
        "properties": { "path": { "type": "string" } },
        "required": ["path"]
      }
    }
  ]
}`}</pre>
          入口文件导出处理函数，通过 <span className="mono">api</span> 访问被授权的宿主能力：
          <pre className="code-inline">{`export async function onTool({ input, api }) {
  const file = await api.readFile(input.path)
  return file.text.split('\\n').length
}`}</pre>
          工具的风险等级由申请的权限决定，插件无法自行降级；实际执行仍受当前权限档位约束。
        </div>
      </div>

      {pendingEnable ? (
        <Modal
          title={`启用插件 ${pendingEnable.name}`}
          onClose={() => setPendingEnable(null)}
          footer={
            <>
              <Button onClick={() => setPendingEnable(null)}>取消</Button>
              <Button
                variant="primary"
                onClick={() => {
                  const p = pendingEnable
                  setPendingEnable(null)
                  void toggle(p, true)
                }}
              >
                确认启用
              </Button>
            </>
          }
        >
          该插件申请了以下高风险权限，启用后它的工具与面板可以使用这些能力（实际执行仍受当前权限档位约束）：
          <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
            {pendingEnable.permissions
              .filter((perm) => PERMISSION_INFO[perm]?.danger)
              .map((perm) => (
                <div key={perm} className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                  <span className="pill tiny pill-warn">{PERMISSION_INFO[perm].label}</span>
                  <span className="tiny" style={{ color: 'var(--fg-1)' }}>
                    {PERMISSION_INFO[perm].detail}
                  </span>
                </div>
              ))}
          </div>
          <div className="muted tiny" style={{ marginTop: 10 }}>
            只启用来源可信的插件。它的代码会在你的电脑上运行。
          </div>
        </Modal>
      ) : null}

      {confirmRemove ? (
        <Modal
          title="删除插件"
          onClose={() => setConfirmRemove(null)}
          footer={
            <>
              <Button onClick={() => setConfirmRemove(null)}>取消</Button>
              <Button variant="danger" onClick={() => void remove()}>
                确认删除
              </Button>
            </>
          }
        >
          将删除 <strong>{confirmRemove.name}</strong> 及其全部文件。此操作不可撤销。
        </Modal>
      ) : null}

      {panelHtml ? (
        <Modal title="插件面板" onClose={() => setPanelHtml(null)} wide>
          {/*
            面板由主进程的 lagent-plugin:// 协议提供，而非 srcDoc。
            srcDoc 会继承宿主 CSP（script-src 'self'），面板内联脚本会被直接拦掉。
            协议响应带独立 origin + 自身 CSP，sandbox 去掉 allow-same-origin，
            因此面板既跑得起来，也拿不到宿主的数据。
          */}
          <iframe title="plugin-panel" className="plugin-frame" sandbox="allow-scripts allow-forms" src={panelHtml.html} />
          <div className="muted tiny" style={{ marginTop: 8 }}>
            面板运行在受限沙箱中，无法访问应用的密钥与本地数据。需要读写能力时应改为注册工具，走权限审批。
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
