import { brotliCompressSync, constants } from 'node:zlib'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { EMBEDDED_FAMILY_FORBIDDEN, FONT_MIME_TYPES, MAX_EMBEDDED_FAMILY_LENGTH, fontMime, readFontFileInfo } from './fontFile.ts'
import { type OutlineFont, parseOutlineFont, setWoff2Decoder } from './openType.ts'
import { testFontBytes, toWoff, toWoff2 } from './testFont.ts'
import { EDGE_16, EDGE_32, type Random, corrupt, fuzz, fuzzAsync, mutate } from './testFuzz.ts'
import { decodeWoff2 } from './woff2.ts'

// 書体ファイルを読む処理（OpenType の表・WOFF・WOFF2・書体名の読み取り）のファズテスト。書体は kdr に埋め込まれて届く、信頼できない入力。
// どんなバイト列でも「読めない（null）」か「読めて、字の番号・送り幅・字詰め・輪郭を引いても例外にならず、有限の数だけが返る」かのどちらかで、
// 入力の大きさに見合った時間で終わることを確かめる。
// 入力は、正しい書体を壊したもの（表の中を狙って壊す・全体を壊す）、表の形に沿って個数や参照だけ乱数にしたもの（合成字が指し合う・
// サブルーチンが呼び合う・個数の欄が大きい）、まったくの乱数の 3 通り。圧縮や tar は decoderFuzz.test.ts。

// 手元では 1 本あたり 0.5 秒以内。CI の遅い環境でも時間切れにならないよう、上限を延ばしておく
vi.setConfig({ testTimeout: 30_000 })

setWoff2Decoder(decodeWoff2)

const compress = (data: Uint8Array) => brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 1 } })

const u16 = (...values: number[]) => values.flatMap((value) => [(value >> 8) & 0xff, value & 0xff])
const u32 = (...values: number[]) => values.flatMap((value) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])
const tagBytes = (tag: string) => [...tag].map((char) => char.charCodeAt(0))

type Tables = Map<string, readonly number[]>

/** sfnt の表（名前 → 中身） */
function tablesOf(font: Uint8Array): Tables {
  const data = new DataView(font.buffer, font.byteOffset, font.byteLength)
  const out: Tables = new Map()
  for (let i = 0; i < data.getUint16(4); i++) {
    const record = 12 + i * 16
    const offset = data.getUint32(record + 8)
    out.set(String.fromCharCode(...font.subarray(record, record + 4)), [...font.subarray(offset, offset + data.getUint32(record + 12))])
  }
  return out
}

/** 表を並べて sfnt にする（チェックサムは読まれないので 0） */
function sfntOf(tables: Tables, version: number): Uint8Array<ArrayBuffer> {
  const tags = [...tables.keys()].sort()
  const directory = [...u32(version), ...u16(tags.length, 0, 0, 0)]
  const offsets: number[] = []
  let offset = 12 + tags.length * 16
  for (const tag of tags) {
    const length = tables.get(tag)!.length
    directory.push(...tagBytes(tag), ...u32(0, offset, length))
    offsets.push(offset)
    offset += Math.ceil(length / 4) * 4
  }
  const out = new Uint8Array(offset)
  out.set(directory)
  tags.forEach((tag, i) => out.set(tables.get(tag)!, offsets[i]))
  return out
}

/** 表の一覧（sfnt・WOFF）から表を 1 つ選び、その中を 1 か所壊す（一覧が壊れていて選べなければ、全体のどこかを壊す） */
function corruptTable(random: Random, font: Uint8Array): void {
  const data = new DataView(font.buffer, font.byteOffset, font.byteLength)
  const woff = font[0] === 0x77
  const count = data.getUint16(woff ? 12 : 4)
  const record = (woff ? 44 : 12) + random.int(0, Math.max(0, count - 1)) * (woff ? 20 : 16)
  if (record + 20 > font.length) return corrupt(random, font)
  const offset = data.getUint32(record + (woff ? 4 : 8))
  const end = Math.min(font.length, offset + data.getUint32(record + (woff ? 8 : 12)))
  if (end > offset) corrupt(random, font, offset, end)
  else corrupt(random, font)
}

/** 輪郭の命令の数の上限。字 1 つにかけてよい手間（点 5 万個ぶん）から決まり、これより多くなる字は読めない字として空になる */
const MAX_COMMANDS = 200_000

