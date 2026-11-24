import { describe, expect, it } from 'vitest'
import { fontFaceRule, fontFileName, usedFontFaces } from './fontFace.ts'
import type { Asset, EmbeddedFont } from './types.ts'

const asset = (mime: string): Asset => ({ mime, bytes: new Uint8Array([1, 2, 3]) })
const assets = { a: asset('font/ttf'), b: asset('font/otf'), c: asset('font/woff'), d: asset('font/ttf') }
const font = (assetId: string, family: string, weight = 400, style: 'normal' | 'italic' = 'normal'): EmbeddedFont => ({ assetId, family, weight, style })

describe('usedFontFaces', () => {
  const fonts = [font('a', 'Brand'), font('b', 'Brand', 700), font('c', 'Brand', 400, 'italic'), font('d', 'Other')]

  it('テキストが使う書体だけを、太さを CSS と同じ選び方で選び、document.fonts の順に返す', () => {
    const used = usedFontFaces(fonts, assets, [
      { fontFamily: 'Brand', fontWeight: 800 },
      { fontFamily: 'Brand', fontWeight: 300 },
      { fontFamily: 'sans-serif', fontWeight: 400 },
    ])
    expect(used).toEqual([fonts[0], fonts[1]])
  })

  it('書体名の並びの先頭で選び、斜体は斜体でない書体がないときだけ使う。ファイルの無い書体は選ばない', () => {
    expect(usedFontFaces(fonts, assets, [{ fontFamily: '"Other", serif', fontWeight: 400 }])).toEqual([fonts[3]])
    const italicOnly = [font('c', 'Slant', 400, 'italic')]
    expect(usedFontFaces(italicOnly, assets, [{ fontFamily: 'Slant', fontWeight: 400 }])).toEqual(italicOnly)
    expect(usedFontFaces([font('x', 'Brand')], assets, [{ fontFamily: 'Brand', fontWeight: 400 }])).toEqual([])
  })
})

describe('fontFaceRule と fontFileName', () => {
  it('形式・太さ・斜体を書き、url の引用符はエスケープする', () => {
    const rule = fontFaceRule(font('b', 'Red Hat Display', 700, 'italic'), 'font/otf', 'a"b.otf')
    expect(rule).toBe(
      '@font-face {\n  font-family: "Red Hat Display";\n  src: url("a\\"b.otf") format("opentype");\n  font-weight: 700;\n  font-style: italic;\n}',
    )
  })

  it('ファイル名は書体名の空白と使えない文字を - にし、太さと斜体と拡張子を付ける', () => {
    expect(fontFileName(font('a', 'Red Hat Display', 700), 'font/ttf')).toBe('Red-Hat-Display-700.ttf')
    expect(fontFileName(font('c', 'ゴシック/体', 400, 'italic'), 'font/woff')).toBe('ゴシック-体-400-italic.woff')
  })
})
