import { inflateZlib } from './inflate.ts'

// 書体ファイル（TrueType / OpenType の CFF / WOFF / WOFF2）から、字の輪郭と送り幅・字詰めを読む。テキストのアウトライン化と、
// テキストを入れたブーリアン演算（document/textOutline.ts）が使う。描画の途中で使うので同期で読む（WOFF は inflate.ts で展開する。
// WOFF2 は woff2.ts で戻すが、Brotli の辞書が大きいのでブラウザでは別のチャンクにして、読み込んだら setWoff2Decoder で知らせてもらう）。
// 読むのは、文字から字を引く cmap（format 4 / 12）、送り幅の hmtx、上下の高さの hhea / OS/2、輪郭の glyf（合成字を含む）と CFF（Type 2 の字形の命令）、
// 字詰めの GPOS（kern の機能の PairPos）か古い kern の表。合字や文脈で字を替える置き換え（GSUB）、可変の書体（CFF2・gvar）、縦書きは読まない。
// 書体ファイルは信頼できない入力なので、範囲の外を読んだら（DataView が投げる）その字・その書体を読めないものとして扱う。

/** 字の輪郭の命令（書体の単位、y は上が正） */
export type GlyphCommand =
  | { type: 'M' | 'L'; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Z' }

export type OutlineFont = {
  unitsPerEm: number
  /** 上下の高さ（書体の単位。descender は基線より下を正で持つ） */
  ascender: number
  descender: number
  /** 文字（コードポイント）の字の番号。書体に無ければ 0（.notdef） */
  glyphIndex(codePoint: number): number
  /** 字の送り幅（書体の単位） */
  advance(glyph: number): number
  /** 字の並びの字詰め（送り幅に足す量、書体の単位） */
  kerning(left: number, right: number): number
  /** 字の輪郭。読めない字は空 */
  glyphPath(glyph: number): readonly GlyphCommand[]
}

/** 展開した表の大きさの合計の上限（細工された WOFF への備え） */
const MAX_TABLES_SIZE = 128 * 1024 * 1024
/** 合成字・サブルーチンの入れ子の上限 */
const MAX_NESTING = 10

type Tables = Map<string, DataView>

function tagAt(data: DataView, offset: number): string {
  return String.fromCharCode(data.getUint8(offset), data.getUint8(offset + 1), data.getUint8(offset + 2), data.getUint8(offset + 3))
}

function viewOf(bytes: Uint8Array, offset = 0, length = bytes.length - offset): DataView {
  if (offset < 0 || length < 0 || offset + length > bytes.length) throw new RangeError('table out of range')
  return new DataView(bytes.buffer, bytes.byteOffset + offset, length)
}

type Woff2Decoder = (bytes: Uint8Array) => Uint8Array | null
let woff2Decoder: Woff2Decoder | null = null

/** WOFF2 を sfnt に戻す処理（woff2.ts の decodeWoff2）を知らせる。知らせるまで WOFF2 の書体は読めない（null） */
export function setWoff2Decoder(decoder: Woff2Decoder): void {
  woff2Decoder = decoder
}

/** WOFF2 の書体を読めるか（setWoff2Decoder が済んだか） */
export function hasWoff2Decoder(): boolean {
  return woff2Decoder !== null
}

function readTables(bytes: Uint8Array): Tables | null {
  const data = viewOf(bytes)
  const tag = tagAt(data, 0)
  if (tag === 'wOF2') {
    const sfnt = woff2Decoder?.(bytes)
    return sfnt && tagAt(viewOf(sfnt), 0) !== 'wOF2' ? readTables(sfnt) : null
  }
  const tables: Tables = new Map()
  if (tag === 'wOFF') {
    const count = data.getUint16(12)
    let total = 0
    for (let i = 0; i < count; i++) {
      const record = 44 + i * 20
      const name = tagAt(data, record)
      const offset = data.getUint32(record + 4)
      const compressed = data.getUint32(record + 8)
      const length = data.getUint32(record + 12)
      total += length
      if (total > MAX_TABLES_SIZE) return null
      const raw = bytes.subarray(offset, offset + compressed)
      if (raw.length !== compressed) return null
      const table = compressed < length ? inflateZlib(raw, length) : raw
      tables.set(name, viewOf(table))
    }
    return tables
  }
  if (tag !== '\u0000\u0001\u0000\u0000' && tag !== 'true' && tag !== 'OTTO') return null
  const count = data.getUint16(4)
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16
    tables.set(tagAt(data, record), viewOf(bytes, data.getUint32(record + 8), data.getUint32(record + 12)))
  }
  return tables
}

