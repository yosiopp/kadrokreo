// テスト用: 小さな TrueType の書体を組み立てる。ASCII の印字できる字（! 〜 ~）はどれも同じ黒い四角、空白は何も描かない字。
// 書体名・太さ・斜体を選べる。ブラウザ（OTS の検査）と CLI の Canvas（Skia）で読めることを e2e と CLI のテストで確かめている。
// e2e のスクリプトも require してテスト用の書体ファイルを作る。

export type TestFontOptions = {
  family?: string
  /** OS/2 の usWeightClass */
  weight?: number
  italic?: boolean
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

export function testFontBytes({ family = 'Kdr Test', weight = 400, italic = false }: TestFontOptions = {}): Uint8Array<ArrayBuffer> {
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

  return sfnt({
    'OS/2': os2.bytes,
    cmap: cmap.bytes,
    glyf: glyf.bytes,
    head: head.bytes,
    hhea: hhea.bytes,
    hmtx: hmtx.bytes,
    loca: loca.bytes,
    maxp: maxp.bytes,
    name: name.bytes,
    post: post.bytes,
  })
}

function checksum(bytes: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < bytes.length; i += 4) {
    sum = (sum + (((bytes[i] ?? 0) << 24) | ((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0))) >>> 0
  }
  return sum
}

/** 表を並べて TrueType のファイルにする（表は名前の順、4 バイト境界に揃える。head の checkSumAdjustment も入れる） */
function sfnt(tables: Record<string, number[]>): Uint8Array<ArrayBuffer> {
  const tags = Object.keys(tables).sort()
  const count = tags.length
  const power = 2 ** Math.floor(Math.log2(count))
  const out = new Writer().u32(0x00010000).u16(count, power * 16, Math.log2(power), count * 16 - power * 16)
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
