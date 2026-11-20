import { describe, expect, it, vi } from 'vitest'
import { createRect } from './nodes.ts'
import { createDocument, insertNode, removeNodes, updateNode } from './operations.ts'
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
    expect(store.getState().document.nodes[rect.id].x).toBe(50)

    store.undo()
    expect(store.getState().document.nodes[rect.id].x).toBe(0)
    expect(store.getState().canRedo).toBe(true)

    store.redo()
    expect(store.getState().document.nodes[rect.id].x).toBe(50)
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
    expect(store.getState().document.nodes[rect.id].x).toBe(30)

    store.commitPreview()
    store.undo()
    expect(store.getState().document.nodes[rect.id].x).toBe(0)
    store.undo()
    expect(store.getState().document.nodes[rect.id]).toBeUndefined()
  })

  it('cancelPreview で元に戻る', () => {
    const { store, rect } = setup()
    store.preview((doc) => updateNode(doc, rect.id, { x: 99 }))
    store.cancelPreview()
    expect(store.getState().document.nodes[rect.id].x).toBe(0)

    store.undo()
    expect(store.getState().document.rootIds).toEqual([])
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
})
