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
import { type Vertex, arrowSize, cappedStroke, pathPoints, tracePath } from '../document/path.ts'
import { gradientLine, hasStroke } from '../document/paint.ts'
import type {
  Asset,
  AssetId,
  Cap,
  Effect,
  ImageNode,
  NodeId,
  Paint,
  Scene,
  SceneNode,
  Style,
} from '../document/types.ts'
import { OVERLAY_COMPONENT } from './overlay.ts'
import { isVariantSet } from '../document/variants.ts'
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
  /** フレーム名のラベルを出すか。省略すると出す */
  labels?: boolean
  /**
   * ページ全体ではなく、指定したノードだけを描く（画像として書き出すとき）。
   * parent は、そのノードの親の座標系からページ座標系への変換。
   */
  roots?: readonly { id: NodeId; parent: Matrix }[]
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
  const roots = options.roots ?? scene.rootIds.map((id) => ({ id, parent: IDENTITY }))
  for (const root of roots) {
    ctx.save()
    ctx.transform(...root.parent)
    drawNode(ctx, pass, root.id, root.parent)
    ctx.restore()
  }
  ctx.restore()

  if (options.labels !== false) drawFrameLabels(ctx, scene, viewport, options)
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
    case 'path': {
      const points = pathPoints(node)
      const outline = () => {
        ctx.beginPath()
        tracePath(ctx, points, node.closed)
      }
      const capped = !node.closed && (node.startCap !== 'none' || node.endCap !== 'none')
      if (!capped) {
        outline()
        paint(ctx, pass, node)
        break
      }
      // 端に矢印を付ける線は、線を矢印の分だけ短くするので、塗りと線を別々に描く
      if (node.fills.length > 0) {
        outline()
        fillAll(ctx, pass, node, node.effects)
      }
      strokeWithCaps(ctx, points, node)
      break
    }
    case 'text':
      if (node.id !== pass.options.hiddenId) {
        applyFont(ctx, node)
        ctx.textBaseline = 'alphabetic'
        // CSS の行ボックスと同じ位置にベースラインを置き、編集中の入力欄と文字がずれないようにする
        const metrics = ctx.measureText('')
        const lineHeight = node.fontSize * node.lineHeight
        const contentHeight = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent
        const baseline = (lineHeight - contentHeight) / 2 + metrics.fontBoundingBoxAscent
        const align = { left: 0, center: 0.5, right: 1 }[node.textAlign]
        const lines = layoutText(ctx, node)
        for (const fill of node.fills) {
          ctx.fillStyle = paintStyle(ctx, fill, node)
          lines.forEach((line, i) => {
            ctx.fillText(line.text, (width - line.width) * align, lineHeight * i + baseline)
          })
        }
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
        drawFitted(ctx, bitmap, node)
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
      fillAll(ctx, pass, node, node.effects)
      ctx.save()
      if (node.clipContent) ctx.clip()
      for (const childId of node.children) drawNode(ctx, pass, childId, world)
      ctx.restore()
      // 枠線は子より手前に描く
      if (hasStroke(node)) {
        outline()
        strokeAll(ctx, node)
      }
      break
    }
  }
}

/** いま組んであるパスを塗りと線で描く。影は塗りに付け、塗りがなければ線に付ける */
function paint(ctx: CanvasRenderingContext2D, pass: Pass, node: Size & Style): void {
  fillAll(ctx, pass, node, node.effects)
  if (hasStroke(node)) {
    ctx.save()
    if (node.fills.length === 0) applyEffects(ctx, pass, node.effects)
    strokeAll(ctx, node)
    ctx.restore()
  }
}

/** いま組んであるパスを、塗りを下から順に重ねて塗る。影は一番下の塗りに付ける */
function fillAll(ctx: CanvasRenderingContext2D, pass: Pass, node: Size & Pick<Style, 'fills'>, effects: readonly Effect[]): void {
  node.fills.forEach((fill, i) => {
    ctx.save()
    if (i === 0) applyEffects(ctx, pass, effects)
    ctx.fillStyle = paintStyle(ctx, fill, node)
    ctx.fill()
    ctx.restore()
  })
}

/** いま組んであるパスに、線を下から順に重ねて引く */
function strokeAll(ctx: CanvasRenderingContext2D, node: Size & Pick<Style, 'strokes' | 'strokeWidth'>): void {
  ctx.lineWidth = node.strokeWidth
  for (const stroke of node.strokes) {
    ctx.strokeStyle = paintStyle(ctx, stroke, node)
    ctx.stroke()
  }
}

/** 塗りに使う色かグラデーション。グラデーションは枠（size）に合わせる */
function paintStyle(ctx: CanvasRenderingContext2D, paint: Paint, size: Size): string | CanvasGradient {
  if (paint.type === 'solid') return paint.color
  // 枠の中心を通る、angle の向きの線に沿って色を変える
  const [from, to] = gradientLine(paint, size)
  // 枠が極端に大きいと端が Infinity になり、createLinearGradient が例外を投げる。そのときは最初の色で塗る
  if (![from.x, from.y, to.x, to.y].every(Number.isFinite)) return paint.stops[0].color
  const gradient = ctx.createLinearGradient(from.x, from.y, to.x, to.y)
  for (const stop of paint.stops) gradient.addColorStop(stop.offset, stop.color)
  return gradient
}

