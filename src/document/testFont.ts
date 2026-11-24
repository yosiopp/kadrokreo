// テスト用: 小さな TrueType の書体を組み立てる。ASCII の印字できる字（! 〜 ~）はどれも同じ黒い四角、空白は何も描かない字。
// 書体名・太さ・斜体を選べる。ブラウザ（OTS の検査）と CLI の Canvas（Skia）で読めることを e2e と CLI のテストで確かめている。
// e2e のスクリプトも require してテスト用の書体ファイルを作る。

export type TestFontOptions = {
  family?: string
  /** OS/2 の usWeightClass */
  weight?: number
  italic?: boolean
  /** 字の輪郭の持ち方。cff なら OpenType（CFF の表、四角はサブルーチンで描く） */
  outline?: 'glyf' | 'cff'
  /** 四角の字が続くときの字詰め（書体の単位）。GPOS の kern の機能（PairPos format 1）で持つ。legacyKern なら古い kern の表で持つ */
  kerning?: number
  legacyKern?: boolean
}

const UNITS_PER_EM = 1000
/** 四角の字の送り幅と、四角の範囲 */
const BOX = { advance: 600, xMin: 50, yMin: 0, xMax: 550, yMax: 700 }
const SPACE_ADVANCE = 300

class Writer {
  readonly bytes: number[] = []
  u8(...values: number[]) {
    for (const value of values) this.bytes.push(value & 0xff)
    return this
  }
  u16(...values: number[]) {
    for (const value of values) this.bytes.push((value >> 8) & 0xff, value & 0xff)
    return this
  }
  i16(...values: number[]) {
    return this.u16(...values.map((value) => value & 0xffff))
  }
  u32(...values: number[]) {
    for (const value of values) this.u16((value >>> 16) & 0xffff, value & 0xffff)
    return this
  }
  tag(text: string) {
    for (const char of text) this.u8(char.charCodeAt(0))
    return this
  }
}

function utf16be(text: string): number[] {
  const out: number[] = []
  for (let i = 0; i < text.length; i++) out.push(text.charCodeAt(i) >> 8, text.charCodeAt(i) & 0xff)
  return out
}

