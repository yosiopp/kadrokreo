import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { SceneNode } from '../document/types.ts'
import { fitTextNodes } from './measure.ts'
import { type NodePatch, updateNodes } from './operations.ts'
import type { EditorState, EditorStore } from './store.ts'

type Props = {
  store: EditorStore
  state: EditorState
}

/** 複数選択で値が揃っていないことを表す */
const MIXED = Symbol('mixed')
type Mixed = typeof MIXED

function common<T>(values: readonly T[]): T | Mixed {
  return values.every((value) => Object.is(value, values[0])) ? values[0] : MIXED
}

const TYPE_LABELS: Record<SceneNode['type'], string> = {
  frame: 'フレーム',
  rect: '長方形',
  ellipse: '楕円',
  text: 'テキスト',
}

const FONT_FAMILIES = [
  { value: 'sans-serif', label: 'ゴシック体' },
  { value: 'serif', label: '明朝体' },
  { value: 'monospace', label: '等幅' },
]

const SHORTCUTS = [
  ['V / F / R / O / T', 'ツールの切り替え'],
  ['Space + ドラッグ', '画面の移動'],
  ['⌘/Ctrl + ホイール', 'ズーム'],
  ['Shift + 1', '全体を表示'],
  ['⌘/Ctrl + Z', '元に戻す'],
  ['⌘/Ctrl + D', '複製'],
  ['] / [', '最前面 / 最背面へ'],
]

export function PropertiesPanel({ store, state }: Props) {
  const { document: doc, selection } = state
  const nodes = selection.map((id) => doc.nodes[id])

  if (nodes.length === 0) {
    return (
      <aside className="panel properties-panel" aria-label="プロパティ">
        <h2 className="panel-title">プロパティ</h2>
        <p className="panel-hint">レイヤーを選択すると、位置や色を編集できます。</p>
        <h2 className="panel-title">ショートカット</h2>
        <dl className="shortcut-list">
          {SHORTCUTS.map(([keys, description]) => (
            <div key={keys}>
              <dt>{keys}</dt>
              <dd>{description}</dd>
            </div>
          ))}
        </dl>
      </aside>
    )
  }

  // 文字やフォントを変えるとテキストの大きさも変わるので、毎回合わせ直す
  const apply = (patch: NodePatch) =>
    store.apply((base) => fitTextNodes(updateNodes(base, selection, patch), selection))
  const preview = (patch: NodePatch) => store.preview((base) => updateNodes(base, selection, patch))

  const shapes = nodes.filter((node) => node.type !== 'text')
  const texts = nodes.filter((node) => node.type === 'text')
  const rects = nodes.filter((node) => node.type === 'rect')
  const frames = nodes.filter((node) => node.type === 'frame')
  const onlyShapes = texts.length === 0
  const fontFamily = common(texts.map((node) => node.fontFamily))
  const clipContent = common(frames.map((node) => node.clipContent))

  return (
    <aside className="panel properties-panel" aria-label="プロパティ">
      <h2 className="panel-title">
        {nodes.length === 1 ? TYPE_LABELS[nodes[0].type] : `${nodes.length} 個を選択中`}
      </h2>

      <Section title="位置とサイズ">
        <div className="field-grid">
          <NumberField label="X" value={common(nodes.map((n) => n.x))} onCommit={(x) => apply({ x })} />
          <NumberField label="Y" value={common(nodes.map((n) => n.y))} onCommit={(y) => apply({ y })} />
          <NumberField
            label="W"
            value={common(nodes.map((n) => n.width))}
            min={1}
            disabled={!onlyShapes}
            onCommit={(width) => apply({ width })}
          />
          <NumberField
            label="H"
            value={common(nodes.map((n) => n.height))}
            min={1}
            disabled={!onlyShapes}
            onCommit={(height) => apply({ height })}
          />
        </div>
      </Section>

      <Section title="不透明度">
        <NumberField
          label="%"
          value={mapValue(common(nodes.map((n) => n.opacity)), (opacity) => Math.round(opacity * 100))}
          min={0}
          max={100}
          onCommit={(percent) => apply({ opacity: percent / 100 })}
        />
      </Section>

      <Section title="塗り">
        <ColorField
          label="塗り"
          value={common(nodes.map((n) => n.fill))}
          // テキストは塗りを消せない
          nullable={onlyShapes}
          fallback="#d9d9d9"
          onPreview={(fill) => preview({ fill })}
          onCommit={store.commitPreview}
          onSet={(fill) => apply({ fill })}
        />
      </Section>

      {onlyShapes && (
        <Section title="線">
          <ColorField
            label="線"
            value={common(shapes.map((n) => n.stroke))}
            nullable
            fallback="#000000"
            onPreview={(stroke) => preview({ stroke })}
            onCommit={store.commitPreview}
            onSet={(stroke) => apply({ stroke })}
          />
          <NumberField
            label="太さ"
            value={common(shapes.map((n) => n.strokeWidth))}
            min={0}
            onCommit={(strokeWidth) => apply({ strokeWidth })}
          />
        </Section>
      )}

      {rects.length === nodes.length && (
        <Section title="角丸">
          <NumberField
            label="半径"
            value={common(rects.map((n) => n.cornerRadius))}
            min={0}
            onCommit={(cornerRadius) => apply({ cornerRadius })}
          />
        </Section>
      )}

      {frames.length === nodes.length && (
        <Section title="フレーム">
          <label className="check-field">
            <input
              type="checkbox"
              checked={clipContent === true}
              ref={(input) => {
                if (input) input.indeterminate = clipContent === MIXED
              }}
              onChange={(event) => apply({ clipContent: event.target.checked })}
            />
            はみ出した中身を隠す
          </label>
        </Section>
      )}

      {texts.length === nodes.length && (
        <Section title="テキスト">
          <NumberField
            label="サイズ"
            value={common(texts.map((n) => n.fontSize))}
            min={1}
            max={1000}
            onCommit={(fontSize) => apply({ fontSize })}
          />
          <label className="field">
            <span className="field-label">書体</span>
            <select
              value={fontFamily === MIXED ? '' : fontFamily}
              onChange={(event) => {
                apply({ fontFamily: event.target.value })
                // フォーカスを残すとキーボードショートカットが効かなくなる
                event.target.blur()
              }}
            >
              {fontFamily === MIXED && <option value="">混在</option>}
              {typeof fontFamily === 'string' && !FONT_FAMILIES.some((f) => f.value === fontFamily) && (
                <option value={fontFamily}>{fontFamily}</option>
              )}
              {FONT_FAMILIES.map((font) => (
                <option key={font.value} value={font.value}>
                  {font.label}
                </option>
              ))}
            </select>
          </label>
        </Section>
      )}
    </aside>
  )
}

