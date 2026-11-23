import { describe, expect, it } from 'vitest'
import type { Point } from './geometry.ts'
import { ellipseVertices } from './mask.ts'
import { type Contour, type Vertex, pathSegments, segmentAt } from './path.ts'
import { type BooleanShape, FLATTEN_TOLERANCE, booleanContours, contoursArea, flattenParams, subSegment } from './pathBoolean.ts'

const rect = (x: number, y: number, w: number, h: number, fillRule: BooleanShape['fillRule'] = 'nonzero'): BooleanShape => ({
  contours: [{ vertices: rectVertices(x, y, w, h), closed: true }],
  fillRule,
})
const rectVertices = (x: number, y: number, w: number, h: number): Vertex[] => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
]
const circle = (cx: number, cy: number, r: number): BooleanShape => ({
  contours: [{ vertices: ellipseVertices(cx, cy, r, r), closed: true }],
  fillRule: 'nonzero',
})
const vertexCount = (contours: Contour[]) => contours.reduce((sum, contour) => sum + contour.vertices.length, 0)

/** 輪郭の曲線の上の点を細かく取る */
function samples(contours: Contour[], perSegment = 16) {
  const points = []
  for (const contour of contours) {
    for (const segment of pathSegments(contour.vertices, true)) {
      for (let k = 0; k <= perSegment; k++) points.push(segmentAt(segment, k / perSegment))
    }
  }
  return points
}

describe('booleanContours（矩形）', () => {
  const a = rect(0, 0, 100, 100)
  const b = rect(50, 50, 100, 100)

  it('合体は重なりを 1 度だけ数えた面積の 1 つの輪郭になる', () => {
    const result = booleanContours([a, b], 'union')
    expect(result).toHaveLength(1)
    expect(result[0].vertices).toHaveLength(8)
    expect(contoursArea(result)).toBeCloseTo(17500, 6)
  })

  it('差し引きは最背面の形から残りを引く', () => {
    const result = booleanContours([a, b], 'subtract')
    expect(result).toHaveLength(1)
    expect(result[0].vertices).toHaveLength(6)
    expect(contoursArea(result)).toBeCloseTo(7500, 6)
    // 引く順は並び（先頭が最背面）で決まる
    expect(contoursArea(booleanContours([b, a], 'subtract'))).toBeCloseTo(7500, 6)
  })

  it('交差は重なった所だけ', () => {
    const result = booleanContours([a, b], 'intersect')
    expect(result).toHaveLength(1)
    expect(result[0].vertices.map(({ x, y }) => [x, y]).sort()).toEqual([
      [100, 100],
      [100, 50],
      [50, 100],
      [50, 50],
    ])
  })

  it('除外は重なりを抜く（離れた 2 つの輪郭が角で触れる）', () => {
    const result = booleanContours([a, b], 'exclude')
    expect(contoursArea(result)).toBeCloseTo(15000, 6)
  })

  it('内側の形を引くと穴（2 つ目の輪郭）になる', () => {
    const result = booleanContours([a, rect(25, 25, 50, 50)], 'subtract')
    expect(result).toHaveLength(2)
    expect(contoursArea(result)).toBeCloseTo(7500, 6)
  })

  it('離れた形の交差は空', () => {
    expect(booleanContours([a, rect(200, 0, 10, 10)], 'intersect')).toEqual([])
  })

  it('辺がそろって触れる形の合体は、余計な頂点を残さない 1 つの矩形になる', () => {
    const result = booleanContours([rect(0, 0, 50, 100), rect(50, 0, 50, 100)], 'union')
    expect(result).toHaveLength(1)
    expect(result[0].vertices).toHaveLength(4)
    expect(contoursArea(result)).toBeCloseTo(10000, 6)
  })

  it('辺の一部が重なる形（T 字に触れる）も合体できる', () => {
    const result = booleanContours([rect(0, 0, 100, 100), rect(100, 25, 50, 50)], 'union')
    expect(result).toHaveLength(1)
    expect(result[0].vertices).toHaveLength(8)
    expect(contoursArea(result)).toBeCloseTo(12500, 6)
  })

  it('角だけで触れる形の合体は 2 つの輪にする', () => {
    const result = booleanContours([rect(0, 0, 10, 10), rect(10, 10, 10, 10)], 'union')
    expect(result).toHaveLength(2)
    for (const contour of result) expect(contour.vertices).toHaveLength(4)
  })

  it('同じ形どうし: 合体・交差はそのまま、差し引き・除外は空', () => {
    expect(contoursArea(booleanContours([a, a], 'union'))).toBeCloseTo(10000, 6)
    expect(contoursArea(booleanContours([a, a], 'intersect'))).toBeCloseTo(10000, 6)
    expect(booleanContours([a, a], 'subtract')).toEqual([])
    expect(booleanContours([a, a], 'exclude')).toEqual([])
  })

  it('3 つ以上の形にもかかる', () => {
    const c = rect(0, 120, 30, 30)
    expect(contoursArea(booleanContours([a, b, c], 'union'))).toBeCloseTo(17500 + 900 - 0, 6)
    expect(contoursArea(booleanContours([a, b, c], 'subtract'))).toBeCloseTo(7500, 6)
    expect(booleanContours([a, b, c], 'intersect')).toEqual([])
  })
})

