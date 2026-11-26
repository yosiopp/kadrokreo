import { brotliCompressSync, constants } from 'node:zlib'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { brotliDecompress } from './brotli.ts'
import { type ImageInfo, readImageInfo } from './imageInfo.ts'
import { inflateZlib } from './inflate.ts'
import { TarError, readTar, tarParts } from './tar.ts'
import { testFontBytes } from './testFont.ts'
import { BitWriter, type Random, allowThrow, corrupt, fuzz, fuzzAsync, mutate, plainError } from './testFuzz.ts'

// 自前のデコーダ（zlib・Brotli・tar・画像の見出し）のファズテスト。kdr と書体は外から受け取ったファイルなので、どんなバイト列でも
// 「決めた例外になる」か「決めた大きさの結果を返す」かのどちらかで、入力の大きさに見合った時間で終わることを確かめる。
// 入力は、正しいデータを少し壊したもの（testFuzz.ts の mutate）、形式の決まりに沿って欄だけ乱数にしたもの、まったくの乱数の 3 通り。
// 書体の表（OpenType・WOFF・WOFF2）は fontFuzz.test.ts。

// 手元では 1 本あたり 0.5 秒以内。CI の遅い環境でも時間切れにならないよう、上限を延ばしておく
vi.setConfig({ testTimeout: 30_000 })

const text = new TextEncoder().encode(
  'The quick brown fox jumps over the lazy dog. Information about the Development of International Government. ' +
    '日本語の文章も混ぜる。書体ファイルを kdr に埋め込む。\n'.repeat(12),
)
const table = Uint8Array.from({ length: 3000 }, (_, i) => (i % 2 === 0 ? (i >> 5) & 0xff : (i * 7) & 0xff))
const noise = Uint8Array.from({ length: 1500 }, (_, i) => (Math.imul(i + 1, 2654435761) >>> 24) & 0xff)
const samples: Uint8Array<ArrayBuffer>[] = [new Uint8Array(0), new TextEncoder().encode('abc'), text, table, noise, testFontBytes()]

/** 壊した入力に渡す「展開した大きさ」。たいていは正しい値、ときどき違う値 */
function expectedSize(random: Random, correct: number): number {
  return random.chance(0.8) ? correct : random.pick([0, 1, Math.max(0, correct - 1), correct + 1, random.int(0, 5000)])
}

describe('inflateZlib のファズ', () => {
  const seeds: { size: number; compressed: Uint8Array }[] = []
  beforeAll(async () => {
    for (const data of samples) {
      const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'))
      seeds.push({ size: data.length, compressed: new Uint8Array(await new Response(stream).arrayBuffer()) })
      if (data.length > 0xffff) continue
      // 格納だけのブロック（adler32 は読まないので 0）
      const n = data.length
      seeds.push({ size: n, compressed: Uint8Array.from([0x78, 0x01, 0x01, n & 0xff, n >> 8, ~n & 0xff, (~n >> 8) & 0xff, ...data, 0, 0, 0, 0]) })
    }
  })

  const check = (input: Uint8Array, expected: number) => {
    const out = allowThrow(() => inflateZlib(input, expected), plainError('inflate: '))
    if (out !== undefined) expect(out.length).toBe(expected)
  }

  it('壊していない入力は元の大きさに戻る', () => {
    for (const seed of seeds) expect(inflateZlib(seed.compressed, seed.size)).toHaveLength(seed.size)
  })

  it('正しい圧縮データを壊しても、決めた例外か決めた大きさの結果になる', () => {
    fuzz({ seed: 10_000, cases: 1500 }, (random) => {
      const seed = random.pick(seeds)
      check(mutate(random, seed.compressed), expectedSize(random, seed.size))
    })
  })

  it('乱数のバイト列（zlib の見出しだけ正しいものも）でも同じ', () => {
    fuzz({ seed: 20_000, cases: 1500 }, (random) => {
      const body = random.bytes(random.int(0, 300))
      // ブロックの種類（先頭の 3 ビット）は、格納・固定・動的のどれにも入るようにする
      const input = random.chance(0.8) ? Uint8Array.from([0x78, random.pick([0x01, 0x5e, 0x9c, 0xda]), ...body]) : body
      check(input, random.int(0, 4000))
    })
  })
})

