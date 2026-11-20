import { describe, expect, it, vi } from 'vitest'
import { createRect } from './nodes.ts'
import {
  addPage,
  createDocument,
  createPage,
  insertNode,
  removeNodes,
  removePage,
  renameDocument,
  updateNode,
} from './operations.ts'
import { createEditorStore } from './store.ts'

function setup() {
  const rect = createRect({ x: 0, y: 0, width: 10, height: 10 })
  const store = createEditorStore(createDocument())
  store.apply((doc) => insertNode(doc, rect))
  return { store, rect }
}

describe('createEditorStore', () => {
  it('apply した変更を undo / redo できる', () => {
    const { store, rect } = setup()
    store.apply((doc) => updateNode(doc, rect.id, { x: 50 }))
    expect(store.getState().page.nodes[rect.id].x).toBe(50)

    store.undo()
    expect(store.getState().page.nodes[rect.id].x).toBe(0)
    expect(store.getState().canRedo).toBe(true)

    store.redo()
    expect(store.getState().page.nodes[rect.id].x).toBe(50)
    expect(store.getState().canRedo).toBe(false)
  })

  it('新しい変更を加えると redo は消える', () => {
    const { store, rect } = setup()
    store.apply((doc) => updateNode(doc, rect.id, { x: 50 }))
    store.undo()
    store.apply((doc) => updateNode(doc, rect.id, { y: 7 }))
    expect(store.getState().canRedo).toBe(false)
  })

  it('何も変わらない apply は履歴にも通知にも残らない', () => {
    const { store, rect } = setup()
    const listener = vi.fn()
    store.subscribe(listener)
    store.apply((doc) => updateNode(doc, rect.id, { x: 0 }))
    expect(listener).not.toHaveBeenCalled()

    store.undo()
    expect(store.getState().canUndo).toBe(false)
  })

  it('preview は commit するまで履歴に積まれず、まとめて 1 回分になる', () => {
    const { store, rect } = setup()
    for (const dx of [10, 20, 30]) {
      store.preview((doc) => updateNode(doc, rect.id, { x: doc.nodes[rect.id].x + dx }))
    }
    // recipe には毎回プレビュー開始前のドキュメントが渡るので累積しない
    expect(store.getState().page.nodes[rect.id].x).toBe(30)

    store.commitPreview()
    store.undo()
    expect(store.getState().page.nodes[rect.id].x).toBe(0)
    store.undo()
    expect(store.getState().page.nodes[rect.id]).toBeUndefined()
  })

  it('cancelPreview で元に戻る', () => {
    const { store, rect } = setup()
    store.preview((doc) => updateNode(doc, rect.id, { x: 99 }))
    store.cancelPreview()
    expect(store.getState().page.nodes[rect.id].x).toBe(0)

    store.undo()
    expect(store.getState().page.rootIds).toEqual([])
  })

  it('消えたノードは選択から外れる', () => {
    const { store, rect } = setup()
    store.select([rect.id])
    expect(store.getState().selection).toEqual([rect.id])

    store.apply((doc) => removeNodes(doc, [rect.id]))
    expect(store.getState().selection).toEqual([])
  })

  it('load で履歴と選択を捨てる', () => {
    const { store, rect } = setup()
    store.select([rect.id])
    store.load(createDocument('other'))
    expect(store.getState()).toMatchObject({ selection: [], canUndo: false, canRedo: false })
    expect(store.getState().document.name).toBe('other')
  })

  it('subscribe の解除後は通知されない', () => {
    const { store, rect } = setup()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    store.apply((doc) => updateNode(doc, rect.id, { x: 1 }))
    unsubscribe()
    store.apply((doc) => updateNode(doc, rect.id, { x: 2 }))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  describe('ページ', () => {
    function withTwoPages() {
      const { store, rect } = setup()
      const first = store.getState().page.id
      const second = createPage('Page 2')
      store.applyDocument((doc) => addPage(doc, second))
      return { store, rect, first, second: second.id }
    }

    it('apply はいま表示しているページだけを書き換える', () => {
      const { store, rect, first, second } = withTwoPages()
      store.setPage(second)
      const other = createRect({ x: 0, y: 0, width: 5, height: 5 })
      store.apply((page) => insertNode(page, other))

      const { document, page } = store.getState()
      expect(page.id).toBe(second)
      expect(page.rootIds).toEqual([other.id])
      expect(document.pages.find((p) => p.id === first)!.rootIds).toEqual([rect.id])
    })

    it('ページを切り替えると選択が解除される', () => {
      const { store, rect, second } = withTwoPages()
      store.select([rect.id])
      store.setPage(second)
      expect(store.getState().selection).toEqual([])
    })

    it('別のページの変更を undo すると、そのページが表示される', () => {
      const { store, rect, first, second } = withTwoPages()
      store.apply((page) => updateNode(page, rect.id, { x: 99 }))
      store.setPage(second)

      store.undo()
      expect(store.getState().page.id).toBe(first)
      expect(store.getState().page.nodes[rect.id].x).toBe(0)

      store.setPage(second)
      store.redo()
      expect(store.getState().page.id).toBe(first)
      expect(store.getState().page.nodes[rect.id].x).toBe(99)
    })

    it('ページに関係ない変更の undo では、表示中のページは変わらない', () => {
      const { store, second } = withTwoPages()
      store.applyDocument((doc) => renameDocument(doc, 'renamed'))
      store.setPage(second)
      store.undo()
      expect(store.getState().page.id).toBe(second)
      expect(store.getState().document.name).toBe('Untitled')
    })

    it('表示中のページが消えたら先頭のページへ移り、undo で戻る', () => {
      const { store, first, second } = withTwoPages()
      store.setPage(second)
      store.applyDocument((doc) => removePage(doc, second))
      expect(store.getState().page.id).toBe(first)

      store.undo()
      expect(store.getState().page.id).toBe(second)
    })
  })
})
