import { describe, expect, it } from 'vitest'
import { hitTest } from '../canvas/hitTest.ts'
import { findMain, owningInstance } from '../document/component.ts'
import type { AutoLayout, DesignDocument, FrameNode, Page, Scene } from '../document/types.ts'
import {
  type FitText,
  captureOverrides,
  createInstance,
  detachComponent,
  hasOverrides,
  makeComponent,
  resetOverrides,
  syncComponents,
} from './components.ts'
import { nodesInMarquee } from './hitTest.ts'
import { createFrame, createRect, createText } from './nodes.ts'
import {
  addPage,
  copyFragment,
  createDocument,
  createPage,
  insertNode,
  pasteIntoPage,
  removeNodes,
  updateNode,
  updatePage,
} from './operations.ts'
import { createEditorStore } from './store.ts'

/** ボタン（フレーム + 背景 + ラベル）を元にしたドキュメント */
function fixture() {
  const button = createFrame({ x: 100, y: 100, width: 120, height: 40 })
  const background = createRect({ x: 0, y: 0, width: 120, height: 40 })
  const label = createText({ x: 20, y: 10, width: 40, height: 20 }, 'OK')
  let doc = createDocument()
  const pageId = doc.pages[0].id
  doc = updatePage(doc, pageId, (page) => {
    let next = insertNode(page, button)
    next = insertNode(next, background, button.id)
    next = insertNode(next, label, button.id)
    return makeComponent(next, button.id)
  })
  const componentId = (doc.pages[0].nodes[button.id] as FrameNode).component!.id
  return { doc, pageId, button, background, label, componentId }
}

/** インスタンスを 1 つ作って同期する */
function withInstance() {
  const base = fixture()
  const created = createInstance(base.doc, base.pageId, base.componentId)
  return { ...base, doc: syncComponents(created.document), instanceId: created.id! }
}

const frameOf = (page: Page, id: string) => page.nodes[id] as FrameNode
const childrenOf = (page: Page, id: string) => frameOf(page, id).children.map((child) => page.nodes[child])