/** 書体ファイルを読む。字の輪郭を読めない書体（表が足りない・壊れている・可変の CFF2 だけ・WOFF2 を戻す処理がまだ無い）は null */
export function parseOutlineFont(bytes: Uint8Array): OutlineFont | null {
  try {
    const tables = readTables(bytes)
    if (!tables) return null
    const head = tables.get('head')
    const hhea = tables.get('hhea')
    const hmtx = tables.get('hmtx')
    const maxp = tables.get('maxp')
    const cmap = tables.get('cmap')
    if (!head || !hhea || !hmtx || !maxp || !cmap) return null
    const unitsPerEm = head.getUint16(18)
    if (unitsPerEm < 16 || unitsPerEm > 16384) return null
    const glyphCount = maxp.getUint16(4)
    const lookup = cmapLookup(cmap)
    if (!lookup) return null
    const outlines = glyfOutlines(tables, head, glyphCount) ?? cffOutlines(tables, glyphCount)
    if (!outlines) return null

    let ascender = hhea.getInt16(4)
    let descender = -hhea.getInt16(6)
    const os2 = tables.get('OS/2')
    // USE_TYPO_METRICS（fsSelection の bit 7）なら typo の値を使う（ブラウザの書体の上下の高さと揃える）
    if (os2 && os2.byteLength >= 72 && (os2.getUint16(62) & 0x80) !== 0) {
      ascender = os2.getInt16(68)
      descender = -os2.getInt16(70)
    }
    if (ascender === 0 && descender === 0) {
      ascender = Math.round(unitsPerEm * 0.9)
      descender = Math.round(unitsPerEm * 0.22)
    }

    const metricCount = Math.min(hhea.getUint16(34), glyphCount)
    const advance = (glyph: number): number => {
      if (metricCount === 0) return 0
      const index = Math.min(glyph, metricCount - 1)
      return index * 4 + 2 <= hmtx.byteLength ? hmtx.getUint16(index * 4) : 0
    }
    const kerning = kerningOf(tables)
    const paths = new Map<number, readonly GlyphCommand[]>()
    return {
      unitsPerEm,
      ascender,
      descender,
      glyphIndex: (codePoint) => {
        try {
          const glyph = lookup(codePoint)
          return glyph < glyphCount ? glyph : 0
        } catch {
          return 0
        }
      },
      advance,
      kerning,
      glyphPath: (glyph) => {
        const cached = paths.get(glyph)
        if (cached) return cached
        let path: readonly GlyphCommand[]
        try {
          path = glyph < glyphCount ? outlines(glyph) : []
        } catch {
          path = []
        }
        paths.set(glyph, path)
        return path
      },
    }
  } catch {
    return null
  }
}

// ---- cmap ----

/** Unicode の対応表を選び、文字から字の番号を引く関数を返す。format 12（BMP の外も）を先に、なければ format 4 */
function cmapLookup(cmap: DataView): ((codePoint: number) => number) | null {
  const count = cmap.getUint16(2)
  let best: { score: number; offset: number } | null = null
  for (let i = 0; i < count; i++) {
    const record = 4 + i * 8
    const platform = cmap.getUint16(record)
    const encoding = cmap.getUint16(record + 2)
    const offset = cmap.getUint32(record + 4)
    if (offset + 4 > cmap.byteLength) continue
    const format = cmap.getUint16(offset)
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10))
    if (!unicode || (format !== 4 && format !== 12)) continue
    const score = format === 12 ? 2 : 1
    if (best === null || score > best.score) best = { score, offset }
  }
  if (best === null) return null
  const base = best.offset
  if (cmap.getUint16(base) === 12) {
    const groups = cmap.getUint32(base + 12)
    if (base + 16 + groups * 12 > cmap.byteLength) return null
    return (codePoint) => {
      let low = 0
      let high = groups - 1
      while (low <= high) {
        const mid = (low + high) >> 1
        const group = base + 16 + mid * 12
        const start = cmap.getUint32(group)
        const end = cmap.getUint32(group + 4)
        if (codePoint < start) high = mid - 1
        else if (codePoint > end) low = mid + 1
        else return cmap.getUint32(group + 8) + codePoint - start
      }
      return 0
    }
  }
  const segments = cmap.getUint16(base + 6) / 2
  const ends = base + 14
  const starts = ends + segments * 2 + 2
  const deltas = starts + segments * 2
  const ranges = deltas + segments * 2
  return (codePoint) => {
    if (codePoint > 0xffff) return 0
    let low = 0
    let high = segments - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      if (cmap.getUint16(ends + mid * 2) < codePoint) low = mid + 1
      else high = mid - 1
    }
    if (low >= segments) return 0
    const start = cmap.getUint16(starts + low * 2)
    if (codePoint < start) return 0
    const delta = cmap.getUint16(deltas + low * 2)
    const rangeOffset = cmap.getUint16(ranges + low * 2)
    if (rangeOffset === 0) return (codePoint + delta) & 0xffff
    const glyph = cmap.getUint16(ranges + low * 2 + rangeOffset + (codePoint - start) * 2)
    return glyph === 0 ? 0 : (glyph + delta) & 0xffff
  }
}

