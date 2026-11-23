import { type Matrix, type Point, applyMatrix, multiply, nodeMatrix } from './geometry.ts'
import { clampedRadii } from './paint.ts'
import { type Contour, type Vertex, flattenPath, mapVertices, pathOutlines, roundCorners } from './path.ts'
import type { CornerRadius, EllipseNode, NodeId, PathNode, RectNode, Scene, SceneNode } from './types.ts'

// マスク（既存のデザインツールの「マスクとして使う」。types.ts の Maskable）を読む関数。描画・当たり判定・SVG の書き出し・Dev モードの CSS が共有する。
// マスクは同じ親の中で、自分より手前（並びの後ろ）の兄弟を、次のマスクが現れるまで自分の形で切り取る。マスク自身は描かない。

/** マスクにできるノード */
export type MaskNode = RectNode | EllipseNode | PathNode

/** マスクにできる種類か（矩形・楕円・パス） */
export function canMask(node: SceneNode): node is MaskNode {
  return node.type === 'rect' || node.type === 'ellipse' || node.type === 'path'
}

/** マスクとして使っているノードか（隠していても true。描かず、範囲の区切りになる） */
export function isMaskNode(node: SceneNode): node is MaskNode {
  return canMask(node) && node.isMask
}

/**
 * 兄弟の並び（先頭が最背面）の、それぞれにかかるマスクの id。かからなければ null。
 * マスク自身と、隠したマスクの範囲のノードは null
 */
export function masksOf(scene: Scene, ids: readonly NodeId[]): (NodeId | null)[] {
  let current: NodeId | null = null
  return ids.map((id) => {
    const node = scene.nodes[id]
    if (isMaskNode(node)) {
      current = node.visible ? id : null
      return null
    }
    return current
  })
}

/** 兄弟の並びにマスクがあるか（ないときの近道） */
export function hasMask(scene: Scene, ids: readonly NodeId[]): boolean {
  return ids.some((id) => isMaskNode(scene.nodes[id]))
}

/** 円を 4 つの 3 次ベジェ曲線で近似するときの制御点の長さ */
export const KAPPA = 0.5522847498

/** 楕円の輪郭（4 つの 3 次ベジェ曲線） */
export function ellipseVertices(cx: number, cy: number, rx: number, ry: number): Vertex[] {
  const kx = rx * KAPPA
  const ky = ry * KAPPA
  return [
    { x: cx + rx, y: cy, in: { x: cx + rx, y: cy - ky }, out: { x: cx + rx, y: cy + ky } },
    { x: cx, y: cy + ry, in: { x: cx + kx, y: cy + ry }, out: { x: cx - kx, y: cy + ry } },
    { x: cx - rx, y: cy, in: { x: cx - rx, y: cy + ky }, out: { x: cx - rx, y: cy - ky } },
    { x: cx, y: cy - ry, in: { x: cx - kx, y: cy - ry }, out: { x: cx + kx, y: cy - ry } },
  ]
}

/**
 * 図形の形の輪郭（ノードの座標系。角丸・角の丸めは曲線に直したもの）。マスクの形で、パスの開いた輪郭も閉じた形として扱う。
 * 矩形の角丸は描画と同じく枠の短い辺の半分まで
 */
export function shapeContours(node: MaskNode): Contour[] {
  const { width, height } = node
  if (node.type === 'ellipse') return [{ vertices: ellipseVertices(width / 2, height / 2, width / 2, height / 2), closed: true }]
  if (node.type === 'rect') return [roundedRectContour(width, height, node.cornerRadius)]
  return pathOutlines(node).map((contour) => ({ vertices: contour.vertices, closed: true }))
}

/** 角丸の矩形の輪郭（左上が原点。角丸は枠の短い辺の半分まで） */
export function roundedRectContour(width: number, height: number, radius: CornerRadius): Contour {
  const [tl, tr, br, bl] = clampedRadii(radius, width, height)
  const corners: Vertex[] = [
    { x: 0, y: 0, radius: tl },
    { x: width, y: 0, radius: tr },
    { x: width, y: height, radius: br },
    { x: 0, y: height, radius: bl },
  ]
  return { vertices: roundCorners(corners, true), closed: true }
}

/** マスクの形の塗る範囲の決め方 */
export function maskFillRule(node: MaskNode): 'nonzero' | 'evenodd' {
  return node.type === 'path' ? node.fillRule : 'nonzero'
}

/** マスクの形の輪郭を、親の座標系に直したもの（m は追加でかける変換。省くと親の座標系） */
export function maskContours(node: MaskNode, m?: Matrix): Contour[] {
  const local = m ? multiply(m, nodeMatrix(node)) : nodeMatrix(node)
  return shapeContours(node).map((contour) => ({ vertices: mapVertices(contour.vertices, (p) => applyMatrix(local, p)), closed: true }))
}

/** 点（親の座標系）がマスクの形の内側か */
export function insideMask(node: MaskNode, point: Point): boolean {
  const contours = maskContours(node).map((contour) => flattenPath(contour.vertices, true))
  return insidePolygons(point, contours, maskFillRule(node))
}

/**
 * 点がいくつもの多角形で塗られる範囲の内側か。点から右へ伸ばした半直線が辺を横切る回数を数え、
 * evenodd なら奇数、nonzero なら向きを足した巻き数が 0 でなければ内側
 */
export function insidePolygons(p: Point, contours: readonly (readonly Point[])[], rule: 'nonzero' | 'evenodd'): boolean {
  let crossings = 0
  let winding = 0
  for (const points of contours) {
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[j]
      const b = points[i]
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
        crossings++
        winding += b.y > a.y ? 1 : -1
      }
    }
  }
  return rule === 'evenodd' ? crossings % 2 === 1 : winding !== 0
}

/** ノードの表ごと・兄弟の並びごとの masksOf の結果。どちらも不変なので、同じものなら同じ結果になる */
const masksCache = new WeakMap<Scene['nodes'], WeakMap<readonly NodeId[], Map<NodeId, NodeId>>>()

/**
 * 1 つのノードにかかるマスクの id（同じ親の兄弟の並びから決める）。かからなければ null。
 * 子が多い親の子を 1 つずつ調べても 2 乗にならないよう、並びごとの結果を覚えておく
 */
export function maskOf(scene: Scene, id: NodeId): NodeId | null {
  const parentId = scene.nodes[id].parentId
  const parent = parentId === null ? null : scene.nodes[parentId]
  const siblings = parent?.type === 'frame' ? parent.children : scene.rootIds
  let byList = masksCache.get(scene.nodes)
  if (!byList) masksCache.set(scene.nodes, (byList = new WeakMap()))
  let masks = byList.get(siblings)
  if (!masks) {
    // かかるマスクのあるノードだけを覚える（マスクがなければ空）
    masks = new Map()
    if (hasMask(scene, siblings)) {
      const list = masksOf(scene, siblings)
      siblings.forEach((sibling, i) => list[i] !== null && masks!.set(sibling, list[i]!))
    }
    byList.set(siblings, masks)
  }
  return masks.get(id) ?? null
}
