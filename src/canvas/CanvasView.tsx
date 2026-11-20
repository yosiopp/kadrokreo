import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { Point } from '../document/geometry.ts'
import type { DesignDocument, NodeId } from '../document/types.ts'
import type { Camera } from './camera.ts'
import { isTextInput } from './dom.ts'
import { renderDocument } from './render.ts'
import { type Viewport, screenToWorld } from './viewport.ts'

export type CanvasPointer = {
  /** キャンバス左上を原点とする画面座標 */
  screen: Point
  /** ページ座標 */
  world: Point
  shiftKey: boolean
  altKey: boolean
  /** Cmd（macOS）または Ctrl */
  modKey: boolean
}

type Props = {
  document: DesignDocument
  camera: Camera
  /** 左ドラッグでパンする。編集操作のない viewer 用 */
  panWithPrimaryButton?: boolean
  hiddenId?: NodeId | null
  cursor?: string
  /** ドキュメントの上に画面座標で重ねて描く（選択枠など） */
  drawOverlay?: (ctx: CanvasRenderingContext2D, viewport: Viewport) => void
  onPointerDown?: (pointer: CanvasPointer) => void
  onPointerMove?: (pointer: CanvasPointer) => void
  onPointerUp?: (pointer: CanvasPointer) => void
  onPointerCancel?: () => void
  onDoubleClick?: (pointer: CanvasPointer) => void
  children?: ReactNode
}

export function CanvasView(props: Props) {
  const { camera } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const propsRef = useRef(props)
  const requestDrawRef = useRef(() => {})
  const dragRef = useRef<{ kind: 'pan'; x: number; y: number } | { kind: 'forward' } | null>(null)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [panning, setPanning] = useState(false)

  // 描画は rAF でまとめる。props は ref 経由で常に最新を見る
  useEffect(() => {
    propsRef.current = props
    requestDrawRef.current()
  })

  useEffect(() => {
    const container = containerRef.current!
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    let frame = 0

    function draw() {
      frame = 0
      const { document, drawOverlay, hiddenId } = propsRef.current
      const size = camera.getSize()
      const pixelRatio = window.devicePixelRatio || 1
      const width = Math.round(size.width * pixelRatio)
      const height = Math.round(size.height * pixelRatio)
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }

      const viewport = camera.getViewport()
      const labelColor = getComputedStyle(container).getPropertyValue('--canvas-label')
      renderDocument(ctx, document, viewport, size, pixelRatio, { labelColor, hiddenId })
      if (drawOverlay) {
        ctx.save()
        drawOverlay(ctx, viewport)
        ctx.restore()
      }
    }

    function requestDraw() {
      if (frame === 0) frame = requestAnimationFrame(draw)
    }
    requestDrawRef.current = requestDraw

    const observer = new ResizeObserver(() => {
      camera.setSize({ width: container.clientWidth, height: container.clientHeight })
      requestDraw()
    })
    observer.observe(container)
    const unsubscribe = camera.subscribe(requestDraw)

    function onWheel(event: WheelEvent) {
      event.preventDefault()
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1
      if (event.ctrlKey || event.metaKey) {
        // トラックパッドのピンチも ctrlKey つきの wheel として届く
        const delta = Math.max(-50, Math.min(50, event.deltaY * unit))
        const rect = container.getBoundingClientRect()
        const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top }
        camera.zoomAt(anchor, camera.getViewport().zoom * Math.exp(-delta * 0.01))
      } else if (event.shiftKey && event.deltaX === 0) {
        camera.panBy(-event.deltaY * unit, 0)
      } else {
        camera.panBy(-event.deltaX * unit, -event.deltaY * unit)
      }
    }
    container.addEventListener('wheel', onWheel, { passive: false })

    function onKey(event: KeyboardEvent) {
      // フォーカス中のボタンでは Space は「押す」操作なので奪わない
      if (event.code !== 'Space' || isTextInput(event.target)) return
      if (event.target instanceof HTMLButtonElement) return
      event.preventDefault()
      setSpaceHeld(event.type === 'keydown')
    }
    const onBlur = () => setSpaceHeld(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    window.addEventListener('blur', onBlur)

    return () => {
      cancelAnimationFrame(frame)
      requestDrawRef.current = () => {}
      observer.disconnect()
      unsubscribe()
      container.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', onBlur)
    }
  }, [camera])

  function toPointer(event: ReactMouseEvent): CanvasPointer {
    const rect = containerRef.current!.getBoundingClientRect()
    const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    return {
      screen,
      world: screenToWorld(camera.getViewport(), screen),
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      modKey: event.metaKey || event.ctrlKey,
    }
  }

  const panMode = spaceHeld || props.panWithPrimaryButton === true

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    // 入力欄など、キャンバスの上に重ねた要素への操作は拾わない
    if (event.target !== canvasRef.current || dragRef.current) return
    if (event.button === 1 || (event.button === 0 && panMode)) {
      dragRef.current = { kind: 'pan', x: event.clientX, y: event.clientY }
      setPanning(true)
    } else if (event.button === 0) {
      dragRef.current = { kind: 'forward' }
      props.onPointerDown?.(toPointer(event))
    } else {
      return
    }
    // コンテナではなくキャンバスで捕まえる。続く click / dblclick の target がキャンバスのままになる
    canvasRef.current!.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (drag?.kind === 'pan') {
      camera.panBy(event.clientX - drag.x, event.clientY - drag.y)
      drag.x = event.clientX
      drag.y = event.clientY
    } else if (drag || event.target === canvasRef.current) {
      props.onPointerMove?.(toPointer(event))
    }
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    if (drag.kind === 'pan') setPanning(false)
    else if (cancelled) props.onPointerCancel?.()
    else props.onPointerUp?.(toPointer(event))
  }

  return (
    <div
      ref={containerRef}
      className="canvas-view"
      style={{ cursor: panning ? 'grabbing' : panMode ? 'grab' : props.cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => endDrag(event, false)}
      onPointerCancel={(event) => endDrag(event, true)}
      // 中ボタンのオートスクロールを止める
      onMouseDown={(event) => event.button === 1 && event.preventDefault()}
      onDoubleClick={(event) => {
        if (event.target === canvasRef.current && !panMode) props.onDoubleClick?.(toPointer(event))
      }}
    >
      <canvas ref={canvasRef} />
      {props.children}
    </div>
  )
}
