import { describe, expect, it } from 'vitest'
import type { AutoLayout, FrameNode, Scene } from '../document/types.ts'
import { enableAutoLayout, placeInLayout, relayout, wrapInAutoLayout } from './layout.ts'
import { createFrame, createRect, createText } from './nodes.ts'
import { createDocument, createPage, insertNode, removeNodes, setSize, updateNode } from './operations.ts'
import { createEditorStore } from './store.ts'

const LAYOUT: AutoLayout = {
  direction: 'horizontal',
  gap: 10,
  paddingX: 20,
  paddingY: 5,
  align: 'start',
  justify: 'start',
  widthMode: 'hug',
  heightMode: 'hug',
}

/** 大きさの違う 3 つの長方形（a: 30×20, b: 50×40, c: 20×10）を持つフレーム */
function fixture(layout: Partial<AutoLayout> = {}) {
  const frame = { ...createFrame({ x: 100, y: 100, width: 300, height: 100 }), layout: { ...LAYOUT, ...layout } }
  const a = createRect({ x: 0, y: 0, width: 30, height: 20 })
  const b = createRect({ x: 0, y: 0, width: 50, height: 40 })
  const c = createRect({ x: 0, y: 0, width: 20, height: 10 })
  let page = insertNode(createPage(), frame)
  for (const node of [a, b, c]) page = insertNode(page, node, frame.id)
  return { page: relayout(page), frame, a, b, c }
}

const at = (scene: Scene, id: string) => ({ x: scene.nodes[id].x, y: scene.nodes[id].y })
const sizeOf = (scene: Scene, id: string) => ({ width: scene.nodes[id].width, height: scene.nodes[id].height })

describe('relayout', () => {
  it('横に並べ、フレームを中身に合わせる', () => {
    const { page, frame, a, b, c } = fixture()
    expect(at(page, a.id)).toEqual({ x: 20, y: 5 })
    expect(at(page, b.id)).toEqual({ x: 60, y: 5 })
    expect(at(page, c.id)).toEqual({ x: 120, y: 5 })
    // 幅: 余白 20 × 2 + 30 + 50 + 20 + 間隔 10 × 2、高さ: 余白 5 × 2 + いちばん高い 40
    expect(sizeOf(page, frame.id)).toEqual({ width: 160, height: 50 })
    // フレームの左上は動かない
    expect(at(page, frame.id)).toEqual({ x: 100, y: 100 })
  })

  it('縦に並べる', () => {
    const { page, frame, a, b, c } = fixture({ direction: 'vertical' })
    expect(at(page, a.id)).toEqual({ x: 20, y: 5 })
    expect(at(page, b.id)).toEqual({ x: 20, y: 35 })
    expect(at(page, c.id)).toEqual({ x: 20, y: 85 })
    expect(sizeOf(page, frame.id)).toEqual({ width: 90, height: 100 })
  })

  it('並べる向きと直交する向きの揃え', () => {
    const center = fixture({ align: 'center' })
    expect(center.page.nodes[center.a.id].y).toBe(15)
    expect(center.page.nodes[center.c.id].y).toBe(20)
    const end = fixture({ align: 'end' })
    expect(end.page.nodes[end.a.id].y).toBe(25)
    expect(end.page.nodes[end.b.id].y).toBe(5)
  })

  it('大きさが固定なら、寄せ方に従って余りを配る', () => {
    const fixed = { widthMode: 'fixed', heightMode: 'fixed' } as const
    // 幅 300、余白 20 × 2、中身 120 なので余りは 140
    const xs = (justify: AutoLayout['justify']) => {
      const { page, a, b, c } = fixture({ ...fixed, justify })
      return [a, b, c].map((node) => page.nodes[node.id].x)
    }
    expect(xs('start')).toEqual([20, 60, 120])
    expect(xs('center')).toEqual([90, 130, 190])
    expect(xs('end')).toEqual([160, 200, 260])
    // 間隔 10 に、余り 140 を 2 か所へ 70 ずつ足す
    expect(xs('space-between')).toEqual([20, 130, 260])

    const { page, frame } = fixture(fixed)
    expect(sizeOf(page, frame.id)).toEqual({ width: 300, height: 100 })
  })

  it('非表示の子は場所を取らない', () => {
    const { page, frame, a, b, c } = fixture()
    const next = relayout(updateNode(page, b.id, { visible: false }))
    expect(at(next, a.id)).toEqual({ x: 20, y: 5 })
    expect(at(next, c.id)).toEqual({ x: 60, y: 5 })
    expect(sizeOf(next, frame.id)).toEqual({ width: 100, height: 30 })
  })

  it('子が増減すると並べ直す', () => {
    const { page, frame, b, c } = fixture()
    const removed = relayout(removeNodes(page, [b.id]))
    expect(at(removed, c.id)).toEqual({ x: 60, y: 5 })
    expect(sizeOf(removed, frame.id).width).toBe(100)
  })

  it('入れ子は内側から並べる', () => {
    const outer = { ...createFrame({ x: 0, y: 0, width: 10, height: 10 }), layout: { ...LAYOUT, direction: 'vertical' as const, paddingX: 0, paddingY: 0 } }
    const inner = { ...createFrame({ x: 0, y: 0, width: 10, height: 10 }), layout: { ...LAYOUT, paddingX: 0, paddingY: 0, gap: 0 } }
    const label = createRect({ x: 0, y: 0, width: 70, height: 20 })
    const footer = createRect({ x: 0, y: 0, width: 40, height: 15 })
    let page = insertNode(createPage(), outer)
    page = insertNode(page, inner, outer.id)
    page = insertNode(page, label, inner.id)
    page = insertNode(page, footer, outer.id)

    const next = relayout(page)
    // 内側が中身（70 × 20）に合わせて決まり、それを受けて外側が決まる
    expect(sizeOf(next, inner.id)).toEqual({ width: 70, height: 20 })
    expect(at(next, footer.id)).toEqual({ x: 0, y: 30 })
    expect(sizeOf(next, outer.id)).toEqual({ width: 70, height: 45 })
  })

  it('すでに並んでいれば同じ参照を返す', () => {
    const { page } = fixture()
    expect(relayout(page)).toBe(page)
    const plain = insertNode(createPage(), createFrame({ x: 0, y: 0, width: 10, height: 10 }))
    expect(relayout(plain)).toBe(plain)
  })

  it('90° 回した子は、回した後の幅と高さで場所を取る', () => {
    const { page, a, b } = fixture()
    const next = relayout(updateNode(page, a.id, { rotation: 90 }))
    // a は 30 × 20 → 回すと 20 × 30。次の b は 20 + 20 + 10 の位置から
    expect(next.nodes[b.id].x).toBe(50)
  })
})

