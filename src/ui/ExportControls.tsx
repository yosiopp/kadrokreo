import { type ReactNode, useEffect, useState } from 'react'
import { setExportOptions, useExportOptions } from './exportOptions.ts'

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

/** PNG 書き出しの倍率と実行ボタン、SVG 書き出しとコピーのボタンと、書き出しのオプション（背景は PNG と SVG、id と書体は SVG だけ） */
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
      <ExportOptionFields svg={Boolean(onExportSvg || onCopySvg)} />
    </>
  )
}

/** 書き出しのオプション。背景を敷くか（PNG と SVG。CLI の --background）と、レイヤー名の id・埋め込んだ書体を入れるか（SVG だけ。CLI の --no-ids・--no-fonts の逆） */
function ExportOptionFields({ svg }: { svg: boolean }) {
  const options = useExportOptions()
  return (
    <div className="export-row export-options">
      <label title="書き出す範囲全体に背景の色を敷く（PNG と SVG。外すと透明）">
        <input
          type="checkbox"
          checked={options.background !== null}
          onChange={(event) => setExportOptions({ background: event.target.checked ? '#ffffff' : null })}
        />
        背景
      </label>
      {options.background !== null && (
        <input
          type="color"
          aria-label="書き出しの背景の色"
          value={options.background}
          onChange={(event) => setExportOptions({ background: event.target.value })}
        />
      )}
      {svg && (
        <label title="SVG の要素に、レイヤー名から作る id を付ける（取り込み直すとレイヤー名に戻る）">
          <input type="checkbox" checked={options.ids} onChange={(event) => setExportOptions({ ids: event.target.checked })} />
          SVG に id
        </label>
      )}
      {svg && (
        <label title="テキストが使う、kdr に埋め込んだ書体のファイルを SVG に入れる（その書体のない環境でも同じ書体で表示される。ファイルは大きくなる）">
          <input
            type="checkbox"
            checked={options.embedFonts}
            onChange={(event) => setExportOptions({ embedFonts: event.target.checked })}
          />
          SVG に書体
        </label>
      )}
    </div>
  )
}
