import type { Point } from './geometry.ts'
import type { Cap, StrokeJoin } from './types.ts'
import { ellipseVertices, type ShapeNode, shapeContours } from './mask.ts'
import { type Contour, cappedStroke, dashCap, flattenPath, pathOutlines } from './path.ts'
import { fitContour } from './fitCurve.ts'
import { booleanContours } from './pathBoolean.ts'

// 線の輪郭化（既存のデザインツールの Outline stroke）。線の太さの形を、塗る輪郭（閉じた形）にする。
//
// 線を細かい折れ線に直し（曲線は flattenPath と同じ細かさ）、辺ごとの長方形・頂点ごとのつなぎ目（線の角の形 strokeJoin。マイターは
// 長さが太さの 10 倍を超えればベベル。Canvas の既定。丸は円）・端の形（cappedStroke の図形）を並べ、それらをブーリアン演算の合体でまとめる。
// 破線は、線と空きの長さ（とずれ strokeDashOffset）で折れ線を切り分けてから同じことをする。開いたパスの両端が同じ丸・四角なら、
// 破線の 1 本ごとの両端にその形を付ける（dashCap。描画の lineCap と同じ）。そうでなければ切れ目の端は切りっぱなし。
// 合体の結果は折れ線なので、角で区切って曲線に当てはめ直す（fitContour）。線は輪郭の上に内と外へ半分ずつ引く（描画と同じ）。

/** マイターのつなぎ目の長さの上限（線の太さに対する倍率。Canvas の miterLimit の既定） */
const MITER_LIMIT = 10

/** 輪郭化できる図形の線の設定 */
type Stroked = ShapeNode

/**
 * 線の形の輪郭（ノードの座標系、nonzero・evenodd どちらで読んでも同じ。重なりのない閉じた形）。
 * 線がない（太さ 0）か、形が潰れていれば空
 */
export function strokeOutline(node: Stroked): Contour[] {
  const half = node.strokeWidth / 2
  if (half <= 0) return []
  const pieces: Point[][] = []
  const contours = node.type === 'path' ? pathOutlines(node) : shapeContours(node)
  // 破線の切れ目の端の形（あれば、線の両端の形もこれで付く）
  const cap = node.type === 'path' ? dashCap(node) : null
  const addCaps = (vertices: readonly Point[], startCap: Cap, endCap: Cap) => {
    for (const shape of cappedStroke(vertices, { strokeWidth: node.strokeWidth, startCap, endCap, capSize: 0 }).caps) {
      pieces.push(shape.kind === 'circle' ? flattenPath(ellipseVertices(shape.center.x, shape.center.y, shape.radius, shape.radius), true) : shape.points)
    }
  }
  contours.forEach((contour, index) => {
    let vertices = contour.vertices
    // 端の形は、パスの最初の輪郭の開いた端にだけ付く（描画と同じ）
    if (node.type === 'path' && cap === null && index === 0 && !contour.closed && (node.startCap !== 'none' || node.endCap !== 'none')) {
      const capped = cappedStroke(vertices, node)
      vertices = capped.line
      for (const shape of capped.caps) {
        pieces.push(shape.kind === 'circle' ? flattenPath(ellipseVertices(shape.center.x, shape.center.y, shape.radius, shape.radius), true) : shape.points)
      }
    }
    const points = withoutRepeats(flattenPath(vertices, contour.closed), contour.closed)
    const runs = node.strokeDashes.some((d) => d > 0)
      ? dashRuns(points, contour.closed, node.strokeDashes, node.strokeDashOffset)
      : [{ points, closed: contour.closed }]
    for (const run of runs) {
      pieces.push(...strokePieces(run.points, run.closed, half, node.strokeJoin))
      if (cap !== null && !run.closed) addCaps(run.points, cap, cap)
    }
  })
  const shapes = pieces.filter((piece) => piece.length >= 3).map(oriented)
  if (shapes.length === 0) return []
  return booleanContours([{ contours: shapes.map((points) => ({ vertices: points, closed: true })), fillRule: 'nonzero' }], 'union').map((c) => fitContour(c))
}

/** 続けて同じ位置にある点を除く（閉じた形は最後と最初も） */
function withoutRepeats(points: readonly Point[], closed: boolean): Point[] {
  const out: Point[] = []
  for (const p of points) {
    const last = out[out.length - 1]
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-9) out.push(p)
  }
  if (closed && out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= 1e-9) out.pop()
  return out
}

/** 面積が正（y を下向きにとった座標で時計回り）になる向きにそろえる。合体の巻き数がどれも同じ向きに数えられるように */
function oriented(points: Point[]): Point[] {
  let area = 0
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) area += points[j].x * points[i].y - points[i].x * points[j].y
  return area < 0 ? points.toReversed() : points
}