describe('enableAutoLayout', () => {
  it('いまの並びから、向き・順番・間隔・余白を決める', () => {
    const frame = createFrame({ x: 0, y: 0, width: 400, height: 200 })
    // 重なり順とは逆に、右から左へ置いてある
    const right = createRect({ x: 200, y: 30, width: 50, height: 50 })
    const left = createRect({ x: 40, y: 30, width: 60, height: 50 })
    const middle = createRect({ x: 120, y: 30, width: 60, height: 50 })
    let page = insertNode(createPage(), frame)
    for (const node of [right, left, middle]) page = insertNode(page, node, frame.id)

    const next = enableAutoLayout(page, frame.id)
    const result = next.nodes[frame.id] as FrameNode
    expect(result.layout).toMatchObject({ direction: 'horizontal', gap: 20, paddingX: 40, paddingY: 30 })
    expect(result.children).toEqual([left.id, middle.id, right.id])
    // 見た目の位置は変わらない
    expect(at(next, left.id)).toEqual({ x: 40, y: 30 })
    expect(at(next, middle.id)).toEqual({ x: 120, y: 30 })
    expect(at(next, right.id)).toEqual({ x: 200, y: 30 })
    expect(sizeOf(next, frame.id)).toEqual({ width: 290, height: 110 })
  })

  it('縦に並んでいれば縦に並べる', () => {
    const frame = createFrame({ x: 0, y: 0, width: 100, height: 300 })
    let page = insertNode(createPage(), frame)
    page = insertNode(page, createRect({ x: 10, y: 10, width: 50, height: 20 }), frame.id)
    page = insertNode(page, createRect({ x: 10, y: 40, width: 50, height: 20 }), frame.id)
    expect((enableAutoLayout(page, frame.id).nodes[frame.id] as FrameNode).layout).toMatchObject({
      direction: 'vertical',
      gap: 10,
    })
  })

  it('すでに有効なら何もしない', () => {
    const { page, frame } = fixture()
    expect(enableAutoLayout(page, frame.id)).toBe(page)
  })
})

