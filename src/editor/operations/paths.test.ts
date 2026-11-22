import { describe, expect, it } from 'vitest'
import { getAbsoluteBounds } from '../../document/geometry.ts'
import { pathContours, pathFromContours, pathFromPoints } from '../../document/path.ts'
import { ellipse, frame, path, rect, sceneOf, text } from '../../document/testNodes.ts'
import type { FrameNode, PathNode } from '../../document/types.ts'
import { contoursArea } from '../../document/pathBoolean.ts'
import { addContour, applyMask, booleanPaths, canJoinPaths, canSplitPaths, joinPaths, maskAction, splitPaths } from './paths.ts'

const square = (x: number, y: number, size: number) => ({
  vertices: [
    { x, y },
    { x: x + size, y },
    { x: x + size, y: y + size },
    { x, y: y + size },
  ],
  closed: true,
})

describe('パスの結合', () => {
  it('矩形・楕円・パスを最も背面のものの輪郭にまとめ、残りを消す', () => {
    const tri = path({ id: 'tri', name: 'Tri', ...pathFromPoints([{ x: 200, y: 0 }, { x: 240, y: 0 }, { x: 220, y: 30 }], true), closed: true, strokes: [] })
    const scene = sceneOf(
      rect({ id: 'r', name: 'Box', x: 0, y: 0, width: 100, height: 50, cornerRadius: 10 }),
      ellipse({ id: 'e', x: 120, y: 0, width: 40, height: 40 }),
      tri,
      text({ id: 't' }),
    )
    expect(canJoinPaths(scene, ['r'])).toBe(false)
    expect(canJoinPaths(scene, ['r', 't'])).toBe(false)
    expect(canJoinPaths(scene, ['tri', 'e', 'r'])).toBe(true)
    const { scene: joined, id } = joinPaths(scene, ['tri', 'e', 'r', 't'])
    expect(id).toBe('r')
    expect(joined.rootIds).toEqual(['r', 't'])
    const node = joined.nodes.r as PathNode
    // 名前・塗りは背面の矩形のもの。角丸は輪郭の曲線になり、cornerRadius は持たない
    expect(node).toMatchObject({ type: 'path', name: 'Box', x: 0, y: 0, width: 240, height: 50, fills: scene.nodes.r.type === 'rect' ? scene.nodes.r.fills : [] })
    expect('cornerRadius' in node).toBe(false)
    expect(node.contours).toHaveLength(2)
    expect(pathContours(node).every((contour) => contour.closed)).toBe(true)
    expect(joinPaths(scene, ['r'])).toEqual({ scene, id: null })
  })

  it('最も背面のものの親の座標にまとめ、ページ上の形は変わらない', () => {
    const outer = frame({ id: 'f', x: 100, y: 100, width: 300, height: 300, rotation: 90, children: ['a'] })
    const a = rect({ id: 'a', parentId: 'f', x: 10, y: 10, width: 20, height: 20 })
    const b = rect({ id: 'b', x: 0, y: 0, width: 20, height: 20 })
    const scene = sceneOf(b, outer, a)
    const before = getAbsoluteBounds(scene, 'a')
    const { scene: joined, id } = joinPaths(scene, ['a', 'b'])
    expect(id).toBe('b')
    expect(joined.nodes.a).toBeUndefined()
    const after = joined.nodes.b as PathNode
    expect(after.parentId).toBeNull()
    const world = pathContours(after)[1].vertices.map((v) => ({ x: v.x + after.x, y: v.y + after.y }))
    expect(Math.min(...world.map((p) => p.x))).toBeCloseTo(before.x, 6)
    expect(Math.min(...world.map((p) => p.y))).toBeCloseTo(before.y, 6)
    expect(Math.max(...world.map((p) => p.x))).toBeCloseTo(before.x + before.width, 6)
  })
})

describe('パスの分割', () => {
  it('輪郭ごとのパスに分け、2 つ目からは元のすぐ手前に置く。端の形は最初の輪郭にだけ残す', () => {
    const shape = pathFromContours([square(0, 0, 10), square(20, 0, 10), square(40, 0, 10)])
    const holed = path({ id: 'p', ...shape, contours: shape.contours, closed: true, startCap: 'arrow' })
    const scene = sceneOf(holed, rect({ id: 'front' }))
    expect(canSplitPaths(scene, ['front'])).toBe(false)
    expect(canSplitPaths(scene, ['p'])).toBe(true)
    const { scene: split, ids } = splitPaths(scene, ['p'])
    expect(ids).toHaveLength(3)
    expect(split.rootIds).toEqual([...ids, 'front'])
    expect(split.nodes.p).toMatchObject({ x: 0, width: 10, contours: [], startCap: 'arrow' })
    expect(split.nodes[ids[1]]).toMatchObject({ type: 'path', x: 20, width: 10, contours: [], startCap: 'none' })
    expect(split.nodes[ids[2]]).toMatchObject({ x: 40, width: 10 })
    expect(splitPaths(split, ['p']).ids).toEqual([])
  })

  it('結合して分割すると元の形に戻る', () => {
    const a = path({ id: 'a', ...pathFromPoints(square(0, 0, 10).vertices, true), closed: true })
    const b = path({ id: 'b', ...pathFromPoints(square(30, 30, 10).vertices, true), closed: true })
    const joined = joinPaths(sceneOf(a, b), ['a', 'b']).scene
    const { scene, ids } = splitPaths(joined, ['a'])
    expect(scene.nodes[ids[0]]).toMatchObject({ x: 0, y: 0, width: 10, height: 10 })
    expect(scene.nodes[ids[1]]).toMatchObject({ x: 30, y: 30, width: 10, height: 10 })
  })
})

