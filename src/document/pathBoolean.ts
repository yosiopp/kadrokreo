import type { Point } from './geometry.ts'
import { type Contour, type Segment, type Vertex, pathSegments, segmentAt, splitSegment } from './path.ts'

// パスのブーリアン演算（合体・差し引き・交差・除外）。依存を足さずに自前で書いている（決めた理由は decisions.md「パスのブーリアン演算」）。
//
// 流れ:
// 1. 形ごとの輪郭の辺を、曲線は細かい折れ線に直す（FLATTEN_TOLERANCE 以内のずれ）。折れ線の辺は、どの辺のどの t の範囲から来たかを覚える。
// 2. 全部の辺どうしの交点（触れる・重なるも含む）で辺を分け、近い点（SNAP 以内）は 1 つの頂点にまとめる。重なった辺も 1 本にまとめる。
// 3. 分けた辺ごとに、その両側がそれぞれの形の内側か（巻き数・偶奇）を、辺の中点から伸ばした半直線で数えて決める。
//    演算の結果が両側で違う辺だけが、結果の輪郭になる（結果の内側を左手に見る向きにそろえる）。
// 4. 輪郭の辺をつないで輪にし、同じ元の曲線から続けて来た辺は、元の曲線をその t の範囲で切り出した曲線に戻す。
//    結果は折れ線ではなく、元の曲線を交点で切った曲線になる（交点の位置だけが折れ線で求めた近似）。

export type BooleanOp = 'union' | 'subtract' | 'intersect' | 'exclude'

/** 演算に渡す形。輪郭はすべて閉じた形として扱う（開いた輪郭も最後と最初をつなぐ） */
export type BooleanShape = { contours: readonly Contour[]; fillRule: 'nonzero' | 'evenodd' }

/** 曲線を折れ線に直すときの、曲線からのずれの上限（px）。交点の位置の誤差もこの程度になる */
export const FLATTEN_TOLERANCE = 0.01
/** 1 本の曲線を分ける数の上限 */
const MAX_STEPS = 256
/** これより近い点は同じ頂点とみなす（px） */
const SNAP = 1e-6

/** 元の辺（曲線か直線）と、それを持つ形 */
type Source = { segment: Segment; shape: number }

/** 折れ線に直した辺。src の辺の t0〜t1 の範囲を直線で近似したもの */
type FlatEdge = { a: Point; b: Point; shape: number; src: number; t0: number; t1: number }

/** 分けて重なりをまとめた辺。wind / count は形ごとの、この辺の向き（a → b を +1）の和と本数 */
type Edge = { a: number; b: number; wind: number[]; count: number[]; src: number; ta: number; tb: number }

/** 結果の辺（結果の内側を左手に見る向き） */
type OutEdge = { from: number; to: number; src: number; tFrom: number; tTo: number }

/**
 * 形の並び（先頭が最背面）にブーリアン演算をかけた結果の輪郭（閉じた形、塗る範囲は evenodd で読む）。何も残らなければ空。
 * 合体 = どれかの内側、差し引き = 最背面の形から残りを引く、交差 = 全部の内側、除外 = 奇数個の内側（重なりが偶数の所を抜く）
 */
export function booleanContours(shapes: readonly BooleanShape[], op: BooleanOp): Contour[] {
  if (shapes.length === 0) return []
  const sources: Source[] = []
  const flat: FlatEdge[] = []
  shapes.forEach((shape, index) => {
    for (const contour of shape.contours) {
      if (contour.vertices.length === 0) continue
      for (const segment of pathSegments(contour.vertices, true)) {
        const src = sources.push({ segment, shape: index }) - 1
        const ts = flattenParams(segment)
        for (let k = 0; k < ts.length - 1; k++) {
          const a = k === 0 ? segment.from : segmentAt(segment, ts[k])
          const b = k === ts.length - 2 ? segment.to : segmentAt(segment, ts[k + 1])
          if (a.x === b.x && a.y === b.y) continue
          flat.push({ a, b, shape: index, src, t0: ts[k], t1: ts[k + 1] })
        }
      }
    }
  })
  const pool = new VertexPool()
  const edges = splitEdges(flat, pool, shapes.length)
  const inside = (sides: boolean[]) => evaluate(op, sides)
  const out = classify(edges, pool.points, shapes, inside)
  return buildRings(out, pool.points, sources)
}

