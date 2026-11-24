// zlib（RFC 1950）/ deflate（RFC 1951）の同期の展開。WOFF の書体の表を、描画やブーリアン演算の途中（同期の処理）で読むために使う。
// ブラウザの DecompressionStream は非同期なので使えない。展開した大きさは呼ぶ側が決めた上限（expected）で打ち切る（細工されたファイルへの備え）。

class BitReader {
  private pos = 0
  private bit = 0
  private bits = 0
  private readonly data: Uint8Array
  constructor(data: Uint8Array) {
    this.data = data
  }
  get offset(): number {
    return this.pos
  }
  read(count: number): number {
    while (this.bits < count) {
      if (this.pos >= this.data.length) throw new Error('inflate: 途中で切れています')
      this.bit |= this.data[this.pos++] << this.bits
      this.bits += 8
    }
    const value = this.bit & ((1 << count) - 1)
    this.bit >>>= count
    this.bits -= count
    return value
  }
  /** バイトの境目まで読み飛ばす（格納だけのブロック） */
  align(): void {
    this.bit = 0
    this.bits = 0
  }
  byte(): number {
    if (this.pos >= this.data.length) throw new Error('inflate: 途中で切れています')
    return this.data[this.pos++]
  }
}

/** 符号の長さの並びから引く表（長さごとの数と、符号の順の記号） */
type Huffman = { counts: Uint16Array; symbols: Uint16Array }

function huffman(lengths: ArrayLike<number>): Huffman {
  const counts = new Uint16Array(16)
  for (let i = 0; i < lengths.length; i++) counts[lengths[i]]++
  counts[0] = 0
  const offsets = new Uint16Array(16)
  for (let i = 1; i < 16; i++) offsets[i] = offsets[i - 1] + counts[i - 1]
  const symbols = new Uint16Array(lengths.length)
  for (let i = 0; i < lengths.length; i++) if (lengths[i] !== 0) symbols[offsets[lengths[i]]++] = i
  return { counts, symbols }
}

function decodeSymbol(reader: BitReader, table: Huffman): number {
  let code = 0
  let first = 0
  let index = 0
  for (let length = 1; length < 16; length++) {
    code |= reader.read(1)
    const count = table.counts[length]
    if (code - first < count) return table.symbols[index + code - first]
    index += count
    first = (first + count) << 1
    code <<= 1
  }
  throw new Error('inflate: 符号が不正です')
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

let fixedTables: { lit: Huffman; dist: Huffman } | null = null
function fixed(): { lit: Huffman; dist: Huffman } {
  if (fixedTables) return fixedTables
  const lengths = new Uint8Array(288)
  lengths.fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288)
  fixedTables = { lit: huffman(lengths), dist: huffman(new Uint8Array(30).fill(5)) }
  return fixedTables
}

function dynamic(reader: BitReader): { lit: Huffman; dist: Huffman } {
  const litCount = reader.read(5) + 257
  const distCount = reader.read(5) + 1
  const codeCount = reader.read(4) + 4
  const codeLengths = new Uint8Array(19)
  for (let i = 0; i < codeCount; i++) codeLengths[CODE_LENGTH_ORDER[i]] = reader.read(3)
  const codeTable = huffman(codeLengths)
  const lengths = new Uint8Array(litCount + distCount)
  for (let i = 0; i < lengths.length; ) {
    const symbol = decodeSymbol(reader, codeTable)
    if (symbol < 16) {
      lengths[i++] = symbol
      continue
    }
    let repeat: number
    let value = 0
    if (symbol === 16) {
      if (i === 0) throw new Error('inflate: 繰り返す長さがありません')
      value = lengths[i - 1]
      repeat = 3 + reader.read(2)
    } else if (symbol === 17) repeat = 3 + reader.read(3)
    else repeat = 11 + reader.read(7)
    if (i + repeat > lengths.length) throw new Error('inflate: 長さの並びが不正です')
    lengths.fill(value, i, i + repeat)
    i += repeat
  }
  return { lit: huffman(lengths.subarray(0, litCount)), dist: huffman(lengths.subarray(litCount)) }
}

/**
 * zlib の形式（2 バイトの見出し + deflate）のバイト列を展開する。expected は展開した大きさ（WOFF の表の origLength）。
 * それより長くなる・短く終わる・壊れているときは例外を投げる
 */
export function inflateZlib(data: Uint8Array, expected: number): Uint8Array {
  if (data.length < 2 || (data[0] & 0x0f) !== 8 || ((data[0] << 8) | data[1]) % 31 !== 0 || (data[1] & 0x20) !== 0) {
    throw new Error('inflate: zlib の見出しが不正です')
  }
  const reader = new BitReader(data.subarray(2))
  const out = new Uint8Array(expected)
  let length = 0
  let last = 0
  while (last === 0) {
    last = reader.read(1)
    const type = reader.read(2)
    if (type === 0) {
      reader.align()
      const size = reader.byte() | (reader.byte() << 8)
      const check = reader.byte() | (reader.byte() << 8)
      if ((size ^ 0xffff) !== check) throw new Error('inflate: 格納ブロックの長さが不正です')
      if (length + size > expected) throw new Error('inflate: 大きすぎます')
      for (let i = 0; i < size; i++) out[length++] = reader.byte()
      continue
    }
    if (type === 3) throw new Error('inflate: ブロックの種類が不正です')
    const { lit, dist } = type === 1 ? fixed() : dynamic(reader)
    for (;;) {
      const symbol = decodeSymbol(reader, lit)
      if (symbol < 256) {
        if (length >= expected) throw new Error('inflate: 大きすぎます')
        out[length++] = symbol
        continue
      }
      if (symbol === 256) break
      const lengthIndex = symbol - 257
      if (lengthIndex >= LENGTH_BASE.length) throw new Error('inflate: 長さの記号が不正です')
      const copy = LENGTH_BASE[lengthIndex] + reader.read(LENGTH_EXTRA[lengthIndex])
      const distIndex = decodeSymbol(reader, dist)
      if (distIndex >= DIST_BASE.length) throw new Error('inflate: 距離の記号が不正です')
      const distance = DIST_BASE[distIndex] + reader.read(DIST_EXTRA[distIndex])
      if (distance > length) throw new Error('inflate: 距離が不正です')
      if (length + copy > expected) throw new Error('inflate: 大きすぎます')
      for (let i = 0; i < copy; i++, length++) out[length] = out[length - distance]
    }
  }
  if (length !== expected) throw new Error('inflate: 大きさが合いません')
  return out
}
