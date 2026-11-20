import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { Camera } from '../canvas/camera.ts'
import { LINE_HEIGHT } from '../canvas/text.ts'
import { worldToScreen } from '../canvas/viewport.ts'
import { getAbsolutePosition } from '../document/geometry.ts'
import type { DesignDocument, NodeId } from '../document/types.ts'

type Props = {
  document: DesignDocument
  camera: Camera
  id: NodeId
  /** 既存のテキストを開いたときは全選択して、そのまま打ち替えられるようにする */
  selectAll: boolean
  onInput: (text: string) => void
  onDone: () => void
}

/** キャンバス上のテキストに重ねる入力欄。描画側と同じフォント・行送りにして見た目を揃える */
export function TextEditor({ document: doc, camera, id, selectAll, onInput, onDone }: Props) {
  const viewport = useSyncExternalStore(camera.subscribe, camera.getViewport)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
    if (selectAll) ref.current?.select()
  }, [selectAll])

  const node = doc.nodes[id]
  if (node?.type !== 'text') return null

  const position = worldToScreen(viewport, getAbsolutePosition(doc, id))
  const fontSize = node.fontSize * viewport.zoom
  return (
    <textarea
      ref={ref}
      className="text-editor"
      value={node.text}
      spellCheck={false}
      style={{
        left: position.x,
        top: position.y,
        // 次の 1 文字が入る余白を足しておく
        width: node.width * viewport.zoom + fontSize * 2,
        height: node.height * viewport.zoom,
        fontSize,
        lineHeight: LINE_HEIGHT,
        fontFamily: node.fontFamily,
        color: node.fill,
      }}
      onChange={(event) => onInput(event.target.value)}
      onBlur={onDone}
      onKeyDown={(event) => {
        // 変換中の Escape / Enter は IME のもの
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
          event.currentTarget.blur()
        }
      }}
    />
  )
}
