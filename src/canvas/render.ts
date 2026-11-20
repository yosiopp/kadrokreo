import {
  type Bounds,
  IDENTITY,
  type Matrix,
  type Size,
  intersects,
  multiply,
  nodeMatrix,
  transformRect,
} from '../document/geometry.ts'
import type { Asset, AssetId, NodeId, Scene, SceneNode, Shadow } from '../document/types.ts'
import { getImage } from './images.ts'
import { applyFont, layoutText } from './text.ts'
import type { Viewport } from './viewport.ts'

export const FRAME_LABEL_FONT = '11px system-ui, sans-serif'
/** フレーム名ラベルの高さ（画面ピクセル）。フレームを囲む矩形の上辺のすぐ上に置く */
export const FRAME_LABEL_HEIGHT = 18

export type RenderOptions = {
  labelColor: string
  /** キャンバス上で編集中のテキスト。入力欄と二重に見えないよう描画しない */
  hiddenId?: NodeId | null
}

/** 1 回の描画で変わらないもの */
type Pass = {
  scene: Scene
  assets: Record<AssetId, Asset>
  options: RenderOptions
  /** 画面に映っている範囲（ページ座標） */
  visible: Bounds
  /** ページ座標の 1 がキャンバスの何ピクセルか。影の大きさは変換行列に従わないので自分で掛ける */
  scale: number
  /** 半透明のフレームを合成中の入れ子の数 */
  layerDepth: number
}

/** 1 ページ分を描く */
export function renderScene(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  assets: Record<AssetId, Asset>,
  viewport: Viewport,
  size: Size,
  pixelRatio: number,
  options: RenderOptions,
): void {
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
  ctx.clearRect(0, 0, size.width, size.height)

  const pass: Pass = {
    scene,
    assets,
    options,
    visible: {
      x: viewport.x,
      y: viewport.y,
      width: size.width / viewport.zoom,
      height: size.height / viewport.zoom,
    },
    scale: viewport.zoom * pixelRatio,
    layerDepth: 0,
  }

  ctx.save()
  ctx.scale(viewport.zoom, viewport.zoom)
  ctx.translate(-viewport.x, -viewport.y)
  for (const id of scene.rootIds) drawNode(ctx, pass, id, IDENTITY)
  ctx.restore()

  drawFrameLabels(ctx, scene, viewport, options)
}

/** parent は、親の座標系からページ座標系への変換。ctx はすでに親の座標系になっている */
function drawNode(ctx: CanvasRenderingContext2D, pass: Pass, id: NodeId, parent: Matrix): void {
  const node = pass.scene.nodes[id]
  if (!node.visible || node.opacity === 0) return

  const local = nodeMatrix(node)
  const world = multiply(parent, local)
  // はみ出した子を描くフレーム以外は、画面外なら丸ごと省ける
  const selfContained = node.type !== 'frame' || node.clipContent
  if (selfContained && !intersects(transformRect(world, paintedRect(node)), pass.visible)) return

  // 半透明のフレームは、中身を別のキャンバスに描いてから 1 枚の絵として重ねる。
  // 子を 1 つずつ半透明で描くと、子どうしの重なりが透けてしまう
  if (node.type === 'frame' && node.opacity < 1 && node.children.length > 0) {
    const layer = acquireLayer(ctx, pass.layerDepth)
    pass.layerDepth++
    layer.transform(...local)
    drawContent(layer, pass, node, world)
    pass.layerDepth--

    ctx.save()
    ctx.globalAlpha *= node.opacity
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(layer.canvas, 0, 0)
    ctx.restore()
    return
  }

  ctx.save()
  ctx.globalAlpha *= node.opacity
  ctx.transform(...local)
  drawContent(ctx, pass, node, world)
  ctx.restore()
}

const layers: CanvasRenderingContext2D[] = []

/** 合成用のキャンバス。描画先と同じ大きさ・同じ変換行列にして、空にして返す */
function acquireLayer(target: CanvasRenderingContext2D, depth: number): CanvasRenderingContext2D {
  const layer = (layers[depth] ??= document.createElement('canvas').getContext('2d')!)
  const { width, height } = target.canvas
  if (layer.canvas.width !== width || layer.canvas.height !== height) {
    layer.canvas.width = width
    layer.canvas.height = height
  }
  layer.setTransform(1, 0, 0, 1, 0, 0)
  layer.clearRect(0, 0, width, height)
  layer.setTransform(target.getTransform())
  return layer
}

/**
 * 不透明度を除いたノードの中身を描く。ctx はノードの座標系（枠の左上が原点）になっている。
 * world は、その座標系からページ座標系への変換。
 */