function evaluate(op: BooleanOp, sides: boolean[]): boolean {
  switch (op) {
    case 'union':
      return sides.some(Boolean)
    case 'intersect':
      return sides.every(Boolean)
    case 'subtract':
      return sides[0] && !sides.slice(1).some(Boolean)
    case 'exclude':
      return sides.filter(Boolean).length % 2 === 1
  }
}

/**
 * 曲線を折れ線に直すときの t の並び（0 から 1 まで）。直線は [0, 1]。
 * 3 次ベジェを n 等分した折れ線のずれは M / (8 n²) 以下（M は 2 階微分の大きさの上限 = 6 · max|P0 − 2P1 + P2|, |P1 − 2P2 + P3|）なので、
 * それが FLATTEN_TOLERANCE 以下になる n で分ける
 */
export function flattenParams(segment: Segment, tolerance = FLATTEN_TOLERANCE): number[] {
  if (!segment.curved) return [0, 1]
  const { from, c1, c2, to } = segment
  const d1 = Math.hypot(from.x - 2 * c1.x + c2.x, from.y - 2 * c1.y + c2.y)
  const d2 = Math.hypot(c1.x - 2 * c2.x + to.x, c1.y - 2 * c2.y + to.y)
  const m = 6 * Math.max(d1, d2)
  const n = Math.min(MAX_STEPS, Math.max(1, Math.ceil(Math.sqrt(m / (8 * tolerance)))))
  return Array.from({ length: n + 1 }, (_, k) => k / n)
}

/** 近い点を 1 つの頂点にまとめる表（格子で引く） */
class VertexPool {
  points: Point[] = []
  private grid = new Map<string, number[]>()

  id(p: Point): number {
    const cx = Math.floor(p.x / SNAP)
    const cy = Math.floor(p.y / SNAP)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const id of this.grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          const q = this.points[id]
          if (Math.abs(q.x - p.x) <= SNAP && Math.abs(q.y - p.y) <= SNAP) return id
        }
      }
    }
    const id = this.points.push({ x: p.x, y: p.y }) - 1
    const key = `${cx},${cy}`
    const list = this.grid.get(key)
    if (list) list.push(id)
    else this.grid.set(key, [id])
    return id
  }
}

type Split = { t: number; p: Point }

/** 全部の辺を交点・触れる点で分け、重なった辺を 1 本にまとめる */
function splitEdges(flat: readonly FlatEdge[], pool: VertexPool, shapeCount: number): Edge[] {
  const splits: Split[][] = flat.map((edge) => [
    { t: 0, p: edge.a },
    { t: 1, p: edge.b },
  ])
  const minX = flat.map((edge) => Math.min(edge.a.x, edge.b.x))
  const maxX = flat.map((edge) => Math.max(edge.a.x, edge.b.x))
  const minY = flat.map((edge) => Math.min(edge.a.y, edge.b.y))
  const maxY = flat.map((edge) => Math.max(edge.a.y, edge.b.y))
  // x の左端の順に並べ、x の範囲が重なるものどうしだけを比べる
  const order = flat.map((_, i) => i).sort((i, j) => minX[i] - minX[j])
  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi]
    for (let oj = oi + 1; oj < order.length; oj++) {
      const j = order[oj]
      if (minX[j] > maxX[i] + SNAP) break
      if (minY[j] > maxY[i] + SNAP || maxY[j] < minY[i] - SNAP) continue
      intersect(flat[i], flat[j], splits[i], splits[j])
    }
  }

  const edges: Edge[] = []
  const byKey = new Map<string, number>()
  flat.forEach((edge, index) => {
    const list = splits[index].sort((p, q) => p.t - q.t)
    let prevId = pool.id(list[0].p)
    let prevT = list[0].t
    for (let k = 1; k < list.length; k++) {
      const id = pool.id(list[k].p)
      if (id === prevId) continue
      const key = prevId < id ? `${prevId},${id}` : `${id},${prevId}`
      const found = byKey.get(key)
      if (found === undefined) {
        byKey.set(key, edges.length)
        const wind = new Array<number>(shapeCount).fill(0)
        const count = new Array<number>(shapeCount).fill(0)
        wind[edge.shape] = 1
        count[edge.shape] = 1
        const span = edge.t1 - edge.t0
        edges.push({ a: prevId, b: id, wind, count, src: edge.src, ta: edge.t0 + span * prevT, tb: edge.t0 + span * list[k].t })
      } else {
        const existing = edges[found]
        existing.wind[edge.shape] += existing.a === prevId ? 1 : -1
        existing.count[edge.shape] += 1
      }
      prevId = id
      prevT = list[k].t
    }
  })
  return edges
}

