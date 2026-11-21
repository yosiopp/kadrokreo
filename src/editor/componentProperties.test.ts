import { describe, expect, it } from 'vitest'
import { type InstanceNode, type MainNode, canBindProperty, derivedId, instanceProperties } from '../document/component.ts'
import type { DesignDocument, FrameNode } from '../document/types.ts'
import {
  addComponentProperty,
  bindComponentProperty,
  removeComponentProperty,
  renameComponentProperty,
  setComponentDescription,
  setInstanceProperty,
  unbindComponentProperty,
} from './componentProperties.ts'
import { createInstance, makeComponent, pushOverrides, syncComponents } from './components.ts'
import { createFrame, createRect, createText } from './nodes.ts'
import { createDocument, updatePage } from './operations/document.ts'
import { insertNode } from './operations/tree.ts'

/** ボタン（ラベル・印・入れ子のアイコン）の元と、そのインスタンス。アイコンの元は丸と四角の 2 つ */
function fixture() {
  const button = { ...createFrame({ x: 0, y: 0, width: 120, height: 40 }), name: 'ボタン' }
  const label = { ...createText({ x: 20, y: 10, width: 40, height: 20 }, 'OK'), name: 'ラベル' }
  const mark = { ...createRect({ x: 0, y: 0, width: 8, height: 8 }), name: '印' }
  const circle = { ...createFrame({ x: 300, y: 0, width: 16, height: 16 }), name: '丸' }
  const square = { ...createFrame({ x: 400, y: 0, width: 16, height: 16 }), name: '四角' }
  let doc = createDocument()
  const pageId = doc.pages[0].id
  doc = updatePage(doc, pageId, (page) => {
    let next = insertNode(page, button)
    next = insertNode(next, label, button.id)
    next = insertNode(next, mark, button.id)
    next = makeComponent(insertNode(next, circle), circle.id)
    next = makeComponent(insertNode(next, square), square.id)
    return makeComponent(next, button.id)
  })
  const componentOf = (id: string) => (doc.pages[0].nodes[id] as FrameNode).component!.id
  const icon = createInstance(doc, pageId, componentOf(circle.id), { center: { x: 100, y: 20 }, parentId: button.id })
  doc = syncComponents(icon.document)
  const instance = createInstance(doc, pageId, componentOf(button.id))
  doc = syncComponents(instance.document)
  return {
    doc, pageId, button, label, mark, iconId: icon.id!, instanceId: instance.id!,
    circleComponent: componentOf(circle.id), squareComponent: componentOf(square.id),
  }
}

const mainOf = (doc: DesignDocument, id: string) => doc.pages[0].nodes[id] as MainNode
const instanceOf = (doc: DesignDocument, id: string) => doc.pages[0].nodes[id] as InstanceNode

describe('説明文とプロパティの定義', () => {
  it('説明文を変える', () => {
    const { doc, button } = fixture()
    const page = setComponentDescription(doc.pages[0], button.id, '主な操作に使う')
    expect(mainOf({ ...doc, pages: [page] }, button.id).component.description).toBe('主な操作に使う')
    expect(setComponentDescription(page, button.id, '主な操作に使う')).toBe(page)
  })

  it('種類の合うノードにだけ結べる。名前はノードの名前から、重なれば番号を付ける', () => {
    const { doc, button, label, mark, iconId } = fixture()
    let page = doc.pages[0]
    expect(canBindProperty(page, button.id, 'text', label.id)).toBe(true)
    expect(canBindProperty(page, button.id, 'text', mark.id)).toBe(false)
    expect(canBindProperty(page, button.id, 'instance', iconId)).toBe(true)
    expect(canBindProperty(page, button.id, 'boolean', button.id)).toBe(false)
    // 入れ子のインスタンスの中身（写し）には結べない
    const iconCopy = (page.nodes[iconId] as FrameNode).children[0]
    expect(iconCopy === undefined || !canBindProperty(page, button.id, 'boolean', iconCopy)).toBe(true)

    const text = addComponentProperty(page, button.id, 'text', label.id)
    expect(text.name).toBe('ラベル')
    page = text.scene
    page = addComponentProperty(page, button.id, 'boolean', label.id).scene
    expect(mainOf({ ...doc, pages: [page] }, button.id).component.properties.map((p) => p.name)).toEqual(['ラベル', 'ラベル 2'])
    expect(addComponentProperty(page, button.id, 'text', mark.id).name).toBeNull()
    expect(addComponentProperty(page, button.id, 'boolean', mark.id, 'ラベル').name).toBeNull()
  })

  it('結ぶ・外す・名前を変える・消す', () => {
    const { doc, button, label, mark } = fixture()
    let page = addComponentProperty(doc.pages[0], button.id, 'boolean', label.id, '表示').scene
    page = bindComponentProperty(page, button.id, '表示', mark.id)
    const properties = () => mainOf({ ...doc, pages: [page] }, button.id).component.properties
    expect(properties()).toEqual([{ name: '表示', type: 'boolean', targets: [label.id, mark.id] }])
    expect(bindComponentProperty(page, button.id, '表示', mark.id)).toBe(page)
    page = unbindComponentProperty(page, button.id, '表示', label.id)
    expect(properties()[0].targets).toEqual([mark.id])
    page = renameComponentProperty(page, button.id, '表示', '印を出す')
    expect(properties()[0].name).toBe('印を出す')
    expect(renameComponentProperty(page, button.id, '印を出す', ' ')).toBe(page)
    page = removeComponentProperty(page, button.id, '印を出す')
    expect(properties()).toEqual([])
  })
})