// ---- glyf（TrueType の輪郭） ----

type GlyphPoint = { x: number; y: number; on: boolean }

function glyfOutlines(tables: Tables, head: DataView, glyphCount: number): ((glyph: number) => GlyphCommand[]) | null {
  const glyf = tables.get('glyf')
  const loca = tables.get('loca')
  if (!glyf || !loca) return null
  const long = head.getInt16(50) === 1
  const locate = (glyph: number): [number, number] => {
    if (long) return [loca.getUint32(glyph * 4), loca.getUint32(glyph * 4 + 4)]
    return [loca.getUint16(glyph * 2) * 2, loca.getUint16(glyph * 2 + 2) * 2]
  }
  const contoursOf = (glyph: number, depth: number): GlyphPoint[][] => {
    if (depth > MAX_NESTING || glyph >= glyphCount) return []
    const [start, end] = locate(glyph)
    if (end <= start) return []
    const data = viewOf(new Uint8Array(glyf.buffer, glyf.byteOffset, glyf.byteLength), start, end - start)
    const contourCount = data.getInt16(0)
    if (contourCount >= 0) return simpleGlyph(data, contourCount)
    const result: GlyphPoint[][] = []
    let offset = 10
    for (;;) {
      const flags = data.getUint16(offset)
      const component = data.getUint16(offset + 2)
      offset += 4
      let dx: number
      let dy: number
      if (flags & 0x1) {
        dx = data.getInt16(offset)
        dy = data.getInt16(offset + 2)
        offset += 4
      } else {
        dx = data.getInt8(offset)
        dy = data.getInt8(offset + 1)
        offset += 2
      }
      // 点を合わせる配置（ARGS_ARE_XY_VALUES でない）は使われることが少ないので、ずらさない
      if ((flags & 0x2) === 0) dx = dy = 0
      let a = 1
      let b = 0
      let c = 0
      let d = 1
      const f2dot14 = (at: number) => data.getInt16(at) / 16384
      if (flags & 0x8) {
        a = d = f2dot14(offset)
        offset += 2
      } else if (flags & 0x40) {
        a = f2dot14(offset)
        d = f2dot14(offset + 2)
        offset += 4
      } else if (flags & 0x80) {
        a = f2dot14(offset)
        b = f2dot14(offset + 2)
        c = f2dot14(offset + 4)
        d = f2dot14(offset + 6)
        offset += 8
      }
      for (const contour of contoursOf(component, depth + 1)) {
        result.push(contour.map((p) => ({ x: a * p.x + c * p.y + dx, y: b * p.x + d * p.y + dy, on: p.on })))
      }
      if ((flags & 0x20) === 0) break
    }
    return result
  }
  return (glyph) => quadraticPath(contoursOf(glyph, 0))
}

function simpleGlyph(data: DataView, contourCount: number): GlyphPoint[][] {
  const endPoints: number[] = []
  for (let i = 0; i < contourCount; i++) endPoints.push(data.getUint16(10 + i * 2))
  const pointCount = contourCount === 0 ? 0 : endPoints[contourCount - 1] + 1
  let offset = 10 + contourCount * 2
  offset += 2 + data.getUint16(offset)
  const flags = new Uint8Array(pointCount)
  for (let i = 0; i < pointCount; ) {
    const flag = data.getUint8(offset++)
    flags[i++] = flag
    if (flag & 0x8) {
      const repeat = data.getUint8(offset++)
      for (let r = 0; r < repeat && i < pointCount; r++) flags[i++] = flag
    }
  }
  const xs = new Int32Array(pointCount)
  const ys = new Int32Array(pointCount)
  const readAxis = (out: Int32Array, short: number, same: number) => {
    let value = 0
    for (let i = 0; i < pointCount; i++) {
      const flag = flags[i]
      if (flag & short) {
        const delta = data.getUint8(offset++)
        value += flag & same ? delta : -delta
      } else if ((flag & same) === 0) {
        value += data.getInt16(offset)
        offset += 2
      }
      out[i] = value
    }
  }
  readAxis(xs, 0x2, 0x10)
  readAxis(ys, 0x4, 0x20)
  const contours: GlyphPoint[][] = []
  let first = 0
  for (const last of endPoints) {
    const contour: GlyphPoint[] = []
    for (let i = first; i <= last && i < pointCount; i++) contour.push({ x: xs[i], y: ys[i], on: (flags[i] & 0x1) !== 0 })
    if (contour.length > 0) contours.push(contour)
    first = last + 1
  }
  return contours
}

