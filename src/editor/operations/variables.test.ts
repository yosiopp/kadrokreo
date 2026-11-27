import { describe, expect, it } from 'vitest'
import { docOf, frame, rect, sceneOf } from '../../document/testNodes.ts'
import type { DesignDocument, Gradient, Paint } from '../../document/types.ts'
import { patchEffectAt, withStopColor, withStopVariable } from './paints.ts'
import { VariableError, addCollection, addMode, addVariable, removeCollection, removeMode, removeVariable, setFrameMode, setVariableValue } from './variables.ts'

const fill = (variable: string, color = '#000000'): Paint => ({ type: 'solid', color, variable, opacity: 1, visible: true, blendMode: 'normal' })

function setup() {
  let doc: DesignDocument = docOf(
    sceneOf(
      frame({ id: 'f', children: ['r'] }),
      rect({ id: 'r', parentId: 'f', fills: [fill('x')] }),
      frame({ id: 'i', component: { id: 'm', role: 'instance', overrides: { n: { strokes: [fill('x')] } }, flipX: false, flipY: false } }),
    ),
  )
  const theme = addCollection(doc, 'Theme', 'Light')
  doc = theme.document
  const primary = addVariable(doc, theme.id, 'color/primary', 'color', '#123456')
  doc = primary.document
  const brand = addCollection(doc, 'Brand')
  doc = brand.document
  const link = addVariable(doc, brand.id, 'color/link', 'color', { alias: primary.id })
  doc = link.document
  return { doc, theme: theme.id, brand: brand.id, primary: primary.id, link: link.id }
}

describe('変数の操作', () => {
  it('モードを足すと、値は最初のモードのものを写す。最後のモードは消せない', () => {
    const { doc, theme, primary } = setup()
    const dark = addMode(doc, theme, 'Dark')
    expect(dark.document.collections[0].variables[0].values[dark.id]).toBe('#123456')
    expect(() => addMode(dark.document, theme, 'Dark')).toThrow(VariableError)
    const withSelection = setFrameMode(dark.document, 'p1', 'f', theme, dark.id)
    expect(withSelection.pages[0].nodes.f).toMatchObject({ modes: { [theme]: dark.id } })
    const removed = removeMode(withSelection, theme, dark.id)
    expect(removed.pages[0].nodes.f).not.toHaveProperty('modes')
    expect(() => removeMode(removed, theme, removed.collections[0].modes[0].id)).toThrow('最後のモード')
    expect(setVariableValue(doc, primary, '#123456')).toBe(doc)
  })

  it('値の形・別名の先・循環を確かめる', () => {
    const { doc, primary, link } = setup()
    expect(() => setVariableValue(doc, primary, 'red')).toThrow('#rrggbb')
    expect(() => setVariableValue(doc, primary, { alias: 'nope' })).toThrow('別名の先')
    expect(() => setVariableValue(doc, primary, { alias: link })).toThrow('循環')
    const number = addVariable(doc, doc.collections[0].id, 'space', 'number', 4)
    expect(() => setVariableValue(number.document, primary, { alias: number.id })).toThrow('種類が違います')
  })

  it('変数を消すと、つながりを外して値を残し、別のコレクションからの別名は値に置き換える', () => {
    const { doc, primary, link } = setup()
    const withNodes = { ...doc, pages: [{ ...doc.pages[0], nodes: { ...doc.pages[0].nodes, r: rect({ id: 'r', parentId: 'f', fills: [fill(primary, '#123456')] }) } }] }
    const removed = removeVariable(withNodes, primary)
    expect(removed.pages[0].nodes.r).toMatchObject({ fills: [{ color: '#123456' }] })
    expect((removed.pages[0].nodes.r as { fills: object[] }).fills[0]).not.toHaveProperty('variable')
    expect(removed.collections[1].variables.find((v) => v.id === link)?.values).toEqual({ [removed.collections[1].modes[0].id]: '#123456' })
  })

  it('コレクションを消すと、その変数へのインスタンスの上書きの塗りのつながりも外す', () => {
    const { doc, brand, link } = setup()
    const bound = { ...doc, pages: [{ ...doc.pages[0], nodes: { ...doc.pages[0].nodes, i: frame({ id: 'i', component: { id: 'm', role: 'instance', overrides: { n: { strokes: [fill(link)] } }, flipX: false, flipY: false } }) } }] }
    const removed = removeCollection(bound, brand)
    expect(removed.collections).toHaveLength(1)
    const node = removed.pages[0].nodes.i
    expect(node.type === 'frame' && node.component?.role === 'instance' && node.component.overrides.n.strokes?.[0]).not.toHaveProperty('variable')
  })

  it('色を直接決めると、グラデーションの色と影のつながりは外れる', () => {
    const gradient: Gradient = {
      type: 'linear', x1: 0, y1: 0, x2: 1, y2: 0, opacity: 1, visible: true, blendMode: 'normal',
      stops: [{ offset: 0, color: '#000000', opacity: 1, variable: 'v' }, { offset: 1, color: '#ffffff', opacity: 1 }],
    }
    expect(withStopColor(gradient, 0, '#ff0000').stops[0]).toEqual({ offset: 0, color: '#ff0000', opacity: 1 })
    expect(withStopVariable(gradient, 1, 'w', '#00ff00').stops[1]).toEqual({ offset: 1, color: '#00ff00', opacity: 1, variable: 'w' })
    expect(withStopVariable(gradient, 0, null, '#00ff00').stops[0]).toEqual({ offset: 0, color: '#000000', opacity: 1 })
    const scene = sceneOf(rect({ id: 'r', effects: [{ type: 'drop-shadow', x: 0, y: 0, blur: 0, spread: 0, color: '#000000', variable: 'v', opacity: 1, visible: true, blendMode: 'normal' }] }))
    expect(patchEffectAt(scene, ['r'], 0, { color: '#ff0000' }).nodes.r.effects[0]).not.toHaveProperty('variable')
    expect(patchEffectAt(scene, ['r'], 0, { blur: 4 }).nodes.r.effects[0]).toMatchObject({ variable: 'v', blur: 4 })
    expect(patchEffectAt(scene, ['r'], 0, { variable: 'w', color: '#00ff00' }).nodes.r.effects[0]).toMatchObject({ variable: 'w', color: '#00ff00' })
  })
})
