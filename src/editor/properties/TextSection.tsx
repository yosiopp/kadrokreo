import type { TextNode } from '../../document/types.ts'
import { TextAlignIcon } from '../icons.tsx'
import { type PanelContext, textsIn, MIXED, common, mapValue } from './context.ts'
import { NumberField, Section, SelectField } from './fields.tsx'

const FONT_FAMILIES = [
  { value: 'sans-serif', label: 'ゴシック体' },
  { value: 'serif', label: '明朝体' },
  { value: 'monospace', label: '等幅' },
]

const TEXT_ALIGNMENTS: { value: TextNode['textAlign']; label: string }[] = [
  { value: 'left', label: '左寄せ' },
  { value: 'center', label: '中央寄せ' },
  { value: 'right', label: '右寄せ' },
]

/** テキストだけを選んでいるときの、文字の書式 */
export function TextSection({ ctx }: { ctx: PanelContext }) {
  const { nodes, apply, inner } = ctx
  const texts = textsIn(nodes)
  if (texts.length !== nodes.length) return null
  const fontFamily = common(texts.map((node) => node.fontFamily))
  const autoWidth = common(texts.map((node) => node.autoWidth))
  const fontWeight = common(texts.map((node) => node.fontWeight))
  const textAlign = common(texts.map((node) => node.textAlign))

  return (
    <Section title="テキスト">
      <NumberField
        label="サイズ"
        value={common(texts.map((n) => n.fontSize))}
        min={1}
        max={1000}
        onCommit={(fontSize) => apply({ fontSize })}
      />
      {!inner && (
        <NumberField
          label="行の高さ"
          value={common(texts.map((n) => n.lineHeight))}
          min={0.5}
          max={5}
          step={0.1}
          onCommit={(lineHeight) => apply({ lineHeight })}
        />
      )}
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
        {/* 写しの行揃えは上書きできない */}
        {!inner && TEXT_ALIGNMENTS.map(({ value, label }) => (
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
      {!inner && (
        <SelectField
          label="折り返し"
          value={mapValue(autoWidth, (auto) => (auto ? 'auto' : 'fixed'))}
          options={[
            ['auto', 'しない（幅は自動）'],
            ['fixed', '幅に合わせる'],
          ]}
          onChange={(wrap) => apply({ autoWidth: wrap === 'auto' })}
        />
      )}
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
  )
}
