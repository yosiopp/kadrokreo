import { isInstance } from '../document/component.ts'
import {
  type Bounds,
  type Point,
  getAbsoluteBounds,
  intersects,
  toNodeSpace,
} from '../document/geometry.ts'
import { MAX_DEPTH } from '../document/kdr.ts'
import type { NodeId, Scene } from '../document/types.ts'

// 編集でしか使わない当たり判定。ポインタの下のノードを探す処理は、viewer も使うので共通側（canvas/hitTest.ts）にある

/**
 * point を含む最も深いフレーム。ドラッグ中のノードの入れ先を決めるのに使う。
 * exclude のノードとその子孫は候補にしない。
 */
export function findFrameAt(
  scene: Scene,
  point: Point,
  exclude: ReadonlySet<NodeId> = new Set(),
): NodeId | null {
  function search(ids: readonly NodeId[], p: Point, depth: number): NodeId | null {
    for (let i = ids.length - 1; i >= 0; i--) {
      const node = scene.nodes[ids[i]]
      if (node.type !== 'frame' || !node.visible || node.locked || exclude.has(node.id)) continue
      // インスタンスの中へは入れられない。ブーリアン演算のノードにも、ドラッグでは入れない（元の図形が変わってしまう）
      if (isInstance(node) || node.booleanOperation !== null) continue
      const local = toNodeSpace(node, p)
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
  return search(scene.rootIds, point, 1)
}

/**
 * 範囲選択。範囲に完全に収まったフレームはフレームごと、
 * はみ出しているフレームは中身のうち範囲にかかるものを選ぶ。
 */
export function nodesInMarquee(scene: Scene, marquee: Bounds): NodeId[] {
  const result: NodeId[] = []
  function visit(ids: readonly NodeId[]) {
    for (const id of ids) {
      const node = scene.nodes[id]
      if (!node.visible || node.locked) continue
      const bounds = getAbsoluteBounds(scene, id)
      if (!intersects(bounds, marquee)) {
        if (node.type === 'frame' && !isInstance(node) && !node.clipContent && node.booleanOperation === null) visit(node.children)
        continue
      }
      // ブーリアン演算のノードは、インスタンスと同じく全体でひとつとして選ぶ
      if (node.type === 'frame' && !isInstance(node) && node.booleanOperation === null && !contains(marquee, bounds)) visit(node.children)
      else result.push(id)
    }
  }
  visit(scene.rootIds)
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
