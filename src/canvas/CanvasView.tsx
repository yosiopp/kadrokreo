import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { Point } from '../document/geometry.ts'
import type { Asset, AssetId, NodeId, Scene } from '../document/types.ts'
import type { Camera } from './camera.ts'
import { isTextInput } from './dom.ts'
import { onImageLoad } from './images.ts'
import { SceneCache } from './sceneCache.ts'
import { type Viewport, screenToWorld } from './viewport.ts'

export type CanvasPointer = {
  /** キャンバス左上を原点とする画面座標 */
  screen: Point
  /** ウィンドウ左上を原点とする画面座標（clientX / clientY） */
  client: Point
  /** ページ座標 */
  world: Point
  shiftKey: boolean
  altKey: boolean
  /** Cmd（macOS）または Ctrl */
  modKey: boolean
}

type Props = {
  /** 表示するページ */
  scene: Scene
  assets: Record<AssetId, Asset>
  camera: Camera
  /** 左ドラッグでパンする。編集操作のない viewer 用 */
  panWithPrimaryButton?: boolean
  /** 左ドラッグでパンするとき、動かさずに離した（クリックした）場合に呼ぶ */
  onClick?: (pointer: CanvasPointer) => void
  hiddenId?: NodeId | null
  cursor?: string
  /** ドキュメントの上に画面座標で重ねて描く（選択枠など） */
  drawOverlay?: (ctx: CanvasRenderingContext2D, viewport: Viewport) => void
  onPointerDown?: (pointer: CanvasPointer) => void
  onPointerMove?: (pointer: CanvasPointer) => void
  onPointerUp?: (pointer: CanvasPointer) => void
  onPointerCancel?: () => void
  /** ポインタがキャンバスの外へ出た */
  onPointerLeave?: () => void
  onDoubleClick?: (pointer: CanvasPointer) => void
  /** 右クリック。渡したときだけ、ブラウザのメニューを出さない */
  onContextMenu?: (pointer: CanvasPointer) => void
  children?: ReactNode
}

/** これより動かさずに離したら、ドラッグではなくクリックとみなす（画面ピクセル） */
const CLICK_TRAVEL = 4
/** ホイールのズームがこれだけ途切れたら止まったとみなし、拡大・縮小して見せていた絵を描き直す（ms） */
const ZOOM_SETTLE = 120
/** ズームし続けていても、これだけ経ったら一度描き直す（ぼやけたままにしない。ms） */
const ZOOM_SHARPEN = 300

export function CanvasView(props: Props) {
  const { camera } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const propsRef = useRef(props)
  const requestDrawRef = useRef(() => {})
  // pan の travel は、押してから動いた距離。クリックとドラッグを見分けるのに使う
  const dragRef = useRef<
    { kind: 'pan'; x: number; y: number; travel: number; click: boolean } | { kind: 'forward' } | null
  >(null)
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
    // ページの絵は取っておき、選択枠だけが変わったときやパンでは使い回す（sceneCache.ts）
    const cache = new SceneCache()
    let frame = 0
    // ホイールでズームしている途中か。lastWheel は最後にズームしたとき、sharpAt は最後に全部を描いたとき（performance.now）
    let zoomGesture: { lastWheel: number; sharpAt: number } | null = null
    let settleTimer = 0

    function draw() {
      frame = 0
      const { scene, assets, drawOverlay, hiddenId } = propsRef.current
      const size = camera.getSize()
      const pixelRatio = window.devicePixelRatio || 1
      const width = Math.round(size.width * pixelRatio)
      const height = Math.round(size.height * pixelRatio)
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }

      // 大きさが決まる前（0 × 0）は描かない（drawImage が例外を投げる）
      if (width === 0 || height === 0) return
      const viewport = camera.getViewport()
      const labelColor = getComputedStyle(container).getPropertyValue('--canvas-label')
      const now = performance.now()
      const zooming = zoomGesture !== null && now - zoomGesture.lastWheel < ZOOM_SETTLE && now - zoomGesture.sharpAt < ZOOM_SHARPEN
      const kind = cache.render(ctx, { scene, assets, viewport, size, pixelRatio, labelColor, hiddenId }, zooming)
      if (zoomGesture) {
        if (kind === 'preview') {
          // 止まったら描き直す
          clearTimeout(settleTimer)
          settleTimer = window.setTimeout(requestDraw, Math.max(0, zoomGesture.lastWheel + ZOOM_SETTLE - now) + 1)
        } else if (now - zoomGesture.lastWheel >= ZOOM_SETTLE) zoomGesture = null
        else zoomGesture.sharpAt = now
      }
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
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
    // 書体の読み込みが済んだら、取っておいた絵は古い。画像のデコードが済んだら、その画像を使うノードだけを描き直す
    const redrawAll = () => {
      cache.invalidate()
      requestDraw()
    }
    const unsubscribeImages = onImageLoad((asset) => {
      cache.invalidateAsset(asset)
      requestDraw()
    })
    document.fonts?.addEventListener('loadingdone', redrawAll)

    function onWheel(event: WheelEvent) {
      event.preventDefault()
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1
      if (event.ctrlKey || event.metaKey) {
        // トラックパッドのピンチも ctrlKey つきの wheel として届く
        const delta = Math.max(-50, Math.min(50, event.deltaY * unit))
        const rect = container.getBoundingClientRect()
        const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top }
        const now = performance.now()
        if (zoomGesture) zoomGesture.lastWheel = now
        else zoomGesture = { lastWheel: now, sharpAt: now }
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
      clearTimeout(settleTimer)
      requestDrawRef.current = () => {}
      observer.disconnect()
      unsubscribe()
      unsubscribeImages()
      document.fonts?.removeEventListener('loadingdone', redrawAll)
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
      client: { x: event.clientX, y: event.clientY },
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
      // Space や中ボタンでのパンは、動かさなくてもクリックとはみなさない
      const click = event.button === 0 && !spaceHeld
      dragRef.current = { kind: 'pan', x: event.clientX, y: event.clientY, travel: 0, click }
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
      drag.travel += Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y)
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
    if (drag.kind === 'pan') {
      setPanning(false)
      if (drag.click && !cancelled && drag.travel < CLICK_TRAVEL) props.onClick?.(toPointer(event))
    } else if (cancelled) props.onPointerCancel?.()
    else props.onPointerUp?.(toPointer(event))
  }

  return (
    <div
      ref={containerRef}
      className="canvas-view"
      // 画面を動かしている間と、Space を押している間のほかは、指定されたカーソルを出す
      style={{ cursor: panning ? 'grabbing' : spaceHeld ? 'grab' : props.cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => endDrag(event, false)}
      onPointerCancel={(event) => endDrag(event, true)}
      onPointerLeave={() => props.onPointerLeave?.()}
      // 中ボタンのオートスクロールを止める
      onMouseDown={(event) => event.button === 1 && event.preventDefault()}
      // 左ボタンで画面を動かす viewer でも、動かさずに 2 回押せばダブルクリック。Space を押している間は画面の移動だけ
      onDoubleClick={(event) => {
        if (event.target === canvasRef.current && !spaceHeld) props.onDoubleClick?.(toPointer(event))
      }}
      onContextMenu={(event) => {
        if (event.target !== canvasRef.current || !props.onContextMenu || dragRef.current) return
        event.preventDefault()
        props.onContextMenu(toPointer(event))
      }}
    >
      <canvas ref={canvasRef} />
      {props.children}
    </div>
  )
}
