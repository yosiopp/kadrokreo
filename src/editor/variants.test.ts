import { describe, expect, it } from 'vitest'
import { type InstanceNode, findMain } from '../document/component.ts'
import type { FrameNode } from '../document/types.ts'
import { solid } from '../document/paint.ts'
import { variantProperties, variantSetOf, variantsIn } from '../document/variants.ts'
import { createInstance, makeComponent, syncComponents } from './components.ts'
import { relayout } from './layout.ts'
import { createFrame, createRect, createText } from './nodes.ts'
import { createDocument, updatePage } from './operations/document.ts'
import { insertNode, updateNode } from './operations/tree.ts'
import {
  addVariant,
  addVariantProperty,
  addVariantValue,
  moveVariantProperty,
  moveVariantValue,
  removeVariantProperty,
  renameVariantProperty,
  renameVariantValue,
  selectVariant,
  setVariantValue,
} from './variants.ts'

/** ボタン（背景とラベル）の元が 1 つあるドキュメント */
function fixture() {
  const button = { ...createFrame({ x: 100, y: 100, width: 120, height: 40 }), name: 'ボタン' }
  const label = { ...createText({ x: 20, y: 10, width: 40, height: 20 }, 'OK'), name: 'ラベル' }
  let doc = createDocument()
  const pageId = doc.pages[0].id
  doc = updatePage(doc, pageId, (page) => {
    let next = insertNode(page, button)
    next = insertNode(next, createRect({ x: 0, y: 0, width: 120, height: 40 }), button.id)
    next = insertNode(next, label, button.id)
    return makeComponent(next, button.id)
  })
  return { doc, pageId, button, label }
}

describe('addVariant', () => {
  it('元をまとまりで包んで、複製をもう 1 つのバリアントにする', () => {
    const { doc, pageId, button } = fixture()
    const { document, id } = addVariant(doc, pageId, button.id)
    const page = updatePage(document, pageId, relayout).pages[0]
    const set = variantSetOf(page, button.id)!
    expect(set.name).toBe('ボタン')
    expect(variantsIn(page, set.id).map((node) => node.name)).toEqual(['種類=標準', '種類=2'])
    expect(variantsIn(page, set.id)[1].id).toBe(id)
    // 新しいバリアントは別のコンポーネント。中身も複製されている
    const copy = page.nodes[id!] as FrameNode
    expect(copy.component?.role).toBe('main')
    expect(copy.component?.id).not.toBe((page.nodes[button.id] as FrameNode).component?.id)
    expect(copy.children).toHaveLength(2)
    // 元のページ上の位置は変わらない
    expect(page.nodes[button.id]).toMatchObject({ x: 20, y: 20 })
    expect(set).toMatchObject({ x: 80, y: 80, width: 300, height: 80 })
  })

  it('まとまりの中なら、まだない値で後ろに足す', () => {
    const { doc, pageId, button } = fixture()
    const first = addVariant(doc, pageId, button.id)
    const second = addVariant(first.document, pageId, button.id)
    const page = second.document.pages[0]
    const set = variantSetOf(page, button.id)!
    expect(variantsIn(page, set.id).map((node) => node.name)).toEqual(['種類=標準', '種類=3', '種類=2'])
  })
})

describe('プロパティの編集', () => {
  it('値とプロパティ名を変える', () => {
    const { doc, pageId, button } = fixture()
    const { document, id } = addVariant(doc, pageId, button.id)
    let page = document.pages[0]
    const set = variantSetOf(page, button.id)!
    page = setVariantValue(page, id!, '種類', '押下')
    expect(page.nodes[id!].name).toBe('種類=押下')
    // カンマや = を含む値、空の値は受け付けない
    expect(setVariantValue(page, id!, '種類', 'a,b')).toBe(page)
    expect(setVariantValue(page, id!, '種類', ' ')).toBe(page)
    page = renameVariantProperty(page, set.id, '種類', '状態')
    expect(variantProperties(page, set.id)).toEqual([{ name: '状態', values: ['標準', '押下'] }])
  })

  it('プロパティを足す・消すと、すべてのバリアントの名前を書き換える', () => {
    const { doc, pageId, button } = fixture()
    const { document } = addVariant(doc, pageId, button.id)
    let page = document.pages[0]
    const set = variantSetOf(page, button.id)!
    const names = () => variantsIn(page, set.id).map((node) => node.name)

    const added = addVariantProperty(page, set.id)
    expect(added.name).toBe('プロパティ1')
    page = added.scene
    expect(names()).toEqual(['種類=標準, プロパティ1=標準', '種類=2, プロパティ1=標準'])
    page = addVariantProperty(page, set.id, '押下', 'false').scene
    expect(variantProperties(page, set.id).at(-1)).toEqual({ name: '押下', values: ['false'] })
    // すでにある名前、使えない名前は足さない
    expect(addVariantProperty(page, set.id, '押下').scene).toBe(page)
    expect(addVariantProperty(page, set.id, 'a=b').name).toBeNull()

    page = removeVariantProperty(page, set.id, 'プロパティ1')
    expect(names()).toEqual(['種類=標準, 押下=false', '種類=2, 押下=false'])
    page = removeVariantProperty(page, set.id, '種類')
    expect(names()).toEqual(['押下=false', '押下=false'])
    // 最後の 1 つは消せない（名前がバリアントの形でなくなる）
    expect(removeVariantProperty(page, set.id, '押下')).toBe(page)
    expect(removeVariantProperty(page, set.id, 'ない')).toBe(page)
  })
})

