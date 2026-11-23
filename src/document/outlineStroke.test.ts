import { describe, expect, it } from 'vitest'
import { strokeOutline } from './outlineStroke.ts'
import { contoursArea } from './pathBoolean.ts'
import { pathBounds } from './path.ts'
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

  it('楕円の線は輪の形になる', () => {
    const contours = strokeOutline(ellipse({ width: 100, height: 100, strokes: stroke, strokeWidth: 10 }))
    expect(contours).toHaveLength(2)
    expect(contoursArea(contours)).toBeCloseTo(Math.PI * (55 * 55 - 45 * 45), -1)
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
