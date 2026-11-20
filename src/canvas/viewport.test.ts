import { describe, expect, it } from 'vitest'
import { MAX_ZOOM, MIN_ZOOM, fitBounds, panBy, screenToWorld, worldToScreen, zoomAt } from './viewport.ts'

describe('viewport', () => {
  const viewport = { x: 100, y: -50, zoom: 2 }

  it('画面座標とページ座標を相互に変換する', () => {
    expect(screenToWorld(viewport, { x: 40, y: 20 })).toEqual({ x: 120, y: -40 })
    expect(worldToScreen(viewport, { x: 120, y: -40 })).toEqual({ x: 40, y: 20 })
  })

  it('パンは画面上の移動量ぶんだけ中身を動かす', () => {
    const next = panBy(viewport, 30, -10)
    expect(worldToScreen(next, { x: 120, y: -40 })).toEqual({ x: 70, y: 10 })
  })

  it('ズームしても基準点に映っている場所は動かない', () => {
    const anchor = { x: 300, y: 200 }
    const before = screenToWorld(viewport, anchor)
    const next = zoomAt(viewport, anchor, 5)
    expect(next.zoom).toBe(5)
    expect(screenToWorld(next, anchor).x).toBeCloseTo(before.x)
    expect(screenToWorld(next, anchor).y).toBeCloseTo(before.y)
  })

  it('ズーム倍率を範囲内に収める', () => {
    expect(zoomAt(viewport, { x: 0, y: 0 }, 1000).zoom).toBe(MAX_ZOOM)
    expect(zoomAt(viewport, { x: 0, y: 0 }, 0).zoom).toBe(MIN_ZOOM)
  })

  it('全体表示は中身を中央に置き、等倍を超えて拡大しない', () => {
    const view = { width: 1000, height: 600 }
    const large = fitBounds({ x: 0, y: 0, width: 4000, height: 1000 }, view, 50)
    expect(large.zoom).toBeCloseTo(900 / 4000)
    expect(worldToScreen(large, { x: 2000, y: 500 })).toEqual({ x: 500, y: 300 })

    const small = fitBounds({ x: 10, y: 10, width: 20, height: 20 }, view)
    expect(small.zoom).toBe(1)
    expect(worldToScreen(small, { x: 20, y: 20 })).toEqual({ x: 500, y: 300 })
  })
})
