import { afterEach, describe, expect, it } from 'vitest'
import { isInstance, isMain, mainNodesOf, mainsOf } from '../document/component.ts'
import { trackNodeChanges } from '../document/nodeChanges.ts'
import type { DesignDocument, FrameNode, NodeId, Page } from '../document/types.ts'
import { type FitText, makeComponent, syncComponents } from './components.ts'
import { enableAutoLayout, patchLayouts, setFrameSizing, setLayoutFill } from './layout.ts'
import { createEllipse, createFrame, createRect, createText } from './nodes.ts'
import { addPage, createDocument, createPage, updatePage } from './operations/document.ts'
import { createBooleanNode } from './operations/booleanNodes.ts'
import { setFill } from './operations/paints.ts'
import { translateNodes } from './operations/transform.ts'
import { insertNode, isSelfOrAncestor, moveNode, removeNodes, updateNode } from './operations/tree.ts'
import { type EditorStore, createEditorStore } from './store.ts'

// ストアの後始末（上書きを覚える・枠合わせ・辺への追従・並べ直し・同期）は、ノードの表に覚えた「変えた id」を使い、
// 変わったノードのまわりだけを見る。それが全部を見たときと同じ結果になることを、覚え書きを使わないストアと
// 同じ編集（確定・プレビュー・取り消し・Undo / Redo）を重ねて比べて確かめる。

/** 文字数 × 文字の大きさを幅とみなして測る */
const fitText: FitText = (scene, ids) =>
  ids.reduce((next, id) => {
    const node = next.nodes[id]
    if (node?.type !== 'text') return next
    return updateNode(next, id, { width: node.text.length * node.fontSize, height: node.fontSize })
  }, scene)

/** 決まった種から決まった並びを出す乱数 */
function random(seed: number) {
  let state = seed
  const next = () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)],
  }
}

const componentIdOf = (page: Page, id: NodeId) => (page.nodes[id] as FrameNode).component!.id

/**
 * ボタンとカードの元、自動で並べる行（中身に合わせる）、辺に追従する子を持つ枠、ブーリアン演算、
 * ばらばらに置いたインスタンス、2 ページ目のインスタンス
 */
function fixture() {
  let doc = createDocument()
  const pageId = doc.pages[0].id
  const button = createFrame({ x: 0, y: 0, width: 120, height: 40 })
  const card = createFrame({ x: 0, y: 100, width: 240, height: 120 })
  const row = createFrame({ x: 400, y: 0, width: 600, height: 60 })
  const box = createFrame({ x: 0, y: 400, width: 300, height: 200 })
  const holder = createFrame({ x: 400, y: 400, width: 300, height: 300 })
  const shapes = [createRect({ x: 10, y: 10, width: 80, height: 80 }), createEllipse({ x: 50, y: 50, width: 80, height: 80 })]
  doc = updatePage(doc, pageId, (page) => {
    let next = insertNode(page, button)
    next = insertNode(next, createRect({ x: 0, y: 0, width: 120, height: 40 }), button.id)
    next = insertNode(next, createText({ x: 20, y: 10, width: 40, height: 20 }, 'OK'), button.id)
    next = makeComponent(next, button.id)
    next = insertNode(next, card)
    next = insertNode(next, createRect({ x: 0, y: 0, width: 240, height: 120 }), card.id)
    next = insertNode(next, createText({ x: 16, y: 16, width: 80, height: 20 }, 'Title'), card.id)
    next = makeComponent(next, card.id)
    next = insertNode(next, row)
    next = enableAutoLayout(next, row.id)
    next = insertNode(next, box)
    for (const [i, horizontal] of (['stretch', 'center', 'end', 'scale'] as const).entries()) {
      const child = createRect({ x: 20 + i * 60, y: 20, width: 40, height: 40 })
      next = insertNode(next, { ...child, constraints: { horizontal, vertical: i % 2 === 0 ? 'stretch' : 'scale' } }, box.id)
    }
    next = insertNode(next, holder)
    for (const shape of shapes) next = insertNode(next, shape, holder.id)
    return createBooleanNode(next, shapes.map((shape) => shape.id), 'union').scene
  })
  const buttonId = componentIdOf(doc.pages[0], button.id)
  const cardId = componentIdOf(doc.pages[0], card.id)
  const instance = (componentId: string, x: number, y: number): FrameNode => ({
    ...createFrame({ x, y, width: 120, height: 40 }),
    component: { id: componentId, role: 'instance', overrides: {} },
  })
  doc = updatePage(doc, pageId, (page) => {
    let next = insertNode(page, instance(buttonId, 20, 40), card.id)
    for (let i = 0; i < 3; i++) next = insertNode(next, instance(buttonId, 0, 0), row.id)
    for (let i = 0; i < 4; i++) next = insertNode(next, instance(i % 2 === 0 ? buttonId : cardId, 100 + i * 260, 800))
    return next
  })
  doc = addPage(doc, createPage('ページ 2'))
  doc = updatePage(doc, doc.pages[1].id, (page) => insertNode(insertNode(page, instance(cardId, 0, 0)), instance(buttonId, 300, 0)))
  return { doc: syncComponents(doc, fitText), rowId: row.id, componentIds: [buttonId, cardId], instance }
}

