import { getNodesBounds, getWorldMatrix } from '../document/geometry.ts'
import type { Asset, AssetId, NodeId, Scene } from '../document/types.ts'
import { loadImage } from './images.ts'
import { renderScene } from './render.ts'

/** ブラウザが扱えるキャンバスの大きさには上限がある。一辺と総画素数の両方で抑える */
const MAX_SIDE = 16_384
const MAX_PIXELS = 64_000_000

/**
 * targets のノードを、背景が透明な PNG にする。targets は重なり順（背面が先）に並べ、
 * 親子を一緒に含めないこと。
 * 範囲は、それらを囲む矩形。影など、枠の外にはみ出す部分は含めない。
 */
export async function renderPng(
  scene: Scene,
  assets: Record<AssetId, Asset>,
  targets: readonly NodeId[],
  scale: number,
): Promise<Blob> {
  const bounds = getNodesBounds(scene, targets)
  if (!bounds) throw new Error('書き出すものがありません')

  const width = Math.max(1, Math.ceil(bounds.width * scale))
  const height = Math.max(1, Math.ceil(bounds.height * scale))
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new Error('大きすぎて PNG に書き出せません。倍率を下げるか、範囲を狭めてください。')
  }

  // 画像のデコードは裏で進むので、済んでいないと仮の表示のまま書き出されてしまう
  const images = Object.values(scene.nodes).filter((node) => node.type === 'image')
  await Promise.all(images.map((node) => loadImage(assets[node.assetId])))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  renderScene(
    canvas.getContext('2d')!,
    scene,
    assets,
    { x: bounds.x, y: bounds.y, zoom: scale },
    { width, height },
    1,
    {
      labelColor: '#000000',
      labels: false,
      // 親が回っていても見た目どおりに描けるよう、親までの変換を渡す
      roots: targets.map((id) => ({ id, parent: getWorldMatrix(scene, scene.nodes[id].parentId) })),
    },
  )

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG の書き出しに失敗しました'))),
      'image/png',
    )
  })
}

/** 倍率つきのファイル名。等倍なら倍率は付けない */
export function pngFileName(name: string, scale: number): string {
  return `${name}${scale === 1 ? '' : `@${scale}x`}.png`
}
