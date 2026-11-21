import { type ReactNode, useEffect, useRef, useState } from 'react'
import { tidy } from '../../document/geometry.ts'
import { ExportControls } from '../../ui/ExportControls.tsx'
import { MIXED, type Mixed } from './context.ts'

// プロパティパネルの欄の部品。どれも、複数選択で値が揃っていないとき（MIXED）の出し方を持つ

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel-section">
      <h3 className="section-title">{title}</h3>
      {children}
    </section>
  )
}

export function ExportSection({ label, onExport }: { label: string; onExport: (scale: number) => void }) {
  const [scale, setScale] = useState(1)
  return (
    <Section title="書き出し">
      <ExportControls scale={scale} onScaleChange={setScale} onExport={() => onExport(scale)}>
        {label}
      </ExportControls>
    </Section>
  )
}

type TextFieldProps = {
  label: string
  value: string
  onCommit: (value: string) => void
}

/** 文字の欄。NumberField と同じく、Enter かフォーカスが外れたときに確定し、Esc で打ち直しを捨てる */
export function TextField({ label, value, onCommit }: TextFieldProps) {
  const [draft, setDraft] = useState<string | null>(null)
  function commit() {
    if (draft !== null && draft !== value) onCommit(draft)
    setDraft(null)
  }
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type="text"
        value={draft ?? value}
        onFocus={(event) => event.target.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          else if (event.key === 'Escape') {
            const input = event.currentTarget
            setDraft(null)
            requestAnimationFrame(() => input.blur())
          }
        }}
      />
    </label>
  )
}

type SelectFieldProps<T extends string> = {
  label: string
  value: T | Mixed
  /** [値, 表示名] の並び */
  options: readonly (readonly [T, string])[]
  onChange: (value: T) => void
}

export function SelectField<T extends string>({ label, value, options, onChange }: SelectFieldProps<T>) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select
        value={value === MIXED ? '' : value}
        onChange={(event) => {
          onChange(event.target.value as T)
          // フォーカスを残すとキーボードショートカットが効かなくなる
          event.target.blur()
        }}
      >
        {value === MIXED && <option value="">混在</option>}
        {options.map(([option, name]) => (
          <option key={option} value={option}>
            {name}
          </option>
        ))}
      </select>
    </label>
  )
}

type CheckFieldProps = {
  label: string
  value: boolean | Mixed
  onChange: (checked: boolean) => void
}

/** 選んでいるもので値が揃っていなければ、どちらでもない印にする */
export function CheckField({ label, value, onChange }: CheckFieldProps) {
  return (
    <label className="check-field">
      <input
        type="checkbox"
        checked={value === true}
        ref={(input) => {
          if (input) input.indeterminate = value === MIXED
        }}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  )
}

type NumberFieldProps = {
  label: string
  /** null は「決めていない」。空欄で出し、onClear があれば空欄にして確定すると呼ぶ */
  value: number | Mixed | null
  min?: number
  max?: number
  /** 上下キーで増減する量。Shift でその 10 倍 */
  step?: number
  disabled?: boolean
  onCommit: (value: number) => void
  onClear?: () => void
}

/** 入力中は下書きとして持ち、Enter かフォーカスが外れたときに確定する */
export function NumberField({
  label,
  value,
  min = -Infinity,
  max = Infinity,
  step = 1,
  disabled,
  onCommit,
  onClear,
}: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? (value === MIXED || value === null ? '' : String(tidy(value)))

  function commit(text: string | null) {
    setDraft(null)
    if (text === null) return
    if (text.trim() === '') {
      if (value !== null) onClear?.()
      return
    }
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) return
    // 0.1 刻みの足し算で出る端数を落とす
    onCommit(tidy(Math.min(max, Math.max(min, parsed))))
  }

  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={shown}
        placeholder={value === MIXED ? '混在' : value === null ? 'なし' : undefined}
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
            const fallback = value ?? 0
            const current = draft === null ? fallback : Number(draft)
            commit(String((Number.isFinite(current) ? current : fallback) + delta))
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

export function ColorField({ label, value, nullable, fallback, onPreview, onCommit, onSet }: ColorFieldProps) {
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
