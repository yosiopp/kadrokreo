import { brotliDecompress } from './brotli.ts'

// WOFF2（W3C WOFF File Format 2.0）の書体ファイルを、TrueType / OpenType のファイル（sfnt）に戻す。同期で戻す（描画の途中で字の形を読むため）。
// 表は Brotli でまとめて圧縮され、glyf / loca と hmtx は形を変えて入っている（変換）ので、それを元の表に組み立て直す。
// 書体の名前・太さを読む（fontFile.ts）、字の形を読む（openType.ts）、CLI の Skia に登録する（cli/png.ts）のに使う。ブラウザの FontFace は WOFF2 をそのまま読める。
// 書体ファイルは信頼できない入力なので、大きさは表の大きさの合計（上限 128MB）に限り、範囲の外を読んだら（DataView が投げる）読めないものとして null を返す。
// TrueType Collection（ttcf）は扱わない。

/** 戻した表の大きさの合計の上限（openType.ts と同じ） */
const MAX_TOTAL_SIZE = 128 * 1024 * 1024

/** 表の名前の番号（表の一覧で 0〜62 の番号で書かれる） */
const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
]

type Entry = { tag: string; version: number; origLength: number; transformed: boolean; length: number; offset: number }

class Reader {
  pos: number
  private readonly data: DataView
  constructor(bytes: Uint8Array, offset = 0, length = bytes.length - offset) {
    if (offset < 0 || length < 0 || offset + length > bytes.length) throw new RangeError('woff2: 範囲の外です')
    this.data = new DataView(bytes.buffer, bytes.byteOffset + offset, length)
    this.pos = 0
  }
  get length(): number {
    return this.data.byteLength
  }
  u8(): number {
    return this.data.getUint8(this.pos++)
  }
  u16(): number {
    const value = this.data.getUint16(this.pos)
    this.pos += 2
    return value
  }
  i16(): number {
    const value = this.data.getInt16(this.pos)
    this.pos += 2
    return value
  }
  u32(): number {
    const value = this.data.getUint32(this.pos)
    this.pos += 4
    return value
  }
  tag(): string {
    return String.fromCharCode(this.u8(), this.u8(), this.u8(), this.u8())
  }
  /** UIntBase128（1〜5 バイト、7 ビットずつ） */
  base128(): number {
    let value = 0
    for (let i = 0; i < 5; i++) {
      const byte = this.u8()
      if (i === 0 && byte === 0x80) throw new Error('woff2: 数の表し方が不正です')
      if (value > 0x1ffffff) throw new Error('woff2: 数が大きすぎます')
      value = value * 128 + (byte & 0x7f)
      if ((byte & 0x80) === 0) return value
    }
    throw new Error('woff2: 数の表し方が不正です')
  }
  /** 255UInt16 */
  u255(): number {
    const code = this.u8()
    if (code === 253) return this.u16()
    if (code === 255) return 253 + this.u8()
    if (code === 254) return 506 + this.u8()
    return code
  }
  bytes(length: number): Uint8Array {
    if (length < 0 || this.pos + length > this.data.byteLength) throw new RangeError('woff2: 範囲の外です')
    const out = new Uint8Array(this.data.buffer, this.data.byteOffset + this.pos, length)
    this.pos += length
    return out
  }
}

/** 伸びるバイト列（組み立てた glyf） */
class Writer {
  private buffer: Uint8Array
  length = 0
  constructor(size: number) {
    this.buffer = new Uint8Array(Math.max(64, size))
  }
  private reserve(count: number): void {
    if (this.length + count <= this.buffer.length) return
    if (this.length + count > MAX_TOTAL_SIZE) throw new Error('woff2: 大きすぎます')
    const next = new Uint8Array(Math.min(MAX_TOTAL_SIZE, Math.max(this.buffer.length * 2, this.length + count)))
    next.set(this.buffer.subarray(0, this.length))
    this.buffer = next
  }
  u8(value: number): void {
    this.reserve(1)
    this.buffer[this.length++] = value
  }
  u16(value: number): void {
    this.reserve(2)
    this.buffer[this.length++] = (value >> 8) & 0xff
    this.buffer[this.length++] = value & 0xff
  }
  bytes(bytes: Uint8Array): void {
    this.reserve(bytes.length)
    this.buffer.set(bytes, this.length)
    this.length += bytes.length
  }
  pad(alignment: number): void {
    while (this.length % alignment !== 0) this.u8(0)
  }
  result(): Uint8Array {
    return this.buffer.slice(0, this.length)
  }
}

