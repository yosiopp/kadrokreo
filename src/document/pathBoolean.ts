import type { Point } from './geometry.ts'
import { type Contour, type Segment, type Vertex, pathSegments, segmentAt, splitSegment } from './path.ts'

// パスのブーリアン演算（合体・差し引き・交差・除外）。依存を足さずに自前で書いている。
//
// 流れ:
// 1. 形ごとの輪郭の辺を、曲線は細かい折れ線に直す（FLATTEN_TOLERANCE 以内のずれ）。折れ線の辺は、どの辺のどの t の範囲から来たかを覚える。
// 2. 全部の辺どうしの交点を求め、端の点と交点を SNAP 四方のマスごとに 1 つの頂点にまとめる。頂点のあるマスを通る辺は、そこで分ける（触れる・重なるもこれで扱う）。重なった辺も 1 本にまとめる。
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
/** 頂点をまとめるマスの大きさ（px）。同じマスの点は同じ頂点とみなす */
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
  const { edges, points, exact } = splitEdges(flat, shapes.length)
  const inside = (sides: boolean[]) => evaluate(op, sides)
  const out = classify(edges, points, shapes, inside)
  return buildRings(out, points, exact, sources)
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

/**
 * 頂点の表。平面を SNAP 四方のマス（SNAP の整数倍の点を中心にする）に分け、同じマスに入った点は 1 つの頂点にまとめる。
 * マスの中心を切りのいい座標に置くのは、整数や 0.5 のような座標の辺がマスの境目に乗らないようにするため
 * （境目の上を走る辺は両側のマスを同時に通り、通る順が決まらない）。
 * 交わり方と内外はマスの中心（points）で決め、結果の輪郭にはマスに最初に入った点の位置（exact）を使う
 * （入力の頂点は動かさない。ずれはマスの対角線以内）。
 * 近さで 1 点ずつまとめたり、マスの中心以外を通したりすると、まとめた後の辺どうしが頂点を共有せずに交わりうる
 */
class VertexPool {
  /** マスの中心 */
  points: Point[] = []
  /** マスに最初に入った点 */
  exact: Point[] = []
  cellX: number[] = []
  cellY: number[] = []
  private byCell = new Map<string, number>()

  id(p: Point): number {
    const cx = Math.round(p.x / SNAP)
    const cy = Math.round(p.y / SNAP)
    const key = `${cx},${cy}`
    const found = this.byCell.get(key)
    if (found !== undefined) return found
    const id = this.points.push({ x: cx * SNAP, y: cy * SNAP }) - 1
    this.exact.push({ x: p.x, y: p.y })
    this.cellX.push(cx)
    this.cellY.push(cy)
    this.byCell.set(key, id)
    return id
  }
}

/** 辺を分ける位置。t は辺の上の位置（0〜1）、id は頂点 */
type Split = { t: number; id: number }

/**
 * 全部の辺を交点・触れる点で分け、重なった辺を 1 本にまとめる。
 * 端の点と交点のあるマスを、そのマスを通る辺はすべて、そのマスの頂点を通るように分ける（スナップ丸め）。
 * こうすると、交点が密集したり辺がほとんど重なったりしても、まとめた後の辺どうしが頂点を共有せずに重なる・交わることがない。
 * 2 本ずつの交点だけで分けると、ほとんど重なる 3 本目の辺がその交点のそばを分けられずに通り、半直線で数える内外が食い違って輪が閉じなくなる
 */
