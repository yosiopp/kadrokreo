import type { EmbeddedFont } from '../../document/types.ts'
import { FONT_WEIGHT_LABELS } from '../../ui/labels.ts'
import { OpenFileButton } from '../../ui/OpenFile.tsx'
import { TrashIcon } from '../icons.tsx'
import { FONT_ACCEPT } from '../importFont.ts'

type Props = {
  fonts: readonly EmbeddedFont[]
  onAddFonts: (files: File[]) => void
  onRemoveFont: (font: EmbeddedFont) => void
}

/** 書体の太さと斜体の呼び名（一覧に出す） */
function fontFaceLabel(font: Pick<EmbeddedFont, 'weight' | 'style'>): string {
  const weight = FONT_WEIGHT_LABELS[String(font.weight)] ?? String(font.weight)
  return font.style === 'italic' ? `${weight}・斜体` : weight
}

/**
 * kdr に埋め込んだ書体の一覧（何も選んでいないときのプロパティパネル）。書体ファイルを足す・外す。
 * 埋め込んだ書体はテキストの「書体」で選べ、OS にない書体でも同じに描かれる
 */
export function FontsSection({ fonts, onAddFonts, onRemoveFont }: Props) {
  return (
    <>
      <h2 className="panel-title">書体</h2>
      {fonts.length === 0 ? (
        <p className="panel-hint">書体ファイル（TTF / OTF / WOFF / WOFF2）を kdr に入れると、OS にない書体でも同じに描かれます。再配布できる書体（SIL Open Font License など）だけを入れてください。</p>
      ) : (
        <ul className="font-list" aria-label="埋め込んだ書体">
          {fonts.map((font) => (
            <li key={`${font.family}\u0000${font.weight}\u0000${font.style}`} className="font-row">
              <span className="font-name" style={{ fontFamily: `"${font.family}"`, fontWeight: font.weight, fontStyle: font.style }}>
                {font.family}
              </span>
              <span className="font-face">{fontFaceLabel(font)}</span>
              <button
                type="button"
                className="icon-button"
                title={`${font.family}（${fontFaceLabel(font)}）を外す`}
                aria-label={`${font.family}（${fontFaceLabel(font)}）を外す`}
                onClick={() => onRemoveFont(font)}
              >
                <TrashIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="font-actions">
        <OpenFileButton accept={FONT_ACCEPT} multiple onFiles={onAddFonts}>
          書体ファイルを追加…
        </OpenFileButton>
      </div>
    </>
  )
}
