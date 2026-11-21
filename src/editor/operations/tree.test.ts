import { describe, expect, it } from 'vitest'
import { getAbsoluteBounds } from '../../document/geometry.ts'
import type { FrameNode } from '../../document/types.ts'
import { solid } from '../../document/paint.ts'
import { createFrame, createRect, createText } from '../nodes.ts'
import { createPage } from './document.ts'
import { insertNode, moveNode, patchNodes, removeNodes, reparentNodes, updateNode } from './tree.ts'

const bounds = { x: 0, y: 0, width: 100, height: 100 }

function fixture() {
  const frame = createFrame({ x: 100, y: 50, width: 400, height: 300 })
  const inner = createFrame({ x: 20, y: 10, width: 200, height: 100 })
  const rect = createRect({ x: 5, y: 5, width: 10, height: 10 })
  const loose = createRect({ ...bounds, x: 900 })
  let doc = createPage()
  doc = insertNode(doc, frame)
  doc = insertNode(doc, inner, frame.id)
  doc = insertNode(doc, rect, inner.id)
  doc = insertNode(doc, loose)
  return { doc, frame, inner, rect, loose }
}

describe('insertNode', () => {
  it('ページ直下では最前面に追加する', () => {
    const { doc, frame, loose } = fixture()
    expect(doc.rootIds).toEqual([frame.id, loose.id])
    expect(doc.nodes[loose.id].parentId).toBeNull()
  })

  it('フレームの子として指定位置に追加する', () => {
    const { doc, frame, inner } = fixture()
    const back = createRect(bounds)
    const next = insertNode(doc, back, frame.id, 0)
    expect((next.nodes[frame.id] as FrameNode).children).toEqual([back.id, inner.id])
    expect(next.nodes[back.id].parentId).toBe(frame.id)
  })

  it('元のドキュメントを書き換えない', () => {
    const { doc, frame } = fixture()
    const before = structuredClone(doc)
    insertNode(doc, createRect(bounds), frame.id)
    expect(doc).toEqual(before)
  })

  it('フレーム以外を親にはできない', () => {
    const { doc, loose } = fixture()
    expect(() => insertNode(doc, createRect(bounds), loose.id)).toThrow()
  })

  it('同じ id は二重に追加できない', () => {
    const { doc, loose } = fixture()
    expect(() => insertNode(doc, loose)).toThrow()
  })
})

describe('updateNode', () => {
  it('指定したフィールドだけを更新する', () => {
    const { doc, rect } = fixture()
    const next = updateNode(doc, rect.id, { x: 42, fills: solid('#ff0000') })
    expect(next.nodes[rect.id]).toEqual({ ...doc.nodes[rect.id], x: 42, fills: solid('#ff0000') })
  })

  it('値が変わらなければ同じドキュメントを返す', () => {
    const { doc, rect } = fixture()
    expect(updateNode(doc, rect.id, { x: rect.x })).toBe(doc)
    expect(updateNode(doc, 'missing', { x: 1 })).toBe(doc)
  })

  it('木構造のフィールドやノード種別にないフィールドは無視する', () => {
    const { doc, rect } = fixture()
    const patch = { parentId: null, id: 'other', text: 'hello' } as object
    expect(updateNode(doc, rect.id, patch)).toBe(doc)
  })
})

describe('patchNodes', () => {
  it('ノードごとに決めた patch をまとめて当てる。ノードの表を写すのは 1 回', () => {
    const { doc, frame, rect, loose } = fixture()
    const next = patchNodes(doc, [frame.id, rect.id, loose.id], (node) =>
      node.type === 'rect' ? { x: node.x + 1 } : null,
    )
    expect(next.nodes[rect.id].x).toBe(6)
    expect(next.nodes[loose.id].x).toBe(901)
    // null を返したノードは、同じ参照のまま
    expect(next.nodes[frame.id]).toBe(doc.nodes[frame.id])
    expect(doc.nodes[rect.id].x).toBe(5)
  })

  it('何も変わらなければ、同じ参照を返す。存在しない id は飛ばす', () => {
    const { doc, rect } = fixture()
    expect(patchNodes(doc, [rect.id, 'missing'], (node) => ({ x: node.x }))).toBe(doc)
    expect(patchNodes(doc, [rect.id], () => null)).toBe(doc)
  })

  it('同じ id が 2 回あれば、2 回目は 1 回目の結果を受け取る', () => {
    const { doc, rect } = fixture()
    const next = patchNodes(doc, [rect.id, rect.id], (node) => ({ x: node.x + 1 }))
    expect(next.nodes[rect.id].x).toBe(7)
  })
})

