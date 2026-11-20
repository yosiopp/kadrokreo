import { type Viewport, worldToScreen } from '../canvas/viewport.ts'
import { type Point, getAbsoluteBounds, getCorners } from '../document/geometry.ts'
import type { NodeId, Scene } from '../document/types.ts'
import { measureBetween } from './distances.ts'

const ACCENT = '#0d99ff'
const MEASURE = '#f24822'

/**
 * 選んでいるノードの枠と大きさ、ポインタを重ねているノードとの間隔を、キャンバスに重ねて描く。
 * 座標は画面ピクセル。
 */
export function drawInspectOverlay(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  scene: Scene,
  selectedId: NodeId | null,
  hoverId: NodeId | null,
): void {
  const toScreen = (point: Point) => worldToScreen(viewport, point)
  const line = (points: Point[], close: boolean) => {
    ctx.beginPath()
    for (const [index, point] of points.entries()) {
      // 線がにじまないよう、ピクセルの中心に合わせる
      const x = Math.round(point.x) + 0.5
      const y = Math.round(point.y) + 0.5
      if (index === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    if (close) ctx.closePath()
    ctx.stroke()
  }
  // 回っていれば、その向きのまま枠をなぞる
  const outline = (id: NodeId) => line(getCorners(scene, id).map(toScreen), true)
  const label = (text: string, center: Point, color: string) => {
    ctx.font = '11px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const width = ctx.measureText(text).width + 10
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.roundRect(Math.round(center.x - width / 2), Math.round(center.y - 9), width, 18, 4)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.fillText(text, Math.round(center.x), Math.round(center.y) + 0.5)
  }

  ctx.lineWidth = 1
  const selected = selectedId !== null && Object.hasOwn(scene.nodes, selectedId) ? selectedId : null
  const hovered = hoverId !== null && hoverId !== selected && Object.hasOwn(scene.nodes, hoverId) ? hoverId : null

  if (hovered) {
    // 選んでいるものがあれば、ポインタの下のものは「間隔を測る相手」として色を変える
    ctx.strokeStyle = selected ? MEASURE : ACCENT
    outline(hovered)
  }
  if (!selected) return

  ctx.strokeStyle = ACCENT
  ctx.lineWidth = 2
  outline(selected)
  ctx.lineWidth = 1

  const bounds = getAbsoluteBounds(scene, selected)
  if (hovered) {
    const distances = measureBetween(bounds, getAbsoluteBounds(scene, hovered))
    ctx.strokeStyle = MEASURE
    for (const { from, to, guide } of distances) {
      line([toScreen(from), toScreen(to)], false)
      if (guide) {
        ctx.setLineDash([3, 3])
        line([toScreen(guide.from), toScreen(guide.to)], false)
        ctx.setLineDash([])
      }
    }
    // 数字は線より手前に出す
    for (const { from, to, distance } of distances) {
      const middle = toScreen({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 })
      label(String(distance), middle, MEASURE)
    }
    return
  }

  // 大きさを下に出す
  const node = scene.nodes[selected]
  const size = `${Math.round(node.width * 100) / 100} × ${Math.round(node.height * 100) / 100}`
  const bottom = toScreen({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height })
  label(size, { x: bottom.x, y: bottom.y + 17 }, ACCENT)
}