type Step = (store: EditorStore) => void

afterEach(() => trackNodeChanges(true))

describe('変わったノードだけを見る後始末', () => {
  // settled: 一度後始末を通して落ち着かせたドキュメントから始める（読み込んだ直後に落ち着いていると確かめて、最初から差分だけを見る道）
  it.each([
    [20261124, false],
    [7, true],
    [314159, true],
  ])('編集を重ねても、全部を見るストアと同じドキュメントになる（種 %i、落ち着いた状態から %s）', (seed, settled) => {
    const rng = random(seed)
    const { doc: unsettled, rowId, componentIds, instance } = fixture()
    let initial = unsettled
    if (settled) {
      const warm = createEditorStore(unsettled, fitText)
      warm.applyDocument((doc) => ({ ...doc, name: 'settled' }))
      warm.applyDocument((doc) => updatePage(doc, doc.pages[0].id, (page) => updateNode(page, page.rootIds[0], { x: 1 })))
      initial = warm.getState().document
    }
    const tracked = createEditorStore(initial, fitText)
    const plain = createEditorStore(initial, fitText)
    const run = (step: Step) => {
      trackNodeChanges(true)
      step(tracked)
      trackNodeChanges(false)
      step(plain)
      trackNodeChanges(true)
    }
    const colors = ['#ef4444', '#22c55e', '#3b82f6', '#eab308']
    const texts = ['OK', 'キャンセル', 'Title', '保存する']
    for (let index = 0; index < 400; index++) {
      const doc = tracked.getState().document
      const page = doc.pages[rng.int(doc.pages.length)]
      const onPage = (recipe: (scene: Page) => Page) => (base: DesignDocument) => updatePage(base, page.id, recipe)
      const ids = Object.keys(page.nodes)
      if (ids.length === 0) continue
      const target = rng.pick(ids)
      const node = page.nodes[target]
      const frames = ids.filter((id) => page.nodes[id].type === 'frame')
      // インスタンスを足す・元へ入れると写しが増えていく。重くなりすぎないよう、大きくなったら足さない（代わりに消す）
      const drawn = rng.int(13)
      const kind = ids.length > 500 && (drawn === 7 || drawn === 8) ? 12 : drawn
      let step: Step
      switch (kind) {
        case 0: {
          const color = rng.pick(colors)
          step = (store) => store.applyDocument(onPage((scene) => setFill(scene, [target], color)))
          break
        }
        case 1: {
          // ドラッグ（プレビューを何歩か重ねて、確定か取り消し）
          const moves = Array.from({ length: 1 + rng.int(4) }, () => [rng.int(41) - 20, rng.int(41) - 20])
          const commit = rng.next() < 0.7
          step = (store) => {
            let dx = 0
            let dy = 0
            for (const [x, y] of moves) {
              dx += x
              dy += y
              const [ax, ay] = [dx, dy]
              store.previewDocument(onPage((scene) => translateNodes(scene, [target], ax, ay)))
            }
            if (commit) store.commitPreview()
            else store.cancelPreview()
          }
          break
        }
        case 2: {
          const text = rng.pick(texts)
          step = (store) => store.applyDocument(onPage((scene) => (node.type === 'text' ? updateNode(scene, target, { text }) : scene)))
          break
        }
        case 3: {
          // 大きさを変える（プレビューしてから確定。辺に追従する子・中身に合わせる行・演算の枠が動く）
          const sizes = Array.from({ length: 1 + rng.int(3) }, () => ({ width: 20 + rng.int(300), height: 20 + rng.int(300) }))
          step = (store) => {
            for (const size of sizes) store.previewDocument(onPage((scene) => updateNode(scene, target, size)))
            store.commitPreview()
          }
          break
        }
        case 4: {
          const fill = rng.next() < 0.5
          step = (store) => store.applyDocument(onPage((scene) => setLayoutFill(scene, [target], 'width', fill)))
          break
        }
        case 5: {
          const direction = rng.next() < 0.5 ? 'horizontal' : 'vertical'
          const hug = rng.next() < 0.5 ? 'hug' : 'fixed'
          step = (store) =>
            store.applyDocument(
              onPage((scene) =>
                scene.nodes[rowId] ? setFrameSizing(patchLayouts(scene, [rowId], { direction }), [rowId], 'width', hug) : scene,
              ),
            )
          break
        }
        case 6:
          step = (store) => store.applyDocument(onPage((scene) => updateNode(scene, target, { visible: !node.visible })))
          break
        case 7: {
          // 別のフレームへ入れる（元の中へも。循環するなら変えない）
          const parentId = frames.length > 0 && rng.next() < 0.8 ? rng.pick(frames) : null
          step = (store) =>
            store.applyDocument(
              onPage((scene) =>
                scene.nodes[target] && !isSelfOrAncestor(scene, target, parentId) && (parentId === null || scene.nodes[parentId])
                  ? moveNode(scene, target, parentId)
                  : scene,
              ),
            )
          break
        }
        case 8: {
          // インスタンスを足す（同じノードを両方のストアに入れるので、先に作る）
          const parentId = page.nodes[rowId] && rng.next() < 0.5 ? rowId : null
          const created = instance(rng.pick(componentIds), rng.int(800), rng.int(800))
          step = (store) => store.applyDocument(onPage((scene) => insertNode(scene, created, parentId)))
          break
        }
        case 9:
          step = (store) => store.undo()
          break
        case 10:
          step = (store) => store.redo()
          break
        case 11: {
          // フレームを元にする（元が増える。コンポーネントの id を両方のストアで揃えるので、makeComponent と同じ形を先に作る）
          const component = { id: `c${index}`, role: 'main' as const, description: '', properties: [] }
          step = (store) =>
            store.applyDocument(
              onPage((scene) => {
                const frame = scene.nodes[target]
                return frame?.type === 'frame' && !frame.component ? updateNode(scene, target, { component }) : scene
              }),
            )
          break
        }
        default: {
          const remove = rng.next() < 0.3
          step = (store) => store.applyDocument(onPage((scene) => (remove && scene.nodes[target] ? removeNodes(scene, [target]) : scene)))
        }
      }
      run(step)
      expect(tracked.getState().document, `${index} 回目（種類 ${kind}）`).toEqual(plain.getState().document)
      // 引き継いだ元の集まりが、ページを見直して集めたものと同じ
      for (const page of tracked.getState().document.pages) {
        const scanned = Object.values(page.nodes).filter(isMain)
        expect(new Set(mainNodesOf(page)), `${index} 回目の元の集まり`).toEqual(new Set(scanned))
        for (const main of mainsOf(page).values()) expect(page.nodes[main.id]).toBe(main)
      }
    }
    // 途中でインスタンスがなくなっていない
    const last = tracked.getState().document
    expect(last.pages.some((page) => Object.values(page.nodes).some(isInstance))).toBe(true)
  })
})
