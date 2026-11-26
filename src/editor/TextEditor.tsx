import { alignFactor, paintColor, solidColor } from '../document/paint.ts'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { Camera } from '../canvas/camera.ts'
import { worldToScreen } from '../canvas/viewport.ts'
import { getWorldCenter, getWorldRotation } from '../document/geometry.ts'
import type { NodeId, Scene } from '../document/types.ts'

type Props = {
  scene: Scene
  camera: Camera
  id: NodeId
  /** 既存のテキストを開いたときは全選択して、そのまま打ち替えられるようにする */
  selectAll: boolean
  onInput: (text: string) => void
  onDone: () => void
}

/** キャンバス上のテキストに重ねる入力欄。描画側と同じフォント・行送りにして見た目を揃える */
export function TextEditor({ scene, camera, id, selectAll, onInput, onDone }: Props) {
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

  const node = scene.nodes[id]
  if (node?.type !== 'text') return null

  const center = worldToScreen(viewport, getWorldCenter(scene, id))
  const rotation = getWorldRotation(scene, id)
  const width = node.width * viewport.zoom
  const height = node.height * viewport.zoom
  const fontSize = node.fontSize * viewport.zoom
  // 幅が自動のときは、次の 1 文字が入る余白を足しておく。
  // 中央・右寄せでは、余白のぶん入力欄を左へずらして文字の位置を描画と合わせる
  // 上限（maxWidth）に届いて折り返しているときは、幅を決めたテキストと同じに扱う
  const autoWidth = node.sizing.width === 'hug' && (node.maxWidth === null || node.width < node.maxWidth)
  const slack = autoWidth ? fontSize * 2 : 0
  const align = alignFactor(node.textAlign)
  return (
    <textarea
      ref={ref}
      className="text-editor"
      value={node.text}
      spellCheck={false}
      style={{
        left: center.x - width / 2 - slack * align,
        top: center.y - height / 2,
        width: width + slack,
        // 回転したテキストは、描画と同じく枠の中心を軸に回す
        transform: rotation === 0 ? undefined : `rotate(${rotation}deg)`,
        transformOrigin: `${slack * align + width / 2}px ${height / 2}px`,
        whiteSpace: autoWidth ? 'pre' : 'pre-wrap',
        fontSize,
        lineHeight: node.lineHeight,
        fontFamily: node.fontFamily,
        fontWeight: node.fontWeight,
        textAlign: node.textAlign,
        letterSpacing: node.letterSpacing * viewport.zoom,
        textDecoration: node.textDecoration === 'none' ? undefined : node.textDecoration,
        color: solidColor(node.fills) ?? (node.fills[0] ? paintColor(node.fills[0]) : 'transparent'),
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