/** 画像を、枠への収め方（fit）に従って描く */
function drawFitted(ctx: CanvasRenderingContext2D, bitmap: ImageBitmap, node: ImageNode): void {
  const { width, height, fit } = node
  if (fit === 'stretch' || bitmap.width === 0 || bitmap.height === 0) {
    ctx.drawImage(bitmap, 0, 0, width, height)
  } else if (fit === 'cover') {
    // 枠を埋める倍率で、画像の中央を切り出す
    const scale = Math.max(width / bitmap.width, height / bitmap.height)
    const sourceWidth = width / scale
    const sourceHeight = height / scale
    ctx.drawImage(
      bitmap,
      (bitmap.width - sourceWidth) / 2,
      (bitmap.height - sourceHeight) / 2,
      sourceWidth,
      sourceHeight,
      0,
      0,
      width,
      height,
    )
  } else {
    // 全体が入る倍率で、枠の中央に置く
    const scale = Math.min(width / bitmap.width, height / bitmap.height)
    const drawnWidth = bitmap.width * scale
    const drawnHeight = bitmap.height * scale
    ctx.drawImage(bitmap, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight)
  }
}

/**
 * 効果（影）を、次に描くものに付ける。影のずれは回転に従わない（図形を回しても、影は同じ向きに落ちる）。
 * Canvas は 1 回の描画に影を 1 つしか付けられないので、2 つ目からは図形を画面外へずらして影だけを先に描く
 */
function applyEffects(ctx: CanvasRenderingContext2D, pass: Pass, effects: readonly Effect[]): void {
  if (effects.length === 0) return
  for (const effect of effects.slice(0, -1)) drawShadowOnly(ctx, pass, effect)
  setShadow(ctx, pass, effects[effects.length - 1])
}

function setShadow(ctx: CanvasRenderingContext2D, pass: Pass, shadow: Effect): void {
  const alpha = Math.round(shadow.opacity * 255)
  ctx.shadowColor = shadow.color + alpha.toString(16).padStart(2, '0')
  ctx.shadowBlur = shadow.blur * pass.scale
  ctx.shadowOffsetX = shadow.x * pass.scale
  ctx.shadowOffsetY = shadow.y * pass.scale
}

/** いま組んであるパスの影だけを描く。パスを画面の外へずらして塗り、影のずれで元の位置へ戻す */
function drawShadowOnly(ctx: CanvasRenderingContext2D, pass: Pass, shadow: Effect): void {
  const far = 100_000
  const inverse = ctx.getTransform().inverse()
  ctx.save()
  setShadow(ctx, pass, shadow)
  ctx.shadowOffsetX += far
  // 画面の座標で far だけ左へずらす量を、いまの座標系に直す
  ctx.translate(-far * inverse.a, -far * inverse.b)
  ctx.fillStyle = '#000000'
  ctx.fill()
  ctx.restore()
}

/** 頂点を順につないだ線（曲線を含む）を引き、両端に端の形を描く */
function strokeWithCaps(
  ctx: CanvasRenderingContext2D,
  points: readonly Vertex[],
  style: Size & Pick<Style, 'strokes' | 'strokeWidth'> & { startCap: Cap; endCap: Cap },
): void {
  if (!hasStroke(style) || points.length < 2) return
  const { line, heads } = cappedStroke(points, style)
  for (const stroke of style.strokes) {
    const color = paintStyle(ctx, stroke, style)
    ctx.beginPath()
    tracePath(ctx, line, false)
    ctx.strokeStyle = color
    ctx.lineWidth = style.strokeWidth
    ctx.stroke()

    ctx.fillStyle = color
    for (const head of heads) {
      ctx.beginPath()
      head.forEach((point, i) => (i === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)))
      ctx.closePath()
      ctx.fill()
    }
  }
}

function clampRadius(radius: number, size: Size): number {
  return Math.max(0, Math.min(radius, size.width / 2, size.height / 2))
}

/** 線の太さや影も含めて、ノードが描かれうる範囲（ノードの座標系） */
function paintedRect(node: SceneNode): Bounds {
  const stroke = 'strokes' in node && node.strokes.length > 0 ? node.strokeWidth / 2 : 0
  const effects = 'effects' in node ? node.effects : []
  // ぼかしは指定した長さより少し外まで広がる。影のずれは回転に従わないので、どの向きにも余裕を取る
  const spread = Math.max(0, ...effects.map((shadow) => shadow.blur * 2 + Math.max(Math.abs(shadow.x), Math.abs(shadow.y))))
  // 矢印は線より外へ張り出す
  const arrow =
    'startCap' in node && (node.startCap !== 'none' || node.endCap !== 'none')
      ? arrowSize(node.strokeWidth)
      : 0
  const outset = Math.max(stroke, arrow) + spread
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
  ctx.textBaseline = 'middle'
  for (const id of scene.rootIds) {
    const node = scene.nodes[id]
    if (node.type !== 'frame' || !node.visible) continue
    // コンポーネントの元とインスタンス、バリアントのまとまりは、名前の色で見分けられるようにする
    ctx.fillStyle = node.component || isVariantSet(scene, id) ? OVERLAY_COMPONENT : options.labelColor
    const bounds = transformRect(nodeMatrix(node), { x: 0, y: 0, width: node.width, height: node.height })
    const x = (bounds.x - viewport.x) * viewport.zoom
    const y = (bounds.y - viewport.y) * viewport.zoom
    ctx.fillText(node.name, x, y - FRAME_LABEL_HEIGHT / 2)
  }
}