describe('booleanContours（塗る範囲の決め方）', () => {
  it('evenodd の形は、重なった輪郭の偶奇で内側を決める', () => {
    const donut: BooleanShape = {
      contours: [
        { vertices: rectVertices(0, 0, 100, 100), closed: true },
        { vertices: rectVertices(25, 25, 50, 50), closed: true },
      ],
      fillRule: 'evenodd',
    }
    // 穴の中に置いた矩形との交差は空、合体は穴を埋める
    expect(booleanContours([donut, rect(40, 40, 20, 20)], 'intersect')).toEqual([])
    expect(contoursArea(booleanContours([donut, rect(40, 40, 20, 20)], 'union'))).toBeCloseTo(7500 + 400, 6)
  })

  it('nonzero の形は、同じ向きに重なった輪郭を合わせた範囲が内側', () => {
    const overlapping: BooleanShape = {
      contours: [
        { vertices: rectVertices(0, 0, 100, 100), closed: true },
        { vertices: rectVertices(50, 0, 100, 100), closed: true },
      ],
      fillRule: 'nonzero',
    }
    expect(contoursArea(booleanContours([overlapping], 'union'))).toBeCloseTo(15000, 6)
    // 同じ輪郭でも evenodd なら重なりが抜ける
    expect(contoursArea(booleanContours([{ ...overlapping, fillRule: 'evenodd' }], 'union'))).toBeCloseTo(10000, 6)
  })

  it('nonzero で逆向きの輪郭は穴になる', () => {
    const reversed: BooleanShape = {
      contours: [
        { vertices: rectVertices(0, 0, 100, 100), closed: true },
        { vertices: rectVertices(25, 25, 50, 50).reverse(), closed: true },
      ],
      fillRule: 'nonzero',
    }
    expect(contoursArea(booleanContours([reversed], 'union'))).toBeCloseTo(7500, 6)
  })
})

describe('booleanContours（自分と交わる輪郭）', () => {
  // 五芒星（1 本の輪郭が自分と交わる）。nonzero なら真ん中の五角形も塗り、evenodd なら抜く
  const star = Array.from({ length: 5 }, (_, i) => {
    const angle = -Math.PI / 2 + (i * 4 * Math.PI) / 5
    return { x: 100 * Math.cos(angle), y: 100 * Math.sin(angle) }
  })
  it('巻き数で決める nonzero と、偶奇の evenodd を数え分ける', () => {
    const nonzero = contoursArea(booleanContours([{ contours: [{ vertices: star, closed: true }], fillRule: 'nonzero' }], 'union'))
    const evenodd = contoursArea(booleanContours([{ contours: [{ vertices: star, closed: true }], fillRule: 'evenodd' }], 'union'))
    // 真ん中の五角形（内接円の半径 = 100 · cos72° / cos36°）の面積の分だけ違う
    const inner = 100 * Math.cos((2 * Math.PI) / 5) / Math.cos(Math.PI / 5)
    const pentagon = (5 / 2) * inner * inner * Math.sin((2 * Math.PI) / 5)
    expect(nonzero - evenodd).toBeCloseTo(pentagon, 6)
  })
})