/** TrueType の点の並び（曲線上の点と 2 次の制御点）を命令にする。続く制御点の間には、その中点に曲線上の点があるとみなす */
function quadraticPath(contours: readonly GlyphPoint[][]): GlyphCommand[] {
  const out: GlyphCommand[] = []
  for (const points of contours) {
    const n = points.length
    if (n === 0) continue
    const first = points[0]
    const last = points[n - 1]
    let start: { x: number; y: number }
    let rest: GlyphPoint[]
    if (first.on) {
      start = first
      rest = points.slice(1)
    } else if (last.on) {
      start = last
      rest = points.slice(0, -1)
    } else {
      start = { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 }
      rest = points
    }
    out.push({ type: 'M', x: start.x, y: start.y })
    let control: GlyphPoint | null = null
    for (const point of rest) {
      if (point.on) {
        out.push(control ? { type: 'Q', x1: control.x, y1: control.y, x: point.x, y: point.y } : { type: 'L', x: point.x, y: point.y })
        control = null
      } else {
        if (control) out.push({ type: 'Q', x1: control.x, y1: control.y, x: (control.x + point.x) / 2, y: (control.y + point.y) / 2 })
        control = point
      }
    }
    if (control) out.push({ type: 'Q', x1: control.x, y1: control.y, x: start.x, y: start.y })
    out.push({ type: 'Z' })
  }
  return out
}

// ---- CFF（OpenType の 3 次曲線の輪郭） ----

type CffIndex = { count: number; at(i: number): DataView }

const EMPTY_INDEX: CffIndex = {
  count: 0,
  at: () => {
    throw new RangeError('empty index')
  },
}

function cffIndex(data: DataView, offset: number): { index: CffIndex; end: number } {
  const count = data.getUint16(offset)
  if (count === 0) return { index: EMPTY_INDEX, end: offset + 2 }
  const offSize = data.getUint8(offset + 2)
  if (offSize < 1 || offSize > 4) throw new RangeError('bad offSize')
  const readOffset = (i: number) => {
    let value = 0
    for (let k = 0; k < offSize; k++) value = value * 256 + data.getUint8(offset + 3 + i * offSize + k)
    return value
  }
  const dataStart = offset + 3 + (count + 1) * offSize - 1
  const end = dataStart + readOffset(count)
  return {
    index: {
      count,
      at: (i) => {
        const from = dataStart + readOffset(i)
        const to = dataStart + readOffset(i + 1)
        if (to < from || to > data.byteLength) throw new RangeError('bad index')
        return new DataView(data.buffer, data.byteOffset + from, to - from)
      },
    },
    end,
  }
}

/** CFF の DICT を、演算子（12 の後ろは 1200 + 次のバイト）ごとの数の並びにする */
function cffDict(data: DataView): Map<number, number[]> {
  const dict = new Map<number, number[]>()
  let operands: number[] = []
  let i = 0
  while (i < data.byteLength) {
    const b0 = data.getUint8(i)
    if (b0 <= 21) {
      let op = b0
      i++
      if (b0 === 12) op = 1200 + data.getUint8(i++)
      dict.set(op, operands)
      operands = []
    } else if (b0 === 28) {
      operands.push(data.getInt16(i + 1))
      i += 3
    } else if (b0 === 29) {
      operands.push(data.getInt32(i + 1))
      i += 5
    } else if (b0 === 30) {
      // 実数（4 ビットずつ）。字の輪郭を読むのには使わないので、読み飛ばして 0 にする
      i++
      for (;;) {
        const byte = data.getUint8(i++)
        if ((byte & 0x0f) === 0x0f || (byte >> 4) === 0x0f) break
      }
      operands.push(0)
    } else if (b0 >= 32 && b0 <= 246) {
      operands.push(b0 - 139)
      i++
    } else if (b0 >= 247 && b0 <= 250) {
      operands.push((b0 - 247) * 256 + data.getUint8(i + 1) + 108)
      i += 2
    } else if (b0 >= 251 && b0 <= 254) {
      operands.push(-(b0 - 251) * 256 - data.getUint8(i + 1) - 108)
      i += 2
    } else {
      throw new RangeError('bad dict')
    }
  }
  return dict
}

