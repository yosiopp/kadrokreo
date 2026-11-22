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
import { type Vertex, capMarkerSize, capReach, cappedStroke, pathOutlines, tracePath } from '../document/path.ts'
import { cornerRadii, gradientLine, hasStroke, imageRect, isRounded, splitEffects, withoutHidden } from '../document/paint.ts'
import type {
  Asset,
  AssetId,
  Cap,
  CornerRadius,
  ConicGradient,
  Effect,
  ImageNode,
  NodeId,
  Paint,
  RadialGradient,
  Scene,
  SceneNode,
  Style,
  TextNode,
} from '../document/types.ts'
import { OVERLAY_COMPONENT } from './overlay.ts'
import { isVariantSet } from '../document/variants.ts'
import { getImage } from './images.ts'
import { frameLabelPose } from './labels.ts'
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
  /**
   * 画面のこの範囲（画面座標）だけを描き直す。ほかの部分はそのまま残す。
   * 前の絵をずらして使い回すパンで、新しく見えた端だけを描くのに使う（CanvasView）
   */
  region?: Bounds
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
  const region = options.region
  ctx.save()
  if (region) {
    ctx.clearRect(region.x, region.y, region.width, region.height)
    ctx.beginPath()
    ctx.rect(region.x, region.y, region.width, region.height)
    ctx.clip()
  } else {
    ctx.clearRect(0, 0, size.width, size.height)
  }

  // 範囲を描き直すときは、範囲の外の図形を省く。境目のにじみを取りこぼさないよう、1 ピクセル分広げる
  const margin = region ? 1 / pixelRatio : 0
  const screen = region ?? { x: 0, y: 0, ...size }
  const pass: Pass = {
    scene,
    assets,
    options,
    visible: {
      x: viewport.x + (screen.x - margin) / viewport.zoom,
      y: viewport.y + (screen.y - margin) / viewport.zoom,
      width: (screen.width + margin * 2) / viewport.zoom,
      height: (screen.height + margin * 2) / viewport.zoom,
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
  ctx.restore()
}

/** parent は、親の座標系からページ座標系への変換。ctx はすでに親の座標系になっている */
function drawNode(ctx: CanvasRenderingContext2D, pass: Pass, id: NodeId, parent: Matrix): void {
  const node = pass.scene.nodes[id]
  if (!node.visible || node.opacity === 0) return

  const local = nodeMatrix(node)
  const world = multiply(parent, local)
  // はみ出した子を描くフレーム以外は、画面外なら丸ごと省ける
  const selfContained = node.type !== 'frame' || node.clipContent
  if (selfContained && !intersects(transformRect(world, paintedRect(ctx, node)), pass.visible)) return

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
  // 隠した塗り・線・効果は描かない
  node = withoutHidden(node)
  const { width, height } = node
  switch (node.type) {
    case 'rect': {
      const outline = () => {
        ctx.beginPath()
        ctx.roundRect(0, 0, width, height, clampRadius(node.cornerRadius, node))
      }
      outline()
      paint(ctx, pass, node, outline)
      break
    }
    case 'ellipse': {
      const outline = () => {
        ctx.beginPath()
        ctx.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2)
      }
      outline()
      paint(ctx, pass, node, outline)
      break
    }
    case 'path': {
      const outlines = pathOutlines(node)
      const points = outlines[0].vertices
      const outline = () => {
        ctx.beginPath()
        for (const contour of outlines) tracePath(ctx, contour.vertices, contour.closed)
      }
      const capped = !node.closed && (node.startCap !== 'none' || node.endCap !== 'none')
      if (!capped) {
        outline()
        paint(ctx, pass, node, outline)
        break
      }
      // 端の形を付ける線は、線を矢印の分だけ短くし、端の図形を足すので、塗りと線を別々に描く
      outline()
      fillAll(ctx, pass, node, node.effects)
      drawInnerShadows(ctx, pass, node, node.effects, outline)
      strokeWithCaps(ctx, points, node)
      // 端の形は最初の輪郭にだけ付く。残りの輪郭はそのまま線を引く
      if (outlines.length > 1 && hasStroke(node)) {
        ctx.beginPath()
        for (const contour of outlines.slice(1)) tracePath(ctx, contour.vertices, contour.closed)
        strokeAll(ctx, node)
      }
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
          // 固定の幅からはみ出す行もあるので、文字の大きさの分だけ外まで覆う
          ctx.save()
          ctx.globalAlpha *= fill.opacity
          ctx.fillStyle = paintStyle(ctx, fill, node, node.fontSize)
          lines.forEach((line, i) => {
            ctx.fillText(line.text, (width - line.width) * align, lineHeight * i + baseline)
          })
          ctx.restore()
        }
      }
      break
    case 'image': {
      const asset = pass.assets[node.assetId]
      const bitmap = asset ? getImage(asset) : null
      ctx.save()
      if (isRounded(node.cornerRadius)) {
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
      // 内側の影は背景の上、子の下（CSS の inset の box-shadow と同じ）
      drawInnerShadows(ctx, pass, node, node.effects, outline)
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

/**
 * いま組んであるパスを塗りと線で描く。落ち影は塗りに付け、塗りがなければ線に付ける。内側の影は塗りと線の間に描く。
 * outline は同じパスを組み直す関数（内側の影がパスを使うので、線の前に組み直す）
 */
function paint(ctx: CanvasRenderingContext2D, pass: Pass, node: Size & Style, outline: () => void): void {
  fillAll(ctx, pass, node, node.effects)
  drawInnerShadows(ctx, pass, node, node.effects, outline)
  if (hasStroke(node)) {
    ctx.save()
    if (node.fills.length === 0) applyEffects(ctx, pass, node.effects)
    strokeAll(ctx, node)
    ctx.restore()
  }
}

/** いま組んであるパスを、塗りを下から順に重ねて塗る。落ち影は一番下の塗りに付ける */
function fillAll(ctx: CanvasRenderingContext2D, pass: Pass, node: Size & Pick<Style, 'fills'>, effects: readonly Effect[]): void {
  node.fills.forEach((fill, i) => {
    ctx.save()
    ctx.globalAlpha *= fill.opacity
    if (i === 0) applyEffects(ctx, pass, effects)
    if (fill.type === 'radial') fillRadial(ctx, fill, node, fillRuleOf(node))
    else {
      ctx.fillStyle = paintStyle(ctx, fill, node)
      ctx.fill(fillRuleOf(node))
    }
    ctx.restore()
  })
}

/** いま組んであるパスに、線を下から順に重ねて引く */
function strokeAll(ctx: CanvasRenderingContext2D, node: Size & Pick<Style, 'strokes' | 'strokeWidth' | 'strokeDashes'>): void {
  ctx.lineWidth = node.strokeWidth
  ctx.setLineDash(node.strokeDashes)
  for (const stroke of node.strokes) {
    ctx.save()
    ctx.globalAlpha *= stroke.opacity
    ctx.strokeStyle = paintStyle(ctx, stroke, node, node.strokeWidth)
    ctx.stroke()
    ctx.restore()
  }
  ctx.setLineDash([])
}

/** 塗る範囲の決め方。パスだけが持ち、ほかは nonzero */
function fillRuleOf(node: object): CanvasFillRule {
  return 'fillRule' in node && node.fillRule === 'evenodd' ? 'evenodd' : 'nonzero'
}

/**
 * 塗りに使う色かグラデーション。グラデーションは枠（size）に合わせる。
 * 円形のグラデーションは楕円にするため、線と文字では枠の大きさの絵のパターンにする（面の塗りは fillRadial で正確に描く）
 */
function paintStyle(ctx: CanvasRenderingContext2D, paint: Paint, size: Size, margin = 0): string | CanvasGradient | CanvasPattern {
  if (paint.type === 'solid') return paint.color
  if (paint.type === 'radial') return radialPattern(ctx, paint, size, margin)
  if (paint.type === 'conic') return conicGradient(ctx, paint, size)
  // 枠の中心を通る、angle の向きの線に沿って色を変える
  const [from, to] = gradientLine(paint, size)
  // 枠が極端に大きいと端が Infinity になり、createLinearGradient が例外を投げる。そのときは最初の色で塗る
  if (![from.x, from.y, to.x, to.y].every(Number.isFinite)) return paint.stops[0].color
  const gradient = ctx.createLinearGradient(from.x, from.y, to.x, to.y)
  for (const stop of paint.stops) gradient.addColorStop(stop.offset, stop.color)
  return gradient
}

/** 角度のグラデーション。Canvas の角度も右が 0 で時計回りなので、angle をそのまま使う */
function conicGradient(ctx: CanvasRenderingContext2D, paint: ConicGradient, size: Size): string | CanvasGradient {
  const x = paint.cx * size.width
  const y = paint.cy * size.height
  if (!Number.isFinite(x) || !Number.isFinite(y)) return paint.stops[0].color
  // 極端に大きい角度でラジアンが Infinity にならないよう、先に 1 周に収める
  const gradient = ctx.createConicGradient(((paint.angle % 360) * Math.PI) / 180, x, y)
  for (const stop of paint.stops) gradient.addColorStop(stop.offset, stop.color)
  return gradient
}

/** 円形のグラデーションの楕円を単位円に写す変換（ノードの座標系で）。楕円がつぶれていれば null */
function radialMatrix(paint: RadialGradient, size: Size): Matrix | null {
  const rx = paint.rx * size.width
  const ry = paint.ry * size.height
  const m: Matrix = [rx, 0, 0, ry, paint.cx * size.width, paint.cy * size.height]
  return rx > 0 && ry > 0 && m.every(Number.isFinite) ? m : null
}

/** 中心から半径 1 の円で色を変える CanvasGradient。楕円にするのは変換行列の役目 */
function unitRadial(ctx: CanvasRenderingContext2D, paint: RadialGradient): CanvasGradient {
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1)
  for (const stop of paint.stops) gradient.addColorStop(stop.offset, stop.color)
  return gradient
}

/**
 * いま組んであるパスを円形のグラデーションで塗る。パスは組んだときの座標で決まっているので、
 * 変換行列を楕円に合わせてから塗れば、グラデーションだけが楕円になる（影は変換行列に従わない）
 */
function fillRadial(ctx: CanvasRenderingContext2D, paint: RadialGradient, size: Size, rule: CanvasFillRule = 'nonzero'): void {
  const m = radialMatrix(paint, size)
  if (!m) {
    ctx.fillStyle = paint.stops[paint.stops.length - 1].color
  } else {
    ctx.transform(...m)
    ctx.fillStyle = unitRadial(ctx, paint)
  }
  ctx.fill(rule)
}

let patternCanvas: CanvasRenderingContext2D | null = null
const PATTERN_SIZE = 256

/**
 * 円形のグラデーションを、枠（と margin だけ外側）を覆う絵にしたパターン。線や文字は変換行列をゆがめて描けないので使う。
 * 絵の外は透明になるので、margin に線の太さなどのはみ出す分を渡す
 */
function radialPattern(ctx: CanvasRenderingContext2D, paint: RadialGradient, size: Size, margin: number): string | CanvasPattern {
  const last = paint.stops[paint.stops.length - 1].color
  const m = radialMatrix(paint, size)
  const width = size.width + margin * 2
  const height = size.height + margin * 2
  if (!m || !(width > 0 && height > 0) || !Number.isFinite(width + height)) return last
  const tile = (patternCanvas ??= document.createElement('canvas').getContext('2d')!)
  tile.canvas.width = PATTERN_SIZE
  tile.canvas.height = PATTERN_SIZE
  tile.setTransform(1, 0, 0, 1, 0, 0)
  tile.beginPath()
  tile.rect(0, 0, PATTERN_SIZE, PATTERN_SIZE)
  // 絵の 1 ピクセルをノードの座標に写し、そこから単位円へ
  const sx = PATTERN_SIZE / width
  const sy = PATTERN_SIZE / height
  tile.setTransform(sx, 0, 0, sy, margin * sx, margin * sy)
  tile.transform(...m)
  tile.fillStyle = unitRadial(tile, paint)
  tile.fill()
  const pattern = ctx.createPattern(tile.canvas, 'no-repeat')
  if (!pattern) return last
  pattern.setTransform(new DOMMatrix([1 / sx, 0, 0, 1 / sy, -margin, -margin]))
  return pattern
}

/** 画像を、枠への収め方（fit）と切り抜きの拡大（scale）に従って描く。枠からはみ出した分は切り落とす */
function drawFitted(ctx: CanvasRenderingContext2D, bitmap: ImageBitmap, node: ImageNode): void {
  const rect = imageRect(node, bitmap)
  const overflows = rect.x < 0 || rect.y < 0 || rect.x + rect.width > node.width || rect.y + rect.height > node.height
  if (overflows) {
    ctx.beginPath()
    ctx.rect(0, 0, node.width, node.height)
    ctx.clip()
  }
  ctx.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height)
}

/**
 * 効果（影）を、次に描くものに付ける。影のずれは回転に従わない（図形を回しても、影は同じ向きに落ちる）。
 * Canvas は 1 回の描画に影を 1 つしか付けられないので、2 つ目からは図形を画面外へずらして影だけを先に描く
 */
function applyEffects(ctx: CanvasRenderingContext2D, pass: Pass, all: readonly Effect[]): void {
  const effects = splitEffects(all).drop
  if (effects.length === 0) return
  for (const effect of effects.slice(0, -1)) drawShadowOnly(ctx, pass, effect)
  setShadow(ctx, pass, effects[effects.length - 1])
}

/**
 * 内側の影を描く。図形で切り抜いたうえで、図形の外側（大きな矩形から図形をくり抜いた形）を塗り、その影だけを図形の内側へ落とす。
 * 外側そのものは切り抜きの外なので見えない。outline はパスを組み直す関数で、終わったら組み直して返す（続く線のため）
 */
function drawInnerShadows(
  ctx: CanvasRenderingContext2D,
  pass: Pass,
  node: Size & { fillRule?: CanvasFillRule },
  effects: readonly Effect[],
  outline: () => void,
): void {
  const inner = splitEffects(effects).inner
  if (inner.length === 0) return
  const rule = fillRuleOf(node)
  ctx.save()
  ctx.clip(rule)
  for (const shadow of inner) {
    const pad = Math.max(node.width, node.height) + shadow.blur * 2 + Math.abs(shadow.x) + Math.abs(shadow.y)
    if (!Number.isFinite(pad)) continue
    outline()
    // 偶奇で塗るので、矩形の中の図形（穴なら穴の外）がくり抜かれる
    ctx.rect(-pad, -pad, node.width + pad * 2, node.height + pad * 2)
    ctx.save()
    setShadow(ctx, pass, shadow)
    ctx.fillStyle = '#000000'
    ctx.fill('evenodd')
    ctx.restore()
  }
  ctx.restore()
  outline()
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
  style: Size & Pick<Style, 'strokes' | 'strokeWidth' | 'strokeDashes'> & { startCap: Cap; endCap: Cap; capSize: number },
): void {
  if (!hasStroke(style) || points.length < 2) return
  const { line, caps } = cappedStroke(points, style)
  for (const stroke of style.strokes) {
    ctx.save()
    ctx.globalAlpha *= stroke.opacity
    const color = paintStyle(ctx, stroke, style, capMarkerSize(style) + style.strokeWidth)
    ctx.beginPath()
    tracePath(ctx, line, false)
    ctx.strokeStyle = color
    ctx.lineWidth = style.strokeWidth
    ctx.setLineDash(style.strokeDashes)
    ctx.stroke()
    ctx.setLineDash([])

    // 端の図形はまとめて 1 回で塗る
    ctx.fillStyle = color
    ctx.beginPath()
    for (const cap of caps) {
      if (cap.kind === 'circle') {
        ctx.moveTo(cap.center.x + cap.radius, cap.center.y)
        ctx.arc(cap.center.x, cap.center.y, cap.radius, 0, Math.PI * 2)
      } else {
        cap.points.forEach((point, i) => (i === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)))
        ctx.closePath()
      }
    }
    if (caps.length > 0) ctx.fill()
    ctx.restore()
  }
}

