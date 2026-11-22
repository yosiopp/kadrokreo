import { describe, expect, it } from 'vitest'
import { labelEdge } from './labels.ts'

describe('labelEdge', () => {
  it('回していなければ上の辺と下の辺をそのまま左から右へ', () => {
    expect(labelEdge(100, 50, 0, 'top')).toEqual({ from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, angle: 0 })
    expect(labelEdge(100, 50, 0, 'bottom')).toEqual({ from: { x: 0, y: 50 }, to: { x: 100, y: 50 }, angle: 0 })
  })

  it('少し回せば、その向きに傾けて同じ辺に沿わせる', () => {
    expect(labelEdge(100, 50, 30, 'top')).toEqual({ from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, angle: 30 })
    expect(labelEdge(100, 50, -30, 'bottom').angle).toBe(-30)
  })

  it('90° 回すと、画面で上に来た左の辺に沿わせる（逆さにしない）', () => {
    expect(labelEdge(100, 50, 90, 'top')).toEqual({ from: { x: 0, y: 50 }, to: { x: 0, y: 0 }, angle: 0 })
    expect(labelEdge(100, 50, 90, 'bottom')).toEqual({ from: { x: 100, y: 50 }, to: { x: 100, y: 0 }, angle: 0 })
  })

  it('180° 回すと、もとの下の辺が上になる', () => {
    expect(labelEdge(100, 50, 180, 'top')).toEqual({ from: { x: 100, y: 50 }, to: { x: 0, y: 50 }, angle: 0 })
    expect(labelEdge(100, 50, 135, 'top').angle).toBe(45)
  })
})
