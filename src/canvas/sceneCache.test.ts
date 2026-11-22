import { describe, expect, it } from 'vitest'
import { exposedRegions, panShift } from './sceneCache.ts'

describe('panShift', () => {
  const canvas = { width: 2000, height: 1000 }
  it('倍率が同じで、ずれが実ピクセルの整数なら、ずらす量を返す', () => {
    expect(panShift({ x: 0, y: 0, zoom: 0.3 }, { x: -40 / 0.3, y: 20 / 0.3, zoom: 0.3 }, 2, canvas)).toEqual({ x: 80, y: -40 })
  })
  it('倍率が違う・半端なずれ・画面より大きいずれは使い回さない', () => {
    expect(panShift({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0, zoom: 2 }, 2, canvas)).toBeNull()
    expect(panShift({ x: 0, y: 0, zoom: 1 }, { x: 0.25, y: 0, zoom: 1 }, 1, canvas)).toBeNull()
    expect(panShift({ x: 0, y: 0, zoom: 1 }, { x: 2000, y: 0, zoom: 1 }, 1, canvas)).toBeNull()
  })
})

describe('exposedRegions', () => {
  const size = { width: 100, height: 50 }
  it('右下へずらすと、左と上の帯が見える', () => {
    expect(exposedRegions(10, 5, size)).toEqual([
      { x: 0, y: 0, width: 10, height: 50 },
      { x: 10, y: 0, width: 90, height: 5 },
    ])
  })
  it('左上へずらすと、右と下の帯が見える', () => {
    expect(exposedRegions(-10, -5, size)).toEqual([
      { x: 90, y: 0, width: 10, height: 50 },
      { x: 0, y: 45, width: 90, height: 5 },
    ])
  })
  it('縦だけ・横だけ', () => {
    expect(exposedRegions(0, 5, size)).toEqual([{ x: 0, y: 0, width: 100, height: 5 }])
    expect(exposedRegions(-3, 0, size)).toEqual([{ x: 97, y: 0, width: 3, height: 50 }])
  })
})