describe('booleanContours（交点が密集する形・ほとんど重なる辺）', () => {
  // 交点が頂点をまとめるマス（1e-6px）より近く集まる形。結果を、元の形の巻き数・偶奇から求めた内外と、
  // 輪郭から離れた点で比べる（頂点のまとめ方を誤ると輪が閉じず、離れた所の内外まで食い違う）
  type Op = Parameters<typeof booleanContours>[1]
  const ops: Op[] = ['union', 'subtract', 'intersect', 'exclude']

  /** 決まった列を返す乱数（テストを毎回同じにする） */
  const random = (seed: number) => {
    let state = seed >>> 0
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 2 ** 32
    }
  }
  const polygon = (vertices: readonly Point[], fillRule: BooleanShape['fillRule'] = 'nonzero'): BooleanShape => ({
    contours: [{ vertices: vertices.map(({ x, y }) => ({ x, y })), closed: true }],
    fillRule,
  })
  /** 輪郭を細かい折れ線にする（曲線は 64 等分） */
  const polylines = (contours: readonly Contour[]) =>
    contours.map((contour) => {
      const points: Point[] = []
      for (const segment of pathSegments(contour.vertices, true)) {
        const n = segment.curved ? 64 : 1
        for (let k = 0; k < n; k++) points.push(segmentAt(segment, k / n))
      }
      return points
    })
  const winding = (points: readonly Point[], p: Point) => {
    let total = 0
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[j]
      const b = points[i]
      const side = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y)
      if (a.y <= p.y && b.y > p.y && side > 0) total++
      else if (a.y > p.y && b.y <= p.y && side < 0) total--
    }
    return total
  }
  const distanceToOutline = (lines: readonly Point[][], p: Point) => {
    let best = Infinity
    for (const points of lines) {
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[j]
        const b = points[i]
        const rx = b.x - a.x
        const ry = b.y - a.y
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * rx + (p.y - a.y) * ry) / (rx * rx + ry * ry || 1)))
        best = Math.min(best, Math.hypot(a.x + rx * t - p.x, a.y + ry * t - p.y))
      }
    }
    return best
  }
  const expected = (op: Op, sides: boolean[]) =>
    op === 'union'
      ? sides.some(Boolean)
      : op === 'intersect'
        ? sides.every(Boolean)
        : op === 'subtract'
          ? sides[0] && !sides.slice(1).some(Boolean)
          : sides.filter(Boolean).length % 2 === 1

  /** 輪郭から margin より離れた点で、結果の内外（evenodd）が元の形から求めた内外と合わない点の数 */
  function mismatches(shapes: readonly BooleanShape[], op: Op, scale: number, margin: number, seed = 1) {
    const inputs = shapes.map((shape) => polylines(shape.contours))
    const output = polylines(booleanContours(shapes, op))
    const next = random(seed)
    let wrong = 0
    for (let k = 0; k < 300; k++) {
      const p = { x: (next() * 2 - 1) * scale, y: (next() * 2 - 1) * scale }
      if (inputs.some((lines) => distanceToOutline(lines, p) < margin)) continue
      const sides = shapes.map((shape, s) => {
        const w = inputs[s].reduce((sum, points) => sum + winding(points, p), 0)
        return shape.fillRule === 'evenodd' ? w % 2 !== 0 : w !== 0
      })
      const inside = output.reduce((sum, points) => sum + winding(points, p), 0) % 2 !== 0
      if (inside !== expected(op, sides)) wrong++
    }
    return wrong
  }

  /** 中心のごく近く（jitter 以内）を通る直径を n 本、1 本の輪郭でつないだ形（自分と何度も交わる） */
  const sunburst = (next: () => number, n: number, jitter: number, r = 100) => {
    const points: Point[] = []
    for (let i = 0; i < n; i++) {
      const angle = (i * Math.PI * (2 * Math.floor(n / 2) + 1)) / n + next() * 0.01
      const ox = (next() - 0.5) * jitter
      const oy = (next() - 0.5) * jitter
      points.push({ x: ox + r * Math.cos(angle), y: oy + r * Math.sin(angle) })
      points.push({ x: ox - r * Math.cos(angle) * (0.5 + next()), y: oy - r * Math.sin(angle) * (0.5 + next()) })
    }
    return points
  }
  /** 中心 (dx, 0)、半辺 50 の正方形を angle だけ回したもの */
  const square = (angle: number, dx: number) =>
    [
      [-50, -50],
      [50, -50],
      [50, 50],
      [-50, 50],
    ].map(([x, y]) => ({ x: dx + x * Math.cos(angle) - y * Math.sin(angle), y: x * Math.sin(angle) + y * Math.cos(angle) }))

  it('中心の 1e-7px 以内に交点が集まる、自分と交わる輪郭（nonzero・evenodd）', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const next = random(seed)
      const fillRule = seed % 2 ? 'nonzero' : 'evenodd'
      const shapes = [polygon(sunburst(next, 5 + (seed % 9), 1e-7), fillRule)]
      if (seed % 3 === 0) shapes.push(polygon(sunburst(next, 3 + (seed % 4), 1e-7, 60)))
      for (const op of shapes.length > 1 ? ops : (['union'] as Op[])) {
        // 遠くの点と、交点の集まる中心のそば（1e-4px 四方）の点の両方で比べる
        expect(mismatches(shapes, op, 120, 0.1, seed)).toBe(0)
        expect(mismatches(shapes, op, 1e-4, 3e-6, seed)).toBe(0)
      }
    }
  })

  it('ほとんど重なる正方形（わずかに回してずらす）の演算が、輪の切れた形にならない', () => {
    // 3 本の辺がほとんど重なると、2 本ずつの交点が別々の所にでき、3 本目はそのそばを分けられずに通っていた
    for (const angle of [1e-7, 1e-8, 1e-9, 1e-10, 0]) {
      for (let seed = 1; seed <= 6; seed++) {
        const next = random(seed)
        const shapes = [polygon(square(0, 0)), polygon(square(angle * (next() - 0.5), (next() - 0.5) * 1e-6), seed % 2 ? 'nonzero' : 'evenodd')]
        if (seed % 3 !== 0) shapes.push(polygon(square(-angle, (next() - 0.5) * 1e-6)))
        expect(contoursArea(booleanContours(shapes, 'union'))).toBeCloseTo(10000, 3)
        expect(contoursArea(booleanContours(shapes, 'intersect'))).toBeCloseTo(10000, 3)
        expect(contoursArea(booleanContours(shapes, 'subtract'))).toBeCloseTo(0, 3)
        for (const op of ops) expect(mismatches(shapes, op, 60, 0.01, seed)).toBe(0)
      }
    }
  })

  it('ほとんど重なる円・楕円（1e-6px 未満ずらして複製した形）の合体・交差は、元の円と同じ面積', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const next = random(seed)
      const jitter = [1e-6, 3e-7, 1e-7, 1e-8][seed % 4]
      const ellipse = (): BooleanShape => ({
        contours: [{ vertices: ellipseVertices((next() - 0.5) * jitter, (next() - 0.5) * jitter, 50 + (next() - 0.5) * jitter, 50 + (next() - 0.5) * jitter), closed: true }],
        fillRule: next() < 0.5 ? 'nonzero' : 'evenodd',
      })
      const shapes = Array.from({ length: 2 + (seed % 2) }, ellipse)
      const area = Math.PI * 50 * 50
      // 円は 3 次ベジェの近似なので、面積は円の式から 0.03% ほど大きい
      expect(contoursArea(booleanContours(shapes, 'union')) / area).toBeCloseTo(1, 3)
      expect(contoursArea(booleanContours(shapes, 'intersect')) / area).toBeCloseTo(1, 3)
      for (const op of ops) expect(mismatches(shapes, op, 60, 0.05, seed)).toBe(0)
    }
  })

  it('頂点が 1e-6px より細かく並んで、自分と何度も交わるジグザグ', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const next = random(seed)
      const jitter = [1e-6, 3e-7, 1e-7][seed % 3]
      const points: Point[] = []
      const m = 20 + Math.floor(next() * 40)
      for (let i = 0; i <= m; i++) points.push({ x: (i / m) * 1e-5 * (next() < 0.3 ? -1 : 1) + (next() - 0.5) * jitter, y: (next() - 0.5) * jitter * 10 })
      points.push({ x: 1e-5, y: 50 }, { x: -50, y: 50 }, { x: -50, y: -50 }, { x: 0, y: -50 })
      for (let i = 0; i <= m; i++) points.push({ x: (next() - 0.5) * 2e-5, y: (next() - 0.5) * jitter * 10 })
      points.push({ x: 50, y: -50 }, { x: 50, y: 50 }, { x: 0, y: 40 })
      const shapes = [polygon(points, seed % 2 ? 'nonzero' : 'evenodd')]
      if (seed % 2 === 0) shapes.push(polygon(sunburst(next, 3 + (seed % 5), jitter, 30)))
      for (const op of shapes.length > 1 ? ops : (['union'] as Op[])) expect(mismatches(shapes, op, 60, 0.01, seed)).toBe(0)
    }
  })

  it('入力の頂点の位置は動かさない（頂点をまとめるマスの中心に寄せない）', () => {
    const result = booleanContours([rect(0.1234567, 0, 100, 100), rect(50.7654321, 50, 100, 100)], 'union')
    const xs = result[0].vertices.map((vertex) => vertex.x)
    expect(xs).toContain(0.1234567)
    expect(xs).toContain(150.7654321)
  })
})