/** roundRect に渡す 4 隅の半径。どの隅も枠の短い辺の半分までにする */
function clampRadius(radius: CornerRadius, size: Size): number[] {
  const limit = Math.min(size.width / 2, size.height / 2)
  return cornerRadii(radius).map((r) => Math.max(0, Math.min(r, limit)))
}

/** 線の太さや影も含めて、ノードが描かれうる範囲（ノードの座標系） */
function paintedRect(ctx: CanvasRenderingContext2D, node: SceneNode): Bounds {
  if (node.type === 'text') return textRect(ctx, node)
  const stroke = 'strokes' in node && node.strokes.length > 0 ? node.strokeWidth / 2 : 0
  const effects = 'effects' in node ? node.effects : []
  // ぼかしは指定した長さより少し外まで広がる。影のずれは回転に従わないので、どの向きにも余裕を取る
  const spread = Math.max(0, ...effects.map((shadow) => shadow.blur * 2 + Math.max(Math.abs(shadow.x), Math.abs(shadow.y))))
  // 端の形（矢印などの印、四角の端）は線より外へ張り出す
  const cap = node.type === 'path' && node.strokes.length > 0 ? capReach(node) : 0
  const outset = Math.max(stroke, cap) + spread
  return {
    x: -outset,
    y: -outset,
    width: node.width + outset * 2,
    height: node.height + outset * 2,
  }
}