/** 2 本の辺の交わる点・触れる点を、それぞれの分ける位置に足す */
function intersect(p: FlatEdge, q: FlatEdge, splitsP: Split[], splitsQ: Split[]): void {
  // 端が相手の辺の上にある（触れる・重なる）
  touch(p, q.a, splitsP)
  touch(p, q.b, splitsP)
  touch(q, p.a, splitsQ)
  touch(q, p.b, splitsQ)
  const r = { x: p.b.x - p.a.x, y: p.b.y - p.a.y }
  const s = { x: q.b.x - q.a.x, y: q.b.y - q.a.y }
  const denom = r.x * s.y - r.y * s.x
  if (Math.abs(denom) <= 1e-12 * Math.hypot(r.x, r.y) * Math.hypot(s.x, s.y)) return
  const w = { x: q.a.x - p.a.x, y: q.a.y - p.a.y }
  const t = (w.x * s.y - w.y * s.x) / denom
  const u = (w.x * r.y - w.y * r.x) / denom
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return
  const point = { x: p.a.x + r.x * t, y: p.a.y + r.y * t }
  splitsP.push({ t, p: point })
  splitsQ.push({ t: u, p: point })
}

/** 点が辺の途中（端を除く）の SNAP 以内にあれば、そこで分ける */
function touch(edge: FlatEdge, point: Point, splits: Split[]): void {
  const r = { x: edge.b.x - edge.a.x, y: edge.b.y - edge.a.y }
  const length2 = r.x * r.x + r.y * r.y
  if (length2 === 0) return
  const t = ((point.x - edge.a.x) * r.x + (point.y - edge.a.y) * r.y) / length2
  if (t <= 0 || t >= 1) return
  const dx = edge.a.x + r.x * t - point.x
  const dy = edge.a.y + r.y * t - point.y
  if (dx * dx + dy * dy <= SNAP * SNAP) splits.push({ t, p: point })
}

/** 半直線を引くときの、辺を探す帯（行または列）の索引 */
class BandIndex {
  private bands: number[][]
  private origin: number
  private size: number

  constructor(ranges: readonly [number, number][]) {
    const lo = Math.min(...ranges.map((range) => range[0]))
    const hi = Math.max(...ranges.map((range) => range[1]))
    const count = Math.max(1, Math.min(1024, Math.ceil(Math.sqrt(ranges.length))))
    this.origin = lo
    this.size = (hi - lo) / count || 1
    this.bands = Array.from({ length: count }, () => [])
    ranges.forEach(([from, to], index) => {
      for (let band = this.band(from); band <= this.band(to); band++) this.bands[band].push(index)
    })
  }

  band(value: number): number {
    return Math.max(0, Math.min(this.bands.length - 1, Math.floor((value - this.origin) / this.size)))
  }

  at(value: number): readonly number[] {
    return this.bands[this.band(value)]
  }
}

/**
 * 辺ごとに両側の内外を決め、結果の輪郭になる辺を返す。
 * 縦寄りの辺は中点から +x へ、横寄りの辺は +y へ半直線を引き、横切る辺の巻き数と本数を形ごとに数える。
 * それが半直線の側の値で、反対の側はこの辺（と重なった辺）の分を足したもの
 */
