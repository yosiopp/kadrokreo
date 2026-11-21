import { OVERLAY_ACCENT, OVERLAY_GUIDE, drawBadge, strokePolyline } from '../canvas/overlay.ts'
import { type Viewport, worldToScreen } from '../canvas/viewport.ts'
import { type Bounds, type Point, getAbsoluteBounds, getCorners, getNodesBounds, tidy } from '../document/geometry.ts'
import type { NodeId, Scene } from '../document/types.ts'
import { measureBetween } from './distances.ts'

/**
 * 選んでいるノードの枠と大きさ、間隔を、キャンバスに重ねて描く。座標は画面ピクセル。
 * 1 つ選んでいれば、ポインタを重ねたノードとの間隔を、2 つ選んでいれば、その 2 つの間隔を出す。
 */
export function drawInspectOverlay(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  scene: Scene,
  selection: readonly NodeId[],
  hoverId: NodeId | null,
): void {
  const toScreen = (point: Point) => worldToScreen(viewport, point)
  // 回っていれば、その向きのまま枠をなぞる
  const outline = (id: NodeId) => strokePolyline(ctx, getCorners(scene, id).map(toScreen), true)

  ctx.lineWidth = 1
  const selected = selection.filter((id) => Object.hasOwn(scene.nodes, id))
  const hovered =
    hoverId !== null && !selected.includes(hoverId) && Object.hasOwn(scene.nodes, hoverId) ? hoverId : null

  if (hovered) {
    // 1 つだけ選んでいれば、ポインタの下のものは「間隔を測る相手」として色を変える
    ctx.strokeStyle = selected.length === 1 ? OVERLAY_GUIDE : OVERLAY_ACCENT
    outline(hovered)
  }
  if (selected.length === 0) return

  ctx.strokeStyle = OVERLAY_ACCENT
  ctx.lineWidth = 2
  for (const id of selected) outline(id)
  ctx.lineWidth = 1

  const bounds = getNodesBounds(scene, selected)!
  const partner = selected.length === 1 ? hovered : selected.length === 2 ? selected[1] : null
  if (partner !== null) {
    drawDistances(ctx, toScreen, getAbsoluteBounds(scene, selected[0]), getAbsoluteBounds(scene, partner))
    return
  }

  // 大きさを下に出す。いくつも選んでいれば、全体を囲む矩形の大きさ
  const node = scene.nodes[selected[0]]
  const size =
    selected.length === 1
      ? `${tidy(node.width)} × ${tidy(node.height)}`
      : `${tidy(bounds.width)} × ${tidy(bounds.height)}`
  const bottom = toScreen({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height })
  drawBadge(ctx, size, { x: bottom.x, y: bottom.y + 17 }, OVERLAY_ACCENT)
}

function drawDistances(
  ctx: CanvasRenderingContext2D,
  toScreen: (point: Point) => Point,
  from: Bounds,
  to: Bounds,
): void {
  const distances = measureBetween(from, to)
  ctx.strokeStyle = OVERLAY_GUIDE
  for (const { from, to, guide } of distances) {
    strokePolyline(ctx, [toScreen(from), toScreen(to)], false)
    if (guide) {
      ctx.setLineDash([3, 3])
      strokePolyline(ctx, [toScreen(guide.from), toScreen(guide.to)], false)
      ctx.setLineDash([])
    }
  }
  // 数字は線より手前に出す
  for (const { from, to, distance } of distances) {
    const middle = toScreen({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 })
    drawBadge(ctx, String(distance), middle, OVERLAY_GUIDE)
  }
}
