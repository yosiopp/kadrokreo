// 画像ファイルの種類と大きさを、先頭のバイト列から読む（デコードはしない）

export type ImageInfo = { mime: string; width: number; height: number }

/**
 * 画像 1 枚の画素数の上限（PNG の書き出しのキャンバスと同じ 6,400 万）。デコードで確保するメモリを抑えるため、
 * kdr の読み込み・画像の取り込み・デコードの前に見出しの大きさで確かめる
 */
export const MAX_IMAGE_PIXELS = 64_000_000
/** デコードして持っておく画像の画素数の合計の上限（RGBA で約 1GB）。超えた分はデコードせず、読み込み中の見た目のままにする */
export const MAX_DECODED_PIXELS = 256_000_000

export const IMAGE_TOO_LARGE_MESSAGE = '画像の画素数が多すぎます（6,400 万画素まで）'

export function imagePixels(info: ImageInfo): number {
  return info.width * info.height
}

/** 1 枚の画素数の上限を超えているか */
export function isImageTooLarge(info: ImageInfo): boolean {
  return imagePixels(info) > MAX_IMAGE_PIXELS
}

export function readImageInfo(bytes: Uint8Array): ImageInfo | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, start + length))
  try {
    // PNG: シグネチャのあとの IHDR に幅と高さ
    if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && ascii(12, 4) === 'IHDR') {
      return { mime: 'image/png', width: view.getUint32(16), height: view.getUint32(20) }
    }
    // GIF: 論理画面の大きさ（リトルエンディアン）
    if (bytes.length >= 10 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) {
      return { mime: 'image/gif', width: view.getUint16(6, true), height: view.getUint16(8, true) }
    }
    if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return webp(bytes, view, ascii)
    if (bytes.length >= 4 && view.getUint16(0) === 0xffd8) return jpeg(bytes, view)
  } catch {
    // 途中で切れている
  }
  return null
}

function webp(bytes: Uint8Array, view: DataView, ascii: (start: number, length: number) => string): ImageInfo | null {
  const chunk = ascii(12, 4)
  const mime = 'image/webp'
  if (chunk === 'VP8 ') {
    return { mime, width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    const bits = view.getUint32(21, true)
    return { mime, width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') {
    const read24 = (offset: number) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
    return { mime, width: read24(24) + 1, height: read24(27) + 1 }
  }
  return null
}

function jpeg(bytes: Uint8Array, view: DataView): ImageInfo | null {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null
    // マーカーの前の詰め物（0xff の並び）は読み飛ばす
    if (bytes[offset + 1] === 0xff) {
      offset++
      continue
    }
    const marker = bytes[offset + 1]
    // SOF0〜SOF15（DHT・JPG・DAC を除く）にフレームの大きさがある
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { mime: 'image/jpeg', height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) }
    }
    offset += 2 + view.getUint16(offset + 2)
  }
  return null
}
