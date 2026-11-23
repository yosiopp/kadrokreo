import {
  type Bounds,
  IDENTITY,
  type Matrix,
  type Size,
  intersects,
  multiply,
  contentMatrix,
  nodeMatrix,
  transformRect,
} from '../document/geometry.ts'
import { type Vertex, capMarkerSize, capReach, cappedStroke, dashCap, pathOutlines, tracePath } from '../document/path.ts'
import { alignFactor, blurRadius, clampedRadii, radialFocus, radialTransform, gradientLine, hasStroke, imageRect, isRounded, isShadow, shownPaints, splitEffects, stopCssColor, textInkBox, withoutHidden } from '../document/paint.ts'
import type {
  Asset,
  AssetId,
  Cap,
  ConicGradient,
  Effect,
  ImageNode,
  NodeId,
  Paint,
  RadialGradient,
  Scene,
  SceneNode,
  Shadow,
  Style,
  TextNode,
} from '../document/types.ts'
import { type MaskNode, hasMask, isMaskNode, maskContours, maskFillRule, maskOf, masksOf } from '../document/mask.ts'
import { drawnNode } from '../document/booleanNode.ts'
import { OVERLAY_COMPONENT } from './overlay.ts'
import { isVariantSet } from '../document/variants.ts'
import { getImage } from './images.ts'
import { drawBlurred } from './blur.ts'
import { FRAME_LABEL_FONT, FRAME_LABEL_HEIGHT, frameLabelPose } from './labels.ts'
import { applyFont, layoutText } from './text.ts'
import type { Viewport } from './viewport.ts'

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
  /**
   * 中身を描いている途中の合成用のキャンバスと、それを描き終えたら親へ重ねる方法。
   * 背景のぼかしが、合成の途中でもフレームの外側の絵まで見られるようにする（backdropOf）
   */
  open: Map<CanvasRenderingContext2D, OpenLayer>
}

/** 合成用のキャンバス（layer）を親（target）に重ねる。どちらも変換行列はそのまま渡し、呼ばれた側で単位行列にする */
type Merge = (target: CanvasRenderingContext2D, layer: CanvasRenderingContext2D) => void

/** 中身を描いている途中の合成用のキャンバス */
type OpenLayer = { parent: CanvasRenderingContext2D; merge: Merge }

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
    open: new Map(),
  }

  ctx.save()
  ctx.scale(viewport.zoom, viewport.zoom)
  ctx.translate(-viewport.x, -viewport.y)
  const roots = options.roots ?? []
  if (options.roots) {
    // 指定したノードだけを描くときも、かかっているマスクは（選んでいなくても）かける
    for (const root of roots) {
      ctx.save()
      ctx.transform(...root.parent)
      const mask = maskOf(scene, root.id)
      if (mask === null) drawNode(ctx, pass, root.id, root.parent)
      else drawMasked(ctx, pass, scene.nodes[mask] as MaskNode, root.parent, (c) => drawNode(c, pass, root.id, root.parent))
      ctx.restore()
    }
  } else {
    drawChildren(ctx, pass, scene.rootIds, IDENTITY)
  }
  ctx.restore()

  if (options.labels !== false) drawFrameLabels(ctx, scene, viewport, options)
  ctx.restore()
}

/**
 * 兄弟の並びを背面から描く。マスクは描かず、そこから次のマスクまでの兄弟をその形で切り取る（types.ts の Maskable）。
 * parent は親の座標系からページ座標系への変換で、ctx はすでに親の座標系になっている
 */
function drawChildren(ctx: CanvasRenderingContext2D, pass: Pass, ids: readonly NodeId[], parent: Matrix): void {
  if (!hasMask(pass.scene, ids)) {
    for (const id of ids) drawNode(ctx, pass, id, parent)
    return
  }
  // マスクごとに、かかる兄弟の並び（run）にまとめて描く
  const masks = masksOf(pass.scene, ids)
  let run: NodeId[] = []
  let current: NodeId | null = null
  const flush = () => {
    if (run.length === 0) return
    const list = run
    const draw = (c: CanvasRenderingContext2D) => list.forEach((id) => drawNode(c, pass, id, parent))
    if (current === null) draw(ctx)
    else drawMasked(ctx, pass, pass.scene.nodes[current] as MaskNode, parent, draw)
    run = []
  }
  ids.forEach((id, i) => {
    if (masks[i] !== current) {
      flush()
      current = masks[i]
    }
    run.push(id)
  })
  flush()
}

/**
 * draw で描くものを、マスクで切り取って描く（ctx は親の座標系）。形だけのマスクはパスで切り取り、
 * 不透明度・明るさのマスクは、中身とマスクを別のキャンバスに描いて destination-in で重ねる（明るさは先に不透明度に直す）
 */
