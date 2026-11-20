import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { Camera } from '../canvas/camera.ts'
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

  // 折り返し位置がキャンバスの描画と 1 行ずれても文字が隠れないよう、高さは入力欄の中身に合わせる
  useEffect(() => {
    const textarea = ref.current
    if (!textarea) return
    textarea.style.height = '0'
    textarea.style.height = `${textarea.scrollHeight}px`
  })

  const node = doc.nodes[id]
  if (node?.type !== 'text') return null

  const position = worldToScreen(viewport, getAbsolutePosition(doc, id))
  const fontSize = node.fontSize * viewport.zoom
  // 幅が自動のときは、次の 1 文字が入る余白を足しておく。
  // 中央・右寄せでは、余白のぶん入力欄を左へずらして文字の位置を描画と合わせる
  const slack = node.autoWidth ? fontSize * 2 : 0
  const align = { left: 0, center: 0.5, right: 1 }[node.textAlign]
  return (
    <textarea
      ref={ref}
      className="text-editor"
      value={node.text}
      spellCheck={false}
      style={{
        left: position.x - slack * align,
        top: position.y,
        width: node.width * viewport.zoom + slack,
        whiteSpace: node.autoWidth ? 'pre' : 'pre-wrap',
        fontSize,
        lineHeight: node.lineHeight,
        fontFamily: node.fontFamily,
        fontWeight: node.fontWeight,
        textAlign: node.textAlign,
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
