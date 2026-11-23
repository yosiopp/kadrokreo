import { describe, expect, it } from 'vitest'
import { solid } from '../../document/paint.ts'
import { createLine, createRect, createText } from '../nodes.ts'
import { createPage } from './document.ts'
import {
  convertEffect,
  convertPaint,
  movePaint,
  patchEffectAt,
  patchGradientAt,
  patchPaintAt,
  setCornerRadius,
  setFill,
  setShadow,
  setStroke,
  updateEffects,
  updatePaints,
  withStopAdded,
  withStopAt,
  withStopColor,
  withStopOffset,
  withStopRemoved,
} from './paints.ts'
import { insertNode, updateNode } from './tree.ts'

describe('塗り・グラデーション・影', () => {
  function shapes() {
    const rect = createRect({ x: 0, y: 0, width: 10, height: 10 })
    const text = createText({ x: 0, y: 20, width: 10, height: 10 })
    const line = createLine({ x: 0, y: 40, width: 10, height: 0 })
    let page = createPage()
    for (const node of [rect, text, line]) page = insertNode(page, node)
    return { page, rect, text, line }
  }
  /** いちばん上の塗りがグラデーションならそれ、そうでなければ null */
  const gradientOf = (page: ReturnType<typeof createPage>, id: string) => {
    const node = page.nodes[id]
    const top = 'fills' in node ? node.fills.at(-1) : undefined
    return top?.type === 'linear' ? top : null
  }

  it('withStopColor は index 番目（負なら後ろから）の色だけを変える', () => {
    const gradient = {
      type: 'linear' as const,
      x1: 0.5,
      y1: 0,
      x2: 0.5,
      y2: 1,
      stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }],
      opacity: 1,
      visible: true,
      blendMode: 'normal' as const,
    }
    expect(withStopColor(gradient, -1, '#ff0000').stops).toEqual([
      { offset: 0, color: '#000000' },
      { offset: 1, color: '#ff0000' },
    ])
    expect(withStopColor(gradient, 0, '#00ff00').stops[0].color).toBe('#00ff00')
    expect(gradient.stops[1].color).toBe('#ffffff')
  })

  it('塗りの種類を変えると、色を受け継ぐ', () => {
    const red = { type: 'solid' as const, color: '#ff0000', opacity: 1, visible: true, blendMode: 'normal' as const }
    const linear = convertPaint(red, 'linear')
    expect(linear).toEqual({ type: 'linear', x1: 0.5, y1: 0, x2: 0.5, y2: 1, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#ffffff' }], opacity: 1, visible: true, blendMode: 'normal' as const })
    const radial = convertPaint(linear, 'radial')
    expect(radial).toEqual({ type: 'radial', cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5, stops: linear.type === 'linear' ? linear.stops : [], opacity: 1, visible: true, angle: 0, blendMode: 'normal' as const })
    expect(convertPaint(radial, 'solid')).toEqual(red)
    expect(convertPaint(red, 'solid')).toBe(red)
    // 角度は、円形から中心を、直線から向きを受け継ぐ。隠した塗りは隠したまま
    const moved = { ...radial, cx: 0.2, cy: 0.8 } as typeof radial
    expect(convertPaint(moved, 'conic')).toMatchObject({ type: 'conic', cx: 0.2, cy: 0.8, angle: 0 })
    expect(convertPaint({ ...linear, x1: 0, y1: 0, x2: 1, y2: 1, visible: false } as typeof linear, 'conic')).toMatchObject({ type: 'conic', cx: 0.5, angle: 45, visible: false, blendMode: 'normal' as const })
    expect(convertPaint(convertPaint(moved, 'conic'), 'radial')).toMatchObject({ cx: 0.2, cy: 0.8, rx: 0.5 })
  })

  it('グラデーションの色を足す・消す・位置を変える', () => {
    const gradient = convertPaint({ type: 'solid', color: '#000000', opacity: 1, visible: true, blendMode: 'normal' as const }, 'linear') as Extract<ReturnType<typeof convertPaint>, { type: 'linear' }>
    const three = withStopAdded(gradient)
    expect(three.stops).toEqual([
      { offset: 0, color: '#000000' },
      { offset: 0.5, color: '#808080' },
      { offset: 1, color: '#ffffff' },
    ])
    // いちばん離れた隣どうしの間に足す
    expect(withStopAdded(three).stops.map((stop) => stop.offset)).toEqual([0, 0.25, 0.5, 1])
    // 位置を変えると並べ直す
    expect(withStopOffset(three, 0, 0.8).stops.map((stop) => stop.color)).toEqual(['#808080', '#000000', '#ffffff'])
    expect(withStopOffset(three, 0, 2).stops).toContainEqual({ offset: 1, color: '#000000' })
    expect(withStopRemoved(three, 1).stops).toEqual(gradient.stops)
    // 2 色より減らさない
    expect(withStopRemoved(gradient, 0)).toBe(gradient)
  })

  it('withStopAt は位置に、そこでの色を足す', () => {
    const gradient = convertPaint({ type: 'solid', color: '#000000', opacity: 1, visible: true, blendMode: 'normal' as const }, 'linear') as Extract<ReturnType<typeof convertPaint>, { type: 'linear' }>
    const added = withStopAt(gradient, 0.25)
    expect(added.index).toBe(1)
    expect(added.gradient.stops).toEqual([
      { offset: 0, color: '#000000' },
      { offset: 0.25, color: '#404040' },
      { offset: 1, color: '#ffffff' },
    ])
    // 端より外は端の色
    expect(withStopAt({ ...gradient, stops: [{ offset: 0.5, color: '#ff0000' }, { offset: 1, color: '#ffffff' }] }, 0.1)).toMatchObject({
      index: 0,
      gradient: { stops: [{ offset: 0.1, color: '#ff0000' }, { offset: 0.5 }, { offset: 1 }] },
    })
  })

  it('塗りの不透明度は、種類や色を変えても保つ', () => {
    const half = { type: 'solid' as const, color: '#ff0000', opacity: 0.5, visible: true, blendMode: 'normal' as const }
    expect(convertPaint(half, 'radial').opacity).toBe(0.5)
    expect(convertPaint(convertPaint(half, 'linear'), 'solid')).toEqual(half)
    const { page, rect } = shapes()
    const faded = updatePaints(page, [rect.id], 'fills', () => [half])
    expect(setFill(faded, [rect.id], '#00ff00').nodes[rect.id]).toMatchObject({ fills: [{ color: '#00ff00', opacity: 0.5 }] })
  })

  it('塗り・線の色を変えても、表示と描画モードは受け継ぐ（setFill と setStroke で同じ）', () => {
    const hidden = { type: 'solid' as const, color: '#ff0000', opacity: 0.5, visible: false, blendMode: 'multiply' as const }
    const { page, rect } = shapes()
    const both = updatePaints(updatePaints(page, [rect.id], 'fills', () => [hidden]), [rect.id], 'strokes', () => [hidden])
    const keep = { color: '#00ff00', opacity: 0.5, visible: false, blendMode: 'multiply' }
    expect(setFill(both, [rect.id], '#00ff00').nodes[rect.id]).toMatchObject({ fills: [keep] })
    expect(setStroke(both, [rect.id], '#00ff00').nodes[rect.id]).toMatchObject({ strokes: [keep] })
  })

  it('塗りを足す・消す・並べ替える。テキストの塗りと直線の線は空にしない', () => {
    const { page, rect, text, line } = shapes()
    const two = updatePaints(page, [rect.id, text.id], 'fills', (fills) => [...fills, ...solid('#ff0000')])
    expect(two.nodes[rect.id]).toMatchObject({ fills: [...solid('#d9d9d9'), ...solid('#ff0000')] })
    const swapped = updatePaints(two, [rect.id], 'fills', (fills) => movePaint(fills, 1, 0))
    expect(swapped.nodes[rect.id]).toMatchObject({ fills: [...solid('#ff0000'), ...solid('#d9d9d9')] })
    const emptied = updatePaints(page, [rect.id, text.id, line.id], 'fills', () => [])
    expect(emptied.nodes[rect.id]).toMatchObject({ fills: [] })
    expect(emptied.nodes[text.id]).toBe(page.nodes[text.id])
    expect(updatePaints(page, [line.id], 'strokes', () => [])).toBe(page)
    // 上限を超える数にはしない
    const many = Array.from({ length: 17 }, () => solid('#000000')[0])
    expect(updatePaints(page, [rect.id], 'fills', () => many)).toBe(page)
  })

  it('index 番目の塗りだけを書き換える。グラデーションの書き換えは単色に当てない', () => {
    const { page, rect } = shapes()
    const layered = updateNode(page, rect.id, { fills: [...solid('#000000'), convertPaint(solid('#ff0000')[0], 'radial')] })
    const moved = patchGradientAt(layered, [rect.id], 'fills', 1, (g) => (g.type === 'radial' ? { ...g, cx: 0.2 } : g))
    expect(moved.nodes[rect.id]).toMatchObject({ fills: [{ type: 'solid' }, { type: 'radial', cx: 0.2, opacity: 1, visible: true, angle: 0, blendMode: 'normal' as const }] })
    expect(patchGradientAt(layered, [rect.id], 'fills', 0, (g) => ({ ...g, stops: [] }))).toEqual(layered)
    const recolored = patchPaintAt(layered, [rect.id], 'fills', 0, () => solid('#00ff00')[0])
    expect(recolored.nodes[rect.id]).toMatchObject({ fills: [...solid('#00ff00'), { type: 'radial' }] })
    // その番目がないノードは変えない
    expect(patchPaintAt(layered, [rect.id], 'fills', 5, () => solid('#00ff00')[0])).toBe(layered)
  })

  it('塗りの色を変えると、グラデーションの始まりの色も変わる。塗りをなくすとグラデーションもやめる', () => {
    const { page, rect } = shapes()
    const on = updatePaints(page, [rect.id], 'fills', (fills) => [convertPaint(fills[0], 'linear')])
    const red = setFill(on, [rect.id], '#ff0000')
    expect(gradientOf(red, rect.id)).toMatchObject({ stops: [{ color: '#ff0000' }, { color: '#ffffff' }] })
    const none = setFill(red, [rect.id], null)
    expect(none.nodes[rect.id]).toMatchObject({ fills: [] })
  })

  it('塗りの操作は、いちばん上の塗りだけを変える', () => {
    const { page, rect } = shapes()
    const layered = updateNode(page, rect.id, { fills: [...solid('#000000'), ...solid('#00ff00')] })
    expect(setFill(layered, [rect.id], '#ff0000').nodes[rect.id]).toMatchObject({
      fills: [...solid('#000000'), ...solid('#ff0000')],
    })
    expect(setFill(layered, [rect.id], null).nodes[rect.id]).toMatchObject({ fills: solid('#000000') })
  })

  it('テキストの塗りは消せない（null なら変えない）。塗りのない直線も null なら変えない', () => {
    const { page, text, line } = shapes()
    expect(setFill(page, [text.id, line.id], null)).toBe(page)
    const blue = setFill(page, [text.id, line.id], '#0000ff')
    expect(blue.nodes[text.id]).toMatchObject({ fills: solid('#0000ff') })
    // 直線も見た目（Style）を持つパスなので、色を指定すると塗りが付く
    expect(blue.nodes[line.id]).toMatchObject({ fills: solid('#0000ff') })
  })

  it('線の色を変えると、いちばん上の線を単色に置き換える。null で外し、テキストは変えない', () => {
    const { page, rect, text, line } = shapes()
    const red = setStroke(page, [rect.id, text.id, line.id], '#ff0000')
    expect(red.nodes[rect.id]).toMatchObject({ strokes: solid('#ff0000') })
    expect(red.nodes[line.id]).toMatchObject({ strokes: solid('#ff0000') })
    expect(red.nodes[text.id]).toBe(page.nodes[text.id])
    const none = setStroke(red, [rect.id, line.id], null)
    expect(none.nodes[rect.id]).toMatchObject({ strokes: [] })
    // 直線の線は空にできない（updatePaints と同じ）
    expect(none.nodes[line.id]).toBe(red.nodes[line.id])
    // 線のないものから外しても変わらない
    expect(setStroke(page, [rect.id], null)).toBe(page)
  })

  it('影を付けると最初の効果を置き換え、null で外す', () => {
    const { page, rect } = shapes()
    const shadow = { type: 'drop-shadow' as const, x: 0, y: 4, blur: 12, color: '#000000', opacity: 0.25, visible: true, spread: 0 , blendMode: 'normal' as const}
    const second = { ...shadow, y: 8 }
    const two = updateNode(page, rect.id, { effects: [shadow, second] })
    const replaced = setShadow(two, [rect.id], { ...shadow, blur: 2 })
    expect(replaced.nodes[rect.id]).toMatchObject({ effects: [{ ...shadow, blur: 2 }, second] })
    expect(setShadow(two, [rect.id], null).nodes[rect.id]).toMatchObject({ effects: [second] })
    expect(setShadow(page, [rect.id], shadow).nodes[rect.id]).toMatchObject({ effects: [shadow] })
    expect(setShadow(page, [rect.id], null)).toBe(page)
  })

  it('影を足し、index 番目の影だけを書き換える', () => {
    const { page, rect } = shapes()
    const other = createRect({ x: 50, y: 0, width: 10, height: 10 })
    let next = insertNode(page, other)
    const shadow = { type: 'drop-shadow' as const, x: 0, y: 4, blur: 12, color: '#000000', opacity: 0.25, visible: true, spread: 0, blendMode: 'normal' as const }
    next = updateEffects(next, [rect.id], (effects) => [...effects, shadow, { ...shadow, y: 8 }])
    const moved = patchEffectAt(next, [rect.id, other.id], 1, { blur: 20 })
    expect(moved.nodes[rect.id]).toMatchObject({ effects: [shadow, { ...shadow, y: 8, blur: 20 }] })
    expect(moved.nodes[other.id]).toBe(next.nodes[other.id])
  })
})