describe('booleanContours（曲線の精度）', () => {
  const r = 100
  const left = circle(0, 0, r)
  const right = circle(120, 0, r)
  // 2 つの円の重なり（レンズ）の面積
  const d = 120
  const lens = 2 * r * r * Math.acos(d / (2 * r)) - (d / 2) * Math.sqrt(4 * r * r - d * d)

  it('曲線は折れ線でなく、元の曲線を交点で切った曲線のまま残る', () => {
    const result = booleanContours([left, right], 'union')
    expect(result).toHaveLength(1)
    // 円 2 つの 4 + 4 頂点のうち、相手の内側の頂点が消えて交点 2 つが増える程度
    expect(vertexCount(result)).toBeLessThanOrEqual(8)
    expect(result[0].vertices.every((vertex) => vertex.in && vertex.out)).toBe(true)
  })

  it('結果の曲線の上の点は、どちらかの円の上にある（ずれは FLATTEN_TOLERANCE の数倍以内）', () => {
    for (const op of ['union', 'intersect', 'subtract', 'exclude'] as const) {
      for (const p of samples(booleanContours([left, right], op))) {
        const toLeft = Math.abs(Math.hypot(p.x, p.y) - r)
        const toRight = Math.abs(Math.hypot(p.x - 120, p.y) - r)
        // 円そのものの 4 本のベジェ近似のずれ（半径の 0.03% ≒ 0.027px）を足した範囲
        expect(Math.min(toLeft, toRight)).toBeLessThan(0.03 + 3 * FLATTEN_TOLERANCE)
      }
    }
  })

  it('面積が式で求めた値と合い、合体・交差・差し引き・除外の面積の関係が保たれる', () => {
    const circleArea = contoursArea(left.contours)
    const intersect = contoursArea(booleanContours([left, right], 'intersect'))
    // 円そのものを 4 本のベジェで近似している分（面積で 0.1% 未満）だけ式とずれる
    expect(Math.abs(intersect - lens) / lens).toBeLessThan(0.001)
    // 交点の位置の誤差（FLATTEN_TOLERANCE 程度）の分だけずれてよい（面積の 0.01% 未満）
    const near = (value: number, expected: number) => expect(Math.abs(value - expected) / expected).toBeLessThan(1e-4)
    near(contoursArea(booleanContours([left, right], 'union')), 2 * circleArea - intersect)
    near(contoursArea(booleanContours([left, right], 'subtract')), circleArea - intersect)
    near(contoursArea(booleanContours([left, right], 'exclude')), 2 * circleArea - 2 * intersect)
  })

  it('交差（レンズ）は交点 2 つと、元の円の頂点 2 つの曲線だけ', () => {
    const [lensContour] = booleanContours([left, right], 'intersect')
    expect(lensContour.vertices).toHaveLength(4)
    const crossings = lensContour.vertices.filter((vertex) => Math.abs(vertex.x - 60) < 0.05)
    expect(crossings).toHaveLength(2)
    for (const vertex of crossings) expect(Math.abs(vertex.y)).toBeCloseTo(80, 1)
    expect(lensContour.vertices.every((vertex) => vertex.in && vertex.out)).toBe(true)
  })

  it('円から矩形を引くと、曲線と直線の混ざった輪郭になる', () => {
    const result = booleanContours([left, rect(0, -200, 200, 400)], 'subtract')
    expect(result).toHaveLength(1)
    expect(contoursArea(result)).toBeCloseTo(contoursArea(left.contours) / 2, 0)
    expect(result[0].vertices).toHaveLength(3)
  })
})

