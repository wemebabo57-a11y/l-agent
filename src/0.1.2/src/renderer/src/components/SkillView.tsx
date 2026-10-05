import { useCallback, useEffect, useState } from 'react'
import type { SkillMeta } from '@shared/types'
import { api, messageOf, unwrap } from '../lib/api'
import { formatBytes, formatRelative } from '../lib/format'
import { Alert, Button, Empty, Modal, Pill, Switch } from './ui'
import { IconArchive, IconFile, IconFolder } from './icons'

export function SkillView({ onNotice }: { onNotice: (m: string, k?: 'error' | 'info') => void }): React.JSX.Element {
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ meta: SkillMeta; text: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<SkillMeta | null>(null)

  const refresh = useCallback(async () => {
    try {
      setSkills(await unwrap(api.skills.list()))
      setError(null)
    } catch (e) {
      setError(messageOf(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const doImport = async (kind: 'files' | 'folder' | 'zip'): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const fn =
        kind === 'files' ? api.skills.importFiles : kind === 'folder' ? api.skills.importFolder : api.skills.importZip
      const added = await unwrap(fn())
      if (added.length) {
        onNotice(`已导入 ${added.length} 个 skill：${added.map((s) => s.name).join('、')}`)
        await refresh()
      }
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (s: SkillMeta, enabled: boolean): Promise<void> => {
    try {
      setSkills(await unwrap(api.skills.toggle(s.id, enabled)))
    } catch (e) {
      onNotice(messageOf(e), 'error')
    }
  }

  const doDelete = async (): Promise<void> => {
    if (!confirmDelete) return
    try {
      setSkills(await unwrap(api.skills.remove(confirmDelete.id)))
      onNotice(`已删除 skill「${confirmDelete.name}」`)
      setConfirmDelete(null)
    } catch (e) {
      onNotice(messageOf(e), 'error')
    }
  }

  const openPreview = async (s: SkillMeta): Promise<void> => {
    try {
      setPreview(await unwrap(api.skills.read(s.id)))
    } catch (e) {
      onNotice(messageOf(e), 'error')
    }
  }

  const enabledCount = skills.filter((s) => s.enabled).length

  return (
    <div className="page">
      <div className="page-narrow">
        <div className="row row-wrap" style={{ marginBottom: 14 }}>
          <h2 className="page-title">Skill 管理</h2>
          <span className="muted tiny">
            {skills.length} 个已安装，{enabledCount} 个已启用
          </span>
          <div className="topbar-spacer" />
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void doImport('folder')}>
            上传文件夹
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void doImport('zip')}>
            上传 ZIP
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void doImport('files')}>
            上传文件
          </Button>
        </div>

        {error ? <Alert kind="error">{error}</Alert> : null}
        {busy ? (
          <Alert kind="info">
            <span className="spin" /> 正在导入并解析…
          </Alert>
        ) : null}

        <Alert kind="info">
          Skill 是给助手看的可复用任务指令。导入时会完整复制到应用数据目录（<span className="mono">skills/</span>
          ），原目录不受影响。启用的 skill 会被注入到系统提示词中，助手在任务匹配时按其中的流程执行。
          入口文件优先识别 <span className="mono">SKILL.md</span>。
        </Alert>

        {skills.length === 0 ? (
          <Empty title="还没有安装任何 Skill">
            支持三种导入方式：整个文件夹、单个 Markdown 文件、ZIP 压缩包。
            <br />
            <span className="tiny">
              推荐结构：文件夹内含 <span className="mono">SKILL.md</span>
              ，并在开头用 frontmatter 声明 <span className="mono">name</span> 与{' '}
              <span className="mono">description</span>。
            </span>
          </Empty>
        ) : (
          skills.map((s) => (
            <div key={s.id} className={`skill-item${s.enabled ? '' : ' disabled'}`}>
              <div className="skill-icon">
                {s.source === 'folder' ? (
                  <IconFolder size={16} />
                ) : s.source === 'zip' ? (
                  <IconArchive size={16} />
                ) : (
                  <IconFile size={16} />
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row" style={{ gap: 7 }}>
                  <span style={{ fontWeight: 600 }}>{s.name}</span>
                  {s.extra.version ? <Pill>v{s.extra.version}</Pill> : null}
                  {s.extra.author ? <Pill>{s.extra.author}</Pill> : null}
                  {s.enabled ? <Pill kind="ok">已启用</Pill> : <Pill>已停用</Pill>}
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
                  {s.description || '（无描述）'}
                </div>
                <div className="muted tiny mono" style={{ marginTop: 4 }}>
                  {s.entry}
                  {s.resources.length ? ` + ${s.resources.length} 个资源文件` : ''} · {formatBytes(s.sizeBytes)} ·
                  导入于 {formatRelative(s.installedAt)}
                </div>
              </div>
              <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                <Button size="sm" variant="ghost" onClick={() => void openPreview(s)}>
                  查看
                </Button>
                <Button size="sm" variant="danger" onClick={() => setConfirmDelete(s)}>
                  删除
                </Button>
                <Switch checked={s.enabled} onChange={(v) => void toggle(s, v)} title="启用后将注入系统提示词" />
              </div>
            </div>
          ))
        )}
      </div>

      {preview ? (
        <Modal title={preview.meta.name} onClose={() => setPreview(null)} wide>
          <div className="row row-wrap" style={{ marginBottom: 10, gap: 6 }}>
            <Pill kind="accent">{preview.meta.entry}</Pill>
            <Pill>{preview.meta.source}</Pill>
            <Pill>{preview.meta.dir}</Pill>
          </div>
          <pre className="code-view" style={{ maxHeight: '56vh', border: '1px solid var(--border)', borderRadius: 6 }}>
            {preview.text}
          </pre>
        </Modal>
      ) : null}

      {confirmDelete ? (
        <Modal
          title="删除 Skill"
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <Button onClick={() => setConfirmDelete(null)}>取消</Button>
              <Button variant="danger" onClick={() => void doDelete()}>
                确认删除
              </Button>
            </>
          }
        >
          将从应用数据目录中删除 <strong>{confirmDelete.name}</strong> 的完整副本。
          <br />
          <span className="muted tiny">如果它是从其他地方导入的，原始文件不受影响。</span>
        </Modal>
      ) : null}
    </div>
  )
}
