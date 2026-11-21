type Props = {
  /** 出す文言。null なら何も出さない */
  text: string | null
  onClose: () => void
}

/** 画面の上に出す知らせ（エラーなど）。× で閉じる */
export function Message({ text, onClose }: Props) {
  if (text === null || text === '') return null
  return (
    <div className="app-message" role="alert">
      {text}
      <button type="button" aria-label="閉じる" onClick={onClose}>
        ×
      </button>
    </div>
  )
}