// ---- Brotli

function brotli(data: Uint8Array, quality: number, window: number, mode: number): Uint8Array {
  return brotliCompressSync(data, {
    params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_LGWIN]: window, [constants.BROTLI_PARAM_MODE]: mode },
  })
}

function bitWidth(alphabetSize: number): number {
  let bits = 0
  while (1 << bits < alphabetSize) bits++
  return bits
}

/** 単純な符号（記号を 1〜4 個並べたもの）。記号はたまに重なる・範囲を外れる */
function writeSimpleCode(writer: BitWriter, random: Random, alphabetSize: number, count = random.int(1, 4)): void {
  const width = bitWidth(alphabetSize)
  writer.write(1, 2).write(count - 1, 2)
  for (let i = 0; i < count; i++) writer.write(random.chance(0.97) ? random.int(0, alphabetSize - 1) : random.int(0, (1 << width) - 1), width)
  if (count === 4) writer.write(random.int(0, 1), 1)
}

/** 1〜256 の数（ブロックの種類の数・符号の数）から 1 を引いた値 */
function writeVarLen(writer: BitWriter, value: number): void {
  if (value === 0) {
    writer.write(0, 1)
    return
  }
  const bits = 31 - Math.clz32(value)
  writer.write(1, 1).write(bits, 3).write(value - (1 << bits), bits)
}

/** ブロックの種類が 1 つなら 1 ビット。2 つ以上なら、種類の符号・長さの符号（記号 1 つ）・最初のブロックの長さ */
function writeBlockCategory(writer: BitWriter, random: Random): number {
  const types = random.chance(0.75) ? 1 : random.pick([2, 3, 16, 255, 256])
  writeVarLen(writer, types - 1)
  if (types >= 2) {
    writeSimpleCode(writer, random, types + 2)
    writeSimpleCode(writer, random, 26, 1)
    writer.write(random.int(0, 0xffffff), 24) // 長さの余りのビット（符号によって使う数が違う）
  }
  return types
}

/** 文脈の対応。符号が 2 つ以上なら、記号 1 つの符号（どの項目も 0 ビット）で書く */
function writeContextMap(writer: BitWriter, random: Random): number {
  const trees = random.chance(0.75) ? 1 : random.pick([2, 3, 64, 256])
  writeVarLen(writer, trees - 1)
  if (trees >= 2) {
    const rle = random.chance(0.3)
    writer.write(rle ? 1 : 0, 1)
    if (rle) writer.write(random.int(0, 15), 4)
    writeSimpleCode(writer, random, trees + (rle ? 16 : 0), random.pick([1, 1, 2]))
    writer.write(random.int(0, 1), 1) // 前へ移す変換
  }
  return trees
}

/**
 * Brotli の並びに沿って、欄の値だけを乱数にしたバイト列。見出し（窓・ブロックの長さ・種類の数・符号）までは形式どおりに進むので、
 * バイトを壊すだけでは届きにくい、命令の並びを読む所まで試せる
 */
