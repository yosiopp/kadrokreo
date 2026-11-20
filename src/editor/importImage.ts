import type { Camera } from '../canvas/camera.ts'
import { primeImage } from '../canvas/images.ts'
import { screenToWorld } from '../canvas/viewport.ts'
import { getAbsolutePosition } from '../document/geometry.ts'
import { IMAGE_MIME_TYPES } from '../document/kdr.ts'
import type { Asset } from '../document/types.ts'
import { findFrameAt } from './hitTest.ts'
import { createId, createImage } from './nodes.ts'
import { addAsset, insertNode } from './operations.ts'
import type { EditorStore } from './store.ts'

/** kdr に base64 で埋め込むので、元のファイルの大きさを抑える */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024

export type ImportedImage = { name: string; asset: Asset; width: number; height: number }

export async function readImageFile(file: File): Promise<ImportedImage> {
  if (!IMAGE_MIME_TYPES.includes(file.type)) {
    throw new Error(`${file.name}: PNG / JPEG / WebP / GIF 以外の画像は取り込めません`)
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`${file.name}: 画像が大きすぎます（16MB まで）`)
  }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error(`${file.name}: 画像として読み込めません`)
  }
  const asset = { mime: file.type, data: await toBase64(file) }
  primeImage(asset, bitmap)
  return {
    name: file.name.replace(/\.[^.]+$/, '') || 'Image',
    asset,
    width: bitmap.width,
    height: bitmap.height,
  }
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  // 引数の数に上限があるので、少しずつ文字列にする
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** 画面の中央に元の大きさで置く。そこにフレームがあればその中へ入れる。offset は複数枚を少しずつずらすため */
export function placeImage(store: EditorStore, camera: Camera, image: ImportedImage, offset = 0): void {
  const size = camera.getSize()
  const center = screenToWorld(camera.getViewport(), { x: size.width / 2, y: size.height / 2 })
  const doc = store.getState().document
  const parentId = findFrameAt(doc, center)
  const origin = parentId === null ? { x: 0, y: 0 } : getAbsolutePosition(doc, parentId)

  const assetId = createId()
  const node = {
    ...createImage(
      {
        x: Math.round(center.x - image.width / 2 - origin.x) + offset,
        y: Math.round(center.y - image.height / 2 - origin.y) + offset,
        width: image.width,
        height: image.height,
      },
      assetId,
    ),
    name: image.name,
  }
  store.apply((base) => insertNode(addAsset(base, assetId, image.asset), node, parentId))
  store.select([node.id])
}
