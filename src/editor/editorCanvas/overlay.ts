import {
  OVERLAY_ACCENT,
  OVERLAY_COMPONENT,
  OVERLAY_GUIDE,
  drawBadge,
  overlayColor,
  strokePolyline,
} from '../../canvas/overlay.ts'
import { type Viewport, worldToScreen } from '../../canvas/viewport.ts'
import { type Point, applyMatrix, boundsFromPoints, getCorners, normalizeAngle, rotateVector } from '../../document/geometry.ts'
import { labelEdge } from '../../canvas/labels.ts'
import type { Gradient, NodeId, PathNode, Scene } from '../../document/types.ts'
import { type Vertex, isLine, mapVertices, roundCorners, tracePath } from '../../document/path.ts'
import { contourSegment, flatVertices } from '../pathEdit.ts'
import { isVariantSet } from '../../document/variants.ts'
import { handlePoint } from '../resize.ts'
import { drawConstraintMarks } from './constraintMarks.ts'
import type { Gesture } from './drag.ts'
import type { GradientHandles } from './gradientHandles.ts'
import {
  HANDLE_SIZE,
  type SelectionBox,
  boxToScreen,
  editableContours,
  editablePoints,
  rotateHandlePoint,
  toScreenBounds,
  visibleContourControls,
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
  /** キャンバスで動かしているグラデーションのハンドル（画面座標。stops は色の印、onLine は線の上の色の位置）と、色の並び・選んでいる色 */
  gradient: { handles: GradientHandles & { onLine: Point[] }; type: Gradient['type']; colors: string[]; selected: number | null } | null
  /** ペンツールで描いている途中の頂点（ページ座標、制御点を含む）と、ポインタの位置 */
  pen: { points: Vertex[]; cursor: Point | null } | null
  /** リサイズと回転のハンドルを出す枠 */
  box: SelectionBox | null
  /** コンポーネントの一覧からドラッグしているインスタンスが入るフレーム */
  dropTarget: NodeId | null
}

