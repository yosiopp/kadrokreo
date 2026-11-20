import { describe, expect, it } from 'vitest'
import { handlePoint, resizeBounds } from './resize.ts'

const start = { x: 10, y: 20, width: 100, height: 50 }

describe('resizeBounds', () => {
  it('引いたハンドルの側の辺だけが動く', () => {
    expect(resizeBounds(start, 'se', 30, 10)).toEqual({ x: 10, y: 20, width: 130, height: 60 })
    expect(resizeBounds(start, 'nw', 30, 10)).toEqual({ x: 40, y: 30, width: 70, height: 40 })
    expect(resizeBounds(start, 'e', 30, 999)).toEqual({ x: 10, y: 20, width: 130, height: 50 })
    expect(resizeBounds(start, 'n', 999, -10)).toEqual({ x: 10, y: 10, width: 100, height: 60 })
  })

  it('反対側の辺を越えると裏返る', () => {
    expect(resizeBounds(start, 'e', -150, 0)).toEqual({ x: -40, y: 20, width: 50, height: 50 })
  })

  it('大きさは 1 未満にならない', () => {
    expect(resizeBounds(start, 'e', -100, 0).width).toBe(1)
  })

  it('縦横比を保つ', () => {
    expect(resizeBounds(start, 'se', 100, 0, true)).toEqual({ x: 10, y: 20, width: 200, height: 100 })
    expect(resizeBounds(start, 'nw', -100, 0, true)).toEqual({ x: -90, y: -30, width: 200, height: 100 })
    // 辺のハンドルでは効かない
    expect(resizeBounds(start, 'e', 100, 0, true)).toEqual({ x: 10, y: 20, width: 200, height: 50 })
  })
})

describe('handlePoint', () => {
  it('角と辺の中点を返す', () => {
    expect(handlePoint(start, 'nw')).toEqual({ x: 10, y: 20 })
    expect(handlePoint(start, 'se')).toEqual({ x: 110, y: 70 })
    expect(handlePoint(start, 'n')).toEqual({ x: 60, y: 20 })
    expect(handlePoint(start, 'w')).toEqual({ x: 10, y: 45 })
  })
})