/** 読めた書体から、字の番号・送り幅・字詰め・輪郭を引く。例外にならず、有限の数だけが返ること */
function exercise(font: OutlineFont, random: Random): void {
  const numbers = [font.unitsPerEm, font.ascender, font.descender]
  const glyphs = [0, 1, 2, 3, 4, 5, random.int(0, 0xffff), font.glyphIndex(0x41), font.glyphIndex(0x20), font.glyphIndex(random.int(0, 0x10ffff))]
  for (const glyph of glyphs) {
    numbers.push(glyph, font.advance(glyph))
    const path = font.glyphPath(glyph)
    if (path.length > MAX_COMMANDS) throw new Error(`字 ${glyph} の輪郭の命令が多すぎます（${path.length} 個）`)
    for (const command of path) {
      if (command.type === 'Z') continue
      numbers.push(command.x, command.y)
      if (command.type === 'Q' || command.type === 'C') numbers.push(command.x1, command.y1)
      if (command.type === 'C') numbers.push(command.x2, command.y2)
    }
  }
  for (let i = 0; i < 6; i++) numbers.push(font.kerning(random.pick(glyphs), random.pick(glyphs)))
  if (!numbers.every(Number.isFinite)) throw new Error('有限でない数が返りました')
}

function checkOutlineFont(bytes: Uint8Array, random: Random): void {
  const font = parseOutlineFont(bytes)
  if (font !== null) exercise(font, random)
}

// ---- 表の形に沿って、個数や参照だけを乱数にしたもの

/** 合成字が互いを（自分自身も）指し合う glyf / loca */
function compositeGlyphs(random: Random, base: Tables): Tables {
  const box = base.get('glyf')!
  const count = random.int(2, 6)
  const glyphs: (readonly number[])[] = []
  for (let glyph = 0; glyph < count; glyph++) {
    if (glyph === 0 || random.chance(0.2)) {
      glyphs.push(box)
      continue
    }
    const bytes = u16(0xffff, 0, 0, 100, 100)
    const parts = random.pick([1, 1, 2, 2, 3, 12, 40])
    for (let part = 0; part < parts; part++) {
      const scale = random.pick([0, 0, 0x8, 0x40, 0x80])
      const words = random.chance(0.5)
      const flags = (words ? 0x1 : 0) | (random.chance(0.9) ? 0x2 : 0) | (part < parts - 1 ? 0x20 : 0) | scale
      // たいていは前の字を指す。ときどき自分や後ろの字（輪になる）、字の数を超える番号
      const target = random.chance(0.7) ? random.int(0, glyph - 1) : random.chance(0.7) ? random.int(0, count - 1) : random.pick(EDGE_16)
      bytes.push(...u16(flags, target), ...random.bytes((words ? 4 : 2) + (scale === 0x8 ? 2 : scale === 0x40 ? 4 : scale === 0x80 ? 8 : 0)))
    }
    if (bytes.length % 2 === 1) bytes.push(0)
    glyphs.push(bytes)
  }
  const offsets = [0]
  for (const glyph of glyphs) offsets.push(offsets[offsets.length - 1] + glyph.length)
  const long = random.chance(0.5)
  const head = [...base.get('head')!]
  head[51] = long ? 1 : 0
  const maxp = [...base.get('maxp')!]
  maxp[5] = count
  return new Map([...base, ['glyf', glyphs.flat()], ['loca', long ? u32(...offsets) : u16(...offsets.map((offset) => offset / 2))], ['head', head], ['maxp', maxp]])
}

const cffNumber = (value: number) => (value >= -107 && value <= 107 ? [value + 139] : [28, (value >> 8) & 0xff, value & 0xff])
const cffInt32 = (value: number) => [29, ...u32(value)]

function cffIndex(items: readonly number[][]): number[] {
  if (items.length === 0) return [0, 0]
  const offsets = [1]
  for (const item of items) offsets.push(offsets[offsets.length - 1] + item.length)
  return [...u16(items.length), 2, ...u16(...offsets), ...items.flat()]
}

/**
 * Type 2 の字形の命令の並び。dense ならサブルーチンの呼び出しだけを並べる。next を渡すと、呼ぶのはその番号のサブルーチンだけ
 * （どれも 1 つ後ろだけを何度も呼ぶようにすると、輪にならず、入れ子の上限に届かないまま呼び出しが掛け算で増える）
 */
