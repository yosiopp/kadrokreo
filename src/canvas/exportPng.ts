import { type Bounds, getNodesBounds, getWorldMatrix } from '../document/geometry.ts'
import type { Asset, AssetId, DesignDocument, NodeId, Page, Scene } from '../document/types.ts'
import { loadImage } from './images.ts'
import { renderScene } from './render.ts'

/** ブラウザが扱えるキャンバスの大きさには上限がある。一辺と総画素数の両方で抑える */
const MAX_SIDE = 16_384
const MAX_PIXELS = 64_000_000

/** 書き出す範囲（targets を囲む矩形）と、倍率をかけた画素の大きさ。大きすぎればエラー */
export function pngArea(scene: Scene, targets: readonly NodeId[], scale: number): { bounds: Bounds; width: number; height: number } {
  const bounds = getNodesBounds(scene, targets)
  if (!bounds) throw new Error('書き出すものがありません')
  const width = Math.max(1, Math.ceil(bounds.width * scale))
  const height = Math.max(1, Math.ceil(bounds.height * scale))
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new Error('大きすぎて PNG に書き出せません。倍率を下げるか、範囲を狭めてください。')
  }
  return { bounds, width, height }
}

/** 画像のデコードは裏で進むので、済んでいないと仮の表示のまま書き出されてしまう。描く前に待つ */
export async function loadSceneImages(scene: Scene, assets: Record<AssetId, Asset>): Promise<void> {
  const images = Object.values(scene.nodes).filter((node) => node.type === 'image')
  await Promise.all(images.map((node) => loadImage(assets[node.assetId])))
}

/** pngArea の大きさのキャンバスに、targets を描く。ブラウザと CLI（Node の Canvas）で共通 */
export function drawPng(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  assets: Record<AssetId, Asset>,
  targets: readonly NodeId[],
  area: { bounds: Bounds; width: number; height: number },
  scale: number,
): void {
  renderScene(
    ctx,
    scene,
    assets,
    { x: area.bounds.x, y: area.bounds.y, zoom: scale },
    { width: area.width, height: area.height },
    1,
    {
      labelColor: '#000000',
      labels: false,
      // 親が回っていても見た目どおりに描けるよう、親までの変換を渡す
      roots: targets.map((id) => ({ id, parent: getWorldMatrix(scene, scene.nodes[id].parentId) })),
    },
  )
}

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
  const area = pngArea(scene, targets, scale)
  await loadSceneImages(scene, assets)

  const canvas = document.createElement('canvas')
  canvas.width = area.width
  canvas.height = area.height
  drawPng(canvas.getContext('2d')!, scene, assets, targets, area, scale)

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG の書き出しに失敗しました'))),
      'image/png',
    )
  })
}

/**
 * 書き出すファイルの名前（拡張子・倍率の前）。ページ全体ならドキュメントとページの名前、
 * ノードが 1 つならその名前、いくつもなら先頭の名前と残りの数。viewer / editor / CLI で揃える
 */
export function pngBaseName(doc: Pick<DesignDocument, 'name'>, page: Page, targets: readonly NodeId[], whole: boolean): string {
  if (whole || targets.length === 0) return `${doc.name} - ${page.name}`
  if (targets.length === 1) return page.nodes[targets[0]].name
  return `${page.nodes[targets[0]].name} ほか ${targets.length - 1} 個`
}

/** 倍率つきのファイル名。等倍なら倍率は付けない */
export function pngFileName(name: string, scale: number): string {
  return `${name}${scale === 1 ? '' : `@${scale}x`}.png`
}
