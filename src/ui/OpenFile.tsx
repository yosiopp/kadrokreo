import { type ReactNode, useRef } from 'react'
import { KDR_EXTENSION } from '../document/kdr.ts'

type Props = {
  onFiles: (files: File[]) => void
  /** 選べるファイルの種類。省略すると kdr ファイル */
  accept?: string
  multiple?: boolean
  className?: string
  title?: string
  children: ReactNode
}

export function OpenFileButton({
  onFiles,
  accept = KDR_EXTENSION,
  multiple,
  className,
  title,
  children,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <button type="button" className={className} title={title} onClick={() => inputRef.current?.click()}>
        {children}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          // 同じファイルを続けて選んでも change が起きるように戻しておく
          event.target.value = ''
          if (files.length > 0) onFiles(files)
        }}
      />
    </>
  )
}