function structuredBrotli(random: Random): { bytes: Uint8Array; expected: number } {
  const writer = new BitWriter()
  const window = random.int(0, 2)
  if (window === 0) writer.write(0, 1)
  else if (window === 1) writer.write(1, 1).write(random.int(1, 7), 3)
  else writer.write(1, 1).write(0, 3).write(random.int(0, 7), 3)

  let expected = 0
  const blocks = random.int(1, 3)
  for (let block = 0; block < blocks; block++) {
    const last = block === blocks - 1 && random.chance(0.8)
    writer.write(last ? 1 : 0, 1)
    if (last) writer.write(random.chance(0.05) ? 1 : 0, 1)
    if (random.chance(0.08)) {
      // 読み飛ばすメタデータ
      const skipBytes = random.int(0, 3)
      writer.write(3, 2).write(0, 1).write(skipBytes, 2)
      for (let i = 0; i < skipBytes; i++) writer.write(random.pick([0, 1, 7, 0xff]), 8)
      writer.flush()
      for (const byte of random.bytes(random.int(0, 12))) writer.write(byte, 8)
      continue
    }
    const length = random.chance(0.9) ? random.int(1, 300) : random.pick([1, 0x10000])
    writer.write(0, 2).write(length - 1, 16)
    expected += length
    if (!last) {
      const stored = random.chance(0.15)
      writer.write(stored ? 1 : 0, 1)
      if (stored) {
        writer.flush()
        for (const byte of random.bytes(Math.min(length, random.int(0, 320)))) writer.write(byte, 8)
        continue
      }
    }
    const literalTypes = writeBlockCategory(writer, random)
    const commandTypes = writeBlockCategory(writer, random)
    writeBlockCategory(writer, random)
    const postfix = random.int(0, 3)
    const direct = random.int(0, 15)
    writer.write(postfix, 2).write(direct, 4)
    for (let i = 0; i < literalTypes; i++) writer.write(random.int(0, 3), 2)
    const literalTrees = writeContextMap(writer, random)
    const distanceTrees = writeContextMap(writer, random)
    for (let i = 0; i < literalTrees; i++) writeSimpleCode(writer, random, 256)
    for (let i = 0; i < commandTypes; i++) writeSimpleCode(writer, random, 704)
    for (let i = 0; i < distanceTrees; i++) writeSimpleCode(writer, random, 16 + (direct << postfix) + (48 << postfix))
    // 命令の並び（挿入と複写の長さ・字・距離）は乱数のまま
    for (const byte of random.bytes(random.int(0, 40))) writer.write(byte, 8)
  }
  return { bytes: writer.bytes(), expected: random.chance(0.7) ? expected : random.int(0, 70_000) }
}

describe('brotliDecompress のファズ', () => {
  const seeds: { size: number; compressed: Uint8Array }[] = []
  beforeAll(() => {
    for (const data of samples) {
      for (const [quality, window, mode] of [
        [0, 16, constants.BROTLI_MODE_GENERIC],
        [5, 10, constants.BROTLI_MODE_TEXT],
        [9, 22, constants.BROTLI_MODE_FONT],
        [11, 24, constants.BROTLI_MODE_GENERIC],
      ]) {
        seeds.push({ size: data.length, compressed: brotli(data, quality, window, mode) })
      }
    }
  })

  const check = (input: Uint8Array, expected: number) => {
    const out = allowThrow(() => brotliDecompress(input, expected), plainError('brotli: '))
    if (out !== undefined) expect(out.length).toBe(expected)
  }

  it('正しい圧縮データを壊しても、決めた例外か決めた大きさの結果になる', () => {
    fuzz({ seed: 30_000, cases: 1500 }, (random) => {
      const seed = random.pick(seeds)
      check(mutate(random, seed.compressed), expectedSize(random, seed.size))
    })
  })

  it('形式に沿って欄だけ乱数にした入力でも同じ', () => {
    fuzz({ seed: 40_000, cases: 2500 }, (random) => {
      const { bytes, expected } = structuredBrotli(random)
      check(random.chance(0.2) ? mutate(random, bytes) : bytes, expected)
    })
  })

  it('乱数のバイト列でも同じ', () => {
    fuzz({ seed: 50_000, cases: 1500 }, (random) => {
      check(random.bytes(random.int(0, 200)), random.int(0, 4000))
    })
  })
})

// ---- tar

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** 見出しのチェックサムを中身に合わせて書き直す（見出しの欄を壊したあと、その先の検査まで進ませる） */
function fixChecksum(tar: Uint8Array, header: number): void {
  if (header + 512 > tar.length) return
  let sum = 0
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : tar[header + i]
  const text = sum.toString(8).padStart(6, '0') + '\0 '
  for (let i = 0; i < 8; i++) tar[header + 148 + i] = text.charCodeAt(i)
}

