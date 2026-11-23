import { type Point, applyMatrix, nodeMatrix } from '../document/geometry.ts'
import {
  type Contour,
  type Vertex,
  mapVertices,
  pathContours,
  pathFromContours,
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

/** パスのすべての輪郭の頂点と制御点（親の座標系。ノードの回転を織り込んだもの）。先頭が最初の輪郭 */
export function parentContours(scene: Scene, id: NodeId): Contour[] {
  const node = scene.nodes[id]
  if (node?.type !== 'path') return []
  const matrix = nodeMatrix(node)
  return pathContours(node).map((contour) => ({
    vertices: mapVertices(contour.vertices, (point) => applyMatrix(matrix, point)),
    closed: contour.closed,
  }))
}

/**
 * パスのすべての輪郭を親の座標系で書き換える。edit が null を返すか、輪郭が 1 つも残らなければ何もしない（同じ参照を返す）。
 * 枠は全部の輪郭に合わせ直し、回転は 0 に戻して頂点に織り込む
 */
export function reshapeContours<T extends Scene>(scene: T, id: NodeId, edit: (contours: Contour[]) => Contour[] | null): T {
  const node = scene.nodes[id]
  if (node?.type !== 'path') return scene
  const result = edit(parentContours(scene, id))
  if (result === null || result.length === 0) return scene
  return updateNode(scene, id, { ...pathFromContours(result), rotation: 0 })
}

/**
 * パスの最初の輪郭の頂点を親の座標系で書き換える。edit が null を返したら何もしない（同じ参照を返す）。
 * closed を返せば、閉じているかも変えられる。2 つ目以降の輪郭（穴など）はそのまま保つ。
 * 全部の輪郭を通し番号で扱うときは reshapeContours と、下の「輪郭をまたぐ編集」の関数を使う
 */
export function reshapePath<T extends Scene>(
  scene: T,
  id: NodeId,
  edit: (vertices: Vertex[], closed: boolean) => Vertex[] | { vertices: Vertex[]; closed: boolean } | null,
): T {
  return reshapeContours(scene, id, ([first, ...others]) => {
    const result = edit(first.vertices, first.closed)
    if (result === null) return null
    const changed = Array.isArray(result) ? { vertices: result, closed: first.closed } : result
    return [changed, ...others]
  })
}

/** 枠を、いまの頂点が描く形（角の丸めを含む）に合わせ直す。頂点の位置は変わらない（回転は頂点に織り込む） */
export function refitPath<T extends Scene>(scene: T, id: NodeId): T {
  return reshapePath(scene, id, (vertices) => vertices)
}

/** 頂点を to へ動かす。制御点も一緒に動く */
export function moveVertex(vertices: readonly Vertex[], index: number, to: Point): Vertex[] {
  const vertex = vertices[index]
  const dx = to.x - vertex.x
  const dy = to.y - vertex.y
  const [moved] = mapVertices([vertex], (point) => ({ x: point.x + dx, y: point.y + dy }))
  return vertices.with(index, moved)
}

/** indices の頂点を（制御点ごと）dx, dy だけ動かす */
export function moveVertices(vertices: readonly Vertex[], indices: readonly number[], dx: number, dy: number): Vertex[] {
  const moving = new Set(indices)
  return vertices.map((vertex, i) =>
    moving.has(i) ? mapVertices([vertex], (point) => ({ x: point.x + dx, y: point.y + dy }))[0] : vertex,
  )
}

/** 頂点の種類。角は制御点なし、なめらかは 2 つの制御点が一直線、曲線は制御点があるが一直線でない（折れた曲線） */
export type VertexKind = 'corner' | 'smooth' | 'curve'

export function vertexKind(vertex: Vertex): VertexKind {
  if (!vertex.in && !vertex.out) return 'corner'
  return isSmooth(vertex) ? 'smooth' : 'curve'
}

/**
 * indices の頂点を角かなめらかにする。角にするなら制御点を消し、なめらかにするなら、
 * 角の頂点は隣を結ぶ向きの制御点を付け（toggleSmooth と同じ）、折れた曲線は out の向きに in を揃える（長さは保つ）
 */
export function setVertexKind(
  vertices: readonly Vertex[],
  indices: readonly number[],
  closed: boolean,
  kind: 'corner' | 'smooth',
): Vertex[] {
  let result = [...vertices]
  for (const index of indices) {
    const vertex = result[index]
    if (!vertex) continue
    const current = vertexKind(vertex)
    if (current === kind) continue
    if (kind === 'corner') {
      result = result.with(index, vertex.radius ? { x: vertex.x, y: vertex.y, radius: vertex.radius } : { x: vertex.x, y: vertex.y })
    } else if (current === 'corner') {
      const smooth = toggleSmooth(result, index, closed)[index]
      result = result.with(index, smooth)
    } else {
      // 折れた曲線（片側だけの制御点を含む）。ある側の制御点の向きに、反対側を揃える
      const reference = vertex.out ?? vertex.in!
      const side = vertex.out ? 'out' : 'in'
      const other = side === 'out' ? 'in' : 'out'
      const count = result.length
      const neighbor = other === 'in' ? (index > 0 ? result[index - 1] : closed ? result[count - 1] : null) : (index < count - 1 ? result[index + 1] : closed ? result[0] : null)
      const length = vertex[other]
        ? Math.hypot(vertex[other]!.x - vertex.x, vertex[other]!.y - vertex.y)
        : neighbor
          ? Math.hypot(neighbor.x - vertex.x, neighbor.y - vertex.y) / 3
          : 0
      const dx = reference.x - vertex.x
      const dy = reference.y - vertex.y
      const d = Math.hypot(dx, dy)
      if (d === 0 || length === 0) continue
      result = result.with(index, { ...vertex, [other]: { x: vertex.x - (dx / d) * length, y: vertex.y - (dy / d) * length } })
    }
  }
  return result
}

/** indices の頂点の角の丸めを radius（px）にする。0 なら丸めを外す */
export function setVertexRadius(vertices: readonly Vertex[], indices: readonly number[], radius: number): Vertex[] {
  const targets = new Set(indices)
  return vertices.map((vertex, i) => {
    if (!targets.has(i)) return vertex
    const { radius: _, ...rest } = vertex
    return radius > 0 ? { ...rest, radius } : rest
  })
}

/**
 * 閉じた形を、辺 segment（index の頂点から次の頂点への辺）を消して開く。消した辺の次の頂点が始点、辺の手前の頂点が終点になる。
 * 消した辺の制御点も消す。開いたパスなら null
 */
export function openAtSegment(
  vertices: readonly Vertex[],
  closed: boolean,
  segment: number,
): { vertices: Vertex[]; closed: false } | null {
  if (!closed || segment < 0 || segment >= vertices.length) return null
  const start = (segment + 1) % vertices.length
  const rotated = [...vertices.slice(start), ...vertices.slice(0, start)]
  const { in: _in, ...first } = rotated[0]
  const { out: _out, ...last } = rotated[rotated.length - 1]
  // 端になった頂点は丸めない（丸めは両側に辺があるときだけ効く）。持ったままでも描画は同じだが、残すと紛らわしい
  delete first.radius
  delete last.radius
  return { vertices: [first, ...rotated.slice(1, -1), last], closed: false }
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
  return deleteVertices(vertices, closed, [index])
}

/** indices の頂点をまとめて消す。残りが開いたパスで 2 つ、閉じた形で 3 つより少なくなるなら null */
export function deleteVertices(vertices: readonly Vertex[], closed: boolean, indices: readonly number[]): Vertex[] | null {
  const removing = new Set(indices.filter((index) => index >= 0 && index < vertices.length))
  if (removing.size === 0 || vertices.length - removing.size < (closed ? 3 : 2)) return null
  return vertices.filter((_, i) => !removing.has(i))
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

// 輪郭をまたぐ編集。頂点は全部の輪郭をつないだ通し番号（最初の輪郭の頂点が 0 から、次の輪郭がその続き）で扱う。
// 辺も、その辺が始まる頂点の通し番号で呼ぶ（開いた輪郭の最後の頂点から始まる辺はない）。
// ストアの頂点の選択（vertexEdit）やパネルは、この通し番号を持つ

/** 全部の輪郭の頂点を、通し番号の順に並べる */
export function flatVertices(contours: readonly Contour[]): Vertex[] {
  return contours.flatMap((contour) => contour.vertices)
}

/** 通し番号 index の頂点が、何番目の輪郭の何番目の頂点か。範囲の外なら null */
export function locateVertex(contours: readonly Contour[], index: number): { contour: number; local: number } | null {
  if (index < 0) return null
  let start = 0
  for (const [contour, { vertices }] of contours.entries()) {
    if (index < start + vertices.length) return { contour, local: index - start }
    start += vertices.length
  }
  return null
}

/** 何番目の輪郭の最初の頂点の通し番号 */
function contourStart(contours: readonly Contour[], contour: number): number {
  return contours.slice(0, contour).reduce((sum, { vertices }) => sum + vertices.length, 0)
}

/** 通し番号で並べた頂点（数は変えない）を、輪郭ごとに切り分けて戻す。頂点を動かすなど、隣を見ない編集に使う */
export function withFlatVertices(contours: readonly Contour[], vertices: readonly Vertex[]): Contour[] {
  let start = 0
  return contours.map((contour) => {
    const part = vertices.slice(start, start + contour.vertices.length)
    start += contour.vertices.length
    return { vertices: part, closed: contour.closed }
  })
}

/**
 * 通し番号の indices を輪郭ごとに分け、その輪郭の頂点・閉じているか・輪郭の中の番号で edit を呼ぶ。
 * indices を含まない輪郭はそのまま。edit が 1 つでも null を返したら全体を null にする
 */
export function editByContour(
  contours: readonly Contour[],
  indices: readonly number[],
  edit: (vertices: Vertex[], closed: boolean, local: number[]) => Vertex[] | Contour | null,
): Contour[] | null {
  const groups = new Map<number, number[]>()
  for (const index of indices) {
    const at = locateVertex(contours, index)
    if (at) groups.set(at.contour, [...(groups.get(at.contour) ?? []), at.local])
  }
  const result: Contour[] = []
  for (const [i, contour] of contours.entries()) {
    const local = groups.get(i)
    if (!local) {
      result.push(contour)
      continue
    }
    const changed = edit(contour.vertices, contour.closed, local)
    if (changed === null) return null
    result.push(Array.isArray(changed) ? { vertices: changed, closed: contour.closed } : changed)
  }
  return result
}

/**
 * 通し番号の indices の頂点をまとめて消す。輪郭が 2 つ以上あるとき、輪郭の頂点を全部選んでいれば、その輪郭ごと消す。
 * 残りが開いた輪郭で 2 つ、閉じた輪郭で 3 つより少なくなる輪郭があれば null（何も消さない）
 */
export function deleteContourVertices(contours: readonly Contour[], indices: readonly number[]): Contour[] | null {
  const removing = new Set(indices)
  const whole = contours.map((contour, i) => {
    const start = contourStart(contours, i)
    return contour.vertices.every((_, local) => removing.has(start + local))
  })
  // 全部の輪郭を丸ごと選んでいても、パスそのものは消さない（ノードを消すのは頂点の編集の外で）
  if (whole.every(Boolean)) return null
  const kept = contours.filter((_, i) => !whole[i])
  const rest = indices.filter((index) => {
    const at = locateVertex(contours, index)
    return at !== null && !whole[at.contour]
  })
  // 番号は消す前の並びで数えたもの。丸ごと消した輪郭を除いた並びに数え直す
  const renumbered = rest.map((index) => {
    const at = locateVertex(contours, index)!
    const contour = contours.slice(0, at.contour).filter((_, i) => !whole[i]).length
    return contourStart(kept, contour) + at.local
  })
  if (renumbered.length === 0) return kept
  return editByContour(kept, renumbered, (vertices, closed, local) => deleteVertices(vertices, closed, local))
}

/** 全部の輪郭のうち point にいちばん近い辺（通し番号）と、その上の位置 t、距離 */
export function nearestOnContours(
  contours: readonly Contour[],
  point: Point,
): { segment: number; t: number; distance: number } | null {
  let best: { segment: number; t: number; distance: number } | null = null
  for (const [i, contour] of contours.entries()) {
    const nearest = nearestOnPath(contour.vertices, contour.closed, point)
    if (nearest && (!best || nearest.distance < best.distance)) {
      best = { ...nearest, segment: contourStart(contours, i) + nearest.segment }
    }
  }
  return best
}

/** 通し番号 segment の辺（その頂点から、同じ輪郭の次の頂点への辺）。ない辺なら undefined */
export function contourSegment(contours: readonly Contour[], segment: number) {
  const at = locateVertex(contours, segment)
  if (!at) return undefined
  const contour = contours[at.contour]
  return pathSegments(contour.vertices, contour.closed)[at.local]
}

/** 通し番号 index の頂点の、同じ輪郭の中の手前の頂点（なければ次の頂点）。Shift で向きを揃える基準に使う */
export function neighborVertex(contours: readonly Contour[], index: number): Vertex | undefined {
  const at = locateVertex(contours, index)
  if (!at) return undefined
  const { vertices } = contours[at.contour]
  return vertices[at.local === 0 ? 1 : at.local - 1]
}
