import { brotliCompressSync, constants } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { brotliDecompress } from './brotli.ts'
import { DICTIONARY_SIZE, DICTIONARY_ZLIB_BASE64 } from './brotliDictionary.ts'
import { inflateZlib } from './inflate.ts'
import { sha256Hex } from './sha256.ts'
import { testFontBytes } from './testFont.ts'

function compress(data: Uint8Array, quality: number, window = 22, mode = constants.BROTLI_MODE_GENERIC): Uint8Array {
  return brotliCompressSync(data, {
    params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_LGWIN]: window, [constants.BROTLI_PARAM_MODE]: mode },
  })
}

/** 決まった並びの疑似乱数のバイト列 */
function noise(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length)
  let x = seed
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    out[i] = x >>> 24
  }
  return out
}

const english = new TextEncoder().encode(
  'The quick brown fox jumps over the lazy dog. This is the time of the year when People are Thinking about THE FUTURE, ' +
    'the international community and the government. 日本語の文章も混ぜる。書体ファイルを kdr に埋め込む。\n'.repeat(40),
)
/** 字の形のような、規則のある 2 バイトの並び（書体の表に近い） */
const tableLike = new Uint8Array(Array.from({ length: 60_000 }, (_, i) => (i % 2 === 0 ? (i >> 9) & 0xff : (i * 7) & 0xff)))

describe('brotliDecompress', () => {
  it('Node の Brotli で圧縮したものを、品質・窓の大きさ・種類を変えても元に戻す', () => {
    const inputs = [new Uint8Array(0), new Uint8Array([65]), english, noise(10_000), tableLike, testFontBytes()]
    for (const data of inputs) {
      for (const quality of [0, 1, 5, 9, 11]) {
        for (const window of [10, 16, 24]) {
          for (const mode of [constants.BROTLI_MODE_GENERIC, constants.BROTLI_MODE_TEXT, constants.BROTLI_MODE_FONT]) {
            expect(brotliDecompress(compress(data, quality, window, mode), data.length)).toEqual(data)
          }
        }
      }
    }
    // 圧縮（品質 11）が遅いので、遅い環境でも収まるよう上限を延ばす
  }, 30_000)

  it('辞書の語を変換して使う（英語の文章）', () => {
    const data = new TextEncoder().encode('Information about the Development of International Government, and THE COMMUNITY. ')
    expect(new TextDecoder().decode(brotliDecompress(compress(data, 11), data.length))).toBe(new TextDecoder().decode(data))
  })

  it('辞書は RFC 7932 のもの', () => {
    const binary = atob(DICTIONARY_ZLIB_BASE64)
    const dictionary = inflateZlib(Uint8Array.from(binary, (char) => char.charCodeAt(0)), DICTIONARY_SIZE)
    expect(sha256Hex(dictionary)).toBe('20e42eb1b511c21806d4d227d07e5dd06877d8ce7b3a817f378f313653f35c70')
  })

  it('大きさが合わない・途中で切れている・壊れているときは例外', () => {
    const compressed = compress(english, 9)
    expect(() => brotliDecompress(compressed, english.length - 1)).toThrow()
    expect(() => brotliDecompress(compressed, english.length + 1)).toThrow()
    expect(() => brotliDecompress(compressed.subarray(0, compressed.length >> 1), english.length)).toThrow()
    for (let i = 0; i < 200; i++) {
      const broken = compressed.slice()
      broken[(i * 37) % broken.length] ^= 1 << (i % 8)
      try {
        // 壊れ方によっては別の中身として読めることもあるが、決めた大きさは超えない
        expect(brotliDecompress(broken, english.length)).toHaveLength(english.length)
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
      }
    }
  })
})
