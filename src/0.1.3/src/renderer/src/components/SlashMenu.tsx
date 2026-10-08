import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react'

/** 输入框斜杠命令：键盘优先的操作入口，不用满屏找按钮 */
export interface SlashCommand {
  id: string
  /** 主名，如 mode */
  name: string
  /** 别名，如 ['标准', 'ptc', 'mini'] */
  aliases: string[]
  hint: string
  /** arg 为斜杠后跟的参数原文（去首尾空格） */
  run: (arg: string) => void
}

export interface SlashMenuHandle {
  /** 返回 true 表示消费了该按键 */
  handleKey: (key: string, shiftKey?: boolean) => boolean
}

/**
 * 斜杠菜单。
 *
 * 交互约定（抄 deepseek-harness）：
 * - ↑↓ 环绕移动，Enter/Tab 选中，Esc 关闭且绝不改草稿；
 * - 鼠标点选用 onMouseDown + preventDefault，不抢输入框焦点；
 * - 过滤纯本地，无匹配时给一句提示而不是静默吞掉。
 */
export const SlashMenu = forwardRef<
  SlashMenuHandle,
  { query: string; commands: SlashCommand[]; onPick: (c: SlashCommand, arg: string) => void; onClose: () => void }
>(function SlashMenu({ query, commands, onPick, onClose }, ref) {
  const [selected, setSelected] = useState(0)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    // 前缀优先，其次包含；主名与别名同检
    const starts: SlashCommand[] = []
    const contains: SlashCommand[] = []
    for (const c of commands) {
      const keys = [c.name, ...c.aliases].map((s) => s.toLowerCase())
      if (keys.some((k) => k.startsWith(q))) starts.push(c)
      else if (keys.some((k) => k.includes(q))) contains.push(c)
    }
    return [...starts, ...contains]
  }, [query, commands])

  useEffect(() => {
    setSelected(0)
  }, [query])

  useImperativeHandle(ref, () => ({
    handleKey: (key: string, shiftKey?: boolean): boolean => {
      if (key === 'ArrowDown') {
        setSelected((s) => (filtered.length ? (s + 1) % filtered.length : 0))
        return true
      }
      if (key === 'ArrowUp') {
        setSelected((s) => (filtered.length ? (s - 1 + filtered.length) % filtered.length : 0))
        return true
      }
      if (key === 'Enter' || (key === 'Tab' && !shiftKey)) {
        const c = filtered[selected]
        if (c) {
          onPick(c, query.trim())
          return true
        }
        return false
      }
      if (key === 'Escape') {
        onClose()
        return true
      }
      return false
    }
  }))

  return (
    <div className="slash-menu" role="listbox" aria-label="输入框命令">
      {filtered.length === 0 ? (
        <div className="muted tiny" style={{ padding: '8px 10px' }}>
          没有匹配「/{query}」的命令，Esc 继续打字
        </div>
      ) : (
        filtered.map((c, i) => (
          <button
            key={c.id}
            type="button"
            role="option"
            aria-selected={i === selected}
            className={`palette-item${i === selected ? ' selected' : ''}`}
            onMouseEnter={() => setSelected(i)}
            // mousedown 即选中：click 会先丢焦点导致菜单闪关
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(c, query.trim())
            }}
          >
            <span className="palette-item-main">
              <span className="palette-item-title">/{c.name}</span>
              <span className="palette-item-hint">{c.hint}</span>
            </span>
            {i === selected ? <span className="kbd">↵</span> : null}
          </button>
        ))
      )}
    </div>
  )
})

/**
 * 斜杠触发检测：`/` 出现在行首或空白/换行之后才算命令，避免 URL 里的斜杠误触。
 * 返回斜杠 token 在全文中的起止下标，命中失败返回 null。
 */
export function detectSlashToken(text: string, caret: number): { start: number; end: number; query: string } | null {
  const before = text.slice(0, caret)
  const m = /(^|\s)\/([^\s]*)$/.exec(before)
  if (!m) return null
  const start = caret - m[2].length - 1
  return { start, end: caret, query: m[2] }
}
