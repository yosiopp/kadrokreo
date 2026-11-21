import { describe, expect, it } from 'vitest'
import { componentEntries, groupByPage } from './componentList.ts'
import { makeComponent } from './components.ts'
import { createFrame } from './nodes.ts'
import { addPage, createDocument, createPage, updatePage } from './operations/document.ts'
import { insertNode } from './operations/tree.ts'
import { addVariant } from './variants.ts'

/** 1 ページ目に「Card」と「ボタン」（バリアント 2 つ）、2 ページ目に「avatar」の元 */
function fixture() {
  let doc = createDocument()
  const pageId = doc.pages[0].id
  const card = { ...createFrame({ x: 0, y: 0, width: 100, height: 100 }), name: 'Card' }
  const button = { ...createFrame({ x: 200, y: 0, width: 80, height: 30 }), name: 'ボタン' }
  doc = updatePage(doc, pageId, (page) =>
    makeComponent(makeComponent(insertNode(insertNode(page, card), button), card.id), button.id),
  )
  doc = addVariant(doc, pageId, button.id).document
  doc = addPage(doc, createPage('Page 2'))
  const avatar = { ...createFrame({ x: 0, y: 0, width: 40, height: 40 }), name: 'avatar' }
  doc = updatePage(doc, doc.pages[1].id, (page) => makeComponent(insertNode(page, avatar), avatar.id))
  return doc
}

const names = (entries: ReturnType<typeof componentEntries>) =>
  entries.map((entry) => [entry.name, entry.variants.map((variant) => variant.name)])

describe('コンポーネントの一覧', () => {
  it('バリアントはまとまりで 1 行にまとめ、その下にバリアントを持つ', () => {
    expect(names(componentEntries(fixture(), '', 'document'))).toEqual([
      ['Card', []],
      ['ボタン', ['種類=標準', '種類=2']],
      ['avatar', []],
    ])
  })

  it('名前の順に並べ替えられる', () => {
    expect(componentEntries(fixture(), '', 'name').map((entry) => entry.name)).toEqual(['avatar', 'Card', 'ボタン'])
  })

  it('名前で絞り込む。まとまりは当てはまったバリアントだけを残し、置くのもその最初のもの', () => {
    const doc = fixture()
    expect(names(componentEntries(doc, ' CARD ', 'document'))).toEqual([['Card', []]])
    const found = componentEntries(doc, '=2', 'document')
    expect(names(found)).toEqual([['ボタン', ['種類=2']]])
    expect(found[0].node.name).toBe('種類=2')
    // まとまりの名前が当てはまれば、すべてのバリアント
    expect(names(componentEntries(doc, 'ボタ', 'document'))).toEqual([['ボタン', ['種類=標準', '種類=2']]])
    expect(componentEntries(doc, 'ない', 'document')).toEqual([])
  })
})

describe('ページごとの見出し', () => {
  it('ページ順の行を、ページごとにまとめる', () => {
    const doc = fixture()
    const groups = groupByPage(componentEntries(doc, '', 'document'))
    expect(groups.map((group) => [group.page.name, group.entries.map((entry) => entry.name)])).toEqual([
      [doc.pages[0].name, ['Card', 'ボタン']],
      ['Page 2', ['avatar']],
    ])
    // 検索で 1 ページだけになれば、見出しも 1 つ
    expect(groupByPage(componentEntries(doc, 'ava', 'document')).map((group) => group.page.name)).toEqual(['Page 2'])
  })
})
