import { describe, expect, it } from 'vitest'
import { MAX_DECODED_PIXELS } from '../document/imageInfo.ts'
import { pngHeader } from '../document/testKdr.ts'
import { decodablePixels } from './images.ts'

describe('decodablePixels', () => {
  it('見出しの大きさが読めて上限に収まる画像だけ、画素数を返す', () => {
    expect(decodablePixels(pngHeader(40, 20), 0)).toBe(800)
    // 大きさの読めない画像・1 枚の上限を超える画像はデコードしない
    expect(decodablePixels(new Uint8Array([1, 2, 3]), 0)).toBeNull()
    expect(decodablePixels(pngHeader(8001, 8000), 0)).toBeNull()
  })

  it('デコード済みの画素数との合計が上限を超えるならデコードしない', () => {
    expect(decodablePixels(pngHeader(8000, 8000), MAX_DECODED_PIXELS - 64_000_000)).toBe(64_000_000)
    expect(decodablePixels(pngHeader(8000, 8000), MAX_DECODED_PIXELS - 63_999_999)).toBeNull()
  })
})
