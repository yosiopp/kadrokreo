import { describe, expect, it } from 'vitest'
import { MAX_IMAGE_PIXELS, isImageTooLarge, readImageInfo } from './imageInfo.ts'
import { pngHeader } from './testKdr.ts'

/** SOI と、詰め物つきの SOF0（高さ・幅）だけの JPEG の先頭 */
function jpegHeader(width: number, height: number, fill = 0): Uint8Array {
  return new Uint8Array([0xff, 0xd8, ...Array(fill).fill(0xff), 0xff, 0xc0, 0, 11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0])
}

describe('readImageInfo', () => {
  it('PNG と JPEG の見出しから大きさを読む', () => {
    expect(readImageInfo(pngHeader(40, 20))).toEqual({ mime: 'image/png', width: 40, height: 20 })
    expect(readImageInfo(jpegHeader(300, 200))).toEqual({ mime: 'image/jpeg', width: 300, height: 200 })
  })

  it('JPEG のマーカーの前の詰め物を読み飛ばす', () => {
    expect(readImageInfo(jpegHeader(300, 200, 3))).toEqual({ mime: 'image/jpeg', width: 300, height: 200 })
  })
})

describe('isImageTooLarge', () => {
  it('1 枚の画素数が上限を超えるか', () => {
    expect(isImageTooLarge({ mime: 'image/png', width: 8000, height: 8000 })).toBe(false)
    expect(isImageTooLarge({ mime: 'image/png', width: MAX_IMAGE_PIXELS + 1, height: 1 })).toBe(true)
    expect(isImageTooLarge({ mime: 'image/png', width: 30_000, height: 30_000 })).toBe(true)
  })
})