function subrBias(count: number): number {
  return count < 1240 ? 107 : count < 33900 ? 1131 : 32768
}

function privateSubrs(cff: DataView, dict: Map<number, number[]>): CffIndex {
  const [size, offset] = dict.get(18) ?? [0, 0]
  if (!size) return EMPTY_INDEX
  const priv = cffDict(new DataView(cff.buffer, cff.byteOffset + offset, size))
  const subrs = priv.get(19)?.[0]
  return subrs ? cffIndex(cff, offset + subrs).index : EMPTY_INDEX
}

function cffOutlines(tables: Tables, glyphCount: number): ((glyph: number) => GlyphCommand[]) | null {
  const cff = tables.get('CFF ')
  if (!cff) return null
  const headerSize = cff.getUint8(2)
  const names = cffIndex(cff, headerSize)
  const topDicts = cffIndex(cff, names.end)
  const strings = cffIndex(cff, topDicts.end)
  const globalSubrs = cffIndex(cff, strings.end).index
  if (topDicts.index.count < 1) return null
  const top = cffDict(topDicts.index.at(0))
  if ((top.get(1206)?.[0] ?? 2) !== 2) return null
  const charStringsOffset = top.get(17)?.[0]
  if (charStringsOffset === undefined) return null
  const charStrings = cffIndex(cff, charStringsOffset).index
  if (charStrings.count < glyphCount) glyphCount = charStrings.count

  // CID の書体は字ごとに使う Private DICT（のサブルーチン）を FDSelect で選ぶ
  let subrsFor: (glyph: number) => CffIndex
  const fdArrayOffset = top.get(1236)?.[0]
  const fdSelectOffset = top.get(1237)?.[0]
  if (top.has(1230) && fdArrayOffset !== undefined && fdSelectOffset !== undefined) {
    const fdArray = cffIndex(cff, fdArrayOffset).index
    const locals = Array.from({ length: fdArray.count }, (_, i) => privateSubrs(cff, cffDict(fdArray.at(i))))
    const format = cff.getUint8(fdSelectOffset)
    let fdOf: (glyph: number) => number
    if (format === 0) fdOf = (glyph) => cff.getUint8(fdSelectOffset + 1 + glyph)
    else if (format === 3) {
      const ranges = cff.getUint16(fdSelectOffset + 1)
      fdOf = (glyph) => {
        for (let i = 0; i < ranges; i++) {
          const at = fdSelectOffset + 3 + i * 3
          const next = cff.getUint16(at + 3)
          if (glyph >= cff.getUint16(at) && glyph < next) return cff.getUint8(at + 2)
        }
        return 0
      }
    } else return null
    subrsFor = (glyph) => locals[fdOf(glyph)] ?? locals[0]
  } else {
    const local = privateSubrs(cff, top)
    subrsFor = () => local
  }
  return (glyph) => (glyph < glyphCount ? runCharString(charStrings.at(glyph), globalSubrs, subrsFor(glyph)) : [])
}

