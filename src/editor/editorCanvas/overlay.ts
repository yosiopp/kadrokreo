import {
  OVERLAY_ACCENT,
  OVERLAY_COMPONENT,
  OVERLAY_GUIDE,
  drawBadge,
  overlayColor,
  strokePolyline,
} from '../../canvas/overlay.ts'
import { type Viewport, worldToScreen } from '../../canvas/viewport.ts'
import { type Point, applyMatrix, boundsFromPoints, getCorners, normalizeAngle } from '../../document/geometry.ts'
import type { NodeId, PathNode, Scene } from '../../document/types.ts'
import { type Vertex, isLine, mapVertices, pathSegments, roundCorners, tracePath } from '../../document/path.ts'
import { isVariantSet } from '../../document/variants.ts'
import { handlePoint } from '../resize.ts'
import { drawConstraintMarks } from './constraintMarks.ts'
import type { Gesture } from './drag.ts'
import {
  HANDLE_SIZE,
  type SelectionBox,
  boxToScreen,
  editablePoints,
  rotateHandlePoint,
  toScreenBounds,
  visibleControls,
  visibleHandles,
} from './handles.ts'

/** キャンバスの上に重ねて描く、編集のための印の材料 */
export type OverlayState = {
  page: Scene
  selection: readonly NodeId[]
  /** ポインタの下にあるノード */
  hover: NodeId | null
  gesture: Gesture | null
  /** 点をつかんで形を変えられるノード（選んでいる直線や、頂点を編集中のパス） */
  pointed: PathNode | null
  /** 頂点を編集中のパス */
  editedId: NodeId | undefined
  /** 頂点の編集中に選んでいる頂点の番号 */
  selectedVertices: readonly number[]
  /** 頂点の編集中に選んでいる辺 */
  selectedSegment: number | null
  /** ペンツールで描いている途中の頂点（ページ座標、制御点を含む）と、ポインタの位置 */
  pen: { points: Vertex[]; cursor: Point | null } | null
  /** リサイズと回転のハンドルを出す枠 */
  box: SelectionBox | null
  /** コンポーネントの一覧からドラッグしているインスタンスが入るフレーム */
  dropTarget: NodeId | null
}

