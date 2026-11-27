import { describe, expect, it } from 'vitest'
import { booleanBounds, booleanPath, booleanResult, isBooleanNode } from '../../document/booleanNode.ts'
import { getAbsoluteBounds } from '../../document/geometry.ts'
import { contoursArea } from '../../document/pathBoolean.ts'
import { ellipse, frame, path, rect, sceneOf, text } from '../../document/testNodes.ts'
import type { FrameNode, PathNode } from '../../document/types.ts'
import { createEditorStore } from '../store.ts'
import { canCreateBooleanNode, canFlattenBoolean, createBooleanNode, fitBooleanNodes, flattenBooleanNodes, setBooleanOperation } from './booleanNodes.ts'
import { canOutlineStroke, outlineStrokes } from './outline.ts'
import { translateNodes } from './transform.ts'
import { updateNode } from './tree.ts'

const two = () =>
  sceneOf(
    rect({ id: 'a', name: 'A', x: 0, y: 0, width: 100, height: 100 }),
    rect({ id: 'b', name: 'B', x: 50, y: 50, width: 100, height: 100, fills: [] }),
    text({ id: 't' }),
  )

describe('ブーリアン演算のノード', () => {
  it('選んだものを子にしたノードを作り、塗りは最背面の子から引き継ぐ。テキストは入れない', () => {
    const scene = two()
    expect(canCreateBooleanNode(scene, ['a'])).toBe(false)
    expect(canCreateBooleanNode(scene, ['a', 't'])).toBe(false)
    expect(canCreateBooleanNode(scene, ['a', 'b'])).toBe(true)
    const { scene: next, id } = createBooleanNode(scene, ['b', 'a', 't'], 'union')
    const node = next.nodes[id!] as FrameNode
    expect(isBooleanNode(node)).toBe(true)
    expect(node).toMatchObject({ name: '合体', booleanOperation: 'union', layout: null, x: 0, y: 0, width: 150, height: 150 })
    expect(node.children).toEqual(['a', 'b'])
    expect(node.fills).toEqual(scene.nodes.a.type === 'rect' ? scene.nodes.a.fills : [])
    expect(next.rootIds).toEqual([id, 't'])
    expect(contoursArea(booleanResult(next, node as never))).toBeCloseTo(100 * 100 * 2 - 50 * 50, 3)
  })

  it('演算を変えると結果が変わり、枠が結果に合う', () => {
    const { scene, id } = createBooleanNode(two(), ['a', 'b'], 'union')
    const intersected = fitBooleanNodes(setBooleanOperation(scene, [id!], 'intersect'))
    const node = intersected.nodes[id!] as FrameNode
    expect(node).toMatchObject({ x: 50, y: 50, width: 50, height: 50, booleanOperation: 'intersect' })
    // 子は動かして、ページ上の位置は変えない
    expect(getAbsoluteBounds(intersected, 'a')).toEqual({ x: 0, y: 0, width: 100, height: 100 })
    expect(contoursArea(booleanResult(intersected, node as never))).toBeCloseTo(2500, 3)
    expect(setBooleanOperation(intersected, [id!], 'intersect')).toBe(intersected)
    expect(setBooleanOperation(intersected, ['t'], 'union')).toBe(intersected)
  })

  it('子を変えると結果が変わる（ストアの後始末で枠が付いてくる）', () => {
    const { scene, id } = createBooleanNode(two(), ['a', 'b'], 'subtract')
    const store = createEditorStore({ name: 'd', pages: [{ ...scene, id: 'p', name: 'P', guides: [] }], assets: {}, fonts: [] })
    store.apply((page) => updateNode(page, 'b', { x: 200 }))
    const page = store.getState().page
    const node = page.nodes[id!] as FrameNode
    // 引くものが離れたので、結果は a そのもの
    expect(contoursArea(booleanResult(page, node as never))).toBeCloseTo(10000, 3)
    expect(node).toMatchObject({ x: 0, y: 0, width: 100, height: 100 })
  })

  it('ストアで演算を変えても、子は拡大されない（枠だけが結果に合う）', () => {
    const { scene, id } = createBooleanNode(two(), ['a', 'b'], 'intersect')
    const store = createEditorStore({ name: 'd', pages: [{ ...scene, id: 'p', name: 'P', guides: [] }], assets: {}, fonts: [] })
    store.apply((page) => setBooleanOperation(page, [id!], 'union'))
    const page = store.getState().page
    expect(page.nodes[id!]).toMatchObject({ x: 0, y: 0, width: 150, height: 150 })
    expect(page.nodes.a).toMatchObject({ x: 0, y: 0, width: 100, height: 100 })
  })

  it('ノードを拡大すると、子も一緒に拡大する', () => {
    const { scene, id } = createBooleanNode(two(), ['a', 'b'], 'union')
    const store = createEditorStore({ name: 'd', pages: [{ ...scene, id: 'p', name: 'P', guides: [] }], assets: {}, fonts: [] })
    store.apply((page) => updateNode(page, id!, { width: 300, height: 300 }))
    const page = store.getState().page
    expect(page.nodes.b).toMatchObject({ x: 100, y: 100, width: 200, height: 200 })
    expect(page.nodes[id!]).toMatchObject({ width: 300, height: 300 })
  })

  it('入れ子の演算のノードも形として入り、回したノードの枠合わせは見た目を変えない', () => {
    const inner = createBooleanNode(two(), ['a', 'b'], 'union')
    const withCircle: typeof inner.scene = { ...inner.scene, nodes: { ...inner.scene.nodes, c: ellipse({ id: 'c', x: 0, y: 200, width: 20, height: 20 }) }, rootIds: [...inner.scene.rootIds, 'c'] }
    const outer = createBooleanNode(withCircle, [inner.id!, 'c'], 'union')
    const node = outer.scene.nodes[outer.id!] as FrameNode
    expect(node).toMatchObject({ x: 0, y: 0, width: 150, height: 220 })
    const rotated = updateNode(outer.scene, outer.id!, { rotation: 90, width: 400 })
    const before = booleanPath(rotated, rotated.nodes[outer.id!] as never)
    const fitted = fitBooleanNodes(rotated)
    const after = fitted.nodes[outer.id!] as FrameNode
    expect(after.width).toBeCloseTo(150, 1)
    // 結果の形のページ上の位置は変わらない（中心がずれた分を x / y で打ち消す）
    const world = (s: typeof fitted, p: PathNode) => getAbsoluteBounds({ ...s, nodes: { ...s.nodes, [p.id]: p } }, p.id)
    expect(booleanBounds(fitted, after as never)).toMatchObject({ x: expect.closeTo(0, 1), y: expect.closeTo(0, 1) })
    expect(world(fitted, booleanPath(fitted, after as never)).x).toBeCloseTo(world(rotated, before).x + 0, 0)
  })

  it('平らにすると、結果の形のパスになり、子は消える', () => {
    const { scene, id } = createBooleanNode(two(), ['a', 'b'], 'exclude')
    expect(canFlattenBoolean(scene, [id!])).toBe(true)
    expect(canFlattenBoolean(scene, ['t'])).toBe(false)
    const flat = flattenBooleanNodes(scene, [id!])
    const node = flat.scene.nodes[id!] as PathNode
    expect(node).toMatchObject({ type: 'path', name: '除外', fillRule: 'evenodd', x: 0, y: 0, width: 150, height: 150 })
    expect(flat.scene.nodes.a).toBeUndefined()
    expect(flat.ids).toEqual([id])
    const empty = createBooleanNode(sceneOf(rect({ id: 'p', width: 10, height: 10 }), rect({ id: 'q', x: 50, width: 10, height: 10 })), ['p', 'q'], 'intersect')
    expect(flattenBooleanNodes(empty.scene, [empty.id!]).error).toBe('empty')
  })

  it('隠した子とテキストの子は演算に入らない', () => {
    const { scene, id } = createBooleanNode(two(), ['a', 'b'], 'union')
    const hidden = updateNode(scene, 'b', { visible: false })
    expect(contoursArea(booleanResult(hidden, hidden.nodes[id!] as never))).toBeCloseTo(10000, 3)
    const withText = { ...scene, nodes: { ...scene.nodes, t: { ...scene.nodes.t, parentId: id! }, [id!]: { ...(scene.nodes[id!] as FrameNode), children: ['a', 'b', 't'] } } }
    expect(contoursArea(booleanResult(withText, withText.nodes[id!] as never))).toBeCloseTo(17500, 3)
  })

  it('線を含めると、子の線の外形まで結果に入る（線のない子は形のまま）', () => {
    const black = [{ type: 'solid' as const, color: '#000000', opacity: 1, visible: true, blendMode: 'normal' as const }]
    const scene = sceneOf(
      rect({ id: 'a', x: 0, y: 0, width: 100, height: 100, strokes: black, strokeWidth: 10 }),
      rect({ id: 'b', x: 50, y: 50, width: 100, height: 100, strokes: black, strokeWidth: 10 }),
    )
    const { scene: plain, id } = createBooleanNode(scene, ['a', 'b'], 'union')
    expect(contoursArea(booleanResult(plain, plain.nodes[id!] as never))).toBeCloseTo(17500, 3)
    const included = fitBooleanNodes(updateNode(plain, id!, { booleanIncludeStrokes: true }))
    const node = included.nodes[id!] as FrameNode
    // 線は輪郭の内と外へ半分ずつ（5px）出る: 110 角の正方形 2 つが 60 角で重なる
    expect(contoursArea(booleanResult(included, node as never))).toBeCloseTo(110 * 110 * 2 - 60 * 60, 1)
    expect(node).toMatchObject({ x: -5, y: -5, width: 160, height: 160 })
    // 線のない子は形のまま
    const bare = fitBooleanNodes(updateNode(included, 'b', { strokes: [] }))
    expect(contoursArea(booleanResult(bare, bare.nodes[id!] as never))).toBeCloseTo(110 * 110 + 100 * 100 - 55 * 55, 1)
  })

  it('線を含めると、直線（開いたパス）も線の太さの形で入る', () => {
    const scene = sceneOf(
      rect({ id: 'a', x: 0, y: 0, width: 100, height: 100 }),
      path({ id: 'l', x: 50, y: 150, width: 100, height: 0, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], strokeWidth: 4 }),
    )
    const { scene: next, id } = createBooleanNode(scene, ['a', 'l'], 'union')
    expect(contoursArea(booleanResult(next, next.nodes[id!] as never))).toBeCloseTo(10000, 3)
    const included = updateNode(next, id!, { booleanIncludeStrokes: true })
    expect(contoursArea(booleanResult(included, included.nodes[id!] as never))).toBeCloseTo(10000 + 100 * 4, 1)
    // 差し引きでは、線の太さの分だけ削られる
    const cut = createBooleanNode(sceneOf(rect({ id: 'a', x: 0, y: 0, width: 100, height: 100 }), path({ id: 'l', x: 0, y: 50, width: 100, height: 0, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], strokeWidth: 4 })), ['a', 'l'], 'subtract')
    const cutIncluded = updateNode(cut.scene, cut.id!, { booleanIncludeStrokes: true })
    expect(booleanResult(cutIncluded, cutIncluded.nodes[cut.id!] as never)).toHaveLength(2)
    expect(contoursArea(booleanResult(cutIncluded, cutIncluded.nodes[cut.id!] as never))).toBeCloseTo(10000 - 400, 1)
  })

  it('線を含めると、子のフレームの枠の線と入れ子の演算のノードの線も入る', () => {
    const black = [{ type: 'solid' as const, color: '#000000', opacity: 1, visible: true, blendMode: 'normal' as const }]
    const scene = sceneOf(
      frame({ id: 'f', x: 0, y: 0, width: 100, height: 100, strokes: black, strokeWidth: 10 }),
      rect({ id: 'b', x: 200, y: 0, width: 50, height: 50 }),
      rect({ id: 'c', x: 225, y: 25, width: 50, height: 50 }),
    )
    const inner = createBooleanNode(scene, ['b', 'c'], 'union')
    const innerStroked = updateNode(inner.scene, inner.id!, { strokes: black, strokeWidth: 2 })
    const { scene: next, id } = createBooleanNode(innerStroked, ['f', inner.id!], 'union')
    const plainArea = contoursArea(booleanResult(next, next.nodes[id!] as never))
    expect(plainArea).toBeCloseTo(10000 + 50 * 50 * 2 - 25 * 25, 1)
    const included = updateNode(next, id!, { booleanIncludeStrokes: true })
    // 枠の線 110 角と、入れ子の結果を 1px 太らせた形（周 300 × 1 と角の分）
    const area = contoursArea(booleanResult(included, included.nodes[id!] as never))
    expect(area - plainArea).toBeGreaterThan(110 * 110 - 10000 + 300)
    expect(area - plainArea).toBeLessThan(110 * 110 - 10000 + 310)
  })
})

