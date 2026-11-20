import { type ReactNode, useEffect, useRef, useState } from 'react'
import { normalizeAngle } from '../document/geometry.ts'
import type { Page, SceneNode, Shadow, TextNode } from '../document/types.ts'
import { fitTextNodes } from './measure.ts'
import { AlignIcon, TextAlignIcon } from './icons.tsx'
import {
  type Alignment,
  type NodePatch,
  alignNodes,
  distributeNodes,
  updateNode,
  updateNodes,
} from './operations.ts'
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
  line: '直線',
  text: 'テキスト',
  image: '画像',
}

const FONT_FAMILIES = [
  { value: 'sans-serif', label: 'ゴシック体' },
  { value: 'serif', label: '明朝体' },
  { value: 'monospace', label: '等幅' },
]

const ALIGNMENTS: { alignment: Alignment; label: string }[] = [
  { alignment: 'left', label: '左揃え' },
  { alignment: 'center', label: '左右中央揃え' },
  { alignment: 'right', label: '右揃え' },
  { alignment: 'top', label: '上揃え' },
  { alignment: 'middle', label: '上下中央揃え' },
  { alignment: 'bottom', label: '下揃え' },
]

const TEXT_ALIGNMENTS: { value: TextNode['textAlign']; label: string }[] = [
  { value: 'left', label: '左寄せ' },
  { value: 'center', label: '中央寄せ' },
  { value: 'right', label: '右寄せ' },
]

const DEFAULT_SHADOW: Shadow = { x: 0, y: 4, blur: 12, color: '#000000', opacity: 0.25 }

const SHORTCUTS = [
  ['V / F / R / O / L / T', 'ツールの切り替え'],
  ['Space + ドラッグ', '画面の移動'],
  ['⌘/Ctrl + ホイール', 'ズーム'],
  ['Shift + 1', '全体を表示'],
  ['⌘/Ctrl + Z', '元に戻す'],
  ['⌘/Ctrl + D', '複製'],
  ['] / [', '最前面 / 最背面へ'],
]

