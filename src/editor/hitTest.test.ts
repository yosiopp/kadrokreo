import { describe, expect, it } from 'vitest'
import { findFrameAt, hitTest, hitTestFrameLabel, nodesInMarquee } from './hitTest.ts'
import { createEllipse, createFrame, createRect } from './nodes.ts'
import { createDocument, insertNode, updateNode } from './operations.ts'

function fixture() {
  const frame = createFrame({ x: 100, y: 100, width: 200, height: 200 })
  const inner = createFrame({ x: 50, y: 50, width: 100, height: 100 })
  const child = createRect({ x: 10, y: 10, width: 50, height: 50 })
  const overflow = createRect({ x: 180, y: 0, width: 100, height: 20 })
  const ellipse = createEllipse({ x: 400, y: 100, width: 100, height: 100 })
  let doc = createDocument()
  doc = insertNode(doc, frame)
  doc = insertNode(doc, child, frame.id)
  doc = insertNode(doc, inner, frame.id)
  doc = insertNode(doc, overflow, frame.id)
  doc = insertNode(doc, ellipse)
  return { doc, frame, inner, child, overflow, ellipse }
}

describe('hitTest', () => {
  it('最も手前・最も深いノードを返す', () => {
    const { doc, frame, inner, child } = fixture()
    expect(hitTest(doc, { x: 120, y: 120 })).toBe(child.id)
    // child と inner が重なる位置では、後から入れた inner が手前
    expect(hitTest(doc, { x: 155, y: 155 })).toBe(inner.id)
    expect(hitTest(doc, { x: 110, y: 290 })).toBe(frame.id)
    expect(hitTest(doc, { x: 50, y: 50 })).toBeNull()
  })

  it('クリップされてはみ出した部分には当たらない', () => {
    const { doc, frame, overflow } = fixture()
    expect(hitTest(doc, { x: 290, y: 110 })).toBe(overflow.id)
    expect(hitTest(doc, { x: 350, y: 110 })).toBeNull()

    const unclipped = updateNode(doc, frame.id, { clipContent: false })
    expect(hitTest(unclipped, { x: 350, y: 110 })).toBe(overflow.id)
  })

  it('楕円は外接矩形の角では当たらない', () => {
    const { doc, ellipse } = fixture()
    expect(hitTest(doc, { x: 450, y: 150 })).toBe(ellipse.id)
    expect(hitTest(doc, { x: 403, y: 103 })).toBeNull()
  })

  it('ロック中・非表示のノードは子も含めて当たらない', () => {
    const { doc, frame, ellipse } = fixture()
    expect(hitTest(updateNode(doc, frame.id, { locked: true }), { x: 120, y: 120 })).toBeNull()
    expect(hitTest(updateNode(doc, ellipse.id, { visible: false }), { x: 450, y: 150 })).toBeNull()
  })

  it('tolerance のぶんだけ外側でも当たる', () => {
    const { doc, frame } = fixture()
    expect(hitTest(doc, { x: 98, y: 150 })).toBeNull()
    expect(hitTest(doc, { x: 98, y: 150 }, 3)).toBe(frame.id)
  })
})

describe('hitTestFrameLabel', () => {
  it('ページ直下のフレームの名前ラベルに当たる', () => {
    const { doc, frame } = fixture()
    const viewport = { x: 0, y: 0, zoom: 2 }
    const measure = () => 40
    expect(hitTestFrameLabel(doc, viewport, { x: 210, y: 190 }, measure)).toBe(frame.id)
    expect(hitTestFrameLabel(doc, viewport, { x: 250, y: 190 }, measure)).toBeNull()
    expect(hitTestFrameLabel(doc, viewport, { x: 210, y: 205 }, measure)).toBeNull()
  })
})

describe('findFrameAt', () => {
  it('最も深いフレームを返す', () => {
    const { doc, frame, inner } = fixture()
    expect(findFrameAt(doc, { x: 160, y: 160 })).toBe(inner.id)
    expect(findFrameAt(doc, { x: 110, y: 110 })).toBe(frame.id)
    expect(findFrameAt(doc, { x: 450, y: 150 })).toBeNull()
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
