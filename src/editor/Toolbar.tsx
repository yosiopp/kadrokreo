import { type ReactNode, useState } from 'react'
import { POLYGON_MAX_COUNT, POLYGON_MIN_COUNT } from '../document/polygon.ts'
import type { ShapeOptions, Tool } from './tools.ts'

/** shortcut のないツール（多角形・星）は、ボタンからだけ選ぶ */
const TOOLS: { tool: Tool; label: string; shortcut?: string; icon: ReactNode }[] = [
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
  { tool: 'polygon', label: '多角形', icon: <path d="M8 2l5.7 4.1-2.2 6.7h-7L2.3 6.1z" strokeLinejoin="round" /> },
  {
    tool: 'star',
    label: '星',
    icon: <path d="M8 1.8l1.8 4 4.3.4-3.3 2.9 1 4.2L8 11.1l-3.8 2.2 1-4.2-3.3-2.9 4.3-.4z" strokeLinejoin="round" />,
  },
  { tool: 'line', label: '直線', shortcut: 'L', icon: <path d="M3 13L13 3" /> },
  { tool: 'pen', label: 'ペン', shortcut: 'P', icon: <path d="M2.5 12.5L6 4l4.5 6 3-5.5" /> },
  { tool: 'text', label: 'テキスト', shortcut: 'T', icon: <path d="M3 4V2.5h10V4M8 2.5v11M6 13.5h4" /> },
]

type Props = {
  tool: Tool
  onToolChange: (tool: Tool) => void
  /** 多角形・星のツールで描く形。そのツールを選んでいる間だけ、頂点の数（星は内側の比も）の欄を出す */
  shapeOptions: ShapeOptions
  onShapeOptionsChange: (options: ShapeOptions) => void
  /** ツールの後ろに並べるボタン */
  children?: ReactNode
}

export function Toolbar({ tool, onToolChange, shapeOptions, onShapeOptionsChange, children }: Props) {
  const star = tool === 'star'
  const setCount = (count: number) =>
    onShapeOptionsChange(star ? { ...shapeOptions, starCount: count } : { ...shapeOptions, polygonCount: count })
  return (
    <div className="toolbar" role="toolbar" aria-label="ツール">
      {TOOLS.map((item) => (
        <button
          key={item.tool}
          type="button"
          className="icon-button"
          title={item.shortcut ? `${item.label} (${item.shortcut})` : item.label}
          aria-label={item.label}
          aria-pressed={tool === item.tool}
          onClick={() => onToolChange(item.tool)}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3">
            {item.icon}
          </svg>
        </button>
      ))}
      {(tool === 'polygon' || tool === 'star') && (
        <div className="toolbar-shape" role="group" aria-label={`${star ? '星' : '多角形'}の形`}>
          <label>
            {star ? '先の数' : '頂点の数'}
            <ShapeNumber
              key={tool}
              label={star ? '星の先の数' : '多角形の頂点の数'}
              value={star ? shapeOptions.starCount : shapeOptions.polygonCount}
              min={POLYGON_MIN_COUNT}
              max={POLYGON_MAX_COUNT}
              onChange={setCount}
            />
          </label>
          {star && (
            <label>
              内側 %
              <ShapeNumber
                label="星の内側の半径（先に対する %）"
                value={Math.round(shapeOptions.starRatio * 100)}
                min={1}
                max={99}
                onChange={(percent) => onShapeOptionsChange({ ...shapeOptions, starRatio: percent / 100 })}
              />
            </label>
          )}
        </div>
      )}
      {children}
    </div>
  )
}

/**
 * ツールバーの整数の欄。入力中の文字は下書きとして持ち（打ちかけの「1」を丸めて書き戻さない）、範囲内の整数になった時点で知らせる
 * （ドラッグを始める押下は欄のフォーカスが外れるより先に来るので、確定を待たずに次に描く形へ効かせる）。
 * 範囲の外や空のままフォーカスが外れたら、範囲に収めた値か元の値に戻す
 */
function ShapeNumber({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const settle = () => {
    if (draft !== null) {
      const parsed = Number(draft)
      if (draft.trim() !== '' && Number.isFinite(parsed)) onChange(Math.min(max, Math.max(min, Math.round(parsed))))
    }
    setDraft(null)
  }
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={1}
      value={draft ?? String(value)}
      aria-label={label}
      onChange={(event) => {
        const text = event.currentTarget.value
        setDraft(text)
        const parsed = Number(text)
        if (text.trim() !== '' && Number.isInteger(parsed) && parsed >= min && parsed <= max) onChange(parsed)
      }}
      onBlur={settle}
      onKeyDown={(event) => {
        if (event.key === 'Enter') settle()
      }}
    />
  )
}
