import { describe, expect, it } from 'vitest'
import { pathFromContours, pathFromPoints, pathSegments, segmentAt } from '../document/path.ts'
import { createFrame, createPath } from './nodes.ts'
import { createPage } from './operations/document.ts'
import { insertNode } from './operations/tree.ts'
import {
  deleteVertex,
  deleteVertices,
  insertVertex,
  moveVertices,
  openAtSegment,
  refitPath,
  setVertexKind,
  setVertexRadius,
  vertexKind,
  isSmooth,
  moveControl,
  moveVertex,
  nearestOnPath,
  parentVertices,
  reshapePath,
  toggleSmooth,
  contourSegment,
  deleteContourVertices,
  editByContour,
  flatVertices,
  locateVertex,
  nearestOnContours,
  neighborVertex,
  parentContours,
  reshapeContours,
  withFlatVertices,
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

describe('頂点の複数選択・種類・角の丸め・辺から開く', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ]

  it('moveVertices は選んだ頂点だけを制御点ごと動かす', () => {
    const curved = [{ x: 0, y: 0, out: { x: 10, y: 0 } }, ...square.slice(1)]
    const moved = moveVertices(curved, [0, 2], 5, -5)
    expect(moved[0]).toEqual({ x: 5, y: -5, out: { x: 15, y: -5 } })
    expect(moved[1]).toBe(curved[1])
    expect(moved[2]).toEqual({ x: 105, y: 95 })
  })

  it('deleteVertices はまとめて消し、残りが少なすぎるときは消さない', () => {
    expect(deleteVertices(square, true, [1])).toHaveLength(3)
    expect(deleteVertices(square, true, [1, 3])).toBeNull()
    expect(deleteVertices(square, false, [1, 3])).toEqual([square[0], square[2]])
    expect(deleteVertices(square, false, [])).toBeNull()
  })

  it('setVertexKind は角となめらかを切り替え、折れた曲線はなめらかに揃える', () => {
    const smooth = setVertexKind(square, [1, 2], true, 'smooth')
    expect(vertexKind(smooth[1])).toBe('smooth')
    expect(vertexKind(smooth[2])).toBe('smooth')
    expect(vertexKind(smooth[0])).toBe('corner')
    expect(setVertexKind(smooth, [1], true, 'corner')[1]).toEqual({ x: 100, y: 0 })
    const broken = { x: 50, y: 50, in: { x: 40, y: 40 }, out: { x: 60, y: 50 } }
    expect(vertexKind(broken)).toBe('curve')
    const fixed = setVertexKind([square[0], broken, square[2]], [1], false, 'smooth')[1]
    expect(vertexKind(fixed)).toBe('smooth')
    // out の向きはそのまま、in の長さも保つ
    expect(fixed.out).toEqual(broken.out)
    expect(Math.hypot(fixed.in!.x - 50, fixed.in!.y - 50)).toBeCloseTo(Math.hypot(10, 10))
  })

  it('setVertexRadius は選んだ頂点の丸めを変え、0 で外す', () => {
    const rounded = setVertexRadius(square, [0, 2], 12)
    expect(rounded[0]).toEqual({ x: 0, y: 0, radius: 12 })
    expect(rounded[1]).toEqual({ x: 100, y: 0 })
    expect(setVertexRadius(rounded, [0], 0)[0]).toEqual({ x: 0, y: 0 })
  })

  it('openAtSegment は閉じた形を辺で開き、辺の次の頂点を始点にする', () => {
    const curved = square.map((vertex, i) => (i === 1 ? { ...vertex, out: { x: 120, y: 30 } } : i === 2 ? { ...vertex, in: { x: 120, y: 70 }, radius: 4 } : vertex))
    const opened = openAtSegment(curved, true, 1)!
    expect(opened.closed).toBe(false)
    // 1 → 2 の辺を消したので、2 から始まって 1 で終わる。消した辺の制御点と、端の丸めは外す
    expect(opened.vertices).toEqual([{ x: 100, y: 100 }, square[3], square[0], { x: 100, y: 0 }])
    expect(openAtSegment(square, false, 0)).toBeNull()
  })

  it('refitPath は角の丸めに合わせて枠を作り直す。頂点の位置は変わらない', () => {
    const triangle = createPath(pathFromPoints([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 100 }], true), true)
    const page = insertNode(createPage(), {
      ...triangle,
      points: triangle.points.map((point) => ({ ...point, radius: 20 })),
    })
    const refit = refitPath(page, triangle.id)
    const node = refit.nodes[triangle.id]
    expect(node.height).toBeLessThan(100)
    expect(node.x).toBeGreaterThan(0)
    const before = parentVertices(page, triangle.id)
    parentVertices(refit, triangle.id).forEach((vertex, i) => {
      expect(vertex.x).toBeCloseTo(before[i].x)
      expect(vertex.y).toBeCloseTo(before[i].y)
    })
  })
})