describe('コンポーネント', () => {
  it('フレームを元にする。フレーム以外や、すでにつながっているものは変えない', () => {
    const { doc, button, background, componentId } = fixture()
    const page = doc.pages[0]
    expect(frameOf(page, button.id).component).toEqual({ id: componentId, role: 'main' })
    expect(makeComponent(page, button.id)).toBe(page)
    expect(makeComponent(page, background.id)).toBe(page)
    expect(findMain(doc, componentId)?.node.id).toBe(button.id)
  })

  it('インスタンスには、元の中身の写しが入る', () => {
    const { doc, button, instanceId } = withInstance()
    const page = doc.pages[0]
    const instance = frameOf(page, instanceId)
    // 元の少し右下に、同じ大きさで置かれる
    expect(instance).toMatchObject({ x: 120, y: 120, width: 120, height: 40, parentId: null })
    expect(instance.component?.role).toBe('instance')

    const copies = childrenOf(page, instanceId)
    expect(copies.map((node) => node.type)).toEqual(['rect', 'text'])
    expect(copies[1]).toMatchObject({ text: 'OK', x: 20, y: 10, parentId: instanceId })
    // 写しは元とは別のノード
    expect(instance.children).not.toEqual(frameOf(page, button.id).children)
    expect(Object.keys(page.nodes)).toHaveLength(6)
  })

  it('元を変えると、インスタンスにも反映される', () => {
    const { doc, pageId, background, label, instanceId } = withInstance()
    const edited = updatePage(doc, pageId, (page) => {
      const next = updateNode(page, label.id, { text: '保存する', width: 80 })
      return removeNodes(next, [background.id])
    })
    const page = syncComponents(edited).pages[0]
    const copies = childrenOf(page, instanceId)
    expect(copies).toHaveLength(1)
    expect(copies[0]).toMatchObject({ text: '保存する', width: 80 })
    // 消した背景の写しも消える（元 2 + インスタンス 2）
    expect(Object.keys(page.nodes)).toHaveLength(4)
  })

  it('置き場所・名前・表示の設定はインスタンスごとに持ち、見た目は元に合わせる', () => {
    const { doc, pageId, button, instanceId } = withInstance()
    const edited = updatePage(doc, pageId, (page) => {
      let next = updateNode(page, instanceId, { x: 500, y: 300, rotation: 30, opacity: 0.5, name: '送信' })
      // インスタンスの見た目を直接変えても、元に戻される
      next = updateNode(next, instanceId, { fill: '#ff0000', width: 999 })
      return updateNode(next, button.id, { fill: '#00ff00', cornerRadius: 8 })
    })
    const instance = frameOf(syncComponents(edited).pages[0], instanceId)
    expect(instance).toMatchObject({ x: 500, y: 300, rotation: 30, opacity: 0.5, name: '送信' })
    expect(instance).toMatchObject({ fill: '#00ff00', cornerRadius: 8, width: 120 })
  })

  it('すでに合っていれば同じ参照を返す', () => {
    const { doc } = withInstance()
    expect(syncComponents(doc)).toBe(doc)
    const plain = createDocument()
    expect(syncComponents(plain)).toBe(plain)
  })

  it('元がなくなると、インスタンスは中身を残したままただのフレームになる', () => {
    const { doc, pageId, button, instanceId } = withInstance()
    const removed = syncComponents(updatePage(doc, pageId, (page) => removeNodes(page, [button.id])))
    const instance = frameOf(removed.pages[0], instanceId)
    expect(instance.component).toBeNull()
    expect(instance.children).toHaveLength(2)

    // 元をコンポーネントでなくした場合も同じ
    const detached = syncComponents(updatePage(doc, pageId, (page) => detachComponent(page, button.id)))
    expect(frameOf(detached.pages[0], instanceId).component).toBeNull()
  })

  it('切り離したインスタンスは、元を変えても変わらない', () => {
    const { doc, pageId, label, instanceId } = withInstance()
    const edited = updatePage(doc, pageId, (page) =>
      updateNode(detachComponent(page, instanceId), label.id, { text: '変更' }),
    )
    const page = syncComponents(edited).pages[0]
    expect(childrenOf(page, instanceId)[1]).toMatchObject({ text: 'OK' })
  })

  it('別のページのインスタンスにも反映される', () => {
    const { doc, pageId, label, componentId } = fixture()
    const second = createPage('2')
    const created = createInstance(addPage(doc, second), second.id, componentId)
    const synced = syncComponents(created.document)
    expect(childrenOf(synced.pages[1], created.id!)[1]).toMatchObject({ text: 'OK' })
    // 別のページに置くときは、ページの左上から
    expect(synced.pages[1].nodes[created.id!]).toMatchObject({ x: 0, y: 0 })

    const edited = syncComponents(updatePage(synced, pageId, (page) => updateNode(page, label.id, { text: 'NG' })))
    expect(childrenOf(edited.pages[1], created.id!)[1]).toMatchObject({ text: 'NG' })
  })

  it('元を複製（コピーして貼り付け）すると、インスタンスになる', () => {
    const { doc, pageId, button, label } = fixture()
    const fragment = copyFragment(doc.pages[0], doc.assets, [button.id])
    const pasted = pasteIntoPage(doc, pageId, fragment, 10)
    const copy = frameOf(pasted.document.pages[0], pasted.ids[0])
    expect(copy.component?.role).toBe('instance')
    // 元は 1 つのまま
    const mains = Object.values(pasted.document.pages[0].nodes).filter(
      (node) => node.type === 'frame' && node.component?.role === 'main',
    )
    expect(mains).toHaveLength(1)

    // 同期すると、貼り付けたものも元に追従する
    const edited = syncComponents(updatePage(pasted.document, pageId, (page) => updateNode(page, label.id, { text: 'Yes' })))
    expect(childrenOf(edited.pages[0], pasted.ids[0])[1]).toMatchObject({ text: 'Yes' })
  })

  it('元の中に別のコンポーネントのインスタンスがあっても、内側から順に反映される', () => {
    const { doc, pageId, label, componentId } = fixture()
    // ボタンのインスタンスを中に持つカードを、もう 1 つの元にする
    const card = createFrame({ x: 400, y: 0, width: 300, height: 200 })
    let next = updatePage(doc, pageId, (page) => makeComponent(insertNode(page, card), card.id))
    const inner = createInstance(next, pageId, componentId)
    next = updatePage(inner.document, pageId, (page) => ({
      ...page,
      rootIds: page.rootIds.filter((id) => id !== inner.id),
      nodes: {
        ...page.nodes,
        [inner.id!]: { ...page.nodes[inner.id!], parentId: card.id },
        [card.id]: { ...(page.nodes[card.id] as FrameNode), children: [inner.id!] },
      },
    }))
    const cardComponent = frameOf(next.pages[0], card.id).component!.id
    const outer = createInstance(next, pageId, cardComponent)
    next = syncComponents(outer.document)

    const textIn = (document: DesignDocument, rootId: string) => {
      const page = document.pages[0]
      const button = childrenOf(page, rootId)[0] as FrameNode
      return childrenOf(page, button.id)[1]
    }
    expect(textIn(next, outer.id!)).toMatchObject({ text: 'OK' })
    // 写しの中のボタンは、入れ子のインスタンスとしては扱わない
    expect((childrenOf(next.pages[0], outer.id!)[0] as FrameNode).component).toBeNull()

    const edited = syncComponents(updatePage(next, pageId, (page) => updateNode(page, label.id, { text: '送信' })))
    expect(textIn(edited, card.id)).toMatchObject({ text: '送信' })
    expect(textIn(edited, outer.id!)).toMatchObject({ text: '送信' })
    expect(syncComponents(edited)).toBe(edited)
  })

  it('自分自身を含むことになるインスタンスは、ただのフレームにする', () => {
    const { doc, pageId, button, componentId } = fixture()
    const created = createInstance(doc, pageId, componentId)
    // 作ったインスタンスを、元の中へ入れてしまう
    const nested = updatePage(created.document, pageId, (page) => ({
      ...page,
      rootIds: page.rootIds.filter((id) => id !== created.id),
      nodes: {
        ...page.nodes,
        [created.id!]: { ...page.nodes[created.id!], parentId: button.id },
        [button.id]: {
          ...(page.nodes[button.id] as FrameNode),
          children: [...frameOf(page, button.id).children, created.id!],
        },
      },
    }))
    const synced = syncComponents(nested)
    expect(frameOf(synced.pages[0], created.id!).component).toBeNull()
    expect(syncComponents(synced)).toBe(synced)
  })
})