function classify(edges: readonly Edge[], points: readonly Point[], shapes: readonly BooleanShape[], inside: (sides: boolean[]) => boolean): OutEdge[] {
  if (edges.length === 0) return []
  const rows = new BandIndex(edges.map((edge) => minMax(points[edge.a].y, points[edge.b].y)))
  const columns = new BandIndex(edges.map((edge) => minMax(points[edge.a].x, points[edge.b].x)))
  const shapeCount = shapes.length
  const isInside = (wind: number[], count: number[]) =>
    shapes.map((shape, s) => (shape.fillRule === 'evenodd' ? count[s] % 2 === 1 : wind[s] !== 0))
  const out: OutEdge[] = []
  edges.forEach((edge, index) => {
    const a = points[edge.a]
    const b = points[edge.b]
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const dx = b.x - a.x
    const dy = b.y - a.y
    const vertical = Math.abs(dy) >= Math.abs(dx)
    const wind = new Array<number>(shapeCount).fill(0)
    const count = new Array<number>(shapeCount).fill(0)
    const add = (other: Edge, sign: number) => {
      for (let s = 0; s < shapeCount; s++) {
        wind[s] += sign * other.wind[s]
        count[s] += other.count[s]
      }
    }
    for (const j of vertical ? rows.at(m.y) : columns.at(m.x)) {
      if (j === index) continue
      const other = edges[j]
      const p = points[other.a]
      const q = points[other.b]
      if (vertical) {
        if (p.y > m.y === q.y > m.y) continue
        const x = p.x + ((m.y - p.y) * (q.x - p.x)) / (q.y - p.y)
        if (x > m.x) add(other, q.y > p.y ? 1 : -1)
      } else {
        if (p.x > m.x === q.x > m.x) continue
        const y = p.y + ((m.x - p.x) * (q.y - p.y)) / (q.x - p.x)
        if (y > m.y) add(other, q.x > p.x ? -1 : 1)
      }
    }
    // 半直線の側（+x か +y）の内外
    const plus = inside(isInside(wind, count))
    add(edge, vertical ? (dy > 0 ? 1 : -1) : dx > 0 ? -1 : 1)
    const minus = inside(isInside(wind, count))
    if (plus === minus) return
    // 左手（n = (-dy, dx) の側）に結果の内側が来る向きにする
    const plusIsLeft = vertical ? -dy > 0 : dx > 0
    if (plus === plusIsLeft) out.push({ from: edge.a, to: edge.b, src: edge.src, tFrom: edge.ta, tTo: edge.tb })
    else out.push({ from: edge.b, to: edge.a, src: edge.src, tFrom: edge.tb, tTo: edge.ta })
  })
  return out
}

function minMax(p: number, q: number): [number, number] {
  return p < q ? [p, q] : [q, p]
}

/** 結果の辺の 1 区間。curved なら元の曲線 src の tFrom〜tTo を切り出したもの */
type Piece = { from: number; to: number; src: number; tFrom: number; tTo: number; curved: boolean }

/** 結果の辺をつないで輪にし、元の曲線から来た辺を曲線に戻した輪郭にする */
function buildRings(out: readonly OutEdge[], points: readonly Point[], sources: readonly Source[]): Contour[] {
  const outgoing = new Map<number, number[]>()
  out.forEach((edge, index) => {
    const list = outgoing.get(edge.from)
    if (list) list.push(index)
    else outgoing.set(edge.from, [index])
  })
  const used = new Array<boolean>(out.length).fill(false)
  const contours: Contour[] = []
  for (let start = 0; start < out.length; start++) {
    if (used[start]) continue
    const ring: OutEdge[] = []
    let current = start
    while (!used[current]) {
      used[current] = true
      const edge = out[current]
      ring.push(edge)
      const next = pickNext(edge, outgoing.get(edge.to) ?? [], used, out, points)
      if (next === null) break
      current = next
    }
    const contour = ringContour(ring, points, sources)
    if (contour) contours.push(contour)
  }
  return contours
}

/**
 * 頂点から続く辺のうち、まだ使っていないもの。いくつもあれば（形が点で触れている所）、
 * 結果の内側（左手）へいちばん大きく曲がるものを選ぶ（触れている形どうしを別の輪にするため）
 */
function pickNext(edge: OutEdge, candidates: readonly number[], used: readonly boolean[], out: readonly OutEdge[], points: readonly Point[]): number | null {
  const free = candidates.filter((index) => !used[index])
  if (free.length <= 1) return free[0] ?? null
  const a = points[edge.from]
  const b = points[edge.to]
  const din = { x: b.x - a.x, y: b.y - a.y }
  let best: number | null = null
  let bestAngle = -Infinity
  for (const index of free) {
    const c = points[out[index].to]
    const dout = { x: c.x - b.x, y: c.y - b.y }
    // 左手は n = (-dy, dx) の側で、din × dout が正の向き
    const angle = Math.atan2(din.x * dout.y - din.y * dout.x, din.x * dout.x + din.y * dout.y)
    if (angle > bestAngle) {
      bestAngle = angle
      best = index
    }
  }
  return best
}