/** 選択の枠・ハンドル・ガイド・範囲選択の枠などを描く */
export function drawEditorOverlay(ctx: CanvasRenderingContext2D, viewport: Viewport, overlay: OverlayState) {
  const { page, selection, hover, gesture, pointed, editedId, selectedVertices, selectedSegment, gradient, pen, box, dropTarget } = overlay
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
    // 頂点の番号は全部の輪郭をつないだ通し番号（pathEdit.ts）
    const contours = editableContours(page, current)
    const vertices = flatVertices(contours)
    // 頂点を編集中のパスは、形そのもの（角の丸めを含む）を輪郭ごとになぞって見せる
    if (!isLine(current)) for (const contour of contours) curve(roundCorners(contour.vertices, contour.closed), contour.closed)
    const editing = current.id === editedId
    // 選んでいる辺は太くなぞる
    const segment = editing && selectedSegment !== null ? contourSegment(contours, selectedSegment) : undefined
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
    for (const control of visibleContourControls(contours, selected)) {
      drawControl(vertices[control.index], control.point)
    }
    vertices.forEach((vertex, index) => {
      // 選んでいる頂点は塗りつぶす
      ctx.fillStyle = selected.includes(index) ? accent : '#ffffff'
      drawHandle(worldToScreen(viewport, vertex))
    })
  }

  if (gradient) drawGradientHandles(ctx, gradient, accent)

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
    // 回した枠では、画面で下にある辺に沿わせて傾ける（読める向きに近い辺を選ぶ）
    const edge = labelEdge(w, h, box.rotation, 'bottom')
    const middle = boxToScreen(viewport, box, { x: (edge.from.x + edge.to.x) / 2, y: (edge.from.y + edge.to.y) / 2 })
    const outward = rotateVector({ x: 0, y: 17 }, edge.angle)
    drawBadge(ctx, label, { x: middle.x + outward.x, y: middle.y + outward.y }, accent, edge.angle)
  }

  if (gesture?.kind === 'move' || gesture?.kind === 'resize' || gesture?.kind === 'reshape') {
    ctx.strokeStyle = OVERLAY_GUIDE
    ctx.beginPath()
    for (const guide of gesture.guides) {
      const along = guide.axis === 'x' ? 'y' : 'x'
      // 回した図形の向きに沿ったガイドは、その向きの座標からページ座標に戻す
      const toScreen = (value: number) =>
        worldToScreen(viewport, rotateVector({ x: 0, y: 0, [guide.axis]: guide.position, [along]: value }, guide.rotation ?? 0))
      const from = toScreen(guide.from)
      const to = toScreen(guide.to)
      // 縦横の線は画素に揃えてくっきり引く
      const snap = (value: number) => (guide.rotation ? value : Math.round(value) + 0.5)
      ctx.moveTo(snap(from.x), snap(from.y))
      ctx.lineTo(snap(to.x), snap(to.y))
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

/**
 * グラデーションのハンドル（画面座標で受け取る）。色が並ぶ線と、両端（直線の始点・終点、円形の中心と半径の先）の小さな丸、
 * 線の横に離して並べた色の印（その色で塗った丸。線の上の位置と細い線で結ぶ）を出す。円形は楕円も破線でなぞる。選んでいる色は太い縁で囲む
 */
function drawGradientHandles(ctx: CanvasRenderingContext2D, gradient: NonNullable<OverlayState['gradient']>, accent: string) {
  const { handles, type, colors, selected } = gradient
  const [from, to] = handles.axis
  ctx.save()
  // 背景が何色でも見えるよう、白い線の上に暗い細い線を重ねる
  const line = (points: Point[], dash: number[] = []) => {
    for (const [color, width] of [['#ffffff', 3], ['rgba(0, 0, 0, 0.6)', 1]] as const) {
      ctx.setLineDash(dash)
      ctx.strokeStyle = color
      ctx.lineWidth = width
      strokePolyline(ctx, points, false)
    }
  }
  line([from, to])
  if (type === 'radial' && handles.radiusY) {
    const center = from
    const ry = handles.radiusY
    line([center, ry])
    // 楕円は、中心から 2 つの半径の先への向きを軸にした形（回したノードでも合う）
    const ellipse = Array.from({ length: 65 }, (_, i) => {
      const t = (i / 64) * Math.PI * 2
      return {
        x: center.x + (to.x - center.x) * Math.cos(t) + (ry.x - center.x) * Math.sin(t),
        y: center.y + (to.y - center.y) * Math.cos(t) + (ry.y - center.y) * Math.sin(t),
      }
    })
    line(ellipse, [4, 3])
  }
  if (type === 'conic') {
    // 角度は中心のまわりを 1 周するので、向きの先を通る円を点線で出す
    const radius = Math.hypot(to.x - from.x, to.y - from.y)
    const circle = Array.from({ length: 65 }, (_, i) => {
      const t = (i / 64) * Math.PI * 2
      return { x: from.x + radius * Math.cos(t), y: from.y + radius * Math.sin(t) }
    })
    line(circle, [4, 3])
  }
  ctx.setLineDash([])
  // 色の印と、線の上の位置を結ぶ細い線
  handles.stops.forEach((marker, i) => line([handles.onLine[i], marker]))
  const knob = (point: Point, radius: number, fill: string, ring: string, ringWidth: number) => {
    ctx.beginPath()
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2)
    ctx.fillStyle = fill
    ctx.fill()
    ctx.lineWidth = ringWidth
    ctx.strokeStyle = ring
    ctx.stroke()
  }
  const ends = type === 'radial' && handles.radiusY ? [from, to, handles.radiusY] : [from, to]
  for (const end of ends) knob(end, 4, '#ffffff', 'rgba(0, 0, 0, 0.6)', 1)
  handles.stops.forEach((marker, i) => {
    // 外側に白い縁、内側にその色
    knob(marker, HANDLE_SIZE / 2 + 2, '#ffffff', i === selected ? accent : 'rgba(0, 0, 0, 0.6)', i === selected ? 2 : 1)
    knob(marker, HANDLE_SIZE / 2 - 1, colors[i], 'rgba(0, 0, 0, 0.2)', 1)
  })
  ctx.restore()
}
