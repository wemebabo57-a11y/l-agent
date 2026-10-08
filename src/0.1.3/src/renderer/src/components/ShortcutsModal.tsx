/** 快捷键总览：Ctrl+/ 或输入 /help 唤起，hover 按钮只能看到一个键，全表在这里 */
const ROWS: { keys: string[]; what: string }[] = [
  { keys: ['Ctrl', 'K'], what: '命令面板：新建会话、跳页面、换主题、置顶' },
  { keys: ['Ctrl', 'Enter'], what: '发送当前输入' },
  { keys: ['Enter'], what: '输入框内换行' },
  { keys: ['Esc'], what: '先关输入框菜单；无菜单且忙碌时停止本轮' },
  { keys: ['/'], what: '输入框行首输入 /：切模式（/mode）、看本表（/help）' },
  { keys: ['↑', '↓', '↵'], what: '菜单内移动与选中；Tab 也可选中' },
  { keys: ['Ctrl', '/'], what: '打开本表' }
]

export function ShortcutsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal" style={{ maxWidth: 480 }} role="dialog" aria-label="快捷键一览">
        <div className="modal-head">
          <strong>快捷键一览</strong>
          <span className="kbd">Esc</span>
        </div>
        <div className="modal-body">
          {ROWS.map((r) => (
            <div key={r.what} className="shortcut-row">
              <span className="shortcut-keys">
                {r.keys.map((k) => (
                  <span key={k} className="kbd">
                    {k}
                  </span>
                ))}
              </span>
              <span className="tiny">{r.what}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
