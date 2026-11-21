import { describe, expect, it } from 'vitest'
import { pathFromPoints, pathSegments, segmentAt } from '../document/path.ts'
import { createFrame, createPath } from './nodes.ts'
import { createPage, insertNode } from './operations.ts'
import {
  deleteVertex,
  insertVertex,
  isSmooth,
  moveControl,
  moveVertex,
  nearestOnPath,
  parentVertices,
  reshapePath,
  toggleSmooth,
} from './pathEdit.ts'

const zigzag = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
]

describe('パスの頂点の編集', () => {
  it('toggleSmooth は角の頂点に、両隣を結ぶ向きの制御点を付ける。もう一度で角に戻す', () => {
    const smooth = toggleSmooth(zigzag, 1, false)
    // 0,0 → 100,100 の向き。長さは隣までの 1/3
    expect(smooth[1].in?.x).toBeCloseTo(100 - 100 / 3 / Math.SQRT2)
    expect(smooth[1].out?.y).toBeCloseTo(100 / 3 / Math.SQRT2)
    expect(isSmooth(smooth[1])).toBe(true)
    expect(toggleSmooth(smooth, 1, false)[1]).toEqual({ x: 100, y: 0 })
    // 開いたパスの端は片側だけ
    const end = toggleSmooth(zigzag, 0, false)[0]
    expect(end.in).toBeUndefined()
    expect(end.out).toBeDefined()
  })

  it('moveVertex は制御点も一緒に動かす', () => {
    const smooth = toggleSmooth(zigzag, 1, false)
    const moved = moveVertex(smooth, 1, { x: 110, y: 10 })
    expect(moved[1].x).toBe(110)
    expect(moved[1].out!.x - moved[1].x).toBeCloseTo(smooth[1].out!.x - smooth[1].x)
  })

  it('moveControl はなめらかな頂点の反対側を一直線に保ち、長さは変えない。mirror でなければ片側だけ', () => {
    const vertex = { x: 0, y: 0, in: { x: -10, y: 0 }, out: { x: 20, y: 0 } }
    const [mirrored] = moveControl([vertex], 0, 'out', { x: 0, y: 30 }, true)
    expect(mirrored.in!.x).toBeCloseTo(0)
    expect(mirrored.in!.y).toBeCloseTo(-10)
    const [broken] = moveControl([vertex], 0, 'out', { x: 0, y: 30 }, false)
    expect(broken.in).toEqual({ x: -10, y: 0 })
    // 頂点に重ねると、その側の制御点はなくなる
    const [corner] = moveControl([vertex], 0, 'in', { x: 0, y: 0 }, false)
    expect(corner).not.toHaveProperty('in')
  })

  it('insertVertex は曲線の形を変えずに頂点を足す', () => {
    const arch = [
      { x: 0, y: 0, out: { x: 0, y: -100 } },
      { x: 100, y: 0, in: { x: 100, y: -100 } },
    ]
    const split = insertVertex(arch, false, 0, 0.5)
    expect(split).toHaveLength(3)
    expect(split[1]).toMatchObject({ x: 50, y: -75 })
    const before = segmentAt(pathSegments(arch, false)[0], 0.25)
    const after = segmentAt(pathSegments(split, false)[0], 0.5)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
    // 直線の辺には制御点のない頂点を足す
    expect(insertVertex(zigzag, false, 1, 0.5)[2]).toEqual({ x: 100, y: 50 })
    // 閉じた形の戻る辺にも足せる
    expect(insertVertex(zigzag, true, 2, 0.5)).toHaveLength(4)
  })

  it('deleteVertex は開いたパスを 2 つ、閉じた形を 3 つより減らさない', () => {
    expect(deleteVertex(zigzag, false, 1)).toEqual([zigzag[0], zigzag[2]])
    expect(deleteVertex(zigzag, true, 1)).toBeNull()
    expect(deleteVertex(zigzag.slice(0, 2), false, 0)).toBeNull()
  })

  it('nearestOnPath は曲線の上でいちばん近い位置を返す', () => {
    const arch = [
      { x: 0, y: 0, out: { x: 0, y: -100 } },
      { x: 100, y: 0, in: { x: 100, y: -100 } },
    ]
    const nearest = nearestOnPath(arch, false, { x: 50, y: -80 })
    expect(nearest?.t).toBeCloseTo(0.5, 2)
    expect(nearest?.distance).toBeCloseTo(5, 1)
  })

  it('reshapePath は親の座標で形を作り直し、回転を頂点に織り込む', () => {
    const frame = createFrame({ x: 100, y: 100, width: 300, height: 300 })
    const path = { ...createPath(pathFromPoints(zigzag), false), rotation: 90 }
    const page = insertNode(insertNode(createPage(), frame), path, frame.id)
    const before = parentVertices(page, path.id)
    const result = reshapePath(page, path.id, (vertices, closed) => toggleSmooth(vertices, 1, closed))
    const node = result.nodes[path.id]
    expect(node).toMatchObject({ rotation: 0, parentId: frame.id })
    const after = parentVertices(result, path.id)
    expect(after[0].x).toBeCloseTo(before[0].x)
    expect(after[2].y).toBeCloseTo(before[2].y)
    expect(after[1].in).toBeDefined()
    // 何もしなければ同じ参照
    expect(reshapePath(page, path.id, () => null)).toBe(page)
  })
})