function charString(random: Random, subrs: number, globals: number, dense: boolean, next?: number): number[] {
  const out: number[] = []
  for (let step = random.int(1, dense ? 30 : 12); step > 0; step--) {
    if (dense || random.chance(0.25)) {
      // 最後のサブルーチン（next が無い番号）は何も呼ばない
      if (next !== undefined) out.push(...(next < subrs ? [...cffNumber(next - 107), 10] : []))
      else if (globals > 0 && random.chance(0.3)) out.push(...cffNumber(random.int(0, globals - 1) - 107), 29)
      else out.push(...cffNumber((random.chance(0.95) ? random.int(0, subrs - 1) : random.int(-3, 300)) - 107), 10)
      continue
    }
    for (let operands = random.int(0, 7); operands > 0; operands--) out.push(...cffNumber(random.int(-300, 300)))
    const operator = random.pick([21, 22, 4, 5, 6, 7, 8, 24, 25, 26, 27, 30, 31, 1, 3, 18, 23, 19, 20, 11, 14, 12, 255, random.int(0, 31)])
    out.push(operator)
    if (operator === 12) out.push(random.pick([34, 35, 36, 37, random.int(0, 255)]))
    if (operator === 19 || operator === 20) out.push(random.int(0, 255))
    if (operator === 255) out.push(...random.bytes(4))
  }
  return out
}

/** サブルーチンが互いを（自分自身も）呼び合う CFF。半分は、字ごとにサブルーチンの組を選ぶ CID の書体（FDArray / FDSelect）にする */
function subroutineGraph(random: Random, base: Tables): Tables {
  // layered: サブルーチンは 1 つ後ろだけを呼ぶ（段になる）。そうでなければ、どれでも呼ぶ（輪になる）
  const layered = random.chance(0.04)
  const subrCount = layered ? random.int(6, 10) : random.int(1, 5)
  const globalCount = random.int(0, 3)
  const dense = random.chance(0.15)
  const make = (next?: number) => charString(random, subrCount, globalCount, layered || (dense && random.chance(0.8)), next)
  const charStrings = cffIndex(Array.from({ length: 3 }, () => make(layered ? 0 : undefined)))
  const subrs = cffIndex(Array.from({ length: subrCount }, (_, i) => make(layered ? i + 1 : undefined)))
  const globals = cffIndex(Array.from({ length: globalCount }, () => make()))
  // Private DICT は Subrs の位置（Private DICT の先頭から数える）だけ。数の書き方（1・2・3 バイト、実数）も混ぜる
  const privateDict = [...random.pick([[], cffNumber(random.int(-1131, 1131)), [30, 0x1a, 0x5f], [247 + random.int(0, 7), random.int(0, 255)]]), 20, ...cffInt32(0), 19]
  privateDict.splice(-6, 6, ...cffInt32(privateDict.length), 19)
  const cid = random.chance(0.5)
  const fdSelect = random.chance(0.5) ? [0, random.int(0, 2), random.int(0, 2), random.int(0, 2)] : [3, ...u16(2, 0), random.int(0, 2), ...u16(random.int(0, 3)), random.int(0, 2), ...u16(random.pick([3, 3, 0, 0xffff]))]
  const fontDict = (privateAt: number) => [...cffInt32(privateDict.length), ...cffInt32(privateAt), 18]
  const fdArray = (privateAt: number) => cffIndex(Array.from({ length: random.int(1, 3) }, () => fontDict(random.chance(0.9) ? privateAt : random.pick(EDGE_32))))
  const top = (charStringsAt: number, privateAt: number) => {
    const dict = [...cffInt32(charStringsAt), 17, ...cffInt32(privateDict.length), ...cffInt32(privateAt), 18]
    // CID: ROS（12 30）・FDArray（12 36）・FDSelect（12 37）。どちらも Private DICT とサブルーチンの後ろに置く
    if (cid) dict.push(...cffNumber(0), ...cffNumber(0), ...cffNumber(0), 12, 30, ...cffInt32(privateAt + privateDict.length + subrs.length + fdSelect.length), 12, 36, ...cffInt32(privateAt + privateDict.length + subrs.length), 12, 37)
    return cffIndex([dict])
  }
  const start = [1, 0, 4, 4, ...cffIndex([[0x46]])]
  const charStringsAt = start.length + top(0, 0).length + 2 + globals.length
  const privateAt = charStringsAt + charStrings.length
  const cff = [...start, ...top(charStringsAt, privateAt), 0, 0, ...globals, ...charStrings, ...privateDict, ...subrs]
  if (cid) cff.push(...fdSelect, ...fdArray(privateAt))
  return new Map([...base, ['CFF ', cff]])
}

