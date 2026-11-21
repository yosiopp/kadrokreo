type Props = {
  /** いまの名前 */
  name: string
  /** Enter かフォーカスが外れたときに、入力された名前（前後の空白を除く前のもの）で呼ぶ */
  onCommit: (name: string) => void
}

/** 一覧の行の中で、名前を打ち直す欄。Esc でやめる */
export function RenameInput({ name, onCommit }: Props) {
  return (
    <input
      className="layer-name-input"
      defaultValue={name}
      autoFocus
      onFocus={(event) => event.target.select()}
      onClick={(event) => event.stopPropagation()}
      onBlur={(event) => onCommit(event.target.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          // 元の名前に戻してから確定すれば、何も変わらない
          event.currentTarget.value = name
          event.currentTarget.blur()
        }
      }}
    />
  )
}