function mapValue<T, U>(value: T | Mixed, map: (value: T) => U): U | Mixed {
  return value === MIXED ? MIXED : map(value as T)
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel-section">
      <h3 className="section-title">{title}</h3>
      {children}
    </section>
  )
}

type NumberFieldProps = {
  label: string
  value: number | Mixed
  min?: number
  max?: number
  disabled?: boolean
  onCommit: (value: number) => void
}

/** 入力中は下書きとして持ち、Enter かフォーカスが外れたときに確定する */
function NumberField({ label, value, min = -Infinity, max = Infinity, disabled, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? (value === MIXED ? '' : String(Math.round(value * 100) / 100))

  function commit(text: string | null) {
    setDraft(null)
    if (text === null || text.trim() === '') return
    const parsed = Number(text)
    if (Number.isFinite(parsed)) onCommit(Math.min(max, Math.max(min, parsed)))
  }

  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={shown}
        placeholder={value === MIXED ? '混在' : undefined}
        disabled={disabled}
        onFocus={(event) => event.target.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur()
          } else if (event.key === 'Escape') {
            // 下書きを捨てた後で blur させる（先に blur すると下書きが確定してしまう）
            const input = event.currentTarget
            setDraft(null)
            requestAnimationFrame(() => input.blur())
          } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && value !== MIXED) {
            event.preventDefault()
            const step = (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1)
            const current = draft === null ? value : Number(draft)
            commit(String((Number.isFinite(current) ? current : value) + step))
          }
        }}
      />
    </label>
  )
}

type ColorFieldProps = {
  label: string
  value: string | null | Mixed
  nullable: boolean
  /** 色がない状態から有効にしたときの色 */
  fallback: string
  /** 色を選んでいる最中。履歴には積まない */
  onPreview: (color: string) => void
  onCommit: () => void
  onSet: (color: string | null) => void
}

function ColorField({ label, value, nullable, fallback, onPreview, onCommit, onSet }: ColorFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const onCommitRef = useRef(onCommit)
  useEffect(() => {
    onCommitRef.current = onCommit
  })

  // React の onChange は選んでいる最中にも呼ばれる。選び終えたことは素の change イベントで知る
  useEffect(() => {
    const input = inputRef.current
    const commit = () => onCommitRef.current()
    input?.addEventListener('change', commit)
    return () => input?.removeEventListener('change', commit)
  }, [])

  const color = typeof value === 'string' ? value : fallback
  return (
    <div className="color-field">
      {nullable && (
        <input
          type="checkbox"
          aria-label={`${label}を有効にする`}
          checked={value !== null}
          onChange={(event) => onSet(event.target.checked ? color : null)}
        />
      )}
      <input
        ref={inputRef}
        type="color"
        aria-label={`${label}の色`}
        value={color}
        disabled={value === null}
        onChange={(event) => onPreview(event.target.value)}
        onBlur={onCommit}
      />
      <span className="color-value">
        {value === MIXED ? '混在' : value === null ? 'なし' : value.toUpperCase()}
      </span>
    </div>
  )
}
