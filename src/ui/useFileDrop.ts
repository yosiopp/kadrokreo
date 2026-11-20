import { useEffect, useRef, useState } from 'react'

/** ウィンドウへのファイルのドロップを受け付ける。ドラッグ中かどうかを返す */
export function useFileDrop(onFile: (file: File) => void): boolean {
  const [dragging, setDragging] = useState(false)
  const onFileRef = useRef(onFile)
  useEffect(() => {
    onFileRef.current = onFile
  })

  useEffect(() => {
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') === true

    function onDragOver(event: DragEvent) {
      if (!hasFiles(event)) return
      event.preventDefault()
      setDragging(true)
    }
    function onDragLeave(event: DragEvent) {
      // ウィンドウの外へ出たときだけ解除する
      if (event.relatedTarget === null) setDragging(false)
    }
    function onDrop(event: DragEvent) {
      if (!hasFiles(event)) return
      event.preventDefault()
      setDragging(false)
      const file = event.dataTransfer?.files[0]
      if (file) onFileRef.current(file)
    }

    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  return dragging
}
