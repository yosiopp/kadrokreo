import { type Bounds, type Size, intersects } from '../document/geometry.ts'
import type { DesignDocument, NodeId, SceneNode } from '../document/types.ts'
import { LINE_HEIGHT, applyFont } from './text.ts'
import type { Viewport } from './viewport.ts'

export const FRAME_LABEL_FONT = '11px system-ui, sans-serif'
/** フレーム名ラベルの高さ（画面ピクセル）。フレームの上辺のすぐ上に置く */
export const FRAME_LABEL_HEIGHT = 18

export type RenderOptions = {
  labelColor: string
  /** キャンバス上で編集中のテキスト。入力欄と二重に見えないよう描画しない */
  hiddenId?: NodeId | null
}

export function renderDocument(
  ctx: CanvasRenderingContext2D,
  doc: DesignDocument,
  viewport: Viewport,
  size: Size,
  pixelRatio: number,
  options: RenderOptions,
): void {
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
  ctx.clearRect(0, 0, size.width, size.height)

  const visible: Bounds = {
    x: viewport.x,
    y: viewport.y,
    width: size.width / viewport.zoom,
    height: size.height / viewport.zoom,
  }

  ctx.save()
  ctx.scale(viewport.zoom, viewport.zoom)
  ctx.translate(-viewport.x, -viewport.y)
  for (const id of doc.rootIds) drawNode(ctx, doc, id, 0, 0, visible, options)
  ctx.restore()

  drawFrameLabels(ctx, doc, viewport, options)
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  doc: DesignDocument,
  id: NodeId,
  originX: number,
  originY: number,
  visible: Bounds,
  options: RenderOptions,
): void {
  const node = doc.nodes[id]
  if (!node.visible || node.opacity === 0) return

  const x = originX + node.x
  const y = originY + node.y
  // はみ出した子を描くフレーム以外は、画面外なら丸ごと省ける
  const selfContained = node.type !== 'frame' || node.clipContent
  if (selfContained && !intersects(strokeBounds(node, x, y), visible)) return

  ctx.save()
  ctx.globalAlpha *= node.opacity

  switch (node.type) {
    case 'rect':
      ctx.beginPath()
      ctx.roundRect(x, y, node.width, node.height, cornerRadius(node.cornerRadius, node))
      paint(ctx, node)
      break
    case 'ellipse':
      ctx.beginPath()
      ctx.ellipse(
        x + node.width / 2,
        y + node.height / 2,
        node.width / 2,
        node.height / 2,
        0,
        0,
        Math.PI * 2,
      )
      paint(ctx, node)
      break
    case 'text':
      if (id !== options.hiddenId) {
        applyFont(ctx, node)
        ctx.fillStyle = node.fill
        ctx.textBaseline = 'alphabetic'
        // CSS の行ボックスと同じ位置にベースラインを置き、編集中の入力欄と文字がずれないようにする
        const metrics = ctx.measureText('')
        const lineHeight = node.fontSize * LINE_HEIGHT
        const contentHeight = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent
        const baseline = (lineHeight - contentHeight) / 2 + metrics.fontBoundingBoxAscent
        node.text.split('\n').forEach((line, i) => {
          ctx.fillText(line, x, y + lineHeight * i + baseline)
        })
      }
      break
    case 'frame':
      ctx.beginPath()
      ctx.rect(x, y, node.width, node.height)
      if (node.fill) {
        ctx.fillStyle = node.fill
        ctx.fill()
      }
      ctx.save()
      if (node.clipContent) ctx.clip()
      for (const childId of node.children) drawNode(ctx, doc, childId, x, y, visible, options)
      ctx.restore()
      // 枠線は子より手前に描く
      if (node.stroke && node.strokeWidth > 0) {
        ctx.beginPath()
        ctx.rect(x, y, node.width, node.height)
        ctx.strokeStyle = node.stroke
        ctx.lineWidth = node.strokeWidth
        ctx.stroke()
      }
      break
  }

  ctx.restore()
}

function paint(
  ctx: CanvasRenderingContext2D,
  node: { fill: string | null; stroke: string | null; strokeWidth: number },
): void {
  if (node.fill) {
    ctx.fillStyle = node.fill
    ctx.fill()
  }
  if (node.stroke && node.strokeWidth > 0) {
    ctx.strokeStyle = node.stroke
    ctx.lineWidth = node.strokeWidth
    ctx.stroke()
  }
}

function cornerRadius(radius: number, size: Size): number {
  return Math.max(0, Math.min(radius, size.width / 2, size.height / 2))
}

function strokeBounds(node: SceneNode, x: number, y: number): Bounds {
  const outset = node.type !== 'text' && node.stroke ? node.strokeWidth / 2 : 0
  return {
    x: x - outset,
    y: y - outset,
    width: node.width + outset * 2,
    height: node.height + outset * 2,
  }
}

/** ページ直下のフレームの左上に名前を出す。画面座標で描くのでズームしても文字の大きさは変わらない */
function drawFrameLabels(
  ctx: CanvasRenderingContext2D,
  doc: DesignDocument,
  viewport: Viewport,
  options: RenderOptions,
): void {
  ctx.font = FRAME_LABEL_FONT
  ctx.fillStyle = options.labelColor
  ctx.textBaseline = 'middle'
  for (const id of doc.rootIds) {
    const node = doc.nodes[id]
    if (node.type !== 'frame' || !node.visible) continue
    const x = (node.x - viewport.x) * viewport.zoom
    const y = (node.y - viewport.y) * viewport.zoom
    ctx.fillText(node.name, x, y - FRAME_LABEL_HEIGHT / 2)
  }
}