function drawContent(
  ctx: CanvasRenderingContext2D,
  pass: Pass,
  node: SceneNode,
  world: Matrix,
): void {
  const { width, height } = node
  switch (node.type) {
    case 'rect':
      ctx.beginPath()
      ctx.roundRect(0, 0, width, height, clampRadius(node.cornerRadius, node))
      paint(ctx, pass, node)
      break
    case 'ellipse':
      ctx.beginPath()
      ctx.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2)
      paint(ctx, pass, node)
      break
    case 'line':
      if (node.strokeWidth > 0) {
        const down = node.direction === 'down'
        ctx.beginPath()
        ctx.moveTo(0, down ? 0 : height)
        ctx.lineTo(width, down ? height : 0)
        ctx.strokeStyle = node.stroke
        ctx.lineWidth = node.strokeWidth
        ctx.stroke()
      }
      break
    case 'text':
      if (node.id !== pass.options.hiddenId) {
        applyFont(ctx, node)
        ctx.fillStyle = node.fill
        ctx.textBaseline = 'alphabetic'
        // CSS の行ボックスと同じ位置にベースラインを置き、編集中の入力欄と文字がずれないようにする
        const metrics = ctx.measureText('')
        const lineHeight = node.fontSize * node.lineHeight
        const contentHeight = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent
        const baseline = (lineHeight - contentHeight) / 2 + metrics.fontBoundingBoxAscent
        const align = { left: 0, center: 0.5, right: 1 }[node.textAlign]
        layoutText(ctx, node).forEach((line, i) => {
          ctx.fillText(line.text, (width - line.width) * align, lineHeight * i + baseline)
        })
      }
      break
    case 'image': {
      const asset = pass.assets[node.assetId]
      const bitmap = asset ? getImage(asset) : null
      ctx.save()
      if (node.cornerRadius > 0) {
        ctx.beginPath()
        ctx.roundRect(0, 0, width, height, clampRadius(node.cornerRadius, node))
        ctx.clip()
      }
      if (bitmap) {
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(bitmap, 0, 0, width, height)
      } else {
        // デコードが済むまでの仮の表示
        ctx.fillStyle = '#d9d9d9'
        ctx.fillRect(0, 0, width, height)
      }
      ctx.restore()
      break
    }
    case 'frame': {
      const outline = () => {
        ctx.beginPath()
        ctx.roundRect(0, 0, width, height, clampRadius(node.cornerRadius, node))
      }
      outline()
      if (node.fill) fillWithShadow(ctx, pass, node.fill, node.shadow)
      ctx.save()
      if (node.clipContent) ctx.clip()
      for (const childId of node.children) drawNode(ctx, pass, childId, world)
      ctx.restore()
      // 枠線は子より手前に描く
      if (node.stroke && node.strokeWidth > 0) {
        outline()
        ctx.strokeStyle = node.stroke
        ctx.lineWidth = node.strokeWidth
        ctx.stroke()
      }
      break
    }
  }
}

/** いま組んであるパスを塗りと線で描く。影は塗りに付け、塗りがなければ線に付ける */
function paint(
  ctx: CanvasRenderingContext2D,
  pass: Pass,
  node: { fill: string | null; stroke: string | null; strokeWidth: number; shadow: Shadow | null },
): void {
  if (node.fill) fillWithShadow(ctx, pass, node.fill, node.shadow)
  if (node.stroke && node.strokeWidth > 0) {
    ctx.save()
    if (!node.fill) applyShadow(ctx, pass, node.shadow)
    ctx.strokeStyle = node.stroke
    ctx.lineWidth = node.strokeWidth
    ctx.stroke()
    ctx.restore()
  }
}

function fillWithShadow(
  ctx: CanvasRenderingContext2D,
  pass: Pass,
  fill: string,
  shadow: Shadow | null,
): void {
  ctx.save()
  applyShadow(ctx, pass, shadow)
  ctx.fillStyle = fill
  ctx.fill()
  ctx.restore()
}

/** 影のずれは回転に従わない（図形を回しても、影は同じ向きに落ちる） */
function applyShadow(ctx: CanvasRenderingContext2D, pass: Pass, shadow: Shadow | null): void {
  if (!shadow) return
  const alpha = Math.round(shadow.opacity * 255)
  ctx.shadowColor = shadow.color + alpha.toString(16).padStart(2, '0')
  ctx.shadowBlur = shadow.blur * pass.scale
  ctx.shadowOffsetX = shadow.x * pass.scale
  ctx.shadowOffsetY = shadow.y * pass.scale
}

function clampRadius(radius: number, size: Size): number {
  return Math.max(0, Math.min(radius, size.width / 2, size.height / 2))
}

/** 線の太さや影も含めて、ノードが描かれうる範囲（ノードの座標系） */
function paintedRect(node: SceneNode): Bounds {
  const stroke = 'stroke' in node && node.stroke ? node.strokeWidth / 2 : 0
  const shadow = 'shadow' in node ? node.shadow : null
  // ぼかしは指定した長さより少し外まで広がる。影のずれは回転に従わないので、どの向きにも余裕を取る
  const spread = shadow ? shadow.blur * 2 + Math.max(Math.abs(shadow.x), Math.abs(shadow.y)) : 0
  const outset = stroke + spread
  return {
    x: -outset,
    y: -outset,
    width: node.width + outset * 2,
    height: node.height + outset * 2,
  }
}

/**
 * ページ直下のフレームの左上に名前を出す。画面座標で描くのでズームしても文字の大きさは変わらない。
 * 回転したフレームでは、フレームを囲む矩形の左上に置く。
 */
function drawFrameLabels(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  viewport: Viewport,
  options: RenderOptions,
): void {
  ctx.font = FRAME_LABEL_FONT
  ctx.fillStyle = options.labelColor
  ctx.textBaseline = 'middle'
  for (const id of scene.rootIds) {
    const node = scene.nodes[id]
    if (node.type !== 'frame' || !node.visible) continue
    const bounds = transformRect(nodeMatrix(node), { x: 0, y: 0, width: node.width, height: node.height })
    const x = (bounds.x - viewport.x) * viewport.zoom
    const y = (bounds.y - viewport.y) * viewport.zoom
    ctx.fillText(node.name, x, y - FRAME_LABEL_HEIGHT / 2)
  }
}
