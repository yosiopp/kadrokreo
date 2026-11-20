import type { ReactNode } from 'react'
import type { Tool } from './EditorCanvas.tsx'

const TOOLS: { tool: Tool; label: string; shortcut: string; icon: ReactNode }[] = [
  {
    tool: 'select',
    label: '選択',
    shortcut: 'V',
    icon: <path d="M4 2.5v11l3-2.7 1.9 4.2 1.8-.8-1.9-4.2 4-.3z" fill="currentColor" stroke="none" />,
  },
  {
    tool: 'frame',
    label: 'フレーム',
    shortcut: 'F',
    icon: <path d="M5 1.5v13M11 1.5v13M1.5 5h13M1.5 11h13" />,
  },
  { tool: 'rect', label: '長方形', shortcut: 'R', icon: <rect x="2.5" y="3.5" width="11" height="9" /> },
  { tool: 'ellipse', label: '楕円', shortcut: 'O', icon: <ellipse cx="8" cy="8" rx="5.5" ry="5.5" /> },
  { tool: 'line', label: '直線', shortcut: 'L', icon: <path d="M3 13L13 3" /> },
  { tool: 'text', label: 'テキスト', shortcut: 'T', icon: <path d="M3 4V2.5h10V4M8 2.5v11M6 13.5h4" /> },
]

type Props = {
  tool: Tool
  onToolChange: (tool: Tool) => void
  /** ツールの後ろに並べるボタン */
  children?: ReactNode
}

export function Toolbar({ tool, onToolChange, children }: Props) {
  return (
    <div className="toolbar" role="toolbar" aria-label="ツール">
      {TOOLS.map((item) => (
        <button
          key={item.tool}
          type="button"
          className="icon-button"
          title={`${item.label} (${item.shortcut})`}
          aria-label={item.label}
          aria-pressed={tool === item.tool}
          onClick={() => onToolChange(item.tool)}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3">
            {item.icon}
          </svg>
        </button>
      ))}
      {children}
    </div>
  )
}