/**
 * 折れ線を破線の並び（線・空きの長さを交互に。奇数なら 2 回繰り返す）で切り分けた、線を引く部分。
 * offset は並びを始める位置（Canvas の lineDashOffset・SVG の stroke-dashoffset と同じ）
 */
export function dashRuns(points: readonly Point[], closed: boolean, dashes: readonly number[], offset = 0): { points: Point[]; closed: false }[] {
  const pattern = dashes.length % 2 === 1 ? [...dashes, ...dashes] : [...dashes]
  const total = pattern.reduce((a, b) => a + b, 0)
  if (total <= 0) return [{ points: [...points], closed: false }]
  const path = closed && points.length > 0 ? [...points, points[0]] : [...points]
  const runs: { points: Point[]; closed: false }[] = []
  let index = 0
  let on = true
  // ずれの分だけ並びを進めてから始める（負なら 1 周分足した位置）
  let phase = Number.isFinite(offset) ? ((offset % total) + total) % total : 0
  while (phase >= pattern[index] && phase > 0) {
    phase -= pattern[index]
    index = (index + 1) % pattern.length
    on = !on
  }
  let left = pattern[index] - phase
  let current: Point[] = [path[0]]
  for (let i = 1; i < path.length; i++) {
    let from = path[i - 1]
    const to = path[i]
    let remaining = Math.hypot(to.x - from.x, to.y - from.y)
    while (remaining > left) {
      const t = left / remaining
      const cut = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
      if (on) {
        current.push(cut)
        runs.push({ points: current, closed: false })
      }
      current = [cut]
      remaining -= left
      from = cut
      index = (index + 1) % pattern.length
      left = pattern[index]
      on = !on
      // 長さ 0 の線・空きが続いても止まらないよう、全部 0 でないことは total で確かめてある
    }
    left -= remaining
    if (on) current.push(to)
  }
  if (on && current.length >= 2) runs.push({ points: current, closed: false })
  return runs.filter((run) => run.points.length >= 2)
}

/** 折れ線を太さ half × 2 で引いた形を、辺ごとの長方形とつなぎ目の図形に分けたもの */
function strokePieces(points: readonly Point[], closed: boolean, half: number, join: StrokeJoin = 'miter'): Point[][] {
  const n = points.length
  if (n < 2) return []
  const pieces: Point[][] = []
  const count = closed ? n : n - 1
  const normals: (Point | null)[] = []
  for (let i = 0; i < count; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (length === 0) {
      normals.push(null)
      continue
    }
    const nx = (-(b.y - a.y) / length) * half
    const ny = ((b.x - a.x) / length) * half
    normals.push({ x: nx, y: ny })
    pieces.push([
      { x: a.x + nx, y: a.y + ny },
      { x: b.x + nx, y: b.y + ny },
      { x: b.x - nx, y: b.y - ny },
      { x: a.x - nx, y: a.y - ny },
    ])
  }
  // つなぎ目: 辺 i - 1 と辺 i の間の頂点 i
  const first = closed ? 0 : 1
  for (let i = first; i < (closed ? n : n - 1); i++) {
    const n1 = normals[(i - 1 + count) % count]
    const n2 = normals[i % count]
    if (!n1 || !n2) continue
    const v = points[i]
    // 曲がる向き（n の側へ曲がるなら、外側は -n の側）
    const cross = n1.x * n2.y - n1.y * n2.x
    if (Math.abs(cross) < 1e-12 * half * half) continue
    const s = cross > 0 ? -1 : 1
    const p1 = { x: v.x + n1.x * s, y: v.y + n1.y * s }
    const p2 = { x: v.x + n2.x * s, y: v.y + n2.y * s }
    const sum = { x: n1.x + n2.x, y: n1.y + n2.y }
    const sumSquared = sum.x * sum.x + sum.y * sum.y
    // マイターの先までの長さは half / cos(φ/2)（φ は 2 つの法線のなす角）。太さの MITER_LIMIT 倍を超えればベベル
    const cosHalf = Math.sqrt(sumSquared) / (2 * half)
    if (join === 'round') {
      pieces.push(flattenPath(ellipseVertices(v.x, v.y, half, half), true))
    } else if (join === 'miter' && cosHalf > 0 && 1 / cosHalf <= MITER_LIMIT) {
      const k = (2 * half * half) / sumSquared
      pieces.push([v, p1, { x: v.x + sum.x * k * s, y: v.y + sum.y * k * s }, p2])
    } else {
      pieces.push([v, p1, p2])
    }
  }
  return pieces
}