describe('インスタンスごとの上書き', () => {
  /** 変更を加えて、ストアと同じ順（上書きを覚える → 同期）で後始末する */
  const edit = (doc: DesignDocument, recipe: (page: Page) => Page, fitText?: FitText) =>
    syncComponents(captureOverrides(doc, updatePage(doc, doc.pages[0].id, recipe)), fitText)
  const overridesOf = (doc: DesignDocument, instanceId: string) => {
    const link = frameOf(doc.pages[0], instanceId).component
    return link?.role === 'instance' ? link.overrides : null
  }
  /** 文字数 × 文字の大きさを幅とみなして測る */
  const fitText: FitText = (scene, ids) =>
    ids.reduce((next, id) => {
      const node = next.nodes[id]
      if (node?.type !== 'text') return next
      return updateNode(next, id, { width: node.text.length * node.fontSize, height: node.fontSize })
    }, scene)

  it('写しの文言・色・表示を変えると、そのインスタンスの上書きになる', () => {
    const { doc, background, label, instanceId } = withInstance()
    const [backgroundCopy, labelCopy] = frameOf(doc.pages[0], instanceId).children
    const edited = edit(doc, (page) => {
      let next = updateNode(page, labelCopy, { text: 'キャンセル', fill: '#ff0000' })
      next = updateNode(next, backgroundCopy, { fill: null, stroke: '#0000ff', visible: false })
      return next
    })
    expect(overridesOf(edited, instanceId)).toEqual({
      [label.id]: { text: 'キャンセル', fill: '#ff0000' },
      [background.id]: { fill: null, stroke: '#0000ff', visible: false },
    })
    const page = edited.pages[0]
    expect(page.nodes[labelCopy]).toMatchObject({ text: 'キャンセル', fill: '#ff0000' })
    expect(page.nodes[backgroundCopy]).toMatchObject({ fill: null, stroke: '#0000ff', visible: false })
    // 元は変わらない
    expect(page.nodes[label.id]).toMatchObject({ text: 'OK', fill: '#000000' })
    expect(syncComponents(edited)).toBe(edited)

    // 元を変えても上書きした項目は残り、ほかの項目は元に合わせて変わる
    const restyled = edit(edited, (next) => updateNode(next, label.id, { text: 'はい', fontSize: 20 }))
    expect(restyled.pages[0].nodes[labelCopy]).toMatchObject({ text: 'キャンセル', fill: '#ff0000', fontSize: 20 })
    expect(syncComponents(restyled)).toBe(restyled)
  })

  it('上書きできない項目を変えても覚えず、元に戻る', () => {
    const { doc, instanceId } = withInstance()
    const labelCopy = frameOf(doc.pages[0], instanceId).children[1]
    const edited = edit(doc, (page) => updateNode(page, labelCopy, { x: 99, fontSize: 40, name: '別名' }))
    expect(overridesOf(edited, instanceId)).toEqual({})
    expect(edited.pages[0].nodes[labelCopy]).toMatchObject({ x: 20, fontSize: 16, name: 'Text' })
  })

  it('元と同じ値に戻すと、上書きは消える', () => {
    const { doc, label, instanceId } = withInstance()
    const labelCopy = frameOf(doc.pages[0], instanceId).children[1]
    const edited = edit(doc, (page) => updateNode(page, labelCopy, { text: '送信', fill: '#ff0000' }))
    const restored = edit(edited, (page) => updateNode(page, labelCopy, { fill: '#000000' }))
    expect(overridesOf(restored, instanceId)).toEqual({ [label.id]: { text: '送信' } })
    expect(overridesOf(edit(restored, (page) => updateNode(page, labelCopy, { text: 'OK' })), instanceId)).toEqual({})
  })

  it('インスタンス自身の塗りと線も上書きできる。表示・非表示は上書きではなく自身の設定', () => {
    const { doc, button, instanceId } = withInstance()
    const edited = edit(doc, (page) => updateNode(page, instanceId, { fill: '#00ff00', visible: false }))
    expect(overridesOf(edited, instanceId)).toEqual({ [button.id]: { fill: '#00ff00' } })
    expect(edited.pages[0].nodes[instanceId]).toMatchObject({ fill: '#00ff00', visible: false })
    expect(edited.pages[0].nodes[button.id]).toMatchObject({ fill: '#ffffff', visible: true })

    // 元の塗りを変えても、上書きしたインスタンスはそのまま
    const repainted = edit(edited, (page) => updateNode(page, button.id, { fill: '#0000ff', cornerRadius: 4 }))
    expect(repainted.pages[0].nodes[instanceId]).toMatchObject({ fill: '#00ff00', cornerRadius: 4 })
  })

  it('元と写しを同じ値に変えたら、上書きにはならない', () => {
    const { doc, label, instanceId } = withInstance()
    const labelCopy = frameOf(doc.pages[0], instanceId).children[1]
    const edited = edit(doc, (page) =>
      updateNode(updateNode(page, label.id, { fill: '#123456' }), labelCopy, { fill: '#123456' }),
    )
    expect(overridesOf(edited, instanceId)).toEqual({})
  })

  it('上書きを捨てると、元と同じに戻る', () => {
    const { doc, pageId, button, background, label, instanceId } = withInstance()
    const [backgroundCopy, labelCopy] = frameOf(doc.pages[0], instanceId).children
    const edited = edit(doc, (page) => {
      let next = updateNode(page, labelCopy, { text: '送信' })
      next = updateNode(next, backgroundCopy, { fill: '#ff0000' })
      return updateNode(next, instanceId, { stroke: '#000000' })
    })
    const page = edited.pages[0]
    expect(hasOverrides(edited, page, instanceId)).toBe(true)
    expect(hasOverrides(edited, page, labelCopy)).toBe(true)
    expect(hasOverrides(edited, page, label.id)).toBe(false)
    expect(hasOverrides(doc, doc.pages[0], instanceId)).toBe(false)

    // 中身を指定すると、そのノードの分だけ
    const one = syncComponents(resetOverrides(edited, pageId, [labelCopy]))
    expect(Object.keys(overridesOf(one, instanceId)!).toSorted()).toEqual([button.id, background.id].toSorted())
    expect(one.pages[0].nodes[labelCopy]).toMatchObject({ text: 'OK' })
    expect(one.pages[0].nodes[backgroundCopy]).toMatchObject({ fill: '#ff0000' })
    expect(resetOverrides(one, pageId, [labelCopy])).toBe(one)

    // インスタンスを指定すると、すべて
    const all = syncComponents(resetOverrides(edited, pageId, [instanceId]))
    expect(overridesOf(all, instanceId)).toEqual({})
    expect(all.pages[0].nodes[backgroundCopy]).toMatchObject({ fill: '#d9d9d9' })
    expect(all.pages[0].nodes[instanceId]).toMatchObject({ stroke: null })
  })

  it('元から消えたノードへの上書きは捨てる。持てない値の上書きは当てない', () => {
    const { doc, pageId, background, label, instanceId } = withInstance()
    const labelCopy = frameOf(doc.pages[0], instanceId).children[1]
    const forged = updatePage(doc, pageId, (page) =>
      updateNode(page, instanceId, {
        component: {
          ...frameOf(page, instanceId).component!,
          role: 'instance',
          overrides: {
            // テキストの塗りは消せない。テキストに線はない
            [label.id]: { fill: null, stroke: '#ff0000', text: '送信' },
            [background.id]: { text: '長方形に文言はない', fill: '#ff0000' },
            missing: { fill: '#ff0000' },
          },
        },
      }),
    )
    const synced = syncComponents(forged)
    expect(synced.pages[0].nodes[labelCopy]).toMatchObject({ text: '送信', fill: '#000000' })
    expect(synced.pages[0].nodes[labelCopy]).not.toHaveProperty('stroke')
    expect(childrenOf(synced.pages[0], instanceId)[0]).not.toHaveProperty('text')
    expect(Object.keys(overridesOf(synced, instanceId)!)).not.toContain('missing')

    const removed = syncComponents(updatePage(synced, pageId, (page) => removeNodes(page, [background.id])))
    expect(Object.keys(overridesOf(removed, instanceId)!)).toEqual([label.id])
  })

  it('文言を上書きすると、自動で並べるインスタンスの大きさも変わる', () => {
    const { doc, button, label, instanceId } = withInstance()
    const layout: AutoLayout = {
      direction: 'horizontal',
      gap: 0,
      paddingX: 10,
      paddingY: 10,
      align: 'start',
      justify: 'start',
      widthMode: 'hug',
      heightMode: 'hug',
    }
    const store = createEditorStore(doc, fitText)
    store.apply((page) => updateNode(page, button.id, { layout }))
    const widths = () => {
      const { page } = store.getState()
      return [page.nodes[button.id].width, page.nodes[instanceId].width]
    }
    // 余白 10 + 背景 120 + ラベル 40 + 余白 10
    expect(widths()).toEqual([180, 180])

    // 編集する側は、文言と一緒に測った大きさも入れる
    const labelCopy = frameOf(store.getState().page, instanceId).children[1]
    store.apply((page) => updateNode(page, labelCopy, { text: 'キャンセル', width: 80 }))
    expect(widths()).toEqual([180, 220])
    expect(store.getState().page.nodes[labelCopy]).toMatchObject({ text: 'キャンセル', width: 80 })

    // 元の書式を変えると、上書きした文言の大きさを測り直す（5 文字 × 20）
    store.apply((page) => updateNode(page, label.id, { fontSize: 20, width: 40 }))
    expect(store.getState().page.nodes[labelCopy]).toMatchObject({ text: 'キャンセル', fontSize: 20, width: 100 })
    expect(widths()).toEqual([180, 240])

    // 写しを隠すと、その分だけ詰まる
    const backgroundCopy = frameOf(store.getState().page, instanceId).children[0]
    store.apply((page) => updateNode(page, backgroundCopy, { visible: false }))
    expect(widths()).toEqual([180, 120])

    store.undo()
    store.undo()
    store.undo()
    expect(widths()).toEqual([180, 180])
    expect(store.getState().page.nodes[labelCopy]).toMatchObject({ text: 'OK' })
  })

  it('インスタンスを複製しても、上書きは引き継がれる', () => {
    const { doc, pageId, instanceId } = withInstance()
    const labelCopy = frameOf(doc.pages[0], instanceId).children[1]
    const edited = edit(doc, (page) => updateNode(page, labelCopy, { text: '送信' }))
    const fragment = copyFragment(edited.pages[0], edited.assets, [instanceId])
    const pasted = pasteIntoPage(edited, pageId, fragment, 10)
    const synced = syncComponents(captureOverrides(edited, pasted.document))
    expect(childrenOf(synced.pages[0], pasted.ids[0])[1]).toMatchObject({ text: '送信' })
    expect(overridesOf(synced, pasted.ids[0])).toEqual(overridesOf(edited, instanceId))
  })

  it('元の中のインスタンスへの上書きは、外側のインスタンスにも写る', () => {
    const { doc, pageId, componentId } = fixture()
    // ボタンのインスタンスを中に持つカードを、もう 1 つの元にする
    const card = createFrame({ x: 400, y: 0, width: 300, height: 200 })
    let next = updatePage(doc, pageId, (page) => makeComponent(insertNode(page, card), card.id))
    const inner = createInstance(next, pageId, componentId)
    next = updatePage(inner.document, pageId, (page) => ({
      ...page,
      rootIds: page.rootIds.filter((id) => id !== inner.id),
      nodes: {
        ...page.nodes,
        [inner.id!]: { ...page.nodes[inner.id!], parentId: card.id },
        [card.id]: { ...(page.nodes[card.id] as FrameNode), children: [inner.id!] },
      },
    }))
    const outer = createInstance(next, pageId, frameOf(next.pages[0], card.id).component!.id)
    next = syncComponents(outer.document)
    const labelIn = (scene: Scene, rootId: string) => {
      const button = scene.nodes[(scene.nodes[rootId] as FrameNode).children[0]] as FrameNode
      return scene.nodes[button.children[1]]
    }

    // カードの中のボタンの文言を変える
    const innerLabel = labelIn(next.pages[0], card.id).id
    expect(owningInstance(next.pages[0], innerLabel)?.id).toBe(inner.id)
    next = edit(next, (page) => updateNode(page, innerLabel, { text: '購入' }))
    expect(labelIn(next.pages[0], outer.id!)).toMatchObject({ text: '購入' })

    // 外側のインスタンスで、さらに上書きする
    const outerLabel = labelIn(next.pages[0], outer.id!).id
    expect(owningInstance(next.pages[0], outerLabel)?.id).toBe(outer.id)
    next = edit(next, (page) => updateNode(page, outerLabel, { text: '予約' }))
    expect(labelIn(next.pages[0], outer.id!)).toMatchObject({ text: '予約' })
    expect(labelIn(next.pages[0], card.id)).toMatchObject({ text: '購入' })
    expect(overridesOf(next, outer.id!)).toEqual({ [innerLabel]: { text: '予約' } })
    expect(syncComponents(next)).toBe(next)
  })
})

