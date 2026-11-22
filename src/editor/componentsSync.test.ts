import { describe, expect, it } from 'vitest'
import { derivedId, isInstance, isMain, mainsOf } from '../document/component.ts'
import { solid } from '../document/paint.ts'
import type { DesignDocument, FrameNode, NodeId, Page } from '../document/types.ts'
import { type FitText, captureOverrides, createInstance, makeComponent, syncComponents } from './components.ts'
import { enableAutoLayout, patchLayouts, setLayoutFill } from './layout.ts'
import { createFrame, createRect, createText } from './nodes.ts'
import { addPage, createDocument, createPage, updatePage } from './operations/document.ts'
import { setFill } from './operations/paints.ts'
import { translateNodes } from './operations/transform.ts'
import { insertNode, removeNodes, updateNode } from './operations/tree.ts'

// 同期を速くした仕組み（ページのノードの表を 1 回だけ写す、合っていたインスタンスとドキュメントを覚えて飛ばす）が、
// 結果を変えていないことを確かめる。覚え書きは参照で引くので、structuredClone した（参照を共有しない）ドキュメントを
// 同期すれば、覚え書きを使わずに一から比べた結果になる。それと、編集を重ねながら覚え書きを使った結果を比べる。

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

/** 書き換えられたら例外になるようにする（同期が入力を書き換えていないことを確かめる） */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

const componentIdOf = (page: Page, id: NodeId) => (page.nodes[id] as FrameNode).component!.id

/**
 * ボタン（背景とラベル）と、ボタンのインスタンスを入れたカードの 2 つの元。
 * 1 ページ目に、自動で並べる行（伸ばすインスタンスを含む）とばらばらに置いたインスタンス、2 ページ目にもインスタンスを置く
 */
function fixture() {
  let doc = createDocument()
  const pageId = doc.pages[0].id
  const button = createFrame({ x: 0, y: 0, width: 120, height: 40 })
  const card = createFrame({ x: 0, y: 100, width: 240, height: 120 })
  const row = createFrame({ x: 400, y: 0, width: 600, height: 60 })
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
    return enableAutoLayout(next, row.id)
  })
  const buttonId = componentIdOf(doc.pages[0], button.id)
  const cardId = componentIdOf(doc.pages[0], card.id)
  // カードの中にボタンのインスタンス（入れ子）
  doc = createInstance(doc, pageId, buttonId, { center: { x: 60, y: 190 }, parentId: card.id }).document
  const rowItems: NodeId[] = []
  for (let i = 0; i < 3; i++) {
    const created = createInstance(doc, pageId, buttonId, { center: { x: 460 + i * 130, y: 30 }, parentId: row.id })
    doc = created.document
    rowItems.push(created.id!)
  }
  doc = updatePage(doc, pageId, (page) => setLayoutFill(page, [rowItems[1]], 'width', true))
  for (let i = 0; i < 6; i++) {
    doc = createInstance(doc, pageId, i % 2 === 0 ? buttonId : cardId, { center: { x: 100 + i * 260, y: 500 }, parentId: null }).document
  }
  doc = addPage(doc, createPage('ページ 2'))
  const secondId = doc.pages[1].id
  for (let i = 0; i < 3; i++) {
    doc = createInstance(doc, secondId, i === 0 ? cardId : buttonId, { center: { x: i * 300, y: 0 }, parentId: null }).document
  }
  return { doc: syncComponents(doc, fitText), rowId: row.id, componentIds: [buttonId, cardId] }
}

/** 覚え書きを使わずに一から同期した結果 */
const fresh = (doc: DesignDocument) => syncComponents(structuredClone(doc), fitText)

