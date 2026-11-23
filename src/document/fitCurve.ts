import type { Point } from './geometry.ts'
import type { Contour, Vertex } from './path.ts'

// 折れ線の閉じた輪郭を、3 次ベジェ曲線と直線のつながりに当てはめ直す（線の輪郭化の結果の頂点を減らすため）。
//
// 1. 大きく曲がる頂点（CORNER_DEGREES より大きく向きが変わる所）を角とみなし、そこで輪郭を区切る。長い辺（直線）の両端でも区切る。
//    区切りがなければ 1 か所で切る。
// 2. 区切った 1 本ずつを、全部の点が誤差の範囲で弦に乗れば直線、そうでなければ 3 次曲線で近似する
//    （弦の長さで点に t を振り、両端の接線の向きを決めた最小二乗で制御点を求め、ずれが大きければニュートン法で t を直し、
//    それでも大きければいちばんずれた点で分けて繰り返す。よく知られた当てはめの方法）。
//    長い辺は区切りの 1 本になるので、曲線で近似するのは短い辺の並びだけ（点の間で曲線がふくらんでも、ずれは小さい）。
// 3. 角では接線を左右で別に、角でない継ぎ目では前後の点から 1 つの接線を取るので、曲線どうしはなめらかにつながる。

/** これより大きく向きが変わる頂点は角とみなす（度）。折れ線に直した曲線の 1 歩はこれより小さい（flattenPath は 1 本を 4 つ以上に分ける） */
const CORNER_DEGREES = 30
/** これより長い辺は直線とみなし、両端で区切る（px）。flattenPath の曲線の 1 歩（約 6px）より長く */
const LONG_EDGE = 8
/** 当てはめで許すずれ（px） */
export const FIT_TOLERANCE = 0.05

/** 閉じた折れ線の輪郭を、曲線と直線の輪郭にする。うまく当てはまらない輪郭（点が少ないなど）はそのまま返す */
export function fitContour(contour: Contour, tolerance = FIT_TOLERANCE): Contour {
  if (!contour.closed || contour.vertices.length < 4 || contour.vertices.some((v) => v.in || v.out)) return contour
  const points = contour.vertices.map((v) => ({ x: v.x, y: v.y }))
  const n = points.length
  const cosLimit = Math.cos((CORNER_DEGREES * Math.PI) / 180)
  const isLong = (i: number) => Math.hypot(points[(i + 1) % n].x - points[i].x, points[(i + 1) % n].y - points[i].y) > LONG_EDGE
  // 区切りの頂点と、そこでの接線（角なら null で、左右の点から別々に見積もる）
  const breaks: { index: number; tangent: Point | null }[] = []
  for (let i = 0; i < n; i++) {
    const before = (i - 1 + n) % n
    const a = unit(sub(points[i], points[before]))
    const b = unit(sub(points[(i + 1) % n], points[i]))
    if (!a || !b || dot(a, b) < cosLimit) breaks.push({ index: i, tangent: null })
    else if (isLong(before)) breaks.push({ index: i, tangent: a })
    else if (isLong(i)) breaks.push({ index: i, tangent: b })
  }
  // 区切りがなければ、0 番で切る（そこは角ではないので、前後の点から接線を取る）
  if (breaks.length === 0) breaks.push({ index: 0, tangent: centerTangent(points[n - 1], points[1]) })

  // 輪郭をひと回りする辺の並び（curve が null なら直線）
  const segments: { from: Point; curve: Cubic | null }[] = []
  for (let k = 0; k < breaks.length; k++) {
    const start = breaks[k]
    const end = breaks[(k + 1) % breaks.length]
    const endIndex = k + 1 < breaks.length ? end.index : breaks[0].index + n
    const run: Point[] = []
    for (let i = start.index; i <= endIndex; i++) run.push(points[i % n])
    // 終わりの接線は戻る向き
    const curves = fitRun(run, start.tangent, end.tangent && { x: -end.tangent.x, y: -end.tangent.y }, tolerance)
    for (const curve of curves) {
      if (curve === null) segments.push({ from: run[0], curve: null })
      else segments.push({ from: curve[0], curve: isStraight(curve) ? null : curve })
    }
  }
  const vertices: Vertex[] = segments.map((segment, i) => {
    const before = segments[(i - 1 + segments.length) % segments.length].curve
    const vertex: Vertex = { x: segment.from.x, y: segment.from.y }
    if (before) vertex.in = before[2]
    if (segment.curve) vertex.out = segment.curve[1]
    return vertex
  })
  return vertices.length >= 2 ? { vertices, closed: true } : contour
}

