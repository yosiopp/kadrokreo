import { FRAME_LABEL_HEIGHT } from '../canvas/render.ts'
import { type Viewport, worldToScreen } from '../canvas/viewport.ts'
import { type Bounds, type Point, getAbsoluteBounds, intersects } from '../document/geometry.ts'
import { MAX_DEPTH } from '../document/kdr.ts'
import type { DesignDocument, NodeId } from '../document/types.ts'

/**
 * point（ページ座標）の位置で最も手前にあるノード。非表示・ロック中のノードとその子は対象外。
 * tolerance は小さな図形をつかみやすくするための遊び（ページ座標）。
 */
export function hitTest(doc: DesignDocument, point: Point, tolerance = 0): NodeId | null {
  return hitSiblings(doc, doc.rootIds, point, tolerance)
}

function hitSiblings(
  doc: DesignDocument,
  ids: readonly NodeId[],
  point: Point,
  tolerance: number,
): NodeId | null {
  for (let i = ids.length - 1; i >= 0; i--) {
    const node = doc.nodes[ids[i]]
    if (!node.visible || node.locked) continue

    const local = { x: point.x - node.x, y: point.y - node.y }
    const inside =
      local.x >= -tolerance &&
      local.x <= node.width + tolerance &&
      local.y >= -tolerance &&
      local.y <= node.height + tolerance

    if (node.type === 'frame') {
      if (inside || !node.clipContent) {
        const child = hitSiblings(doc, node.children, local, tolerance)
        if (child) return child
      }
      if (inside) return node.id
    } else if (node.type === 'ellipse') {
      const rx = node.width / 2 + tolerance
      const ry = node.height / 2 + tolerance
      const dx = (local.x - node.width / 2) / rx
      const dy = (local.y - node.height / 2) / ry
      if (dx * dx + dy * dy <= 1) return node.id
    } else if (node.type === 'line') {
      // 細い線でもつかめるよう、太さによらず最低限の当たり幅を持たせる
      const reach = Math.max(node.strokeWidth / 2, tolerance)
      const down = node.direction === 'down'
      const from = { x: 0, y: down ? 0 : node.height }
      const to = { x: node.width, y: down ? node.height : 0 }
      if (distanceToSegment(local, from, to) <= reach) return node.id
    } else if (inside) {
      return node.id
    }
  }
  return null
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared))
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
}

/** ページ直下のフレームの名前ラベルに当たっていればそのフレーム。screen は画面座標 */
export function hitTestFrameLabel(
  doc: DesignDocument,
  viewport: Viewport,
  screen: Point,
  measureLabel: (text: string) => number,
): NodeId | null {
  for (let i = doc.rootIds.length - 1; i >= 0; i--) {
    const node = doc.nodes[doc.rootIds[i]]
    if (node.type !== 'frame' || !node.visible || node.locked) continue
    const origin = worldToScreen(viewport, node)
    if (
      screen.y >= origin.y - FRAME_LABEL_HEIGHT &&
      screen.y <= origin.y &&
      screen.x >= origin.x &&
      screen.x <= origin.x + measureLabel(node.name)
    ) {
      return node.id
    }
  }
  return null
}

/**
 * point を含む最も深いフレーム。ドラッグ中のノードの入れ先を決めるのに使う。
 * exclude のノードとその子孫は候補にしない。
 */
export function findFrameAt(
  doc: DesignDocument,
  point: Point,
  exclude: ReadonlySet<NodeId> = new Set(),
): NodeId | null {
  function search(ids: readonly NodeId[], p: Point, depth: number): NodeId | null {
    for (let i = ids.length - 1; i >= 0; i--) {
      const node = doc.nodes[ids[i]]
      if (node.type !== 'frame' || !node.visible || node.locked || exclude.has(node.id)) continue
      const local = { x: p.x - node.x, y: p.y - node.y }
      const inside =
        local.x >= 0 && local.x <= node.width && local.y >= 0 && local.y <= node.height
      // これより深い階層には入れられないフレームは候補にしない
      if (depth >= MAX_DEPTH) continue
      if (inside || !node.clipContent) {
        const child = search(node.children, local, depth + 1)
        if (child) return child
      }
      if (inside) return node.id
    }
    return null
  }
  return search(doc.rootIds, point, 1)
}

/**
 * 範囲選択。範囲に完全に収まったフレームはフレームごと、
 * はみ出しているフレームは中身のうち範囲にかかるものを選ぶ。
 */
export function nodesInMarquee(doc: DesignDocument, marquee: Bounds): NodeId[] {
  const result: NodeId[] = []
  function visit(ids: readonly NodeId[]) {
    for (const id of ids) {
      const node = doc.nodes[id]
      if (!node.visible || node.locked) continue
      const bounds = getAbsoluteBounds(doc, id)
      if (!intersects(bounds, marquee)) {
        if (node.type === 'frame' && !node.clipContent) visit(node.children)
        continue
      }
      if (node.type === 'frame' && !contains(marquee, bounds)) visit(node.children)
      else result.push(id)
    }
  }
  visit(doc.rootIds)
  return result
}

function contains(outer: Bounds, inner: Bounds): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}