/** 頂点の多いぎざぎざの円（n 頂点、直線だけのパス）。2,000 頂点 2 つの合体で数十 ms かかる */
const jagged = (id: string, x: number, n = 2000) =>
  path({
    id,
    x,
    y: 0,
    width: 216,
    height: 216,
    closed: true,
    fills: [{ type: 'solid', color: '#000000', opacity: 1, visible: true, blendMode: 'normal' }],
    strokes: [],
    points: Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2
      const r = i % 2 ? 108 : 100
      return { x: (108 + r * Math.cos(a)) / 216, y: (108 + r * Math.sin(a)) / 216 }
    }),
  })

describe('ブーリアン演算のノードを動かす・ドラッグする', () => {
  it('ノードごと動かしても、子がそろって平行移動しても、計算し直さず前の結果を使う（ずらした結果は計算し直したものと同じ）', () => {
    const { scene, id } = createBooleanNode(two(), ['a', 'b'], 'union')
    const node = scene.nodes[id!] as FrameNode
    const first = booleanResult(scene, node as never)
    const moved = updateNode(scene, id!, { x: 300 })
    expect(booleanResult(moved, moved.nodes[id!] as never)).toBe(first)
    const shifted = translateNodes(scene, ['a', 'b'], 7, -3)
    const reused = booleanResult(shifted, shifted.nodes[id!] as never)
    expect(reused).not.toBe(first)
    expect(reused[0].vertices[0]).toEqual({ x: first[0].vertices[0].x + 7, y: first[0].vertices[0].y - 3 })
    // 片方だけ動かせば、計算し直す
    const one = translateNodes(scene, ['b'], 200, 0)
    expect(contoursArea(booleanResult(one, one.nodes[id!] as never))).toBeCloseTo(20000, 3)
  })

  it('ドラッグ中（プレビュー）は重い演算を計算し直さず前の結果を見せ、離したときに計算して枠を合わせる', () => {
    const { scene, id } = createBooleanNode(sceneOf(jagged('a', 0), jagged('b', 80)), ['a', 'b'], 'union')
    const store = createEditorStore({ name: 'd', pages: [{ ...scene, id: 'p', name: 'P', guides: [] }], assets: {}, fonts: [] })
    const before = store.getState().page
    const result = booleanResult(before, before.nodes[id!] as never)
    const width = before.nodes[id!].width
    for (const dx of [100, 200, 300]) store.preview((base) => translateNodes(base, ['b'], dx, 0))
    const dragging = store.getState().page
    expect(booleanResult(dragging, dragging.nodes[id!] as never)).toBe(result)
    expect(dragging.nodes[id!].width).toBe(width)
    store.commitPreview()
    const page = store.getState().page
    const node = page.nodes[id!] as FrameNode
    // 離れた 2 つの形になり、枠も 2 つを囲む
    expect(booleanResult(page, node as never)).toHaveLength(2)
    expect(node.width).toBeCloseTo(216 + 380, 1)
    expect(store.getState().canUndo).toBe(true)
  })

  it('軽い演算はドラッグ中も毎回計算し、取り消すと元に戻る', () => {
    const { scene, id } = createBooleanNode(two(), ['a', 'b'], 'union')
    const store = createEditorStore({ name: 'd', pages: [{ ...scene, id: 'p', name: 'P', guides: [] }], assets: {}, fonts: [] })
    store.preview((base) => translateNodes(base, ['b'], 200, 0))
    const dragging = store.getState().page
    expect(contoursArea(booleanResult(dragging, dragging.nodes[id!] as never))).toBeCloseTo(20000, 3)
    expect(dragging.nodes[id!].width).toBeCloseTo(350, 3)
    store.cancelPreview()
    expect(store.getState().page.nodes[id!].width).toBe(150)
  })
})