describe('インスタンスでのプロパティの値', () => {
  function withProperties() {
    const base = fixture()
    const doc = updatePage(base.doc, base.pageId, (page) => {
      let next = addComponentProperty(page, base.button.id, 'text', base.label.id, '文言').scene
      next = addComponentProperty(next, base.button.id, 'boolean', base.mark.id, '印').scene
      return addComponentProperty(next, base.button.id, 'instance', base.iconId, 'アイコン').scene
    })
    return { ...base, doc: syncComponents(doc) }
  }

  it('値は元の値から始まり、変えると結んだノードへの上書きになる', () => {
    const { doc, pageId, instanceId, label, mark, iconId, circleComponent, squareComponent } = withProperties()
    const states = () => instanceProperties(next, next.pages[0], instanceOf(next, instanceId))
    let next = doc
    expect(states().map(({ property, value, overridden }) => [property.name, value, overridden])).toEqual([
      ['文言', 'OK', false],
      ['印', true, false],
      ['アイコン', circleComponent, false],
    ])
    next = syncComponents(setInstanceProperty(next, pageId, instanceId, '文言', '送信'))
    next = syncComponents(setInstanceProperty(next, pageId, instanceId, '印', false))
    next = syncComponents(setInstanceProperty(next, pageId, instanceId, 'アイコン', squareComponent))
    expect(instanceOf(next, instanceId).component.overrides).toEqual({
      [label.id]: { text: '送信' },
      [mark.id]: { visible: false },
      [iconId]: { componentId: squareComponent },
    })
    const page = next.pages[0]
    expect(page.nodes[derivedId(instanceId, label.id)]).toMatchObject({ text: '送信' })
    expect(page.nodes[derivedId(instanceId, mark.id)]).toMatchObject({ visible: false })
    expect(page.nodes[derivedId(instanceId, iconId)]).toMatchObject({ name: '四角' })
    expect(states().map(({ value, overridden }) => [value, overridden])).toEqual([
      ['送信', true],
      [false, true],
      [squareComponent, true],
    ])
    // 元と同じ値にすると上書きは外れる
    next = syncComponents(setInstanceProperty(next, pageId, instanceId, '文言', 'OK'))
    expect(instanceOf(next, instanceId).component.overrides[label.id]).toBeUndefined()
  })

  it('元に反映すると、元の値（プロパティの既定値）が変わる', () => {
    const { doc, pageId, instanceId, label } = withProperties()
    let next = syncComponents(setInstanceProperty(doc, pageId, instanceId, '文言', '送信'))
    next = syncComponents(pushOverrides(next, pageId, [instanceId]))
    expect(next.pages[0].nodes[label.id]).toMatchObject({ text: '送信' })
    expect(instanceProperties(next, next.pages[0], instanceOf(next, instanceId))[0]).toMatchObject({ value: '送信', overridden: false })
  })

  it('種類の合わない値や、ないプロパティは変えない', () => {
    const { doc, pageId, instanceId } = withProperties()
    expect(setInstanceProperty(doc, pageId, instanceId, '文言', true)).toBe(doc)
    expect(setInstanceProperty(doc, pageId, instanceId, 'ない', 'x')).toBe(doc)
  })
})
