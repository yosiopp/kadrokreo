import { describe, expect, it } from 'vitest'
import { pathBounds, pathData } from './path.ts'
import { PathDataError, parsePathData } from './pathData.ts'

describe('parsePathData', () => {
  it('M / L / H / V / Z を頂点にする。小文字は相対座標', () => {
    expect(parsePathData('M10 10 H50 v20 l-40 0 Z')).toEqual([
      {
        vertices: [
          { x: 10, y: 10 },
          { x: 50, y: 10 },
          { x: 50, y: 30 },
          { x: 10, y: 30 },
        ],
        closed: true,
      },
    ])
  })

  it('M の後に続く座標の組は L として扱う。カンマや符号の区切りも読む', () => {
    expect(parsePathData('M0,0 10,0-5.5.5')[0].vertices).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: -5.5, y: 0.5 },
    ])
  })

  it('C は前の頂点の out と、次の頂点の in になる。S は直前の制御点を折り返す', () => {
    const [path] = parsePathData('M0 0 C0 -10 10 -10 10 0 S20 10 20 0')
    expect(path.vertices).toEqual([
      { x: 0, y: 0, out: { x: 0, y: -10 } },
      { x: 10, y: 0, in: { x: 10, y: -10 }, out: { x: 10, y: 10 } },
      { x: 20, y: 0, in: { x: 20, y: 10 } },
    ])
    // そのまま書き出すと元の形に戻る
    expect(pathData(path.vertices, path.closed)).toBe('M0 0 C0 -10 10 -10 10 0 C10 10 20 10 20 0')
  })

  it('Q と T は同じ形の 3 次の曲線にする', () => {
    const [path] = parsePathData('M0 0 Q15 30 30 0 T60 0')
    expect(path.vertices[0].out).toEqual({ x: 10, y: 20 })
    expect(path.vertices[1].in).toEqual({ x: 20, y: 20 })
    // T は直前の制御点（15,30）を 30,0 で折り返した 45,-30 を使う
    expect(path.vertices[1].out).toEqual({ x: 40, y: -20 })
    expect(pathBounds(path.vertices, false)).toMatchObject({ x: 0, y: -15, width: 60, height: 30 })
  })

  it('A は 90° 以下に分けた 3 次の曲線で近似する', () => {
    // 半径 50 の半円（0,0 → 100,0、下側を通る）
    const [path] = parsePathData('M0 0 A50 50 0 0 0 100 0')
    expect(path.vertices).toHaveLength(3)
    expect(path.vertices[1].x).toBeCloseTo(50)
    expect(path.vertices[1].y).toBeCloseTo(50)
    const box = pathBounds(path.vertices, false)
    expect(box.height).toBeCloseTo(50, 1)
    expect(path.vertices[2]).toMatchObject({ x: 100, y: 0 })
  })

  it('A のフラグは区切りなしで続けて書ける。半径が足りなければ拡大する', () => {
    const [compact] = parsePathData('M0 0a1 1 0 0010 0')
    expect(compact.vertices.at(-1)).toMatchObject({ x: 10, y: 0 })
    expect(pathBounds(compact.vertices, false).height).toBeCloseTo(5, 1)
  })

  it('最初の頂点に戻ってから閉じた輪郭は、重なった頂点を 1 つにまとめる', () => {
    const [circle] = parsePathData('M0 50 A50 50 0 1 1 100 50 A50 50 0 1 1 0 50 Z')
    expect(circle.closed).toBe(true)
    expect(circle.vertices).toHaveLength(4)
    expect(circle.vertices[0].in).toBeDefined()
    const box = pathBounds(circle.vertices, true)
    expect(box.width).toBeCloseTo(100, 1)
    expect(box.height).toBeCloseTo(100, 1)
  })

  it('M ごとに輪郭を分ける', () => {
    expect(parsePathData('M0 0 L1 1 M5 5 L6 6')).toHaveLength(2)
  })

  it('読めないものはエラーにする', () => {
    expect(() => parsePathData('L0 0')).toThrow(PathDataError)
    expect(() => parsePathData('M0 0 C1 1 2')).toThrow('C の数値が足りません')
    expect(() => parsePathData('M0 0 X1 1')).toThrow('読めない文字')
    expect(() => parsePathData('M0 0 A1 1 0 2 0 5 5')).toThrow('フラグ')
  })
})