export function testFontBytes({ family = 'Kdr Test', weight = 400, italic = false, outline = 'glyf', kerning, legacyKern = false }: TestFontOptions = {}): Uint8Array<ArrayBuffer> {
  const subfamily = `${weight === 700 ? 'Bold' : weight === 400 ? 'Regular' : `W${weight}`}${italic ? ' Italic' : ''}`
  const postScript = `${family}-${subfamily}`.replace(/[^A-Za-z0-9-]/g, '')
  // 字: 0 = .notdef（空）、1 = 四角、2 = 空白
  const glyphCount = 3

  const glyf = new Writer()
  glyf.i16(1, BOX.xMin, BOX.yMin, BOX.xMax, BOX.yMax) // 輪郭 1 つ
  glyf.u16(3) // 輪郭の最後の点
  glyf.u16(0) // 命令なし
  glyf.u8(1, 1, 1, 1) // 4 点とも曲線上、座標は 16 ビット
  glyf.i16(BOX.xMin, 0, BOX.xMax - BOX.xMin, 0)
  glyf.i16(BOX.yMin, BOX.yMax - BOX.yMin, 0, -(BOX.yMax - BOX.yMin))
  const boxLength = glyf.bytes.length
  const loca = new Writer().u16(0, 0, boxLength / 2, boxLength / 2)

  const head = new Writer()
    .u32(0x00010000, 0x00010000, 0, 0x5f0f3cf5)
    .u16(0x000b, UNITS_PER_EM)
    .u32(0, 0, 0, 0)
    .i16(BOX.xMin, BOX.yMin, BOX.xMax, BOX.yMax)
    .u16((weight >= 700 ? 1 : 0) | (italic ? 2 : 0), 8)
    .i16(2, 0, 0)

  const hhea = new Writer()
    .u32(0x00010000)
    .i16(800, -200, 0)
    .u16(BOX.advance)
    .i16(0, 0, BOX.xMax, 1, 0, 0, 0, 0, 0, 0, 0)
    .u16(glyphCount)

  const maxp = new Writer().u32(0x00010000).u16(glyphCount, 4, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0)

  const os2 = new Writer()
    .u16(4)
    .i16(BOX.advance)
    .u16(weight, 5, 0)
    .i16(650, 600, 0, 75, 650, 600, 0, 350, 50, 300, 0)
    .u8(2, 11, 6, 3, 2, 2, 2, 2, 2, 4)
    .u32(1, 0, 0, 0)
    .tag('KDRT')
    .u16((italic ? 0x01 : 0) | (weight >= 700 ? 0x20 : 0) | (!italic && weight < 700 ? 0x40 : 0), 0x20, 0x7e)
    .i16(800, -200, 0)
    .u16(800, 200)
    .u32(1, 0)
    .i16(500, 700)
    .u16(0, 0x20, 1)

  const hmtx = new Writer().u16(BOX.advance).i16(0).u16(BOX.advance).i16(BOX.xMin).u16(SPACE_ADVANCE).i16(0)

  // cmap: Windows Unicode BMP（format 4）。空白 → 2、! 〜 ~ → 1（glyphIdArray で引く）
  const segments = [
    { start: 0x20, end: 0x20, delta: 2 - 0x20, rangeOffset: 0 },
    { start: 0x21, end: 0x7e, delta: 0, rangeOffset: 4 },
    { start: 0xffff, end: 0xffff, delta: 1, rangeOffset: 0 },
  ]
  const glyphIds = Array.from({ length: 0x7e - 0x21 + 1 }, () => 1)
  const subtable = new Writer()
  const subtableLength = 16 + segments.length * 8 + glyphIds.length * 2
  subtable.u16(4, subtableLength, 0, segments.length * 2, 4, 1, 2)
  subtable.u16(...segments.map((s) => s.end)).u16(0)
  subtable.u16(...segments.map((s) => s.start))
  subtable.i16(...segments.map((s) => s.delta))
  subtable.u16(...segments.map((s) => s.rangeOffset))
  subtable.u16(...glyphIds)
  const cmap = new Writer().u16(0, 1).u16(3, 1).u32(12)
  cmap.bytes.push(...subtable.bytes)

  const names: [number, string][] = [
    [1, family],
    [2, subfamily],
    [3, `${postScript};kdr-test`],
    [4, `${family} ${subfamily}`],
    [6, postScript],
  ]
  const name = new Writer().u16(0, names.length, 6 + names.length * 12)
  const strings: number[] = []
  for (const [id, text] of names) {
    const encoded = utf16be(text)
    name.u16(3, 1, 0x409, id, encoded.length, strings.length)
    strings.push(...encoded)
  }
  name.bytes.push(...strings)

  const post = new Writer().u32(0x00030000, 0).i16(-100, 50).u32(0, 0, 0, 0, 0)

  const tables: Record<string, number[]> = {
    'OS/2': os2.bytes,
    cmap: cmap.bytes,
    head: head.bytes,
    hhea: hhea.bytes,
    hmtx: hmtx.bytes,
    maxp: maxp.bytes,
    name: name.bytes,
    post: post.bytes,
  }
  if (outline === 'cff') {
    tables['CFF '] = cffTable(postScript)
    // CFF の書体の maxp は version 0.5（字の数だけ）
    tables.maxp = new Writer().u32(0x00005000).u16(glyphCount).bytes
  } else {
    tables.glyf = glyf.bytes
    tables.loca = loca.bytes
  }
  if (kerning !== undefined && legacyKern) {
    tables.kern = new Writer().u16(0, 1).u16(0, 6 + 8 + 6, 0x0001).u16(1, 6, 0, 0).u16(1, 1).i16(kerning).bytes
  } else if (kerning !== undefined) {
    tables.GPOS = gposKern(kerning)
  }
  return sfnt(tables, outline === 'cff' ? 0x4f54544f : 0x00010000)
}

