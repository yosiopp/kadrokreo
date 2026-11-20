import { describe, expect, it } from 'vitest'
import { measureBetween } from './distances.ts'

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })

describe('measureBetween', () => {
  it('横に離れていれば、向かい合う辺の間隔を、選んでいる側の中心の高さで測る', () => {
    const result = measureBetween(box(0, 0, 100, 40), box(130, 0, 50, 40))
    expect(result).toEqual([{ from: { x: 100, y: 20 }, to: { x: 130, y: 20 }, distance: 30, guide: null }])
    // 相手が左にあっても同じ
    expect(measureBetween(box(130, 0, 50, 40), box(0, 0, 100, 40))).toEqual([
      { from: { x: 100, y: 20 }, to: { x: 130, y: 20 }, distance: 30, guide: null },
    ])
  })

  it('縦に離れていれば、縦の間隔を測る', () => {
    const result = measureBetween(box(0, 0, 100, 40), box(0, 100, 100, 40))
    expect(result).toEqual([{ from: { x: 50, y: 40 }, to: { x: 50, y: 100 }, distance: 60, guide: null }])
  })

  it('斜め向かいにあれば縦横の両方を測り、相手の辺まで補助線を引く', () => {
    const result = measureBetween(box(0, 0, 100, 40), box(150, 100, 50, 50))
    expect(result).toEqual([
      {
        from: { x: 100, y: 20 },
        to: { x: 150, y: 20 },
        distance: 50,
        guide: { from: { x: 150, y: 20 }, to: { x: 150, y: 100 } },
      },
      {
        from: { x: 50, y: 40 },
        to: { x: 50, y: 100 },
        distance: 60,
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
