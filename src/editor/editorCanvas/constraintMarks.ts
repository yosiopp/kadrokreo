import { OVERLAY_ACCENT } from '../../canvas/overlay.ts'
import { type Viewport, worldToScreen } from '../../canvas/viewport.ts'
import { followsConstraints } from '../../document/autoLayout.ts'
import { type Point, applyMatrix, getWorldMatrix, nodeMatrix, transformRect } from '../../document/geometry.ts'
import type { Constraint, NodeId, Scene } from '../../document/types.ts'

// 親の辺への固定（constraints）の向きを、キャンバスに印で見せる（既存のデザインツールの制約の線に当たる）。
// 選んだ子を囲む矩形（回した子は回したまま囲む矩形。追従もこの矩形で測る）から、固定した親の辺へ破線を引き、辺の側に短い横棒を付ける。
// 中央は親の中心線、拡大縮小は両側の辺へ点線を引く。

/** 印の線 1 本（ページ座標）。tick は to の側に辺と平行な短い横棒を付けるか、dotted は点線（拡大縮小）か */
export type ConstraintMark = { from: Point; to: Point; tick: boolean; dotted: boolean }

/**
 * id の固定の印。1 つだけ選んだ、親の辺に追従する子で、左・上（既定）のままでないときだけ出す
 * （既定のままの子にまで線を出すと、フレームの中を選ぶたびに印が出てうるさい）
 */
export function constraintMarks(page: Scene, selection: readonly NodeId[]): ConstraintMark[] {
  if (selection.length !== 1) return []
  const node = page.nodes[selection[0]]
  const parent = node?.parentId == null ? undefined : page.nodes[node.parentId]
  if (!node || !parent || !followsConstraints(parent, node)) return []
  const { horizontal, vertical } = node.constraints
  if (horizontal === 'start' && vertical === 'start') return []

  // 親の座標系で考え、最後にページ座標へ直す
  const box = transformRect(nodeMatrix(node), { x: 0, y: 0, width: node.width, height: node.height })
  const toPage = getWorldMatrix(page, parent.id)
  const marks: ConstraintMark[] = []
  const add = (from: Point, to: Point, tick: boolean, dotted: boolean) =>
    marks.push({ from: applyMatrix(toPage, from), to: applyMatrix(toPage, to), tick, dotted })

  const axis = (constraint: Constraint, horizontalAxis: boolean) => {
    const [start, size, whole] = horizontalAxis ? [box.x, box.width, parent.width] : [box.y, box.height, parent.height]
    // 直交する向きの、囲む矩形の中心（線を引く高さ）と広がり
    const middle = horizontalAxis ? box.y + box.height / 2 : box.x + box.width / 2
    const point = (along: number, across: number): Point => (horizontalAxis ? { x: along, y: across } : { x: across, y: along })
    const dotted = constraint === 'scale'
    if (constraint === 'start' || constraint === 'stretch' || constraint === 'scale') {
      add(point(start, middle), point(0, middle), true, dotted)
    }
    if (constraint === 'end' || constraint === 'stretch' || constraint === 'scale') {
      add(point(start + size, middle), point(whole, middle), true, dotted)
    }
    if (constraint === 'center') {
      // 親の中心線を、子の広がりより少し長く引く
      const [from, to] = horizontalAxis ? [box.y, box.y + box.height] : [box.x, box.x + box.width]
      const reach = 8
      add(point(whole / 2, Math.max(0, from - reach)), point(whole / 2, Math.min(horizontalAxis ? parent.height : parent.width, to + reach)), false, false)
    }
  }
  axis(horizontal, true)
  axis(vertical, false)
  return marks
}

/** 辺の側の横棒の長さ（画面ピクセル） */
const TICK = 8

const crisp = (point: Point): Point => ({ x: Math.round(point.x) + 0.5, y: Math.round(point.y) + 0.5 })

/** 固定の印を描く */
export function drawConstraintMarks(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  page: Scene,
  selection: readonly NodeId[],
): void {
  const marks = constraintMarks(page, selection)
  if (marks.length === 0) return
  ctx.save()
  ctx.strokeStyle = OVERLAY_ACCENT
  ctx.lineWidth = 1
  for (const mark of marks) {
    // 1px の線がぼやけないよう、画素の中央に合わせる
    const from = crisp(worldToScreen(viewport, mark.from))
    const to = crisp(worldToScreen(viewport, mark.to))
    ctx.setLineDash(mark.dotted ? [1, 3] : [4, 3])
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
    const length = Math.hypot(to.x - from.x, to.y - from.y)
    if (!mark.tick || length < 1) continue
    // 線に直交する短い横棒
    const nx = (-(to.y - from.y) / length) * (TICK / 2)
    const ny = ((to.x - from.x) / length) * (TICK / 2)
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.moveTo(to.x - nx, to.y - ny)
    ctx.lineTo(to.x + nx, to.y + ny)
    ctx.stroke()
  }
  ctx.restore()
}
