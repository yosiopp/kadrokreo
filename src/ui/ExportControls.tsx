import type { ReactNode } from 'react'

type Props = {
  scale: number
  onScaleChange: (scale: number) => void
  onExport: () => void
  children: ReactNode
}

/** PNG 書き出しの倍率と実行ボタン */
export function ExportControls({ scale, onScaleChange, onExport, children }: Props) {
  return (
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
  )
}