/** 文字の範囲の並びを乱数にした cmap（format 12 と format 4） */
function cmapGroups(random: Random, base: Tables): Tables {
  const count = random.int(0, 6)
  const claimed = random.chance(0.85) ? count : random.pick([0, 1, 0xffff, 0x10000000])
  const glyph = () => (random.chance(0.9) ? random.int(0, 5) : random.pick(EDGE_16))
  let code = random.pick([0, 0x20, 0x41])
  const ranges = Array.from({ length: count }, () => {
    const start = code + random.int(0, 30)
    const end = random.chance(0.9) ? start + random.int(0, 60) : random.pick([0, start - 1, 0xffff, 0x10ffff])
    code = Math.max(start, end) + 1
    return { start, end, glyph: glyph() }
  })
  let subtable: number[]
  if (random.chance(0.6)) {
    subtable = [...u16(12, 0), ...u32(16 + count * 12, 0, claimed), ...ranges.flatMap((range) => u32(range.start, range.end, range.glyph))]
  } else {
    // format 4: 終わり・（0）・始まり・ずれ・字の番号の並びへの位置。最後の区切りは 0xffff
    const segments = [...ranges, { start: 0xffff, end: 0xffff, glyph: 0 }]
    const offsets = segments.map((_, i) => (random.chance(0.3) ? (segments.length - i) * 2 : 0))
    subtable = [
      ...u16(4, 0, 0, random.chance(0.85) ? segments.length * 2 : random.pick(EDGE_16), 0, 0, 0),
      ...u16(...segments.map((segment) => segment.end)), 0, 0,
      ...u16(...segments.map((segment) => segment.start)),
      ...u16(...segments.map((segment) => segment.glyph - segment.start)),
      ...u16(...offsets),
      ...u16(...Array.from({ length: random.int(0, 40) }, glyph)),
    ]
  }
  return new Map([...base, ['cmap', [...u16(0, 1), ...u16(random.pick([3, 3, 0, 1]), random.pick([10, 1, 0])), ...u32(12), ...subtable]]])
}

/** 個数と長さの欄を乱数にした古い kern の表 */
function kernCounts(random: Random, base: Tables): Tables {
  const full = random.chance(0.01)
  const kern = u16(0, full ? 0xffff : random.pick([0, 1, 2, 3, 0xffff]))
  for (let subtable = random.int(1, 3); subtable > 0; subtable--) {
    const pairs = full ? 0xffff : random.pick([0, 1, 3, 40])
    const length = !full && random.chance(0.7) ? 14 + pairs * 6 : random.pick([0, 0, 6, 14, 0xffff])
    kern.push(...u16(0, length, random.pick([1, 1, 1, 1, 0, 3, 5, 0x8001]), random.chance(0.85) ? pairs : random.pick(EDGE_16), 0, 0, 0))
    for (let pair = 0; pair < pairs; pair++) kern.push(0, random.int(0, 3), 0, random.int(0, 3), 0, random.int(0, 255))
  }
  const tables = new Map([...base, ['kern', kern]])
  tables.delete('GPOS')
  return tables
}

/** 字詰めの小表（PairPos）。組を並べる format 1 と、字を組に分けて表で引く format 2。字の範囲（Coverage）と組分け（ClassDef）も 2 通り */
function pairPos(random: Random): number[] {
  const formats = [random.pick([4, 4, 4, 0, 5, 0xff]), random.pick([0, 0, 4])]
  const coverage = random.chance(0.5) ? u16(1, 2, 1, 2) : u16(2, 1, random.int(0, 1), random.pick([2, 5, 0xffff]), 0)
  const value = () => u16(random.int(-80, 80) & 0xffff)
  if (random.chance(0.5)) {
    const pairSet = [...u16(2, 1), ...value(), ...u16(2), ...value()]
    return [...u16(1, 14, ...formats, random.pick([2, 2, 0, 0xffff]), 14 + coverage.length, 14 + coverage.length), ...coverage, ...pairSet]
  }
  const classDef = () => (random.chance(0.5) ? u16(1, random.int(0, 2), 4, 0, 1, 1, 0) : u16(2, 2, 0, 1, 0, 2, 5, 1))
  const [first, second] = [classDef(), classDef()]
  const records = [...value(), ...value(), ...value(), ...value()]
  const at = 16 + records.length
  const counts = [random.pick([2, 2, 0, 0xffff]), random.pick([2, 2, 0xffff])]
  return [...u16(2, at, ...formats, at + coverage.length, at + coverage.length + first.length, ...counts), ...records, ...coverage, ...first, ...second]
}