/** CFF の数（Type 2 の字形の命令・DICT で同じ書き方になる -107〜107 と、5 バイトの整数） */
function cffInt(value: number, dict = true): number[] {
  if (value >= -107 && value <= 107) return [value + 139]
  if (dict) return [29, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
  return [28, (value >> 8) & 0xff, value & 0xff]
}

function cffIndexBytes(items: number[][]): number[] {
  if (items.length === 0) return [0, 0]
  const out = new Writer().u16(items.length).u8(4)
  let offset = 1
  out.u32(offset)
  for (const item of items) {
    offset += item.length
    out.u32(offset)
  }
  for (const item of items) out.bytes.push(...item)
  return out.bytes
}

/** 字 0 = 空、1 = 四角（ローカルのサブルーチン 0 を呼んで描く）、2 = 空白 */
function cffTable(postScript: string): number[] {
  const box = [
    ...cffInt(BOX.xMin, false), ...cffInt(BOX.yMin, false), 21, // rmoveto
    ...cffInt(BOX.xMax - BOX.xMin, false), 6, // hlineto
    ...cffInt(BOX.yMax - BOX.yMin, false), 7, // vlineto
    ...cffInt(-(BOX.xMax - BOX.xMin), false), 6, // hlineto（閉じる辺は省く）
    11, // return
  ]
  const charStrings = cffIndexBytes([[14], [...cffInt(0 - 107, false), 10, 14], [14]])
  const subrs = cffIndexBytes([box])
  const privateDict = [...cffInt(0), 20, ...cffInt(0), 21]
  // Private DICT の Subrs は Private DICT の先頭から数える（Private DICT は Subrs の直前に置く）
  const privateWithSubrs = (length: number) => [...privateDict, ...cffInt(length), 19]
  const privateLength = privateWithSubrs(0).length
  const privateBytes = privateWithSubrs(privateLength)
  const header = [1, 0, 4, 4]
  const nameIndex = cffIndexBytes([[...postScript].map((c) => c.charCodeAt(0))])
  // 位置は大きさが変わらないよう、いつも 5 バイトの整数で書く
  const int32 = (value: number) => [29, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
  const topDict = (charStringsAt: number, privateAt: number) => [...int32(charStringsAt), 17, ...cffInt(privateBytes.length), ...int32(privateAt), 18]
  const topLength = cffIndexBytes([topDict(0, 0)]).length
  const strings = cffIndexBytes([])
  const globalSubrs = cffIndexBytes([])
  const charStringsAt = header.length + nameIndex.length + topLength + strings.length + globalSubrs.length
  const privateAt = charStringsAt + charStrings.length
  return [...header, ...nameIndex, ...cffIndexBytes([topDict(charStringsAt, privateAt)]), ...strings, ...globalSubrs, ...charStrings, ...privateBytes, ...subrs]
}

/** 四角の字（1）が続くときの字詰めを持つ GPOS（DFLT の kern の機能 → PairPos format 1） */
function gposKern(value: number): number[] {
  const out = new Writer().u32(0x00010000).u16(10, 30, 44)
  // ScriptList（10）: DFLT → Script → 既定の LangSys（機能 0）
  out.u16(1).tag('DFLT').u16(8).u16(4, 0).u16(0, 0xffff, 1, 0)
  // FeatureList（30）: kern → Feature（lookup 0）
  out.u16(1).tag('kern').u16(8).u16(0, 1, 0)
  // LookupList（44）: Lookup（type 2）→ PairPos format 1
  out.u16(1, 4).u16(2, 0, 1, 8)
  out.u16(1, 12, 0x0004, 0, 1, 18) // format, coverage, valueFormat1 = XAdvance, valueFormat2, pairSetCount, pairSet
  out.u16(1, 1, 1) // Coverage format 1: 字 1
  out.u16(1, 1).i16(value) // PairSet: 1 組（右が字 1）
  return out.bytes
}

function checksum(bytes: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < bytes.length; i += 4) {
    sum = (sum + (((bytes[i] ?? 0) << 24) | ((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0))) >>> 0
  }
  return sum
}

/** 表を並べて TrueType のファイルにする（表は名前の順、4 バイト境界に揃える。head の checkSumAdjustment も入れる） */
function sfnt(tables: Record<string, number[]>, version = 0x00010000): Uint8Array<ArrayBuffer> {
  const tags = Object.keys(tables).sort()
  const count = tags.length
  const power = 2 ** Math.floor(Math.log2(count))
  const out = new Writer().u32(version).u16(count, power * 16, Math.log2(power), count * 16 - power * 16)
  let offset = 12 + count * 16
  const body: number[] = []
  let headOffset = 0
  for (const tag of tags) {
    const data = tables[tag]
    if (tag === 'head') headOffset = offset
    out.tag(tag.padEnd(4, ' ')).u32(checksum(data), offset, data.length)
    body.push(...data)
    while (body.length % 4 !== 0) body.push(0)
    offset = 12 + count * 16 + body.length
  }
  const all = [...out.bytes, ...body]
  const adjustment = (0xb1b0afba - checksum(all)) >>> 0
  all[headOffset + 8] = adjustment >>> 24
  all[headOffset + 9] = (adjustment >>> 16) & 0xff
  all[headOffset + 10] = (adjustment >>> 8) & 0xff
  all[headOffset + 11] = adjustment & 0xff
  return new Uint8Array(all)
}

/** TrueType のファイルを WOFF（1.0）にする。表は zlib で圧縮し、小さくならなければそのまま入れる */
export async function toWoff(font: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const data = new DataView(font.buffer, font.byteOffset, font.byteLength)
  const count = data.getUint16(4)
  const tables: { tag: number; checksum: number; raw: Uint8Array; stored: Uint8Array }[] = []
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16
    const offset = data.getUint32(record + 8)
    const raw = font.slice(offset, offset + data.getUint32(record + 12))
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer())
    tables.push({ tag: data.getUint32(record), checksum: data.getUint32(record + 4), raw, stored: compressed.length < raw.length ? compressed : raw })
  }
  const header = new Writer()
  const directory = new Writer()
  const body: number[] = []
  let offset = 44 + count * 20
  for (const table of tables) {
    directory.u32(table.tag, offset, table.stored.length, table.raw.length, table.checksum)
    body.push(...table.stored)
    while (body.length % 4 !== 0) body.push(0)
    offset = 44 + count * 20 + body.length
  }
  header.tag('wOFF').u32(data.getUint32(0), 44 + count * 20 + body.length).u16(count, 0).u32(font.length).u16(1, 0).u32(0, 0, 0, 0, 0)
  return new Uint8Array([...header.bytes, ...directory.bytes, ...body])
}
