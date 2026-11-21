import { describe, expect, it } from 'vitest'
import { rotateVector } from '../document/geometry.ts'
import { measureBetween, measureCorners } from './distances.ts'

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })

describe('measureBetween', () => {
  it('横に離れていれば、向かい合う辺の間隔を、選んでいる側の中心の高さで測る', () => {
    const result = measureBetween(box(0, 0, 100, 40), box(130, 0, 50, 40))
    expect(result).toEqual([{ from: { x: 100, y: 20 }, to: { x: 130, y: 20 }, distance: 30, axis: 'x', guide: null }])
    // 相手が左にあっても同じ
    expect(measureBetween(box(130, 0, 50, 40), box(0, 0, 100, 40))).toEqual([
      { from: { x: 100, y: 20 }, to: { x: 130, y: 20 }, distance: 30, axis: 'x', guide: null },
    ])
  })

  it('縦に離れていれば、縦の間隔を測る', () => {
    const result = measureBetween(box(0, 0, 100, 40), box(0, 100, 100, 40))
    expect(result).toEqual([{ from: { x: 50, y: 40 }, to: { x: 50, y: 100 }, distance: 60, axis: 'y', guide: null }])
  })

  it('斜め向かいにあれば縦横の両方を測り、相手の辺まで補助線を引く', () => {
    const result = measureBetween(box(0, 0, 100, 40), box(150, 100, 50, 50))
    expect(result).toEqual([
      {
        from: { x: 100, y: 20 },
        to: { x: 150, y: 20 },
        distance: 50,
        axis: 'x',
        guide: { from: { x: 150, y: 20 }, to: { x: 150, y: 100 } },
      },
      {
        from: { x: 50, y: 40 },
        to: { x: 50, y: 100 },
        distance: 60,
        axis: 'y',
        guide: { from: { x: 50, y: 100 }, to: { x: 150, y: 100 } },
      },
    ])
  })

  it('相手に含まれていれば、4 辺それぞれまでの余白を測る', () => {
    const result = measureBetween(box(20, 10, 60, 30), box(0, 0, 200, 100))
    expect(result.map((item) => item.distance)).toEqual([20, 120, 10, 60])
    expect(result.every((item) => item.guide === null)).toBe(true)
    expect(result[1]).toMatchObject({ from: { x: 80, y: 25 }, to: { x: 200, y: 25 } })
  })

  it('一方の向きに離れていれば、重なっている向きの辺のずれは出さず、離れている向きの間隔だけ', () => {
    // 上下に並んでいて、左右は一部だけ重なる
    expect(measureBetween(box(0, 0, 100, 40), box(30, 100, 100, 40))).toEqual([
      { from: { x: 65, y: 40 }, to: { x: 65, y: 100 }, distance: 60, axis: 'y', guide: null },
    ])
    // 左右に並んでいて、相手のほうが縦に長い
    expect(measureBetween(box(0, 20, 50, 20), box(80, 0, 50, 100)).map((item) => item.axis)).toEqual(['x'])
  })

  it('線は 2 つが重なっている範囲の中央を通り、補助線は要らない', () => {
    // a の中心の高さ（20）は相手の外だが、重なっている 30〜40 の中央を通す
    const [only] = measureBetween(box(0, 0, 100, 40), box(150, 30, 50, 50))
    expect(only).toEqual({ from: { x: 100, y: 35 }, to: { x: 150, y: 35 }, distance: 50, axis: 'x', guide: null })
  })

  it('相手を含んでいれば、相手の中を通って 4 辺までの余白を測る', () => {
    const result = measureBetween(box(0, 0, 200, 100), box(20, 10, 60, 30))
    expect(result.map((item) => item.distance)).toEqual([20, 120, 10, 60])
    expect(result[0]).toMatchObject({ from: { x: 0, y: 25 }, to: { x: 20, y: 25 }, guide: null })
    expect(result[2]).toMatchObject({ from: { x: 50, y: 0 }, to: { x: 50, y: 10 }, guide: null })
  })

  it('一部だけ重なっていれば、縦横とも同じ側の辺どうしを、重なりの中を通して測る', () => {
    const result = measureBetween(box(0, 0, 100, 100), box(60, 40, 100, 100))
    expect(result.map((item) => [item.axis, item.distance])).toEqual([
      ['x', 60],
      ['x', 60],
      ['y', 40],
      ['y', 40],
    ])
    expect(result[0].from.y).toBe(70)
    expect(result[2].from.x).toBe(80)
  })

  it('接していれば（間隔 0）、重なっている向きの辺のずれを出す', () => {
    expect(measureBetween(box(0, 0, 60, 40), box(0, 40, 100, 40)).map((item) => item.distance)).toEqual([40])
  })

  it('辺が揃っている向きや、接している向きには線を出さない', () => {
    expect(measureBetween(box(0, 0, 100, 40), box(0, 0, 100, 40))).toEqual([])
    expect(measureBetween(box(0, 0, 100, 40), box(100, 0, 50, 40))).toEqual([])
    // 左の辺は揃っていて、右だけ余っている
    expect(measureBetween(box(0, 0, 60, 40), box(0, 0, 100, 40)).map((item) => item.distance)).toEqual([40])
  })

  it('端数は小数 2 桁に丸める', () => {
    const [only] = measureBetween(box(0, 0, 0.1, 10), box(0.3, 0, 10, 10))
    expect(only.distance).toBe(0.2)
  })
})

