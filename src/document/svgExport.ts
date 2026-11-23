import { IDENTITY, type Matrix, contentMatrix, flipMatrix, getWorldMatrix, invert, multiply, nodeMatrix, tidy, transformRect } from './geometry.ts'
import { drawnNode } from './booleanNode.ts'
import { readImageInfo } from './imageInfo.ts'
import { type TextLinesOf, alignFactor, blurRadius, clampedRadii, getPaintedBounds, hasStroke, imageRect, isRounded, isShadow, solidPaint, splitEffects, withoutHidden } from './paint.ts'
import { KAPPA, type MaskNode, isMaskNode, maskContours, maskFillRule, maskOf, masksOf } from './mask.ts'
import { contoursData, isLine } from './path.ts'
import { dataUri, escapeXml, gradientDef, pathSvg, strokeShapeAttrs } from './svgShapes.ts'
import type {
  Asset,
  AssetId,
  BlendMode,
  CornerRadius,
  ImageNode,
  NodeId,
  Paint,
  Scene,
  SceneNode,
  Shadow,
  Style,
  TextNode,
} from './types.ts'

// ノードを SVG ファイルにする（viewer・editor・CLI の「SVG に書き出し」）。ドキュメントは変えない。
// 描画（canvas/render.ts）と同じ見た目になるように書く:
// - 矩形は rect（4 隅の角丸が違えば path）、楕円は ellipse、直線・パスは line / path（svgShapes.ts を Dev モードの HTML と共有）。
// - フレームは g（回転・位置は transform、不透明度は g の opacity なので子の重なりは透けない）。背景の塗りは rect、
//   切り取りは clipPath、枠線は子より手前の rect。
// - 塗りは単色・linearGradient・radialGradient（userSpaceOnUse でノードの座標系に書く）。塗りがいくつもあれば、描画と同じく
//   要素を下から順に重ねる。塗りごとの不透明度は fill-opacity / stroke-opacity（グラデーションは stop-opacity）。
// - 影は filter。落ち影は一番下の塗りに付け（塗りがなければ線に）、内側の影は一番上の塗りに付ける。ずれは回転に従わない（ノードの向きに直して書く）。
// - 影の広がりは feMorphology（四角く太らせる・細らせるので、角は描画より角張る）。
// - 描画モードは style の mix-blend-mode（ノードは要素か g に、塗りは塗りの要素に）。
// - レイヤーのぼかしは feGaussianBlur の filter を g に付ける。背景のぼかしは SVG で表せないので書かない（コメントを残す）。
// - テキストの影は text に filter で付ける（落ち影は一番下の塗り、内側の影は一番上の塗り）。画像の影は、枠の形の黒い要素に影だけを出す filter を付けて、画像の下（内側の影は上）に置く。
// - 角度のグラデーションは SVG にないので、扇形を並べた pattern で近似する（svgShapes.ts の gradientDef）。
// - 隠した塗り・線・効果（visible が false）は書かない。
// - テキストは text と、行ごとの tspan。行の区切り（折り返し）は呼び出し側が渡す（ブラウザは Canvas で、CLI は見積もりで測る）。
//   フォントは埋め込まず、名前だけを書く（kdr は書体のファイルを持たず、OS の書体は再配布できないものが多いため）。1 行目の基線は、呼び出し側がフォントの実際の高さ（textMetrics）を
//   渡せば描画と同じ位置に、渡さなければ SVG の取り込みと同じ見積もり（文字の上 0.9・下 0.22）で置く。
// - 画像は data URI の image。fit と切り抜きは imageRect で置き、枠の外は clipPath で切る。
// - マスク（isMask）は書かず、そこから次のマスクまでの兄弟を、マスクの形の path の clipPath をかけた g にまとめる。
//   不透明度・明るさのマスク（maskType）は、マスクの図形を塗りだけで描いた mask にする。
// - ブーリアン演算のノードは、結果の形の path（evenodd）として書く（子は書かない）。
// 取り込み（editor/svg/）で読み戻すと同じ形になることを svgExport.test.ts で確かめている。

/** テキストを描く行に分ける（canvas/text.ts の layoutText と同じ結果を返すもの）。行の幅を返せば、範囲に横へはみ出す行も含める */
export type SvgTextLines = TextLinesOf

/** フォントの上下の高さ（px）。Canvas の measureText の fontBoundingBoxAscent / fontBoundingBoxDescent に当たる */
export type SvgTextMetrics = (node: TextNode) => { ascent: number; descent: number }

