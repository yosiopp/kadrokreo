import { describe, expect, it } from 'vitest'
import { solid } from '../../document/paint.ts'
import { createLine, createRect, createText } from '../nodes.ts'
import { createPage } from './document.ts'
import {
  patchGradients,
  patchShadows,
  setFill,
  setGradientEnabled,
  setShadow,
  setStroke,
  withStopColor,
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
      angle: 90,
      stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }],
    }
    expect(withStopColor(gradient, -1, '#ff0000').stops).toEqual([
      { offset: 0, color: '#000000' },
      { offset: 1, color: '#ff0000' },
    ])
    expect(withStopColor(gradient, 0, '#00ff00').stops[0].color).toBe('#00ff00')
    expect(gradient.stops[1].color).toBe('#ffffff')
  })

  it('グラデーションを付けると、いまの色から白への上から下のグラデーションになる。外すと単色に戻る', () => {
    const { page, rect, line } = shapes()
    const on = setGradientEnabled(page, [rect.id, line.id], true)
    expect(gradientOf(on, rect.id)).toEqual({
      type: 'linear',
      angle: 90,
      stops: [{ offset: 0, color: '#d9d9d9' }, { offset: 1, color: '#ffffff' }],
    })
    // 塗りを持たないものは変えない
    expect(on.nodes[line.id]).toBe(page.nodes[line.id])
    // 付いているものに付け直しても変わらない
    expect(setGradientEnabled(on, [rect.id], true)).toBe(on)
    const off = setGradientEnabled(on, [rect.id], false)
    expect(gradientOf(off, rect.id)).toBeNull()
    expect(off.nodes[rect.id]).toMatchObject({ fills: solid('#d9d9d9') })
  })

  it('塗りの色を変えると、グラデーションの始まりの色も変わる。塗りをなくすとグラデーションもやめる', () => {
    const { page, rect } = shapes()
    const on = setGradientEnabled(page, [rect.id], true)
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
    expect(none.nodes[line.id]).toMatchObject({ strokes: [] })
    // 線のないものから外しても変わらない
    expect(setStroke(page, [rect.id], null)).toBe(page)
  })

  it('影を付けると最初の効果を置き換え、null で外す', () => {
    const { page, rect } = shapes()
    const shadow = { type: 'drop-shadow' as const, x: 0, y: 4, blur: 12, color: '#000000', opacity: 0.25 }
    const second = { ...shadow, y: 8 }
    const two = updateNode(page, rect.id, { effects: [shadow, second] })
    const replaced = setShadow(two, [rect.id], { ...shadow, blur: 2 })
    expect(replaced.nodes[rect.id]).toMatchObject({ effects: [{ ...shadow, blur: 2 }, second] })
    expect(setShadow(two, [rect.id], null).nodes[rect.id]).toMatchObject({ effects: [second] })
    expect(setShadow(page, [rect.id], shadow).nodes[rect.id]).toMatchObject({ effects: [shadow] })
    expect(setShadow(page, [rect.id], null)).toBe(page)
  })

  it('グラデーションと影は、付いているものだけを書き換える', () => {
    const { page, rect } = shapes()
    const other = createRect({ x: 50, y: 0, width: 10, height: 10 })
    let next = insertNode(page, other)
    next = setGradientEnabled(next, [rect.id], true)
    const angled = patchGradients(next, [rect.id, other.id], (g) => ({ ...g, angle: 45 }))
    expect(gradientOf(angled, rect.id)).toMatchObject({ angle: 45 })
    expect(angled.nodes[other.id]).toBe(next.nodes[other.id])

    const shadow = { type: 'drop-shadow' as const, x: 0, y: 4, blur: 12, color: '#000000', opacity: 0.25 }
    next = updateNode(next, rect.id, { effects: [shadow] })
    const moved = patchShadows(next, [rect.id, other.id], { blur: 20 })
    expect(moved.nodes[rect.id]).toMatchObject({ effects: [{ ...shadow, blur: 20 }] })
    expect(moved.nodes[other.id]).toBe(next.nodes[other.id])
  })
})