describe('インスタンスの扱い', () => {
  it('中身は、deep を指定したときだけ選べる', () => {
    const { doc, instanceId } = withInstance()
    const page = doc.pages[0]
    const labelCopy = frameOf(page, instanceId).children[1]
    expect(hitTest(page, { x: 150, y: 135 }, { deep: true })).toBe(labelCopy)
    expect(owningInstance(page, labelCopy)?.id).toBe(instanceId)
    expect(owningInstance(page, instanceId)).toBeNull()
  })

  it('中身は個別に選べない', () => {
    const { doc, instanceId } = withInstance()
    const page = doc.pages[0]
    // インスタンスは (120, 120) にあり、ラベルの写しは (140, 130) から。
    // ラベルの写しの上を押しても、選ばれるのはインスタンス全体
    expect(hitTest(page, { x: 150, y: 135 })).toBe(instanceId)
    expect(hitTest(page, { x: 230, y: 150 })).toBe(instanceId)
    expect(nodesInMarquee(page, { x: 225, y: 145, width: 10, height: 10 })).toEqual([instanceId])
  })
})

describe('ストア', () => {
  it('元を編集すると、同じ変更の中でインスタンスも変わり、Undo 1 回で両方戻る', () => {
    const { doc, label, instanceId } = withInstance()
    const store = createEditorStore(doc)
    const copyText = () => {
      const { page } = store.getState()
      return childrenOf(page, instanceId)[1]
    }

    store.apply((page) => updateNode(page, label.id, { text: '保存' }))
    expect(copyText()).toMatchObject({ text: '保存' })

    store.preview((page) => updateNode(page, label.id, { text: 'ドラッグ中' }))
    expect(copyText()).toMatchObject({ text: 'ドラッグ中' })
    store.cancelPreview()

    store.undo()
    expect(copyText()).toMatchObject({ text: 'OK' })
    expect(store.getState().canUndo).toBe(false)
  })
})