export function PropertiesPanel({ store, state }: Props) {
  const { page, selection } = state
  const nodes = selection.map((id) => page.nodes[id])

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

  // 塗りと線を持つ図形
  const shapes = nodes.filter((node) => node.type === 'rect' || node.type === 'ellipse' || node.type === 'frame')
  const texts = nodes.filter((node) => node.type === 'text')
  const lines = nodes.filter((node) => node.type === 'line')
  const frames = nodes.filter((node) => node.type === 'frame')
  const rounded = nodes.filter((node) => node.type === 'rect' || node.type === 'frame' || node.type === 'image')
  const filled = [...shapes, ...texts]
  const stroked = [...shapes, ...lines]
  const onlyShapes = shapes.length === nodes.length
  const hasText = texts.length > 0
  // 直線は水平・垂直にできるよう、幅や高さが 0 でもよい
  const minSize = lines.length > 0 ? 0 : 1
  const fontFamily = common(texts.map((node) => node.fontFamily))
  const autoWidth = common(texts.map((node) => node.autoWidth))
  const fontWeight = common(texts.map((node) => node.fontWeight))
  const textAlign = common(texts.map((node) => node.textAlign))
  const clipContent = common(frames.map((node) => node.clipContent))

  const shadows = shapes.flatMap((node) => (node.shadow ? [node.shadow] : []))
  const shadowEnabled = common(shapes.map((node) => node.shadow !== null))
  /** 影のある図形だけ、影の一部を書き換える */
  const patchShadows = (patch: Partial<Shadow>) => (base: Page) =>
    selection.reduce((next, id) => {
      const node = next.nodes[id]
      if (!('shadow' in node) || !node.shadow) return next
      return updateNode(next, id, { shadow: { ...node.shadow, ...patch } })
    }, base)
  // 1 つだけのときは親フレームに揃えるので、ページ直下では揃える先がない
  const canAlign = nodes.length > 1 || nodes[0].parentId !== null

  return (
    <aside className="panel properties-panel" aria-label="プロパティ">
      <h2 className="panel-title">
        {nodes.length === 1 ? TYPE_LABELS[nodes[0].type] : `${nodes.length} 個を選択中`}
      </h2>

      <Section title="整列">
        <div className="button-row">
          {ALIGNMENTS.map(({ alignment, label }) => (
            <button
              key={alignment}
              type="button"
              className="icon-button"
              title={label}
              aria-label={label}
              disabled={!canAlign}
              onClick={() => store.apply((base) => alignNodes(base, selection, alignment))}
            >
              <AlignIcon kind={alignment} />
            </button>
          ))}
          {(['x', 'y'] as const).map((axis) => {
            const label = axis === 'x' ? '左右に等間隔' : '上下に等間隔'
            return (
              <button
                key={axis}
                type="button"
                className="icon-button"
                title={label}
                aria-label={label}
                disabled={nodes.length < 3}
                onClick={() => store.apply((base) => distributeNodes(base, selection, axis))}
              >
                <AlignIcon kind={axis === 'x' ? 'distribute-x' : 'distribute-y'} />
              </button>
            )
          })}
        </div>
      </Section>

      <Section title="位置とサイズ">
        <div className="field-grid">
          <NumberField label="X" value={common(nodes.map((n) => n.x))} onCommit={(x) => apply({ x })} />
          <NumberField label="Y" value={common(nodes.map((n) => n.y))} onCommit={(y) => apply({ y })} />
          <NumberField
            label="W"
            value={common(nodes.map((n) => n.width))}
            min={minSize}
            // テキストは幅を決めると、その幅で折り返すようになる
            onCommit={(width) => apply(hasText ? { width, autoWidth: false } : { width })}
          />
          <NumberField
            label="H"
            value={common(nodes.map((n) => n.height))}
            min={minSize}
            // テキストの高さは中身で決まる
            disabled={hasText}
            onCommit={(height) => apply({ height })}
          />
          <NumberField
            label="回転"
            value={common(nodes.map((n) => n.rotation))}
            onCommit={(rotation) => apply({ rotation: normalizeAngle(rotation) })}
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

      {filled.length === nodes.length && (
        <Section title="塗り">
          <ColorField
            label="塗り"
            value={common(filled.map((n) => n.fill))}
            // テキストは塗りを消せない
            nullable={onlyShapes}
            fallback="#d9d9d9"
            onPreview={(fill) => preview({ fill })}
            onCommit={store.commitPreview}
            onSet={(fill) => apply({ fill })}
          />
        </Section>
      )}

      {stroked.length === nodes.length && (
        <Section title="線">
          <ColorField
            label="線"
            value={common(stroked.map((n) => n.stroke))}
            // 直線は線を消せない
            nullable={lines.length === 0}
            fallback="#000000"
            onPreview={(stroke) => preview({ stroke })}
            onCommit={store.commitPreview}
            onSet={(stroke) => apply({ stroke })}
          />
          <NumberField
            label="太さ"
            value={common(stroked.map((n) => n.strokeWidth))}
            min={0}
            onCommit={(strokeWidth) => apply({ strokeWidth })}
          />
        </Section>
      )}

      {rounded.length === nodes.length && (
        <Section title="角丸">
          <NumberField
            label="半径"
            value={common(rounded.map((n) => n.cornerRadius))}
            min={0}
            onCommit={(cornerRadius) => apply({ cornerRadius })}
          />
        </Section>
      )}

      {onlyShapes && (
        <Section title="影">
          <label className="check-field">
            <input
              type="checkbox"
              checked={shadowEnabled === true}
              ref={(input) => {
                if (input) input.indeterminate = shadowEnabled === MIXED
              }}
              onChange={(event) => apply({ shadow: event.target.checked ? DEFAULT_SHADOW : null })}
            />
            影を付ける
          </label>
          {shadows.length > 0 && (
            <>
              <div className="field-grid">
                <NumberField
                  label="横"
                  value={common(shadows.map((shadow) => shadow.x))}
                  onCommit={(x) => store.apply(patchShadows({ x }))}
                />
                <NumberField
                  label="縦"
                  value={common(shadows.map((shadow) => shadow.y))}
                  onCommit={(y) => store.apply(patchShadows({ y }))}
                />
                <NumberField
                  label="ぼかし"
                  value={common(shadows.map((shadow) => shadow.blur))}
                  min={0}
                  onCommit={(blur) => store.apply(patchShadows({ blur }))}
                />
                <NumberField
                  label="濃さ"
                  value={mapValue(common(shadows.map((shadow) => shadow.opacity)), (opacity) =>
                    Math.round(opacity * 100),
                  )}
                  min={0}
                  max={100}
                  onCommit={(percent) => store.apply(patchShadows({ opacity: percent / 100 }))}
                />
              </div>
              <ColorField
                label="影"
                value={common(shadows.map((shadow) => shadow.color))}
                nullable={false}
                fallback={DEFAULT_SHADOW.color}
                onPreview={(color) => store.preview(patchShadows({ color }))}
                onCommit={store.commitPreview}
                onSet={(color) => store.apply(patchShadows({ color: color ?? DEFAULT_SHADOW.color }))}
              />
            </>
          )}
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
          <NumberField
            label="行の高さ"
            value={common(texts.map((n) => n.lineHeight))}
            min={0.5}
            max={5}
            step={0.1}
            onCommit={(lineHeight) => apply({ lineHeight })}
          />
          <div className="button-row">
            <button
              type="button"
              className="icon-button"
              title="太字"
              aria-label="太字"
              aria-pressed={fontWeight === 700}
              onClick={() => apply({ fontWeight: fontWeight === 700 ? 400 : 700 })}
            >
              <b>B</b>
            </button>
            {TEXT_ALIGNMENTS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                className="icon-button"
                title={label}
                aria-label={label}
                aria-pressed={textAlign === value}
                onClick={() => apply({ textAlign: value })}
              >
                <TextAlignIcon align={value} />
              </button>
            ))}
          </div>
          <label className="field">
            <span className="field-label">折り返し</span>
            <select
              value={autoWidth === MIXED ? '' : autoWidth ? 'auto' : 'fixed'}
              onChange={(event) => {
                apply({ autoWidth: event.target.value === 'auto' })
                event.target.blur()
              }}
            >
              {autoWidth === MIXED && <option value="">混在</option>}
              <option value="auto">しない（幅は自動）</option>
              <option value="fixed">幅に合わせる</option>
            </select>
          </label>
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
  /** 上下キーで増減する量。Shift でその 10 倍 */
  step?: number
  disabled?: boolean
  onCommit: (value: number) => void
}

/** 入力中は下書きとして持ち、Enter かフォーカスが外れたときに確定する */
function NumberField({
  label,
  value,
  min = -Infinity,
  max = Infinity,
  step = 1,
  disabled,
  onCommit,
}: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? (value === MIXED ? '' : String(Math.round(value * 100) / 100))

  function commit(text: string | null) {
    setDraft(null)
    if (text === null || text.trim() === '') return
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) return
    // 0.1 刻みの足し算で出る端数を落とす
    onCommit(Math.round(Math.min(max, Math.max(min, parsed)) * 100) / 100)
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
            const delta = step * (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1)
            const current = draft === null ? value : Number(draft)
            commit(String((Number.isFinite(current) ? current : value) + delta))
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
