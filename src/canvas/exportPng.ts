import { type Bounds, getWorldMatrix } from '../document/geometry.ts'
import { type TextLinesOf, getPaintedBounds } from '../document/paint.ts'
import type { Asset, AssetId, DesignDocument, NodeId, Page, Scene } from '../document/types.ts'
import { loadImage } from './images.ts'
import { renderScene } from './render.ts'
import { layoutText } from './text.ts'

/** ブラウザが扱えるキャンバスの大きさには上限がある。一辺と総画素数の両方で抑える */
const MAX_SIDE = 16_384
const MAX_PIXELS = 64_000_000

/** 書き出す範囲（targets を囲む矩形に影・ぼかし・線の太さ・枠からはみ出すテキストの行を足したもの）と、倍率をかけた画素の大きさ。大きすぎればエラー */
export function pngArea(
  scene: Scene,
  targets: readonly NodeId[],
  scale: number,
  textLines?: TextLinesOf,
): { bounds: Bounds; width: number; height: number } {
  // 影・ぼかし・枠からはみ出すテキストの行まで含める（getPaintedBounds）
  const bounds = getPaintedBounds(scene, targets, textLines)
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
  background: string | null = null,
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
  // 背景は描いた絵の後ろに敷く（範囲全体。SVG の書き出しの背景と同じ）
  if (background !== null) {
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'destination-over'
    ctx.fillStyle = background
    ctx.fillRect(0, 0, area.width, area.height)
    ctx.restore()
  }
}

/**
 * targets のノードを PNG にする。targets は重なり順（背面が先）に並べ、親子を一緒に含めないこと。
 * 範囲は pngArea（影・ぼかし・線の太さのはみ出しを含む）。background（#rrggbb）を渡せば範囲全体に敷き、null なら透明
 */
export async function renderPng(
  scene: Scene,
  assets: Record<AssetId, Asset>,
  targets: readonly NodeId[],
  scale: number,
  background: string | null = null,
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  // テキストの行分けは描画と同じく Canvas で測る（枠からはみ出す行を範囲に含めるため）
  const area = pngArea(scene, targets, scale, (node) => layoutText(ctx, node))
  await loadSceneImages(scene, assets)

  canvas.width = area.width
  canvas.height = area.height
  drawPng(ctx, scene, assets, targets, area, scale, background)

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
