import { describe, expect, it } from 'vitest'
import {
  cappedStroke,
  flattenPath,
  isLine,
  mapVertices,
  pathBounds,
  pathData,
  pathFromPoints,
  pathPoints,
  pathSegments,
  segmentAt,
  splitSegment,
} from './path.ts'
import type { PathNode } from './types.ts'

describe('pathFromPoints で 2 点から作る直線', () => {
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
    const line = pathFromPoints([from, to])
    const [start, end] = pathPoints(line).map((p) => ({ x: p.x + line.x, y: p.y + line.y }))
    expect(start).toEqual(from)
    expect(end).toEqual(to)
  })

  it('枠は両端を囲む', () => {
    expect(pathFromPoints([{ x: 110, y: 20 }, { x: 10, y: 70 }])).toMatchObject({ x: 10, y: 20, width: 100, height: 50 })
  })

  it('水平・垂直の直線は高さ・幅が 0 になれる', () => {
    expect(pathFromPoints([{ x: 0, y: 5 }, { x: 30, y: 5 }])).toMatchObject({ x: 0, y: 5, width: 30, height: 0 })
    expect(pathFromPoints([{ x: 5, y: 30 }, { x: 5, y: 0 }])).toMatchObject({ x: 5, y: 0, width: 0, height: 30 })
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
    const shape = pathFromPoints([{ x: 0, y: 5 }, { x: 15, y: 5 }, { x: 30, y: 5 }])
    expect(shape).toMatchObject({ x: 0, y: 5, width: 30, height: 1 })
    expect(pathPoints(shape)).toEqual([{ x: 0, y: 0 }, { x: 15, y: 0 }, { x: 30, y: 0 }])
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

describe('曲線（制御点 in / out）', () => {
  // 0,0 から 100,0 へ、上に膨らむ山形。制御点は 0,-100 と 100,-100
  const arch = [
    { x: 0, y: 0, out: { x: 0, y: -100 } },
    { x: 100, y: 0, in: { x: 100, y: -100 } },
  ]

  it('枠は制御点ではなく、曲線そのものを囲む', () => {
    // 曲線のいちばん上は t = 0.5 の y = -75
    expect(pathBounds(arch, false)).toEqual({ x: 0, y: -75, width: 100, height: 75 })
  })

  it('閉じた形は最後から最初へ戻る辺も囲む', () => {
    const loop = [
      { x: 0, y: 0 },
      { x: 100, y: 0, out: { x: 100, y: 100 } },
      { x: 50, y: 50, in: { x: 0, y: 100 } },
    ]
    expect(pathBounds(loop, false).x).toBe(0)
    const closedBox = pathBounds([{ ...loop[0], in: { x: -60, y: 0 } }, loop[1], { ...loop[2], out: { x: -60, y: 50 } }], true)
    expect(closedBox.x).toBeLessThan(-10)
  })

  it('pathFromPoints は制御点を頂点からのずれ（枠に対する割合）で持ち、pathPoints で元の位置に戻る', () => {
    const shape = pathFromPoints(arch)
    expect(shape).toMatchObject({ x: 0, y: -75, width: 100, height: 75 })
    expect(shape.points[0]).toEqual({ x: 0, y: 1, out: { x: 0, y: -100 / 75 } })
    expect(shape.points[1]).toEqual({ x: 1, y: 1, in: { x: 0, y: -100 / 75 } })
    const back = mapVertices(pathPoints(shape), (p) => ({ x: p.x, y: p.y - 75 }))
    expect(back[0].out?.y).toBeCloseTo(-100)
    expect(back[1]).toMatchObject({ x: 100, y: 0 })
    expect(back[1].in?.x).toBeCloseTo(100)
  })

  it('曲がった 2 点のパスは直線ではない', () => {
    const node = { type: 'path', closed: false, points: pathFromPoints(arch).points } as PathNode
    expect(isLine(node)).toBe(false)
    expect(isLine({ ...node, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })).toBe(true)
  })

  it('片方の制御点だけでも曲線になり、両方なければ直線の辺', () => {
    const [segment] = pathSegments([{ x: 0, y: 0, out: { x: 0, y: 50 } }, { x: 100, y: 0 }], false)
    expect(segment).toMatchObject({ c1: { x: 0, y: 50 }, c2: { x: 100, y: 0 }, curved: true })
    expect(pathSegments([{ x: 0, y: 0 }, { x: 100, y: 0 }], false)[0].curved).toBe(false)
  })

  it('splitSegment は形を変えずに 2 つに分ける', () => {
    const [segment] = pathSegments(arch, false)
    const [left, right] = splitSegment(segment, 0.3)
    expect(left.to.x).toBeCloseTo(segmentAt(segment, 0.3).x)
    expect(left.to.y).toBeCloseTo(segmentAt(segment, 0.3).y)
    expect(segmentAt(left, 0.5).x).toBeCloseTo(segmentAt(segment, 0.15).x)
    expect(segmentAt(right, 0.5).y).toBeCloseTo(segmentAt(segment, 0.65).y)
  })

  it('flattenPath は曲線を細かい折れ線にする', () => {
    const points = flattenPath(arch, false)
    expect(points[0]).toEqual({ x: 0, y: 0 })
    expect(points.at(-1)).toEqual({ x: 100, y: 0 })
    expect(points.length).toBeGreaterThan(8)
    expect(Math.min(...points.map((p) => p.y))).toBeCloseTo(-75, 0)
    // 直線の辺は分けない。閉じた形は最初の頂点を繰り返さない
    expect(flattenPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }], true)).toHaveLength(3)
  })

  it('pathData は直線を L、曲線を C で書き、閉じた形は Z で閉じる', () => {
    expect(pathData(arch, false)).toBe('M0 0 C0 -100 100 -100 100 0')
    expect(pathData([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }], true)).toBe('M0 0 L10 0 L0 10 Z')
    // 戻る辺が曲線なら C で戻ってから閉じる
    expect(pathData([{ x: 0, y: 0, in: { x: -5, y: 5 } }, { x: 10, y: 0 }], true)).toBe('M0 0 L10 0 C10 0 -5 5 0 0 Z')
  })

  it('mapVertices は制御点にも同じ変換をかける', () => {
    expect(mapVertices(arch, (p) => ({ x: p.x * 2, y: p.y + 1 }))[0]).toEqual({ x: 0, y: 1, out: { x: 0, y: -99 } })
  })

  it('端の矢印は曲線の接線の向きに付き、線は曲線のまま矢印の手前で止まる', () => {
    const style = { strokeWidth: 1, startCap: 'arrow' as const, endCap: 'arrow' as const }
    const { line, heads } = cappedStroke(arch, style)
    // 始点では真上へ出るので、矢印は真下を向く。終点では真下へ入るので、真下を向く
    expect(heads[0][0]).toEqual({ x: 0, y: 0 })
    expect(heads[0][1].y).toBeCloseTo(-10)
    expect(heads[1][1].y).toBeCloseTo(-10)
    expect(Math.hypot(line[0].x, line[0].y)).toBeCloseTo(8)
    expect(Math.hypot(line[1].x - 100, line[1].y)).toBeCloseTo(8)
    // 切り詰めた後も曲線（制御点を持つ）
    expect(line[0].out).toBeDefined()
    expect(line[1].in).toBeDefined()
  })
})