function drawMasked(ctx: CanvasRenderingContext2D, pass: Pass, mask: MaskNode, parent: Matrix, draw: (c: CanvasRenderingContext2D) => void): void {
  if (mask.maskType === 'vector') {
    ctx.save()
    clipToMask(ctx, mask)
    draw(ctx)
    ctx.restore()
    return
  }
  // マスクの不透明度を先に作っておく。中身の背景のぼかしが、マスクをかけたあとの見た目を元にできるように
  const alpha = acquireLayer(ctx, pass.layerDepth)
  pass.layerDepth++
  // マスクは塗りだけを見る（線と効果は見ない）。ノードの不透明度は効く
  const shape = { ...mask, isMask: false, strokes: [], effects: [] }
  const local = nodeMatrix(mask)
  alpha.save()
  alpha.globalAlpha = mask.opacity
  alpha.transform(...local)
  drawContent(alpha, pass, shape, multiply(parent, local))
  alpha.restore()
  if (mask.maskType === 'luminance') luminanceToAlpha(alpha)
  const content = acquireLayer(ctx, pass.layerDepth)
  pass.layerDepth++
  // 途中の見た目は、中身の写しをマスクで切り抜いて重ねたもの（中身そのものは描き終えるまで切り抜けない）
  pass.open.set(content, {
    parent: ctx,
    merge: (target, layer) => {
      const cut = acquireScratch(maskScratch, layer)
      maskScratch = cut
      cut.drawImage(layer.canvas, 0, 0)
      cut.globalCompositeOperation = 'destination-in'
      cut.drawImage(alpha.canvas, 0, 0)
      cut.globalCompositeOperation = 'source-over'
      target.save()
      target.setTransform(1, 0, 0, 1, 0, 0)
      target.drawImage(cut.canvas, 0, 0)
      target.restore()
    },
  })
  draw(content)
  pass.open.delete(content)
  content.save()
  content.setTransform(1, 0, 0, 1, 0, 0)
  content.globalCompositeOperation = 'destination-in'
  content.drawImage(alpha.canvas, 0, 0)
  content.restore()
  pass.layerDepth -= 2
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(content.canvas, 0, 0)
  ctx.restore()
}

/** キャンバスの絵の明るさ（sRGB の輝度）に不透明度を掛けたものを、不透明度にする（SVG の明るさのマスクと同じ） */
function luminanceToAlpha(c: CanvasRenderingContext2D): void {
  const { width, height } = c.canvas
  if (width === 0 || height === 0) return
  const image = c.getImageData(0, 0, width, height)
  const data = image.data
  for (let i = 0; i < data.length; i += 4) {
    const luminance = (0.2125 * data[i] + 0.7154 * data[i + 1] + 0.0721 * data[i + 2]) / 255
    data[i + 3] = Math.round(luminance * data[i + 3])
    data[i] = data[i + 1] = data[i + 2] = 0
  }
  c.putImageData(image, 0, 0)
}

/** マスクの形で切り取る（ctx は親の座標系）。続けて描くものはその内側だけに描かれる */
function clipToMask(ctx: CanvasRenderingContext2D, mask: MaskNode): void {
  ctx.beginPath()
  for (const contour of maskContours(mask)) tracePath(ctx, contour.vertices, true)
  ctx.clip(maskFillRule(mask))
}