/** 機能・ルックアップ・小表の個数を乱数にした GPOS（小表はどれも同じ PairPos を指す） */
function gposCounts(random: Random, base: Tables): Tables {
  // 40 回に 1 回ずつ、個数の欄を大きくする（1: 機能とその中の番号が多い、2: ルックアップと小表が多い）
  const full = random.pick([1, 2, ...new Array<number>(78).fill(0)])
  const small = () => random.pick([1, 2, 20])
  const features = full === 1 ? 5000 : small()
  const refs = full === 1 ? 15_000 : full === 2 ? 30_000 : small()
  const lookups = full === 2 ? 30_000 : random.int(1, 3)
  const subtables = full === 2 ? 0xffff : small()
  const featureList = u16(features)
  for (let i = 0; i < features; i++) featureList.push(...tagBytes(random.chance(0.9) ? 'kern' : 'liga'), ...u16(2 + features * 6))
  featureList.push(...u16(0, refs))
  for (let i = 0; i < refs; i++) featureList.push(...u16(full === 2 || random.chance(0.9) ? i % lookups : random.pick(EDGE_16)))
  // ルックアップの一覧はどれも同じルックアップを指し、ルックアップの小表はどれも同じ PairPos（字 1 の次に字 1 が来たら詰める）を指す
  const lookupList = u16(lookups)
  for (let i = 0; i < lookups; i++) lookupList.push(...u16(2 + lookups * 2))
  const pairPosAt = 6 + subtables * 2
  lookupList.push(...u16(random.pick([2, 2, 2, 9, 1]), 0, subtables))
  for (let i = 0; i < subtables; i++) lookupList.push(...u16(pairPosAt <= 0xffff ? pairPosAt : 8))
  lookupList.push(...pairPos(random))
  const gpos = [...u32(0x00010000), ...u16(10, 10, 10 + featureList.length), ...featureList, ...lookupList]
  const tables = new Map([...base, ['GPOS', gpos]])
  tables.delete('kern')
  return tables
}

/** 項目の数・長さ・位置を乱数にした name の表 */
function nameRecords(random: Random, base: Tables): Tables {
  const full = random.chance(0.01)
  const count = full ? 0xffff : random.pick([0, 1, 5, 40])
  const text = [...random.bytes(random.int(0, 80))]
  const name = u16(0, random.chance(0.9) ? count : random.pick(EDGE_16), full ? 6 : 6 + count * 12)
  for (let i = 0; i < count; i++) {
    const length = full ? 0xfffe : random.int(0, text.length)
    name.push(...u16(random.pick([3, 3, 0, 1, 2]), random.pick([1, 10, 0, 3]), random.pick([0x409, 0, 0x411]), random.pick([1, 16, 1, 16, 2, 4]), length, full ? 0 : random.int(0, text.length - length)))
  }
  return new Map([...base, ['name', [...name, ...text]]])
}

// ---- 元にする正しい書体

const ttf = testFontBytes()
const otf = testFontBytes({ outline: 'cff' })
const sfnts = [ttf, otf, testFontBytes({ kerning: -50 }), testFontBytes({ kerning: -50, legacyKern: true }), testFontBytes({ outline: 'cff', kerning: -50 })]
const woff2s = [toWoff2(ttf, compress), toWoff2(ttf, compress, { transform: false }), toWoff2(otf, compress), toWoff2(sfnts[2], compress)]
const woffs: Uint8Array[] = []
const ttfTables = tablesOf(ttf)
const otfTables = tablesOf(otf)

beforeAll(async () => {
  for (const font of sfnts) woffs.push(await toWoff(font))
})

