import { describe, expect, it } from 'vitest'
import type { SceneNode } from '../../document/types.ts'
import { createFrame, createRect } from '../nodes.ts'
import { createPage } from '../operations/document.ts'
import { insertNode } from '../operations/tree.ts'
import { constraintMarks } from './constraintMarks.ts'

/** ページの (100, 50) に置いた 200 × 100 の並べないフレームに、x 150, y 60, 30 × 20 の長方形 */
function setup(constraints: SceneNode['constraints'], patch: Partial<SceneNode> = {}) {
  const frame = createFrame({ x: 100, y: 50, width: 200, height: 100 })
  const rect = { ...createRect({ x: 150, y: 60, width: 30, height: 20 }), constraints, ...patch } as SceneNode
  return { page: insertNode(insertNode(createPage('p'), frame), rect, frame.id), frame, rect }
}

describe('constraintMarks（固定の向きの印）', () => {
  it('右・下なら、子の辺から親の右辺・下辺へ線を引く（ページ座標）', () => {
    const { page, rect } = setup({ horizontal: 'end', vertical: 'end' })
    expect(constraintMarks(page, [rect.id])).toEqual([
      { from: { x: 280, y: 120 }, to: { x: 300, y: 120 }, tick: true, dotted: false },
      { from: { x: 265, y: 130 }, to: { x: 265, y: 150 }, tick: true, dotted: false },
    ])
  })

  it('左右は両側の辺へ、中央は親の中心線、拡大縮小は点線', () => {
    const stretch = setup({ horizontal: 'stretch', vertical: 'center' })
    const marks = constraintMarks(stretch.page, [stretch.rect.id])
    expect(marks.map((mark) => mark.to)).toEqual([{ x: 100, y: 120 }, { x: 300, y: 120 }, { x: 288, y: 100 }])
    expect(marks[2]).toMatchObject({ from: { x: 242, y: 100 }, tick: false })
    const scale = setup({ horizontal: 'scale', vertical: 'start' })
    const scaled = constraintMarks(scale.page, [scale.rect.id])
    expect(scaled.filter((mark) => mark.dotted)).toHaveLength(2)
    expect(scaled.filter((mark) => !mark.dotted)).toHaveLength(1)
  })

  it('回した子は、囲む矩形の辺から引く', () => {
    // 90° 回すと囲む矩形は x 155〜175（親の座標）
    const { page, rect } = setup({ horizontal: 'end', vertical: 'start' }, { rotation: 90 })
    expect(constraintMarks(page, [rect.id])[0]).toMatchObject({ from: { x: 275, y: 120 }, to: { x: 300, y: 120 } })
  })

  it('左・上（既定）のまま・複数選択・並べるフレームの並びの中では出さない', () => {
    const plain = setup({ horizontal: 'start', vertical: 'start' })
    expect(constraintMarks(plain.page, [plain.rect.id])).toEqual([])
    const both = setup({ horizontal: 'end', vertical: 'end' })
    expect(constraintMarks(both.page, [both.rect.id, both.frame.id])).toEqual([])
    const top = setup({ horizontal: 'end', vertical: 'end' })
    expect(constraintMarks(top.page, [top.frame.id])).toEqual([])
  })
})
