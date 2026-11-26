import { DICTIONARY_SIZE, DICTIONARY_ZLIB_BASE64, TRANSFORMS } from './brotliDictionary.ts'
import { inflateZlib } from './inflate.ts'

// Brotli（RFC 7932）の同期の展開。WOFF2 の書体の表を読むために使う（woff2.ts）。描画やブーリアン演算の途中（同期の処理）でも読むので、
// ブラウザの DecompressionStream（非同期で、Brotli に対応していないブラウザもある）は使わない。
// 展開した大きさは呼ぶ側が決めた値（WOFF2 の表の大きさの合計）に限り、それより長くなる・短く終わる・壊れているときは例外を投げる（細工されたファイルへの備え）。

class BitReader {
  private pos = 0
  private value = 0
  private count = 0
  private readonly data: Uint8Array
  constructor(data: Uint8Array) {
    this.data = data
  }
  /**
   * 少なくとも 25 ビットを貯める（データの終わりより先は 0 で埋め、使ったら checkEnd で弾く）。
   * 貯めておけるのは 32 ビットまでなので、終わりより 4 バイト以上先を読みに来たら、もう終わりより先を使っている。
   * そこで止める（0 を読み続けられると、短い入力で長い繰り返しを回せてしまう）
   */
  private fill(): void {
    if (this.pos > this.data.length + 3) throw new Error('brotli: 途中で切れています')
    while (this.count <= 24) {
      const byte = this.pos < this.data.length ? this.data[this.pos] : 0
      this.pos++
      this.value = (this.value | (byte << this.count)) >>> 0
      this.count += 8
    }
  }
  /** 次の n ビット（n ≤ 24）を読まずに見る */
  peek(n: number): number {
    if (this.count < n) this.fill()
    return this.value & ((1 << n) - 1)
  }
  skip(n: number): void {
    this.value >>>= n
    this.count -= n
  }
  read(n: number): number {
    if (n === 0) return 0
    const value = this.peek(n)
    this.skip(n)
    return value
  }
  /** バイトの境目まで読み飛ばす */
  align(): void {
    this.skip(this.count & 7)
  }
  /** データの終わりより先を読んでいないか */
  checkEnd(): void {
    if (this.pos * 8 - this.count > this.data.length * 8) throw new Error('brotli: 途中で切れています')
  }
}

// ---- 符号（プレフィックス符号）

/** 引く表の根の幅（それより長い符号は 1 ビットずつたどる） */
const ROOT_BITS = 8

/**
 * 符号の長さの並びから引く表。root は先頭の ROOT_BITS ビット（読む順）で引き、(長さ << 16) | 記号。長さが ROOT_BITS を超える符号は -1。
 * 記号が 1 つだけの符号は 0 ビットで読む
 */
type Huffman = { root: Int32Array; counts: Uint16Array; symbols: Uint16Array; single: number }

function huffman(lengths: Uint8Array): Huffman {
  const counts = new Uint16Array(16)
  let used = 0
  let last = 0
  for (let i = 0; i < lengths.length; i++) {
    if (lengths[i] === 0) continue
    counts[lengths[i]]++
    used++
    last = i
  }
  const symbols = new Uint16Array(used)
  const root = new Int32Array(1 << ROOT_BITS)
  if (used === 1) return { root, counts, symbols, single: last }
  const offsets = new Uint16Array(16)
  for (let i = 1; i < 16; i++) offsets[i] = offsets[i - 1] + counts[i - 1]
  for (let i = 0; i < lengths.length; i++) if (lengths[i] !== 0) symbols[offsets[lengths[i]]++] = i
  // 正準の符号を順に振り、読む順（下位ビットから）に反転して根の表に入れる
  root.fill(-1)
  let code = 0
  let index = 0
  for (let length = 1; length < 16; length++) {
    for (let k = 0; k < counts[length]; k++, index++, code++) {
      if (length > ROOT_BITS) continue
      let reversed = 0
      for (let b = 0; b < length; b++) reversed |= ((code >> b) & 1) << (length - 1 - b)
      for (let fillAt = reversed; fillAt < root.length; fillAt += 1 << length) root[fillAt] = (length << 16) | symbols[index]
    }
    code <<= 1
  }
  return { root, counts, symbols, single: -1 }
}