/** WOFF2 の書体ファイルを sfnt（TrueType / OpenType）に戻す。読めない・壊れている・TrueType Collection なら null */
export function decodeWoff2(bytes: Uint8Array): Uint8Array | null {
  try {
    return decode(bytes)
  } catch {
    return null
  }
}

function decode(bytes: Uint8Array): Uint8Array | null {
  const header = new Reader(bytes)
  if (header.tag() !== 'wOF2') return null
  const flavor = header.u32()
  if (flavor === 0x74746366) return null // ttcf
  header.u32() // length
  const count = header.u16()
  header.u16() // reserved
  header.u32() // totalSfntSize
  const compressedSize = header.u32()
  header.pos = 48
  if (count === 0) return null

  const entries: Entry[] = []
  let total = 0
  for (let i = 0; i < count; i++) {
    const flags = header.u8()
    const index = flags & 0x3f
    const tag = index === 63 ? header.tag() : KNOWN_TAGS[index]
    const version = flags >> 6
    const origLength = header.base128()
    // glyf / loca は 0 が変換あり（3 が変換なし）、ほかの表は 0 が変換なし
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0
    if (transformed && tag !== 'glyf' && tag !== 'loca' && !(tag === 'hmtx' && version === 1)) return null
    if (!transformed && (tag === 'glyf' || tag === 'loca') && version !== 3) return null
    const length = transformed ? header.base128() : origLength
    entries.push({ tag, version, origLength, transformed, length, offset: total })
    total += length
    if (total > MAX_TOTAL_SIZE) return null
  }
  if (new Set(entries.map((entry) => entry.tag)).size !== entries.length) return null
  const data = brotliDecompress(new Reader(bytes, header.pos, compressedSize).bytes(compressedSize), total)
  const tableData = (entry: Entry): Uint8Array => data.subarray(entry.offset, entry.offset + entry.length)

  const tables = new Map<string, Uint8Array>()
  for (const entry of entries) if (!entry.transformed) tables.set(entry.tag, tableData(entry))

  const glyf = entries.find((entry) => entry.tag === 'glyf')
  const loca = entries.find((entry) => entry.tag === 'loca')
  if ((glyf?.transformed ?? false) !== (loca?.transformed ?? false)) return null
  let xMins: Int16Array | null = null
  if (glyf && loca && glyf.transformed) {
    if (loca.length !== 0) return null
    const rebuilt = rebuildGlyf(tableData(glyf), glyf.origLength)
    if (rebuilt.loca.length !== loca.origLength) return null
    tables.set('glyf', rebuilt.glyf)
    tables.set('loca', rebuilt.loca)
    xMins = rebuilt.xMins
  }
  const hmtx = entries.find((entry) => entry.tag === 'hmtx')
  if (hmtx && hmtx.transformed) {
    const hhea = tables.get('hhea')
    const maxp = tables.get('maxp')
    if (!hhea || !maxp || !xMins) return null
    const rebuilt = rebuildHmtx(tableData(hmtx), new Reader(hhea, 34, 2).u16(), new Reader(maxp, 4, 2).u16(), xMins)
    if (rebuilt.length !== hmtx.origLength) return null
    tables.set('hmtx', rebuilt)
  }
  return sfnt(flavor, tables)
}

// ---- glyf / loca