describe('parseOutlineFont のファズ', () => {
  it('壊していない書体は読めて、字の輪郭が引ける', () => {
    for (const font of [...sfnts, ...woffs, ...woff2s]) expect(parseOutlineFont(font)!.glyphPath(1).length).toBeGreaterThan(0)
  })

  it('正しい書体（TrueType・CFF・WOFF・WOFF2）を壊しても、読めないか、引いても例外にならない', () => {
    fuzz({ seed: 110_000, cases: 2500 }, (random) => {
      const seed = random.pick([...sfnts, ...sfnts, ...woffs, ...woff2s])
      if (random.chance(0.25)) return checkOutlineFont(mutate(random, seed), random)
      const font = Uint8Array.from(seed)
      for (let round = random.int(1, 4); round > 0; round--) {
        // WOFF2 は表が圧縮の中なので全体から、ほかは表を選んでその中を壊す。たまに表の一覧も壊す
        if (font[3] === 0x32 || random.chance(0.1)) corrupt(random, font, 0, random.chance(0.5) ? Math.min(font.length, 200) : font.length)
        else corruptTable(random, font)
      }
      checkOutlineFont(font, random)
    })
  })

  it('合成字やサブルーチンが指し合う書体、個数の欄が大きい表、文字の範囲を乱数にした表でも同じ（処理量に上限がある）', () => {
    fuzz({ seed: 120_000, cases: 1500 }, (random) => {
      const kind = random.pick([0, 1, 1, 1, 2, 2, 3, 3, 4, 4])
      const tables = [compositeGlyphs, subroutineGraph, kernCounts, gposCounts, cmapGroups][kind](random, kind === 1 ? otfTables : ttfTables)
      const font = sfntOf(tables, kind === 1 ? 0x4f54544f : 0x00010000)
      if (random.chance(0.2)) corruptTable(random, font)
      checkOutlineFont(font, random)
    })
  })

  it('乱数のバイト列（先頭の印だけ正しいものも）でも同じ', () => {
    fuzz({ seed: 130_000, cases: 800 }, (random) => {
      const bytes = random.bytes(random.int(0, 400))
      if (random.chance(0.8)) bytes.set(random.pick([[0, 1, 0, 0], tagBytes('OTTO'), tagBytes('true'), tagBytes('wOFF'), tagBytes('wOF2')]).slice(0, bytes.length))
      checkOutlineFont(bytes, random)
    })
  })
})

/** UIntBase128（7 ビットずつ、続きがあれば上のビットを立てる） */
function base128(value: number): number[] {
  const bytes = [value & 0x7f]
  for (let rest = Math.floor(value / 128); rest > 0; rest = Math.floor(rest / 128)) bytes.unshift((rest & 0x7f) | 0x80)
  return bytes
}
const u255 = (value: number) => (value < 253 ? [value] : [253, value >> 8, value & 0xff])