function decodeSymbol(reader: BitReader, table: Huffman): number {
  if (table.single >= 0) return table.single
  const entry = table.root[reader.peek(ROOT_BITS)]
  if (entry >= 0) {
    reader.skip(entry >>> 16)
    return entry & 0xffff
  }
  const bits = reader.peek(15)
  let code = 0
  let first = 0
  let index = 0
  for (let length = 1; length < 16; length++) {
    code |= (bits >> (length - 1)) & 1
    const count = table.counts[length]
    if (code - first < count) {
      reader.skip(length)
      return table.symbols[index + code - first]
    }
    index += count
    first = (first + count) << 1
    code <<= 1
  }
  throw new Error('brotli: 符号が不正です')
}

/** 符号の長さの符号の、長さを読む固定の符号（次の 4 ビットで引く。RFC 7932 3.5） */
const CODE_LENGTH_PREFIX_LENGTH = [2, 2, 2, 3, 2, 2, 2, 4, 2, 2, 2, 3, 2, 2, 2, 4]
const CODE_LENGTH_PREFIX_VALUE = [0, 4, 3, 2, 0, 4, 3, 1, 0, 4, 3, 2, 0, 4, 3, 5]
const CODE_LENGTH_ORDER = [1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15]

function bitWidth(alphabetSize: number): number {
  let bits = 0
  while (1 << bits < alphabetSize) bits++
  return bits
}

/** 符号を 1 つ読む（単純な符号か、符号の長さを符号にした複雑な符号） */
function readHuffman(reader: BitReader, alphabetSize: number): Huffman {
  const lengths = new Uint8Array(alphabetSize)
  const skip = reader.read(2)
  if (skip === 1) {
    const count = reader.read(2) + 1
    const width = bitWidth(alphabetSize)
    const symbols: number[] = []
    for (let i = 0; i < count; i++) {
      const symbol = reader.read(width)
      if (symbol >= alphabetSize || symbols.includes(symbol)) throw new Error('brotli: 単純な符号が不正です')
      symbols.push(symbol)
    }
    if (count === 1) lengths[symbols[0]] = 1
    else if (count === 2) lengths[symbols[0]] = lengths[symbols[1]] = 1
    else if (count === 3) {
      lengths[symbols[0]] = 1
      lengths[symbols[1]] = lengths[symbols[2]] = 2
    } else if (reader.read(1) === 0) for (const symbol of symbols) lengths[symbol] = 2
    else {
      lengths[symbols[0]] = 1
      lengths[symbols[1]] = 2
      lengths[symbols[2]] = lengths[symbols[3]] = 3
    }
    return huffman(lengths)
  }

  // 符号の長さの符号
  const codeLengths = new Uint8Array(18)
  let space = 32
  let used = 0
  for (let i = skip; i < 18 && space > 0; i++) {
    const peeked = reader.peek(4)
    reader.skip(CODE_LENGTH_PREFIX_LENGTH[peeked])
    const length = CODE_LENGTH_PREFIX_VALUE[peeked]
    codeLengths[CODE_LENGTH_ORDER[i]] = length
    if (length !== 0) {
      space -= 32 >> length
      used++
    }
  }
  if (used !== 1 && space !== 0) throw new Error('brotli: 符号の長さの符号が不正です')
  const codeTable = huffman(codeLengths)

  // 記号の符号の長さ
  let symbol = 0
  let previous = 8
  let repeat = 0
  let repeatLength = 0
  space = 32768
  while (symbol < alphabetSize && space > 0) {
    const code = decodeSymbol(reader, codeTable)
    if (code < 16) {
      repeat = 0
      lengths[symbol++] = code
      if (code !== 0) {
        previous = code
        space -= 32768 >> code
      }
      continue
    }
    const extraBits = code === 16 ? 2 : 3
    const length = code === 16 ? previous : 0
    if (repeatLength !== length) {
      repeat = 0
      repeatLength = length
    }
    const before = repeat
    if (repeat > 0) repeat = (repeat - 2) << extraBits
    repeat += reader.read(extraBits) + 3
    const delta = repeat - before
    if (symbol + delta > alphabetSize) throw new Error('brotli: 符号の長さの繰り返しが不正です')
    lengths.fill(length, symbol, symbol + delta)
    symbol += delta
    if (length !== 0) space -= delta << (15 - length)
  }
  if (space !== 0) throw new Error('brotli: 符号の長さが不正です')
  return huffman(lengths)
}

