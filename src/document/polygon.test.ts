import { describe, expect, it } from 'vitest'
import { POLYGON_MAX_COUNT, polygonSize, regularPolygon, star } from './polygon.ts'

describe('regularPolygon', () => {
  it('三角形は真上の頂点から時計回りで、枠いっぱいに広がる', () => {
    const { points, aspect } = regularPolygon(3)
    expect(points).toEqual([{ x: 0.5, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }])
    // 正三角形の幅 / 高さ = √3 / 1.5
    expect(aspect).toBeCloseTo(Math.sqrt(3) / 1.5, 10)
  })

  it('正方形（4 角形）はひし形の向きで、縦横比は 1', () => {
    const { points, aspect } = regularPolygon(4)
    expect(points).toEqual([{ x: 0.5, y: 0 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }, { x: 0, y: 0.5 }])
    expect(aspect).toBe(1)
  })

  it('正六角形は辺の長さがすべて同じ（縦横比を aspect に合わせた枠で）', () => {
    const { points, aspect } = regularPolygon(6)
    expect(points).toHaveLength(6)
    const scaled = points.map((p) => ({ x: p.x * aspect, y: p.y }))
    const sides = scaled.map((p, i) => Math.hypot(scaled[(i + 1) % 6].x - p.x, scaled[(i + 1) % 6].y - p.y))
    for (const side of sides) expect(side).toBeCloseTo(sides[0], 6)
  })

  it('頂点の数は 3〜100 の整数', () => {
    expect(() => regularPolygon(2)).toThrow(RangeError)
    expect(() => regularPolygon(POLYGON_MAX_COUNT + 1)).toThrow(RangeError)
    expect(() => regularPolygon(4.5)).toThrow(RangeError)
    expect(regularPolygon(POLYGON_MAX_COUNT).points).toHaveLength(POLYGON_MAX_COUNT)
  })
})

describe('star', () => {
  it('先と内側の頂点が交互に並び、内側は比の半径にある', () => {
    const { points, aspect } = star(5, 0.5)
    expect(points).toHaveLength(10)
    expect(points[0]).toEqual({ x: 0.5, y: 0 })
    // 先の円の中心からの距離（高さを 1 にして、横は縦横比を戻して）を比べる。
    // 先の円の半径を 1 とすると、枠の高さは 1 + cos 36°（下の 2 つの先まで）なので、中心は上から 1 / (1 + cos 36°)
    const center = { x: 0.5 * aspect, y: 1 / (1 + Math.cos(Math.PI / 5)) }
    const radius = (p: { x: number; y: number }) => Math.hypot(p.x * aspect - center.x, p.y - center.y)
    const outer = radius(points[0])
    for (let i = 0; i < 10; i++) expect(radius(points[i]) / outer).toBeCloseTo(i % 2 === 0 ? 1 : 0.5, 6)
  })

  it('比は 0 より大きく 1 未満', () => {
    expect(() => star(5, 0)).toThrow(RangeError)
    expect(() => star(5, 1)).toThrow(RangeError)
    expect(() => star(5, Number.NaN)).toThrow(RangeError)
    expect(star(5).points).toHaveLength(10)
  })
})

describe('polygonSize', () => {
  it('省いた側を縦横比から決める', () => {
    expect(polygonSize(2, 100, 30)).toEqual({ width: 100, height: 30 })
    expect(polygonSize(2, 100)).toEqual({ width: 100, height: 50 })
    expect(polygonSize(2, undefined, 40)).toEqual({ width: 80, height: 40 })
    expect(polygonSize(Math.sqrt(3) / 1.5)).toEqual({ width: 100, height: 86.6 })
  })
})
