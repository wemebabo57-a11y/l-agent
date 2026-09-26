import type { ReactNode } from 'react'
import { IconClose } from './icons'

/* ------------------------------------------------------------------ */
/* 基础原语                                                            */
/* ------------------------------------------------------------------ */

export function Button({
  children,
  onClick,
  variant = 'default',
  size,
  disabled,
  title,
  type = 'button'
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  size?: 'sm'
  disabled?: boolean
  title?: string
  type?: 'button' | 'submit'
}): React.JSX.Element {
  const cls = [
    'btn',
    variant !== 'default' ? `btn-${variant}` : '',
    size === 'sm' ? 'btn-sm' : ''
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button className={cls} onClick={onClick} disabled={disabled} title={title} type={type}>
      {children}
    </button>
  )
}

export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="field">
      <label className="field-label">{label}</label>
      {children}
      {hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  )
}

export function Alert({
  kind,
  children
}: {
  kind: 'error' | 'warn' | 'info'
  children: ReactNode
}): React.JSX.Element {
  return <div className={`alert alert-${kind}`}>{children}</div>
}

export function Pill({
  children,
  kind
}: {
  children: ReactNode
  kind?: 'ok' | 'warn' | 'danger' | 'accent'
}): React.JSX.Element {
  return <span className={`pill${kind ? ` pill-${kind}` : ''}`}>{children}</span>
}

export function Empty({
  title,
  children
}: {
  title: string
  children?: ReactNode
}): React.JSX.Element {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children}
    </div>
  )
}

export function Spinner(): React.JSX.Element {
  return <span className="spin" />
}

export function Switch({
  checked,
  onChange,
  title
}: {
  checked: boolean
  onChange: (v: boolean) => void
  title?: string
}): React.JSX.Element {
  return (
    <button
      className={`switch${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
      title={title}
      aria-pressed={checked}
      type="button"
    />
  )
}

export function Modal({
  title,
  children,
  footer,
  onClose,
  wide
}: {
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  wide?: boolean
}): React.JSX.Element {
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal" style={wide ? { maxWidth: 860 } : undefined}>
        <div className="modal-head">
          <span style={{ flex: 1 }}>{title}</span>
          <Button variant="ghost" size="sm" onClick={onClose} title="关闭">
            <IconClose size={13} />
          </Button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  )
}

/** 统计数字卡 */
export function Stat({
  label,
  value,
  sub,
  ratio,
  tone = 'accent'
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  /** 0~1，给定时显示进度条 */
  ratio?: number
  tone?: 'accent' | 'violet' | 'ok'
}): React.JSX.Element {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
      {ratio != null ? (
        <div className="bar">
          <div
            className={`bar-fill${tone === 'violet' ? ' violet' : tone === 'ok' ? ' ok' : ''}`}
            style={{ width: `${Math.max(0, Math.min(ratio, 1)) * 100}%` }}
          />
        </div>
      ) : null}
    </div>
  )
}
