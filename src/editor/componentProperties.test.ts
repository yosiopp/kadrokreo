import { describe, expect, it } from 'vitest'
import { type InstanceNode, type MainNode, derivedId } from '../document/component.ts'
import { canBindProperty, instanceProperties } from '../document/componentProperties.ts'
import type { DesignDocument, FrameNode } from '../document/types.ts'
import {
  addComponentProperty,
  alignVariantProperties,
  setVariantSetDescription,
  bindComponentProperty,
  moveComponentProperty,
  removeComponentProperty,
  renameComponentProperty,
  setComponentDescription,
  setInstanceProperty,
  setPreferredComponents,
  unbindComponentProperty,
} from './componentProperties.ts'
import { createInstance, makeComponent, pushOverrides, swapNestedInstance, syncComponents } from './components.ts'
import { addVariant } from './variants.ts'
import { createFrame, createRect, createText } from './nodes.ts'
import { createDocument, updatePage } from './operations/document.ts'
import { insertNode, updateNode } from './operations/tree.ts'

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
    expect(properties()).toEqual([{ name: '表示', type: 'boolean', targets: [label.id, mark.id], preferred: [] }])
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

describe('並べ替えと差し替えの候補', () => {
  it('プロパティを並べ替える。範囲の外は端に、同じ位置なら変えない', () => {
    const { doc, button, label, mark, iconId } = fixture()
    let page = addComponentProperty(doc.pages[0], button.id, 'text', label.id, 'A').scene
    page = addComponentProperty(page, button.id, 'boolean', mark.id, 'B').scene
    page = addComponentProperty(page, button.id, 'instance', iconId, 'C').scene
    const names = () => mainOf({ ...doc, pages: [page] }, button.id).component.properties.map((p) => p.name)
    page = moveComponentProperty(page, button.id, 'C', 0)
    expect(names()).toEqual(['C', 'A', 'B'])
    page = moveComponentProperty(page, button.id, 'C', 9)
    expect(names()).toEqual(['A', 'B', 'C'])
    expect(moveComponentProperty(page, button.id, 'A', 0)).toBe(page)
    expect(moveComponentProperty(page, button.id, 'ない', 1)).toBe(page)
  })

  it('差し替えのプロパティにだけ候補を持てる。重なりはまとめる', () => {
    const { doc, button, label, iconId, circleComponent, squareComponent } = fixture()
    let page = addComponentProperty(doc.pages[0], button.id, 'instance', iconId, 'アイコン').scene
    page = addComponentProperty(page, button.id, 'text', label.id, '文言').scene
    page = setPreferredComponents(page, button.id, 'アイコン', [squareComponent, circleComponent, squareComponent])
    const properties = () => mainOf({ ...doc, pages: [page] }, button.id).component.properties
    expect(properties()[0].preferred).toEqual([squareComponent, circleComponent])
    expect(setPreferredComponents(page, button.id, 'アイコン', [squareComponent, circleComponent])).toBe(page)
    expect(setPreferredComponents(page, button.id, '文言', [squareComponent])).toBe(page)
  })
})