type Cubic = [Point, Point, Point, Point]

/**
 * 端から端までの点の並びを、曲線の並びにする。null は直線（点がどれも弦に乗る）。
 * 返す並びの i 番目の終わりが i + 1 番目の始め。t1 / t2 は始め・終わりの接線（始めは進む向き、終わりは戻る向き）。null なら端の点から見積もる
 */
function fitRun(run: readonly Point[], t1: Point | null, t2: Point | null, tolerance: number): (Cubic | null)[] {
  const a = run[0]
  const b = run[run.length - 1]
  const chord = sub(b, a)
  const chordLength = Math.hypot(chord.x, chord.y)
  if (run.length === 2 || (chordLength > 0 && run.every((p) => Math.abs(cross(chord, sub(p, a))) / chordLength <= tolerance))) {
    return [null]
  }
  const start = t1 ?? unit(sub(run[1], run[0])) ?? { x: 1, y: 0 }
  const end = t2 ?? unit(sub(run[run.length - 2], run[run.length - 1])) ?? { x: -1, y: 0 }
  return fitCubic(run, start, end, tolerance, 0)
}

/** 点の並びを、接線 tHat1（始め）・tHat2（終わり）の 3 次曲線の並びで近似する */
function fitCubic(points: readonly Point[], tHat1: Point, tHat2: Point, tolerance: number, depth: number): Cubic[] {
  const first = points[0]
  const lastPoint = points[points.length - 1]
  if (points.length === 2) {
    const d = Math.hypot(lastPoint.x - first.x, lastPoint.y - first.y) / 3
    return [[first, add(first, scale(tHat1, d)), add(lastPoint, scale(tHat2, d)), lastPoint]]
  }
  let u = chordParameters(points)
  let curve = generateBezier(points, u, tHat1, tHat2)
  let { error, index } = maxError(points, curve, u)
  if (error <= tolerance) return [curve]
  if (error <= tolerance * 16) {
    for (let k = 0; k < 8; k++) {
      u = reparameterize(points, u, curve)
      curve = generateBezier(points, u, tHat1, tHat2)
      ;({ error, index } = maxError(points, curve, u))
      if (error <= tolerance) return [curve]
    }
  }
  // いちばんずれた点で分ける（端の点は避ける）
  const split = Math.min(Math.max(index, 1), points.length - 2)
  if (depth > 32) return points.slice(1).map((p, i) => straightCubic(points[i], p))
  const center = centerTangent(points[split - 1], points[split + 1]) ?? unit(sub(points[split + 1], points[split])) ?? { x: 1, y: 0 }
  return [
    ...fitCubic(points.slice(0, split + 1), tHat1, { x: -center.x, y: -center.y }, tolerance, depth + 1),
    ...fitCubic(points.slice(split), center, tHat2, tolerance, depth + 1),
  ]
}

/** 弦の長さの割合で振った t */
function chordParameters(points: readonly Point[]): number[] {
  const u = [0]
  for (let i = 1; i < points.length; i++) u.push(u[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y))
  const total = u[u.length - 1]
  return total > 0 ? u.map((value) => value / total) : u.map((_, i) => i / (points.length - 1))
}