export type SvgExportOptions = {
  assets: Record<AssetId, Asset>
  /** テキストの行分け。省略すると改行だけで分ける（折り返さない） */
  textLines?: SvgTextLines
  /** フォントの実際の高さ。省略すると SVG の取り込みと同じ見積もり（文字の上 0.9・下 0.22）で基線を置く */
  textMetrics?: SvgTextMetrics
  /** レイヤー名から作る id を付けるか（既定は付ける。取り込むとレイヤー名に戻る） */
  ids?: boolean
  /** 範囲全体に敷く背景の色（#rrggbb など）。省略すると透明 */
  background?: string
}

/** SVG の取り込み（editor/svg/convert.ts）と同じ、フォントの高さの見積もり */
export function estimateTextMetrics(node: Pick<TextNode, 'fontSize'>): { ascent: number; descent: number } {
  return { ascent: node.fontSize * 0.9, descent: node.fontSize * 0.22 }
}

/**
 * 1 行目の基線の、テキストの枠の上からの位置。描画（canvas/render.ts）と同じく、行の高さの中でフォントの上下の高さを真ん中に置く
 * （CSS の行ボックスと同じ）
 */
export function textBaseline(node: Pick<TextNode, 'fontSize' | 'lineHeight'>, metrics: { ascent: number; descent: number }): number {
  return (node.fontSize * node.lineHeight - (metrics.ascent + metrics.descent)) / 2 + metrics.ascent
}

/**
 * targets のノードを 1 つの SVG ファイルの文字列にする。targets は重なり順（背面が先）に並べ、親子を一緒に含めないこと。
 * 範囲は PNG の書き出しと同じく、それらを囲む矩形に影・ぼかし・線の太さ・枠からはみ出すテキストの行（textLines を渡したとき）を足したもの
 */
export function exportSvg(scene: Scene, targets: readonly NodeId[], options: SvgExportOptions): string {
  // 影・ぼかし・枠からはみ出すテキストの行まで含める（getPaintedBounds）
  const bounds = getPaintedBounds(scene, targets, options.textLines)
  if (!bounds) throw new Error('書き出すものがありません')
  const writer = new SvgWriter(scene, options)
  const body = targets
    .map((id) => {
      const parent = getWorldMatrix(scene, scene.nodes[id].parentId)
      const element = writer.node(id, multiply(parent, nodeMatrix(scene.nodes[id])), parent)
      // かかっているマスクは、選んでいなくてもかける（描画と同じ）
      const mask = maskOf(scene, id)
      return mask === null || element === '' ? element : writer.masked(scene.nodes[mask] as MaskNode, parent, element)
    })
    .join('')
  const width = tidy(Math.max(bounds.width, 0))
  const height = tidy(Math.max(bounds.height, 0))
  const defs = writer.defs.length > 0 ? `<defs>${writer.defs.join('')}</defs>\n` : ''
  // 背景は id を付けない矩形（取り込み直すと矩形のノードになる）
  const background =
    options.background === undefined
      ? ''
      : `<rect x="${tidy(bounds.x)}" y="${tidy(bounds.y)}" width="${width}" height="${height}" fill="${escapeXml(options.background)}"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="${tidy(bounds.x)} ${tidy(bounds.y)} ${width} ${height}">\n${defs}${background}${body}\n</svg>\n`
  )
}

/**
 * 不透明度・明るさのマスクの絵を、かかるノードの枠（size）に合わせた SVG の文字列にする（Dev モードの CSS の mask-image に使う）。
 * m はマスクの親の座標系から、かかるノードの座標系への変換。マスクは線と効果を見ず、塗りだけで描く（描画と同じ）
 */