/** 変換した glyf から glyf と loca を組み立て直す。xMins は字ごとの左端（hmtx の変換を戻すのに使う） */
function rebuildGlyf(transformed: Uint8Array, origLength: number): { glyf: Uint8Array; loca: Uint8Array; xMins: Int16Array } {
  const head = new Reader(transformed)
  head.u16() // reserved
  const options = head.u16()
  const glyphCount = head.u16()
  const indexFormat = head.u16()
  const sizes = Array.from({ length: 7 }, () => head.u32())
  let offset = head.pos
  const streams = sizes.map((size) => {
    const stream = new Reader(transformed, offset, size)
    offset += size
    return stream
  })
  const [contourStream, pointStream, flagStream, glyphStream, compositeStream, bboxStream, instructionStream] = streams
  const bitmapLength = 4 * Math.floor((glyphCount + 31) / 32)
  const bboxBitmap = bboxStream.bytes(bitmapLength)
  const overlapBitmap = (options & 1) !== 0 ? new Reader(transformed, offset).bytes(Math.floor((glyphCount + 7) / 8)) : null
  const hasBit = (bitmap: Uint8Array, glyph: number): boolean => (bitmap[glyph >> 3] & (0x80 >> (glyph & 7))) !== 0

  const glyf = new Writer(Math.min(origLength, MAX_TOTAL_SIZE))
  const offsets = new Uint32Array(glyphCount + 1)
  const xMins = new Int16Array(glyphCount)
  for (let glyph = 0; glyph < glyphCount; glyph++) {
    offsets[glyph] = glyf.length
    const contours = contourStream.i16()
    const explicitBox = hasBit(bboxBitmap, glyph)
    if (contours === 0) {
      if (explicitBox) throw new Error('woff2: 空の字に枠があります')
      continue
    }
    if (contours === -1) {
      // 合成字: 部品の並びをそのまま写す
      if (!explicitBox) throw new Error('woff2: 合成字に枠がありません')
      const box = bboxStream.bytes(8)
      const start = compositeStream.pos
      let instructions = false
      for (let more = true; more; ) {
        const flags = compositeStream.u16()
        compositeStream.u16() // 部品の字
        let skip = flags & 0x0001 ? 4 : 2
        if (flags & 0x0008) skip += 2
        else if (flags & 0x0040) skip += 4
        else if (flags & 0x0080) skip += 8
        compositeStream.bytes(skip)
        if (flags & 0x0100) instructions = true
        more = (flags & 0x0020) !== 0
      }
      glyf.u16(0xffff)
      glyf.bytes(box)
      xMins[glyph] = new Reader(box, 0, 2).i16()
      glyf.bytes(compositeStreamBytes(compositeStream, start))
      if (instructions) {
        const length = glyphStream.u255()
        glyf.u16(length)
        glyf.bytes(instructionStream.bytes(length))
      }
    } else if (contours > 0) {
      const ends: number[] = []
      let points = 0
      for (let i = 0; i < contours; i++) {
        points += pointStream.u255()
        if (points > 0xffff) throw new Error('woff2: 点が多すぎます')
        ends.push(points - 1)
      }
      const xs = new Int32Array(points)
      const ys = new Int32Array(points)
      const onCurve = new Uint8Array(points)
      let x = 0
      let y = 0
      for (let i = 0; i < points; i++) {
        const flag = flagStream.u8()
        onCurve[i] = flag >> 7 ? 0 : 1
        const [dx, dy] = triplet(flag & 0x7f, glyphStream)
        x += dx
        y += dy
        xs[i] = x
        ys[i] = y
      }
      const instructionLength = glyphStream.u255()
      const instructions = instructionStream.bytes(instructionLength)
      let xMin: number, yMin: number, xMax: number, yMax: number
      if (explicitBox) {
        xMin = bboxStream.i16()
        yMin = bboxStream.i16()
        xMax = bboxStream.i16()
        yMax = bboxStream.i16()
      } else {
        xMin = yMin = Infinity
        xMax = yMax = -Infinity
        for (let i = 0; i < points; i++) {
          xMin = Math.min(xMin, xs[i])
          xMax = Math.max(xMax, xs[i])
          yMin = Math.min(yMin, ys[i])
          yMax = Math.max(yMax, ys[i])
        }
        if (points === 0) xMin = yMin = xMax = yMax = 0
      }
      xMins[glyph] = xMin
      glyf.u16(contours)
      for (const value of [xMin, yMin, xMax, yMax]) glyf.u16(value & 0xffff)
      for (const end of ends) glyf.u16(end)
      glyf.u16(instructionLength)
      glyf.bytes(instructions)
      writeSimpleGlyphPoints(glyf, xs, ys, onCurve, overlapBitmap !== null && hasBit(overlapBitmap, glyph))
    } else {
      throw new Error('woff2: 輪郭の数が不正です')
    }
    // loca の短い形（2 で割る）でも表せるよう 4 バイトに揃える
    glyf.pad(4)
  }
  offsets[glyphCount] = glyf.length

  const long = indexFormat !== 0
  const loca = new Uint8Array((glyphCount + 1) * (long ? 4 : 2))
  const locaView = new DataView(loca.buffer)
  for (let i = 0; i <= glyphCount; i++) {
    if (long) locaView.setUint32(i * 4, offsets[i])
    else {
      if (offsets[i] / 2 > 0xffff) throw new Error('woff2: loca の短い形に収まりません')
      locaView.setUint16(i * 2, offsets[i] / 2)
    }
  }
  return { glyf: glyf.result(), loca, xMins }
}