/** parent は、親の座標系からページ座標系への変換。ctx はすでに親の座標系になっている */
function drawNode(ctx: CanvasRenderingContext2D, pass: Pass, id: NodeId, parent: Matrix): void {
  // ブーリアン演算のノードは、結果の形のパスとして描く
  const node = drawnNode(pass.scene, pass.scene.nodes[id])
  if (!node.visible || node.opacity === 0) return
  // マスクは描かない（形で兄弟を切り取るだけ）
  if (isMaskNode(node)) return

  // テキスト・画像の裏返しは中身を描くときだけ掛ける（枠は同じ矩形）。影のずれは画面の向きで付くので裏返らない
  const local = contentMatrix(node)
  const world = multiply(parent, local)
  // はみ出した子を描くフレーム以外は、画面外なら丸ごと省ける
  const selfContained = node.type !== 'frame' || node.clipContent
  if (selfContained && !intersects(transformRect(world, paintedRect(ctx, node)), pass.visible)) return

  const effects = shownPaints(node.effects)
  // 背景のぼかしは、ノードより先に描いてあるもの（後ろに見えているもの）をノードの形の内側でぼかす
  const backgroundBlur = blurRadius(effects, 'background-blur')
  if (backgroundBlur > 0) blurBackdrop(ctx, pass, node, local, backgroundBlur)

  // 半透明や描画モードを持つフレームと、ぼかすノードは、中身を別のキャンバスに描いてから 1 枚の絵として重ねる。
  // 子を 1 つずつ半透明で描くと、子どうしの重なりが透けてしまう
  const layerBlur = blurRadius(effects, 'layer-blur')
  // 通過のフレームは、後ろの絵の写しに子を直接混ぜて描き、それを不透明度で後ろと混ぜる（子の描画モードが後ろにも効く）
  if (isPassThrough(node) && layerBlur === 0) {
    const layer = acquireLayer(ctx, pass.layerDepth)
    layer.setTransform(1, 0, 0, 1, 0, 0)
    layer.drawImage(ctx.canvas, 0, 0)
    layer.setTransform(ctx.getTransform())
    // 後ろ × (1 - 不透明度) + 混ぜた絵 × 不透明度。写しの外は後ろと同じなので変わらない
    const alpha = ctx.globalAlpha * node.opacity
    const merge: Merge = (target, drawn) => {
      target.save()
      target.setTransform(1, 0, 0, 1, 0, 0)
      target.globalAlpha = alpha
      target.globalCompositeOperation = 'destination-out'
      target.fillStyle = '#000000'
      target.fillRect(0, 0, target.canvas.width, target.canvas.height)
      target.globalCompositeOperation = 'lighter'
      target.drawImage(drawn.canvas, 0, 0)
      target.restore()
    }
    drawLayer(ctx, pass, layer, merge, node, local, world)
    return
  }
  const group = node.type === 'frame' && node.children.length > 0 && (node.opacity < 1 || node.blendMode !== 'normal')
  if (group || layerBlur > 0) {
    const alpha = ctx.globalAlpha * node.opacity
    const merge: Merge = (target, drawn) => {
      target.save()
      target.globalAlpha = alpha
      if (node.blendMode !== 'normal') target.globalCompositeOperation = node.blendMode
      target.setTransform(1, 0, 0, 1, 0, 0)
      // ぼかしの半径の半分が標準偏差（CSS の blur() の値）。filter の長さは変換行列に従わないので、拡大率を掛ける
      if (layerBlur > 0) drawBlurred(target, drawn, (layerBlur / 2) * pass.scale)
      else target.drawImage(drawn.canvas, 0, 0)
      target.restore()
    }
    drawLayer(ctx, pass, acquireLayer(ctx, pass.layerDepth), merge, node, local, world)
    return
  }

  ctx.save()
  ctx.globalAlpha *= node.opacity
  if (node.blendMode !== 'normal') ctx.globalCompositeOperation = node.blendMode
  ctx.transform(...local)
  drawContent(ctx, pass, node, world)
  ctx.restore()
}

/** ノードの中身を合成用のキャンバス（layer）に描き、merge で ctx に重ねる。描いている間は pass.open に載せておく */
function drawLayer(ctx: CanvasRenderingContext2D, pass: Pass, layer: CanvasRenderingContext2D, merge: Merge, node: SceneNode, local: Matrix, world: Matrix): void {
  pass.layerDepth++
  pass.open.set(layer, { parent: ctx, merge })
  layer.transform(...local)
  drawContent(layer, pass, node, world)
  pass.open.delete(layer)
  pass.layerDepth--
  merge(ctx, layer)
}

/** 通過のフレームとして描くか。不透明なら、まとめずに描くふつうの道と同じ見た目なので、写しを作らない */
function isPassThrough(node: SceneNode): boolean {
  return node.type === 'frame' && node.passThrough && node.blendMode === 'normal' && node.opacity < 1 && node.children.length > 0
}

/**
 * 背景のぼかし。ノードの形で切り抜き、後ろに見えている絵をぼかして描き直す（ノードの不透明度にはよらない）。
 * 半透明のフレームの中など、別のキャンバスに描いている途中でも、フレームの外側の絵までぼかす（backdropOf）。
 * ぼかした絵はそのフレームの中身の一部になり、ほかの中身と同じくフレームの不透明度・描画モードで後ろに重なる
 */
function blurBackdrop(ctx: CanvasRenderingContext2D, pass: Pass, node: SceneNode, local: Matrix, blur: number): void {
  if (node.type === 'text') {
    if (node.id !== pass.options.hiddenId) blurTextBackdrop(ctx, pass, node, local, blur)
    return
  }
  // 後ろの絵を写しておき、形の内側を消してから、写しをぼかして描き戻す（そのまま重ねると、ぼけた絵の下に元の絵が残る）
  const copy = backdropOf(ctx, pass)
  ctx.save()
  ctx.transform(...local)
  traceShape(ctx, node)
  ctx.clip(fillRuleOf(node))
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  drawBlurred(ctx, copy, (blur / 2) * pass.scale)
  ctx.restore()
}

