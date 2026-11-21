import { describe, expect, it } from 'vitest'
import type { FrameNode } from '../../document/types.ts'
import { createFrame, createRect } from '../nodes.ts'
import { copyFragment, duplicateNodes, pasteFragment } from './clipboard.ts'
import { createPage } from './document.ts'
import { insertNode, removeNodes } from './tree.ts'

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

describe('copyFragment / pasteFragment', () => {
  it('子孫ごと新しい id で複製し、元の親の中へずらして置く', () => {
    const { doc, frame, inner, rect } = fixture()
    const { scene: next, ids } = pasteFragment(doc, copyFragment(doc, {}, [inner.id, rect.id]), 10)

    expect(ids).toHaveLength(1)
    const copy = next.nodes[ids[0]] as FrameNode
    expect(copy.id).not.toBe(inner.id)
    expect(copy).toMatchObject({ parentId: frame.id, x: 30, y: 20 })
    expect((next.nodes[frame.id] as FrameNode).children).toEqual([inner.id, copy.id])

    expect(copy.children).toHaveLength(1)
    expect(copy.children[0]).not.toBe(rect.id)
    expect(next.nodes[copy.children[0]]).toMatchObject({ parentId: copy.id, x: 5, y: 5 })
    expect(Object.keys(next.nodes)).toHaveLength(6)
  })

  it('元の親が消えていたらページ直下へ、見た目の位置を保って置く', () => {
    const { doc, frame, rect } = fixture()
    const fragment = copyFragment(doc, {}, [rect.id])
    const { scene: next, ids } = pasteFragment(removeNodes(doc, [frame.id]), fragment)
    expect(next.nodes[ids[0]]).toMatchObject({ parentId: null, x: 125, y: 65 })
    expect(next.rootIds.at(-1)).toBe(ids[0])
  })
})

describe('duplicateNodes', () => {
  it('元の親の中で、元のすぐ上（重なり順で 1 つ前面）に置く', () => {
    const { doc, frame, inner, loose } = fixture()
    const second = createRect(bounds)
    const withSecond = insertNode(doc, second, frame.id, 0)
    // frame の子は [second, inner]。second を複製すると second と inner の間に入る
    const { scene, ids } = duplicateNodes(withSecond, [second.id], 10)
    expect((scene.nodes[frame.id] as FrameNode).children).toEqual([second.id, ids[0], inner.id])
    expect(scene.nodes[ids[0]]).toMatchObject({ x: 10, y: 10 })

    // ページ直下の 2 つをまとめて複製すると、それぞれの直上に入る
    const both = duplicateNodes(doc, [frame.id, loose.id], 0)
    expect(both.scene.rootIds).toEqual([frame.id, both.ids[0], loose.id, both.ids[1]])
  })
})
