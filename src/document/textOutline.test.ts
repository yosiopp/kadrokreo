import { afterEach, describe, expect, it } from 'vitest'
import { booleanParts, booleanResult, canBoolean, type BooleanNode } from './booleanNode.ts'
import { pathBounds, type Contour } from './path.ts'
import { testFontBytes } from './testFont.ts'
import { frame, rect, sceneOf, text } from './testNodes.ts'
import { matchWeight, outlineFontsGeneration, setOutlineFonts, textOutline, textOutlineFont } from './textOutline.ts'
import type { Asset, EmbeddedFont } from './types.ts'

const FONT_ID = 'f'.repeat(64)
const BOLD_ID = 'b'.repeat(64)
const assets: Record<string, Asset> = {
  [FONT_ID]: { mime: 'font/ttf', bytes: testFontBytes() },
  [BOLD_ID]: { mime: 'font/ttf', bytes: testFontBytes({ weight: 700, outline: 'cff' }) },
}
const fonts: EmbeddedFont[] = [
  { assetId: FONT_ID, family: 'Kdr Test', weight: 400, style: 'normal' },
  { assetId: BOLD_ID, family: 'Kdr Test', weight: 700, style: 'normal' },
]

afterEach(() => setOutlineFonts([], {}))

/** 輪郭ごとの囲む矩形（四捨五入） */
function boxes(contours: readonly Contour[]) {
  return contours.map((contour) => {
    const b = pathBounds(contour.vertices, true)
    return [b.x, b.y, b.width, b.height].map((value) => Math.round(value * 100) / 100)
  })
}

describe('matchWeight', () => {
  it('CSS と同じく、いちばん近い太さを選ぶ', () => {
    expect(matchWeight([400, 700], 400)).toBe(400)
    expect(matchWeight([300, 700], 400)).toBe(300)
    expect(matchWeight([500, 700], 400)).toBe(500)
    expect(matchWeight([400, 700], 600)).toBe(700)
    expect(matchWeight([400, 900], 800)).toBe(900)
    expect(matchWeight([400], 900)).toBe(400)
    expect(matchWeight([200, 600], 300)).toBe(200)
    expect(matchWeight([], 400)).toBeNull()
  })
})

describe('textOutline', () => {
  it('埋め込んでいない書体のテキストは null', () => {
    expect(textOutline(text({ fontFamily: 'Kdr Test', text: 'A' }))).toBeNull()
    setOutlineFonts(fonts, assets)
    expect(textOutline(text({ fontFamily: 'sans-serif', text: 'A' }))).toBeNull()
  })

  it('字を描画と同じ基線・送り幅で並べる', () => {
    setOutlineFonts(fonts, assets)
    // 大きさ 100 → 1 単位 0.1px。上下の高さ 80 / 20、行の高さ 120 なので基線は (120 - 100) / 2 + 80 = 90
    const outline = textOutline(text({ fontFamily: 'Kdr Test', text: 'A B', fontSize: 100, lineHeight: 1.2, width: 200 }))!
    expect(outline.missing).toBe(0)
    expect(boxes(outline.contours)).toEqual([
      [5, 20, 50, 70],
      [95, 20, 50, 70],
    ])
  })

  it('行揃え・改行・折り返し・裏返しを描画と合わせる', () => {
    setOutlineFonts(fonts, assets)
    const centered = textOutline(text({ fontFamily: 'Kdr Test', text: 'A\nAA', fontSize: 100, lineHeight: 1, width: 200, textAlign: 'center' }))!
    // 1 行目は幅 60 を真ん中に、2 行目（100px 下）は幅 120
    expect(boxes(centered.contours)).toEqual([
      [75, 10, 50, 70],
      [45, 110, 50, 70],
      [105, 110, 50, 70],
    ])
    // 幅 130 で折り返すと、「AA AA」は 2 行になる
    const wrapped = textOutline(text({ fontFamily: 'Kdr Test', text: 'AA AA', fontSize: 100, lineHeight: 1, width: 130, sizing: { width: 'fixed', height: 'hug' } }))!
    expect(boxes(wrapped.contours).map(([, y]) => y)).toEqual([10, 10, 110, 110])
    const flipped = textOutline(text({ fontFamily: 'Kdr Test', text: 'A', fontSize: 100, lineHeight: 1, width: 100, height: 100, flipX: true }))!
    expect(boxes(flipped.contours)).toEqual([[45, 10, 50, 70]])
  })

  it('書体に無い文字は除いて数える。太さはいちばん近い書体を使う', () => {
    setOutlineFonts(fonts, assets)
    const outline = textOutline(text({ fontFamily: '"Kdr Test", sans-serif', text: 'Aあ A', fontSize: 100, width: 300 }))!
    expect(outline.missing).toBe(1)
    expect(outline.contours).toHaveLength(2)
    expect(textOutlineFont(text({ fontFamily: 'Kdr Test', fontWeight: 900 }))).not.toBe(textOutlineFont(text({ fontFamily: 'Kdr Test', fontWeight: 400 })))
    expect(textOutline(text({ fontFamily: 'Kdr Test', fontWeight: 800, text: 'A', fontSize: 100 }))!.contours).toHaveLength(1)
  })

  it('書体の並びとファイルが同じなら覚えた結果を捨てない', () => {
    setOutlineFonts(fonts, assets)
    const before = outlineFontsGeneration()
    setOutlineFonts([...fonts], { ...assets, other: { mime: 'image/png', bytes: new Uint8Array(1) } })
    expect(outlineFontsGeneration()).toBe(before)
    setOutlineFonts(fonts.slice(0, 1), assets)
    expect(outlineFontsGeneration()).toBe(before + 1)
  })
})

describe('テキストを入れたブーリアン演算', () => {
  const node = (): BooleanNode => frame({ id: 'b', width: 200, height: 100, children: ['r', 't'], booleanOperation: 'subtract' }) as BooleanNode
  const scene = () =>
    sceneOf(
      node(),
      rect({ id: 'r', parentId: 'b', width: 200, height: 100 }),
      text({ id: 't', parentId: 'b', fontFamily: 'Kdr Test', text: 'A', fontSize: 100, lineHeight: 1, width: 60, height: 100 }),
    )

  it('埋め込んだ書体のテキストは文字の形で演算に入る', () => {
    setOutlineFonts(fonts, assets)
    const s = scene()
    const b = s.nodes.b as BooleanNode
    expect(canBoolean(s.nodes.t)).toBe(true)
    expect(booleanParts(s, b).map((part) => part.id)).toEqual(['r', 't'])
    // 矩形から文字の四角（5〜55, 10〜80）を引くと、穴のある形になる
    expect(boxes(booleanResult(s, b)).sort()).toEqual([
      [0, 0, 200, 100],
      [5, 10, 50, 70],
    ])
  })

  it('書体を外すとテキストは演算から外れ、結果も計算し直す', () => {
    setOutlineFonts(fonts, assets)
    const s = scene()
    const b = s.nodes.b as BooleanNode
    expect(booleanResult(s, b)).toHaveLength(2)
    setOutlineFonts([], assets)
    expect(canBoolean(s.nodes.t)).toBe(false)
    expect(booleanResult(s, b)).toHaveLength(1)
  })
})