/** 1 つの輪の辺を、元の曲線を切り出した曲線と直線の頂点の並びにする。面積のない輪は null */
function ringContour(ring: readonly OutEdge[], points: readonly Point[], sources: readonly Source[]): Contour | null {
  const pieces: Piece[] = []
  for (const edge of ring) {
    const curved = sources[edge.src].segment.curved
    const piece: Piece = { ...edge, curved }
    const prev = pieces[pieces.length - 1]
    if (prev && canMerge(prev, piece)) {
      prev.to = piece.to
      prev.tTo = piece.tTo
    } else {
      pieces.push(piece)
    }
  }
  // 輪の終わりと始まりが同じ曲線の続きなら 1 つにする
  if (pieces.length > 1 && canMerge(pieces[pieces.length - 1], pieces[0])) {
    const last = pieces.pop()!
    pieces[0] = { ...last, to: pieces[0].to, tTo: pieces[0].tTo }
  }

  const vertices: Vertex[] = pieces.map((piece) => ({ x: points[piece.from].x, y: points[piece.from].y }))
  pieces.forEach((piece, i) => {
    if (!piece.curved) return
    const segment = subSegment(sources[piece.src].segment, piece.tFrom, piece.tTo)
    vertices[i].out = segment.c1
    vertices[(i + 1) % vertices.length].in = segment.c2
  })
  const cleaned = removeCollinear(vertices)
  if (cleaned.length < 2 || (cleaned.length === 2 && !cleaned.some((vertex) => vertex.in || vertex.out))) return null
  return { vertices: cleaned, closed: true }
}

/** 同じ元の曲線の、t の続いた同じ向きの区間か */
function canMerge(prev: Piece, piece: Piece): boolean {
  if (!prev.curved || !piece.curved || prev.src !== piece.src || prev.to !== piece.from) return false
  if (Math.abs(prev.tTo - piece.tFrom) > 1e-9) return false
  return Math.sign(prev.tTo - prev.tFrom) === Math.sign(piece.tTo - piece.tFrom)
}

/** 3 次ベジェの t0〜t1 の部分（t0 > t1 なら向きを逆にしたもの） */
export function subSegment(segment: Segment, t0: number, t1: number): Segment {
  const lo = Math.min(t0, t1)
  const hi = Math.max(t0, t1)
  let part = segment
  if (hi < 1) part = splitSegment(part, hi)[0]
  if (lo > 0 && hi > 0) part = splitSegment(part, lo / hi)[1]
  if (t0 <= t1) return part
  return { from: part.to, c1: part.c2, c2: part.c1, to: part.from, curved: part.curved }
}

/** 直線どうしが一直線に並ぶ間の頂点を除く（隣り合う形の辺がそろっている所に、余計な頂点を残さない） */
function removeCollinear(vertices: Vertex[]): Vertex[] {
  // 一直線に並ぶ頂点が続くときは、まとめて除いても残った両端は同じ直線の上にある
  const collinear = (list: readonly Vertex[], i: number) => {
    const prev = list[(i - 1 + list.length) % list.length]
    const vertex = list[i]
    const next = list[(i + 1) % list.length]
    if (prev.out || vertex.in || vertex.out || next.in) return false
    const ax = vertex.x - prev.x
    const ay = vertex.y - prev.y
    const bx = next.x - vertex.x
    const by = next.y - vertex.y
    return Math.abs(ax * by - ay * bx) <= 1e-9 * Math.hypot(ax, ay) * Math.hypot(bx, by) && ax * bx + ay * by > 0
  }
  let list = vertices
  while (list.length > 2) {
    const kept = list.filter((_, i) => !collinear(list, i))
    if (kept.length === list.length) break
    list = kept
  }
  return list
}

/** 輪郭の面積（evenodd で塗る範囲の面積。曲線は細かく分けて測る）。テストと CLI の確かめ用 */
export function contoursArea(contours: readonly Contour[]): number {
  // 結果の輪郭は外側と穴が逆向きなので、符号付きの面積を足すと塗る範囲の面積になる
  let total = 0
  for (const contour of contours) {
    const polygon: Point[] = []
    for (const segment of pathSegments(contour.vertices, true)) {
      const ts = flattenParams(segment, 0.001)
      for (let k = 0; k < ts.length - 1; k++) polygon.push(segmentAt(segment, ts[k]))
    }
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      total += (polygon[j].x * polygon[i].y - polygon[i].x * polygon[j].y) / 2
    }
  }
  return Math.abs(total)
}
