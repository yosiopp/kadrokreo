import { describe, expect, it } from 'vitest'
import { RULER_SIZE, rulerAt, rulerLabel, rulerStep, rulerTicks } from './rulers.ts'

describe('ルーラー', () => {
  it('目盛りの間隔は、画面で 60px 以上になる 1・2・5 × 10 の累乗', () => {
    expect(rulerStep(1)).toBe(100)
    expect(rulerStep(2)).toBe(50)
    expect(rulerStep(0.5)).toBe(200)
    expect(rulerStep(0.1)).toBe(1000)
    expect(rulerStep(10)).toBe(10)
    expect(rulerStep(64)).toBe(1)
    expect(rulerStep(1.2)).toBe(50)
  })

  it('範囲に入る間隔の倍数を並べる（負の座標も）', () => {
    expect(rulerTicks(-130, 120, 100)).toEqual([-100, 0, 100])
    expect(rulerTicks(0, 0, 10)).toEqual([0])
  })

  it('数字は間隔に合わせた桁で丸め、-0 を出さない', () => {
    expect(rulerLabel(300, 100)).toBe('300')
    expect(rulerLabel(0.30000000000000004, 0.1)).toBe('0.3')
    expect(rulerLabel(-0.0000001, 1)).toBe('0')
  })

  it('帯の上かどうか（角は上のルーラー）', () => {
    expect(rulerAt({ x: 5, y: 5 })).toBe('top')
    expect(rulerAt({ x: 200, y: RULER_SIZE - 1 })).toBe('top')
    expect(rulerAt({ x: 5, y: 200 })).toBe('left')
    expect(rulerAt({ x: RULER_SIZE, y: RULER_SIZE })).toBeNull()
  })
})