/** WOFF2 の変換した glyf（輪郭の数・点の数・旗・座標・合成字・枠・命令の 7 つの流れ）を、字ごとに乱数で作る */
function transformedGlyf(random: Random): { stream: number[]; glyphCount: number; long: boolean } {
  const glyphCount = random.int(1, 6)
  const [contours, points, flags, glyphs, composites, boxes, instructions]: number[][] = [[], [], [], [], [], [], []]
  const bitmap = new Array<number>(4 * Math.floor((glyphCount + 31) / 32)).fill(0)
  const instruction = () => {
    const length = random.pick([0, 0, 1, 3])
    glyphs.push(...u255(random.chance(0.95) ? length : random.pick([200, 253, 600])))
    instructions.push(...random.bytes(length))
  }
  for (let glyph = 0; glyph < glyphCount; glyph++) {
    const kind = random.pick([0, 1, 1, 1, 2, 2])
    // 枠は合成字には要り、空の字には書けない。たまに逆にする
    if (random.chance(kind === 2 ? 0.95 : kind === 1 ? 0.3 : 0.05)) {
      bitmap[glyph >> 3] |= 0x80 >> (glyph & 7)
      boxes.push(...random.bytes(8))
    }
    if (kind === 0) contours.push(0, 0)
    else if (kind === 1) {
      const count = random.int(1, 3)
      contours.push(...u16(random.chance(0.95) ? count : random.pick([0x7fff, 0x8000, 0xfffe])))
      let total = 0
      for (let i = 0; i < count; i++) {
        const length = random.int(0, 5)
        points.push(...u255(random.chance(0.97) ? length : random.pick([252, 255, 0xffff])))
        total += length
      }
      for (let i = 0; i < total; i++) {
        const flag = random.int(0, 255)
        flags.push(flag)
        const kindOfPoint = flag & 0x7f
        glyphs.push(...random.bytes(kindOfPoint < 84 ? 1 : kindOfPoint < 120 ? 2 : kindOfPoint < 124 ? 3 : 4))
      }
      instruction()
    } else {
      contours.push(0xff, 0xff)
      let withInstructions = false
      const parts = random.int(1, 3)
      for (let part = 0; part < parts; part++) {
        const scale = random.pick([0, 0, 0x8, 0x40, 0x80])
        const words = random.chance(0.5)
        const flag = (words ? 0x1 : 0) | (part < parts - 1 ? 0x20 : 0) | scale | (random.chance(0.2) ? 0x100 : 0)
        if (flag & 0x100) withInstructions = true
        composites.push(...u16(flag, random.int(0, glyphCount)), ...random.bytes((words ? 4 : 2) + (scale === 0x8 ? 2 : scale === 0x40 ? 4 : scale === 0x80 ? 8 : 0)))
      }
      if (withInstructions) instruction()
    }
  }
  const streams = [contours, points, flags, glyphs, composites, [...bitmap, ...boxes], instructions]
  const overlap = random.chance(0.2)
  const long = random.chance(0.5)
  const sizes = streams.map((stream) => (random.chance(0.97) ? stream.length : random.pick([0, stream.length + 1, 0xffffffff])))
  const stream = [...u16(0, overlap ? 1 : 0, random.chance(0.95) ? glyphCount : random.pick(EDGE_16), long ? 1 : 0), ...u32(...sizes), ...streams.flat()]
  if (overlap) stream.push(...random.bytes(Math.floor((glyphCount + 7) / 8)))
  return { stream, glyphCount, long }
}

/** 変換した glyf / loca / hmtx を持つ WOFF2 を、表を並べて作る（ほかの表は元の書体のもの） */
function woff2WithGlyf(random: Random): Uint8Array<ArrayBuffer> {
  const { stream, glyphCount, long } = transformedGlyf(random)
  const maxp = [...ttfTables.get('maxp')!]
  maxp[5] = glyphCount
  const metrics = random.chance(0.8) ? random.int(1, glyphCount) : random.pick([0, glyphCount + 1, 0xffff])
  const hhea = [...ttfTables.get('hhea')!]
  hhea.splice(34, 2, ...u16(metrics))
  const hmtxFlags = random.int(0, 3)
  const hmtxLength = 1 + Math.min(metrics, 8) * 2 + (hmtxFlags & 1 ? 0 : Math.min(metrics, 8) * 2) + (hmtxFlags & 2 ? 0 : Math.max(0, glyphCount - metrics) * 2)
  const hmtx = [hmtxFlags, ...random.bytes(Math.max(0, hmtxLength - 1 + random.pick([0, 0, 0, -1, 2])))]
  const plainHmtx = random.chance(0.3)
  // 表の番号: cmap 0・head 1・hhea 2・hmtx 3・maxp 4・glyf 10・loca 11。version は glyf / loca が 0、hmtx が 1 で変換あり
  const entries: { index: number; version: number; data: readonly number[]; original?: number }[] = [
    { index: 0, version: 0, data: ttfTables.get('cmap')! },
    { index: 10, version: 0, data: stream, original: random.pick([0, stream.length, 4096, 0x0fffffff]) },
    { index: 11, version: 0, data: [], original: random.chance(0.9) ? (glyphCount + 1) * (long ? 4 : 2) : random.int(0, 40) },
    { index: 1, version: 0, data: ttfTables.get('head')! },
    { index: 2, version: 0, data: hhea },
    plainHmtx ? { index: 3, version: 0, data: ttfTables.get('hmtx')! } : { index: 3, version: 1, data: hmtx, original: metrics * 4 + Math.max(0, glyphCount - metrics) * 2 },
    { index: 4, version: 0, data: maxp },
  ]
  const directory = entries.flatMap((entry) => [
    entry.index | (entry.version << 6),
    ...base128(entry.original ?? entry.data.length),
    ...(entry.original === undefined ? [] : base128(entry.data.length)),
  ])
  const compressed = compress(Uint8Array.from(entries.flatMap((entry) => entry.data)))
  return Uint8Array.from([...tagBytes('wOF2'), ...u32(0x00010000, 0), ...u16(entries.length, 0), ...u32(0, compressed.length), ...new Array<number>(24).fill(0), ...directory, ...compressed])
}

