import { type ReactNode, useEffect, useState } from 'react'

type Props = {
  scale: number
  onScaleChange: (scale: number) => void
  onExport: () => void
  /** SVG に書き出す（倍率は使わない）。省くとボタンを出さない */
  onExportSvg?: () => void
  /** SVG の文字をクリップボードへ入れる（入れられたら true）。省くとボタンを出さない */
  onCopySvg?: () => Promise<boolean>
  children: ReactNode
}

/** PNG 書き出しの倍率と実行ボタン、SVG 書き出しとコピーのボタン */
export function ExportControls({ scale, onScaleChange, onExport, onExportSvg, onCopySvg, children }: Props) {
  // 「SVG をコピー」を押したあと、少しのあいだ「コピーしました」と出す
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  return (
    <>
      <div className="export-row">
        <select
          aria-label="書き出しの倍率"
          value={scale}
          onChange={(event) => {
            onScaleChange(Number(event.target.value))
            // フォーカスを残すとキーボードショートカットが効かなくなる
            event.target.blur()
          }}
        >
          <option value={1}>1x</option>
          <option value={2}>2x</option>
          <option value={3}>3x</option>
        </select>
        <button type="button" onClick={onExport}>
          {children}
        </button>
      </div>
      {/* 倍率は PNG にだけ効くので、SVG は倍率の行の下に分けて置く（viewer の左の狭い欄にも収まる） */}
      {(onExportSvg || onCopySvg) && (
        <div className="export-row export-svg">
          {onExportSvg && (
            <button type="button" title="SVG ファイルに書き出し" onClick={onExportSvg}>
              SVG に
            </button>
          )}
          {onCopySvg && (
            <button
              type="button"
              title="SVG の文字をクリップボードへコピー（ほかのツールや editor に貼り付けられる）"
              onClick={async () => setCopied(await onCopySvg())}
            >
              {copied ? 'コピーしました' : 'SVG をコピー'}
            </button>
          )}
        </div>
      )}
    </>
  )
}