describe('wrapInAutoLayout', () => {
  it('選んだものを、ぴったり囲む自動で並べるフレームにまとめる', () => {
    const a = createRect({ x: 100, y: 100, width: 40, height: 20 })
    const b = createRect({ x: 160, y: 100, width: 40, height: 20 })
    const other = createRect({ x: 500, y: 500, width: 10, height: 10 })
    let page = createPage()
    for (const node of [a, other, b]) page = insertNode(page, node)

    const { scene, id } = wrapInAutoLayout(page, [a.id, b.id], 'Group')
    const frame = scene.nodes[id!] as FrameNode
    expect(frame).toMatchObject({ x: 100, y: 100, width: 100, height: 20, name: 'Group', fill: null })
    expect(frame.layout).toMatchObject({ direction: 'horizontal', gap: 20, paddingX: 0, paddingY: 0 })
    expect(frame.children).toEqual([a.id, b.id])
    // いちばん手前にあった b の位置に入る
    expect(scene.rootIds).toEqual([other.id, frame.id])
    expect(wrapInAutoLayout(page, [], 'Group')).toEqual({ scene: page, id: null })
  })
})

describe('placeInLayout', () => {
  it('ポインタの位置に応じて順番を入れ替える', () => {
    const { page, frame, a, b, c } = fixture()
    const order = (scene: Scene) => (scene.nodes[frame.id] as FrameNode).children
    // フレームは (100, 100) にあり、a は x 120〜150、b は 160〜210、c は 220〜240
    expect(order(placeInLayout(page, [a.id], frame.id, { x: 250, y: 110 }))).toEqual([b.id, c.id, a.id])
    expect(order(placeInLayout(page, [c.id], frame.id, { x: 110, y: 110 }))).toEqual([c.id, a.id, b.id])
    expect(order(placeInLayout(page, [a.id], frame.id, { x: 200, y: 110 }))).toEqual([b.id, a.id, c.id])
    expect(order(placeInLayout(page, [a.id, b.id], frame.id, { x: 250, y: 110 }))).toEqual([c.id, a.id, b.id])
    // 動かしていなければそのまま
    expect(placeInLayout(page, [b.id], frame.id, { x: 185, y: 110 })).toBe(page)
  })

  it('外から入れる', () => {
    const { page, frame, a, b, c } = fixture()
    const outside = createRect({ x: 0, y: 0, width: 10, height: 10 })
    const next = placeInLayout(insertNode(page, outside), [outside.id], frame.id, { x: 155, y: 110 })
    expect((next.nodes[frame.id] as FrameNode).children).toEqual([a.id, outside.id, b.id, c.id])
  })
})

describe('大きさの指定', () => {
  it('中身に合わせているフレームの大きさを変えると、その向きは固定になる', () => {
    const { page, frame } = fixture()
    const next = relayout(setSize(page, [frame.id], { width: 400 }))
    expect((next.nodes[frame.id] as FrameNode).layout).toMatchObject({ widthMode: 'fixed', heightMode: 'hug' })
    expect(sizeOf(next, frame.id)).toEqual({ width: 400, height: 50 })
    // 同じ大きさを指定しても固定にはならない
    expect(setSize(page, [frame.id], { width: 160 })).toBe(page)
  })
})

describe('ストア', () => {
  it('変更のたびに並べ直す', () => {
    const { page, frame, a, b } = fixture()
    const doc = createDocument()
    const store = createEditorStore({ ...doc, pages: [{ ...doc.pages[0], nodes: page.nodes, rootIds: page.rootIds }] })

    store.apply((base) => updateNode(base, a.id, { width: 100 }))
    expect(store.getState().page.nodes[b.id].x).toBe(130)
    expect(store.getState().page.nodes[frame.id].width).toBe(230)

    // 並べ直しまで含めて Undo 1 回分
    store.undo()
    expect(store.getState().page.nodes[b.id].x).toBe(60)
    expect(store.getState().canUndo).toBe(false)
  })

  it('テキストが伸びると、フレームも一緒に伸びる', () => {
    const frame = { ...createFrame({ x: 0, y: 0, width: 10, height: 10 }), layout: LAYOUT }
    const label = createText({ x: 0, y: 0, width: 40, height: 20 }, 'OK')
    const store = createEditorStore(createDocument())
    store.apply((base) => insertNode(insertNode(base, frame), label, frame.id))
    expect(store.getState().page.nodes[frame.id]).toMatchObject({ width: 80, height: 30 })

    store.preview((base) => updateNode(base, label.id, { width: 100 }))
    expect(store.getState().page.nodes[frame.id].width).toBe(140)
    store.cancelPreview()
    expect(store.getState().page.nodes[frame.id].width).toBe(80)
  })
})