function compositeStreamBytes(stream: Reader, start: number): Uint8Array {
  const end = stream.pos
  stream.pos = start
  return stream.bytes(end - start)
}

function withSign(flag: number, value: number): number {
  return flag & 1 ? value : -value
}

/** 点の座標の差（triplet の符号）。flag は点の種類のビットを除いた 0〜127 */
function triplet(flag: number, stream: Reader): [number, number] {
  if (flag < 10) return [0, withSign(flag, ((flag & 14) << 7) + stream.u8())]
  if (flag < 20) return [withSign(flag, (((flag - 10) & 14) << 7) + stream.u8()), 0]
  if (flag < 84) {
    const b0 = flag - 20
    const b1 = stream.u8()
    return [withSign(flag, 1 + (b0 & 0x30) + (b1 >> 4)), withSign(flag >> 1, 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f))]
  }
  if (flag < 120) {
    const b0 = flag - 84
    const b1 = stream.u8()
    const b2 = stream.u8()
    return [withSign(flag, 1 + (Math.floor(b0 / 12) << 8) + b1), withSign(flag >> 1, 1 + (((b0 % 12) >> 2) << 8) + b2)]
  }
  if (flag < 124) {
    const b1 = stream.u8()
    const b2 = stream.u8()
    const b3 = stream.u8()
    return [withSign(flag, (b1 << 4) + (b2 >> 4)), withSign(flag >> 1, ((b2 & 0x0f) << 8) + b3)]
  }
  const b1 = stream.u8()
  const b2 = stream.u8()
  const b3 = stream.u8()
  const b4 = stream.u8()
  return [withSign(flag, (b1 << 8) + b2), withSign(flag >> 1, (b3 << 8) + b4)]
}

