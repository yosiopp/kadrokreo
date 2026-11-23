import { describe, expect, it } from 'vitest'
import { strokeOutline } from './outlineStroke.ts'
import { contoursArea } from './pathBoolean.ts'
import { flattenPath, pathBounds } from './path.ts'
import { ellipse, path, rect } from './testNodes.ts'

const stroke = [{ type: 'solid' as const, color: '#000000', opacity: 1, visible: true, blendMode: 'normal' as const }]

describe('strokeOutline', () => {
  it('矩形の線は、太さの半分だけ内外に広がった枠になる（角はマイター）', () => {
    const contours = strokeOutline(rect({ width: 100, height: 50, strokes: stroke, strokeWidth: 10 }))
    expect(contours).toHaveLength(2)
    // 外 110×60 − 内 90×40
    expect(contoursArea(contours)).toBeCloseTo(110 * 60 - 90 * 40, 0)
    const outer = pathBounds(contours[0].vertices, true)
    expect(outer.width).toBeCloseTo(110, 1)
  })

  it('開いた直線は、端を切りっぱなしの長方形になる。四角の端は太さの半分だけ伸びる', () => {
    const line = path({ x: 0, y: 0, width: 100, height: 0, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], strokeWidth: 4 })
    expect(contoursArea(strokeOutline(line))).toBeCloseTo(400, 1)
    expect(contoursArea(strokeOutline({ ...line, startCap: 'square', endCap: 'square' }))).toBeCloseTo(416, 1)
  })

  it('楕円の線は輪の形になり、曲線に戻る（頂点が少ない）', () => {
    const contours = strokeOutline(ellipse({ width: 100, height: 100, strokes: stroke, strokeWidth: 10 }))
    expect(contours).toHaveLength(2)
    expect(Math.abs(contoursArea(contours) - Math.PI * (55 * 55 - 45 * 45))).toBeLessThan(10)
    // 外の輪は半径 55、内の輪は 45 の円に 0.1px 以内で沿う
    const radii = contours.map((contour) => flattenPath(contour.vertices, true).map((p) => Math.hypot(p.x - 50, p.y - 50)))
    const [outer, inner] = Math.max(...radii[0]) > Math.max(...radii[1]) ? radii : radii.toReversed()
    for (const r of outer) expect(Math.abs(r - 55)).toBeLessThan(0.1)
    for (const r of inner) expect(Math.abs(r - 45)).toBeLessThan(0.1)
    for (const contour of contours) {
      expect(contour.vertices.length).toBeLessThanOrEqual(8)
      expect(contour.vertices.every((v) => v.in && v.out)).toBe(true)
    }
  })

  it('直線の辺は直線のまま、角は角のまま残る', () => {
    const contours = strokeOutline(rect({ width: 100, height: 50, strokes: stroke, strokeWidth: 10 }))
    expect(contours.map((contour) => contour.vertices.length)).toEqual([4, 4])
    expect(contours.every((contour) => contour.vertices.every((v) => !v.in && !v.out))).toBe(true)
    // 丸い角は、直線 4 本と曲線のつながり（外の輪）。内の角はとがったまま
    const round = strokeOutline(rect({ width: 100, height: 50, strokes: stroke, strokeWidth: 10, strokeJoin: 'round' }))
    expect(round.map((contour) => contour.vertices.length).toSorted()).toEqual([4, 8])
  })

  it('両端が丸い破線は、破線の 1 本ごとの両端も丸くなる。両端が違えば切りっぱなし', () => {
    const line = path({ width: 100, height: 0, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], strokeWidth: 4, strokeDashes: [10, 10] })
    const round = strokeOutline({ ...line, startCap: 'round', endCap: 'round' })
    expect(round).toHaveLength(5)
    // 1 本 = 10 × 4 の長方形と、両端の半円 2 つ（半径 2）
    expect(contoursArea(round)).toBeCloseTo(5 * (40 + Math.PI * 4), 0)
    // 曲線に戻すときのずれ（片側 0.05px まで）を見込む
    expect(Math.abs(pathBounds(round[1].vertices, true).width - 14)).toBeLessThan(0.15)
    const square = strokeOutline({ ...line, startCap: 'square', endCap: 'square' })
    expect(contoursArea(square)).toBeCloseTo(5 * (14 * 4), 1)
    // 丸と矢印のように両端が違えば、切れ目は切りっぱなし（線の両端にだけ形が付く）
    const mixed = strokeOutline({ ...line, startCap: 'round', endCap: 'none' })
    expect(pathBounds(mixed[1].vertices, true).width).toBeCloseTo(10, 1)
  })

  it('破線は線の部分だけになる', () => {
    const line = path({ width: 100, height: 0, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], strokeWidth: 2, strokeDashes: [10, 10] })
    const contours = strokeOutline(line)
    expect(contours).toHaveLength(5)
    expect(contoursArea(contours)).toBeCloseTo(100, 1)
  })

  it('破線のずれだけ並びを進めて始める（負なら戻す）', () => {
    const line = path({ width: 100, height: 0, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], strokeWidth: 2, strokeDashes: [10, 10] })
    // 5 進めると、最初の線は 5 だけ。線は 5 + 10 × 4 + 5（最後の空き 10 のうち 5）…で 5 本と端の 5
    const shifted = strokeOutline({ ...line, strokeDashOffset: 5 })
    expect(contoursArea(shifted)).toBeCloseTo(100, 1)
    expect(pathBounds(shifted[0].vertices, true).x).toBeCloseTo(0, 5)
    expect(shifted).toHaveLength(6)
    // 10 進めると、空きから始まる
    const gap = strokeOutline({ ...line, strokeDashOffset: 10 })
    expect(Math.min(...gap.map((c) => pathBounds(c.vertices, true).x))).toBeCloseTo(10, 5)
    // -10 は 1 周（20）足した 10 と同じ
    expect(contoursArea(strokeOutline({ ...line, strokeDashOffset: -10 }))).toBeCloseTo(contoursArea(gap), 5)
  })

  it('角の形: 丸は角が丸く、切り落とすは角がマイターより小さい', () => {
    const square = (strokeJoin: 'miter' | 'round' | 'bevel') => contoursArea(strokeOutline(rect({ width: 100, height: 50, strokes: stroke, strokeWidth: 10, strokeJoin })))
    const miter = square('miter')
    // 4 隅で、5×5 の正方形から 1/4 円・直角三角形を引いた分だけ小さい
    expect(Math.abs(square('round') - (miter - 4 * (25 - (Math.PI * 25) / 4)))).toBeLessThan(3)
    expect(square('bevel')).toBeCloseTo(miter - 4 * 12.5, 0)
  })

  it('鋭い角はベベルになる（マイターが長すぎる）', () => {
    const v = path({ width: 100, height: 10, points: [{ x: 0, y: 0 }, { x: 1, y: 0.5 }, { x: 0, y: 1 }], strokeWidth: 2 })
    const box = strokeOutline(v).map((c) => pathBounds(c.vertices, true))
    expect(box[0].x + box[0].width).toBeLessThan(103)
  })

  it('線の太さが 0 なら空', () => {
    expect(strokeOutline(rect({ strokeWidth: 0 }))).toEqual([])
  })
})
