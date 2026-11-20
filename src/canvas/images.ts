import type { Asset } from '../document/types.ts'

// アセットは不変なので、オブジェクトをキーにデコード結果を持つ。使われなくなれば一緒に解放される
const cache = new WeakMap<Asset, { bitmap: ImageBitmap | null }>()
const listeners = new Set<() => void>()

/** デコード済みの画像。まだなら null を返して裏でデコードを始め、終わったら onImageLoad で知らせる */
export function getImage(asset: Asset): ImageBitmap | null {
  let entry = cache.get(asset)
  if (!entry) {
    const loading: { bitmap: ImageBitmap | null } = { bitmap: null }
    entry = loading
    cache.set(asset, loading)
    decode(asset).then(
      (bitmap) => {
        loading.bitmap = bitmap
        for (const listener of listeners) listener()
      },
      // 壊れた画像は読み込み中と同じ見た目のままにする
      () => {},
    )
  }
  return entry.bitmap
}

/** 取り込み時にデコード済みの画像を渡しておき、二度デコードしないようにする */
export function primeImage(asset: Asset, bitmap: ImageBitmap): void {
  cache.set(asset, { bitmap })
}

export function onImageLoad(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

async function decode(asset: Asset): Promise<ImageBitmap> {
  const binary = atob(asset.data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return createImageBitmap(new Blob([bytes], { type: asset.mime }))
}