export function maskImageSvg(mask: MaskNode, m: Matrix, size: { width: number; height: number }): string {
  const scene: Scene = { nodes: { [mask.id]: mask }, rootIds: [mask.id] }
  const writer = new SvgWriter(scene, { assets: {}, ids: false })
  const body = writer.maskShape(mask, multiply(m, nodeMatrix(mask)))
  const defs = writer.defs.length > 0 ? `<defs>${writer.defs.join('')}</defs>` : ''
  const width = tidy(Math.max(size.width, 0))
  const height = tidy(Math.max(size.height, 0))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${defs}${body}</svg>`
}

/** SVG ファイルの名前。PNG と同じ名前の付け方（pngBaseName）に拡張子を付ける */
export function svgFileName(name: string): string {
  return `${name}.svg`
}

class SvgWriter {
  readonly defs: string[] = []
  private readonly scene: Scene
  private readonly options: SvgExportOptions
  private readonly usedIds = new Set<string>()
  private count = 0

  constructor(scene: Scene, options: SvgExportOptions) {
    this.scene = scene
    this.options = options
  }

  /** 定義（グラデーション・切り取り・影）の id。レイヤー名から作る id とぶつからないよう、名前に使えない記号で始める */
  private defId(kind: string): string {
    return `kdr-${kind}-${++this.count}`
  }

  /** レイヤー名から作る要素の id（取り込むとレイヤー名に戻る）。XML の名前に使えない文字は _ に、重なれば番号を付ける */
  private nameId(name: string): string {
    let base = name.trim().replace(/[^\p{L}\p{N}_.-]+/gu, '_')
    if (base === '' || !/^[\p{L}_]/u.test(base)) base = `_${base}`
    if (base.startsWith('kdr-')) base = `_${base}`
    let id = base
    for (let n = 2; this.usedIds.has(id); n++) id = `${base}_${n}`
    this.usedIds.add(id)
    return id
  }

  /**
   * 1 つのノード。m はノードの座標系から、書き込む先（親の要素）の座標系への変換。
   * world は親の座標系からページへの変換（影のずれを回転に従わせないために、向きを知る）
   */
  node(id: NodeId, m: Matrix, parentWorld: Matrix, source: SceneNode = this.scene.nodes[id]): string {
    // 隠した塗り・線・効果は書かない。ブーリアン演算のノードは、結果の形のパスとして書く
    const node = withoutHidden(drawnNode(this.scene, source))
    if (!node.visible || node.opacity === 0) return ''
    // マスクは描かない（兄弟を切り取る clipPath / mask になる。children）
    if (isMaskNode(node)) return ''
    // テキスト・画像の裏返しは、要素の transform に含める（枠の中心で鏡に映す）
    const flip = flipMatrix(node)
    if (flip) m = multiply(m, flip)
    const world = multiply(parentWorld, contentMatrix(node))
    const parts = this.content(node, world)
    if (parts.length === 0) return ''
    const effects = 'effects' in node ? node.effects : []
    const blur = blurRadius(effects, 'layer-blur')
    const extra =
      blendStyle(node.blendMode) +
      (blur > 0 ? this.blurFilter(node, blur) : '')
    const idAttr = this.options.ids === false ? '' : ` id="${escapeXml(this.nameId(node.name))}"`
    const attrs = `${idAttr}${transformAttr(m)}${node.opacity < 1 ? ` opacity="${tidy(node.opacity)}"` : ''}${extra}`
    // 背景のぼかしは SVG にないので、書かなかったことをコメントで残す
    const note =
      (blurRadius(effects, 'background-blur') > 0 ? `<!-- ${escapeXml(node.name)}: 背景のぼかしは SVG で表せないので書いていない -->` : '') +
      // 通過は SVG で表せない（g の opacity は中身をまとめてから混ぜる）
      (node.type === 'frame' && node.passThrough && node.blendMode === 'normal' && node.opacity < 1
        ? `<!-- ${escapeXml(node.name)}: 通過は SVG で表せないので、中身をまとめてから半透明にしている -->`
        : '')
    // 要素が 1 つなら、その要素に付ける（取り込むとフレームにならず、同じ種類のノードに戻る）。同じ属性を持っていれば g にする
    const clash = extra !== '' && / (style|filter)="/.test(parts[0].slice(0, parts[0].indexOf('>')))
    if (node.type !== 'frame' && parts.length === 1 && !parts[0].startsWith('<g') && !clash) return note + parts[0].replace(/^<(\w+)/, `<$1${attrs}`)
    return `${note}<g${attrs}${shapeMark(node)}>${parts.join('')}</g>`
  }

  /** レイヤーのぼかしの filter を定義して、付ける属性を返す。範囲は枠と、影・ぼかしのはみ出し */
  private blurFilter(node: SceneNode, blur: number): string {
    const effects = 'effects' in node ? node.effects : []
    const pad =
      blur * 1.5 +
      Math.max(0, ...splitEffects(effects).drop.map((e) => e.blur * 2 + Math.max(0, e.spread) + Math.abs(e.x) + Math.abs(e.y))) +
      ('strokeWidth' in node ? node.strokeWidth : 0)
    const id = this.defId('blur')
    this.defs.push(
      `<filter id="${id}" filterUnits="userSpaceOnUse" x="${tidy(-pad)}" y="${tidy(-pad)}" ` +
        `width="${tidy(node.width + pad * 2)}" height="${tidy(node.height + pad * 2)}" color-interpolation-filters="sRGB">` +
        `<feGaussianBlur stdDeviation="${tidy(blur / 2)}"/></filter>`,
    )
    return ` filter="url(#${id})"`
  }

  /**
   * 兄弟の並び（親の座標系に書く）。マスクから次のマスクまでの兄弟は、マスクの形の clipPath をかけた g にまとめる。
   * parentWorld は親の座標系からページへの変換
   */
  private children(ids: readonly NodeId[], parentWorld: Matrix): string {
    const masks = masksOf(this.scene, ids)
    const runs: { mask: NodeId | null; parts: string[] }[] = []
    ids.forEach((id, i) => {
      const element = this.node(id, nodeMatrix(this.scene.nodes[id]), parentWorld)
      const last = runs[runs.length - 1]
      if (last && last.mask === masks[i]) last.parts.push(element)
      else runs.push({ mask: masks[i], parts: [element] })
    })
    return runs
      .map(({ mask, parts }) => {
        const content = parts.join('')
        return mask === null || content === '' ? content : this.masked(this.scene.nodes[mask] as MaskNode, IDENTITY, content)
      })
      .join('')
  }

  /**
   * content をマスクの形で切り取る g。m はマスクの親の座標系から、書き込む先の座標系への変換。
   * clipPath の id はマスクのレイヤー名から作る（取り込むとマスクの名前に戻る）
   */
  masked(mask: MaskNode, m: Matrix, content: string): string {
    if (mask.maskType !== 'vector') return this.paintedMask(mask, m, content)
    const id = this.nameId(mask.name)
    const rule = maskFillRule(mask) === 'evenodd' ? ' clip-rule="evenodd"' : ''
    this.defs.push(`<clipPath id="${escapeXml(id)}"><path d="${contoursData(maskContours(mask, m))}"${rule}/></clipPath>`)
    return `<g clip-path="url(#${escapeXml(id)})">${content}</g>`
  }

  /**
   * 不透明度・明るさのマスク（maskType が alpha / luminance）。マスクの図形を塗りだけで描いた mask をかけた g。
   * SVG の mask は明るさで透かすのが既定なので、不透明度なら style の mask-type:alpha を付ける。範囲はマスクの枠（外は透けない）
   */
  private paintedMask(mask: MaskNode, m: Matrix, content: string): string {
    const id = this.nameId(mask.name)
    const local = multiply(m, nodeMatrix(mask))
    const box = transformRect(local, { x: 0, y: 0, width: mask.width, height: mask.height })
    const body = this.maskShape(mask, local)
    const type = mask.maskType === 'alpha' ? ' style="mask-type:alpha"' : ''
    this.defs.push(
      `<mask id="${escapeXml(id)}" maskUnits="userSpaceOnUse" x="${tidy(box.x)}" y="${tidy(box.y)}" width="${tidy(box.width)}" height="${tidy(box.height)}"${type}>${body}</mask>`,
    )
    return `<g mask="url(#${escapeXml(id)})">${content}</g>`
  }

  /** マスクの図形を、線と効果を見ずに塗りだけで書く（マスクの印を外して、ふつうの図形として）。local はマスクの枠から書き込む先への変換 */
  maskShape(mask: MaskNode, local: Matrix): string {
    const shape = { ...mask, isMask: false, strokes: [], effects: [], blendMode: 'normal' as const }
    return this.node(mask.id, local, IDENTITY, shape).replace(/^<(\w+) id="[^"]*"/, '<$1')
  }

  /** ノードの中身の要素（ノードの座標系） */
  private content(node: SceneNode, world: Matrix): string[] {
    switch (node.type) {
      case 'rect':
        return this.styled(node, world, (decls) => boxShape(node, node.cornerRadius, decls))
      case 'ellipse': {
        const shape = (decls: string) =>
          `<ellipse cx="${tidy(node.width / 2)}" cy="${tidy(node.height / 2)}" rx="${tidy(node.width / 2)}" ry="${tidy(node.height / 2)}"${decls}/>`
        return this.styled(node, world, shape)
      }
      case 'path':
        return this.path(node, world)
      case 'text':
        return this.text(node, world)
      case 'image':
        return this.image(node, world)
      case 'frame': {
        const shape = (decls: string) => boxShape(node, node.cornerRadius, decls)
        const background = this.styled({ ...node, strokes: [] }, world, shape)
        let children = this.children(node.children, world)
        if (children !== '' && node.clipContent) children = this.clipToBox(node, children)
        // 枠線は子より手前に描く（影は塗りに付けたので、ここでは付けない）
        const border = hasStroke(node) ? this.styled({ ...node, fills: [], effects: [] }, world, shape) : []
        return [...background, ...(children === '' ? [] : [children]), ...border]
      }
    }
  }

  /** 塗りの属性。グラデーションなら定義を足して url で指す */
  private paintAttr(paint: Paint, role: 'fill' | 'stroke', size: { width: number; height: number }): string {
    const blend = blendStyle(paint.blendMode)
    if (paint.type === 'solid') {
      return ` ${role}="${escapeXml(paint.color)}"${paint.opacity < 1 ? ` ${role}-opacity="${tidy(paint.opacity)}"` : ''}${blend}`
    }
    const id = this.defId('paint')
    this.defs.push(gradientDef(paint, size, id, { color: (hex) => hex }))
    return ` ${role}="url(#${id})"${blend}`
  }

  /** 線の太さ・破線・角の形の属性 */
  private strokeShape(style: Pick<Style, 'strokeWidth' | 'strokeDashes' | 'strokeDashOffset' | 'strokeJoin'>): string {
    return strokeShapeAttrs(style).map((decl) => ` ${decl}`).join('')
  }

  /**
   * 塗りと線を持つ図形（矩形・楕円・フレームの背景と枠線）。shape は属性を受け取って要素を返す。
   * 塗り 1 つと線 1 つまでで影がなければ 1 つの要素にまとめ、そうでなければ描画と同じく塗り（下から）・線（下から）の順に重ねる
   */
  private styled(node: SceneNode & Style, world: Matrix, shape: (decls: string) => string): string[] {
    const stroked = hasStroke(node)
    const strokes = stroked ? node.strokes : []
    const { drop, inner } = splitEffects(node.effects)
    if (node.fills.length === 0 && strokes.length === 0 && inner.length === 0) return []
    const blended = [...node.fills, ...strokes].filter((paint) => paint.blendMode !== 'normal').length
    if (node.fills.length <= 1 && strokes.length <= 1 && drop.length === 0 && inner.length === 0 && blended === 0) {
      const fill = node.fills.length > 0 ? this.paintAttr(node.fills[0], 'fill', node) : ' fill="none"'
      const stroke = strokes.length > 0 ? this.paintAttr(strokes[0], 'stroke', node) + this.strokeShape(node) : ''
      return [shape(fill + stroke)]
    }
    const filters = this.fillFilters(node, world, node.fills.length)
    const parts = node.fills.map((fill, i) => shape(`${this.paintAttr(fill, 'fill', node)}${filters.fill(i)}`))
    if (filters.carrier !== '') parts.push(shape(` fill="#000000"${filters.carrier}${CARRIER}`))
    for (const stroke of strokes) parts.push(shape(` fill="none"${this.paintAttr(stroke, 'stroke', node)}${this.strokeShape(node)}${filters.stroke}`))
    return parts
  }

  /**
   * 塗りの要素ごとに付ける filter。落ち影は一番下の塗りに、内側の影は一番上の塗りに付ける（描画と同じく、内側の影は塗りの上・線の下）。
   * 塗りがなければ、落ち影は線に付け、内側の影は図形の形だけを持つ要素（carrier。黒で塗るが、filter が影だけを出す）に付ける
   */
  private fillFilters(
    node: SceneNode & Pick<Style, 'effects'>,
    world: Matrix,
    fillCount: number,
  ): { fill: (index: number) => string; carrier: string; stroke: string } {
    const { drop, inner } = splitEffects(node.effects)
    if (fillCount === 0) {
      return { fill: () => '', carrier: this.shadow(node, world, [], inner, false), stroke: this.shadow(node, world, drop, [], true) }
    }
    if (fillCount === 1) {
      const both = this.shadow(node, world, drop, inner, true)
      return { fill: () => both, carrier: '', stroke: '' }
    }
    const below = this.shadow(node, world, drop, [], true)
    const above = this.shadow(node, world, [], inner, true)
    return { fill: (index) => (index === 0 ? below : index === fillCount - 1 ? above : ''), carrier: '', stroke: '' }
  }

  private path(node: Extract<SceneNode, { type: 'path' }>, world: Matrix): string[] {
    const strokes = hasStroke(node) ? node.strokes : []
    const effects = node.effects.some(isShadow)
    const call = (fill: Paint | null, stroke: Paint | null, extra: string): string[] => {
      const { defs, elements } = pathSvg(node, { id: this.defId('paint'), color: (hex) => hex, fill, stroke, standalone: true })
      this.defs.push(...defs)
      if (extra === '' || elements.length === 0) return elements
      // 端の図形などで要素がいくつもあれば g にまとめて影を付ける
      return elements.length > 1 ? [`<g${extra}${shapeMark(node)}>${elements.join('')}</g>`] : [elements[0].replace(/^<(\w+)/, `<$1${extra}`)]
    }
    // 直線には面がないので塗らない（内側の影もない）
    const fills = isLine(node) ? [] : node.fills
    const shown = isLine(node) ? { ...node, effects: splitEffects(node.effects).drop } : node
    const blended = [...fills, ...strokes].some((paint) => paint.blendMode !== 'normal')
    if (fills.length <= 1 && strokes.length <= 1 && !effects && !blended) {
      if (fills.length === 0 && strokes.length === 0) return []
      return call(fills[0] ?? null, strokes[0] ?? null, '')
    }
    const filters = this.fillFilters(shown, world, fills.length)
    const parts = fills.flatMap((fill, i) => call(fill, null, filters.fill(i) + blendStyle(fill.blendMode)))
    if (filters.carrier !== '') parts.push(...call(solidPaint('#000000'), null, filters.carrier + CARRIER))
    for (const stroke of strokes) parts.push(...call(null, stroke, filters.stroke + blendStyle(stroke.blendMode)))
    return parts
  }

  /**
   * 影の filter を定義して、付ける属性を返す。影がなければ空。
   * 落ち影は元の絵（source が true なら SourceGraphic）の下に、内側の影は上に重ねる
   */
  private shadow(
    node: SceneNode & Pick<Style, 'effects'>,
    world: Matrix,
    drop: readonly Shadow[],
    inner: readonly Shadow[],
    source: boolean,
  ): string {
    const effects = [...drop, ...inner]
    if (effects.length === 0) return ''
    // 影のずれはページの向きで決まる（回転・裏返しに従わない）ので、ノードの向きに直す
    const [a, b, c, d] = invert(world)
    const local = (effect: Shadow) => ({ x: a * effect.x + c * effect.y, y: b * effect.x + d * effect.y })
    const spread =
      Math.max(...effects.map((e) => e.blur * 2 + Math.abs(e.spread) + Math.abs(e.x) + Math.abs(e.y))) + ('strokeWidth' in node ? node.strokeWidth : 0)
    // 広がりは形（の外側）を四角く太らせる・細らせる
    const morph = (input: string, amount: number, result: string) =>
      amount === 0
        ? ''
        : `<feMorphology in="${input}" operator="${amount > 0 ? 'dilate' : 'erode'}" radius="${tidy(Math.abs(amount))}" result="${result}"/>`
    const id = this.defId('shadow')
    // Canvas の shadowBlur は、ガウスぼかしの標準偏差の 2 倍
    const drops = drop.map((effect, i) => {
      const offset = local(effect)
      return (
        morph('SourceAlpha', effect.spread, `m${i}`) +
        `<feGaussianBlur in="${effect.spread === 0 ? 'SourceAlpha' : `m${i}`}" stdDeviation="${tidy(effect.blur / 2)}"/>` +
        `<feOffset dx="${tidy(offset.x)}" dy="${tidy(offset.y)}" result="o${i}"/>` +
        `<feFlood flood-color="${escapeXml(effect.color)}" flood-opacity="${tidy(effect.opacity)}"/>` +
        `<feComposite in2="o${i}" operator="in" result="s${i}"/>`
      )
    })
    // 内側の影: 図形の外側を影の色で塗り、ぼかしてずらし、図形の中だけを残す
    const inners = inner.map((effect, i) => {
      const offset = local(effect)
      return (
        `<feFlood flood-color="${escapeXml(effect.color)}" flood-opacity="${tidy(effect.opacity)}" result="f${i}"/>` +
        `<feComposite in="f${i}" in2="SourceAlpha" operator="out" result="v${i}"/>` +
        morph(`v${i}`, effect.spread, `w${i}`) +
        `<feGaussianBlur in="${effect.spread === 0 ? `v${i}` : `w${i}`}" stdDeviation="${tidy(effect.blur / 2)}"/>` +
        `<feOffset dx="${tidy(offset.x)}" dy="${tidy(offset.y)}" result="u${i}"/>` +
        `<feComposite in="u${i}" in2="SourceAlpha" operator="in" result="n${i}"/>`
      )
    })
    const merge =
      drop.map((_, i) => `<feMergeNode in="s${i}"/>`).join('') +
      (source ? '<feMergeNode in="SourceGraphic"/>' : '') +
      inner.map((_, i) => `<feMergeNode in="n${i}"/>`).join('')
    this.defs.push(
      `<filter id="${id}" filterUnits="userSpaceOnUse" x="${tidy(-spread)}" y="${tidy(-spread)}" ` +
        `width="${tidy(node.width + spread * 2)}" height="${tidy(node.height + spread * 2)}" color-interpolation-filters="sRGB">` +
        `${drops.join('')}${inners.join('')}<feMerge>${merge}</feMerge></filter>`,
    )
    return ` filter="url(#${id})"`
  }

  private text(node: TextNode, world: Matrix): string[] {
    if (node.fills.length === 0) return []
    const lines = this.options.textLines?.(node) ?? node.text.split('\n').map((text) => ({ text }))
    const lineHeight = node.fontSize * node.lineHeight
    // 1 行目の基線。フォントの高さが分からなければ、SVG の取り込み（editor/svg/convert.ts の text）と同じ見積もり
    const baseline = textBaseline(node, (this.options.textMetrics ?? estimateTextMetrics)(node))
    const anchor = { left: '', center: ' text-anchor="middle"', right: ' text-anchor="end"' }[node.textAlign]
    const x = tidy(node.width * alignFactor(node.textAlign))
    const spans = lines
      .map((line, i) => `<tspan x="${x}" y="${tidy(baseline + lineHeight * i)}">${escapeXml(line.text)}</tspan>`)
      .join('')
    const font =
      ` font-family="${escapeXml(node.fontFamily)}" font-size="${tidy(node.fontSize)}"` +
      `${node.fontWeight === 400 ? '' : ` font-weight="${node.fontWeight}"`}${anchor}`
    // 文字の落ち影は一番下の塗りに、内側の影は一番上の塗りに付ける（塗りが 1 つなら両方を 1 つの filter に）
    const { drop, inner } = splitEffects(node.effects)
    const last = node.fills.length - 1
    const filterOf = (i: number) => {
      const drops = i === 0 ? drop : []
      const inners = i === last ? inner : []
      return drops.length + inners.length > 0 ? this.shadow(node, world, drops, inners, true) : ''
    }
    return node.fills.map(
      (fill, i) =>
        `<text x="${x}" y="${tidy(baseline)}"${font}${this.paintAttr(fill, 'fill', node)}${filterOf(i)} xml:space="preserve">${spans}</text>`,
    )
  }

  private image(node: ImageNode, world: Matrix): string[] {
    // 影は枠の形に付ける（描画と同じ）。枠の形の黒い要素に、影だけを出す filter を付ける
    const { drop, inner } = splitEffects(node.effects)
    const below = drop.length > 0 ? [boxShape(node, node.cornerRadius, ` fill="#000000"${this.shadow(node, world, drop, [], false)}`)] : []
    const above = inner.length > 0 ? [boxShape(node, node.cornerRadius, ` fill="#000000"${this.shadow(node, world, [], inner, false)}`)] : []
    return [...below, ...this.imageContent(node), ...above]
  }

  private imageContent(node: ImageNode): string[] {
    const asset = Object.hasOwn(this.options.assets, node.assetId) ? this.options.assets[node.assetId] : undefined
    const info = asset ? readImageInfo(asset.bytes) : null
    // 画像がなければ、描画のデコード待ちと同じ灰色の矩形
    if (!asset || !info) return [boxShape(node, node.cornerRadius, ' fill="#d9d9d9"')]
    const rect = imageRect(node, info)
    const image =
      `<image href="${escapeXml(dataUri(asset))}" x="${tidy(rect.x)}" y="${tidy(rect.y)}" ` +
      `width="${tidy(rect.width)}" height="${tidy(rect.height)}" preserveAspectRatio="none"/>`
    const overflows = rect.x < 0 || rect.y < 0 || rect.x + rect.width > node.width || rect.y + rect.height > node.height
    if (!overflows && !isRounded(node.cornerRadius)) return [image]
    return [this.clipToBox(node, image)]
  }

  /** content を node の枠（角丸を含む）で切り取る g */
  private clipToBox(node: SceneNode & { cornerRadius: CornerRadius }, content: string): string {
    const clip = this.defId('clip')
    this.defs.push(`<clipPath id="${clip}">${boxShape(node, node.cornerRadius, '')}</clipPath>`)
    return `<g clip-path="url(#${clip})">${content}</g>`
  }
}

/** 影だけを出すために図形の形を持つ要素（塗りではない）の印。取り込みで 1 つのノードに戻すときに、効果だけを読む */
const CARRIER = ' data-kdr-part="carrier"'

/**
 * 1 つのノードを要素いくつかの g にまとめたときの印（data-kdr-shape）。取り込み（editor/svg/convert.ts の kdrShape）は、
 * この印があれば g をフレームにせず 1 つのノードに戻す。描画で付けた端の形（矢印など）は data-kdr-caps に残す
 * （端の図形は data-kdr-part="cap"、短くした線の元の形は data-kdr-d。svgShapes.ts の pathSvg）。フレームと画像には付けない
 */
function shapeMark(node: SceneNode): string {
  if (node.type === 'frame' || node.type === 'image') return ''
  const caps = node.type === 'path' && !node.closed && (node.startCap !== 'none' || node.endCap !== 'none')
    ? ` data-kdr-caps="${node.startCap} ${node.endCap}"`
    : ''
  return ` data-kdr-shape="${node.type}"${caps}`
}

/** 描画モードの style 属性（通常なら書かない） */
function blendStyle(mode: BlendMode): string {
  return mode !== 'normal' ? ` style="mix-blend-mode:${mode}"` : ''
}

/** 変換の属性。平行移動だけなら translate、回転を含めば translate と rotate、どちらでもなければ matrix */
function transformAttr(m: Matrix): string {
  const [a, b, c, d, e, f] = m
  const near = (x: number, y: number) => Math.abs(x - y) < 1e-9
  const move = tidy(e) === 0 && tidy(f) === 0 ? '' : `translate(${tidy(e)} ${tidy(f)})`
  if (near(a, 1) && near(b, 0) && near(c, 0) && near(d, 1)) return move === '' ? '' : ` transform="${move}"`
  if (near(a, d) && near(b, -c) && near(a * a + b * b, 1)) {
    const angle = (Math.atan2(b, a) * 180) / Math.PI
    return ` transform="${[move, `rotate(${tidy(angle)})`].filter((part) => part !== '').join(' ')}"`
  }
  const n = (value: number) => Math.round(value * 1e6) / 1e6
  return ` transform="matrix(${[a, b, c, d, e, f].map(n).join(' ')})"`
}

/** 枠（左上が原点）の矩形。角丸は描画と同じく枠の短い辺の半分まで（clampedRadii）。4 隅が違えば path にする */
function boxShape(size: { width: number; height: number }, radius: CornerRadius, decls: string): string {
  const { width, height } = size
  const [tl, tr, br, bl] = clampedRadii(radius, width, height)
  const w = tidy(width)
  const h = tidy(height)
  if (tl === tr && tr === br && br === bl) {
    return `<rect width="${w}" height="${h}"${tl > 0 ? ` rx="${tidy(tl)}"` : ''}${decls}/>`
  }
  // 角は円弧の代わりに 3 次ベジェ曲線（取り込みでも曲線になる）
  const k = 1 - KAPPA
  const n = tidy
  const d = [
    `M${n(tl)} 0`,
    `L${n(width - tr)} 0`,
    tr > 0 ? `C${n(width - tr * k)} 0 ${w} ${n(tr * k)} ${w} ${n(tr)}` : '',
    `L${w} ${n(height - br)}`,
    br > 0 ? `C${w} ${n(height - br * k)} ${n(width - br * k)} ${h} ${n(width - br)} ${h}` : '',
    `L${n(bl)} ${h}`,
    bl > 0 ? `C${n(bl * k)} ${h} 0 ${n(height - bl * k)} 0 ${n(height - bl)}` : '',
    `L0 ${n(tl)}`,
    tl > 0 ? `C0 ${n(tl * k)} ${n(tl * k)} 0 ${n(tl)} 0` : '',
    'Z',
  ]
  return `<path d="${d.filter((part) => part !== '').join(' ')}"${decls}/>`
}
