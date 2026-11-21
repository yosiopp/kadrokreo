import { describe, expect, it } from 'vitest'
import { cappedStroke, lineBetween, lineEndpoints, pathFromPoints, pathPoints } from './path.ts'

describe('lineBetween / lineEndpoints', () => {
  const cases = [
    { name: '右下へ', from: { x: 10, y: 20 }, to: { x: 110, y: 70 } },
    { name: '右上へ', from: { x: 10, y: 70 }, to: { x: 110, y: 20 } },
    { name: '左下へ', from: { x: 110, y: 20 }, to: { x: 10, y: 70 } },
    { name: '左上へ', from: { x: 110, y: 70 }, to: { x: 10, y: 20 } },
    { name: '水平に右へ', from: { x: 0, y: 5 }, to: { x: 30, y: 5 } },
    { name: '水平に左へ', from: { x: 30, y: 5 }, to: { x: 0, y: 5 } },
    { name: '垂直に下へ', from: { x: 5, y: 0 }, to: { x: 5, y: 30 } },
    { name: '垂直に上へ', from: { x: 5, y: 30 }, to: { x: 5, y: 0 } },
  ]

  it.each(cases)('$name 引いた線の始点と終点が入れ替わらない', ({ from, to }) => {
    const line = lineBetween(from, to)
    const [start, end] = lineEndpoints(line).map((p) => ({ x: p.x + line.x, y: p.y + line.y }))
    expect(start).toEqual(from)
    expect(end).toEqual(to)
  })

  it('枠は両端を囲む', () => {
    expect(lineBetween({ x: 110, y: 20 }, { x: 10, y: 70 })).toMatchObject({ x: 10, y: 20, width: 100, height: 50 })
  })
})

describe('pathFromPoints / pathPoints', () => {
  it('頂点を枠に対する割合で持ち、元の位置に戻せる', () => {
    const points = [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 60, y: 70 }]
    const shape = pathFromPoints(points)
    expect(shape).toMatchObject({ x: 10, y: 20, width: 100, height: 50 })
    expect(shape.points).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }])
    expect(pathPoints(shape).map((p) => ({ x: p.x + shape.x, y: p.y + shape.y }))).toEqual(points)
  })

  it('枠の大きさを変えると、形も一緒に伸縮する', () => {
    const shape = pathFromPoints([{ x: 0, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 100 }])
    expect(pathPoints({ ...shape, width: 200, height: 50 })).toEqual([
      { x: 0, y: 0 },
      { x: 200, y: 25 },
      { x: 100, y: 50 },
    ])
  })

  it('水平に並んだ頂点でも枠がつぶれない', () => {
    const shape = pathFromPoints([{ x: 0, y: 5 }, { x: 30, y: 5 }])
    expect(shape).toMatchObject({ x: 0, y: 5, width: 30, height: 1 })
    expect(pathPoints(shape)).toEqual([{ x: 0, y: 0 }, { x: 30, y: 0 }])
  })
})

describe('cappedStroke', () => {
  it('細い線でも矢印は長さ 10 にし、長さのない区間には矢印を付けない', () => {
    const style = { strokeWidth: 1, startCap: 'arrow' as const, endCap: 'arrow' as const }
    const { line, heads } = cappedStroke([{ x: 0, y: 0 }, { x: 0, y: 50 }], style)
    expect(line).toEqual([{ x: 0, y: 8 }, { x: 0, y: 42 }])
    expect(heads[1]).toEqual([{ x: 0, y: 50 }, { x: -4, y: 40 }, { x: 4, y: 40 }])
    expect(cappedStroke([{ x: 5, y: 5 }, { x: 5, y: 5 }], style).heads).toEqual([])
  })
})
