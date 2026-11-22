import { describe, expect, it } from 'vitest'
import { booleanBounds, booleanPath, booleanResult, isBooleanNode } from '../../document/booleanNode.ts'
import { getAbsoluteBounds } from '../../document/geometry.ts'
import { contoursArea } from '../../document/pathBoolean.ts'
import { ellipse, frame, path, rect, sceneOf, text } from '../../document/testNodes.ts'
import type { FrameNode, PathNode } from '../../document/types.ts'
import { createEditorStore } from '../store.ts'
import { canCreateBooleanNode, canFlattenBoolean, createBooleanNode, fitBooleanNodes, flattenBooleanNodes, setBooleanOperation } from './booleanNodes.ts'
import { canOutlineStroke, outlineStrokes } from './outline.ts'
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
    const store = createEditorStore({ name: 'd', pages: [{ ...scene, id: 'p', name: 'P' }], assets: {} })
    store.apply((page) => updateNode(page, 'b', { x: 200 }))
    const page = store.getState().page
    const node = page.nodes[id!] as FrameNode
    // 引くものが離れたので、結果は a そのもの
    expect(contoursArea(booleanResult(page, node as never))).toBeCloseTo(10000, 3)
    expect(node).toMatchObject({ x: 0, y: 0, width: 100, height: 100 })
  })

  it('ストアで演算を変えても、子は拡大されない（枠だけが結果に合う）', () => {
    const { scene, id } = createBooleanNode(two(), ['a', 'b'], 'intersect')
    const store = createEditorStore({ name: 'd', pages: [{ ...scene, id: 'p', name: 'P' }], assets: {} })
    store.apply((page) => setBooleanOperation(page, [id!], 'union'))
    const page = store.getState().page
    expect(page.nodes[id!]).toMatchObject({ x: 0, y: 0, width: 150, height: 150 })
    expect(page.nodes.a).toMatchObject({ x: 0, y: 0, width: 100, height: 100 })
  })

  it('ノードを拡大すると、子も一緒に拡大する', () => {
    const { scene, id } = createBooleanNode(two(), ['a', 'b'], 'union')
    const store = createEditorStore({ name: 'd', pages: [{ ...scene, id: 'p', name: 'P' }], assets: {} })
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