/** tar の見出しの欄（始まりと長さ）: 名前・mode・大きさ・チェックサム・種類・magic・prefix */
const TAR_FIELDS: readonly (readonly [number, number])[] = [[0, 100], [100, 8], [124, 12], [148, 8], [156, 1], [257, 8], [345, 155]]
const TAR_SIZES = ['00000000000\0', '77777777777\0', '777777777777', '00000001000\0', '        7\0  ', '\x80\0\0\0\0\0\0\0\0\0\x10\0', '-0000000001\0']

class Rejected extends Error {}

describe('readTar のファズ', () => {
  const run = async (random: Random, tar: Uint8Array) => {
    // 細切れにして渡す（空の断片も混ぜる）
    let at = 0
    const next = async (): Promise<Uint8Array | null> => {
      if (at >= tar.length) return null
      const chunk = tar.subarray(at, at + random.pick([0, 1, 7, 512, 513, 700, 4096]))
      at += chunk.length
      return chunk
    }
    const limit = random.pick([1 << 20, Infinity])
    const sizes: number[] = []
    const check = (_name: string, size: number) => {
      if (size > limit) throw new Rejected('大きすぎます')
      sizes.push(size)
    }
    let entries
    try {
      entries = await readTar(next, check)
    } catch (error) {
      if (error instanceof TarError || error instanceof Rejected) return
      throw error
    }
    // 読めたなら、中身は check に渡した大きさどおりで、入力より多くは出てこない
    expect(entries.map((entry) => entry.bytes.length)).toEqual(sizes)
    expect(sizes.reduce((total, size) => total + size, 0)).toBeLessThanOrEqual(tar.length)
  }

  const validTar = (random: Random): { tar: Uint8Array<ArrayBuffer>; headers: number[] } => {
    const headers: number[] = []
    let offset = 0
    const entries = Array.from({ length: random.int(0, 3) }, (_, i) => {
      const bytes = random.bytes(random.pick([0, 1, 511, 512, 513, 1200]))
      headers.push(offset)
      offset += 512 + Math.ceil(bytes.length / 512) * 512
      return { name: random.pick(['document.json', `assets/${i}.png`, 'a'.repeat(100)]), bytes }
    })
    return { tar: concat(tarParts(entries)), headers }
  }

  it('壊していない tar は読める', async () => {
    await fuzzAsync({ seed: 60_000, cases: 50 }, async (random) => {
      const { tar, headers } = validTar(random)
      let done = false
      const entries = await readTar(async () => (done ? null : ((done = true), tar)), () => {})
      expect(entries).toHaveLength(headers.length)
    })
  })

  it('正しい tar を壊しても、TarError か中身の揃った結果になる', async () => {
    await fuzzAsync({ seed: 70_000, cases: 1200 }, async (random) => {
      const { tar, headers } = validTar(random)
      if (headers.length === 0 || random.chance(0.4)) return run(random, mutate(random, tar))
      // 見出しの欄を壊す。たいていはチェックサムを合わせ直して、その先まで読ませる
      const header = random.pick(headers)
      for (let round = random.int(1, 3); round > 0; round--) {
        const [start, length] = random.pick(TAR_FIELDS)
        if (start === 124 && random.chance(0.5)) {
          const size = random.pick(TAR_SIZES)
          for (let i = 0; i < 12; i++) tar[header + 124 + i] = size.charCodeAt(i)
        } else corrupt(random, tar, header + start, header + start + length)
      }
      if (random.chance(0.8)) fixChecksum(tar, header)
      return run(random, random.chance(0.2) ? tar.subarray(0, random.int(0, tar.length)) : tar)
    })
  })

  it('乱数のブロックでも同じ', async () => {
    await fuzzAsync({ seed: 80_000, cases: 300 }, async (random) => {
      const tar = random.bytes(random.pick([0, 100, 512, 1024, 1536]))
      if (random.chance(0.5)) fixChecksum(tar, 0)
      await run(random, tar)
    })
  })
})