// ---- 数の読み方

/** 1〜256 の数（NBLTYPES・NTREES は + 1 して使う） */
function readVarLenUint8(reader: BitReader): number {
  if (reader.read(1) === 0) return 0
  const n = reader.read(3)
  return n === 0 ? 1 : (1 << n) + reader.read(n)
}

const BLOCK_LENGTH_OFFSET = [
  1, 5, 9, 13, 17, 25, 33, 41, 49, 65, 81, 97, 113, 145, 177, 209, 241, 305, 369, 497, 753, 1265, 2289, 4337, 8433, 16625,
]
const BLOCK_LENGTH_BITS = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 7, 8, 9, 10, 11, 12, 13, 24]

function readBlockLength(reader: BitReader, table: Huffman): number {
  const code = decodeSymbol(reader, table)
  return BLOCK_LENGTH_OFFSET[code] + reader.read(BLOCK_LENGTH_BITS[code])
}

const INSERT_BASE = [0, 1, 2, 3, 4, 5, 6, 8, 10, 14, 18, 26, 34, 50, 66, 98, 130, 194, 322, 578, 1090, 2114, 6210, 22594]
const INSERT_BITS = [0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 12, 14, 24]
const COPY_BASE = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 18, 22, 30, 38, 54, 70, 102, 134, 198, 326, 582, 1094, 2118]
const COPY_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 24]
/** 挿入と複写の長さの記号の 64 ごとの区切りの、挿入の長さの符号・複写の長さの符号の始まり（RFC 7932 5） */
const CELL_INSERT = [0, 0, 0, 0, 8, 8, 0, 16, 8, 16, 16]
const CELL_COPY = [0, 8, 0, 8, 0, 8, 16, 0, 16, 8, 16]

// ---- 文脈（直前の 2 バイトから、字の符号を選ぶ）

const UTF8_LUT0 = new Uint8Array(256)
const UTF8_LUT1 = new Uint8Array(256)
const SIGNED_LUT = new Uint8Array(256)
{
  const ascii0 = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    8, 12, 16, 12, 12, 20, 12, 16, 24, 28, 12, 12, 32, 12, 36, 12, 44, 44, 44, 44, 44, 44, 44, 44, 44, 44, 32, 32, 24, 40, 28, 12,
    12, 48, 52, 52, 52, 48, 52, 52, 52, 48, 52, 52, 52, 52, 52, 48, 52, 52, 52, 52, 52, 48, 52, 52, 52, 52, 52, 24, 12, 28, 12, 12,
    12, 56, 60, 60, 60, 56, 60, 60, 60, 56, 60, 60, 60, 60, 60, 56, 60, 60, 60, 60, 60, 56, 60, 60, 60, 60, 60, 24, 12, 28, 12, 0,
  ]
  const ascii1 = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1,
    1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1,
    1, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 1, 1, 1, 1, 0,
  ]
  for (let i = 0; i < 256; i++) {
    UTF8_LUT0[i] = i < 128 ? ascii0[i] : i < 192 ? i & 1 : 2 + (i & 1)
    UTF8_LUT1[i] = i < 128 ? ascii1[i] : i < 224 ? 0 : 2
    SIGNED_LUT[i] = i === 0 ? 0 : i < 16 ? 1 : i < 64 ? 2 : i < 128 ? 3 : i < 192 ? 4 : i < 240 ? 5 : i < 255 ? 6 : 7
  }
}