describe('線の輪郭化', () => {
  const stroke = [{ type: 'solid' as const, color: '#ff0000', opacity: 1, visible: true, blendMode: 'normal' as const }]

  it('塗りのない図形は、同じ id の線の形のパスに置き換える', () => {
    const scene = sceneOf(path({ id: 'l', name: 'Line', width: 100, height: 0, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], strokes: stroke, strokeWidth: 4 }))
    expect(canOutlineStroke(scene, ['l'])).toBe(true)
    const { scene: next, ids } = outlineStrokes(scene, ['l'])
    expect(ids).toEqual(['l'])
    const node = next.nodes.l as PathNode
    expect(node).toMatchObject({ type: 'path', name: 'Line', fills: stroke, strokes: [], closed: true, x: 0, y: -2, width: 100, height: 4 })
  })

  it('塗りのある図形は、線を外して残し、手前に線の形を置く', () => {
    const scene = sceneOf(rect({ id: 'r', name: 'Box', width: 100, height: 100, strokes: stroke, strokeWidth: 10 }))
    const { scene: next, ids } = outlineStrokes(scene, ['r'])
    expect(next.rootIds).toEqual(['r', ids[0]])
    expect(next.nodes.r).toMatchObject({ strokes: [] })
    const outline = next.nodes[ids[0]] as PathNode
    expect(outline).toMatchObject({ name: 'Box の線', fills: stroke, x: -5, y: -5, width: 110, height: 110 })
    expect(outline.contours).toHaveLength(1)
  })

  it('線のないものは変えない', () => {
    const scene = sceneOf(rect({ id: 'r' }), text({ id: 't' }), frame({ id: 'f' }))
    expect(canOutlineStroke(scene, ['r', 't', 'f'])).toBe(false)
    expect(outlineStrokes(scene, ['r', 't']).scene).toBe(scene)
  })
})