/**
 * テキストが描かれうる範囲。固定の幅からはみ出す行や、高さの上限を超えた行は枠の外に描くので、行を並べた範囲まで広げる。
 * 字の形は行の箱から少しはみ出しうる（斜体や大きな飾り）ので、文字の大きさの半分だけ余裕を取る
 */
function textRect(ctx: CanvasRenderingContext2D, node: TextNode): Bounds {
  const lines = layoutText(ctx, node)
  const align = { left: 0, center: 0.5, right: 1 }[node.textAlign]
  let left = 0
  let right = node.width
  for (const line of lines) {
    const x = (node.width - line.width) * align
    left = Math.min(left, x)
    right = Math.max(right, x + line.width)
  }
  const bottom = Math.max(node.height, lines.length * node.fontSize * node.lineHeight)
  const margin = node.fontSize / 2
  return { x: left - margin, y: -margin, width: right - left + margin * 2, height: bottom + margin * 2 }
}

/**
 * ページ直下のフレームの左上に名前を出す。画面座標で描くのでズームしても文字の大きさは変わらない。
 * 回転したフレームでは、画面で上にある辺に沿わせて傾ける（`frameLabelPose`）。
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
    const { origin, angle } = frameLabelPose(node, viewport)
    if (angle === 0) {
      ctx.fillText(node.name, origin.x, origin.y - FRAME_LABEL_HEIGHT / 2)
      continue
    }
    ctx.save()
    ctx.translate(origin.x, origin.y)
    ctx.rotate((angle * Math.PI) / 180)
    ctx.fillText(node.name, 0, -FRAME_LABEL_HEIGHT / 2)
    ctx.restore()
  }
}
