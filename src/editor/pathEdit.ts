import { type Point, applyMatrix, nodeMatrix } from '../document/geometry.ts'
import {
  type Vertex,
  mapVertices,
  pathFromPoints,
  pathPoints,
  pathSegments,
  segmentAt,
  splitSegment,
} from '../document/path.ts'
import type { NodeId, Scene } from '../document/types.ts'
import { updateNode } from './operations/tree.ts'

// パスの頂点と制御点の編集。頂点は親の座標系の Vertex（制御点は位置）で扱い、
// reshapePath が形（枠と割合の頂点）を作り直す。回転は 0 に戻して頂点に織り込む（直線の端と同じ）。
// ポインタの位置は toLocal で親の座標に直してから渡す（親が回っていても合う）

/** パスの頂点と制御点（親の座標系。ノードの回転を織り込んだもの） */
export function parentVertices(scene: Scene, id: NodeId): Vertex[] {
  const node = scene.nodes[id]
  if (node?.type !== 'path') return []
  const matrix = nodeMatrix(node)
  return mapVertices(pathPoints(node), (point) => applyMatrix(matrix, point))
}

/**
 * パスの頂点を親の座標系で書き換える。edit が null を返したら何もしない（同じ参照を返す）。
 * closed を返せば、閉じているかも変えられる
 */
export function reshapePath<T extends Scene>(
  scene: T,
  id: NodeId,
  edit: (vertices: Vertex[], closed: boolean) => Vertex[] | { vertices: Vertex[]; closed: boolean } | null,
): T {
  const node = scene.nodes[id]
  if (node?.type !== 'path') return scene
  const result = edit(parentVertices(scene, id), node.closed)
  if (result === null) return scene
  const { vertices, closed } = Array.isArray(result) ? { vertices: result, closed: node.closed } : result
  return updateNode(scene, id, { ...pathFromPoints(vertices, closed), closed, rotation: 0 })
}

/** 頂点を to へ動かす。制御点も一緒に動く */
export function moveVertex(vertices: readonly Vertex[], index: number, to: Point): Vertex[] {
  const vertex = vertices[index]
  const dx = to.x - vertex.x
  const dy = to.y - vertex.y
  const [moved] = mapVertices([vertex], (point) => ({ x: point.x + dx, y: point.y + dy }))
  return vertices.with(index, moved)
}

/**
 * 頂点がなめらか（2 つの制御点が頂点をはさんで一直線）か。
 * なめらかな頂点は、片方の制御点を動かすと、もう片方も反対の向きへ回る（長さは保つ）
 */
export function isSmooth(vertex: Vertex): boolean {
  if (!vertex.in || !vertex.out) return false
  const a = { x: vertex.in.x - vertex.x, y: vertex.in.y - vertex.y }
  const b = { x: vertex.out.x - vertex.x, y: vertex.out.y - vertex.y }
  const la = Math.hypot(a.x, a.y)
  const lb = Math.hypot(b.x, b.y)
  if (la === 0 || lb === 0) return false
  // 向きが 180° から 1° 以内
  return (a.x * b.x + a.y * b.y) / (la * lb) < -Math.cos(Math.PI / 180)
}

/**
 * 制御点（side）を to へ動かす。mirror なら反対側の制御点を一直線に保つ（長さはそのまま）。
 * 頂点に重ねると、その制御点はなくなる（その側は角に戻る）
 */
export function moveControl(
  vertices: readonly Vertex[],
  index: number,
  side: 'in' | 'out',
  to: Point,
  mirror: boolean,
): Vertex[] {
  const vertex = vertices[index]
  const next: Vertex = { ...vertex }
  const other = side === 'in' ? 'out' : 'in'
  if (to.x === vertex.x && to.y === vertex.y) {
    delete next[side]
    return vertices.with(index, next)
  }
  next[side] = to
  const opposite = vertex[other]
  if (mirror && opposite) {
    const length = Math.hypot(opposite.x - vertex.x, opposite.y - vertex.y)
    const dx = to.x - vertex.x
    const dy = to.y - vertex.y
    const d = Math.hypot(dx, dy)
    next[other] = { x: vertex.x - (dx / d) * length, y: vertex.y - (dy / d) * length }
  }
  return vertices.with(index, next)
}