/** 両端の点と接線の向きを決め、制御点までの長さを最小二乗で求めた曲線 */
function generateBezier(points: readonly Point[], u: readonly number[], tHat1: Point, tHat2: Point): Cubic {
  const first = points[0]
  const lastPoint = points[points.length - 1]
  let c00 = 0
  let c01 = 0
  let c11 = 0
  let x0 = 0
  let x1 = 0
  for (let i = 0; i < points.length; i++) {
    const t = u[i]
    const mt = 1 - t
    const b0 = mt * mt * mt
    const b1 = 3 * t * mt * mt
    const b2 = 3 * t * t * mt
    const b3 = t * t * t
    const a1 = scale(tHat1, b1)
    const a2 = scale(tHat2, b2)
    c00 += dot(a1, a1)
    c01 += dot(a1, a2)
    c11 += dot(a2, a2)
    const tmp = sub(points[i], add(scale(first, b0 + b1), scale(lastPoint, b2 + b3)))
    x0 += dot(a1, tmp)
    x1 += dot(a2, tmp)
  }
  const det = c00 * c11 - c01 * c01
  const segLength = Math.hypot(lastPoint.x - first.x, lastPoint.y - first.y)
  let alpha1 = det === 0 ? 0 : (x0 * c11 - x1 * c01) / det
  let alpha2 = det === 0 ? 0 : (c00 * x1 - c01 * x0) / det
  // 長さが負か小さすぎれば、弦の 1/3 にする
  const epsilon = 1e-6 * segLength
  if (!(alpha1 >= epsilon) || !(alpha2 >= epsilon)) {
    alpha1 = segLength / 3
    alpha2 = segLength / 3
  }
  return [first, add(first, scale(tHat1, alpha1)), add(lastPoint, scale(tHat2, alpha2)), lastPoint]
}

/** ニュートン法で、点ごとに曲線上のいちばん近い t へ寄せる */
function reparameterize(points: readonly Point[], u: readonly number[], curve: Cubic): number[] {
  return u.map((t, i) => {
    const p = bezier(curve, t)
    const d1 = derivative(curve, t)
    const d2 = secondDerivative(curve, t)
    const diff = sub(p, points[i])
    const numerator = dot(diff, d1)
    const denominator = dot(d1, d1) + dot(diff, d2)
    if (denominator === 0) return t
    return Math.min(1, Math.max(0, t - numerator / denominator))
  })
}

/** 点と曲線上の t の位置のずれのうち、いちばん大きいものとその点の番号 */
function maxError(points: readonly Point[], curve: Cubic, u: readonly number[]): { error: number; index: number } {
  let error = 0
  let index = Math.floor(points.length / 2)
  for (let i = 1; i < points.length - 1; i++) {
    const p = bezier(curve, u[i])
    const d = Math.hypot(p.x - points[i].x, p.y - points[i].y)
    if (d > error) {
      error = d
      index = i
    }
  }
  return { error, index }
}

/** 制御点が弦の上に乗った曲線（直線と同じ形）か */
function isStraight(c: Cubic): boolean {
  const chord = sub(c[3], c[0])
  const length = Math.hypot(chord.x, chord.y)
  if (length === 0) return false
  const along = (p: Point) => dot(sub(p, c[0]), chord) / (length * length)
  return [c[1], c[2]].every((p) => Math.abs(cross(chord, sub(p, c[0]))) / length < 1e-6 && along(p) >= 0 && along(p) <= 1)
}

function straightCubic(a: Point, b: Point): Cubic {
  return [a, add(a, scale(sub(b, a), 1 / 3)), add(a, scale(sub(b, a), 2 / 3)), b]
}

function bezier(c: Cubic, t: number): Point {
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const d = 3 * mt * t * t
  const e = t * t * t
  return { x: a * c[0].x + b * c[1].x + d * c[2].x + e * c[3].x, y: a * c[0].y + b * c[1].y + d * c[2].y + e * c[3].y }
}

function derivative(c: Cubic, t: number): Point {
  const mt = 1 - t
  return add(add(scale(sub(c[1], c[0]), 3 * mt * mt), scale(sub(c[2], c[1]), 6 * mt * t)), scale(sub(c[3], c[2]), 3 * t * t))
}

function secondDerivative(c: Cubic, t: number): Point {
  const a = add(sub(c[2], scale(c[1], 2)), c[0])
  const b = add(sub(c[3], scale(c[2], 2)), c[1])
  return add(scale(a, 6 * (1 - t)), scale(b, 6 * t))
}

/** 前後の点を結ぶ向き（なめらかな継ぎ目の接線） */
function centerTangent(before: Point, after: Point): Point | null {
  return unit(sub(after, before))
}

function unit(v: Point): Point | null {
  const length = Math.hypot(v.x, v.y)
  return length > 1e-12 ? { x: v.x / length, y: v.y / length } : null
}
function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y }
}
function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y }
}
function scale(a: Point, k: number): Point {
  return { x: a.x * k, y: a.y * k }
}
function dot(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y
}
function cross(a: Point, b: Point): number {
  return a.x * b.y - a.y * b.x
}
