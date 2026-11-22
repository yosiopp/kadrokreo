import { describe, expect, it } from 'vitest'
import { findFrameAt, nodesInMarquee } from './hitTest.ts'
import { createEllipse, createFrame, createRect } from './nodes.ts'
import { createPage } from './operations/document.ts'
import { insertNode } from './operations/tree.ts'

function fixture() {
  const frame = createFrame({ x: 100, y: 100, width: 200, height: 200 })
  const inner = createFrame({ x: 50, y: 50, width: 100, height: 100 })
  const child = createRect({ x: 10, y: 10, width: 50, height: 50 })
  const overflow = createRect({ x: 180, y: 0, width: 100, height: 20 })
  const ellipse = createEllipse({ x: 400, y: 100, width: 100, height: 100 })
  let doc = createPage()
  doc = insertNode(doc, frame)
  doc = insertNode(doc, child, frame.id)
  doc = insertNode(doc, inner, frame.id)
  doc = insertNode(doc, overflow, frame.id)
  doc = insertNode(doc, ellipse)
  return { doc, frame, inner, child, overflow, ellipse }
}

// ポインタの下のノードを探す hitTest（viewer と共通）のテストは canvas/hitTest.test.ts にある

describe('findFrameAt', () => {
  it('最も深いフレームを返す', () => {
    const { doc, frame, inner } = fixture()
    expect(findFrameAt(doc, { x: 160, y: 160 })).toBe(inner.id)
    expect(findFrameAt(doc, { x: 110, y: 110 })).toBe(frame.id)
    expect(findFrameAt(doc, { x: 450, y: 150 })).toBeNull()
  })

  it('回したフレームも、回った位置で探す', () => {
    const frame = { ...createFrame({ x: 0, y: 0, width: 200, height: 100 }), rotation: 180 }
    const child = createRect({ x: 0, y: 0, width: 20, height: 20 })
    const doc = insertNode(insertNode(createPage(), frame), child, frame.id)
    expect(findFrameAt(doc, { x: 190, y: 90 })).toBe(frame.id)
  })

  it('除外したフレームとその中は候補にしない', () => {
    const { doc, frame, inner } = fixture()
    expect(findFrameAt(doc, { x: 160, y: 160 }, new Set([inner.id]))).toBe(frame.id)
    expect(findFrameAt(doc, { x: 160, y: 160 }, new Set([frame.id]))).toBeNull()
  })
})

describe('nodesInMarquee', () => {
  it('完全に収まったフレームはフレームごと選ぶ', () => {
    const { doc, frame, ellipse } = fixture()
    const all = nodesInMarquee(doc, { x: 0, y: 0, width: 1000, height: 1000 })
    expect(all).toEqual([frame.id, ellipse.id])
  })

  it('はみ出しているフレームは中身のうち範囲にかかるものを選ぶ', () => {
    const { doc, child } = fixture()
    expect(nodesInMarquee(doc, { x: 90, y: 90, width: 30, height: 30 })).toEqual([child.id])
  })
})
