import { describe, expect, it } from 'vitest'
import type { TextNode } from '../document/types.ts'
import { bandLines } from './render.ts'

/** bandLines が読む項目だけを持つテキスト */
function text(fields: Partial<TextNode>): TextNode {
  return {
    text: '',
    fontSize: 10,
    lineHeight: 1,
    width: 100,
    height: 10,
    maxWidth: null,
    sizing: { width: 'fixed', height: 'fixed' },
    ...fields,
  } as TextNode
}

describe('bandLines（ごく小さい文字の帯）', () => {
  it('字の数で長さを見積もる。半角は文字の大きさの 0.55 倍、全角は 1 倍', () => {
    expect(bandLines(text({ text: 'abcd' }))).toEqual([22])
    expect(bandLines(text({ text: 'あい' }))).toEqual([20])
  })
  it('折り返す幅を超えたら次の行にし、枠に収まる行の数までにする', () => {
    expect(bandLines(text({ text: 'あいうえお', width: 25, height: 20 }))).toEqual([20, 20])
    expect(bandLines(text({ text: 'あいうえお', width: 25, height: 30 }))).toEqual([20, 20, 10])
  })
  it('改行で行を分け、空の行は長さ 0。枠が 1 行より低くても 1 行は描く', () => {
    expect(bandLines(text({ text: 'あ\n\nい', height: 30 }))).toEqual([10, 0, 10])
    expect(bandLines(text({ text: 'あ\nい', height: 4 }))).toEqual([10])
  })
  it('折り返さない（中身に合わせる幅で上限なし）ときも、帯は枠の幅を超えない', () => {
    expect(bandLines(text({ text: 'あいうえお', width: 30, sizing: { width: 'hug', height: 'hug' } }))).toEqual([30])
  })
})