describe('輪郭を足す', () => {
  it('親の座標の輪郭を足し、枠を合わせ直す。頂点が足りなければ何もしない', () => {
    const scene = sceneOf(path({ id: 'p', ...pathFromPoints(square(0, 0, 10).vertices, true), closed: true }))
    const added = addContour(scene, 'p', square(20, 20, 10))
    expect(added.nodes.p).toMatchObject({ x: 0, y: 0, width: 30, height: 30 })
    expect((added.nodes.p as PathNode).contours).toHaveLength(1)
    expect(addContour(scene, 'p', { vertices: [{ x: 0, y: 0 }], closed: false })).toBe(scene)
  })
})

describe('マスクとして使う', () => {
  it('1 つならそれをマスクにし、どれもマスクならやめる', () => {
    const scene = sceneOf(rect({ id: 'm' }), rect({ id: 'a' }), text({ id: 't' }))
    expect(maskAction(scene, ['m'])).toBe('set')
    expect(maskAction(scene, ['t'])).toBeNull()
    const masked = applyMask(scene, ['m'], 'Mask group')
    expect(masked.id).toBe('m')
    expect(masked.scene.nodes.m).toMatchObject({ isMask: true })
    expect(maskAction(masked.scene, ['m'])).toBe('clear')
    expect(applyMask(masked.scene, ['m'], 'Mask group').scene.nodes.m).toMatchObject({ isMask: false })
  })

  it('いくつもなら、フレームにまとめて最も背面のものをマスクにする', () => {
    const scene = sceneOf(
      ellipse({ id: 'm', x: 0, y: 0, width: 50, height: 50 }),
      rect({ id: 'a', x: 20, y: 20, width: 50, height: 50 }),
      rect({ id: 'other', x: 300, y: 0 }),
    )
    const { scene: next, id } = applyMask(scene, ['a', 'm'], 'Mask group')
    const group = next.nodes[id!] as FrameNode
    expect(group).toMatchObject({ type: 'frame', name: 'Mask group', x: 0, y: 0, width: 70, height: 70, clipContent: false, fills: [] })
    expect(group.children).toEqual(['m', 'a'])
    expect(next.rootIds).toEqual([id, 'other'])
    expect(next.nodes.m).toMatchObject({ isMask: true, parentId: id })
    // 背面のものが矩形・楕円・パスでなければ何もしない
    const withText = sceneOf(text({ id: 't' }), rect({ id: 'a' }))
    expect(applyMask(withText, ['t', 'a'], 'Mask group').scene).toBe(withText)
  })
})

describe('ブーリアン演算', () => {
  const scene = sceneOf(
    rect({ id: 'a', name: 'A', x: 0, y: 0, width: 100, height: 100 }),
    ellipse({ id: 'b', name: 'B', x: 50, y: 50, width: 100, height: 100 }),
    text({ id: 't' }),
  )

  it('結果を最も背面のものの位置のパス（evenodd）に焼き込み、残りを消す', () => {
    const { scene: next, id } = booleanPaths(scene, ['b', 'a', 't'], 'union')
    expect(id).toBe('a')
    expect(next.rootIds).toEqual(['a', 't'])
    const node = next.nodes.a as PathNode
    expect(node).toMatchObject({ type: 'path', name: 'A', closed: true, fillRule: 'evenodd', x: 0, y: 0, width: 150, height: 150 })
    expect(node.fills).toEqual(scene.nodes.a.type === 'rect' ? scene.nodes.a.fills : [])
  })

  it('差し引き・交差・除外の面積', () => {
    const area = (op: 'union' | 'subtract' | 'intersect' | 'exclude') => {
      const node = booleanPaths(scene, ['a', 'b'], op).scene.nodes.a as PathNode
      return contoursArea(pathContours(node))
    }
    const quarter = (Math.PI * 50 * 50) / 4
    // 楕円は 4 本のベジェで近似しているので、面積は 0.1% ほどずれる
    expect(area('intersect') / quarter).toBeCloseTo(1, 2)
    expect(area('subtract') / (10000 - quarter)).toBeCloseTo(1, 2)
    expect(area('union') / (10000 + 4 * quarter - quarter)).toBeCloseTo(1, 2)
    expect(area('exclude') / (10000 + 4 * quarter - 2 * quarter)).toBeCloseTo(1, 2)
  })

  it('回した図形や、親の座標の違うものも、ページ上の形で演算する', () => {
    const rotated = sceneOf(
      rect({ id: 'a', x: 0, y: 0, width: 100, height: 100 }),
      frame({ id: 'f', x: 0, y: 0, width: 300, height: 300, children: ['b'] }),
      rect({ id: 'b', parentId: 'f', x: 0, y: 0, width: 100, height: 100, rotation: 45 }),
    )
    const node = booleanPaths(rotated, ['a', 'b'], 'intersect').scene.nodes.a as PathNode
    const bounds = getAbsoluteBounds({ ...rotated, nodes: { ...rotated.nodes, a: node } }, 'a')
    expect(node.rotation).toBe(0)
    expect(bounds.x).toBeGreaterThanOrEqual(-1e-6)
    expect(bounds.y).toBeGreaterThanOrEqual(-1e-6)
    expect(bounds.width).toBeLessThanOrEqual(100 + 1e-6)
  })

  it('結果が空なら何も変えずに empty を返す。2 つ未満なら何もしない', () => {
    const apart = sceneOf(rect({ id: 'a', x: 0, y: 0, width: 10, height: 10 }), rect({ id: 'b', x: 50, y: 0, width: 10, height: 10 }))
    expect(booleanPaths(apart, ['a', 'b'], 'intersect')).toEqual({ scene: apart, id: null, error: 'empty' })
    expect(booleanPaths(scene, ['a', 't'], 'union')).toEqual({ scene, id: null })
  })
})
