import { MAX_DECODED_PIXELS, imagePixels, isImageTooLarge, readImageInfo } from '../document/imageInfo.ts'
import type { Asset } from '../document/types.ts'

// アセットは不変なので、オブジェクトをキーにデコード結果を持つ。使われなくなれば一緒に解放される
type Entry = { bitmap: ImageBitmap | null; ready: Promise<void> }
const cache = new WeakMap<Asset, Entry>()
const listeners = new Set<(asset: Asset) => void>()

function entryOf(asset: Asset): Entry {
  let entry = cache.get(asset)
  if (!entry) {
    const loading: Entry = { bitmap: null, ready: Promise.resolve() }
    loading.ready = decode(asset).then(
      (bitmap) => {
        loading.bitmap = bitmap
        for (const listener of listeners) listener(asset)
      },
      // 壊れた画像は読み込み中と同じ見た目のままにする
      () => {},
    )
    cache.set(asset, loading)
    entry = loading
  }
  return entry
}

/** デコード済みの画像。まだなら null を返して裏でデコードを始め、終わったら onImageLoad で知らせる */
export function getImage(asset: Asset): ImageBitmap | null {
  return entryOf(asset).bitmap
}

/** デコードが済むまで待つ。画像として書き出す前など、欠けたまま描いては困るときに使う */
export async function loadImage(asset: Asset): Promise<ImageBitmap | null> {
  const entry = entryOf(asset)
  await entry.ready
  return entry.bitmap
}

/** 取り込み時にデコード済みの画像を渡しておき、二度デコードしないようにする */
export function primeImage(asset: Asset, bitmap: ImageBitmap): void {
  if (cache.has(asset)) return
  count(asset, bitmap.width * bitmap.height)
  cache.set(asset, { bitmap, ready: Promise.resolve() })
}

/** デコードが済んだら、その画像を渡して知らせる */
export function onImageLoad(listener: (asset: Asset) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 埋め込んである画像の、元のファイルの中身 */
export function assetBlob(asset: Asset): Blob {
  return new Blob([asset.bytes], { type: asset.mime })
}

// デコードした画像の画素数の合計。アセットが使われなくなる（デコード結果も一緒に解放される）と引く
let decodedPixels = 0
const released = new FinalizationRegistry<number>((pixels) => {
  decodedPixels -= pixels
})

function count(asset: Asset, pixels: number): void {
  decodedPixels += pixels
  released.register(asset, pixels, asset)
}

/**
 * デコードしてよい画像なら、その画素数。見出しの大きさが読めない画像、1 枚の画素数の上限を超える画像、
 * 合計の上限を超える画像はデコードしない（確保するメモリを抑える）ので null
 */
export function decodablePixels(bytes: Uint8Array, alreadyDecoded = decodedPixels): number | null {
  const info = readImageInfo(bytes)
  if (info === null || isImageTooLarge(info)) return null
  const pixels = imagePixels(info)
  return alreadyDecoded + pixels <= MAX_DECODED_PIXELS ? pixels : null
}

// async にしてあるので、壊れた画像でも例外ではなく失敗した Promise になる
async function decode(asset: Asset): Promise<ImageBitmap> {
  const pixels = decodablePixels(asset.bytes)
  if (pixels === null) throw new Error('デコードしない画像です')
  // 並んでデコードするものも合計に入るよう、デコードを待つ前に数える
  count(asset, pixels)
  try {
    return await createImageBitmap(assetBlob(asset))
  } catch (error) {
    released.unregister(asset)
    decodedPixels -= pixels
    throw error
  }
}