// ---- 画像の見出し

const ascii = (value: string) => [...value].map((char) => char.charCodeAt(0))

const IMAGES: readonly { bytes: Uint8Array; info: ImageInfo }[] = [
  {
    bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...ascii('IHDR'), 0, 0, 1, 0x40, 0, 0, 0, 0xf0, 8, 6, 0, 0, 0]),
    info: { mime: 'image/png', width: 320, height: 240 },
  },
  { bytes: Uint8Array.from([...ascii('GIF89a'), 0x40, 1, 0xf0, 0, 0x80, 0, 0]), info: { mime: 'image/gif', width: 320, height: 240 } },
  {
    bytes: Uint8Array.from([...ascii('RIFF'), 22, 0, 0, 0, ...ascii('WEBPVP8 '), 10, 0, 0, 0, 0x30, 1, 0, 0x9d, 1, 0x2a, 0x40, 1, 0xf0, 0]),
    info: { mime: 'image/webp', width: 320, height: 240 },
  },
  {
    // VP8L: 幅 - 1 と高さ - 1 を 14 ビットずつ（319 と 239）
    bytes: Uint8Array.from([...ascii('RIFF'), 22, 0, 0, 0, ...ascii('WEBPVP8L'), 10, 0, 0, 0, 0x2f, 0x3f, 0xc1, 0x3b, 0, 0, 0, 0, 0, 0]),
    info: { mime: 'image/webp', width: 320, height: 240 },
  },
  {
    bytes: Uint8Array.from([...ascii('RIFF'), 22, 0, 0, 0, ...ascii('WEBPVP8X'), 10, 0, 0, 0, 0, 0, 0, 0, 0x3f, 1, 0, 0xef, 0, 0]),
    info: { mime: 'image/webp', width: 320, height: 240 },
  },
  {
    bytes: Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0, 16, ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xff, 0xdb, 0, 4, 0, 0,
      0xff, 0xc0, 0, 11, 8, 0, 0xf0, 1, 0x40, 1, 1, 0x11, 0, 0xff, 0xd9,
    ]),
    info: { mime: 'image/jpeg', width: 320, height: 240 },
  },
]
const IMAGE_MIMES = new Set(['image/png', 'image/gif', 'image/webp', 'image/jpeg'])

describe('readImageInfo のファズ', () => {
  const check = (bytes: Uint8Array) => {
    const info = readImageInfo(bytes)
    if (info === null) return
    expect(IMAGE_MIMES.has(info.mime)).toBe(true)
    for (const side of [info.width, info.height]) expect(Number.isInteger(side) && side >= 0 && side <= 0xffffffff).toBe(true)
  }

  it('壊していない見出しは種類と大きさが読める', () => {
    for (const image of IMAGES) expect(readImageInfo(image.bytes)).toEqual(image.info)
  })

  it('どこで切れていても、null か種類と大きさになる', () => {
    for (const image of IMAGES) {
      for (let length = 0; length <= image.bytes.length; length++) {
        check(image.bytes.subarray(0, length))
        // 別の配列の途中から始まるバイト列（byteOffset が 0 でない）でも同じ
        check(Uint8Array.from([0xff, ...image.bytes]).subarray(1, 1 + length))
      }
    }
  })

  it('正しい見出しを壊しても、乱数のバイト列でも同じ', () => {
    fuzz({ seed: 90_000, cases: 3000 }, (random) => {
      const image = random.pick(IMAGES).bytes
      if (random.chance(0.7)) return check(mutate(random, image))
      // 先頭の印だけ正しい乱数
      const body = random.bytes(random.int(0, 64))
      body.set(image.subarray(0, Math.min(body.length, random.pick([0, 2, 4, 6, 12, 16]))))
      check(body)
    })
  })
})