function splitEdges(flat: readonly FlatEdge[], shapeCount: number): { edges: Edge[]; points: Point[]; exact: Point[] } {
  const pool = new VertexPool()
  // 入力の頂点の位置をそのまま残すため、端の点を交点より先に入れる
  const splits: Split[][] = flat.map((edge) => [
    { t: 0, id: pool.id(edge.a) },
    { t: 1, id: pool.id(edge.b) },
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
      if (minX[j] > maxX[i]) break
      if (minY[j] > maxY[i] || maxY[j] < minY[i]) continue
      const hit = crossing(flat[i], flat[j])
      if (!hit) continue
      // 交点は、丸め誤差で片方の辺がそのマスを外れても、作った 2 本には必ず通す
      const id = pool.id(hit.point)
      splits[i].push({ t: hit.t, id })
      splits[j].push({ t: hit.u, id })
    }
  }

  const cells = new CellIndex(pool)
  // 頂点の番号は、辺に使った順に振り直す（交点は総当たりの順にできるので、そのままだと近い頂点が配列の離れた所に並び、
  // 内外を数えるときに読む位置が飛んで遅くなる）
  const renumber = new Array<number>(pool.points.length).fill(-1)
  const points: Point[] = []
  const exact: Point[] = []
  const vertex = (id: number) => {
    if (renumber[id] < 0) {
      renumber[id] = points.length
      points.push(pool.points[id])
      exact.push(pool.exact[id])
    }
    return renumber[id]
  }
  const edges: Edge[] = []
  const byKey = new Map<string, number>()
  flat.forEach((edge, index) => {
    const list = splits[index]
    const startId = list[0].id
    const endId = list[1].id
    if (startId === endId) return
    // 両端のマスを通る区間より外（端の点で隣のマスに触れるだけの所）は数えない。数えると、端の手前で隣のマスへ回り込む
    const first = cellHit(edge, pool.cellX[startId], pool.cellY[startId]) ?? 0
    const last = cellHit(edge, pool.cellX[endId], pool.cellY[endId]) ?? 1
    cells.near(edge, (id) => {
      if (id === startId || id === endId) return
      const t = cellHit(edge, pool.cellX[id], pool.cellY[id])
      if (t !== null && t > first && t < last) list.push({ t, id })
    })
    list.sort((p, q) => p.t - q.t)
    let prev = list[0]
    for (let k = 1; k < list.length; k++) {
      const next = list[k]
      if (next.id === prev.id) continue
      const a = vertex(prev.id)
      const b = vertex(next.id)
      const key = a < b ? `${a},${b}` : `${b},${a}`
      const found = byKey.get(key)
      if (found === undefined) {
        byKey.set(key, edges.length)
        const wind = new Array<number>(shapeCount).fill(0)
        const count = new Array<number>(shapeCount).fill(0)
        wind[edge.shape] = 1
        count[edge.shape] = 1
        const span = edge.t1 - edge.t0
        edges.push({ a, b, wind, count, src: edge.src, ta: edge.t0 + span * prev.t, tb: edge.t0 + span * next.t })
      } else {
        const existing = edges[found]
        existing.wind[edge.shape] += existing.a === a ? 1 : -1
        existing.count[edge.shape] += 1
      }
      prev = next
    }
  })
  return { edges, points, exact }
}