function literalContext(mode: number, p1: number, p2: number): number {
  if (mode === 0) return p1 & 0x3f
  if (mode === 1) return p1 >> 2
  if (mode === 2) return UTF8_LUT0[p1] | UTF8_LUT1[p2]
  return (SIGNED_LUT[p1] << 3) | SIGNED_LUT[p2]
}

function readContextMap(reader: BitReader, size: number, trees: number): Uint8Array {
  const map = new Uint8Array(size)
  if (trees < 2) return map
  const rleMax = reader.read(1) === 1 ? reader.read(4) + 1 : 0
  const table = readHuffman(reader, trees + rleMax)
  for (let i = 0; i < size; ) {
    const code = decodeSymbol(reader, table)
    if (code === 0) {
      map[i++] = 0
    } else if (code <= rleMax) {
      const repeat = (1 << code) + reader.read(code)
      if (i + repeat > size) throw new Error('brotli: 文脈の対応が不正です')
      i += repeat // 0 で埋まっている
    } else {
      map[i++] = code - rleMax
    }
  }
  if (reader.read(1) === 1) {
    // 前へ移す変換（move-to-front）を戻す。項目は 1 万を超えることがあり、見出しごとに通るので、並びはバイト列をずらして動かす
    const order = Uint8Array.from({ length: 256 }, (_, i) => i)
    for (let i = 0; i < size; i++) {
      const index = map[i]
      const value = order[index]
      map[i] = value
      if (index > 0) {
        order.copyWithin(1, 0, index)
        order[0] = value
      }
    }
  }
  return map
}

// ---- ブロックの種類の切り替え

type BlockCategory = {
  types: number
  typeTable: Huffman | null
  lengthTable: Huffman | null
  /** 今のブロックの残りの数 */
  left: number
  current: number
  previous: number
}

function readBlockCategory(reader: BitReader): BlockCategory {
  const types = readVarLenUint8(reader) + 1
  // 種類が 1 つなら切り替えは起きない（残りの数を数え切らないよう、無限大にしておく）
  if (types < 2) return { types, typeTable: null, lengthTable: null, left: Infinity, current: 0, previous: 1 }
  const typeTable = readHuffman(reader, types + 2)
  const lengthTable = readHuffman(reader, 26)
  return { types, typeTable, lengthTable, left: readBlockLength(reader, lengthTable), current: 0, previous: 1 }
}

function switchBlock(reader: BitReader, category: BlockCategory): void {
  const code = decodeSymbol(reader, category.typeTable!)
  let next = code === 0 ? category.previous : code === 1 ? category.current + 1 : code - 2
  if (next >= category.types) next -= category.types
  category.previous = category.current
  category.current = next
  category.left = readBlockLength(reader, category.lengthTable!)
}

// ---- 辞書