describe('入れ子のインスタンスの中のノード', () => {
  /** ボタンの元を入れたカードの元と、カードのインスタンス */
  function cardFixture() {
    const base = fixture()
    const card = { ...createFrame({ x: 0, y: 200, width: 200, height: 100 }), name: 'カード' }
    let doc = updatePage(base.doc, base.pageId, (page) => makeComponent(insertNode(page, card), card.id))
    const buttonComponent = mainOf(doc, base.button.id).component.id
    const nested = createInstance(doc, base.pageId, buttonComponent, { center: { x: 100, y: 250 }, parentId: card.id })
    doc = syncComponents(nested.document)
    const cardInstance = createInstance(doc, base.pageId, mainOf(doc, card.id).component.id)
    doc = syncComponents(cardInstance.document)
    return { ...base, doc, card, nestedId: nested.id!, cardInstanceId: cardInstance.id! }
  }

  it('入れ子のインスタンスの中身に文言・表示を結び、インスタンスで値を変えられる', () => {
    const { doc, pageId, card, label, mark, nestedId, cardInstanceId } = cardFixture()
    const labelCopy = derivedId(nestedId, label.id)
    const markCopy = derivedId(nestedId, mark.id)
    const page = doc.pages[0]
    expect(canBindProperty(page, card.id, 'text', labelCopy)).toBe(true)
    expect(canBindProperty(page, card.id, 'boolean', markCopy)).toBe(true)
    // 写しの中の入れ子のインスタンスに差し替えを結ぶには、たどるのに doc が要る。ボタンの元のプロパティにはならない
    const iconCopy = (page.nodes[nestedId] as FrameNode).children.at(-1)!
    expect(canBindProperty(page, card.id, 'instance', iconCopy)).toBe(false)
    expect(canBindProperty(page, card.id, 'instance', iconCopy, doc)).toBe(true)
    expect(canBindProperty(page, card.id, 'instance', labelCopy, doc)).toBe(false)
    expect(canBindProperty(page, label.id, 'text', labelCopy)).toBe(false)

    let next = updatePage(doc, pageId, (scene) => {
      let bound = addComponentProperty(scene, card.id, 'text', labelCopy, 'ボタンの文言').scene
      bound = addComponentProperty(bound, card.id, 'boolean', markCopy, '印').scene
      return bound
    })
    next = syncComponents(next)
    const states = () => instanceProperties(next, next.pages[0], instanceOf(next, cardInstanceId))
    expect(states().map(({ value }) => value)).toEqual(['OK', true])

    next = syncComponents(setInstanceProperty(next, pageId, cardInstanceId, 'ボタンの文言', '送信'))
    next = syncComponents(setInstanceProperty(next, pageId, cardInstanceId, '印', false))
    expect(instanceOf(next, cardInstanceId).component.overrides).toEqual({
      [labelCopy]: { text: '送信' },
      [markCopy]: { visible: false },
    })
    expect(next.pages[0].nodes[derivedId(cardInstanceId, labelCopy)]).toMatchObject({ text: '送信' })
    expect(next.pages[0].nodes[derivedId(cardInstanceId, markCopy)]).toMatchObject({ visible: false })
    expect(states().map(({ value, overridden }) => [value, overridden])).toEqual([['送信', true], [false, true]])
    // ボタンの元の文言を変えると、上書きしていないカードの値（既定値）もついてくる
    next = syncComponents(setInstanceProperty(next, pageId, cardInstanceId, 'ボタンの文言', 'OK'))
    next = syncComponents(updatePage(next, pageId, (scene) => ({ ...scene, nodes: { ...scene.nodes, [label.id]: { ...scene.nodes[label.id], text: '決定' } as typeof scene.nodes[string] } })))
    expect(states()[0]).toMatchObject({ value: '決定', overridden: false })
  })
})

