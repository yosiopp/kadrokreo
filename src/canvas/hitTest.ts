import { isInstance } from '../document/component.ts'
import { type Point, getAbsoluteBounds, toNodeSpace } from '../document/geometry.ts'
import { flattenPath, pathOutline } from '../document/path.ts'
import type { NodeId, Scene } from '../document/types.ts'
import { FRAME_LABEL_HEIGHT } from './render.ts'
import { type Viewport, worldToScreen } from './viewport.ts'

// ポインタの下にあるノードを探す。editor の選択と、viewer の選択の両方が使う。

export type HitOptions = {
  /** 小さな図形をつかみやすくするための遊び（ページ座標） */
  tolerance?: number
  /** インスタンスの中身も対象にする。指定しなければ、インスタンスは全体でひとつのものとして扱う */
  deep?: boolean
  /** ロック中のノードも対象にする。見るだけの viewer では、ロックに意味がない */
  locked?: boolean
}

/** point（ページ座標）の位置で最も手前にあるノード。非表示・ロック中のノードとその子は対象外 */
export function hitTest(scene: Scene, point: Point, options: HitOptions = {}): NodeId | null {
  const { tolerance = 0, deep = false, locked = false } = options
  return hitSiblings(scene, scene.rootIds, point, { tolerance, deep, locked })
}

function hitSiblings(
  scene: Scene,
  ids: readonly NodeId[],
  point: Point,
  options: Required<HitOptions>,
): NodeId | null {
  const { tolerance, deep } = options
  for (let i = ids.length - 1; i >= 0; i--) {
    const node = scene.nodes[ids[i]]
    if (!node.visible || (node.locked && !options.locked)) continue

    const local = toNodeSpace(node, point)
    const inside =
      local.x >= -tolerance &&
      local.x <= node.width + tolerance &&
      local.y >= -tolerance &&
      local.y <= node.height + tolerance

    if (node.type === 'frame') {
      const whole = isInstance(node) && !deep
      if (!whole && (inside || !node.clipContent)) {
        const child = hitSiblings(scene, node.children, local, options)
        if (child) return child
      }
      if (inside) return node.id
    } else if (node.type === 'ellipse') {
      const rx = node.width / 2 + tolerance
      const ry = node.height / 2 + tolerance
      const dx = (local.x - node.width / 2) / rx
      const dy = (local.y - node.height / 2) / ry
      if (dx * dx + dy * dy <= 1) return node.id
    } else if (node.type === 'path') {
      // 曲線は細かい折れ線に直して調べる
      const points = flattenPath(pathOutline(node), node.closed)
      // 塗ってある閉じた形は内側でも当たる。それ以外（直線を含む）は線の近くだけ。細い線でもつかめるよう、最低限の当たり幅を持たせる
      if (node.closed && node.fills.length > 0 && insidePolygon(local, points)) return node.id
      const reach = Math.max(node.strokeWidth / 2, tolerance)
      const last = node.closed ? points.length : points.length - 1
      for (let j = 0; j < last; j++) {
        if (distanceToSegment(local, points[j], points[(j + 1) % points.length]) <= reach) return node.id
      }
    } else if (inside) {
      return node.id
    }
  }
  return null
}

/** 点から右へ伸ばした半直線が辺を横切る回数が奇数なら内側 */
function insidePolygon(p: Point, points: readonly Point[]): boolean {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]
    const b = points[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
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
  scene: Scene,
  viewport: Viewport,
  screen: Point,
  measureLabel: (text: string) => number,
  options: Pick<HitOptions, 'locked'> = {},
): NodeId | null {
  for (let i = scene.rootIds.length - 1; i >= 0; i--) {
    const node = scene.nodes[scene.rootIds[i]]
    if (node.type !== 'frame' || !node.visible || (node.locked && !options.locked)) continue
    // ラベルは、フレームを囲む矩形の左上に出している
    const origin = worldToScreen(viewport, getAbsoluteBounds(scene, node.id))
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