/** 中心 (cx, cy)、大きさ w × h の矩形を、中心のまわりに degrees 回した四隅 */
function corners(cx: number, cy: number, w: number, h: number, degrees: number) {
  return [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ].map((p) => {
    const r = rotateVector(p, degrees)
    return { x: cx + r.x, y: cy + r.y }
  })
}

describe('measureCorners', () => {
  it('回っていない 2 つは、measureBetween と同じ', () => {
    const result = measureCorners(corners(50, 20, 100, 40, 0), corners(155, 20, 50, 40, 0))
    expect(result).toEqual({
      angle: 0,
      distances: [{ from: { x: 100, y: 20 }, to: { x: 130, y: 20 }, distance: 30, axis: 'x', guide: null }],
      outlines: [],
    })
  })

  it('同じ向きに回った 2 つは、その向きの辺に沿って測る', () => {
    // 回す前は横に 30 離れた 2 つを、全体ごと 30° 回す
    const pivot = { x: 0, y: 0 }
    const at = (x: number, y: number) => rotateVector({ x: x - pivot.x, y: y - pivot.y }, 30)
    const ca = at(50, 20)
    const cb = at(155, 20)
    const result = measureCorners(corners(ca.x, ca.y, 100, 40, 30), corners(cb.x, cb.y, 50, 40, 30))
    expect(result.angle).toBe(30)
    expect(result.outlines).toEqual([])
    expect(result.distances).toHaveLength(1)
    const [only] = result.distances
    expect(only.distance).toBe(30)
    expect(only.axis).toBe('x')
    // 線は 30° 傾いている
    const slope = Math.atan2(only.to.y - only.from.y, only.to.x - only.from.x) * (180 / Math.PI)
    expect(slope).toBeCloseTo(30, 1)
  })

  it('90° の倍数だけ違う向きは同じ向きとみなす', () => {
    const result = measureCorners(corners(0, 0, 100, 40, 20), corners(0, 0, 40, 100, 110))
    expect(result.angle).toBe(20)
    // 同じ形を 90° 回しただけなので、辺は揃っていて間隔はない
    expect(result.distances).toEqual([])
  })

  it('向きが違えば、囲む矩形どうしを測り、回っている側の囲む矩形を返す', () => {
    // 45° 回した 100 × 100 の正方形は、囲む矩形が約 141.42 四方
    const result = measureCorners(corners(0, 0, 100, 100, 45), corners(200, 0, 50, 50, 0))
    expect(result.angle).toBe(0)
    // 横に離れているので、縦（重なっている向き）の線は出さない
    expect(result.distances.map((item) => item.distance)).toEqual([104.29])
    expect(result.outlines).toHaveLength(1)
    expect(result.outlines[0][0]).toEqual({ x: -70.71, y: -70.71 })
  })

  it('両方回っていて向きが違えば、両方の囲む矩形を返す', () => {
    const result = measureCorners(corners(0, 0, 100, 40, 10), corners(300, 0, 100, 40, 50))
    expect(result.angle).toBe(0)
    expect(result.outlines).toHaveLength(2)
  })

  it('幅のない図形（縦の直線）でも向きが分かる', () => {
    const line = corners(0, 0, 0, 100, 30)
    const result = measureCorners(line, corners(100, 0, 40, 40, 30))
    expect(result.angle).toBe(30)
  })
})