let dictionary: Uint8Array | null = null
function staticDictionary(): Uint8Array {
  if (dictionary) return dictionary
  const binary = atob(DICTIONARY_ZLIB_BASE64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  dictionary = inflateZlib(bytes, DICTIONARY_SIZE)
  return dictionary
}

/** 語の長さ（4〜24）ごとの、辞書の中の始まりと語の数のビット数 */
const DICTIONARY_OFFSETS = [
  0, 0, 0, 0, 0, 4096, 9216, 21504, 35840, 44032, 53248, 63488, 74752, 87040, 93696, 100864, 104704, 106752, 108928, 113536,
  115968, 118528, 119872, 121280, 122016,
]
const DICTIONARY_SIZE_BITS = [0, 0, 0, 0, 10, 10, 11, 11, 10, 10, 10, 10, 10, 9, 9, 8, 7, 7, 8, 7, 7, 6, 6, 5, 5]

/** 大文字にする（RFC 7932 の付録 B の簡単な規則）。進めたバイト数を返す */
function toUpper(bytes: Uint8Array, at: number, end: number): number {
  const byte = bytes[at]
  if (byte < 0xc0) {
    if (byte >= 97 && byte <= 122) bytes[at] ^= 32
    return 1
  }
  if (byte < 0xe0) {
    if (at + 1 < end) bytes[at + 1] ^= 32
    return 2
  }
  if (at + 2 < end) bytes[at + 2] ^= 5
  return 3
}

/** 辞書の語を変換して out の at から書く。書いたバイト数を返す（out に入りきらなければ例外） */
function writeDictionaryWord(out: Uint8Array, at: number, copyLength: number, wordId: number): number {
  const sizeBits = DICTIONARY_SIZE_BITS[copyLength]
  const index = wordId & ((1 << sizeBits) - 1)
  const transformId = wordId >> sizeBits
  if (transformId >= TRANSFORMS.length) throw new Error('brotli: 辞書の参照が不正です')
  const [prefix, kind, suffix] = TRANSFORMS[transformId]
  const dict = staticDictionary()
  let start = DICTIONARY_OFFSETS[copyLength] + index * copyLength
  let length = copyLength
  if (kind >= 12) {
    const omit = Math.min(kind - 11, length)
    start += omit
    length -= omit
  } else if (kind >= 1 && kind <= 9) {
    length = Math.max(0, length - kind)
  }
  if (at + prefix.length + length + suffix.length > out.length) throw new Error('brotli: 大きすぎます')
  let pos = at
  for (let i = 0; i < prefix.length; i++) out[pos++] = prefix.charCodeAt(i)
  const wordAt = pos
  for (let i = 0; i < length; i++) out[pos++] = dict[start + i]
  if (kind === 10) {
    if (length > 0) toUpper(out, wordAt, pos)
  } else if (kind === 11) {
    for (let i = wordAt; i < pos; ) i += toUpper(out, i, pos)
  }
  for (let i = 0; i < suffix.length; i++) out[pos++] = suffix.charCodeAt(i)
  return pos - at
}

// ---- 展開

/**
 * Brotli のバイト列を展開する。expected は展開した大きさ。それより長くなる・短く終わる・壊れているときは例外を投げる
 */
export function brotliDecompress(data: Uint8Array, expected: number): Uint8Array {
  const reader = new BitReader(data)
  const out = new Uint8Array(expected)
  let pos = 0

  // 窓の大きさ（WBITS）
  let windowBits = 16
  if (reader.read(1) === 1) {
    const n = reader.read(3)
    if (n !== 0) windowBits = 17 + n
    else {
      const m = reader.read(3)
      if (m === 1) throw new Error('brotli: 大きな窓には対応していません')
      windowBits = m === 0 ? 17 : 8 + m
    }
  }
  const maxBackward = (1 << windowBits) - 16
  // 直前の 4 つの距離（distances[3] がいちばん新しい）
  const distances = [16, 15, 11, 4]

  for (let last = 0; last === 0; ) {
    last = reader.read(1)
    if (last === 1 && reader.read(1) === 1) break // 空の最後のブロック
    const nibbles = reader.read(2)
    if (nibbles === 3) {
      // メタデータ（読み飛ばす）
      if (reader.read(1) !== 0) throw new Error('brotli: 予約されたビットが 0 でありません')
      const skipBytes = reader.read(2)
      let skipLength = 0
      for (let i = 0; i < skipBytes; i++) skipLength |= reader.read(8) << (i * 8)
      if (skipBytes > 0) skipLength++
      reader.align()
      for (let i = 0; i < skipLength; i++) reader.read(8)
      continue
    }
    let length = 0
    for (let i = 0; i < nibbles + 4; i++) length |= reader.read(4) << (i * 4)
    length += 1
    const end = pos + length
    if (end > expected) throw new Error('brotli: 大きすぎます')
    if (last === 0 && reader.read(1) === 1) {
      // 圧縮していないブロック
      reader.align()
      for (; pos < end; pos++) out[pos] = reader.read(8)
      continue
    }

    const literalBlocks = readBlockCategory(reader)
    const commandBlocks = readBlockCategory(reader)
    const distanceBlocks = readBlockCategory(reader)
    const postfix = reader.read(2)
    const direct = reader.read(4) << postfix
    const postfixMask = (1 << postfix) - 1
    const modes = new Uint8Array(literalBlocks.types)
    for (let i = 0; i < modes.length; i++) modes[i] = reader.read(2)
    const literalTrees = readVarLenUint8(reader) + 1
    const literalMap = readContextMap(reader, 64 * literalBlocks.types, literalTrees)
    const distanceTrees = readVarLenUint8(reader) + 1
    const distanceMap = readContextMap(reader, 4 * distanceBlocks.types, distanceTrees)
    const literalTables = Array.from({ length: literalTrees }, () => readHuffman(reader, 256))
    const commandTables = Array.from({ length: commandBlocks.types }, () => readHuffman(reader, 704))
    const distanceAlphabet = 16 + direct + (48 << postfix)
    const distanceTables = Array.from({ length: distanceTrees }, () => readHuffman(reader, distanceAlphabet))

    while (pos < end) {
      if (commandBlocks.left === 0) switchBlock(reader, commandBlocks)
      commandBlocks.left--
      const command = decodeSymbol(reader, commandTables[commandBlocks.current])
      const cell = command >> 6
      const insertCode = CELL_INSERT[cell] + ((command >> 3) & 7)
      const copyCode = CELL_COPY[cell] + (command & 7)
      const insertLength = INSERT_BASE[insertCode] + reader.read(INSERT_BITS[insertCode])
      const copyLength = COPY_BASE[copyCode] + reader.read(COPY_BITS[copyCode])
      if (pos + insertLength > end) throw new Error('brotli: 挿入の長さが不正です')
      for (let i = 0; i < insertLength; i++) {
        if (literalBlocks.left === 0) switchBlock(reader, literalBlocks)
        literalBlocks.left--
        const p1 = pos > 0 ? out[pos - 1] : 0
        const p2 = pos > 1 ? out[pos - 2] : 0
        const context = literalContext(modes[literalBlocks.current], p1, p2)
        out[pos++] = decodeSymbol(reader, literalTables[literalMap[64 * literalBlocks.current + context]])
      }
      if (pos >= end) break

      let distance: number
      let distanceCode = 0
      if (cell < 2) {
        distance = distances[3]
      } else {
        if (distanceBlocks.left === 0) switchBlock(reader, distanceBlocks)
        distanceBlocks.left--
        const context = copyLength > 4 ? 3 : copyLength - 2
        distanceCode = decodeSymbol(reader, distanceTables[distanceMap[4 * distanceBlocks.current + context]])
        if (distanceCode < 16) {
          if (distanceCode < 4) distance = distances[3 - distanceCode]
          else {
            const base = distanceCode < 10 ? distances[3] : distances[2]
            const k = (distanceCode - (distanceCode < 10 ? 4 : 10))
            const delta = (k >> 1) + 1
            distance = k & 1 ? base + delta : base - delta
          }
          if (distance <= 0) throw new Error('brotli: 距離が不正です')
        } else if (distanceCode < 16 + direct) {
          distance = distanceCode - 15
        } else {
          const code = distanceCode - direct - 16
          const bits = 1 + (code >> (postfix + 1))
          const extra = reader.read(bits)
          const high = code >> postfix
          const offset = ((2 + (high & 1)) << bits) - 4
          distance = ((offset + extra) << postfix) + (code & postfixMask) + direct + 1
        }
      }

      const maxDistance = Math.min(maxBackward, pos)
      if (distance > maxDistance) {
        // 辞書の参照（直前の距離には入れない）
        if (copyLength < 4 || copyLength > 24) throw new Error('brotli: 辞書の参照の長さが不正です')
        pos += writeDictionaryWord(out, pos, copyLength, distance - maxDistance - 1)
        if (pos > end) throw new Error('brotli: ブロックの長さを超えました')
        continue
      }
      if (distanceCode !== 0) {
        distances.shift()
        distances.push(distance)
      }
      if (pos + copyLength > end) throw new Error('brotli: 複写の長さが不正です')
      for (let i = 0; i < copyLength; i++, pos++) out[pos] = out[pos - distance]
    }
    if (pos !== end) throw new Error('brotli: ブロックの長さが合いません')
  }
  reader.checkEnd()
  if (pos !== expected) throw new Error('brotli: 大きさが合いません')
  return out
}
