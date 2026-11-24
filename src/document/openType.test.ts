import { describe, expect, it } from 'vitest'
import { inflateZlib } from './inflate.ts'
import { parseOutlineFont } from './openType.ts'
import { testFontBytes, toWoff } from './testFont.ts'

async function deflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** 格納だけのブロック 1 つの zlib（adler32 は読まないので 0） */
function stored(data: Uint8Array): Uint8Array {
  const n = data.length
  return new Uint8Array([0x78, 0x01, 0x01, n & 0xff, n >> 8, ~n & 0xff, (~n >> 8) & 0xff, ...data, 0, 0, 0, 0])
}

describe('inflateZlib', () => {
  it('zlib で圧縮したものを元に戻す（格納・固定・動的のブロック）', async () => {
    let seed = 1
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const samples = [
      new Uint8Array(0),
      new TextEncoder().encode('abc'),
      new TextEncoder().encode('abcabcabcabcabc'.repeat(200)),
      Uint8Array.from({ length: 70_000 }, () => Math.floor(random() * 256)),
      Uint8Array.from({ length: 20_000 }, (_, i) => (i % 7) * 3 + Math.floor(random() * 4)),
    ]
    for (const sample of samples) expect(inflateZlib(await deflate(sample), sample.length)).toEqual(sample)
    const small = new TextEncoder().encode('stored block')
    expect(inflateZlib(stored(small), small.length)).toEqual(small)
  })

  it('大きさが合わない・壊れたものは例外にする', async () => {
    const data = new TextEncoder().encode('hello hello hello')
    const compressed = await deflate(data)
    expect(() => inflateZlib(compressed, data.length - 1)).toThrow()
    expect(() => inflateZlib(compressed, data.length + 1)).toThrow()
    expect(() => inflateZlib(compressed.subarray(0, 5), data.length)).toThrow()
    expect(() => inflateZlib(new Uint8Array([0x78, 0x9c, 0xff, 0xff]), 10)).toThrow()
  })
})

// TrueType は外側を時計回り、CFF は反時計回りに描く
const box = [
  { type: 'M', x: 50, y: 0 },
  { type: 'L', x: 50, y: 700 },
  { type: 'L', x: 550, y: 700 },
  { type: 'L', x: 550, y: 0 },
]
const cffBox = [
  { type: 'M', x: 50, y: 0 },
  { type: 'L', x: 550, y: 0 },
  { type: 'L', x: 550, y: 700 },
  { type: 'L', x: 50, y: 700 },
]

describe('parseOutlineFont', () => {
  it('TrueType の字の番号・送り幅・輪郭・上下の高さを読む', () => {
    const font = parseOutlineFont(testFontBytes())!
    expect(font.unitsPerEm).toBe(1000)
    expect(font.ascender).toBe(800)
    expect(font.descender).toBe(200)
    expect(font.glyphIndex('A'.codePointAt(0)!)).toBe(1)
    expect(font.glyphIndex(' '.codePointAt(0)!)).toBe(2)
    expect(font.glyphIndex('あ'.codePointAt(0)!)).toBe(0)
    expect(font.advance(1)).toBe(600)
    expect(font.advance(2)).toBe(300)
    expect(font.glyphPath(1)).toEqual([...box, { type: 'Z' }])
    expect(font.glyphPath(2)).toEqual([])
    expect(font.kerning(1, 1)).toBe(0)
  })

  it('CFF（サブルーチンで描く）の輪郭を読む', () => {
    const font = parseOutlineFont(testFontBytes({ outline: 'cff' }))!
    expect(font.glyphIndex('Z'.codePointAt(0)!)).toBe(1)
    expect(font.glyphPath(1)).toEqual([...cffBox, { type: 'Z' }])
    expect(font.glyphPath(0)).toEqual([])
  })

  it('WOFF の表を展開して読む', async () => {
    const font = parseOutlineFont(await toWoff(testFontBytes()))!
    expect(font.glyphPath(1)).toEqual([...box, { type: 'Z' }])
  })

  it('字詰めを GPOS の PairPos と古い kern の表から読む', () => {
    expect(parseOutlineFont(testFontBytes({ kerning: -120 }))!.kerning(1, 1)).toBe(-120)
    expect(parseOutlineFont(testFontBytes({ kerning: 40, legacyKern: true }))!.kerning(1, 1)).toBe(40)
    expect(parseOutlineFont(testFontBytes({ kerning: -120 }))!.kerning(1, 2)).toBe(0)
  })

  it('書体でないもの・途中で切れたものは null（例外にしない）', () => {
    expect(parseOutlineFont(new Uint8Array(20))).toBeNull()
    const bytes = testFontBytes()
    expect(parseOutlineFont(bytes.subarray(0, 100))).toBeNull()
  })

  it('壊れた字は空の輪郭にする', () => {
    const bytes = testFontBytes().slice()
    // glyf の表の中身を壊す（輪郭の数を大きくする）
    const data = new DataView(bytes.buffer)
    const count = data.getUint16(4)
    for (let i = 0; i < count; i++) {
      const record = 12 + i * 16
      if (String.fromCharCode(...bytes.subarray(record, record + 4)) === 'glyf') data.setInt16(data.getUint32(record + 8), 30000)
    }
    const font = parseOutlineFont(bytes)!
    expect(font.glyphPath(1)).toEqual([])
  })
})