describe('decodeWoff2 のファズ', () => {
  const check = (bytes: Uint8Array, random: Random) => {
    const sfnt = decodeWoff2(bytes)
    if (sfnt === null) return
    // 戻せたなら sfnt として読める形で、書体として引いても例外にならない
    expect(fontMime(sfnt)).not.toBe('font/woff2')
    checkOutlineFont(sfnt, random)
  }

  it('正しい WOFF2 の見出しや圧縮したデータを壊しても、null か sfnt になる', () => {
    fuzz({ seed: 140_000, cases: 1500 }, (random) => {
      const seed = random.pick(woff2s)
      if (random.chance(0.4)) return check(mutate(random, seed), random)
      // 見出し（48 バイト）と表の一覧のあたりを狙う
      const font = Uint8Array.from(seed)
      for (let round = random.int(1, 3); round > 0; round--) corrupt(random, font, 0, Math.min(font.length, 110))
      check(font, random)
    })
  })

  it('圧縮する前の表（変換した glyf / hmtx を含む）を壊しても同じ', () => {
    fuzz({ seed: 150_000, cases: 1200 }, (random) => {
      const corrupted = (data: Uint8Array) => {
        const stream = Uint8Array.from(data)
        // 変換した glyf は先頭にあるとは限らないので、全体と、輪郭の数・点の数が並ぶ前のほうの両方を狙う
        for (let round = random.int(1, 4); round > 0; round--) corrupt(random, stream, 0, random.chance(0.5) ? stream.length : Math.min(stream.length, 400))
        return compress(stream)
      }
      const font = random.pick([ttf, ttf, otf, sfnts[2]])
      check(toWoff2(font, corrupted, { transform: random.chance(0.8) }), random)
    })
  })

  it('変換した glyf を字ごとに乱数で作っても同じ（単純な字・合成字・枠・命令）', () => {
    let decoded = 0
    fuzz({ seed: 170_000, cases: 1500 }, (random) => {
      const font = woff2WithGlyf(random)
      if (decodeWoff2(font) !== null) decoded++
      check(font, random)
    })
    // 作った入力がどれも弾かれていたら、組み立て直す所まで試せていない
    expect(decoded).toBeGreaterThan(150)
  })
})

describe('readFontFileInfo のファズ', () => {
  const check = async (bytes: Uint8Array) => {
    const info = await readFontFileInfo(bytes)
    if (info === null) return
    expect(FONT_MIME_TYPES).toContain(info.mime)
    expect(info.weight >= 100 && info.weight <= 900 && info.weight % 100 === 0).toBe(true)
    expect(['normal', 'italic']).toContain(info.style)
    if (info.family !== null) {
      expect(info.family.length > 0 && info.family.length <= MAX_EMBEDDED_FAMILY_LENGTH).toBe(true)
      expect(EMBEDDED_FAMILY_FORBIDDEN.test(info.family)).toBe(false)
    }
  }

  it('壊していない書体は名前が読める', async () => {
    for (const font of [...sfnts, ...woffs, ...woff2s]) expect((await readFontFileInfo(font))!.family).toBe('Kdr Test')
  })

  it('正しい書体を壊しても、name の項目の数や位置を乱数にしても、null か決めた形の値になる', async () => {
    await fuzzAsync({ seed: 160_000, cases: 1500 }, async (random) => {
      if (random.chance(0.3)) return check(sfntOf(nameRecords(random, random.pick([ttfTables, otfTables])), 0x00010000))
      const seed = random.pick([...sfnts, ...woffs, ...woff2s])
      if (random.chance(0.4)) return check(mutate(random, seed))
      const font = Uint8Array.from(seed)
      for (let round = random.int(1, 4); round > 0; round--) {
        if (font[3] === 0x32 || random.chance(0.2)) corrupt(random, font, 0, Math.min(font.length, 300))
        else corruptTable(random, font)
      }
      await check(font)
    })
  })
})
