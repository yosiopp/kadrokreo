import { describe, expect, it } from 'vitest'
import { addGuide, clearGuides, guideAt, guideSnapLines, moveGuide, removeGuide } from './guides.ts'
import { createPage } from './document.ts'

describe('ガイド線の操作', () => {
  const page = addGuide(addGuide(createPage(), { axis: 'x', position: 100 }), { axis: 'y', position: 50 })

  it('足す・動かす・消す・全部消す。変化がなければ同じ参照', () => {
    expect(page.guides).toEqual([{ axis: 'x', position: 100 }, { axis: 'y', position: 50 }])
    expect(moveGuide(page, 0, 120).guides[0]).toEqual({ axis: 'x', position: 120 })
    expect(moveGuide(page, 0, 100)).toBe(page)
    expect(moveGuide(page, 5, 1)).toBe(page)
    expect(removeGuide(page, 0).guides).toEqual([{ axis: 'y', position: 50 }])
    expect(removeGuide(page, 9)).toBe(page)
    expect(clearGuides(page).guides).toEqual([])
    const empty = createPage()
    expect(clearGuides(empty)).toBe(empty)
  })

  it('画面の位置から近いガイド線を探す（ズーム・パンを考える）', () => {
    const viewport = { x: 0, y: 0, zoom: 2 }
    expect(guideAt(page, viewport, { x: 201, y: 500 }, 3)).toBe(0)
    expect(guideAt(page, viewport, { x: 500, y: 98 }, 3)).toBe(1)
    expect(guideAt(page, viewport, { x: 210, y: 500 }, 3)).toBeNull()
    expect(guideAt(page, { x: 50, y: 0, zoom: 1 }, { x: 50, y: 500 }, 3)).toBe(0)
  })

  it('吸着の相手は端の無い線', () => {
    expect(guideSnapLines(page)[0]).toEqual({ axis: 'x', position: 100, from: -Infinity, to: Infinity })
  })
})