/** 単純な字の点（旗・x・y）を TrueType の形で書く。overlap なら最初の点に OVERLAP_SIMPLE を立てる */
function writeSimpleGlyphPoints(out: Writer, xs: Int32Array, ys: Int32Array, onCurve: Uint8Array, overlap: boolean): void {
  const count = xs.length
  const flags = new Uint8Array(count)
  let previousX = 0
  let previousY = 0
  for (let i = 0; i < count; i++) {
    const dx = xs[i] - previousX
    const dy = ys[i] - previousY
    previousX = xs[i]
    previousY = ys[i]
    let flag = onCurve[i]
    if (i === 0 && overlap) flag |= 0x40
    if (dx === 0) flag |= 0x10
    else if (dx > -256 && dx < 256) flag |= dx > 0 ? 0x12 : 0x02
    if (dy === 0) flag |= 0x20
    else if (dy > -256 && dy < 256) flag |= dy > 0 ? 0x24 : 0x04
    flags[i] = flag
  }
  // 旗は同じ値が続けば繰り返し（0x08）でまとめる
  for (let i = 0; i < count; ) {
    let run = 1
    while (i + run < count && flags[i + run] === flags[i] && run < 256) run++
    if (run > 1) {
      out.u8(flags[i] | 0x08)
      out.u8(run - 1)
    } else out.u8(flags[i])
    i += run
  }
  for (const [coords, short, same] of [[xs, 0x02, 0x10], [ys, 0x04, 0x20]] as const) {
    let previous = 0
    for (let i = 0; i < count; i++) {
      const delta = coords[i] - previous
      previous = coords[i]
      if (flags[i] & short) out.u8(Math.abs(delta))
      else if (!(flags[i] & same)) out.u16(delta & 0xffff)
    }
  }
}

// ---- hmtx

/** 変換した hmtx を戻す。省いた左の余白（lsb）は字の左端（xMin）にする */
function rebuildHmtx(transformed: Uint8Array, metricCount: number, glyphCount: number, xMins: Int16Array): Uint8Array {
  if (metricCount === 0 || metricCount > glyphCount || xMins.length !== glyphCount) throw new Error('woff2: hmtx が不正です')
  const stream = new Reader(transformed)
  const flags = stream.u8()
  const advances = Array.from({ length: metricCount }, () => stream.u16())
  const proportional = flags & 1 ? null : Array.from({ length: metricCount }, () => stream.i16())
  const monospaced = flags & 2 ? null : Array.from({ length: glyphCount - metricCount }, () => stream.i16())
  const out = new Uint8Array(metricCount * 4 + (glyphCount - metricCount) * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < metricCount; i++) {
    view.setUint16(i * 4, advances[i])
    view.setInt16(i * 4 + 2, proportional ? proportional[i] : xMins[i])
  }
  for (let i = metricCount; i < glyphCount; i++) {
    view.setInt16(metricCount * 4 + (i - metricCount) * 2, monospaced ? monospaced[i - metricCount] : xMins[i])
  }
  return out
}

// ---- sfnt を組み立てる

function checksum(bytes: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < bytes.length; i += 4) {
    const word = ((bytes[i] << 24) | ((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0)) >>> 0
    sum = (sum + word) >>> 0
  }
  return sum
}

function sfnt(flavor: number, tables: Map<string, Uint8Array>): Uint8Array {
  const tags = [...tables.keys()].sort()
  const count = tags.length
  let size = 12 + count * 16
  for (const tag of tags) size += Math.ceil(tables.get(tag)!.length / 4) * 4
  if (size > MAX_TOTAL_SIZE) throw new Error('woff2: 大きすぎます')
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  let power = 1
  let log = 0
  while (power * 2 <= count) {
    power *= 2
    log++
  }
  view.setUint32(0, flavor)
  view.setUint16(4, count)
  view.setUint16(6, power * 16)
  view.setUint16(8, log)
  view.setUint16(10, count * 16 - power * 16)
  let offset = 12 + count * 16
  let headOffset = -1
  tags.forEach((tag, i) => {
    const table = tables.get(tag)!
    out.set(table, offset)
    if (tag === 'head' && table.length >= 12) {
      headOffset = offset
      view.setUint32(offset + 8, 0) // checkSumAdjustment は全体から計算し直す
    }
    const record = 12 + i * 16
    for (let k = 0; k < 4; k++) out[record + k] = tag.charCodeAt(k)
    view.setUint32(record + 4, checksum(out.subarray(offset, offset + table.length)))
    view.setUint32(record + 8, offset)
    view.setUint32(record + 12, table.length)
    offset += Math.ceil(table.length / 4) * 4
  })
  if (headOffset >= 0) view.setUint32(headOffset + 8, (0xb1b0afba - checksum(out)) >>> 0)
  return out
}