describe('2 つ目以降の輪郭の編集（通し番号）', () => {
  // 外側の正方形（0〜3）と、内側の穴の正方形（4〜7）
  const outer = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ]
  const hole = [
    { x: 30, y: 30 },
    { x: 70, y: 30 },
    { x: 70, y: 70 },
    { x: 30, y: 70 },
  ]
  const contours = [
    { vertices: outer, closed: true },
    { vertices: hole, closed: true },
  ]
  const ring = () => {
    const path = { ...createPath(pathFromContours(contours), true), ...pathFromContours(contours) }
    return { path, page: insertNode(createPage(), path) }
  }

  it('locateVertex と flatVertices は通し番号を輪郭と輪郭の中の番号に分ける', () => {
    expect(flatVertices(contours)).toHaveLength(8)
    expect(locateVertex(contours, 0)).toEqual({ contour: 0, local: 0 })
    expect(locateVertex(contours, 5)).toEqual({ contour: 1, local: 1 })
    expect(locateVertex(contours, 8)).toBeNull()
    expect(withFlatVertices(contours, flatVertices(contours))).toEqual(contours)
  })

  it('reshapeContours で穴の頂点を動かせる。枠は全部の輪郭に合わせ直し、最初の輪郭はそのまま', () => {
    const { path, page } = ring()
    const result = reshapeContours(page, path.id, (all) => withFlatVertices(all, moveVertices(flatVertices(all), [5, 6], 10, 0)))
    const after = parentContours(result, path.id)
    expect(after[0].vertices).toEqual(outer)
    expect(after[1].vertices[1]).toEqual({ x: 80, y: 30 })
    expect(after[1].vertices[2]).toEqual({ x: 80, y: 70 })
    // 穴を外へ出すと枠が広がる
    const out = reshapeContours(page, path.id, (all) => withFlatVertices(all, moveVertex(flatVertices(all), 5, { x: 150, y: 30 })))
    expect(out.nodes[path.id]).toMatchObject({ x: 0, width: 150 })
    expect(parentContours(out, path.id)[1].vertices[1]).toEqual({ x: 150, y: 30 })
  })

  it('nearestOnContours は穴の辺も通し番号で返し、editByContour で穴の辺に頂点を足せる', () => {
    const nearest = nearestOnContours(contours, { x: 50, y: 32 })
    expect(nearest).toMatchObject({ segment: 4 })
    expect(nearest!.t).toBeCloseTo(0.5)
    expect(contourSegment(contours, 4)).toMatchObject({ from: { x: 30, y: 30 }, to: { x: 70, y: 30 } })
    // 閉じた輪郭の最後の頂点から始まる辺は、同じ輪郭の最初の頂点へ戻る
    expect(contourSegment(contours, 7)).toMatchObject({ from: { x: 30, y: 70 }, to: { x: 30, y: 30 } })
    const added = editByContour(contours, [nearest!.segment], (vertices, closed, [segment]) =>
      insertVertex(vertices, closed, segment, nearest!.t),
    )!
    expect(added[0]).toBe(contours[0])
    expect(added[1].vertices).toHaveLength(5)
    // 足した頂点の通し番号は segment + 1
    expect(flatVertices(added)[5]).toEqual({ x: 50, y: 30 })
  })

  it('editByContour は輪郭ごとに閉じているかを渡し、穴の辺で開ける', () => {
    const opened = editByContour(contours, [7], (vertices, closed, [local]) => openAtSegment(vertices, closed, local))!
    expect(opened[0].closed).toBe(true)
    expect(opened[1]).toEqual({ vertices: hole, closed: false })
    // 頂点の種類は、その輪郭の隣を見て決める
    const smooth = editByContour(contours, [4], (vertices, closed, local) => setVertexKind(vertices, local, closed, 'smooth'))!
    expect(smooth[1].vertices[0].in).toBeDefined()
    expect(smooth[1].vertices[0].in!.y).toBeGreaterThan(30)
    expect(neighborVertex(contours, 4)).toEqual(hole[1])
    expect(neighborVertex(contours, 6)).toEqual(hole[1])
  })

  it('deleteContourVertices は穴の頂点を消す。輪郭の頂点を全部選ぶと輪郭ごと消す', () => {
    const fewer = deleteContourVertices([...contours, { vertices: [...hole, { x: 50, y: 80 }], closed: true }], [12])!
    expect(fewer[2].vertices).toHaveLength(4)
    // 閉じた輪郭を 3 つより減らす削除は、何も消さない
    expect(deleteContourVertices(contours, [4, 5])).toBeNull()
    // 穴を丸ごと消す
    expect(deleteContourVertices(contours, [4, 5, 6, 7])).toEqual([contours[0]])
    // 穴を丸ごと消しつつ、後ろの輪郭の頂点も消す（番号は消す前の並びで数える）
    const three = [...contours, { vertices: [...hole, { x: 50, y: 80 }], closed: true }]
    const both = deleteContourVertices(three, [4, 5, 6, 7, 12])!
    expect(both).toHaveLength(2)
    expect(both[1].vertices).toHaveLength(4)
    // 全部の輪郭を丸ごと選んでも、パスは消さない
    expect(deleteContourVertices(contours, [0, 1, 2, 3, 4, 5, 6, 7])).toBeNull()
    // reshapeContours で輪郭を消すと、kdr の contours も減る
    const { path, page } = ring()
    const result = reshapeContours(page, path.id, (all) => deleteContourVertices(all, [4, 5, 6, 7]))
    expect(result.nodes[path.id]).toMatchObject({ contours: [] })
  })

  it('reshapePath は最初の輪郭だけを書き換え、穴は保つ', () => {
    const { path, page } = ring()
    const result = reshapePath(page, path.id, (vertices) => moveVertices(vertices, [0], -10, 0))
    const after = parentContours(result, path.id)
    expect(after[0].vertices[0]).toEqual({ x: -10, y: 0 })
    expect(after[1].vertices).toEqual(hole)
  })
})