describe('プロパティと値の並べ替え・値の一覧', () => {
  /** 種類=標準 / 種類=2 の 2 つに、サイズ=小 を足したまとまり */
  function setFixture() {
    const { doc, pageId, button } = fixture()
    const { document, id } = addVariant(doc, pageId, button.id)
    const page = document.pages[0]
    const set = variantSetOf(page, button.id)!
    const document2 = updatePage(document, pageId, (base) => addVariantProperty(base, set.id, 'サイズ', '小').scene)
    return { doc: document2, pageId, setId: set.id, firstId: button.id, secondId: id! }
  }

  it('プロパティの順を変えると、すべてのバリアントの名前の順が変わる', () => {
    const { doc, setId } = setFixture()
    const page = moveVariantProperty(doc.pages[0], setId, 'サイズ', 0)
    expect(variantsIn(page, setId).map((node) => node.name)).toEqual(['サイズ=小, 種類=標準', 'サイズ=小, 種類=2'])
    expect(variantProperties(page, setId).map((property) => property.name)).toEqual(['サイズ', '種類'])
    expect(moveVariantProperty(page, setId, 'サイズ', 0)).toBe(page)
    expect(moveVariantProperty(page, setId, 'ない', 1)).toBe(page)
  })

  it('値の名前を変えると、その値のバリアントすべてが変わる。すでにある値には変えない', () => {
    const { doc, setId } = setFixture()
    let page = renameVariantValue(doc.pages[0], setId, '種類', '2', '押下')
    expect(variantProperties(page, setId)[0]).toEqual({ name: '種類', values: ['標準', '押下'] })
    expect(renameVariantValue(page, setId, '種類', '押下', '標準')).toBe(page)
    expect(renameVariantValue(page, setId, '種類', '押下', 'a=b')).toBe(page)
    page = renameVariantValue(page, setId, 'サイズ', '小', '大')
    expect(variantsIn(page, setId).map((node) => node.name)).toEqual(['種類=標準, サイズ=大', '種類=押下, サイズ=大'])
  })

  it('値の順を変えると、バリアントの並びを値の順に並べ替える', () => {
    const { doc, setId, firstId, secondId } = setFixture()
    const page = moveVariantValue(doc.pages[0], setId, '種類', '2', 0)
    expect((page.nodes[setId] as FrameNode).children).toEqual([secondId, firstId])
    expect(variantProperties(page, setId)[0].values).toEqual(['2', '標準'])
    expect(moveVariantValue(page, setId, '種類', '2', 0)).toBe(page)
  })

  it('値を足すと、最初のバリアントを複製してその値にする', () => {
    const { doc, pageId, setId } = setFixture()
    const added = addVariantValue(doc, pageId, setId, 'サイズ')
    const page = added.document.pages[0]
    expect(page.nodes[added.id!].name).toBe('種類=標準, サイズ=値2')
    expect(variantProperties(page, setId)[1]).toEqual({ name: 'サイズ', values: ['小', '値2'] })
    const named = addVariantValue(added.document, pageId, setId, 'サイズ', '大')
    expect(named.document.pages[0].nodes[named.id!].name).toBe('種類=標準, サイズ=大')
    // すでにある値は足さない
    expect(addVariantValue(doc, pageId, setId, 'サイズ', '小').id).toBeNull()
  })
})

describe('selectVariant', () => {
  it('インスタンスを、選んだ値のバリアントに差し替える。名前はまとまりの名前', () => {
    const { doc, pageId, button, label } = fixture()
    const added = addVariant(doc, pageId, button.id)
    // 押下のバリアントは赤くて文言が違う
    let next = updatePage(added.document, pageId, (page) => {
      const copy = page.nodes[added.id!] as FrameNode
      const copyLabel = copy.children.map((child) => page.nodes[child]).find((node) => node.name === label.name)!
      let changed = updateNode(page, added.id!, { name: '種類=押下', fills: solid('#ff0000') })
      changed = updateNode(changed, copyLabel.id, { text: '押した' })
      return changed
    })
    const mainComponent = (next.pages[0].nodes[button.id] as FrameNode).component!.id
    const created = createInstance(next, pageId, mainComponent)
    next = syncComponents(created.document)
    const instanceId = created.id!
    expect(next.pages[0].nodes[instanceId].name).toBe('ボタン')

    next = syncComponents(selectVariant(next, pageId, instanceId, '種類', '押下'))
    const instance = next.pages[0].nodes[instanceId] as InstanceNode
    expect(findMain(next, instance.component.id)?.node.id).toBe(added.id)
    expect(instance).toMatchObject({ name: 'ボタン', fills: solid('#ff0000') })
    // ない値なら変えない
    expect(selectVariant(next, pageId, instanceId, '種類', 'なし')).toBe(next)
  })
})
