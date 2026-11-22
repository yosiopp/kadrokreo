import { describe, expect, it } from 'vitest'
import { findGuides, snapMove, snapResize, snapShape, toFrame } from './snap.ts'

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

describe('snapShape', () => {
  const diamond = [
    { x: 50, y: 0 },
    { x: 100, y: 50 },
    { x: 50, y: 100 },
    { x: 0, y: 50 },
  ]

  it('斜めの図形は囲む矩形に加えて角も揃える線にする', () => {
    const shape = snapShape([diamond])!
    expect(shape).toMatchObject({ x: 0, y: 0, width: 100, height: 100 })
    expect(shape.xs).toContain(50)
    // 縦横に沿った図形の角は足さない
    expect(snapShape([[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]])!.xs).toEqual([])
  })

  it('回した向きで見ると、同じ角度の図形は縦横の矩形になる', () => {
    const shape = snapShape([diamond], 45)!
    expect(shape.xs).toEqual([])
    expect(shape.width).toBeCloseTo(Math.hypot(50, 50))
    expect(toFrame({ x: 1, y: 0 }, 0)).toEqual({ x: 1, y: 0 })
  })

  it('動かす側の角が、相手の斜めの角に吸着する', () => {
    const target = snapShape([diamond])!
    // 左端 47 を、ひし形の上の角の x = 50 へ
    expect(snapMove({ x: 47, y: 200, width: 20, height: 10 }, [target], 5).dx).toBe(3)
  })
})
