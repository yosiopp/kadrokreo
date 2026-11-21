import { describe, expect, it } from 'vitest'
import type { AutoLayout, FrameNode, Scene, SceneNode } from '../document/types.ts'
import {
  enableAutoLayout,
  moveInLayout,
  patchLayouts,
  placeInLayout,
  relayout,
  setAutoLayoutEnabled,
  setFrameSizing,
  setLayoutFill,
  setLayoutPositioning,
  setLayoutWrap,
  wrapInAutoLayout,
} from './layout.ts'
import { createFrame, createRect, createText } from './nodes.ts'
import { createDocument, createPage, insertNode, removeNodes, setSize, updateNode } from './operations.ts'
import { createEditorStore } from './store.ts'

const LAYOUT: AutoLayout = {
  direction: 'horizontal',
  gap: 10,
  paddingTop: 5,
  paddingRight: 20,
  paddingBottom: 5,
  paddingLeft: 20,
  align: 'start',
  justify: 'start',
  wrap: false,
  crossGap: 0, alignContent: 'auto',
}

type Sizes = SceneNode['sizing']
const HUG: Sizes = { width: 'hug', height: 'hug' }
const FIXED: Sizes = { width: 'fixed', height: 'fixed' }

/** 大きさの違う 3 つの長方形（a: 30×20, b: 50×40, c: 20×10）を持つフレーム。大きさは既定で中身に合わせる */
function fixture(layout: Partial<AutoLayout> = {}, sizing: Sizes = HUG) {
  const frame = { ...createFrame({ x: 100, y: 100, width: 300, height: 100 }), layout: { ...LAYOUT, ...layout }, sizing }
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
    // 幅 300、余白 20 × 2、中身 120 なので余りは 140
    const xs = (justify: AutoLayout['justify']) => {
      const { page, a, b, c } = fixture({ justify }, FIXED)
      return [a, b, c].map((node) => page.nodes[node.id].x)
    }
    expect(xs('start')).toEqual([20, 60, 120])
    expect(xs('center')).toEqual([90, 130, 190])
    expect(xs('end')).toEqual([160, 200, 260])
    // 間隔 10 に、余り 140 を 2 か所へ 70 ずつ足す
    expect(xs('space-between')).toEqual([20, 130, 260])

    const { page, frame } = fixture({}, FIXED)
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
    const outer = { ...createFrame({ x: 0, y: 0, width: 10, height: 10 }), sizing: HUG, layout: { ...LAYOUT, direction: 'vertical' as const, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0 } }
    const inner = { ...createFrame({ x: 0, y: 0, width: 10, height: 10 }), sizing: HUG, layout: { ...LAYOUT, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, gap: 0 } }
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

describe('親いっぱいに伸ばす', () => {
  /** 横に並べる 300×100 の固定のフレーム（左右の余白 20、上下 5、間隔 10）に、a・b・c */
  const fixed = () => fixture({}, FIXED)
  const box = (scene: Scene, id: string) => {
    const { x, y, width, height } = scene.nodes[id]
    return { x, y, width, height }
  }

  it('並べる向きに伸ばすと、残りを分け合う', () => {
    const { page, a, b, c } = fixed()
    const one = relayout(setLayoutFill(page, [b.id], 'width', true))
    // 300 - 左右 40 - 間隔 20 - a 30 - c 20 = 190
    expect(box(one, b.id)).toEqual({ x: 60, y: 5, width: 190, height: 40 })
    expect(box(one, c.id)).toMatchObject({ x: 260 })
    const two = relayout(setLayoutFill(page, [a.id, b.id], 'width', true))
    // 300 - 40 - 20 - c 20 = 220 を 2 つで
    expect(box(two, a.id).width).toBe(110)
    expect(box(two, b.id)).toMatchObject({ x: 140, width: 110 })
  })

  it('直交する向きに伸ばすと、余白の内側いっぱいになる。揃え方より優先する', () => {
    const { page, a } = fixture({ align: 'end' }, FIXED)
    const next = relayout(setLayoutFill(page, [a.id], 'height', true))
    expect(box(next, a.id)).toEqual({ x: 20, y: 5, width: 30, height: 90 })
  })

  it('中身に合わせる親では、ほかの子の大きさまで伸ばす', () => {
    const { page, c } = fixture()
    const next = relayout(setLayoutFill(page, [c.id], 'height', true))
    // いちばん高い b（40）に合わせる。フレームの高さは変わらない
    expect(box(next, c.id).height).toBe(40)
    expect(next.nodes[fixture().frame.id]?.height ?? 50).toBe(50)
  })

  it('並べる向きを中身に合わせている親なら、伸ばすと親を固定にする', () => {
    const { page, frame, b } = fixture()
    const next = setLayoutFill(page, [b.id], 'width', true)
    expect(next.nodes[frame.id].sizing).toEqual({ width: 'fixed', height: 'hug' })
  })

  it('伸ばすのをやめると固定に戻る', () => {
    const { page, b } = fixed()
    const filled = setLayoutFill(page, [b.id], 'width', true)
    const off = setLayoutFill(filled, [b.id], 'width', false)
    expect(off.nodes[b.id].sizing).toEqual({ width: 'fixed', height: 'fixed' })
    // 伸ばしていなければ変えない
    expect(setLayoutFill(off, [b.id], 'width', false)).toBe(off)
  })

  it('テキストは横に伸ばすと折り返すようになり、縦には伸ばさない。伸ばした幅で測り直す', () => {
    const { page, frame } = fixed()
    const label = createText({ x: 0, y: 0, width: 40, height: 20 }, 'Hello')
    let next = insertNode(page, label, frame.id)
    expect(setLayoutFill(next, [label.id], 'height', true)).toBe(next)
    next = setLayoutFill(next, [label.id], 'width', true)
    expect(next.nodes[label.id].sizing).toEqual({ width: 'fill', height: 'hug' })
    const measured = relayout(next, (scene, ids) =>
      ids.reduce((acc, id) => updateNode(acc, id, { height: 1000 / acc.nodes[id].width }), scene),
    )
    // 300 - 40 - 間隔 30 - 30 - 50 - 20 = 130
    expect(box(measured, label.id).width).toBe(130)
    expect(box(measured, label.id).height).toBeCloseTo(1000 / 130, 1)
  })

  it('子のフレームを伸ばすと、その中身も伸ばした大きさで並べ直す', () => {
    const outer = { ...createFrame({ x: 0, y: 0, width: 200, height: 100 }), sizing: { width: 'fixed', height: 'hug' } as Sizes, layout: { ...LAYOUT, direction: 'vertical' as const } }
    const inner = { ...createFrame({ x: 0, y: 0, width: 10, height: 10 }), layout: { ...LAYOUT, justify: 'end' as const } }
    const dot = createRect({ x: 0, y: 0, width: 10, height: 10 })
    let page = insertNode(createPage(), outer)
    page = insertNode(page, { ...inner, sizing: { width: 'fill', height: 'hug' } }, outer.id)
    page = insertNode(page, dot, inner.id)
    const next = relayout(page)
    // 内側のフレームは中身に合わせる設定でも、親に伸ばされて 200 - 40 = 160。中身は右寄せ
    expect(box(next, inner.id)).toMatchObject({ x: 20, width: 160 })
    expect(box(next, dot.id)).toMatchObject({ x: 130 })
  })
})

describe('並びから外す・矢印キーでの並べ替え', () => {
  const childrenOf = (scene: Scene, id: string) => (scene.nodes[id] as FrameNode).children

  it('並びから外した子は場所を取らず、いまの位置のまま残る。戻せばまた並ぶ', () => {
    const { page, frame, a, b, c } = fixture()
    const out = relayout(setLayoutPositioning(page, [b.id], 'absolute'))
    expect(out.nodes[b.id]).toMatchObject({ x: 60, y: 5, layoutPositioning: 'absolute' })
    // a の次に c が詰める。フレームは a と c だけを囲む
    expect(out.nodes[c.id].x).toBe(60)
    expect(out.nodes[frame.id]).toMatchObject({ width: 20 + 30 + 10 + 20 + 20, height: 5 + 20 + 5 })
    // 外した子は自由に動かせる（並べ直しても戻されない）
    const moved = relayout(updateNode(out, b.id, { x: 200, y: 50 }))
    expect(moved.nodes[b.id]).toMatchObject({ x: 200, y: 50 })
    const back = relayout(setLayoutPositioning(moved, [b.id], 'auto'))
    expect(back.nodes[b.id]).toMatchObject({ x: 60, y: 5 })
    expect(back.nodes[a.id].x).toBe(20)
  })

  it('並びから外すと、親いっぱいに伸ばす指定もやめる', () => {
    const { page, a } = fixture({}, { width: 'fixed', height: 'hug' })
    const filled = setLayoutFill(page, [a.id], 'width', true)
    expect(setLayoutPositioning(filled, [a.id], 'absolute').nodes[a.id].sizing).toEqual({ width: 'fixed', height: 'fixed' })
  })

  it('並べ替えは、並びに加わる子の中で 1 つずらす。端なら変えない', () => {
    const { page, frame, a, b, c } = fixture()
    expect(childrenOf(moveInLayout(page, [a.id], 1), frame.id)).toEqual([b.id, a.id, c.id])
    expect(childrenOf(moveInLayout(page, [b.id, c.id], -1), frame.id)).toEqual([b.id, c.id, a.id])
    expect(moveInLayout(page, [c.id], 1)).toBe(page)
    // 外した子は飛ばす
    const out = setLayoutPositioning(page, [b.id], 'absolute')
    expect(childrenOf(moveInLayout(out, [a.id], 1), frame.id)).toEqual([c.id, b.id, a.id])
    expect(moveInLayout(out, [b.id], 1)).toBe(out)
  })
})

describe('折り返し', () => {
  /** 幅 120 の固定のフレーム（左右の余白 20、上下 5、間隔 10）。中に収まる幅は 80 */
  const narrow = (layout: Partial<AutoLayout> = {}) => {
    const { page, frame, ...rest } = fixture({ wrap: true, crossGap: 4, ...layout }, { width: 'fixed', height: 'hug' })
    return { page: relayout(setSize(page, [frame.id], { width: 120 })), frame, ...rest }
  }

  it('収まらない子を次の行へ送り、高さを中身に合わせる', () => {
    const { page, frame, a, b, c } = narrow()
    // a 30 + 10 + b 50 = 90 > 80 なので b は次の行。b + 10 + c 20 = 80 は収まる
    expect(at(page, a.id)).toEqual({ x: 20, y: 5 })
    expect(at(page, b.id)).toEqual({ x: 20, y: 29 })
    expect(at(page, c.id)).toEqual({ x: 80, y: 29 })
    // 高さ: 余白 5 × 2 + 1 行目 20 + 行の間隔 4 + 2 行目 40
    expect(sizeOf(page, frame.id)).toEqual({ width: 120, height: 74 })
  })

  it('揃え方は、行の中と、行のまとまりの両方に効く', () => {
    const { page, a, c } = narrow({ align: 'end' })
    expect(page.nodes[c.id].y).toBe(59)
    const tall = relayout(updateNode(page, page.rootIds[0], { sizing: { width: 'fixed', height: 'fixed' } }))
    const higher = relayout(setSize(tall, [tall.rootIds[0]], { height: 100 }))
    // 内側 90 に中身 64。余った 26 だけ下へ
    expect(higher.nodes[a.id].y).toBe(31)
  })

  it('行の配置を「均等に配る」にすると、直交する向きの余りを行の間に配る', () => {
    const { page, a, b } = narrow({ alignContent: 'space-between', align: 'end' })
    const fixed = relayout(updateNode(page, page.rootIds[0], { sizing: { width: 'fixed', height: 'fixed' } }))
    const higher = relayout(setSize(fixed, [fixed.rootIds[0]], { height: 100 }))
    // 内側 90 に中身 64。余った 26 を 1 行目と 2 行目の間に入れる（揃え方は行の中だけに効く）
    expect(higher.nodes[a.id].y).toBe(5)
    expect(higher.nodes[b.id].y).toBe(55)
    // 余りがなければ先頭から詰める
    expect(page.nodes[a.id].y).toBe(5)
    expect(page.nodes[b.id].y).toBe(29)
  })

  it('寄せ方は行ごとに効く', () => {
    const { page, a, c } = narrow({ justify: 'end' })
    expect(page.nodes[a.id].x).toBe(70)
    expect(page.nodes[c.id].x).toBe(80)
  })

  it('並べる向きを中身に合わせていれば折り返さない', () => {
    const { page, frame } = fixture({ wrap: true })
    expect(sizeOf(page, frame.id)).toEqual({ width: 160, height: 50 })
  })

  it('折り返すようにすると、並べる向きは固定になる', () => {
    const { page, frame } = fixture()
    const next = setLayoutWrap(page, [frame.id], true)
    expect((next.nodes[frame.id] as FrameNode).layout).toMatchObject({ wrap: true })
    expect(next.nodes[frame.id].sizing).toEqual({ width: 'fixed', height: 'hug' })
  })

  it('並べる向きに伸ばすものは、その行の残りを分け合う。直交する向きは行の高さまで', () => {
    const { page, a, b, c } = narrow()
    const next = relayout(setLayoutFill(setLayoutFill(page, [c.id], 'width', true), [c.id], 'height', true))
    // c は 2 行目の b の後ろ: 80 - b 50 - 10 = 20。高さは 2 行目の b と同じ 40
    expect(sizeOf(next, c.id)).toEqual({ width: 20, height: 40 })
    expect(at(next, c.id)).toEqual({ x: 80, y: 29 })
    expect(at(next, b.id)).toEqual({ x: 20, y: 29 })
    expect(at(next, a.id)).toEqual({ x: 20, y: 5 })
    // 下限があれば、その大きさで数える: b 50 + 10 + 30 > 80 なので 3 行目へ
    const min = relayout(updateNode(next, c.id, { minWidth: 30 }))
    expect(at(min, c.id)).toEqual({ x: 20, y: 73 })
    // 行に伸ばすものしかなければ、行の高さはいまの高さのまま
    expect(sizeOf(min, c.id)).toEqual({ width: 80, height: 40 })
  })

  it('ドラッグで入れる位置は、ポインタのある行で決める', () => {
    const { page, frame, a, b, c } = narrow()
    const order = (scene: Scene) => (scene.nodes[frame.id] as FrameNode).children
    // 2 行目（ページの y 129〜169）の c の右へ
    expect(order(placeInLayout(page, [a.id], frame.id, { x: 210, y: 140 }))).toEqual([b.id, c.id, a.id])
    // 2 行目の先頭へ
    expect(order(placeInLayout(page, [c.id], frame.id, { x: 105, y: 140 }))).toEqual([a.id, c.id, b.id])
    // 1 行目の先頭へ
    expect(order(placeInLayout(page, [b.id], frame.id, { x: 105, y: 108 }))).toEqual([b.id, a.id, c.id])
  })
})

describe('大きさの下限・上限', () => {
  const fixed = () => fixture({}, FIXED)

  it('中身に合わせるフレームの大きさを収める', () => {
    const { page, frame } = fixture()
    const wide = relayout(updateNode(page, frame.id, { minWidth: 200, maxHeight: 30 }))
    expect(sizeOf(wide, frame.id)).toEqual({ width: 200, height: 30 })
    // 固定の大きさには効かない
    const other = fixed()
    const fixedFrame = relayout(updateNode(other.page, other.frame.id, { maxWidth: 100 }))
    expect(sizeOf(fixedFrame, other.frame.id).width).toBe(300)
  })

  it('伸ばすものの上限を超えた分は、ほかの伸ばすものが分け合う', () => {
    const { page, a, b } = fixed()
    const filled = setLayoutFill(page, [a.id, b.id], 'width', true)
    const next = relayout(updateNode(filled, a.id, { maxWidth: 60 }))
    // 220 を 2 つで 110 ずつのはずが、a は 60 まで。残り 160 が b
    expect(sizeOf(next, a.id).width).toBe(60)
    expect(sizeOf(next, b.id).width).toBe(160)
    const min = relayout(updateNode(filled, a.id, { minWidth: 150 }))
    expect(sizeOf(min, a.id).width).toBe(150)
    expect(sizeOf(min, b.id).width).toBe(70)
  })

  it('直交する向きに伸ばすものにも効く', () => {
    const { page, a } = fixed()
    const next = relayout(updateNode(setLayoutFill(page, [a.id], 'height', true), a.id, { maxHeight: 50 }))
    expect(sizeOf(next, a.id).height).toBe(50)
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
    // 余白は 4 辺それぞれ、いまの子とフレームの辺との隙間。フレームの大きさも変わらない
    expect(result.layout).toMatchObject({ direction: 'horizontal', gap: 20, paddingTop: 30, paddingRight: 150, paddingBottom: 120, paddingLeft: 40 })
    expect(result).toMatchObject({ width: 400, height: 200 })
    expect(result.children).toEqual([left.id, middle.id, right.id])
    // 見た目の位置は変わらない
    expect(at(next, left.id)).toEqual({ x: 40, y: 30 })
    expect(at(next, middle.id)).toEqual({ x: 120, y: 30 })
    expect(at(next, right.id)).toEqual({ x: 200, y: 30 })
    expect(sizeOf(next, frame.id)).toEqual({ width: 400, height: 200 })
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
    expect(frame).toMatchObject({ x: 100, y: 100, width: 100, height: 20, name: 'Group', fills: [] })
    expect(frame.layout).toMatchObject({ direction: 'horizontal', gap: 20, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0 })
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
    expect(next.nodes[frame.id].sizing).toEqual({ width: 'fixed', height: 'hug' })
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
    const frame = { ...createFrame({ x: 0, y: 0, width: 10, height: 10 }), layout: LAYOUT, sizing: HUG }
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

describe('オートレイアウトの切り替えと設定', () => {
  it('フレームだけを自動で並べるようにし、外すと設定を消す', () => {
    const frame = createFrame({ x: 0, y: 0, width: 200, height: 100 })
    const rect = createRect({ x: 300, y: 0, width: 10, height: 10 })
    let page = insertNode(createPage(), frame)
    page = insertNode(page, rect)
    const on = setAutoLayoutEnabled(page, [frame.id, rect.id], true)
    expect((on.nodes[frame.id] as FrameNode).layout).not.toBeNull()
    expect(on.nodes[rect.id]).toBe(page.nodes[rect.id])
    // 自動で並べると中身に合わせる
    expect(on.nodes[frame.id].sizing).toEqual({ width: 'hug', height: 'hug' })
    const off = setAutoLayoutEnabled(on, [frame.id, rect.id], false)
    expect((off.nodes[frame.id] as FrameNode).layout).toBeNull()
    expect(off.nodes[rect.id]).toBe(page.nodes[rect.id])
    // やめると中身に合わせていた向きは固定になる
    expect(off.nodes[frame.id].sizing).toEqual({ width: 'fixed', height: 'fixed' })
  })

  it('setFrameSizing は自動で並べるフレームの大きさの決め方を変える。親いっぱいは親が自動で並べるときだけ', () => {
    const { page, frame, a } = fixture()
    const fixedWidth = setFrameSizing(page, [frame.id, a.id], 'width', 'fixed')
    expect(fixedWidth.nodes[frame.id].sizing).toEqual({ width: 'fixed', height: 'hug' })
    // フレームでないものは変えない
    expect(fixedWidth.nodes[a.id]).toBe(page.nodes[a.id])
    expect(setFrameSizing(page, [frame.id], 'width', 'hug')).toBe(page)
    // ページ直下のフレームは伸ばせない
    expect(setFrameSizing(page, [frame.id], 'width', 'fill')).toBe(page)
    const inner = { ...createFrame({ x: 0, y: 0, width: 10, height: 10 }), layout: LAYOUT, sizing: HUG }
    const nested = insertNode(page, inner, frame.id)
    const filled = setFrameSizing(nested, [inner.id], 'height', 'fill')
    expect(filled.nodes[inner.id].sizing).toEqual({ width: 'hug', height: 'fill' })
  })

  it('patchLayouts は自動で並べているフレームの設定だけを書き換える', () => {
    const { page, frame } = fixture()
    const plain = createFrame({ x: 500, y: 0, width: 50, height: 50 })
    const withPlain = insertNode(page, plain)
    const next = patchLayouts(withPlain, [frame.id, plain.id], { gap: 33 })
    expect((next.nodes[frame.id] as FrameNode).layout).toMatchObject({ gap: 33, direction: 'horizontal' })
    expect(next.nodes[plain.id]).toBe(withPlain.nodes[plain.id])
  })
})

describe('親の辺に固定する（constraints）', () => {
  /** 並べないフレーム（200 × 100）に、右下寄りの長方形（x 150, y 60, 30 × 20）を 1 つ */
  function setup(constraints: SceneNode['constraints'], layout: AutoLayout | null = null) {
    const frame = { ...createFrame({ x: 0, y: 0, width: 200, height: 100 }), layout, sizing: layout ? HUG : FIXED }
    const rect = { ...createRect({ x: 150, y: 60, width: 30, height: 20 }), constraints }
    const store = createEditorStore(createDocument())
    store.apply((base) => insertNode(insertNode(base, frame), rect, frame.id))
    return { store, frame, rect }
  }
  const node = (store: ReturnType<typeof createEditorStore>, id: string) => store.getState().page.nodes[id]

  it('右・下に固定すると、親が広がった分だけ動く', () => {
    const { store, frame, rect } = setup({ horizontal: 'end', vertical: 'end' })
    store.apply((base) => setSize(base, [frame.id], { width: 300, height: 150 }))
    expect(at(store.getState().page, rect.id)).toEqual({ x: 250, y: 110 })
    expect(sizeOf(store.getState().page, rect.id)).toEqual({ width: 30, height: 20 })
  })

  it('左右・上下は伸縮し、中央は半分だけ動き、拡大縮小は割合を保つ', () => {
    const stretch = setup({ horizontal: 'stretch', vertical: 'center' })
    stretch.store.apply((base) => setSize(base, [stretch.frame.id], { width: 300, height: 140 }))
    expect(node(stretch.store, stretch.rect.id)).toMatchObject({ x: 150, width: 130, y: 80, height: 20 })
    const scale = setup({ horizontal: 'scale', vertical: 'scale' })
    scale.store.apply((base) => setSize(base, [scale.frame.id], { width: 100, height: 50 }))
    expect(node(scale.store, scale.rect.id)).toMatchObject({ x: 75, width: 15, y: 30, height: 10 })
  })

  it('左・上（既定）なら動かない。一緒に動かした子や、新しく入れた子もそのまま', () => {
    const plain = setup({ horizontal: 'start', vertical: 'start' })
    plain.store.apply((base) => setSize(base, [plain.frame.id], { width: 300 }))
    expect(at(plain.store.getState().page, plain.rect.id)).toEqual({ x: 150, y: 60 })
    const { store, frame, rect } = setup({ horizontal: 'end', vertical: 'start' })
    store.apply((base) => updateNode(setSize(base, [frame.id], { width: 300 }), rect.id, { x: 10 }))
    expect(node(store, rect.id).x).toBe(10)
  })

  it('Undo で親と一緒に戻る', () => {
    const { store, frame, rect } = setup({ horizontal: 'end', vertical: 'start' })
    store.apply((base) => setSize(base, [frame.id], { width: 300 }))
    store.undo()
    expect(node(store, rect.id).x).toBe(150)
  })

  it('自動で並べるフレームでは、並びから外した子だけが追従する。中身に合わせて大きさが変わったときも追従する', () => {
    const { store, frame, rect } = setup({ horizontal: 'end', vertical: 'start' }, { ...LAYOUT, paddingLeft: 0, paddingRight: 0 })
    // 並びに加わっている子は追従しない（位置は並べる側が決める）
    expect(node(store, rect.id).x).toBe(0)
    store.apply((base) => setLayoutPositioning(base, [rect.id], 'absolute'))
    store.apply((base) => updateNode(base, rect.id, { x: 170 }))
    const badge = createRect({ x: 0, y: 0, width: 100, height: 10 })
    const before = node(store, frame.id).width
    store.apply((base) => insertNode(base, badge, frame.id))
    const grown = node(store, frame.id).width - before
    expect(grown).toBeGreaterThan(0)
    expect(node(store, rect.id).x).toBe(170 + grown)
  })

  it('左右に伸縮したテキストは、幅を固定にして折り返す', () => {
    const frame = createFrame({ x: 0, y: 0, width: 200, height: 100 })
    const label = { ...createText({ x: 10, y: 10, width: 30, height: 20 }, 'abc'), constraints: { horizontal: 'stretch', vertical: 'start' } as const }
    const store = createEditorStore(createDocument())
    store.apply((base) => insertNode(insertNode(base, frame), label, frame.id))
    store.apply((base) => setSize(base, [frame.id], { width: 250 }))
    expect(node(store, label.id)).toMatchObject({ width: 80, sizing: { width: 'fixed' } })
  })
})
