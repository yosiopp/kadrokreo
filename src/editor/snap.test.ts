import { describe, expect, it } from 'vitest'
import { findGuides, snapMove, snapResize } from './snap.ts'

const target = { x: 100, y: 100, width: 100, height: 50 }

describe('snapMove', () => {
  it('近くの端に吸着する', () => {
    // 左端 97 → 100、上端 152 → 下端 150
    expect(snapMove({ x: 97, y: 152, width: 30, height: 30 }, [target], 5)).toEqual({ dx: 3, dy: -2 })
  })

  it('中央同士も吸着する', () => {
    // 中央 148 → 150
    expect(snapMove({ x: 128, y: 300, width: 40, height: 40 }, [target], 5)).toEqual({ dx: 2, dy: 0 })
  })

  it('いちばん近い線を選ぶ', () => {
    // 右端 202 → 200（距離 2）。左端 172 は中央 150 にも端にも届かない
    expect(snapMove({ x: 172, y: 0, width: 30, height: 10 }, [target], 5).dx).toBe(-2)
  })

  it('離れていれば吸着しない', () => {
    expect(snapMove({ x: 300, y: 300, width: 30, height: 30 }, [target], 5)).toEqual({ dx: 0, dy: 0 })
  })
})

describe('snapResize', () => {
  it('ハンドルで動かしている辺だけを吸着する', () => {
    const bounds = { x: 10, y: 10, width: 88, height: 87 }
    expect(snapResize(bounds, 'se', [target], 5)).toEqual({ x: 10, y: 10, width: 90, height: 90 })
    expect(snapResize(bounds, 'e', [target], 5)).toEqual({ x: 10, y: 10, width: 90, height: 87 })
    // 左上は動かさないので、右下が近くても何も起きない
    expect(snapResize(bounds, 'nw', [target], 5)).toEqual(bounds)
  })

  it('左や上の辺を吸着するときは反対側の辺を動かさない', () => {
    const bounds = { x: 203, y: 153, width: 50, height: 50 }
    expect(snapResize(bounds, 'nw', [target], 5)).toEqual({ x: 200, y: 150, width: 53, height: 53 })
  })
})

describe('findGuides', () => {
  it('ぴったり揃っている線だけをガイドにし、両方の図形にまたがる長さにする', () => {
    const guides = findGuides({ x: 100, y: 300, width: 30, height: 30 }, [target])
    expect(guides).toEqual([{ axis: 'x', position: 100, from: 100, to: 330 }])
  })

  it('半端にずれている線はガイドにしない', () => {
    expect(findGuides({ x: 100.5, y: 300, width: 30, height: 30 }, [target])).toEqual([])
  })

  it('リサイズ中は動かしている辺だけを見る', () => {
    const bounds = { x: 100, y: 300, width: 100, height: 30 }
    expect(findGuides(bounds, [target], 'e')).toEqual([{ axis: 'x', position: 200, from: 100, to: 330 }])
    expect(findGuides(bounds, [target], 's')).toEqual([])
  })
})