/** Type 2 の字形の命令を実行して輪郭にする（幅とヒントは読み捨てる） */
function runCharString(code: DataView, globalSubrs: CffIndex, localSubrs: CffIndex): GlyphCommand[] {
  const out: GlyphCommand[] = []
  const stack: number[] = []
  let x = 0
  let y = 0
  let stems = 0
  let open = false
  let widthTaken = false
  let ended = false
  const globalBias = subrBias(globalSubrs.count)
  const localBias = subrBias(localSubrs.count)

  const moveTo = (dx: number, dy: number) => {
    if (open) out.push({ type: 'Z' })
    x += dx
    y += dy
    out.push({ type: 'M', x, y })
    open = true
  }
  const lineTo = (dx: number, dy: number) => {
    x += dx
    y += dy
    out.push({ type: 'L', x, y })
  }
  const curveTo = (dx1: number, dy1: number, dx2: number, dy2: number, dx3: number, dy3: number) => {
    const x1 = x + dx1
    const y1 = y + dy1
    const x2 = x1 + dx2
    const y2 = y1 + dy2
    x = x2 + dx3
    y = y2 + dy3
    out.push({ type: 'C', x1, y1, x2, y2, x, y })
  }
  // 幅は最初の「スタックを空にする」命令の前に、余分な 1 つとして置かれる
  const takeWidth = (expected: number) => {
    if (!widthTaken && stack.length > expected) stack.shift()
    widthTaken = true
  }
  const stem = () => {
    takeWidth(stack.length - (stack.length % 2))
    stems += stack.length >> 1
    stack.length = 0
  }

  const run = (data: DataView, depth: number) => {
    if (depth > MAX_NESTING) throw new RangeError('subr nesting')
    let i = 0
    while (i < data.byteLength && !ended) {
      const b0 = data.getUint8(i++)
      if (b0 >= 32 || b0 === 28) {
        if (b0 === 28) {
          stack.push(data.getInt16(i))
          i += 2
        } else if (b0 <= 246) stack.push(b0 - 139)
        else if (b0 <= 250) stack.push((b0 - 247) * 256 + data.getUint8(i++) + 108)
        else if (b0 <= 254) stack.push(-(b0 - 251) * 256 - data.getUint8(i++) - 108)
        else {
          stack.push(data.getInt32(i) / 65536)
          i += 4
        }
        if (stack.length > 513) throw new RangeError('stack overflow')
        continue
      }
      const s = stack
      switch (b0) {
        case 1: // hstem
        case 3: // vstem
        case 18: // hstemhm
        case 23: // vstemhm
          stem()
          break
        case 19: // hintmask
        case 20: // cntrmask
          if (s.length > 0) stem()
          widthTaken = true
          i += (stems + 7) >> 3
          break
        case 21: // rmoveto
          takeWidth(2)
          moveTo(s[0], s[1])
          s.length = 0
          break
        case 22: // hmoveto
          takeWidth(1)
          moveTo(s[0], 0)
          s.length = 0
          break
        case 4: // vmoveto
          takeWidth(1)
          moveTo(0, s[0])
          s.length = 0
          break
        case 5: // rlineto
          for (let k = 0; k + 1 < s.length; k += 2) lineTo(s[k], s[k + 1])
          s.length = 0
          break
        case 6: // hlineto
        case 7: // vlineto
          for (let k = 0; k < s.length; k++) {
            const horizontal = (k % 2 === 0) === (b0 === 6)
            if (horizontal) lineTo(s[k], 0)
            else lineTo(0, s[k])
          }
          s.length = 0
          break
        case 8: // rrcurveto
          for (let k = 0; k + 5 < s.length; k += 6) curveTo(s[k], s[k + 1], s[k + 2], s[k + 3], s[k + 4], s[k + 5])
          s.length = 0
          break
        case 24: { // rcurveline
          let k = 0
          for (; k + 5 < s.length - 2; k += 6) curveTo(s[k], s[k + 1], s[k + 2], s[k + 3], s[k + 4], s[k + 5])
          lineTo(s[k], s[k + 1])
          s.length = 0
          break
        }
        case 25: { // rlinecurve
          let k = 0
          for (; k + 1 < s.length - 6; k += 2) lineTo(s[k], s[k + 1])
          curveTo(s[k], s[k + 1], s[k + 2], s[k + 3], s[k + 4], s[k + 5])
          s.length = 0
          break
        }
        case 26: { // vvcurveto
          let k = 0
          let dx1 = 0
          if (s.length % 2 === 1) dx1 = s[k++]
          for (; k + 3 < s.length; k += 4) {
            curveTo(dx1, s[k], s[k + 1], s[k + 2], 0, s[k + 3])
            dx1 = 0
          }
          s.length = 0
          break
        }
        case 27: { // hhcurveto
          let k = 0
          let dy1 = 0
          if (s.length % 2 === 1) dy1 = s[k++]
          for (; k + 3 < s.length; k += 4) {
            curveTo(s[k], dy1, s[k + 1], s[k + 2], s[k + 3], 0)
            dy1 = 0
          }
          s.length = 0
          break
        }
        case 30: // vhcurveto
        case 31: { // hvcurveto
          let vertical = b0 === 30
          for (let k = 0; k + 3 < s.length; k += 4) {
            const last = s.length - k === 5 ? s[k + 4] : 0
            if (vertical) curveTo(0, s[k], s[k + 1], s[k + 2], s[k + 3], last)
            else curveTo(s[k], 0, s[k + 1], s[k + 2], last, s[k + 3])
            vertical = !vertical
          }
          s.length = 0
          break
        }
        case 10: { // callsubr
          const index = s.pop()! + localBias
          if (index < 0 || index >= localSubrs.count) throw new RangeError('bad subr')
          run(localSubrs.at(index), depth + 1)
          break
        }
        case 29: { // callgsubr
          const index = s.pop()! + globalBias
          if (index < 0 || index >= globalSubrs.count) throw new RangeError('bad subr')
          run(globalSubrs.at(index), depth + 1)
          break
        }
        case 11: // return
          return
        case 14: // endchar（アクセントを重ねる古い形 seac は読まない）
          takeWidth(stack.length >= 4 ? 4 : 0)
          if (open) out.push({ type: 'Z' })
          open = false
          ended = true
          return
        case 12: {
          const op = data.getUint8(i++)
          if (op === 35) { // flex
            curveTo(s[0], s[1], s[2], s[3], s[4], s[5])
            curveTo(s[6], s[7], s[8], s[9], s[10], s[11])
          } else if (op === 34) { // hflex
            curveTo(s[0], 0, s[1], s[2], s[3], 0)
            curveTo(s[4], 0, s[5], -s[2], s[6], 0)
          } else if (op === 36) { // hflex1
            curveTo(s[0], s[1], s[2], s[3], s[4], 0)
            curveTo(s[5], 0, s[6], s[7], s[8], -(s[1] + s[3] + s[7]))
          } else if (op === 37) { // flex1
            const dx = s[0] + s[2] + s[4] + s[6] + s[8]
            const dy = s[1] + s[3] + s[5] + s[7] + s[9]
            const horizontal = Math.abs(dx) > Math.abs(dy)
            curveTo(s[0], s[1], s[2], s[3], s[4], s[5])
            curveTo(s[6], s[7], s[8], s[9], horizontal ? s[10] : -dx, horizontal ? -dy : s[10])
          }
          // 算術などの命令は輪郭に使われることがまれなので読み捨てる
          s.length = 0
          break
        }
        default:
          s.length = 0
      }
    }
  }
  run(code, 0)
  if (open) out.push({ type: 'Z' })
  return out
}