describe('入れ子の中の入れ子のインスタンスへの差し替えのプロパティ', () => {
  /** カードの元の中にボタンのインスタンス、その中にアイコン（丸）のインスタンスの写し。カードのインスタンスも置く */
  function nestedFixture() {
    const base = fixture()
    const card = { ...createFrame({ x: 0, y: 200, width: 200, height: 100 }), name: 'カード' }
    let doc = updatePage(base.doc, base.pageId, (page) => makeComponent(insertNode(page, card), card.id))
    const nested = createInstance(doc, base.pageId, mainOf(doc, base.button.id).component.id, { center: { x: 100, y: 250 }, parentId: card.id })
    doc = syncComponents(nested.document)
    const cardInstance = createInstance(doc, base.pageId, mainOf(doc, card.id).component.id)
    doc = syncComponents(cardInstance.document)
    return { ...base, doc, card, nestedId: nested.id!, cardInstanceId: cardInstance.id!, iconCopy: derivedId(nested.id!, base.iconId) }
  }

  it('結んで、インスタンスで差し替える。値は写しをたどって読む', () => {
    const { doc, pageId, card, iconCopy, cardInstanceId, circleComponent, squareComponent } = nestedFixture()
    let next = updatePage(doc, pageId, (scene) => addComponentProperty(scene, card.id, 'instance', iconCopy, 'アイコン', doc).scene)
    expect(mainOf(next, card.id).component.properties).toEqual([{ name: 'アイコン', type: 'instance', targets: [iconCopy], preferred: [] }])
    next = syncComponents(next)
    const states = () => instanceProperties(next, next.pages[0], instanceOf(next, cardInstanceId))
    expect(states().map(({ value, overridden }) => [value, overridden])).toEqual([[circleComponent, false]])

    next = syncComponents(setInstanceProperty(next, pageId, cardInstanceId, 'アイコン', squareComponent))
    expect(instanceOf(next, cardInstanceId).component.overrides).toEqual({ [iconCopy]: { componentId: squareComponent } })
    expect(next.pages[0].nodes[derivedId(cardInstanceId, iconCopy)]).toMatchObject({ name: '四角' })
    expect(states().map(({ value, overridden }) => [value, overridden])).toEqual([[squareComponent, true]])
    // 元と同じ値に戻すと上書きは外れる
    next = syncComponents(setInstanceProperty(next, pageId, cardInstanceId, 'アイコン', circleComponent))
    expect(instanceOf(next, cardInstanceId).component.overrides).toEqual({})
  })

  it('元の中で入れ子の中身を差し替えていれば、既定値はそれをたどったもの', () => {
    const { doc, pageId, card, nestedId, iconId, iconCopy, cardInstanceId, squareComponent } = nestedFixture()
    // カードの元の中のボタンで、アイコンを四角に差し替える（元のページの写しの id で上書きになる）
    let next = syncComponents(swapNestedInstance(doc, pageId, iconCopy, squareComponent))
    expect(instanceOf(next, nestedId).component.overrides).toEqual({ [iconId]: { componentId: squareComponent } })
    next = syncComponents(updatePage(next, pageId, (scene) => addComponentProperty(scene, card.id, 'instance', iconCopy, 'アイコン', next).scene))
    expect(instanceProperties(next, next.pages[0], instanceOf(next, cardInstanceId))[0]).toMatchObject({ value: squareComponent, overridden: false })
  })
})