describe('同期を速くしても結果は変わらない', () => {
  it('元を変えると、どのページのインスタンスも作り直され、入力は書き換えない', () => {
    const { doc } = fixture()
    const page = doc.pages[0]
    const mainRect = Object.values(page.nodes).find(
      (node) => node.type === 'rect' && node.parentId !== null && page.nodes[node.parentId].type === 'frame' && (page.nodes[node.parentId] as FrameNode).component?.role === 'main',
    )!
    const edited = deepFreeze(updatePage(doc, page.id, (scene) => setFill(scene, [mainRect.id], '#123456')))
    const synced = syncComponents(edited, fitText)
    expect(synced).toEqual(fresh(edited))
    // 元の長方形の写しは、どのインスタンスでも新しい色になっている
    const copies = synced.pages.flatMap((p) =>
      Object.values(p.nodes).flatMap((node) => (isInstance(node) && p.nodes[derivedId(node.id, mainRect.id)] ? [p.nodes[derivedId(node.id, mainRect.id)]] : [])),
    )
    expect(copies.length).toBeGreaterThan(5)
    for (const copy of copies) expect(copy.type === 'rect' && copy.fills).toEqual(solid('#123456'))
    // 合っているものをもう一度同期しても、同じ参照のまま
    expect(syncComponents(synced, fitText)).toBe(synced)
  })

  it('編集を重ねても、覚え書きを使った同期と一から同期した結果が同じ', () => {
    const rng = random(20261122)
    const start = fixture()
    const { rowId, componentIds } = start
    let doc = start.doc
    const colors = ['#ef4444', '#22c55e', '#3b82f6', '#eab308']
    for (let step = 0; step < 300; step++) {
      const page = doc.pages[rng.int(doc.pages.length)]
      const ids = Object.keys(page.nodes)
      if (ids.length === 0) continue
      const target = rng.pick(ids)
      const node = page.nodes[target]
      const kind = rng.int(9)
      let raw: DesignDocument
      if (kind === 8) {
        // インスタンスを足す（行の中か、ページ直下）
        const parentId = page.nodes[rowId] && rng.next() < 0.5 ? rowId : null
        raw = createInstance(doc, page.id, rng.pick(componentIds), { center: { x: rng.int(800), y: rng.int(800) }, parentId }).document
      } else {
        raw = updatePage(doc, page.id, (scene) => {
          switch (kind) {
            // 写しを含め、どのノードの色も変える（写しなら上書きになる）
            case 0:
              return setFill(scene, [target], rng.pick(colors))
            // 動かす（写しを動かしても、次の同期で戻る）
            case 1:
              return translateNodes(scene, [target], rng.int(21) - 10, rng.int(21) - 10)
            // 文言を変える
            case 2:
              return node.type === 'text' ? updateNode(scene, target, { text: rng.pick(['OK', 'キャンセル', 'Title', '保存する']) }) : scene
            // 大きさを変える
            case 3:
              return updateNode(scene, target, { width: 20 + rng.int(200) })
            // 行の中で伸ばす・伸ばさない
            case 4:
              return setLayoutFill(scene, [target], 'width', rng.next() < 0.5)
            // 行の向きを変える（伸ばしているインスタンスの親が変わる）
            case 5:
              return scene.nodes[rowId] ? patchLayouts(scene, [rowId], { direction: rng.next() < 0.5 ? 'horizontal' : 'vertical' }) : scene
            // 表示を切り替える
            case 6:
              return updateNode(scene, target, { visible: !node.visible })
            // まれに消す（元の中身や、元そのものも）
            default:
              return rng.next() < 0.3 ? removeNodes(scene, [target]) : scene
          }
        })
      }
      // ストアと同じ順（上書きを覚えてから同期）
      const captured = deepFreeze(captureOverrides(doc, raw))
      const synced = syncComponents(captured, fitText)
      expect(synced, `${step} 回目（種類 ${kind}）`).toEqual(fresh(captured))
      // 同期が引き継いだ元の集まり（inheritMains）が、ページを見直して集めたものと同じ
      for (const page of synced.pages) {
        const found = new Map<string, NodeId>()
        for (const node of Object.values(page.nodes)) if (isMain(node) && !found.has(node.component.id)) found.set(node.component.id, node.id)
        const inherited = new Map([...mainsOf(page)].map(([id, main]) => [id, main.id]))
        expect(inherited, `${step} 回目の元の集まり`).toEqual(found)
        for (const main of mainsOf(page).values()) expect(page.nodes[main.id]).toBe(main)
      }
      doc = synced
    }
    // 途中でインスタンスがなくなっていない（確かめた中身があった）
    expect(doc.pages.some((page) => Object.values(page.nodes).some(isInstance))).toBe(true)
  })
})
