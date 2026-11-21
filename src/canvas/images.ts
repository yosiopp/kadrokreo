import type { Asset } from '../document/types.ts'

// アセットは不変なので、オブジェクトをキーにデコード結果を持つ。使われなくなれば一緒に解放される
type Entry = { bitmap: ImageBitmap | null; ready: Promise<void> }
const cache = new WeakMap<Asset, Entry>()
const listeners = new Set<() => void>()

function entryOf(asset: Asset): Entry {
  let entry = cache.get(asset)
  if (!entry) {
    const loading: Entry = { bitmap: null, ready: Promise.resolve() }
    loading.ready = decode(asset).then(
      (bitmap) => {
        loading.bitmap = bitmap
        for (const listener of listeners) listener()
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
  cache.set(asset, { bitmap, ready: Promise.resolve() })
}

export function onImageLoad(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 埋め込んである画像の、元のファイルの中身 */
export function assetBlob(asset: Asset): Blob {
  const binary = atob(asset.data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: asset.mime })
}

// async にしてあるので、base64 が壊れていても例外ではなく失敗した Promise になる
async function decode(asset: Asset): Promise<ImageBitmap> {
  return createImageBitmap(assetBlob(asset))
}
