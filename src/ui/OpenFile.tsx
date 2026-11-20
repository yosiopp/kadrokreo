import { type ReactNode, useRef } from 'react'
import { KDR_EXTENSION } from '../document/kdr.ts'

type ButtonProps = {
  onFile: (file: File) => void
  className?: string
  children: ReactNode
}

export function OpenFileButton({ onFile, className, children }: ButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <button type="button" className={className} onClick={() => inputRef.current?.click()}>
        {children}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={KDR_EXTENSION}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          // 同じファイルを続けて選んでも change が起きるように戻しておく
          event.target.value = ''
          if (file) onFile(file)
        }}
      />
    </>
  )
}