describe('バリアントのまとまりで共有するプロパティ', () => {
  /** ボタンの元をバリアントにして、もう 1 つ増やしたもの（中身は同じ名前のレイヤー） */
  function variantFixture() {
    const base = fixture()
    const added = addVariant(base.doc, base.pageId, base.button.id)
    const doc = syncComponents(added.document)
    const other = added.id!
    const page = doc.pages[0]
    const find = (rootId: string, name: string) =>
      (page.nodes[rootId] as FrameNode).children.find((id) => page.nodes[id].name === name)!
    return { ...base, doc, other, otherLabel: find(other, 'ラベル'), otherMark: find(other, '印') }
  }

  it('足す・結ぶ・外すと、ほかのバリアントでも同じ名前のレイヤーに', () => {
    const { doc, pageId, button, label, mark, other, otherLabel, otherMark } = variantFixture()
    let next = updatePage(doc, pageId, (scene) => addComponentProperty(scene, button.id, 'text', label.id, '文言').scene)
    const props = (id: string) => mainOf(next, id).component.properties
    expect(props(other)).toEqual([{ name: '文言', type: 'text', targets: [otherLabel], preferred: [] }])
    next = updatePage(next, pageId, (scene) => addComponentProperty(scene, other, 'boolean', otherMark, '印').scene)
    next = updatePage(next, pageId, (scene) => bindComponentProperty(scene, button.id, '印', label.id))
    expect(props(button.id)).toEqual([
      { name: '文言', type: 'text', targets: [label.id], preferred: [] },
      { name: '印', type: 'boolean', targets: [mark.id, label.id], preferred: [] },
    ])
    expect(props(other)[1].targets).toEqual([otherMark, otherLabel])
    next = updatePage(next, pageId, (scene) => unbindComponentProperty(scene, other, '印', otherLabel))
    expect(props(button.id)[1].targets).toEqual([mark.id])
    // 名前の候補は、まとまりのどのバリアントともぶつからないもの
    expect(addComponentProperty(next.pages[0], other, 'text', otherLabel).name).toBe('ラベル')
  })

  it('名前を変える・並べ替える・候補・消すも、すべてのバリアントで', () => {
    const { doc, pageId, button, label, mark, iconId, other, squareComponent } = variantFixture()
    let next = updatePage(doc, pageId, (scene) => {
      let page = addComponentProperty(scene, button.id, 'text', label.id, 'A').scene
      page = addComponentProperty(page, button.id, 'boolean', mark.id, 'B').scene
      return addComponentProperty(page, button.id, 'instance', iconId, 'C').scene
    })
    const names = (id: string) => mainOf(next, id).component.properties.map((p) => p.name)
    next = updatePage(next, pageId, (scene) => renameComponentProperty(scene, other, 'A', '文言'))
    next = updatePage(next, pageId, (scene) => moveComponentProperty(scene, button.id, 'C', 0))
    expect(names(button.id)).toEqual(['C', '文言', 'B'])
    expect(names(other)).toEqual(['C', '文言', 'B'])
    next = updatePage(next, pageId, (scene) => setPreferredComponents(scene, other, 'C', [squareComponent]))
    expect(mainOf(next, button.id).component.properties[0].preferred).toEqual([squareComponent])
    next = updatePage(next, pageId, (scene) => removeComponentProperty(scene, button.id, 'B'))
    expect(names(other)).toEqual(['C', '文言'])
  })

  it('揃っていないプロパティを一度に揃える。種類の違う同じ名前のものは残す', () => {
    const { doc, pageId, button, label, mark, other, otherLabel, otherMark } = variantFixture()
    // 編集の操作はまとまりにかかるので、揃っていない状態は直接作る（外から入れた元・前の版のファイル）
    const setProps = (scene: typeof doc.pages[0], id: string, properties: MainNode['component']['properties']) =>
      updateNode(scene, id, { component: { ...(scene.nodes[id] as MainNode).component, properties } })
    let next = updatePage(doc, pageId, (scene) => {
      let page = setProps(scene, button.id, [
        { name: '文言', type: 'text', targets: [label.id], preferred: [] },
        { name: '色', type: 'boolean', targets: [mark.id], preferred: [] },
      ])
      page = setProps(page, other, [
        { name: '印', type: 'boolean', targets: [otherMark], preferred: [] },
        { name: '色', type: 'text', targets: [otherLabel], preferred: [] },
      ])
      return page
    })
    const setId = next.pages[0].nodes[button.id].parentId!
    next = updatePage(next, pageId, (scene) => alignVariantProperties(scene, setId, next))
    expect(mainOf(next, button.id).component.properties).toEqual([
      { name: '文言', type: 'text', targets: [label.id], preferred: [] },
      { name: '色', type: 'boolean', targets: [mark.id], preferred: [] },
      { name: '印', type: 'boolean', targets: [mark.id], preferred: [] },
    ])
    expect(mainOf(next, other).component.properties).toEqual([
      { name: '文言', type: 'text', targets: [otherLabel], preferred: [] },
      { name: '色', type: 'text', targets: [otherLabel], preferred: [] },
      { name: '印', type: 'boolean', targets: [otherMark], preferred: [] },
    ])
    // 揃っていれば変えない
    expect(alignVariantProperties(next.pages[0], setId, next)).toBe(next.pages[0])
  })

  it('まとまりの説明文を変える。まとまりでないフレームは変えない', () => {
    const { doc, pageId, button } = variantFixture()
    const setId = doc.pages[0].nodes[button.id].parentId!
    const next = updatePage(doc, pageId, (scene) => setVariantSetDescription(scene, setId, '大きさと状態'))
    expect((next.pages[0].nodes[setId] as FrameNode).setDescription).toBe('大きさと状態')
    expect(setVariantSetDescription(next.pages[0], button.id, 'x')).toBe(next.pages[0])
  })

  it('増やしたバリアントは、元のプロパティを同じ名前のレイヤーに結んで受け継ぐ', () => {
    const base = fixture()
    const doc = updatePage(base.doc, base.pageId, (scene) => addComponentProperty(scene, base.button.id, 'text', base.label.id, '文言').scene)
    const added = addVariant(doc, base.pageId, base.button.id)
    const page = added.document.pages[0]
    const copyLabel = (page.nodes[added.id!] as FrameNode).children.find((id) => page.nodes[id].name === 'ラベル')
    expect(mainOf(added.document, added.id!).component.properties).toEqual([{ name: '文言', type: 'text', targets: [copyLabel], preferred: [] }])
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