/**
 * 頂点の種類を切り替える。制御点があれば消して角に、なければ隣の頂点を結ぶ向きの制御点を付けてなめらかにする。
 * 制御点の長さは、それぞれの側の隣の頂点までの 1/3
 */
export function toggleSmooth(vertices: readonly Vertex[], index: number, closed: boolean): Vertex[] {
  const vertex = vertices[index]
  if (vertex.in || vertex.out) return vertices.with(index, { x: vertex.x, y: vertex.y })
  const count = vertices.length
  const prev = index > 0 ? vertices[index - 1] : closed ? vertices[count - 1] : null
  const next = index < count - 1 ? vertices[index + 1] : closed ? vertices[0] : null
  const from = prev ?? vertex
  const to = next ?? vertex
  const dx = to.x - from.x
  const dy = to.y - from.y
  const d = Math.hypot(dx, dy)
  if (d === 0) return [...vertices]
  const ux = dx / d
  const uy = dy / d
  const smooth: Vertex = { x: vertex.x, y: vertex.y }
  if (prev) {
    const length = Math.hypot(prev.x - vertex.x, prev.y - vertex.y) / 3
    smooth.in = { x: vertex.x - ux * length, y: vertex.y - uy * length }
  }
  if (next) {
    const length = Math.hypot(next.x - vertex.x, next.y - vertex.y) / 3
    smooth.out = { x: vertex.x + ux * length, y: vertex.y + uy * length }
  }
  return vertices.with(index, smooth)
}

/** 辺 segment（index の頂点から次の頂点への辺）の t の位置に頂点を足す。形は変わらない */
export function insertVertex(vertices: readonly Vertex[], closed: boolean, segment: number, t: number): Vertex[] {
  const piece = pathSegments(vertices, closed)[segment]
  if (!piece) return [...vertices]
  const [left, right] = splitSegment(piece, t)
  const nextIndex = (segment + 1) % vertices.length
  const result = [...vertices]
  const inserted: Vertex = { x: left.to.x, y: left.to.y }
  if (piece.curved) {
    // 頂点と重なる制御点は持たない（角のまま）
    const withControl = (vertex: Vertex, side: 'in' | 'out', point: Point): Vertex => {
      const { [side]: _, ...rest } = vertex
      return point.x === vertex.x && point.y === vertex.y ? rest : { ...rest, [side]: point }
    }
    result[segment] = withControl(vertices[segment], 'out', left.c1)
    Object.assign(inserted, withControl(inserted, 'in', left.c2), withControl(inserted, 'out', right.c1))
    result[nextIndex] = withControl(vertices[nextIndex], 'in', right.c2)
  }
  result.splice(segment + 1, 0, inserted)
  return result
}

/**
 * index の頂点を消す。開いたパスは 2 つ、閉じた形は 3 つより減らせない（null を返す）。
 * 両隣を結ぶ辺は、両隣の外側の制御点をそのまま使う
 */
export function deleteVertex(vertices: readonly Vertex[], closed: boolean, index: number): Vertex[] | null {
  if (vertices.length <= (closed ? 3 : 2)) return null
  return vertices.toSpliced(index, 1)
}

/** point にいちばん近い辺と、その上の位置 t、距離。曲線は細かく区切って探してから詰める */
export function nearestOnPath(
  vertices: readonly Vertex[],
  closed: boolean,
  point: Point,
): { segment: number; t: number; distance: number } | null {
  let best: { segment: number; t: number; distance: number } | null = null
  pathSegments(vertices, closed).forEach((piece, segment) => {
    const at = (t: number) => {
      const p = segmentAt(piece, t)
      return Math.hypot(p.x - point.x, p.y - point.y)
    }
    const steps = 32
    let t = 0
    for (let k = 1; k <= steps; k++) if (at(k / steps) < at(t)) t = k / steps
    // 前後の区切りの間で詰める
    let step = 1 / steps
    for (let k = 0; k < 20; k++) {
      step /= 2
      if (t - step >= 0 && at(t - step) < at(t)) t -= step
      else if (t + step <= 1 && at(t + step) < at(t)) t += step
    }
    const distance = at(t)
    if (!best || distance < best.distance) best = { segment, t, distance }
  })
  return best
}