// ---- 字詰め ----

/** GPOS の kern の機能（PairPos）を、なければ古い kern の表を読む。どちらも無ければ 0 を返す関数 */
function kerningOf(tables: Tables): (left: number, right: number) => number {
  let lookup: ((left: number, right: number) => number) | null = null
  try {
    const gpos = tables.get('GPOS')
    if (gpos) lookup = gposKerning(gpos)
  } catch {
    lookup = null
  }
  if (!lookup) {
    try {
      const kern = tables.get('kern')
      if (kern) lookup = kernTable(kern)
    } catch {
      lookup = null
    }
  }
  if (!lookup) return () => 0
  const found = lookup
  const cache = new Map<number, number>()
  return (left, right) => {
    const key = left * 65536 + right
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    let value = 0
    try {
      value = found(left, right)
    } catch {
      value = 0
    }
    if (cache.size > 100_000) cache.clear()
    cache.set(key, value)
    return value
  }
}

function kernTable(kern: DataView): ((left: number, right: number) => number) | null {
  if (kern.getUint16(0) !== 0) return null
  const count = kern.getUint16(2)
  const pairs = new Map<number, number>()
  let offset = 4
  for (let t = 0; t < count; t++) {
    const length = kern.getUint16(offset + 2)
    const coverage = kern.getUint16(offset + 4)
    // 横書き（bit 0）で、最小値・直交でない format 0 だけ
    if ((coverage & 0x1) !== 0 && (coverage & 0x6) === 0 && coverage >> 8 === 0) {
      const pairCount = kern.getUint16(offset + 6)
      for (let i = 0; i < pairCount; i++) {
        const at = offset + 14 + i * 6
        const key = kern.getUint16(at) * 65536 + kern.getUint16(at + 2)
        pairs.set(key, (pairs.get(key) ?? 0) + kern.getInt16(at + 4))
      }
    }
    offset += length
  }
  return pairs.size === 0 ? null : (left, right) => pairs.get(left * 65536 + right) ?? 0
}

function coverageIndex(data: DataView, offset: number, glyph: number): number {
  const format = data.getUint16(offset)
  const count = data.getUint16(offset + 2)
  if (format === 1) {
    let low = 0
    let high = count - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      const value = data.getUint16(offset + 4 + mid * 2)
      if (value < glyph) low = mid + 1
      else if (value > glyph) high = mid - 1
      else return mid
    }
    return -1
  }
  if (format === 2) {
    let low = 0
    let high = count - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      const at = offset + 4 + mid * 6
      if (glyph < data.getUint16(at)) high = mid - 1
      else if (glyph > data.getUint16(at + 2)) low = mid + 1
      else return data.getUint16(at + 4) + glyph - data.getUint16(at)
    }
  }
  return -1
}