describe('flattenParams / subSegment', () => {
  it('直線は分けない。曲線は大きいほど細かく分ける', () => {
    const line = pathSegments([{ x: 0, y: 0 }, { x: 100, y: 0 }], false)[0]
    expect(flattenParams(line)).toEqual([0, 1])
    const small = pathSegments(ellipseVertices(0, 0, 10, 10), true)[0]
    const large = pathSegments(ellipseVertices(0, 0, 1000, 1000), true)[0]
    expect(flattenParams(large).length).toBeGreaterThan(flattenParams(small).length)
  })

  it('折れ線のずれは FLATTEN_TOLERANCE 以内', () => {
    const segment = pathSegments(ellipseVertices(0, 0, 500, 500), true)[0]
    const ts = flattenParams(segment)
    for (let k = 0; k < ts.length - 1; k++) {
      const a = segmentAt(segment, ts[k])
      const b = segmentAt(segment, ts[k + 1])
      const mid = segmentAt(segment, (ts[k] + ts[k + 1]) / 2)
      const length = Math.hypot(b.x - a.x, b.y - a.y)
      const distance = Math.abs((b.x - a.x) * (a.y - mid.y) - (a.x - mid.x) * (b.y - a.y)) / length
      expect(distance).toBeLessThanOrEqual(FLATTEN_TOLERANCE)
    }
  })

  it('subSegment は元の曲線の一部を同じ形で切り出し、逆向きにもできる', () => {
    const segment = pathSegments(ellipseVertices(0, 0, 100, 100), true)[0]
    const part = subSegment(segment, 0.2, 0.7)
    for (const t of [0, 0.3, 0.6, 1]) {
      const p = segmentAt(part, t)
      const q = segmentAt(segment, 0.2 + 0.5 * t)
      expect(p.x).toBeCloseTo(q.x, 9)
      expect(p.y).toBeCloseTo(q.y, 9)
    }
    const back = subSegment(segment, 0.7, 0.2)
    expect(back.from.x).toBeCloseTo(part.to.x, 9)
    expect(back.to.y).toBeCloseTo(part.from.y, 9)
  })
})
