import { describe, expect, it, vi } from 'vitest'
import { solid } from '../document/paint.ts'
import { pathFromContours, pathFromPoints } from '../document/path.ts'
import { createFrame, createPath, createRect } from './nodes.ts'
import { makeComponent } from './components.ts'
import { addVariant } from './variants.ts'
import { variantSetOf } from '../document/variants.ts'
import { addPage, createDocument, createPage, removePage, renameDocument } from './operations/document.ts'
import { insertNode, moveNode, removeNodes, updateNode } from './operations/tree.ts'
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

  it('頂点の編集は、そのパスだけを選んでいる間だけ続き、なくなった頂点は選択から外れる', () => {
    const { store, rect } = setup()
    const path = createPath(pathFromPoints([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], true), true)
    store.apply((doc) => insertNode(doc, path))
    store.select([path.id])
    store.editVertices({ id: path.id, vertices: [3, 1, 1], segment: null })
    expect(store.getState().vertexEdit).toEqual({ id: path.id, vertices: [1, 3], segment: null })
    store.apply((doc) => updateNode(doc, path.id, { points: path.points.slice(0, 3) }))
    expect(store.getState().vertexEdit?.vertices).toEqual([1])
    store.select([rect.id])
    expect(store.getState().vertexEdit).toBeNull()
    store.select([path.id])
    expect(store.getState().vertexEdit).toBeNull()
  })

  it('頂点の編集の番号は全部の輪郭の通し番号で、穴の頂点・辺も選んだままにする', () => {
    const { store } = setup()
    const square = (from: number, to: number) => [
      { x: from, y: from },
      { x: to, y: from },
      { x: to, y: to },
      { x: from, y: to },
    ]
    const shape = pathFromContours([
      { vertices: square(0, 100), closed: true },
      { vertices: square(30, 70), closed: false },
    ])
    const path = { ...createPath(shape, true), ...shape }
    store.apply((doc) => insertNode(doc, path))
    store.select([path.id])
    store.editVertices({ id: path.id, vertices: [7], segment: null })
    expect(store.getState().vertexEdit?.vertices).toEqual([7])
    store.editVertices({ id: path.id, vertices: [], segment: 6 })
    expect(store.getState().vertexEdit?.segment).toBe(6)
    // 開いた穴の最後の頂点から始まる辺はない
    store.editVertices({ id: path.id, vertices: [8], segment: 7 })
    expect(store.getState().vertexEdit).toEqual({ id: path.id, vertices: [], segment: null })
  })

  it('グラデーションの編集は、そのノードだけを選び、その塗りがグラデーションの間だけ続く', () => {
    const { store, rect } = setup()
    const gradient = { type: 'linear' as const, x1: 0, y1: 0.5, x2: 1, y2: 0.5, stops: [{ offset: 0, color: '#000000' }, { offset: 0.5, color: '#888888' }, { offset: 1, color: '#ffffff' }], opacity: 1, visible: true }
    store.apply((doc) => updateNode(doc, rect.id, { fills: [gradient] }))
    store.select([rect.id])
    store.editGradient({ id: rect.id, key: 'fills', index: 0, stop: 2 })
    expect(store.getState().gradientEdit).toEqual({ id: rect.id, key: 'fills', index: 0, stop: 2 })
    // なくなった色は選ばない
    store.apply((doc) => updateNode(doc, rect.id, { fills: [{ ...gradient, stops: gradient.stops.slice(0, 2) }] }))
    expect(store.getState().gradientEdit?.stop).toBeNull()
    // 頂点の編集とは同時に入らない
    store.editVertices({ id: rect.id, vertices: [], segment: null })
    expect(store.getState().gradientEdit).toBeNull()
    store.editGradient({ id: rect.id, key: 'fills', index: 0, stop: null })
    // 単色にすると抜ける
    store.apply((doc) => updateNode(doc, rect.id, { fills: solid('#ff0000') }))
    expect(store.getState().gradientEdit).toBeNull()
    // 選択が変わると抜ける
    store.apply((doc) => updateNode(doc, rect.id, { fills: [gradient] }))
    store.editGradient({ id: rect.id, key: 'fills', index: 0, stop: null })
    store.select([])
    expect(store.getState().gradientEdit).toBeNull()
    // 線の番目がなければ入らない
    store.select([rect.id])
    store.editGradient({ id: rect.id, key: 'strokes', index: 0, stop: null })
    expect(store.getState().gradientEdit).toBeNull()
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

  it('まとまりの外へ動かしたバリアントは、ドラッグ中（preview）も確定後も名前が変わり、Undo で戻る', () => {
    const frame = { ...createFrame({ x: 0, y: 0, width: 50, height: 50 }), name: 'ボタン' }
    const store = createEditorStore(createDocument())
    store.apply((doc) => makeComponent(insertNode(doc, frame), frame.id))
    store.applyDocument((doc) => addVariant(doc, doc.pages[0].id, frame.id).document)
    const setId = variantSetOf(store.getState().page, frame.id)!.id
    store.preview((page) => moveNode(page, frame.id, null))
    expect(store.getState().page.nodes[frame.id].name).toBe('ボタン（標準）')
    // 戻すとプレビュー前の名前のまま
    store.preview((page) => moveNode(page, frame.id, setId))
    expect(store.getState().page.nodes[frame.id].name).toBe('種類=標準')
    store.preview((page) => moveNode(page, frame.id, null))
    store.commitPreview()
    expect(store.getState().page.nodes[frame.id].name).toBe('ボタン（標準）')
    store.undo()
    expect(store.getState().page.nodes[frame.id].name).toBe('種類=標準')
  })
})