/** 選択の枠・ハンドル・ガイド・範囲選択の枠などを描く */
export function drawEditorOverlay(ctx: CanvasRenderingContext2D, viewport: Viewport, overlay: OverlayState) {
  const { page, selection, hover, gesture, pointed, editedId, selectedVertices, selectedSegment, pen, box, dropTarget } = overlay
  // コンポーネントのもの（元・インスタンス・その中身）だけを選んでいれば、枠を紫にする
  const accent = overlayColor(page, selection)
  ctx.strokeStyle = accent
  ctx.lineWidth = 1

  /** ページ座標の点をつないだ線を引く */
  const polyline = (points: Point[], close: boolean) =>
    strokePolyline(ctx, points.map((point) => worldToScreen(viewport, point)), close)

  /** ページ座標の頂点の並びを、曲線のまま線でなぞる */
  const curve = (vertices: readonly Vertex[], close: boolean) => {
    ctx.beginPath()
    tracePath(ctx, mapVertices(vertices, (point) => worldToScreen(viewport, point)), close)
    ctx.stroke()
  }

  /** 制御点のハンドル。頂点から細い線を引き、先に丸を置く */
  const drawControl = (vertex: Point, control: Point) => {
    const from = worldToScreen(viewport, vertex)
    const to = worldToScreen(viewport, control)
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(to.x, to.y, HANDLE_SIZE / 2 - 0.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }

  const drawHandle = (p: Point) => {
    const x = Math.round(p.x - HANDLE_SIZE / 2) + 0.5
    const y = Math.round(p.y - HANDLE_SIZE / 2) + 0.5
    ctx.fillRect(x, y, HANDLE_SIZE, HANDLE_SIZE)
    ctx.strokeRect(x, y, HANDLE_SIZE, HANDLE_SIZE)
  }

  // 回っていればその向きのまま枠をなぞる。直線は枠ではなく線そのものをなぞる
  const outlineNode = (id: NodeId) => {
    const node = page.nodes[id]
    if (node.type === 'path' && isLine(node)) polyline(editablePoints(page, node), false)
    else polyline(getCorners(page, id), true)
  }

  // バリアントのまとまりは、紫の破線で囲んで見分ける（既存のデザインツールと同じ）
  ctx.save()
  ctx.strokeStyle = OVERLAY_COMPONENT
  ctx.setLineDash([4, 3])
  for (const node of Object.values(page.nodes)) {
    if (node.type === 'frame' && node.visible && isVariantSet(page, node.id)) outlineNode(node.id)
  }
  ctx.restore()

  // ドラッグしているインスタンスが入るフレーム
  if (dropTarget && page.nodes[dropTarget]) {
    ctx.save()
    ctx.lineWidth = 2
    ctx.strokeStyle = OVERLAY_ACCENT
    outlineNode(dropTarget)
    ctx.restore()
  }

  if (hover && !gesture && page.nodes[hover] && !selection.includes(hover)) {
    ctx.lineWidth = 2
    ctx.strokeStyle = overlayColor(page, [hover])
    outlineNode(hover)
    ctx.strokeStyle = accent
    ctx.lineWidth = 1
  }
  // 頂点を編集中のパスは、枠ではなく形そのものを後でなぞる
  for (const id of selection) if (id !== editedId) outlineNode(id)

  // 親の辺への固定の向き
  if (gesture?.kind !== 'marquee') drawConstraintMarks(ctx, viewport, page, selection)

  const current = pointed && page.nodes[pointed.id]
  if (current?.type === 'path') {
    const vertices = editablePoints(page, current)
    // 頂点を編集中のパスは、形そのもの（角の丸めを含む）をなぞって見せる
    if (!isLine(current)) curve(roundCorners(vertices, current.closed), current.closed)
    const editing = current.id === editedId
    // 選んでいる辺は太くなぞる
    const segment = editing && selectedSegment !== null ? pathSegments(vertices, current.closed)[selectedSegment] : undefined
    if (segment) {
      ctx.save()
      ctx.lineWidth = 3
      ctx.beginPath()
      const s = mapVertices([{ ...segment.from, out: segment.c1 }, { ...segment.to, in: segment.c2 }], (point) => worldToScreen(viewport, point))
      tracePath(ctx, s, false)
      ctx.stroke()
      ctx.restore()
    }
    ctx.fillStyle = '#ffffff'
    const selected = editing ? selectedVertices : []
    for (const control of visibleControls(vertices, selected, current.closed)) {
      drawControl(vertices[control.index], control.point)
    }
    vertices.forEach((vertex, index) => {
      // 選んでいる頂点は塗りつぶす
      ctx.fillStyle = selected.includes(index) ? accent : '#ffffff'
      drawHandle(worldToScreen(viewport, vertex))
    })
  }

  // ペンツールで描いている途中の線。最後の頂点からポインタまでも結ぶ。最後の頂点の制御点も見せる
  if (pen && pen.points.length > 0) {
    curve(pen.cursor ? [...pen.points, pen.cursor] : pen.points, false)
    ctx.fillStyle = '#ffffff'
    const last = pen.points[pen.points.length - 1]
    if (last.in) drawControl(last, last.in)
    if (last.out) drawControl(last, last.out)
    for (const point of pen.points) drawHandle(worldToScreen(viewport, point))
  }

  if (box && gesture?.kind !== 'move') {
    const { width: w, height: h } = box.size
    const corner = (x: number, y: number) => applyMatrix(box.matrix, { x, y })
    if (selection.length > 1) polyline([corner(0, 0), corner(w, 0), corner(w, h), corner(0, h)], true)

    // 回転ハンドル。上辺の中央から柄を伸ばした先に置く
    const knob = rotateHandlePoint(viewport, box)
    const stem = boxToScreen(viewport, box, { x: w / 2, y: 0 })
    ctx.beginPath()
    ctx.moveTo(stem.x, stem.y)
    ctx.lineTo(knob.x, knob.y)
    ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(knob.x, knob.y, HANDLE_SIZE / 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()

    for (const handle of visibleHandles(viewport, box)) {
      drawHandle(boxToScreen(viewport, box, handlePoint({ x: 0, y: 0, width: w, height: h }, handle)))
    }

    // 選択範囲の大きさを下に出す。回している最中は角度を出す
    const label =
      gesture?.kind === 'rotate'
        ? `${normalizeAngle(gesture.baseRotation + gesture.delta)}°`
        : `${Math.round(w)} × ${Math.round(h)}`
    const screen = toScreenBounds(viewport, box.bounds)
    const below = { x: screen.x + screen.width / 2, y: screen.y + screen.height + 17 }
    drawBadge(ctx, label, below, accent)
  }

  if (gesture?.kind === 'move' || gesture?.kind === 'resize') {
    ctx.strokeStyle = OVERLAY_GUIDE
    ctx.beginPath()
    for (const guide of gesture.guides) {
      const along = guide.axis === 'x' ? 'y' : 'x'
      const from = worldToScreen(viewport, { x: 0, y: 0, [guide.axis]: guide.position, [along]: guide.from })
      const to = worldToScreen(viewport, { x: 0, y: 0, [guide.axis]: guide.position, [along]: guide.to })
      ctx.moveTo(Math.round(from.x) + 0.5, Math.round(from.y) + 0.5)
      ctx.lineTo(Math.round(to.x) + 0.5, Math.round(to.y) + 0.5)
    }
    ctx.stroke()
    ctx.strokeStyle = accent
  }

  if (gesture?.kind === 'marquee' || (gesture?.kind === 'vertexMarquee' && gesture.dragged)) {
    const b = toScreenBounds(viewport, boundsFromPoints(gesture.world, gesture.current))
    ctx.fillStyle = 'rgba(13, 153, 255, 0.12)'
    ctx.fillRect(b.x, b.y, b.width, b.height)
    ctx.strokeStyle = OVERLAY_ACCENT
    ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.width, b.height)
  }
}