describe('removeNodes', () => {
  it('子孫ごと削除し、親の children からも外す', () => {
    const { doc, frame, inner, rect, loose } = fixture()
    const next = removeNodes(doc, [inner.id])
    expect(Object.keys(next.nodes).sort()).toEqual([frame.id, loose.id].sort())
    expect((next.nodes[frame.id] as FrameNode).children).toEqual([])
    expect(next.nodes[rect.id]).toBeUndefined()
  })

  it('親子を同時に指定しても壊れない', () => {
    const { doc, frame, rect, loose } = fixture()
    const next = removeNodes(doc, [rect.id, frame.id])
    expect(next.rootIds).toEqual([loose.id])
    expect(Object.keys(next.nodes)).toEqual([loose.id])
  })

  it('対象がなければ同じドキュメントを返す', () => {
    const { doc } = fixture()
    expect(removeNodes(doc, ['missing'])).toBe(doc)
  })
})

describe('moveNode', () => {
  it('親を付け替えても見た目の位置を保つ', () => {
    const { doc, rect } = fixture()
    expect(getAbsoluteBounds(doc, rect.id)).toMatchObject({ x: 125, y: 65 })

    const next = moveNode(doc, rect.id, null)
    expect(next.nodes[rect.id]).toMatchObject({ parentId: null, x: 125, y: 65 })
    expect(next.rootIds.at(-1)).toBe(rect.id)
  })

  it('別のフレームの中へ移せる', () => {
    const { doc, frame, inner, loose } = fixture()
    const next = moveNode(doc, loose.id, inner.id, 0)
    expect(next.rootIds).toEqual([frame.id])
    expect((next.nodes[inner.id] as FrameNode).children[0]).toBe(loose.id)
    expect(getAbsoluteBounds(next, loose.id)).toMatchObject({ x: 900, y: 0 })
  })

  it('同じ親の中で重なり順を変えられる', () => {
    const { doc, frame, loose } = fixture()
    const next = moveNode(doc, loose.id, null, 0)
    expect(next.rootIds).toEqual([loose.id, frame.id])
    expect(moveNode(doc, loose.id, null, 1)).toBe(doc)
  })

  it('自分自身や子孫の中へは移せない', () => {
    const { doc, frame, inner } = fixture()
    expect(() => moveNode(doc, frame.id, frame.id)).toThrow()
    expect(() => moveNode(doc, frame.id, inner.id)).toThrow()
  })

  it('フレーム以外の中へは移せない', () => {
    const { doc, rect, loose } = fixture()
    expect(() => moveNode(doc, rect.id, loose.id)).toThrow()
    expect(() => moveNode(doc, rect.id, createText(bounds).id)).toThrow()
  })
})

describe('reparentNodes', () => {
  it('親が違うノードだけを移す', () => {
    const { doc, frame, inner, rect, loose } = fixture()
    const next = reparentNodes(doc, [loose.id, rect.id], frame.id)
    expect((next.nodes[frame.id] as FrameNode).children).toEqual([inner.id, rect.id, loose.id])
    expect(getAbsoluteBounds(next, loose.id)).toMatchObject({ x: 900, y: 0 })
    expect(reparentNodes(doc, [inner.id], frame.id)).toBe(doc)
    // 自分自身の中へは入れない
    expect(reparentNodes(doc, [frame.id], inner.id)).toBe(doc)
  })
})
