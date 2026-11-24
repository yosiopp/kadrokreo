import { describe, expect, it } from 'vitest'
import { text } from './testNodes.ts'
import { isFlowText, isPathText, pathTextClusters, placeOnPath, textPathFromVertices, textPathLength, verticesLength } from './textPath.ts'
import type { TextNode, TextPath } from './types.ts'

/** 横 100px の直線（左から右）に沿うテキスト */
function onLine(patch: Partial<TextNode> = {}, textPath: Partial<TextPath> = {}) {
  return text({
    width: 100,
    height: 1,
    textPath: { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], closed: false, startOffset: 0, ...textPath },
    ...patch,
  }) as TextNode & { textPath: TextPath }
}

/** 送り幅がどれも 10px の文字を置く */
function place(node: TextNode & { textPath: TextPath }, count: number) {
  const clusters = Array.from({ length: count }, (_, i) => String.fromCharCode(65 + i))
  const round = (value: number) => Math.round(value * 1e6) / 1e6 || 0
  return placeOnPath(node, clusters, clusters.map((_, i) => i * 10), clusters.map(() => 10), count * 10).map((glyph) => ({
    ...glyph,
    x: round(glyph.x),
    y: round(glyph.y),
  }))
}

describe('textPath', () => {
  it('線に沿うかどうかを見分ける', () => {
    expect(isPathText(onLine())).toBe(true)
    expect(isPathText(text())).toBe(false)
    expect(isFlowText(text())).toBe(true)
    expect(isFlowText(onLine())).toBe(false)
  })

  it('文字は書記素ごとに分け、改行は空白にする', () => {
    expect(pathTextClusters('ab\nc')).toEqual(['a', 'b', ' ', 'c'])
    expect(pathTextClusters('éx')).toEqual(['é', 'x'])
  })

  it('直線の始まりから、基線を線に乗せて並べる', () => {
    const placed = place(onLine(), 3)
    expect(placed.map((glyph) => [glyph.x, glyph.y, glyph.angle])).toEqual([
      [0, 0, 0],
      [10, 0, 0],
      [20, 0, 0],
    ])
  })

  it('始まりの位置は線の長さの割合で、行揃えはその位置に並びのどこを合わせるか', () => {
    expect(place(onLine({}, { startOffset: 0.5 }), 2).map((glyph) => glyph.x)).toEqual([50, 60])
    expect(place(onLine({ textAlign: 'center' }, { startOffset: 0.5 }), 2).map((glyph) => glyph.x)).toEqual([40, 50])
    expect(place(onLine({ textAlign: 'right' }, { startOffset: 1 }), 2).map((glyph) => glyph.x)).toEqual([80, 90])
  })

  it('真ん中が線の外に出た文字は描かない', () => {
    const placed = place(onLine({}, { startOffset: 0.8 }), 4)
    expect(placed.map((glyph) => glyph.text)).toEqual(['A', 'B'])
    expect(placed.map((glyph) => glyph.index)).toEqual([0, 1])
    expect(place(onLine({ textAlign: 'center' }), 2).map((glyph) => glyph.text)).toEqual(['B'])
  })

  it('文字は線の向きに回し、送り幅の真ん中の位置の向きを使う', () => {
    // 縦の線（上から下）
    const down = onLine({ width: 1, height: 100 }, { points: [{ x: 0, y: 0 }, { x: 0, y: 1 }] })
    const [glyph] = place(down, 1)
    expect(glyph.angle).toBeCloseTo(Math.PI / 2)
    expect(glyph.x).toBeCloseTo(0)
    expect(glyph.y).toBeCloseTo(0)
    // 折れ線: 右へ 10px、下へ 100px。2 文字目の真ん中（15px）は縦の辺
    const bent = onLine({ width: 10, height: 100 }, { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] })
    const [, second] = place(bent, 2)
    expect(second.angle).toBeCloseTo(Math.PI / 2)
    expect(second.x).toBeCloseTo(10)
    expect(second.y).toBeCloseTo(0)
  })

  it('曲線の長さを測る', () => {
    // 半径 50 の半円に近い曲線（制御点は円弧の近似）
    const k = 0.5522847498
    const arc = [
      { x: 0, y: 50, out: { x: 0, y: 50 - 50 * k } },
      { x: 50, y: 0, in: { x: 50 - 50 * k, y: 0 }, out: { x: 50 + 50 * k, y: 0 } },
      { x: 100, y: 50, in: { x: 100, y: 50 - 50 * k } },
    ]
    expect(verticesLength(arc, false)).toBeCloseTo(Math.PI * 50, 0)
    const shape = textPathFromVertices(arc, false)
    expect(textPathLength(text({ ...shape }) as TextNode & { textPath: TextPath })).toBeCloseTo(Math.PI * 50, 0)
  })

  it('頂点から、線を囲む枠と枠に対する割合の頂点を作る（直線でも枠は 1 以上）', () => {
    expect(textPathFromVertices([{ x: 10, y: 20 }, { x: 110, y: 20 }], false, 0.3)).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 1,
      textPath: { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], closed: false, startOffset: 0.3 },
    })
  })
})
