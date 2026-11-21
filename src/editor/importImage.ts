import type { Camera } from '../canvas/camera.ts'
import { primeImage } from '../canvas/images.ts'
import { screenToWorld } from '../canvas/viewport.ts'
import { toLocal } from '../document/geometry.ts'
import { IMAGE_MIME_TYPES, KDR_MAX_ASSET_BYTES } from '../document/kdr.ts'
import type { Asset } from '../document/types.ts'
import { findFrameAt } from './hitTest.ts'
import { createId, createImage } from './nodes.ts'
import { addOrReuseAsset, updatePage } from './operations/document.ts'
import { insertNode } from './operations/tree.ts'
import type { EditorStore } from './store.ts'

/**
 * 取り込める画像の大きさ。kdr は画像 1 枚ごとに上限を設けている（細工されたファイル対策）ので、それと揃える
 * （取り込めても書き出せない・開けない画像を作らない）。画像は元のファイルのバイト列のまま持つ
 */
const MAX_IMAGE_BYTES = KDR_MAX_ASSET_BYTES

export type ImportedImage = { name: string; asset: Asset; width: number; height: number }

export async function readImageFile(file: File): Promise<ImportedImage> {
  if (!IMAGE_MIME_TYPES.includes(file.type)) {
    throw new Error(`${file.name}: PNG / JPEG / WebP / GIF 以外の画像は取り込めません`)
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`${file.name}: 画像が大きすぎます（${MAX_IMAGE_BYTES / 1024 / 1024}MB まで）`)
  }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error(`${file.name}: 画像として読み込めません`)
  }
  const asset = { mime: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }
  primeImage(asset, bitmap)
  return {
    name: file.name.replace(/\.[^.]+$/, '') || 'Image',
    asset,
    width: bitmap.width,
    height: bitmap.height,
  }
}

/** 画面の中央に元の大きさで置く。そこにフレームがあればその中へ入れる。offset は複数枚を少しずつずらすため */
export function placeImage(store: EditorStore, camera: Camera, image: ImportedImage, offset = 0): void {
  const size = camera.getSize()
  const center = screenToWorld(camera.getViewport(), { x: size.width / 2, y: size.height / 2 })
  const page = store.getState().page
  const parentId = findFrameAt(page, center)
  // フレームが回っていても、その中での座標に直して置く
  const local = toLocal(page, parentId, center)

  const box = {
    x: Math.round(local.x - image.width / 2) + offset,
    y: Math.round(local.y - image.height / 2) + offset,
    width: image.width,
    height: image.height,
  }
  let nodeId = ''
  store.applyDocument((doc) => {
    // 同じ画像がすでにあれば、新しいアセットを作らずにそれを使う
    const { document, assetId } = addOrReuseAsset(doc, image.asset, createId)
    const node = { ...createImage(box, assetId), name: image.name }
    nodeId = node.id
    return updatePage(document, page.id, (base) => insertNode(base, node, parentId))
  })
  store.select([nodeId])
}