/**
 * 文字の背景のぼかし。文字はパスで切り抜けないので、文字の形を別のキャンバスに描き、その形で今の絵を消してから、
 * 同じ形で切り抜いたぼかした絵を重ねる
 */
function blurTextBackdrop(ctx: CanvasRenderingContext2D, pass: Pass, node: TextNode, local: Matrix, blur: number): void {
  const copy = backdropOf(ctx, pass)
  const shape = acquireLayer(ctx, pass.layerDepth + 1)
  shape.transform(...local)
  shape.fillStyle = '#000000'
  textShape(shape, node).silhouette(shape, 0)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'destination-out'
  ctx.drawImage(shape.canvas, 0, 0)
  shape.save()
  shape.setTransform(1, 0, 0, 1, 0, 0)
  shape.globalCompositeOperation = 'source-in'
  drawBlurred(shape, copy, (blur / 2) * pass.scale)
  shape.restore()
  ctx.globalCompositeOperation = 'source-over'
  ctx.drawImage(shape.canvas, 0, 0)
  ctx.restore()
}

/** 文字の並び。ctx に書体を設定し、行・行揃え・行の高さ・ベースラインと、文字の形を描く関数（影・切り抜き用）を返す */
function textShape(ctx: CanvasRenderingContext2D, node: TextNode) {
  const { width } = node
  applyFont(ctx, node)
  ctx.textBaseline = 'alphabetic'
  // CSS の行ボックスと同じ位置にベースラインを置き、編集中の入力欄と文字がずれないようにする
  const metrics = ctx.measureText('')
  const lineHeight = node.fontSize * node.lineHeight
  const contentHeight = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent
  const baseline = (lineHeight - contentHeight) / 2 + metrics.fontBoundingBoxAscent
  const align = alignFactor(node.textAlign)
  const lines = layoutText(ctx, node)
  // 文字の影は、文字の形を別のキャンバスに描いてから影だけを落とす（行が分かれていても 1 つの形として）
  const silhouette: Silhouette = (c, spread) => {
    applyFont(c, node)
    c.textBaseline = 'alphabetic'
    c.lineJoin = 'round'
    lines.forEach((line, i) => {
      const x = (width - line.width) * align
      const y = lineHeight * i + baseline
      if (spread >= 0) c.fillText(line.text, x, y)
      if (spread > 0) {
        c.lineWidth = spread * 2
        c.strokeText(line.text, x, y)
      }
    })
    // 細らせるのは、縁を太い線で消す
    if (spread < 0) {
      lines.forEach((line, i) => c.fillText(line.text, (width - line.width) * align, lineHeight * i + baseline))
      c.globalCompositeOperation = 'destination-out'
      c.lineWidth = -spread * 2
      lines.forEach((line, i) => c.strokeText(line.text, (width - line.width) * align, lineHeight * i + baseline))
      c.globalCompositeOperation = 'source-over'
    }
  }
  return { lines, align, lineHeight, baseline, silhouette }
}

/** ノードの形のパスを組む（テキスト以外）。描画と同じ形 */
function traceShape(ctx: CanvasRenderingContext2D, node: Exclude<SceneNode, TextNode>): void {
  ctx.beginPath()
  switch (node.type) {
    case 'ellipse':
      ctx.ellipse(node.width / 2, node.height / 2, node.width / 2, node.height / 2, 0, 0, Math.PI * 2)
      break
    case 'path':
      for (const contour of pathOutlines(node)) tracePath(ctx, contour.vertices, contour.closed)
      break
    default:
      ctx.roundRect(0, 0, node.width, node.height, clampedRadii(node.cornerRadius, node.width, node.height))
  }
}

/**
 * 背景のぼかしの元にする、いま後ろに見えている絵の写し（変換行列は単位行列）。ふつうは ctx の絵の写し。
 * ctx が合成の途中のキャンバスなら、外側から順に、開いている合成をすべて今の時点で重ねた絵（ページを描き終えたときと同じ重ね方）にする。
 * 親が切り取っている範囲は分からないので、写しでは切り取らない（ぼかしのにじみに、切り取られて見えない中身が少し入りうる）
 */
function backdropOf(ctx: CanvasRenderingContext2D, pass: Pass): CanvasRenderingContext2D {
  const chain: [CanvasRenderingContext2D, OpenLayer][] = []
  let base = ctx
  for (let open = pass.open.get(base); open; open = pass.open.get(base)) {
    chain.unshift([base, open])
    base = open.parent
  }
  const copy = chain.length === 0 ? acquireLayer(ctx, pass.layerDepth) : (backdropScratch = acquireScratch(backdropScratch, ctx))
  copy.setTransform(1, 0, 0, 1, 0, 0)
  copy.drawImage(base.canvas, 0, 0)
  for (const [layer, open] of chain) open.merge(copy, layer)
  copy.setTransform(1, 0, 0, 1, 0, 0)
  return copy
}