/** 小さい順に並んだ values のうち、value 以上の最初の位置 */
function lowerBound(values: readonly number[], value: number): number {
  let lo = 0
  let hi = values.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (values[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * 頂点のあるマスを、辺の近くだけ引く索引。マスを x で縦の帯に分け、帯の中は y の順に並べる。
 * 辺ごとに、重なる帯のそれぞれで辺の y の範囲だけを二分探索で引く（長い辺でも、遠いマスは見ない）
 */
class CellIndex {
  private origin: number
  private width: number
  /** 帯ごとの頂点（y の順）と、そのマスの y */
  private ids: number[][]
  private ys: number[][]
  private pool: VertexPool

  constructor(pool: VertexPool) {
    this.pool = pool
    const count = pool.points.length
    let lo = Infinity
    let hi = -Infinity
    for (const cx of pool.cellX) {
      if (cx < lo) lo = cx
      if (cx > hi) hi = cx
    }
    const bands = Math.max(1, Math.min(4096, Math.ceil(Math.sqrt(count))))
    this.origin = lo
    this.width = Math.max(1, Math.ceil((hi - lo + 1) / bands))
    this.ids = Array.from({ length: bands }, () => [])
    for (let id = 0; id < count; id++) this.ids[this.band(pool.cellX[id])].push(id)
    for (const list of this.ids) list.sort((p, q) => pool.cellY[p] - pool.cellY[q])
    this.ys = this.ids.map((list) => list.map((id) => pool.cellY[id]))
  }

  private band(cx: number): number {
    return Math.max(0, Math.min(this.ids.length - 1, Math.floor((cx - this.origin) / this.width)))
  }

  /** 辺の通りうるマスの頂点を visit に渡す（多めに渡す。通るかどうかは cellHit で確かめる） */
  near(edge: FlatEdge, visit: (id: number) => void): void {
    const { pool } = this
    // マスの大きさを 1 にした座標
    const ax = edge.a.x / SNAP
    const ay = edge.a.y / SNAP
    const dx = edge.b.x / SNAP - ax
    const dy = edge.b.y / SNAP - ay
    const x0 = Math.round(Math.min(ax, ax + dx)) - 1
    const x1 = Math.round(Math.max(ax, ax + dx)) + 1
    // マスの中心が辺の直線からマスの半分の対角線（≒ 0.71）より遠ければ通らない
    const reach = 0.75 * Math.hypot(dx, dy)
    for (let band = this.band(x0), end = this.band(x1); band <= end; band++) {
      // この帯（と隣のマスの分）の x の範囲で、辺がとる y の範囲
      const from = Math.max(x0, this.origin + band * this.width - 1)
      const to = Math.min(x1, this.origin + (band + 1) * this.width)
      let yLo = Math.min(ay, ay + dy)
      let yHi = Math.max(ay, ay + dy)
      if (dx !== 0) {
        const ta = Math.max(0, Math.min(1, (from - 0.5 - ax) / dx))
        const tb = Math.max(0, Math.min(1, (to + 0.5 - ax) / dx))
        yLo = Math.min(ay + dy * ta, ay + dy * tb)
        yHi = Math.max(ay + dy * ta, ay + dy * tb)
      }
      const ids = this.ids[band]
      const ys = this.ys[band]
      const yMax = Math.round(yHi) + 1
      for (let k = lowerBound(ys, Math.round(yLo) - 1); k < ids.length && ys[k] <= yMax; k++) {
        const id = ids[k]
        const cx = pool.cellX[id]
        if (cx < x0 || cx > x1) continue
        if (Math.abs((cx - ax) * dy - (ys[k] - ay) * dx) > reach) continue
        visit(id)
      }
    }
  }
}

/**
 * 辺がマス (cx, cy) を通れば、通る区間の真ん中の t。通らなければ null。
 * マスはごくわずかに広げて比べる（ほとんど水平・垂直な辺がマスの境目すれすれを通ると、どちらのマスを通るかが丸め誤差で
 * 交点の計算と食い違うので、境目の上は両側のマスを通るとみなす）。広げた分だけ隣のマスと重なるが、真ん中の t の順は通る順のまま
 */
function cellHit(edge: FlatEdge, cx: number, cy: number): number | null {
  // マスの大きさを 1 にした座標で比べる（VertexPool.id の round と同じ尺度）。half はマスの半分の幅に、ごくわずかな余白を足したもの
  const half = 0.5 + 1e-6
  const ax = edge.a.x / SNAP
  const ay = edge.a.y / SNAP
  const dx = edge.b.x / SNAP - ax
  const dy = edge.b.y / SNAP - ay
  let lo = 0
  let hi = 1
  const clip = (start: number, delta: number, min: number, max: number) => {
    if (delta === 0) return start >= min && start <= max
    let t0 = (min - start) / delta
    let t1 = (max - start) / delta
    if (t0 > t1) [t0, t1] = [t1, t0]
    lo = Math.max(lo, t0)
    hi = Math.min(hi, t1)
    return lo <= hi
  }
  if (!clip(ax, dx, cx - half, cx + half) || !clip(ay, dy, cy - half, cy + half)) return null
  return (lo + hi) / 2
}

/** 2 本の辺が途中（端を除く）で交われば、その点と、それぞれの辺の上の位置 */
function crossing(p: FlatEdge, q: FlatEdge): { point: Point; t: number; u: number } | null {
  const r = { x: p.b.x - p.a.x, y: p.b.y - p.a.y }
  const s = { x: q.b.x - q.a.x, y: q.b.y - q.a.y }
  const denom = r.x * s.y - r.y * s.x
  if (Math.abs(denom) <= 1e-12 * Math.hypot(r.x, r.y) * Math.hypot(s.x, s.y)) return null
  const w = { x: q.a.x - p.a.x, y: q.a.y - p.a.y }
  const t = (w.x * s.y - w.y * s.x) / denom
  const u = (w.x * r.y - w.y * r.x) / denom
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null
  return { point: { x: p.a.x + r.x * t, y: p.a.y + r.y * t }, t, u }
}

/** 半直線を引くときの、辺を探す帯（行または列）の索引 */
class BandIndex {
  private bands: number[][]
  private origin: number
  private size: number

  constructor(ranges: readonly [number, number][]) {
    // 辺が数万本になる（交点の多い自分と交わる形）と、Math.min(...配列) は引数が多すぎてスタックがあふれるのでループで求める
    let lo = Infinity
    let hi = -Infinity
    for (const [from, to] of ranges) {
      if (from < lo) lo = from
      if (to > hi) hi = to
    }
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

/** 結果の辺をつないで輪にし、元の曲線から来た辺を曲線に戻した輪郭にする。つなぎ方は points（マスの中心）で決め、輪郭は exact の位置で作る */
function buildRings(out: readonly OutEdge[], points: readonly Point[], exact: readonly Point[], sources: readonly Source[]): Contour[] {
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
    const contour = ringContour(ring, exact, sources)
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