function classOf(data: DataView, offset: number, glyph: number): number {
  const format = data.getUint16(offset)
  if (format === 1) {
    const start = data.getUint16(offset + 2)
    const count = data.getUint16(offset + 4)
    return glyph >= start && glyph < start + count ? data.getUint16(offset + 6 + (glyph - start) * 2) : 0
  }
  if (format === 2) {
    const count = data.getUint16(offset + 2)
    let low = 0
    let high = count - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      const at = offset + 4 + mid * 6
      if (glyph < data.getUint16(at)) high = mid - 1
      else if (glyph > data.getUint16(at + 2)) low = mid + 1
      else return data.getUint16(at + 4)
    }
  }
  return 0
}

function valueSize(format: number): number {
  let size = 0
  for (let bit = 0; bit < 8; bit++) if (format & (1 << bit)) size += 2
  return size
}

/** ValueRecord の XAdvance（無ければ 0） */
function xAdvance(data: DataView, offset: number, format: number): number {
  if ((format & 0x4) === 0) return 0
  let at = offset
  if (format & 0x1) at += 2
  if (format & 0x2) at += 2
  return data.getInt16(at)
}

function gposKerning(gpos: DataView): ((left: number, right: number) => number) | null {
  const featureList = gpos.getUint16(6)
  const lookupList = gpos.getUint16(8)
  const lookupIndices = new Set<number>()
  const featureCount = gpos.getUint16(featureList)
  for (let i = 0; i < featureCount; i++) {
    const record = featureList + 2 + i * 6
    if (tagAt(gpos, record) !== 'kern') continue
    const feature = featureList + gpos.getUint16(record + 4)
    const count = gpos.getUint16(feature + 2)
    for (let k = 0; k < count; k++) lookupIndices.add(gpos.getUint16(feature + 4 + k * 2))
  }
  if (lookupIndices.size === 0) return null
  // 字詰め（PairPos）の小表。拡張（type 9）の先も開く
  const subtables: DataView[][] = []
  const lookupCount = gpos.getUint16(lookupList)
  for (const index of [...lookupIndices].sort((a, b) => a - b)) {
    if (index >= lookupCount) continue
    const lookup = lookupList + gpos.getUint16(lookupList + 2 + index * 2)
    const type = gpos.getUint16(lookup)
    const count = gpos.getUint16(lookup + 4)
    const list: DataView[] = []
    for (let k = 0; k < count; k++) {
      let at = lookup + gpos.getUint16(lookup + 6 + k * 2)
      let subtableType = type
      if (type === 9) {
        subtableType = gpos.getUint16(at + 2)
        at += gpos.getUint32(at + 4)
      }
      if (subtableType === 2) list.push(new DataView(gpos.buffer, gpos.byteOffset + at, gpos.byteLength - at))
    }
    if (list.length > 0) subtables.push(list)
  }
  if (subtables.length === 0) return null
  return (left, right) => {
    let total = 0
    for (const list of subtables) {
      for (const sub of list) {
        const value = pairValue(sub, left, right)
        if (value !== null) {
          total += value
          break
        }
      }
    }
    return total
  }
}

/** PairPos の小表 1 つの、左の字の XAdvance。左の字が範囲に無い（format 1 では組が無い）なら null */
function pairValue(sub: DataView, left: number, right: number): number | null {
  const format = sub.getUint16(0)
  const coverage = coverageIndex(sub, sub.getUint16(2), left)
  if (coverage < 0) return null
  const format1 = sub.getUint16(4)
  const format2 = sub.getUint16(6)
  const size1 = valueSize(format1)
  const size2 = valueSize(format2)
  if (format === 1) {
    if (coverage >= sub.getUint16(8)) return null
    const set = sub.getUint16(10 + coverage * 2)
    const count = sub.getUint16(set)
    const recordSize = 2 + size1 + size2
    let low = 0
    let high = count - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      const at = set + 2 + mid * recordSize
      const second = sub.getUint16(at)
      if (second < right) low = mid + 1
      else if (second > right) high = mid - 1
      else return xAdvance(sub, at + 2, format1)
    }
    return null
  }
  if (format === 2) {
    const class1 = classOf(sub, sub.getUint16(8), left)
    const class2 = classOf(sub, sub.getUint16(10), right)
    const class1Count = sub.getUint16(12)
    const class2Count = sub.getUint16(14)
    if (class1 >= class1Count || class2 >= class2Count) return 0
    const at = 16 + (class1 * class2Count + class2) * (size1 + size2)
    return xAdvance(sub, at, format1)
  }
  return null
}
