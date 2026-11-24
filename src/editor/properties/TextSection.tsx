import { fontFamilyValue } from '../../document/fontFile.ts'
import type { TextNode } from '../../document/types.ts'
import { OpenFileButton } from '../../ui/OpenFile.tsx'
import { FONT_WEIGHT_LABELS, optionsOf } from '../../ui/labels.ts'
import { TextAlignIcon } from '../icons.tsx'
import { type PanelContext, textsIn, MIXED, common, mapValue } from './context.ts'
import { NumberField, OverrideMark, Section, SelectField } from './fields.tsx'
import { FONT_ACCEPT } from '../importFont.ts'
import { isPathText } from '../../document/textPath.ts'
import { fitTextNodes } from '../measure.ts'
import { detachTextFromPath, setTextPathOffset } from '../operations/textPath.ts'

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
export function TextSection({ ctx, onAddFonts }: { ctx: PanelContext; onAddFonts: (files: File[]) => Promise<string | null> }) {
  const { nodes, apply, inner, overridden } = ctx
  const texts = textsIn(nodes)
  if (texts.length !== nodes.length) return null
  const fontFamily = common(texts.map((node) => node.fontFamily))
  const autoWidth = common(texts.map((node) => node.sizing.width === 'hug'))
  const fontWeight = common(texts.map((node) => node.fontWeight))
  const textAlign = common(texts.map((node) => node.textAlign))
  // kdr に埋め込んだ書体（同じ書体名の太さ違いは 1 つにまとめる）
  const embedded = [...new Set(ctx.state.document.fonts.map((font) => font.family))].map((family) => ({
    value: fontFamilyValue(family),
    label: family,
  }))
  const known = [...FONT_FAMILIES, ...embedded]
  // 線に沿うテキスト（折り返し・行の高さは効かない）
  const onPath = texts.every(isPathText)
  const offPath = !texts.some(isPathText)
  const startOffset = common(texts.map((node) => node.textPath?.startOffset ?? 0))

  return (
    <Section title="テキスト" overridden={overridden.has('text')}>
      <NumberField
        label="サイズ"
        overridden={overridden.has('fontSize')}
        value={common(texts.map((n) => n.fontSize))}
        min={1}
        max={1000}
        onCommit={(fontSize) => apply({ fontSize })}
      />
      {!inner && offPath && (
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
        <OverrideMark show={overridden.has('fontWeight')} />
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
      <SelectField
        label="太さ"
        overridden={overridden.has('fontWeight')}
        value={mapValue(fontWeight, String)}
        options={optionsOf(FONT_WEIGHT_LABELS)}
        onChange={(weight) => apply({ fontWeight: Number(weight) })}
      />
      {!inner && onPath && (
        <>
          <NumberField
            label="パスの始まり（%）"
            value={mapValue(startOffset, (value) => Math.round(value * 1000) / 10)}
            min={0}
            max={100}
            onCommit={(percent) => ctx.store.apply((base) => setTextPathOffset(base, ctx.selection, percent / 100))}
          />
          <div className="font-actions">
            <button
              type="button"
              onClick={() => ctx.store.apply((base) => fitTextNodes(detachTextFromPath(base, ctx.selection), ctx.selection))}
            >
              パスから外す
            </button>
          </div>
        </>
      )}
      {!inner && offPath && (
        <SelectField
          label="折り返し"
          value={mapValue(autoWidth, (auto) => (auto ? 'auto' : 'fixed'))}
          options={[
            ['auto', 'しない（幅は自動）'],
            ['fixed', '幅に合わせる'],
          ]}
          onChange={(wrap) => apply({ sizing: { width: wrap === 'auto' ? 'hug' : 'fixed', height: 'hug' } })}
        />
      )}
      <label className="field">
        <span className="field-label">
          書体
          <OverrideMark show={overridden.has('fontFamily')} />
        </span>
        <select
          value={fontFamily === MIXED ? '' : fontFamily}
          onChange={(event) => {
            apply({ fontFamily: event.target.value })
            // フォーカスを残すとキーボードショートカットが効かなくなる
            event.target.blur()
          }}
        >
          {fontFamily === MIXED && <option value="">混在</option>}
          {typeof fontFamily === 'string' && !known.some((f) => f.value === fontFamily) && (
            <option value={fontFamily}>{fontFamily}</option>
          )}
          {FONT_FAMILIES.map((font) => (
            <option key={font.value} value={font.value}>
              {font.label}
            </option>
          ))}
          {embedded.length > 0 && (
            <optgroup label="kdr に埋め込んだ書体">
              {embedded.map((font) => (
                <option key={font.value} value={font.value}>
                  {font.label}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      <div className="font-actions">
        <OpenFileButton
          accept={FONT_ACCEPT}
          onFiles={async (files) => {
            const family = await onAddFonts(files)
            if (family !== null) apply({ fontFamily: family })
          }}
        >
          書体ファイルを追加…
        </OpenFileButton>
      </div>
    </Section>
  )
}
