import { describe, expect, it } from 'vitest'
import { cleanFamilyName, embeddedFamilyOf, firstFamily, fontFamilyValue, fontMime, readFontFileInfo } from './fontFile.ts'
import { testFontBytes, toWoff } from './testFont.ts'

describe('書体ファイル', () => {
  it('先頭のバイト列で種類を見分ける', () => {
    const head = (text: string) => new Uint8Array([...text].map((c) => c.charCodeAt(0)).concat(Array(12).fill(0)))
    expect(fontMime(testFontBytes())).toBe('font/ttf')
    expect(fontMime(head('true'))).toBe('font/ttf')
    expect(fontMime(head('OTTO'))).toBe('font/otf')
    expect(fontMime(head('wOFF'))).toBe('font/woff')
    expect(fontMime(head('wOF2'))).toBe('font/woff2')
    expect(fontMime(head('ttcf'))).toBeNull()
    expect(fontMime(new Uint8Array([0, 1, 0, 0]))).toBeNull()
  })

  it('TrueType の書体名・太さ・斜体を読む', async () => {
    expect(await readFontFileInfo(testFontBytes())).toEqual({ mime: 'font/ttf', family: 'Kdr Test', weight: 400, style: 'normal' })
    expect(await readFontFileInfo(testFontBytes({ family: 'Ünïcode 2', weight: 650, italic: true }))).toEqual({
      mime: 'font/ttf',
      family: 'Ünïcode 2',
      weight: 700,
      style: 'italic',
    })
    // 古い書体の 1〜9 の太さ
    expect(await readFontFileInfo(testFontBytes({ weight: 3 }))).toMatchObject({ weight: 300 })
  })

  it('WOFF は表を展開して読む。壊れたファイルは読まない', async () => {
    const woff = await toWoff(testFontBytes({ family: 'Woff Face', weight: 300 }))
    expect(fontMime(woff)).toBe('font/woff')
    expect(await readFontFileInfo(woff)).toEqual({ mime: 'font/woff', family: 'Woff Face', weight: 300, style: 'normal' })
    // 先頭だけ WOFF2 のもの
    const woff2 = woff.slice()
    woff2[3] = '2'.charCodeAt(0)
    expect(await readFontFileInfo(woff2)).toBeNull()
    expect(await readFontFileInfo(testFontBytes().slice(0, 40))).toBeNull()
    expect(await readFontFileInfo(new Uint8Array(100))).toBeNull()
  })

  it('書体名から使えない文字を除き、テキストの書体名に書く値にする', () => {
    expect(cleanFamilyName('  My, "Font"; {x}  ')).toBe('My Font x')
    expect(cleanFamilyName(',;"')).toBeNull()
    expect(cleanFamilyName('x'.repeat(300))).toHaveLength(200)
    expect(fontFamilyValue('Red Hat Display')).toBe('Red Hat Display')
    expect(fontFamilyValue('Font 2')).toBe('"Font 2"')
    expect(fontFamilyValue('ゴシック')).toBe('"ゴシック"')
    expect(fontFamilyValue('serif')).toBe('"serif"')
    expect(firstFamily('"Font 2", sans-serif')).toBe('Font 2')
    expect(firstFamily('Red Hat Display')).toBe('Red Hat Display')
    const fonts = [{ assetId: 'a', family: 'Font 2', weight: 400, style: 'normal' as const }]
    expect(embeddedFamilyOf(fonts, '"Font 2", serif')).toBe('Font 2')
    expect(embeddedFamilyOf(fonts, 'Font')).toBeNull()
  })
})
