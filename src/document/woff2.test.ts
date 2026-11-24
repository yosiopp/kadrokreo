import { brotliCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { readFontFileInfo } from './fontFile.ts'
import { hasWoff2Decoder, parseOutlineFont, setWoff2Decoder } from './openType.ts'
import { testFontBytes, toWoff2 } from './testFont.ts'
import { loadWoff2Decoder, setOutlineFonts, textOutlineFont } from './textOutline.ts'
import type { EmbeddedFont } from './types.ts'
import { decodeWoff2 } from './woff2.ts'

const compress = (data: Uint8Array) => brotliCompressSync(data)

/** sfnt の表（名前 → 中身） */
function tables(font: Uint8Array): Map<string, Uint8Array> {
  const data = new DataView(font.buffer, font.byteOffset, font.byteLength)
  const out = new Map<string, Uint8Array>()
  for (let i = 0; i < data.getUint16(4); i++) {
    const record = 12 + i * 16
    const offset = data.getUint32(record + 8)
    out.set(String.fromCharCode(...font.subarray(record, record + 4)), font.subarray(offset, offset + data.getUint32(record + 12)))
  }
  return out
}

describe('decodeWoff2', () => {
  it('変換していない表はそのまま戻す', () => {
    const font = testFontBytes({ kerning: -50 })
    const decoded = decodeWoff2(toWoff2(font, compress, { transform: false }))!
    expect(decoded).not.toBeNull()
    const [before, after] = [tables(font), tables(decoded)]
    expect([...after.keys()]).toEqual([...before.keys()])
    for (const [tag, table] of before) {
      // head は checkSumAdjustment（8〜11 バイト）を計算し直す
      if (tag === 'head') expect([...after.get(tag)!.subarray(12)]).toEqual([...table.subarray(12)])
      else expect([...after.get(tag)!]).toEqual([...table])
    }
  })

  it('変換した glyf / loca / hmtx を組み立て直す', () => {
    const font = testFontBytes()
    const decoded = decodeWoff2(toWoff2(font, compress))!
    const [before, after] = [tables(font), tables(decoded)]
    expect([...after.get('hmtx')!]).toEqual([...before.get('hmtx')!])
    // 字の点の書き方は元と違うことがある（loca の値は変わる）が、loca の形と字の形は同じ
    expect(after.get('loca')!.length).toBe(before.get('loca')!.length)
    const original = parseOutlineFont(font)!
    const rebuilt = parseOutlineFont(decoded)!
    for (const glyph of [0, 1, 2]) {
      expect(rebuilt.glyphPath(glyph)).toEqual(original.glyphPath(glyph))
      expect(rebuilt.advance(glyph)).toBe(original.advance(glyph))
    }
  })

  it('CFF の書体も戻す', () => {
    const font = testFontBytes({ outline: 'cff' })
    const decoded = decodeWoff2(toWoff2(font, compress))!
    expect(parseOutlineFont(decoded)!.glyphPath(1)).toEqual(parseOutlineFont(font)!.glyphPath(1))
  })

  it('壊れた・途中で切れた・WOFF2 でないファイルは null', () => {
    const woff2 = toWoff2(testFontBytes(), compress)
    expect(decodeWoff2(woff2.subarray(0, 60))).toBeNull()
    expect(decodeWoff2(testFontBytes())).toBeNull()
    const collection = woff2.slice()
    collection.set([0x74, 0x74, 0x63, 0x66], 4) // ttcf
    expect(decodeWoff2(collection)).toBeNull()
    for (let i = 0; i < 300; i++) {
      const broken = woff2.slice()
      broken[48 + ((i * 13) % (broken.length - 48))] ^= 1 << (i % 8)
      const result = decodeWoff2(broken)
      if (result !== null) parseOutlineFont(result) // 読めても例外にならない
    }
  })
})

describe('WOFF2 の書体', () => {
  afterEach(() => setOutlineFonts([], {}))

  it('書体名・太さ・斜体をファイルから読む', async () => {
    const woff2 = toWoff2(testFontBytes({ family: 'Woff2 Face', weight: 700, italic: true }), compress)
    expect(await readFontFileInfo(woff2)).toEqual({ mime: 'font/woff2', family: 'Woff2 Face', weight: 700, style: 'italic' })
    const broken = woff2.slice(0, 80)
    expect(await readFontFileInfo(broken)).toBeNull()
  })

  it('戻す処理を読み込んでから、字の形を読む', async () => {
    const font: EmbeddedFont = { family: 'Woff2 Face', weight: 400, style: 'normal', assetId: 'w' }
    const bytes = toWoff2(testFontBytes({ family: 'Woff2 Face' }), compress)
    setOutlineFonts([font], { w: { mime: 'font/woff2', bytes } })
    const text = { fontFamily: 'Woff2 Face', fontWeight: 400 }
    if (!hasWoff2Decoder()) {
      expect(textOutlineFont(text)).toBeNull()
      expect(await loadWoff2Decoder()).toBe(true)
    }
    expect(hasWoff2Decoder()).toBe(true)
    expect(textOutlineFont(text)!.advance(1)).toBe(600)
    expect(await loadWoff2Decoder()).toBe(false)
    setWoff2Decoder(decodeWoff2)
  })
})
