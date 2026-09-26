/**
 * 图标集。
 *
 * 用内联 SVG 而非 emoji：emoji 在不同系统上渲染成完全不同的字形，
 * 且自带饱和色与卡通感，是界面显得像"AI 生成"的主要原因。
 * 这里的图标统一 16px 网格、1.6px 描边、currentColor 继承颜色。
 */
import type { ReactNode } from 'react'

interface IconProps {
  size?: number
  className?: string
}

function Svg({ size = 16, className, children }: IconProps & { children: ReactNode }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export function IconChat(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M13.5 8.5a5.5 5.5 0 0 1-5.5 5.5H3.2L1.5 15.5V7A5.5 5.5 0 0 1 7 1.5h1A5.5 5.5 0 0 1 13.5 7z" />
    </Svg>
  )
}

export function IconFolder(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M1.5 4.2A1.2 1.2 0 0 1 2.7 3h3.1l1.4 1.8h5.1A1.2 1.2 0 0 1 13.5 6v5.8a1.2 1.2 0 0 1-1.2 1.2H2.7a1.2 1.2 0 0 1-1.2-1.2z" />
    </Svg>
  )
}

export function IconPlugin(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 2v2.5M10 2v2.5" />
      <path d="M4.5 4.5h7a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" />
      <path d="M6.5 8h3M8 6.8v2.4" />
    </Svg>
  )
}

/** Skill：一份带指令的文档 */
export function IconSkill(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3.5 2.5h6L13 6v7.5a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" />
      <path d="M9.2 2.5V6H13" />
      <path d="M5.5 9h4M5.5 11.2h2.8" />
    </Svg>
  )
}

/** 文件：用于文件树里的叶子节点 */
export function IconFile(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 2h5l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" />
      <path d="M8.8 2v3.2H12" />
    </Svg>
  )
}

/** 归档：zip 包 */
export function IconArchive(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M2.5 5.5h11v8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
      <path d="M1.8 2.5h12.4v3H1.8z" />
      <path d="M6.6 9.2h2.8" />
    </Svg>
  )
}

/** 外部链接：新窗口打开 */
export function IconExternal(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M9.5 2.5h4v4" />
      <path d="M13.5 2.5 7.5 8.5" />
      <path d="M12 9.6v3.4a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1H7" />
    </Svg>
  )
}

/** 锁定：私有仓库 */
export function IconLock(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 7h8a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" />
      <path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7" />
    </Svg>
  )
}

/** 公开仓库 */
export function IconGlobe(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12" />
      <path d="M8 2a9 9 0 0 1 0 12 9 9 0 0 1 0-12z" />
    </Svg>
  )
}

/** 返回上级 */
export function IconArrowUp(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M8 13V3.5" />
      <path d="M4.2 7.3 8 3.5l3.8 3.8" />
    </Svg>
  )
}

/** 分支 */
export function IconBranch(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="4.5" cy="3.8" r="1.8" />
      <circle cx="4.5" cy="12.2" r="1.8" />
      <circle cx="11.5" cy="6.2" r="1.8" />
      <path d="M4.5 5.6v4.8" />
      <path d="M11.5 8v.8a2 2 0 0 1-2 2h-3" />
    </Svg>
  )
}

export function IconGithub(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M5.5 14.5c-3 0-3-1.4-3-1.4 0-1 .5-1.6.5-1.6.8-.7 2-.6 2-.6v-2S2.2 9 2 6.6c0-1 .3-1.9.9-2.6-.1-.4-.3-1.3.1-2.2 0 0 .9-.2 2.3.9a6.5 6.5 0 0 1 3.4 0c1.4-1.1 2.3-.9 2.3-.9.4.9.2 1.8.1 2.2.6.7.9 1.6.9 2.6-.2 2.4-3 3.3-3 3.3v2s1.2-.1 2 .6c0 0 .5.6.5 1.6 0 0 0 1.4-3 1.4z" />
      <path d="M5.5 14.5V13" />
    </Svg>
  )
}

export function IconTerminal(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.2" />
      <path d="M4.5 6.5 6.5 8l-2 1.5M8 10h3.5" />
    </Svg>
  )
}

export function IconScreen(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect x="1.5" y="2.5" width="13" height="8.5" rx="1.2" />
      <path d="M5.5 13.5h5M8 11v2.5" />
    </Svg>
  )
}

export function IconChart(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M2 13.5h12" />
      <path d="M4.5 13.5V8.5M7.5 13.5V4.5M10.5 13.5V6.5" />
    </Svg>
  )
}

export function IconSettings(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v1.8M8 12.7v1.8M2.4 4.7l1.6.9M12 10.4l1.6.9M2.4 11.3l1.6-.9M12 5.6l1.6-.9" />
    </Svg>
  )
}

export function IconPlus(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M8 3.5v9M3.5 8h9" />
    </Svg>
  )
}

export function IconClose(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  )
}

export function IconStop(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function IconChevron(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 4l4 4-4 4" />
    </Svg>
  )
}

export function IconAlert(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M8 2.5 14.5 13.5h-13z" />
      <path d="M8 6.5v3M8 11.6v.01" />
    </Svg>
  )
}

export function IconCheck(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3 8.5 6.5 12l6.5-7.5" />
    </Svg>
  )
}

export function IconRefresh(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.7-4" />
      <path d="M13.5 2v3.5H10" />
    </Svg>
  )
}