let backdropScratch: CanvasRenderingContext2D | null = null
let maskScratch: CanvasRenderingContext2D | null = null

/** 合成の深さによらない作業用のキャンバス。target と同じ大きさにし、空にして単位行列で返す */
function acquireScratch(scratch: CanvasRenderingContext2D | null, target: CanvasRenderingContext2D): CanvasRenderingContext2D {
  const c = scratch ?? document.createElement('canvas').getContext('2d')!
  const { width, height } = target.canvas
  if (c.canvas.width !== width || c.canvas.height !== height) {
    c.canvas.width = width
    c.canvas.height = height
  }
  c.setTransform(1, 0, 0, 1, 0, 0)
  c.globalAlpha = 1
  c.globalCompositeOperation = 'source-over'
  c.clearRect(0, 0, width, height)
  return c
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
      const outline = (c = ctx) => traceShape(c, node)
      outline()
      paint(ctx, pass, node, outline)
      break
    }
    case 'ellipse': {
      const outline = (c = ctx) => traceShape(c, node)
      outline()
      paint(ctx, pass, node, outline)
      break
    }
    case 'path': {
      const outlines = pathOutlines(node)
      const points = outlines[0].vertices
      const outline = (c = ctx) => {
        c.beginPath()
        for (const contour of outlines) tracePath(c, contour.vertices, contour.closed)
      }
      // 両端が同じ丸・四角の破線は、Canvas の lineCap で破線の 1 本ごとに端の形を付ける（線の両端もそれで付く）
      const cap = dashCap(node)
      const capped = cap === null && !node.closed && (node.startCap !== 'none' || node.endCap !== 'none')
      if (!capped) {
        outline()
        ctx.save()
        if (cap !== null) ctx.lineCap = cap
        paint(ctx, pass, node, outline)
        ctx.restore()
        break
      }
      // 端の形を付ける線は、線を矢印の分だけ短くし、端の図形を足すので、塗りと線を別々に描く
      outline()
      fillAll(ctx, pass, node, node.effects, filledSilhouette(outline, fillRuleOf(node)))
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
        const { lines, align, lineHeight, baseline, silhouette } = textShape(ctx, node)
        const { drop: drops, inner } = splitEffects(node.effects)
        for (const shadow of drops) drawMaskedShadow(ctx, pass, shadow, silhouette, false)
        for (const fill of node.fills) {
          // 固定の幅からはみ出す行もあるので、文字の大きさの分だけ外まで覆う
          ctx.save()
          ctx.globalAlpha *= fill.opacity
          if (fill.blendMode !== 'normal') ctx.globalCompositeOperation = fill.blendMode
          ctx.fillStyle = paintStyle(ctx, fill, node, node.fontSize)
          lines.forEach((line, i) => {
            ctx.fillText(line.text, (width - line.width) * align, lineHeight * i + baseline)
          })
          ctx.restore()
        }
        // 内側の影は、別のキャンバスに影を描いてから文字の形で切り抜いて重ねる（パスで切り抜けないため）
        for (const shadow of inner) drawTextInnerShadow(ctx, pass, shadow, silhouette)
      }
      break
    case 'image': {
      const asset = pass.assets[node.assetId]
      const bitmap = asset ? getImage(asset) : null
      const outline = (c = ctx) => traceShape(c, node)
      // 画像の影は枠（角丸を含む）の形に付ける。画像は角丸で切り抜くので、影は画像に付けず先に描く
      if (node.effects.some(isShadow)) {
        outline()
        drawDropShadows(ctx, pass, node.effects, filledSilhouette(outline, 'nonzero'), false)
      }
      ctx.save()
      if (isRounded(node.cornerRadius)) {
        outline()
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
      if (splitEffects(node.effects).inner.length > 0) {
        outline()
        drawInnerShadows(ctx, pass, node, node.effects, outline)
      }
      break
    }
    case 'frame': {
      const outline = (c = ctx) => traceShape(c, node)
      outline()
      fillAll(ctx, pass, node, node.effects, filledSilhouette(outline, 'nonzero'))
      // 内側の影は背景の上、子の下（CSS の inset の box-shadow と同じ）
      drawInnerShadows(ctx, pass, node, node.effects, outline)
      ctx.save()
      if (node.clipContent) ctx.clip()
      drawChildren(ctx, pass, node.children, world)
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
function paint(ctx: CanvasRenderingContext2D, pass: Pass, node: Size & Style, outline: Outline): void {
  fillAll(ctx, pass, node, node.effects, filledSilhouette(outline, fillRuleOf(node)))
  drawInnerShadows(ctx, pass, node, node.effects, outline)
  if (hasStroke(node)) {
    ctx.save()
    if (node.fills.length === 0) {
      // 線だけの形は、線の形が影になる。広がりは線の太さに足す
      const silhouette: Silhouette = (c, spread) => {
        c.lineWidth = Math.max(0, node.strokeWidth + spread * 2)
        c.setLineDash(node.strokeDashes)
        c.lineDashOffset = node.strokeDashOffset
        c.lineJoin = node.strokeJoin
        // 破線の端の形（呼ぶ側が ctx に付けたもの）を、影を描く別のキャンバスにも
        c.lineCap = ctx.lineCap
        outline(c)
        c.stroke()
      }
      drawDropShadows(ctx, pass, node.effects, silhouette, true)
    }
    strokeAll(ctx, node)
    ctx.restore()
  }
}

/** パスを組み直す関数。引数を省くと描いている ctx に組む */
type Outline = (c?: CanvasRenderingContext2D) => void

/**
 * 影を落とす形を c に不透明で描く関数。spread だけ太らせる（負なら細らせる）。影の広がりと、文字の影に使う。
 * c はノードの座標系になっている
 */
type Silhouette = (c: CanvasRenderingContext2D, spread: number) => void

/** パスで塗る形の Silhouette。太らせるのは縁に太い線を足し、細らせるのは縁を太い線で消す（角は丸くなる） */
function filledSilhouette(outline: Outline, rule: CanvasFillRule): Silhouette {
  return (c, spread) => {
    outline(c)
    c.fill(rule)
    if (spread === 0) return
    c.save()
    c.lineJoin = 'round'
    c.lineWidth = Math.abs(spread) * 2
    if (spread < 0) c.globalCompositeOperation = 'destination-out'
    c.stroke()
    c.restore()
  }
}

/** いま組んであるパスを、塗りを下から順に重ねて塗る。落ち影は一番下の塗りに付ける */
function fillAll(
  ctx: CanvasRenderingContext2D,
  pass: Pass,
  node: Size & Pick<Style, 'fills'>,
  effects: readonly Effect[],
  silhouette: Silhouette,
): void {
  node.fills.forEach((fill, i) => {
    ctx.save()
    ctx.globalAlpha *= fill.opacity
    if (fill.blendMode !== 'normal') ctx.globalCompositeOperation = fill.blendMode
    if (i === 0) drawDropShadows(ctx, pass, effects, silhouette, true)
    if (fill.type === 'radial') fillRadial(ctx, fill, node, fillRuleOf(node))
    else {
      ctx.fillStyle = paintStyle(ctx, fill, node)
      ctx.fill(fillRuleOf(node))
    }
    ctx.restore()
  })
}

/** いま組んであるパスに、線を下から順に重ねて引く */
function strokeAll(ctx: CanvasRenderingContext2D, node: Size & Pick<Style, 'strokes' | 'strokeWidth' | 'strokeDashes' | 'strokeDashOffset' | 'strokeJoin'>): void {
  ctx.lineWidth = node.strokeWidth
  ctx.setLineDash(node.strokeDashes)
  ctx.lineDashOffset = node.strokeDashOffset
  ctx.lineJoin = node.strokeJoin
  for (const stroke of node.strokes) {
    ctx.save()
    ctx.globalAlpha *= stroke.opacity
    if (stroke.blendMode !== 'normal') ctx.globalCompositeOperation = stroke.blendMode
    ctx.strokeStyle = paintStyle(ctx, stroke, node, node.strokeWidth)
    ctx.stroke()
    ctx.restore()
  }
  ctx.setLineDash([])
  ctx.lineDashOffset = 0
  ctx.lineJoin = 'miter'
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
  if (![from.x, from.y, to.x, to.y].every(Number.isFinite)) return stopCssColor(paint.stops[0])
  const gradient = ctx.createLinearGradient(from.x, from.y, to.x, to.y)
  for (const stop of paint.stops) gradient.addColorStop(stop.offset, stopCssColor(stop))
  return gradient
}

/** 角度のグラデーション。Canvas の角度も右が 0 で時計回りなので、angle をそのまま使う */
function conicGradient(ctx: CanvasRenderingContext2D, paint: ConicGradient, size: Size): string | CanvasGradient {
  const x = paint.cx * size.width
  const y = paint.cy * size.height
  if (!Number.isFinite(x) || !Number.isFinite(y)) return stopCssColor(paint.stops[0])
  // 極端に大きい角度でラジアンが Infinity にならないよう、先に 1 周に収める
  const gradient = ctx.createConicGradient(((paint.angle % 360) * Math.PI) / 180, x, y)
  for (const stop of paint.stops) gradient.addColorStop(stop.offset, stopCssColor(stop))
  return gradient
}

/** 円形のグラデーションの楕円を単位円に写す変換（ノードの座標系で）。楕円がつぶれていれば null */
function radialMatrix(paint: RadialGradient, size: Size): Matrix | null {
  const m = radialTransform(paint, size)
  return paint.rx * size.width > 0 && paint.ry * size.height > 0 && m.every(Number.isFinite) ? m : null
}

/** 焦点から半径 1 の円へ色を変える CanvasGradient。楕円にするのは変換行列の役目 */
function unitRadial(ctx: CanvasRenderingContext2D, paint: RadialGradient): CanvasGradient {
  const focus = radialFocus(paint)
  const gradient = ctx.createRadialGradient(focus.x, focus.y, 0, 0, 0, 1)
  for (const stop of paint.stops) gradient.addColorStop(stop.offset, stopCssColor(stop))
  return gradient
}

/**
 * いま組んであるパスを円形のグラデーションで塗る。パスは組んだときの座標で決まっているので、
 * 変換行列を楕円に合わせてから塗れば、グラデーションだけが楕円になる（影は変換行列に従わない）
 */
function fillRadial(ctx: CanvasRenderingContext2D, paint: RadialGradient, size: Size, rule: CanvasFillRule = 'nonzero'): void {
  const m = radialMatrix(paint, size)
  if (!m) {
    ctx.fillStyle = stopCssColor(paint.stops[paint.stops.length - 1])
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
  const last = stopCssColor(paint.stops[paint.stops.length - 1])
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
 * 落ち影を描く。影のずれは回転に従わない（図形を回しても、影は同じ向きに落ちる）。attach なら最後の影は次に描くものに付ける。
 * Canvas は 1 回の描画に影を 1 つしか付けられないので、ほかは形を別のキャンバスに描いてから影だけを先に落とす（drawMaskedShadow。
 * 広がりのある影は太らせた形で）。組んであるパスは座標を変えても動かないので、パスを画面外へずらして影だけを描くことはできない
 */
function drawDropShadows(
  ctx: CanvasRenderingContext2D,
  pass: Pass,
  all: readonly Effect[],
  silhouette: Silhouette,
  attach: boolean,
): void {
  if (all.length === 0) return
  const drops = splitEffects(all).drop
  if (drops.length === 0) return
  const plain = drops.filter((shadow) => shadow.spread === 0)
  for (const shadow of drops) if (shadow.spread !== 0) drawMaskedShadow(ctx, pass, shadow, silhouette, false)
  // 描画モードのある影は、図形と一緒に描くと図形にも描画モードがかかるので、付けずに先に描く
  const last = attach && plain.at(-1)?.blendMode === 'normal' ? plain.pop() : undefined
  for (const shadow of plain) drawMaskedShadow(ctx, pass, shadow, silhouette, false)
  if (last) setShadow(ctx, pass, last)
}

/**
 * 形（silhouette）を別のキャンバスに描き、その影だけを ctx に落とす。inner なら、形の外側（細らせた形をくり抜いた全体）を描いて、
 * 影を形の内側へ落とす（呼ぶ側が形で切り抜いておく）
 */
function drawMaskedShadow(ctx: CanvasRenderingContext2D, pass: Pass, shadow: Shadow, silhouette: Silhouette, inner: boolean): void {
  const mask = acquireLayer(ctx, pass.layerDepth)
  mask.fillStyle = '#000000'
  mask.strokeStyle = '#000000'
  if (inner) {
    mask.save()
    mask.setTransform(1, 0, 0, 1, 0, 0)
    mask.fillRect(0, 0, mask.canvas.width, mask.canvas.height)
    mask.restore()
    // 内側の影の広がりは、くり抜く形を細らせる
    mask.globalCompositeOperation = 'destination-out'
    silhouette(mask, -shadow.spread)
    mask.globalCompositeOperation = 'source-over'
  } else silhouette(mask, shadow.spread)
  const far = 100_000
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  setShadow(ctx, pass, shadow)
  blendShadow(ctx, shadow)
  ctx.shadowOffsetX += far
  ctx.drawImage(mask.canvas, -far, 0)
  ctx.restore()
}

/**
 * 文字の内側の影。影を別のキャンバスに描き、文字の形（silhouette）で切り抜いてから ctx に重ねる
 */
function drawTextInnerShadow(ctx: CanvasRenderingContext2D, pass: Pass, shadow: Shadow, silhouette: Silhouette): void {
  const layer = acquireLayer(ctx, pass.layerDepth)
  pass.layerDepth++
  drawMaskedShadow(layer, pass, shadow, silhouette, true)
  // 文字は行ごとに描くので、形を別のキャンバスにまとめてから 1 回で切り抜く（destination-in は 1 回の描画の外を消すため）
  const shape = acquireLayer(ctx, pass.layerDepth)
  pass.layerDepth--
  shape.fillStyle = '#000000'
  silhouette(shape, 0)
  layer.save()
  layer.setTransform(1, 0, 0, 1, 0, 0)
  layer.globalCompositeOperation = 'destination-in'
  layer.drawImage(shape.canvas, 0, 0)
  layer.restore()
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  blendShadow(ctx, shadow)
  ctx.drawImage(layer.canvas, 0, 0)
  ctx.restore()
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
  outline: Outline,
): void {
  if (effects.length === 0) return
  const inner = splitEffects(effects).inner
  if (inner.length === 0) return
  const rule = fillRuleOf(node)
  ctx.save()
  ctx.clip(rule)
  for (const shadow of inner) {
    if (shadow.spread !== 0) {
      drawMaskedShadow(ctx, pass, shadow, filledSilhouette(outline, rule), true)
      continue
    }
    const pad = Math.max(node.width, node.height) + shadow.blur * 2 + Math.abs(shadow.x) + Math.abs(shadow.y)
    if (!Number.isFinite(pad)) continue
    outline()
    // 偶奇で塗るので、矩形の中の図形（穴なら穴の外）がくり抜かれる
    ctx.rect(-pad, -pad, node.width + pad * 2, node.height + pad * 2)
    ctx.save()
    setShadow(ctx, pass, shadow)
    blendShadow(ctx, shadow)
    ctx.fillStyle = '#000000'
    ctx.fill('evenodd')
    ctx.restore()
  }
  ctx.restore()
  outline()
}

/** 影の描画モード（既存のデザインツールの影ごとの描画モード）。呼ぶ側が save / restore で囲む */
function blendShadow(ctx: CanvasRenderingContext2D, shadow: Shadow): void {
  if (shadow.blendMode !== 'normal') ctx.globalCompositeOperation = shadow.blendMode
}

function setShadow(ctx: CanvasRenderingContext2D, pass: Pass, shadow: Shadow): void {
  const alpha = Math.round(shadow.opacity * 255)
  ctx.shadowColor = shadow.color + alpha.toString(16).padStart(2, '0')
  ctx.shadowBlur = shadow.blur * pass.scale
  ctx.shadowOffsetX = shadow.x * pass.scale
  ctx.shadowOffsetY = shadow.y * pass.scale
}

/** 頂点を順につないだ線（曲線を含む）を引き、両端に端の形を描く */
function strokeWithCaps(
  ctx: CanvasRenderingContext2D,
  points: readonly Vertex[],
  style: Size & Pick<Style, 'strokes' | 'strokeWidth' | 'strokeDashes' | 'strokeDashOffset' | 'strokeJoin'> & { startCap: Cap; endCap: Cap; capSize: number },
): void {
  if (!hasStroke(style) || points.length < 2) return
  const { line, caps } = cappedStroke(points, style)
  for (const stroke of style.strokes) {
    ctx.save()
    ctx.globalAlpha *= stroke.opacity
    if (stroke.blendMode !== 'normal') ctx.globalCompositeOperation = stroke.blendMode
    const color = paintStyle(ctx, stroke, style, capMarkerSize(style) + style.strokeWidth)
    ctx.beginPath()
    tracePath(ctx, line, false)
    ctx.strokeStyle = color
    ctx.lineWidth = style.strokeWidth
    ctx.setLineDash(style.strokeDashes)
    ctx.lineDashOffset = style.strokeDashOffset
    ctx.lineJoin = style.strokeJoin
    ctx.stroke()
    ctx.setLineDash([])
    ctx.lineDashOffset = 0
    ctx.lineJoin = 'miter'

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

/** 線の太さや影も含めて、ノードが描かれうる範囲（ノードの座標系） */
export function paintedRect(ctx: CanvasRenderingContext2D, node: SceneNode): Bounds {
  // ぼかしは指定した長さより少し外まで広がる。影のずれは回転に従わないので、どの向きにも余裕を取る
  const spread = Math.max(
    0,
    ...node.effects.map((effect) =>
      isShadow(effect) ? effect.blur * 2 + Math.max(0, effect.spread) + Math.max(Math.abs(effect.x), Math.abs(effect.y)) : effect.blur * 2,
    ),
  )
  if (node.type === 'text') {
    const rect = textRect(ctx, node)
    return { x: rect.x - spread, y: rect.y - spread, width: rect.width + spread * 2, height: rect.height + spread * 2 }
  }
  const stroke = 'strokes' in node && node.strokes.length > 0 ? node.strokeWidth / 2 : 0
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
  const ink = textInkBox(node, layoutText(ctx, node))
  const bottom = Math.max(node.height, ink.height)
  const margin = node.fontSize / 2
  return { x: ink.x - margin, y: -margin, width: ink.width + margin * 2, height: bottom + margin * 2 }
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