describe('角丸', () => {
  it('4 隅まとめてか 1 隅だけ変え、揃えば数値 1 つにまとめる', () => {
    const rect = createRect({ x: 0, y: 0, width: 10, height: 10 })
    const text = createText({ x: 0, y: 20, width: 10, height: 10 })
    let page = createPage()
    for (const node of [rect, text]) page = insertNode(page, node)
    const one = setCornerRadius(page, [rect.id, text.id], 1, 8)
    expect(one.nodes[rect.id]).toMatchObject({ cornerRadius: [0, 8, 0, 0] })
    expect(one.nodes[text.id]).toBe(page.nodes[text.id])
    let back = one
    for (const corner of [0, 2, 3]) back = setCornerRadius(back, [rect.id], corner, 8)
    expect(back.nodes[rect.id]).toMatchObject({ cornerRadius: 8 })
    expect(setCornerRadius(one, [rect.id], null, 4).nodes[rect.id]).toMatchObject({ cornerRadius: 4 })
  })
})

describe('効果の種類の切り替え', () => {
  const shadow = { type: 'drop-shadow' as const, x: 1, y: 2, blur: 6, spread: 3, blendMode: 'normal' as const, color: '#ff0000', opacity: 0.5, visible: true }

  it('影どうしは値を受け継ぎ、影とぼかしの間ではぼかしの長さだけを受け継ぐ', () => {
    expect(convertEffect(shadow, 'inner-shadow')).toEqual({ ...shadow, type: 'inner-shadow' })
    expect(convertEffect(shadow, 'layer-blur')).toEqual({ type: 'layer-blur', blur: 6, visible: true })
    const back = convertEffect({ type: 'background-blur', blur: 10, visible: false }, 'drop-shadow')
    expect(back).toMatchObject({ type: 'drop-shadow', blur: 10, visible: false, spread: 0, blendMode: 'normal', color: '#000000' })
  })

  it('patchEffectAt で種類を変えると形を揃え、その種類にない項目は当てない', () => {
    let page = createPage()
    const rect = { ...createRect({ x: 0, y: 0, width: 10, height: 10 }), effects: [shadow] }
    page = insertNode(page, rect)
    const blurred = patchEffectAt(page, [rect.id], 0, { type: 'layer-blur' })
    expect(blurred.nodes[rect.id]).toMatchObject({ effects: [{ type: 'layer-blur', blur: 6, visible: true }] })
    // ぼかしにずれはないので、x は当てない
    const ignored = patchEffectAt(blurred, [rect.id], 0, { x: 5, blur: 8 })
    expect(ignored.nodes[rect.id]).toMatchObject({ effects: [{ type: 'layer-blur', blur: 8, visible: true }] })
    expect((ignored.nodes[rect.id] as typeof rect).effects[0]).not.toHaveProperty('x')
  })
})
