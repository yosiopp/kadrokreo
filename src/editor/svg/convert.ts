import {
  type Bounds,
  IDENTITY,
  type Matrix,
  type Point,
  type Size,
  applyMatrix,
  multiply,
  nodeMatrix,
  rotateVector,
  tidy,
  toNodeSpace,
  transformRect,
  unionBounds,
} from '../../document/geometry.ts'
import { isImageTooLarge, readImageInfo } from '../../document/imageInfo.ts'
import { KAPPA, canMask, ellipseVertices } from '../../document/mask.ts'
import { BLEND_MODES, CAPS, IMAGE_MIME_TYPES, KDR_MAX_ASSET_BYTES, MAX_DASHES, MAX_PAINTS, MAX_PATH_POINTS, MAX_STOPS } from '../../document/kdr.ts'
import { angleLine, fitFocus, isShadow, linearFromAngle, solidPaint } from '../../document/paint.ts'
import { type Contour, type Vertex, mapVertices, pathBounds, pathFromContours } from '../../document/path.ts'
import { PathDataError, parsePathData } from '../../document/pathData.ts'
import { sha256Hex } from '../../document/sha256.ts'
import { type SvgTextMetrics, estimateTextMetrics, textBaseline } from '../../document/svgExport.ts'
import type {
  Asset,
  AssetId,
  BlendMode,
  Cap,
  ColorStop,
  Effect,
  FrameNode,
  ImageNode,
  NodeId,
  Paint,
  PathNode,
  SceneNode,
  StrokeJoin,
  Style,
  TextNode,
} from '../../document/types.ts'
import { createEllipse, createFrame, createImage, createPath, createRect, createText } from '../nodes.ts'
import type { Fragment } from '../operations/clipboard.ts'
import { type StyleSheet, matchedDeclarations, parseStyleSheet } from './css.ts'
import { readShadowFilter } from './filters.ts'
import { MAX_SVG_LENGTH, type SvgElement, type SvgNode, parseSvgXml } from './xml.ts'
import {
  type Rgba,
  clamp01,
  decompose,
  lengthScale,
  parseColor,
  parseFraction,
  parseLength,
  parseNumbers,
  parseStyle,
  parseTransform,
} from './values.ts'

// SVG の木（xml.ts）を kadrokreo のノードに変換する。SVG そのものは kdr に残さない。
//
// - SVG 全体を 1 つのフレーム（名前はファイル名、大きさは width / height か viewBox）にまとめ、g は入れ子のフレームにする。
//   g のフレームは中身を囲む大きさで、回転しない。g の transform は、中の図形の形に焼き込む。
// - rect / circle / ellipse は、かかっている変換が「回転と縦横の拡大」で表せれば矩形・楕円のノード（回転つき）に、
//   歪めたり裏返したりしていればパスにする。line / polyline / polygon / path はパス。path の輪郭が複数あれば、
//   1 つのパスの輪郭（contours）にし、fill-rule を写す（穴が開く）。stroke-dasharray は線の破線にする。
// - 塗りは単色と linearGradient・radialGradient。fill-opacity・stroke-opacity・色の alpha・揃った stop-opacity は塗りの不透明度（Paint.opacity）に写す。
// - <style> の CSS はセレクタ（要素名・#id・.class・属性・結合子・静的に決まる疑似クラス。css.ts）を読み、属性 < CSS < style 属性 < CSS の !important の順に重ねる。
// - clip-path / mask は、中身が矩形・円 1 つで、軸に沿って置かれているときは、切り取るフレーム（角丸）にする。
//   kadrokreo の書き出しが切り取りを子の要素ごとにかけたもの（data-kdr-clip の g と data-kdr-clip-of の clipPath）は、印の g を 1 つの切り取るフレームに戻す。
//   ほかの形（パス・多角形・回った矩形・いくつもの形・objectBoundingBox）は、形をマスク（isMask）のパスにして中身と一緒にフレームにまとめる（maskShape）。
//   mask の中身が図形 1 つで塗りがグラデーションか mask-type: alpha なら、その図形を明るさ・不透明度のマスクに（paintedMask）、
//   中身にテキスト・画像・グループがあれば、中身のノード（いくつもならまとめたフレーム）をその絵で透かすマスクにする（pictureMask）。
// - <image> は data URI の PNG / JPEG / WebP / GIF を画像のノードに、SVG（data:image/svg+xml）を別の文書として変換したフレームにする（外部の URL は読まない）。
// - <text> と <image> にかかる変換が裏返していれば、左右の裏返し（flipX）と回転にする（上下の裏返しは左右の裏返し + 180° の回転）。
// - 図形の filter は、feDropShadow か kadrokreo の書き出しと同じ並びの影（落ち影・内側の影）だけを効果にする（filters.ts）。
// - foreignObject の中身は読まない。中の要素の style にある backdrop-filter: blur(…) の値だけを文字として拾い（xml.ts）、次の図形の背景のぼかしにする。
//   background: conic-gradient(…) の値も文字として拾い、clipPath で切り取った g の中に置かれていれば、clipPath の図形を角度のグラデーションで塗る（conicForeign）。
// - スクリプト・foreignObject・外部参照は読まない。表せないもの（ほかのフィルタ・複雑なクリップやマスク・パターン・textPath など）は
//   近い形に置き換えるか読み飛ばし、warnings で知らせる。

export type SvgWarning = { label: string; count: number }

export type SvgImport = {
  /** 根は SVG 全体のフレーム（x, y は 0）。ノードの id は仮のもので、貼り付けるときに振り直す（pasteFragment） */
  fragment: Fragment
  /** 表せずに置き換えたり読み飛ばしたりしたもの */
  warnings: SvgWarning[]
}

export type SvgImportOptions = {
  /** 根のフレームの名前（ファイル名） */
  name: string
  /** テキストの大きさを測る。editor は Canvas で測り、CLI は見積もる */
  measureText: (node: TextNode) => Size
  /**
   * フォントの上下の高さ。SVG の (x, y) は基線なので、これで枠の上端を求める。書き出し（document/svgExport.ts）と同じ測り方にすると、
   * 書き出して取り込み直しても上下にずれない。省略すると書き出しと同じ見積もり（文字の上 0.9・下 0.22）
   */
  textMetrics?: SvgTextMetrics
}

class SvgImportError extends Error {
  override name = 'SvgImportError'
}

/** 作るノードの数の上限。use の入れ子で数が膨らむ細工を止める */
const MAX_NODES = 20_000
/** g のフレームの入れ子の上限（kdr の MAX_DEPTH 100 より余裕をもって小さく）。深い分はフレームを作らずに中身を親へ出す */
const MAX_FRAME_DEPTH = 64
const MAX_USE_DEPTH = 16
/** SVG の画像（data:image/svg+xml の <image>）の入れ子の深さ・変換する回数・変換する要素の数の合計の上限 */
const MAX_SVG_IMAGE_DEPTH = 4
const MAX_SVG_IMAGES = 64
const MAX_SVG_IMAGE_ELEMENTS = 100_000
/** 塗りと線を持つ図形の要素（影の filter を効果として読む） */
const SHAPE_ELEMENTS = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path'])
/** 影とぼかしの filter を効果として読む要素（グループはフレームになるので効果を持てる） */
const EFFECT_ELEMENTS = new Set([...SHAPE_ELEMENTS, 'g', 'text', 'image'])

/** 親から受け継ぐ値（presentation attribute と style 属性） */
/** 塗りで透かすマスク（paintedMask）の中身にできる図形 */
const PAINTED_MASK_SHAPES = new Set(['rect', 'circle', 'ellipse', 'path', 'polygon'])

/** mask の中身にあれば、中身をノードにしてその絵で透かすマスクにする要素（pictureMask） */
const PICTURE_MASK_ELEMENTS = new Set(['text', 'image', 'g', 'svg', 'a', 'switch'])

type Inherited = {
  fill: string
  stroke: string
  strokeWidth: string
  fillOpacity: number
  strokeOpacity: number
  color: string
  fontSize: number
  fontFamily: string
  fontWeight: string
  textAnchor: string
  visible: boolean
  /** stroke-linecap。開いたパスの両端の形になる */
  lineCap: string
  /** stroke-linejoin。線の角の形になる */
  lineJoin: string
  fillRule: string
  /** stroke-dasharray（そのままの文字。読むのは shape） */
  dashArray: string
  dashOffset: string
}

/** 属性の名前と、そのままの文字で受け継ぐ Inherited の項目 */
const INHERITED_TEXT = [
  ['fill', 'fill'],
  ['stroke', 'stroke'],
  ['stroke-width', 'strokeWidth'],
  ['font-family', 'fontFamily'],
  ['font-weight', 'fontWeight'],
  ['text-anchor', 'textAnchor'],
  ['stroke-linecap', 'lineCap'],
  ['stroke-linejoin', 'lineJoin'],
  ['fill-rule', 'fillRule'],
  ['stroke-dasharray', 'dashArray'],
  ['stroke-dashoffset', 'dashOffset'],
] as const satisfies readonly (readonly [string, keyof Inherited])[]

const ROOT_INHERITED: Inherited = {
  fill: 'black',
  stroke: 'none',
  strokeWidth: '1',
  fillOpacity: 1,
  strokeOpacity: 1,
  color: 'black',
  fontSize: 16,
  fontFamily: 'sans-serif',
  fontWeight: 'normal',
  textAnchor: 'start',
  visible: true,
  lineCap: 'butt',
  lineJoin: 'miter',
  fillRule: 'nonzero',
  dashArray: 'none',
  dashOffset: '0',
}

/** 要素を描かない（定義だけの）要素。黙って読み飛ばす */
const DEFINITIONS = new Set([
  'defs',
  'title',
  'desc',
  'metadata',
  'symbol',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'filter',
  'pattern',
  'marker',
])

/** 落としたことを知らせる要素と、その呼び名 */
const SKIPPED_ELEMENTS: Record<string, string> = {
  script: 'スクリプト（<script>）',
  foreignObject: '埋め込み HTML（<foreignObject>）',
  textPath: '線に沿った文字（<textPath>）',
}

/** 図形に付いていたら落としたと知らせる属性 */
const SKIPPED_REFERENCES: [string, string][] = [
  ['filter', 'フィルタ'],
  ['marker-start', 'マーカー'],
  ['marker-mid', 'マーカー'],
  ['marker-end', 'マーカー'],
]

/** 解析した SVG の木を、kadrokreo のノードに変換する */
export function convertSvg(root: SvgElement, options: SvgImportOptions): SvgImport {
  if (root.name !== 'svg') throw new SvgImportError('svg 要素がありません')
  return new Converter(root, options).run()
}

/**
 * 1 回の取り込みで共有するもの。SVG の画像（data:image/svg+xml の <image>）は別の文書として別の Converter で変換するが、
 * ノード・知らせ・画像・id の番号・上限は外側と分け合う
 */
type Shared = {
  nodes: Record<NodeId, SceneNode>
  warnings: Map<string, number>
  /** data URI の <image> から作った画像。id は中身の SHA-256 */
  assets: Record<AssetId, Asset>
  nextId: number
  /** 上限に達して、それより後の要素を読まない */
  stopped: boolean
  /** nodes の数（add で増やし、取り消して delete したら減らす。毎回 Object.keys で数えると 2 乗になる） */
  nodeCount: number
  /** SVG の画像の data URI ごとの解析した木（読めなければ null）。use で同じ画像を何度も指されても解析は 1 回 */
  svgImages: Map<string, SvgElement | null>
  /** SVG の画像を変換した回数と、変換した要素の数の合計（細工で何度も変換させられないように） */
  svgImageCount: number
  svgImageElements: number
}

function newShared(): Shared {
  return {
    nodes: {},
    warnings: new Map(),
    assets: {},
    nextId: 0,
    stopped: false,
    nodeCount: 0,
    svgImages: new Map(),
    svgImageCount: 0,
    svgImageElements: 0,
  }
}

class Converter {
  private readonly shared: Shared
  private readonly nodes: Record<NodeId, SceneNode>
  private readonly definitions = new Map<string, SvgElement>()
  private readonly warnings: Map<string, number>
  private readonly root: SvgElement
  private readonly options: SvgImportOptions
  /** SVG の画像の入れ子の深さ（いちばん外の SVG は 0） */
  private readonly imageDepth: number
  /** 要素の親（CSS の子孫・兄弟のセレクタの照合に使う） */
  private readonly parents = new Map<SvgElement, SvgElement>()
  /** ビューポートの大きさ（% の長さの基準） */
  private viewport: Size = { width: 300, height: 150 }
  /** たどっている use の参照先（循環を止める） */
  private readonly using = new Set<string>()
  /** グラデーションごとの href でたどった並び（何度も使うので覚え、外部への参照も 1 つにつき 1 回だけ知らせる） */
  private readonly chainCache = new Map<SvgElement, SvgElement[]>()
  /** 扇形の pattern ごとに読んだ並び（読めなければ null） */
  private readonly fanCache = new Map<SvgElement, WedgeFan | null>()
  /** <style> の CSS をまとめたもの */
  private sheet: StyleSheet = parseStyleSheet('')
  /** 要素ごとの、属性・CSS・style 属性を重ねた値（declared） */
  private readonly declaredCache = new Map<SvgElement, Record<string, string>>()
  private readonly assets: Record<AssetId, Asset>

  constructor(root: SvgElement, options: SvgImportOptions, shared: Shared = newShared(), imageDepth = 0) {
    this.root = root
    this.options = options
    this.shared = shared
    this.nodes = shared.nodes
    this.warnings = shared.warnings
    this.assets = shared.assets
    this.imageDepth = imageDepth
  }

  run(): SvgImport {
    const size = this.prepare()
    const children = this.convertRoot(IDENTITY, 1)
    const frame: FrameNode = {
      ...createFrame({ x: 0, y: 0, width: size.width, height: size.height }),
      id: this.id(),
      name: this.options.name,
      fills: [],
      // SVG はビューポートの外を描かない
      clipContent: true,
      opacity: this.opacityOf(this.root),
      children,
    }
    this.nodes[frame.id] = frame
    for (const child of children) this.nodes[child] = { ...this.nodes[child], parentId: frame.id }
    return {
      fragment: { nodes: this.nodes, rootIds: [frame.id], assets: this.assets },
      warnings: [...this.warnings].map(([label, count]) => ({ label, count })),
    }
  }

  /** 定義・CSS・親を集め、ビューポートを決める。根の大きさ（width / height か viewBox）を返す */
  private prepare(): Size {
    this.collectDefinitions(this.root)
    this.collectParents(this.root)
    this.collectStyles()
    const { size } = this.rootViewport(this.root)
    this.viewport = viewBoxSize(this.root) ?? size
    return size
  }

  /** 根の中身を変換する。outer は根のビューポート（0, 0 から根の大きさ）を外側の座標に写す変換 */
  private convertRoot(outer: Matrix, depth: number): NodeId[] {
    const { matrix } = this.rootViewport(this.root)
    const inherited = this.inherit(this.root, ROOT_INHERITED)
    const ids = this.convertChildren(this.root, multiply(outer, matrix), inherited, depth, 0)
    if (this.sheet.exhausted) this.warn('CSS のセレクタの照合が多すぎる（途中から結合子つきのセレクタを当てなかった）')
    return ids
  }

  private id(): NodeId {
    return `svg${++this.shared.nextId}`
  }

  private warn(label: string): void {
    this.warnings.set(label, (this.warnings.get(label) ?? 0) + 1)
  }

  // ── 下ごしらえ ──

  /** id を持つ要素を覚える（use と url(#…) の参照先）。中身を写していない要素の中は見ない */
  private collectDefinitions(element: SvgElement): void {
    const id = element.attributes.id
    if (id !== undefined && !this.definitions.has(id)) this.definitions.set(id, element)
    for (const child of element.children) if (typeof child !== 'string') this.collectDefinitions(child)
  }

  private collectParents(element: SvgElement): void {
    for (const child of element.children) {
      if (typeof child === 'string') continue
      this.parents.set(child, element)
      this.collectParents(child)
    }
  }

  /** <style> の中身を読む。読めないセレクタや @ の規則は数えて知らせる */
  private collectStyles(): void {
    const texts: string[] = []
    const walk = (element: SvgElement) => {
      if (element.name === 'style') {
        const type = element.attributes.type?.trim().toLowerCase()
        if (type === undefined || type === '' || type === 'text/css') {
          texts.push(element.children.filter((child): child is string => typeof child === 'string').join(''))
        }
        return
      }
      for (const child of element.children) if (typeof child !== 'string') walk(child)
    }
    walk(this.root)
    if (texts.length === 0) return
    this.sheet = parseStyleSheet(texts.join('\n'))
    for (let i = 0; i < this.sheet.skippedSelectors; i++) this.warn('CSS の複雑なセレクタ（読み飛ばした）')
    for (let i = 0; i < this.sheet.skippedAtRules; i++) this.warn('CSS の @ で始まる規則（読み飛ばした）')
  }

  /**
   * 要素の見た目の値（presentation attribute・CSS・style 属性）を重ねたもの。名前は CSS のプロパティ名。
   * 優先は 属性 < CSS < style 属性 < CSS の !important
   */
  private declared(element: SvgElement): Record<string, string> {
    const cached = this.declaredCache.get(element)
    if (cached) return cached
    const { normal, important } = matchedDeclarations(this.sheet, element, this.parents)
    const result = { ...element.attributes, ...normal, ...parseStyle(element.attributes.style), ...important }
    this.declaredCache.set(element, result)
    return result
  }

  private opacityOf(element: SvgElement): number {
    const value = parseFraction(this.declared(element).opacity)
    return value === null ? 1 : clamp01(value)
  }

  private rootViewport(svg: SvgElement): { size: Size; matrix: Matrix } {
    const viewBox = viewBoxOf(svg)
    let width = parseLength(svg.attributes.width) ?? null
    let height = parseLength(svg.attributes.height) ?? null
    // % の大きさは決められないので、viewBox の大きさを使う
    if (svg.attributes.width?.trim().endsWith('%')) width = null
    if (svg.attributes.height?.trim().endsWith('%')) height = null
    if (viewBox) {
      const ratio = viewBox[2] / viewBox[3]
      if (width === null && height === null) [width, height] = [viewBox[2], viewBox[3]]
      else if (width === null) width = height! * ratio
      else if (height === null) height = width / ratio
    }
    const size = { width: positive(width ?? 300), height: positive(height ?? 150) }
    const matrix = viewBox ? viewBoxMatrix(viewBox, size, svg.attributes.preserveAspectRatio) : IDENTITY
    return { size, matrix }
  }

  /** 要素の値を、親から受け継いだ値に重ねる */
  private inherit(element: SvgElement, parent: Inherited): Inherited {
    const declared = this.declared(element)
    const get = (name: string): string | undefined => {
      const value = declared[name]
      return value === undefined || value.trim() === 'inherit' ? undefined : value.trim()
    }
    const next = { ...parent }
    // そのままの文字で受け継ぐ値
    for (const [name, key] of INHERITED_TEXT) {
      const value = get(name)
      if (value !== undefined) next[key] = value
    }
    const fillOpacity = parseFraction(get('fill-opacity'))
    if (fillOpacity !== null) next.fillOpacity = clamp01(fillOpacity)
    const strokeOpacity = parseFraction(get('stroke-opacity'))
    if (strokeOpacity !== null) next.strokeOpacity = clamp01(strokeOpacity)
    const color = get('color')
    if (color !== undefined && color !== 'currentColor') next.color = color
    const fontSize = get('font-size')
    if (fontSize !== undefined) {
      const size = fontSize.endsWith('%') || fontSize.endsWith('em')
        ? parent.fontSize * (parseFloat(fontSize) / (fontSize.endsWith('%') ? 100 : 1))
        : parseLength(fontSize)
      if (size !== null && Number.isFinite(size) && size > 0) next.fontSize = size
    }
    const visibility = get('visibility')
    if (visibility !== undefined) next.visible = visibility === 'visible'
    return next
  }

  // ── 要素 ──

  /** 子要素を順に変換し、できたノードの id を重なり順（先頭が最背面）に返す */
  private convertChildren(element: SvgElement, matrix: Matrix, inherited: Inherited, depth: number, uses: number): NodeId[] {
    const ids: NodeId[] = []
    // backdrop-filter を持つ foreignObject の背景のぼかし。次の兄弟からできたノードにかける
    let backdrop: number | null = null
    for (const child of element.children) {
      if (typeof child === 'string') continue
      const made = this.convertElement(child, matrix, inherited, depth, uses)
      if (backdrop !== null && made.length > 0) {
        this.applyBackdrop(made, backdrop)
        backdrop = null
      }
      if (child.name === 'foreignObject') {
        const blur = this.backdropBlur(child, matrix)
        if (blur !== null) {
          if (backdrop !== null) this.warn('背景のぼかし（かける図形がない）')
          backdrop = blur
        }
      }
      ids.push(...made)
    }
    if (backdrop !== null) this.warn('背景のぼかし（かける図形がない）')
    return ids
  }

  /**
   * 背景のぼかしを書き出したツールは、図形の直前に、図形の形で切り取った foreignObject を置き、中の空の要素の style に
   * backdrop-filter: blur(…) を書く。その値（xml.ts が文字として拾ったもの）を、kadrokreo のぼかしの半径にする（CSS の blur() の 2 倍。
   * 拡大の分だけ大きくする）。backdrop-filter がなければ null、blur(長さ) 1 つでなければ知らせて null。0 なら 0
   */
  private backdropBlur(element: SvgElement, parentMatrix: Matrix): number | null {
    const raw = element.foreign?.backdropFilter?.trim()
    if (raw === undefined || raw === '' || raw === 'none') return null
    if (this.declared(element).display?.trim() === 'none') return null
    // blur() の長さは px（0 だけは単位なし）。空の blur() は 0
    const match = /^blur\(\s*(?:((?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px)?)?\s*\)$/i.exec(raw)
    const length = match ? Number(match[1] ?? 0) : NaN
    if (!match || !Number.isFinite(length) || (match[2] === undefined && length !== 0)) {
      this.warn('読めない背景のぼかし（backdrop-filter）')
      return null
    }
    const transform = parseTransform(element.attributes.transform)
    const matrix = transform ? multiply(parentMatrix, transform) : parentMatrix
    return tidy(length * 2 * lengthScale(matrix))
  }

  /**
   * 背景のぼかしを、foreignObject の次の兄弟からできたノードにかける。g からできた塗りのないフレームに中身が 1 つだけなら、
   * その中身（形がぼかす範囲になる）にかける。ノードが 1 つに決まらなければ知らせる
   */
  private applyBackdrop(ids: NodeId[], blur: number): void {
    if (blur === 0) return
    let node: SceneNode | undefined = ids.length === 1 ? this.nodes[ids[0]] : undefined
    while (node?.type === 'frame' && node.children.length === 1 && node.fills.length === 0) node = this.nodes[node.children[0]]
    // 塗りのないフレーム（中身がいくつもの g）にかけると、中身の形ではなく枠の全体をぼかしてしまう
    if (!node || !('effects' in node) || (node.type === 'frame' && node.fills.length === 0)) {
      this.warn('背景のぼかし（かける図形が 1 つに決まらない）')
      return
    }
    if (node.effects.some((effect) => effect.type === 'background-blur') || node.effects.length >= MAX_PAINTS) return
    this.nodes[node.id] = { ...node, effects: [...node.effects, { type: 'background-blur', blur, visible: true }] }
  }

  private convertElement(element: SvgElement, parentMatrix: Matrix, parentInherited: Inherited, depth: number, uses: number): NodeId[] {
    if (this.shared.stopped) return []
    const { name, attributes } = element
    if (DEFINITIONS.has(name)) return []
    const skipped = SKIPPED_ELEMENTS[name]
    if (skipped) {
      // 背景のぼかしだけの foreignObject は知らせない（ぼかしは convertChildren が次の図形にかける）
      const foreign = element.foreign
      if (!(foreign && foreign.backdropFilter !== null && foreign.conic === null && !foreign.other)) this.warn(skipped)
      return []
    }
    if (name === 'style') return []
    const declared = this.declared(element)
    if (declared.display?.trim() === 'none') return []
    const transform = parseTransform(attributes.transform)
    const matrix = transform ? multiply(parentMatrix, transform) : parentMatrix
    if (!transform) this.warn('読めない transform（無視した）')
    const inherited = this.inherit(element, parentInherited)
    // 図形・グループ・テキスト・画像に付いた影とぼかしの filter は効果として読む（図形は shape で、ほかはここで）
    const effects = EFFECT_ELEMENTS.has(name) ? this.filterEffects(element, matrix) : null
    for (const [attribute, label] of SKIPPED_REFERENCES) {
      const value = declared[attribute]
      if (attribute === 'filter' && effects !== null) continue
      if (value !== undefined && value.trim() !== 'none') this.warn(label)
    }
    // 角度のグラデーションを foreignObject の conic-gradient で書いた g は、切り取りの図形 1 つにする（切り取りはもうかけない）
    const conic = name === 'g' ? this.conicForeign(element, matrix, inherited, depth, uses) : null
    const ids = conic ?? this.convertShape(element, matrix, inherited, depth, uses)
    if (effects !== null && !SHAPE_ELEMENTS.has(name)) {
      const node = ids.length === 1 ? this.nodes[ids[0]] : undefined
      if (node && 'effects' in node && node.effects.length === 0) this.nodes[ids[0]] = { ...node, effects }
      // kadrokreo の書き出しが 1 つのノードを g にまとめたもの（kdrShape）は、g の filter（レイヤーのぼかし・線の影）を足す
      else if (node && 'effects' in node && attributes['data-kdr-shape'] !== undefined) this.nodes[ids[0]] = { ...node, effects: [...node.effects, ...effects] }
      else if (ids.length > 0) this.warn('フィルタ')
    }
    // 描画モード（CSS の mix-blend-mode）はできたノードに付ける
    const blend = declared['mix-blend-mode']?.trim()
    if (blend !== undefined && blend !== 'normal' && blend !== '') {
      if ((BLEND_MODES as readonly string[]).includes(blend)) {
        for (const id of ids) if (this.nodes[id].blendMode === 'normal') this.nodes[id] = { ...this.nodes[id], blendMode: blend as BlendMode }
      } else this.warn(`描画モード（${blend}）`)
    }
    return conic ? ids : this.clipped(element, ids, matrix, depth)
  }

  /**
   * 角度のグラデーションを書き出したツールの形: 図形の形の clipPath で切り取った g の中に、変換を持つ g を 1 つ置き、その中の
   * foreignObject 1 つの空の要素の style に background: conic-gradient(…) を書く（中心と向きは foreignObject の枠の真ん中と
   * 内側の g の transform で決まる）。これを、clipPath の図形を角度のグラデーションで塗ったノード 1 つにする。
   * 形が違えば null（ふつうに変換し、foreignObject は今までどおり知らせる）。conic-gradient が読めなければ知らせて null
   */
  private conicForeign(element: SvgElement, matrix: Matrix, inherited: Inherited, depth: number, uses: number): NodeId[] | null {
    const declared = this.declared(element)
    const clip = /^url\(\s*['"]?#([^'")]*)['"]?\s*\)$/.exec(declared['clip-path']?.trim() ?? '')
    if (!clip || !isNone(declared.mask) || !isNone(declared.filter)) return null
    const outer = shapeChildren(element)
    if (outer.length !== 1 || outer[0].name !== 'g') return null
    const inner = outer[0]
    const innerKids = shapeChildren(inner)
    if (innerKids.length !== 1 || innerKids[0].name !== 'foreignObject') return null
    const foreign = innerKids[0]
    const content = foreign.foreign
    if (!content || content.conic === null || content.other || content.backdropFilter !== null) return null
    // 内側の g と foreignObject には、変換と不透明度のほかの効き目（切り取り・マスク・フィルタ・隠す）がないこと
    for (const part of [inner, foreign]) {
      const style = this.declared(part)
      if (!isNone(style['clip-path']) || !isNone(style.mask) || !isNone(style.filter) || style.display?.trim() === 'none') return null
    }
    const target = this.definitions.get(clip[1].trim())
    if (target?.name !== 'clipPath' || target.attributes.clipPathUnits?.trim() === 'objectBoundingBox') return null
    const shapes = shapeChildren(target)
    if (shapes.length !== 1 || !CONIC_CLIP_SHAPES.has(shapes[0].name)) return null
    const own = parseTransform(target.attributes.transform)
    const innerTransform = parseTransform(inner.attributes.transform)
    const foreignTransform = parseTransform(foreign.attributes.transform)
    if (!own || !innerTransform || !foreignTransform) return null
    const gradient = parseConicGradient(content.conic)
    if (!gradient) {
      this.warn('読めない角度のグラデーション（conic-gradient）')
      return null
    }
    const made = this.convertElement(shapes[0], multiply(matrix, own), inherited, depth, uses)
    const node = made.length === 1 ? this.nodes[made[0]] : undefined
    if (!node || (node.type !== 'rect' && node.type !== 'ellipse' && node.type !== 'path') || node.width === 0 || node.height === 0) {
      for (const id of made) this.remove(id)
      return null
    }
    // 中心は foreignObject の枠の真ん中。CSS の角度は上向きが 0 で時計回り
    const a = foreign.attributes
    const fx = this.length(a.x, 'width') ?? 0
    const fy = this.length(a.y, 'height') ?? 0
    const fw = this.length(a.width, 'width') ?? 0
    const fh = this.length(a.height, 'height') ?? 0
    const whole = multiply(multiply(matrix, innerTransform), foreignTransform)
    const toNode = (point: Point) => toNodeSpace(node, applyMatrix(whole, point))
    const middle = { x: fx + fw / 2, y: fy + fh / 2 }
    const from = (gradient.from * Math.PI) / 180
    const center = toNode(middle)
    const ahead = toNode({ x: middle.x + Math.sin(from), y: middle.y - Math.cos(from) })
    const start = Math.atan2(ahead.y - center.y, ahead.x - center.x)
    // 裏返す変換なら回る向きが逆になるので、同じ向きから時計回りに読み替える
    const reflected = whole[0] * whole[3] - whole[1] * whole[2] < 0
    const stops = reflected ? gradient.stops.map((stop) => ({ ...stop, offset: round4(1 - stop.offset) })).reverse() : gradient.stops
    const paint: Paint = {
      type: 'conic',
      cx: round4(center.x / node.width),
      cy: round4(center.y / node.height),
      angle: round4(((((start * 180) / Math.PI) % 360) + 360) % 360),
      stops,
      opacity: round4(clamp01(parseFraction(content.conicOpacity ?? undefined) ?? 1)),
      visible: true,
      blendMode: 'normal',
    }
    const opacity = node.opacity * this.opacityOf(element) * this.opacityOf(inner) * this.opacityOf(foreign)
    this.nodes[node.id] = { ...node, name: element.attributes.id ?? node.name, fills: [paint], strokes: [], effects: [], opacity: round4(opacity) }
    return [node.id]
  }

  /** 要素の種類ごとの変換（clip-path / mask は呼び出し側がかける） */
  private convertShape(element: SvgElement, matrix: Matrix, inherited: Inherited, depth: number, uses: number): NodeId[] {
    const { name, attributes } = element
    switch (name) {
      case 'g':
        if (attributes['data-kdr-shape'] !== undefined) return this.kdrShape(element, matrix, inherited, depth, uses)
        // kadrokreo の書き出しが、切り取りを子の要素ごとにかけた印の g（data-kdr-clip）は、フレームにせず中身を返す（clipped が切り取る）
        if (attributes['data-kdr-clip'] !== undefined) return this.convertChildren(element, matrix, inherited, depth, uses)
        return this.group(element, this.convertChildren(element, matrix, inherited, depth + 1, uses), depth)
      case 'a':
      case 'switch':
        return this.group(element, this.convertChildren(element, matrix, inherited, depth + 1, uses), depth)
      case 'svg': {
        // 入れ子の svg は、位置と viewBox だけを読んだ g として扱う（はみ出しは切り取らない）
        const x = this.length(attributes.x, 'width') ?? 0
        const y = this.length(attributes.y, 'height') ?? 0
        const viewBox = viewBoxOf(element)
        const width = this.length(attributes.width, 'width') ?? this.viewport.width
        const height = this.length(attributes.height, 'height') ?? this.viewport.height
        let inner = multiply(matrix, [1, 0, 0, 1, x, y])
        if (viewBox) inner = multiply(inner, viewBoxMatrix(viewBox, { width, height }, attributes.preserveAspectRatio))
        return this.group(element, this.convertChildren(element, inner, inherited, depth + 1, uses), depth)
      }
      case 'use':
        return this.use(element, matrix, inherited, depth, uses)
      case 'rect':
        return this.rect(element, matrix, inherited)
      case 'circle':
      case 'ellipse':
        return this.ellipse(element, matrix, inherited)
      case 'line': {
        const from = { x: this.length(attributes.x1, 'width') ?? 0, y: this.length(attributes.y1, 'height') ?? 0 }
        const to = { x: this.length(attributes.x2, 'width') ?? 0, y: this.length(attributes.y2, 'height') ?? 0 }
        return this.path(element, [{ vertices: [from, to], closed: false }], matrix, inherited, 'Line')
      }
      case 'polyline':
      case 'polygon': {
        const numbers = parseNumbers(attributes.points) ?? []
        const points: Point[] = []
        for (let i = 0; i + 1 < numbers.length; i += 2) points.push({ x: numbers[i], y: numbers[i + 1] })
        if (points.length < 2) return []
        return this.path(element, [{ vertices: points, closed: name === 'polygon' }], matrix, inherited, 'Path')
      }
      case 'path':
        return this.pathData(element, matrix, inherited)
      case 'text':
        return this.text(element, matrix, inherited)
      case 'image':
        return this.image(element, matrix, inherited, depth)
      default:
        this.warn(`対応していない要素（<${name}>）`)
        return []
    }
  }

  /** g などをフレームにする。中身がなければ作らない。深すぎればフレームを作らずに中身を返す */
  private group(element: SvgElement, children: NodeId[], depth: number): NodeId[] {
    if (children.length === 0) return []
    const opacity = this.opacityOf(element)
    if (depth > MAX_FRAME_DEPTH) {
      this.warn('深すぎるグループの入れ子（フレームにせずにまとめた）')
      for (const id of children) this.nodes[id] = { ...this.nodes[id], opacity: this.nodes[id].opacity * opacity }
      return children
    }
    const box = this.boundsOf(children)!
    return [this.wrap(children, box, { name: element.attributes.id ?? 'Group', clipContent: false, opacity })]
  }

  /**
   * kadrokreo の SVG の書き出しが、1 つのノード（塗りが 2 つ以上・矢印などの端・影と線の両方）を要素いくつかの g にまとめたもの
   * （data-kdr-shape。document/svgExport.ts の shapeMark）を、1 つのノードに戻す。塗りと線は要素の順に重ね、
   * 端の図形（data-kdr-part="cap"）と線の残りの輪郭（rest）は捨て、影だけの要素（carrier）からは効果だけを読む。
   * 短くした線は元の形（data-kdr-d）で読み、端の形は data-kdr-caps から戻す。形が合わなければ（手で書き換えたなど）ふつうのグループにする
   */
  private kdrShape(element: SvgElement, matrix: Matrix, inherited: Inherited, depth: number, uses: number): NodeId[] {
    const all: NodeId[] = []
    const bases: (Extract<SceneNode, Style> | TextNode)[] = []
    const extraEffects: Effect[] = []
    let ok = true
    for (const child of element.children) {
      if (typeof child === 'string') continue
      const part = child.attributes['data-kdr-part']
      const d = child.attributes['data-kdr-d']
      // 短くした線は元の形の path として読む（line なら塗らない）
      const source: SvgElement = d === undefined
        ? child
        : { name: 'path', attributes: { ...child.attributes, d, ...(child.name === 'line' ? { fill: 'none' } : {}) }, children: [] }
      const ids = this.convertElement(source, matrix, inherited, depth + 1, uses)
      all.push(...ids)
      if (part === 'cap' || part === 'rest') continue
      const node = ids.length === 1 ? this.nodes[ids[0]] : undefined
      if (!node || !('fills' in node) || !('effects' in node) || node.type === 'frame') {
        ok = false
        continue
      }
      // carrier の描画モードは、その影の描画モード（書き出しは描画モードのある影を carrier に分けて mix-blend-mode を付ける）
      if (part === 'carrier') {
        const mode = 'blendMode' in node ? node.blendMode : 'normal'
        extraEffects.push(...node.effects.map((effect) => (mode !== 'normal' && isShadow(effect) ? { ...effect, blendMode: mode } : effect)))
      }
      else bases.push(node)
    }
    const first = bases[0]
    if (!ok || !first || bases.some((node) => node.type !== first.type)) return this.group(element, all, depth)
    let merged = {
      ...first,
      name: element.attributes.id ?? first.name,
      opacity: this.opacityOf(element),
      fills: bases.flatMap((node) => node.fills).slice(0, MAX_PAINTS),
      effects: [...bases.flatMap((node) => node.effects), ...extraEffects].slice(0, MAX_PAINTS),
    } as Extract<SceneNode, Style> | TextNode
    const styled = bases.filter((node): node is Extract<SceneNode, Style> => 'strokes' in node)
    const stroked = styled.find((node) => node.strokes.length > 0)
    if (merged.type !== 'text' && stroked) {
      merged = {
        ...merged,
        strokes: styled.flatMap((node) => node.strokes).slice(0, MAX_PAINTS),
        strokeWidth: stroked.strokeWidth,
        strokeDashes: stroked.strokeDashes,
        strokeDashOffset: stroked.strokeDashOffset,
        strokeJoin: stroked.strokeJoin,
      }
    }
    if (merged.type === 'path' && stroked?.type === 'path') {
      const caps = element.attributes['data-kdr-caps']?.trim().split(/\s+/)
      const valid = caps?.length === 2 && caps.every((cap) => (CAPS as readonly string[]).includes(cap))
      merged = valid && !merged.closed
        ? { ...merged, startCap: caps[0] as Cap, endCap: caps[1] as Cap }
        : { ...merged, startCap: stroked.startCap, endCap: stroked.endCap }
    }
    for (const id of all) if (id !== first.id) this.remove(id)
    this.nodes[first.id] = merged
    return [first.id]
  }

  /** children を box の位置のフレームにまとめる */
  private wrap(children: NodeId[], box: Bounds, props: Partial<FrameNode>): NodeId {
    const frame: FrameNode = {
      ...createFrame({ x: box.x, y: box.y, width: Math.max(1, box.width), height: Math.max(1, box.height) }),
      id: this.id(),
      fills: [],
      ...props,
      children,
    }
    // 子の座標は、ここまでは外側のフレームの座標。これからはこのフレームの左上が原点
    for (const id of children) {
      const child = this.nodes[id]
      this.nodes[id] = { ...child, parentId: frame.id, x: child.x - box.x, y: child.y - box.y }
    }
    return this.add(frame)
  }

  // ── クリップとマスク ──

  /**
   * clip-path / mask をかける。中身が矩形・円 1 つで軸に沿っていれば、それで切り取るフレーム（角丸）にまとめる。
   * mask は、その図形の塗りの明るさ（と不透明度）をフレームの不透明度にする。表せなければ、かけずに知らせる
   */
  private clipped(element: SvgElement, ids: NodeId[], matrix: Matrix, depth: number): NodeId[] {
    if (ids.length === 0) return ids
    const declared = this.declared(element)
    let result = ids
    // kadrokreo の書き出しの印（data-kdr-clip）は、指す clipPath（フレームの枠）での切り取りとして読む
    const marked = element.name === 'g' ? element.attributes['data-kdr-clip']?.trim() : undefined
    const sources = [
      ...(marked ? [[`url(#${marked})`, 'clipPath'] as const] : []),
      [declared['clip-path']?.trim(), 'clipPath'] as const,
      [declared.mask?.trim(), 'mask'] as const,
    ]
    for (const [raw, kind] of sources) {
      if (raw === undefined || raw === 'none' || raw === '') continue
      const label = kind === 'clipPath' ? 'クリップパス' : 'マスク'
      const url = /^url\(\s*['"]?([^'")]*)['"]?\s*\)$/.exec(raw)
      if (!url || !url[1].trim().startsWith('#')) {
        this.warn(url ? '外部への参照（読まなかった）' : `${label}（読めない指定。かけなかった）`)
        continue
      }
      const target = this.definitions.get(url[1].trim().slice(1))
      if (target?.name !== kind) {
        this.warn(`たどれない${label}の参照`)
        continue
      }
      // 書き出しが印の g の中の要素に 1 つずつかけた切り取り（data-kdr-clip-of）は読まない（印の g で 1 つのフレームに戻す）
      if (target.attributes['data-kdr-clip-of'] !== undefined) continue
      if (depth > MAX_FRAME_DEPTH) {
        this.warn('深すぎるグループの入れ子（フレームにせずにまとめた）')
        continue
      }
      if (kind === 'mask') {
        const painted = this.paintedMask(element, target, matrix, result, depth)
        if (painted !== null) {
          result = [painted]
          continue
        }
      }
      const region = this.clipRegion(target, kind, matrix)
      if (!region) {
        // 矩形・円 1 つで表せなければ、形をマスク（isMask）のパスにして、中身と一緒にフレームにまとめる
        const masked = this.maskShape(target, kind, matrix, result, label)
        if (masked) result = [this.masked(element, result, masked, target.attributes.id ?? (kind === 'clipPath' ? 'Clip' : 'Mask'))]
        continue
      }
      result = [
        this.wrap(result, region.box, {
          name: target.attributes.id ?? (kind === 'clipPath' ? 'Clip' : 'Mask'),
          clipContent: true,
          cornerRadius: tidy(region.radius),
          opacity: region.alpha,
        }),
      ]
    }
    return result
  }

  /**
   * 塗りで透かす mask（中身が図形 1 つで、塗りがグラデーションか、mask-type: alpha のもの）は、その図形を塗りごとノードにして
   * 不透明度・明るさのマスク（maskType）にする。それ以外（単色・いくつもの形）は、形のマスクやフレームの不透明度で表す（clipRegion / maskShape）。
   * 中身にテキスト・画像・グループがあれば pictureMask。
   * 当てはまらなければ null
   */
  private paintedMask(element: SvgElement, target: SvgElement, matrix: Matrix, ids: NodeId[], depth: number): NodeId | null {
    if (target.attributes.maskContentUnits?.trim() === 'objectBoundingBox') return null
    const shapes = shapeChildren(target)
    const type = this.declared(target)['mask-type']?.trim() === 'alpha' ? 'alpha' : 'luminance'
    if (shapes.some((shape) => PICTURE_MASK_ELEMENTS.has(shape.name))) return this.pictureMask(element, target, shapes, type, matrix, ids, depth)
    if (shapes.length !== 1 || !PAINTED_MASK_SHAPES.has(shapes[0].name)) return null
    const [shape] = shapes
    const fill = this.declared(shape).fill?.trim() ?? ''
    if (type === 'luminance' && !fill.startsWith('url(')) return null
    const converted = this.convertElement(shape, matrix, this.inherit(target, ROOT_INHERITED), depth, 0)
    const node = converted.length === 1 ? this.nodes[converted[0]] : undefined
    if (!node || (node.type !== 'rect' && node.type !== 'ellipse' && node.type !== 'path')) {
      for (const id of converted) this.remove(id)
      return null
    }
    const name = target.attributes.id ?? 'Mask'
    const mask = { ...node, name, isMask: true, maskType: type, strokes: [], effects: [] } satisfies SceneNode
    return this.placeMask(element, mask, ids)
  }

  /** マスクのノードを、かかる中身（ids）の最背面に置く。中身が切り取らないグループのフレーム 1 つならその中へ、そうでなければ一緒にフレームにまとめる */
  private placeMask(element: SvgElement, mask: SceneNode, ids: NodeId[]): NodeId {
    const only = ids.length === 1 ? this.nodes[ids[0]] : null
    if (only?.type === 'frame' && GROUP_ELEMENTS.has(element.name) && !only.clipContent) {
      this.nodes[mask.id] = { ...mask, x: mask.x - only.x, y: mask.y - only.y, parentId: only.id }
      this.nodes[only.id] = { ...only, children: [mask.id, ...only.children] }
      return only.id
    }
    this.nodes[mask.id] = mask
    const box = this.boundsOf(ids)!
    return this.wrap([mask.id, ...ids], box, { name: mask.name, clipContent: false })
  }

  /**
   * 中身にテキスト・画像・グループを含む mask は、中身をノードにして（いくつもならフレームにまとめて）、その絵で透かすマスクにする。
   * 書き出しのテキストの形のマスク（data-kdr-mask-type="vector"）は形のマスクに戻す。変換できなければ null
   */
  private pictureMask(
    element: SvgElement,
    target: SvgElement,
    shapes: SvgElement[],
    type: 'alpha' | 'luminance',
    matrix: Matrix,
    ids: NodeId[],
    depth: number,
  ): NodeId | null {
    const inherited = this.inherit(target, ROOT_INHERITED)
    const converted = shapes.flatMap((shape) => this.convertElement(shape, matrix, inherited, depth + 1, 0))
    if (converted.length === 0) return null
    const name = target.attributes.id ?? 'Mask'
    const first = this.nodes[converted[0]]
    const picture =
      converted.length === 1 && canMask(first)
        ? first
        : (this.nodes[this.wrap(converted, this.boundsOf(converted)!, { name, clipContent: false })] as FrameNode)
    const vector = target.attributes['data-kdr-mask-type']?.trim() === 'vector' && picture.type === 'text'
    const mask = { ...picture, name, isMask: true, maskType: vector ? 'vector' : type } as SceneNode
    return this.placeMask(element, mask, ids)
  }

  /** clipPath / mask の中身が、軸に沿った矩形・円 1 つなら、その枠（外側のフレームの座標）と角の丸め */
  private clipRegion(target: SvgElement, kind: 'clipPath' | 'mask', matrix: Matrix): { box: Bounds; radius: number; alpha: number } | null {
    const units = kind === 'clipPath' ? target.attributes.clipPathUnits : target.attributes.maskContentUnits
    if (units?.trim() === 'objectBoundingBox') return null
    const shapes = shapeChildren(target)
    if (shapes.length !== 1) return null
    const [shape] = shapes
    if (shape.name !== 'rect' && shape.name !== 'circle' && shape.name !== 'ellipse') return null
    const own = kind === 'clipPath' ? parseTransform(target.attributes.transform) : IDENTITY
    const inner = parseTransform(shape.attributes.transform)
    if (!own || !inner) return null
    const m = multiply(multiply(matrix, own), inner)
    const eps = 1e-9 * (Math.abs(m[0]) + Math.abs(m[1]) + Math.abs(m[2]) + Math.abs(m[3]))
    const straight = Math.abs(m[1]) <= eps && Math.abs(m[2]) <= eps
    const quarter = Math.abs(m[0]) <= eps && Math.abs(m[3]) <= eps
    if (!straight && !quarter) return null
    const a = shape.attributes
    let userBox: Bounds
    let rx: number
    let ry: number
    if (shape.name === 'rect') {
      userBox = {
        x: this.length(a.x, 'width') ?? 0,
        y: this.length(a.y, 'height') ?? 0,
        width: this.length(a.width, 'width') ?? 0,
        height: this.length(a.height, 'height') ?? 0,
      }
      const rxRaw = this.length(a.rx, 'width')
      const ryRaw = this.length(a.ry, 'height')
      rx = Math.min(Math.max(0, rxRaw ?? ryRaw ?? 0), userBox.width / 2)
      ry = Math.min(Math.max(0, ryRaw ?? rxRaw ?? 0), userBox.height / 2)
    } else {
      const cx = this.length(a.cx, 'width') ?? 0
      const cy = this.length(a.cy, 'height') ?? 0
      rx = shape.name === 'circle' ? (this.length(a.r, 'diagonal') ?? 0) : (this.length(a.rx, 'width') ?? this.length(a.ry, 'height') ?? 0)
      ry = shape.name === 'circle' ? rx : (this.length(a.ry, 'height') ?? rx)
      userBox = { x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 }
    }
    if (!(userBox.width > 0 && userBox.height > 0)) return null
    const box = transformRect(m, userBox)
    // 角の丸めは、縦と横が同じ長さになるときだけ表せる（円は正方形の枠のときだけ）
    const sx = Math.hypot(m[0], m[1])
    const sy = Math.hypot(m[2], m[3])
    const [pageRx, pageRy] = straight ? [rx * sx, ry * sy] : [ry * sy, rx * sx]
    if (Math.abs(pageRx - pageRy) > 1e-6 * Math.max(1, pageRx)) return null
    if (shape.name !== 'rect' && Math.abs(box.width - box.height) > 1e-6 * Math.max(1, box.width)) return null
    let alpha = 1
    if (kind === 'mask') {
      // マスクの明るさ。中身の既定の塗りは黒（何も見えない）
      const style = this.declared(shape)
      const fill = (style.fill ?? 'black').trim()
      const color = fill === 'none' ? null : parseColor(fill === 'currentColor' ? (style.color ?? 'black') : fill)
      if (!color) return null
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.color.slice(i, i + 2), 16) / 255)
      const luminance = 0.2125 * r + 0.7154 * g + 0.0721 * b
      alpha = clamp01(luminance * color.alpha * (parseFraction(style['fill-opacity']) ?? 1) * this.opacityOf(shape))
      if (alpha < 1e-3) return null
    }
    return { box, radius: Math.min(pageRx, box.width / 2, box.height / 2), alpha: round4(alpha) }
  }

  /**
   * clipPath / mask の中身の図形（rect・circle・ellipse・polygon・polyline・path と、それを指す use）を、マスクの輪郭（外側のフレームの座標）にする。
   * clipPath は全部の形を足した範囲（nonzero。形が 1 つならその clip-rule）。mask は塗りの明るさで分け、明るい形（見せる）のあとに暗い形（隠す）が
   * 続けば、偶奇（evenodd）で暗い形を穴にする（暗い形が明るい形の内側にあるときに正しい）。明るさが半端なら形だけかけて知らせる。
   * 明るい形の明るさが揃っていれば、それをフレームの不透明度にする。読めない中身なら知らせて null
   */
  private maskShape(
    target: SvgElement,
    kind: 'clipPath' | 'mask',
    matrix: Matrix,
    ids: NodeId[],
    label: string,
  ): { contours: Contour[]; rule: 'nonzero' | 'evenodd'; alpha: number } | null {
    const units = kind === 'clipPath' ? target.attributes.clipPathUnits : target.attributes.maskContentUnits
    let base = matrix
    if (units?.trim() === 'objectBoundingBox') {
      // 中身を囲む枠の割合。枠は外側のフレームの座標で取るので、中身が回っていたり歪んでいたりすると近似になる
      const box = this.boundsOf(ids)
      if (!box) return null
      base = [box.width, 0, 0, box.height, box.x, box.y]
    }
    const own = kind === 'clipPath' ? parseTransform(target.attributes.transform) : IDENTITY
    if (!own) return null
    const shapes = shapeChildren(target)
    const parts: { contours: Contour[]; alpha: number; rule: string }[] = []
    for (const child of shapes) {
      let shape = child
      let m = multiply(base, own)
      // use は 1 段だけたどる（clipPath の中で use は図形を指すことしかできない）
      if (shape.name === 'use') {
        const href = hrefOf(shape)
        const referenced = href?.startsWith('#') ? this.definitions.get(href.slice(1)) : undefined
        const useTransform = parseTransform(shape.attributes.transform)
        if (!referenced || !useTransform) return this.unreadableMask(label)
        m = multiply(multiply(m, useTransform), [1, 0, 0, 1, this.length(shape.attributes.x, 'width') ?? 0, this.length(shape.attributes.y, 'height') ?? 0])
        shape = referenced
      }
      const inner = parseTransform(shape.attributes.transform)
      const userContours = this.shapeOutline(shape)
      if (!inner || userContours === null) return this.unreadableMask(label)
      const style = this.declared(shape)
      if (style.display?.trim() === 'none') continue
      m = multiply(m, inner)
      const contours = userContours.map((contour) => ({
        vertices: mapVertices(contour.vertices, (point) => applyMatrix(m, point)),
        closed: true,
      }))
      let alpha = 1
      if (kind === 'mask') {
        const fill = (style.fill ?? 'black').trim()
        const color = fill === 'none' ? null : parseColor(fill === 'currentColor' ? (style.color ?? 'black') : fill)
        if (fill === 'none') continue
        if (!color) {
          this.warn('グラデーションなどで塗ったマスク（形だけかけた）')
        } else {
          const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.color.slice(i, i + 2), 16) / 255)
          alpha = clamp01((0.2125 * r + 0.7154 * g + 0.0721 * b) * color.alpha * (parseFraction(style['fill-opacity']) ?? 1) * this.opacityOf(shape))
        }
      }
      parts.push({ contours, alpha, rule: (style['clip-rule'] ?? style['fill-rule'] ?? 'nonzero').trim() })
    }
    const shown = parts.filter((part) => part.alpha >= 0.5)
    const hidden = parts.filter((part) => part.alpha < 0.5)
    if (shown.length === 0) return this.unreadableMask(label)
    // 暗い形は明るい形のあとだけ（先に描いた暗い形は、あとの明るい形に塗りつぶされる）
    const firstHidden = parts.findIndex((part) => part.alpha < 0.5)
    const lastShown = parts.findLastIndex((part) => part.alpha >= 0.5)
    const holes = firstHidden !== -1 && firstHidden < lastShown ? [] : hidden
    if (parts.some((part) => part.alpha > 1e-3 && part.alpha < 0.999)) {
      if (new Set(shown.map((part) => round4(part.alpha))).size > 1 || holes.some((part) => part.alpha > 1e-3)) {
        this.warn('明るさが半端なマスク（形だけかけた）')
      }
    }
    const alphas = new Set(shown.map((part) => round4(part.alpha)))
    const alpha = alphas.size === 1 ? [...alphas][0] : 1
    const contours = [...shown, ...holes].flatMap((part) => part.contours)
    const total = contours.reduce((sum, contour) => sum + contour.vertices.length, 0)
    if (contours.length === 0 || total > MAX_PATH_POINTS) return this.unreadableMask(label)
    const rule = holes.length > 0 ? 'evenodd' : parts.length === 1 && parts[0].rule === 'evenodd' ? 'evenodd' : 'nonzero'
    return { contours, rule, alpha }
  }

  private unreadableMask(label: string): null {
    this.warn(`${label}（読めない中身。かけなかった）`)
    return null
  }

  /** 図形の要素の輪郭（その要素の座標。transform はかけない）。図形でなければ null */
  private shapeOutline(shape: SvgElement): Contour[] | null {
    const a = shape.attributes
    switch (shape.name) {
      case 'rect': {
        const box = {
          x: this.length(a.x, 'width') ?? 0,
          y: this.length(a.y, 'height') ?? 0,
          width: this.length(a.width, 'width') ?? 0,
          height: this.length(a.height, 'height') ?? 0,
        }
        if (!(box.width > 0 && box.height > 0)) return []
        const rxRaw = this.length(a.rx, 'width')
        const ryRaw = this.length(a.ry, 'height')
        const rx = Math.min(Math.max(0, rxRaw ?? ryRaw ?? 0), box.width / 2)
        const ry = Math.min(Math.max(0, ryRaw ?? rxRaw ?? 0), box.height / 2)
        return [{ vertices: roundedRect(box, rx, ry), closed: true }]
      }
      case 'circle':
      case 'ellipse': {
        const cx = this.length(a.cx, 'width') ?? 0
        const cy = this.length(a.cy, 'height') ?? 0
        const rx = shape.name === 'circle' ? (this.length(a.r, 'diagonal') ?? 0) : (this.length(a.rx, 'width') ?? this.length(a.ry, 'height') ?? 0)
        const ry = shape.name === 'circle' ? rx : (this.length(a.ry, 'height') ?? rx)
        return rx > 0 && ry > 0 ? [{ vertices: ellipseVertices(cx, cy, rx, ry), closed: true }] : []
      }
      case 'polygon':
      case 'polyline': {
        const numbers = parseNumbers(a.points) ?? []
        const points: Point[] = []
        for (let i = 0; i + 1 < numbers.length; i += 2) points.push({ x: numbers[i], y: numbers[i + 1] })
        return points.length >= 3 ? [{ vertices: points, closed: true }] : []
      }
      case 'path': {
        if (a.d === undefined || a.d.trim() === '') return []
        try {
          return parsePathData(a.d).filter((subpath) => subpath.vertices.length >= 2)
        } catch (error) {
          if (!(error instanceof PathDataError)) throw error
          return null
        }
      }
      default:
        return null
    }
  }

  /**
   * 中身（ids）にマスクのパスをかける。中身がこの要素から作ったグループのフレーム 1 つなら、その最背面にマスクを入れる。
   * そうでなければ、マスクと中身をフレーム（はみ出しは隠さない）にまとめる。マスクの明るさはフレームの不透明度にする
   */
  private masked(
    element: SvgElement,
    ids: NodeId[],
    mask: { contours: Contour[]; rule: 'nonzero' | 'evenodd'; alpha: number },
    name: string,
  ): NodeId {
    const shape = pathFromContours(mask.contours)
    const node: PathNode = {
      ...createPath(shape, true),
      contours: shape.contours,
      id: this.id(),
      name,
      strokes: [],
      fillRule: mask.rule,
      isMask: true,
    }
    const only = ids.length === 1 ? this.nodes[ids[0]] : null
    if (only?.type === 'frame' && GROUP_ELEMENTS.has(element.name) && !only.clipContent) {
      this.nodes[node.id] = { ...node, x: node.x - only.x, y: node.y - only.y, parentId: only.id }
      this.nodes[only.id] = { ...only, children: [node.id, ...only.children], opacity: round4(only.opacity * mask.alpha) }
      return only.id
    }
    this.add(node)
    const box = this.boundsOf(ids)!
    return this.wrap([node.id, ...ids], box, { name, clipContent: false, opacity: mask.alpha })
  }

  private use(element: SvgElement, matrix: Matrix, inherited: Inherited, depth: number, uses: number): NodeId[] {
    const href = hrefOf(element)
    if (href === undefined) return []
    if (!href.startsWith('#')) {
      this.warn('外部への参照（読まなかった）')
      return []
    }
    const id = href.slice(1)
    const target = this.definitions.get(id)
    if (!target || this.using.has(id) || uses >= MAX_USE_DEPTH) {
      this.warn('たどれない <use> の参照')
      return []
    }
    const x = this.length(element.attributes.x, 'width') ?? 0
    const y = this.length(element.attributes.y, 'height') ?? 0
    let inner = multiply(matrix, [1, 0, 0, 1, x, y])
    this.using.add(id)
    try {
      let ids: NodeId[]
      if (target.name === 'symbol') {
        const viewBox = viewBoxOf(target)
        const width = this.length(element.attributes.width, 'width')
        const height = this.length(element.attributes.height, 'height')
        if (viewBox) {
          inner = multiply(
            inner,
            viewBoxMatrix(viewBox, { width: width ?? viewBox[2], height: height ?? viewBox[3] }, target.attributes.preserveAspectRatio),
          )
        }
        ids = this.convertChildren(target, inner, this.inherit(target, inherited), depth + 1, uses + 1)
      } else {
        ids = this.convertElement(target, inner, inherited, depth + 1, uses + 1)
      }
      return this.group({ ...element, attributes: { ...element.attributes, id: element.attributes.id ?? id } }, ids, depth)
    } finally {
      this.using.delete(id)
    }
  }

  private rect(element: SvgElement, matrix: Matrix, inherited: Inherited): NodeId[] {
    const a = element.attributes
    const x = this.length(a.x, 'width') ?? 0
    const y = this.length(a.y, 'height') ?? 0
    const width = this.length(a.width, 'width') ?? 0
    const height = this.length(a.height, 'height') ?? 0
    if (!(width > 0 && height > 0)) return []
    let rx = this.length(a.rx, 'width')
    let ry = this.length(a.ry, 'height')
    if (rx === null || rx < 0) rx = ry !== null && ry > 0 ? ry : 0
    if (ry === null || ry < 0) ry = rx
    rx = Math.min(rx, width / 2)
    ry = Math.min(ry, height / 2)
    const userBox = { x, y, width, height }
    const pose = decompose(matrix)
    // 角丸が縦横で同じなら、矩形のノードで表せる
    if (pose && Math.abs(rx * pose.scaleX - ry * pose.scaleY) < 1e-6) {
      const node = this.placed(createRect({ x: 0, y: 0, width: 0, height: 0 }), userBox, matrix, pose)
      return this.shape({ ...node, cornerRadius: rx * pose.scaleX }, element, matrix, inherited, userBox)
    }
    return this.path(element, [{ vertices: roundedRect(userBox, rx, ry), closed: true }], matrix, inherited, 'Rectangle', userBox)
  }

  private ellipse(element: SvgElement, matrix: Matrix, inherited: Inherited): NodeId[] {
    const a = element.attributes
    const cx = this.length(a.cx, 'width') ?? 0
    const cy = this.length(a.cy, 'height') ?? 0
    let rx: number
    let ry: number
    if (element.name === 'circle') {
      rx = ry = this.length(a.r, 'diagonal') ?? 0
    } else {
      const rxRaw = this.length(a.rx, 'width')
      const ryRaw = this.length(a.ry, 'height')
      rx = rxRaw ?? ryRaw ?? 0
      ry = ryRaw ?? rxRaw ?? 0
    }
    if (!(rx > 0 && ry > 0)) return []
    const userBox = { x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 }
    const pose = decompose(matrix)
    if (pose) {
      const node = this.placed(createEllipse({ x: 0, y: 0, width: 0, height: 0 }), userBox, matrix, pose)
      return this.shape(node, element, matrix, inherited, userBox)
    }
    return this.path(element, [{ vertices: ellipseVertices(cx, cy, rx, ry), closed: true }], matrix, inherited, 'Ellipse', userBox)
  }

  /** SVG の座標での枠（userBox）を、回転つきのノードの位置と大きさにする */
  private placed<T extends SceneNode>(
    node: T,
    userBox: Bounds,
    matrix: Matrix,
    pose: { rotation: number; scaleX: number; scaleY: number },
  ): T {
    const center = applyMatrix(matrix, { x: userBox.x + userBox.width / 2, y: userBox.y + userBox.height / 2 })
    const width = userBox.width * pose.scaleX
    const height = userBox.height * pose.scaleY
    return { ...node, x: center.x - width / 2, y: center.y - height / 2, width, height, rotation: rotationOf(pose.rotation) }
  }

  /** 輪郭（SVG の座標）をパスにする。輪郭が複数なら 2 つ目以降は contours になる */
  private path(
    element: SvgElement,
    userContours: Contour[],
    matrix: Matrix,
    inherited: Inherited,
    fallbackName: string,
    box?: Bounds,
  ): NodeId[] {
    const contours = userContours.filter((contour) => contour.vertices.length >= 2)
    if (contours.length === 0) return []
    // objectBoundingBox のグラデーションは、全部の輪郭を囲む枠にかかる
    const userBox = box ?? unionBounds(contours.map((contour) => pathBounds(contour.vertices, contour.closed)))!
    if (contours.reduce((sum, contour) => sum + contour.vertices.length, 0) > MAX_PATH_POINTS) {
      this.warn('頂点が多すぎるパス（読み飛ばした）')
      return []
    }
    const shape = pathFromContours(
      contours.map((contour) => ({ vertices: mapVertices(contour.vertices, (point) => applyMatrix(matrix, point)), closed: contour.closed })),
    )
    const node: PathNode = { ...createPath(shape, shape.closed), contours: shape.contours, name: fallbackName }
    return this.shape(node, element, matrix, inherited, userBox)
  }

  private pathData(element: SvgElement, matrix: Matrix, inherited: Inherited): NodeId[] {
    const d = element.attributes.d
    if (d === undefined || d.trim() === '') return []
    let subpaths
    try {
      subpaths = parsePathData(d)
    } catch (error) {
      if (!(error instanceof PathDataError)) throw error
      this.warn('読めない path の d（読み飛ばした）')
      return []
    }
    // 輪郭が複数あれば 1 つのパスの輪郭にする（穴は fill-rule で開く）。objectBoundingBox のグラデーションは全部の輪郭を囲む枠にかかる
    return this.path(element, subpaths, matrix, inherited, 'Path')
  }

  /**
   * data URI（PNG・JPEG・WebP・GIF）の <image> を画像のノードにする。SVG の画像は別の文書として変換する（svgImage）。外部の URL は読まない。
   * preserveAspectRatio は収め方（meet → contain、slice → cover、none → stretch）と寄せる位置にする
   */
  private image(element: SvgElement, matrix: Matrix, inherited: Inherited, depth: number): NodeId[] {
    const a = element.attributes
    const href = hrefOf(element)
    if (href === undefined || href === '') return []
    if (!/^data:/i.test(href)) {
      this.warn('外部の画像（<image>。読まなかった）')
      return []
    }
    if (/^data:image\/svg\+xml[;,]/i.test(href.trim())) return this.svgImage(element, href.trim(), matrix, inherited, depth)
    const bytes = decodeDataUri(href)
    const info = bytes ? readImageInfo(bytes) : null
    if (!bytes || !info || !IMAGE_MIME_TYPES.includes(info.mime)) {
      this.warn('PNG・JPEG・WebP・GIF でない画像（<image>。読み飛ばした）')
      return []
    }
    if (bytes.byteLength > KDR_MAX_ASSET_BYTES || isImageTooLarge(info)) {
      this.warn('大きすぎる画像（<image>。読み飛ばした）')
      return []
    }
    // 大きさの指定がなければ、画像の元の大きさ
    const width = this.length(a.width, 'width') ?? info.width
    const height = this.length(a.height, 'height') ?? info.height
    if (!(width > 0 && height > 0)) return []
    const userBox = { x: this.length(a.x, 'width') ?? 0, y: this.length(a.y, 'height') ?? 0, width, height }
    // 裏返していれば、枠の中心で左右に映し戻した変換で置き、裏返しは flipX で持つ（上下の裏返しは左右の裏返し + 180° の回転になる）
    const flipped = isFlipped(matrix)
    const placement = flipped ? multiply(matrix, mirrorAt(userBox.x + userBox.width / 2)) : matrix
    let pose = decompose(placement)
    if (!pose) {
      this.warn('歪めた画像（回転と拡大だけにした）')
      pose = { rotation: (Math.atan2(placement[1], placement[0]) * 180) / Math.PI, scaleX: Math.hypot(placement[0], placement[1]), scaleY: Math.hypot(placement[2], placement[3]) }
    }
    const assetId = sha256Hex(bytes)
    this.assets[assetId] ??= { mime: info.mime, bytes }
    const [align = 'xMidYMid', mode = 'meet'] = (a.preserveAspectRatio ?? 'xMidYMid meet').trim().split(/\s+/)
    const fit: ImageNode['fit'] = align === 'none' ? 'stretch' : mode === 'slice' ? 'cover' : 'contain'
    const node: ImageNode = {
      ...this.placed(createImage({ x: 0, y: 0, width: 0, height: 0 }, assetId), userBox, placement, pose),
      flipX: flipped,
      name: a.id ?? 'Image',
      fit,
      positionX: align.startsWith('xMin') ? 0 : align.startsWith('xMax') ? 1 : 0.5,
      positionY: align.endsWith('YMin') ? 0 : align.endsWith('YMax') ? 1 : 0.5,
      visible: inherited.visible,
      opacity: this.opacityOf(element),
    }
    return [this.add(node)]
  }

  /**
   * SVG の画像（data:image/svg+xml の <image>）を、別の文書として変換してフレームにまとめる。
   * 中の id・CSS・受け継ぐ値は外側と分ける（ブラウザも別の文書として描く）。外部の参照を読まないことや上限は外側と同じで、
   * 入れ子の深さ・変換する回数・要素の数の合計にも上限を置く（use でくり返し指したり、入れ子にしたりして膨らませる細工を止める）。
   * 収め方は <image> の preserveAspectRatio（中の svg の preserveAspectRatio は使わない）。はみ出しは、軸に沿って置かれていれば切り取る
   */
  private svgImage(element: SvgElement, href: string, matrix: Matrix, inherited: Inherited, depth: number): NodeId[] {
    if (this.imageDepth >= MAX_SVG_IMAGE_DEPTH) {
      this.warn('入れ子が深すぎる SVG の画像（<image>。読み飛ばした）')
      return []
    }
    if (this.shared.svgImageCount >= MAX_SVG_IMAGES) {
      this.warn(`${MAX_SVG_IMAGES} 個を超えた SVG の画像（<image>。読み飛ばした）`)
      return []
    }
    let tree = this.shared.svgImages.get(href)
    if (tree === undefined) {
      tree = null
      const bytes = decodeDataUri(href)
      if (bytes && bytes.byteLength <= MAX_SVG_LENGTH) {
        try {
          const parsed = parseSvgXml(new TextDecoder('utf-8', { fatal: false }).decode(bytes))
          if (parsed.name === 'svg') tree = parsed
        } catch {
          // 読めない SVG。下で知らせる
        }
      }
      this.shared.svgImages.set(href, tree)
    }
    if (!tree) {
      this.warn('読めない SVG の画像（<image>。読み飛ばした）')
      return []
    }
    const elements = countElements(tree)
    if (this.shared.svgImageElements + elements > MAX_SVG_IMAGE_ELEMENTS) {
      this.warn('要素が多すぎる SVG の画像（<image>。読み飛ばした）')
      return []
    }
    this.shared.svgImageCount++
    this.shared.svgImageElements += elements
    const inner = new Converter(tree, this.options, this.shared, this.imageDepth + 1)
    const size = inner.prepare()
    const a = element.attributes
    // 大きさの指定がなければ、画像（中の svg）の大きさ
    const width = this.length(a.width, 'width') ?? size.width
    const height = this.length(a.height, 'height') ?? size.height
    if (!(width > 0 && height > 0)) return []
    const box = { x: this.length(a.x, 'width') ?? 0, y: this.length(a.y, 'height') ?? 0, width, height }
    const fit = viewBoxMatrix([0, 0, size.width, size.height], { width, height }, a.preserveAspectRatio)
    const outer = multiply(multiply(matrix, [1, 0, 0, 1, box.x, box.y]), fit)
    const children = inner.convertRoot(outer, depth + 1)
    if (children.length === 0) return []
    const props = {
      name: a.id ?? 'Image',
      opacity: round4(this.opacityOf(element) * inner.opacityOf(tree)),
      visible: inherited.visible,
    }
    if (depth > MAX_FRAME_DEPTH) {
      this.warn('深すぎるグループの入れ子（フレームにせずにまとめた）')
      for (const id of children) this.nodes[id] = { ...this.nodes[id], opacity: this.nodes[id].opacity * props.opacity }
      return children
    }
    // 軸に沿っていれば、画像の枠で切り取るフレームにする。回っていれば中身を囲むフレーム（切り取らない）
    const eps = 1e-9 * (Math.abs(matrix[0]) + Math.abs(matrix[1]) + Math.abs(matrix[2]) + Math.abs(matrix[3]))
    if (Math.abs(matrix[1]) <= eps && Math.abs(matrix[2]) <= eps) {
      return [this.wrap(children, transformRect(matrix, box), { ...props, clipContent: true })]
    }
    this.warn('回した SVG の画像（はみ出しを切り取らなかった）')
    return [this.wrap(children, this.boundsOf(children)!, { ...props, clipContent: false })]
  }

  private text(element: SvgElement, given: Matrix, inherited: Inherited): NodeId[] {
    const lines = textLines(element)
    if (lines.length === 0) return []
    if (hasDescendant(element, 'textPath')) this.warn('線に沿った文字（<textPath>。まっすぐ並べた）')
    const a = element.attributes
    const x = (parseNumbers(a.x)?.[0] ?? 0) + (parseNumbers(a.dx)?.[0] ?? 0)
    const y = (parseNumbers(a.y)?.[0] ?? 0) + (parseNumbers(a.dy)?.[0] ?? 0)
    const scale = lengthScale(given)
    const anchor = inherited.textAnchor === 'middle' ? 'center' : inherited.textAnchor === 'end' ? 'right' : 'left'
    const base = createText({ x: 0, y: 0, width: 0, height: 0 }, lines.join('\n'))
    const lineHeight = lineHeightOf(element, lines.length, inherited.fontSize)
    let node: TextNode = {
      ...base,
      ...(lineHeight === null ? {} : { lineHeight }),
      fontSize: Math.max(1, tidy(inherited.fontSize * scale)),
      fontFamily: inherited.fontFamily,
      fontWeight: fontWeightOf(inherited.fontWeight),
      textAlign: anchor,
    }
    const size = this.options.measureText(node)
    node = { ...node, ...size }
    // SVG の (x, y) は 1 行目の基線の、text-anchor の側の端。kadrokreo のテキストは枠の左上で置く
    const baseline = textBaseline(node, (this.options.textMetrics ?? estimateTextMetrics)(node))
    const offsetX = anchor === 'center' ? -size.width / 2 : anchor === 'right' ? -size.width : 0
    // 裏返していれば、文字の枠の中心で左右に映し戻した変換で置き、裏返しは flipX で持つ
    const flipped = isFlipped(given)
    const matrix = flipped ? multiply(given, mirrorAt(x + (offsetX + size.width / 2) / (scale || 1))) : given
    const pose = decompose(matrix)
    if (!pose) this.warn('歪めたテキスト（回転と拡大だけにした）')
    const rotation = pose ? pose.rotation : (Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI
    const origin = applyMatrix(matrix, { x, y })
    const center = rotateVector({ x: offsetX + size.width / 2, y: -baseline + size.height / 2 }, rotation)
    node = {
      ...node,
      x: origin.x + center.x - size.width / 2,
      y: origin.y + center.y - size.height / 2,
      rotation: rotationOf(rotation),
      flipX: flipped,
      name: a.id ?? lines[0].slice(0, 40),
      visible: inherited.visible,
      opacity: this.opacityOf(element),
    }
    const userBox = { x, y: y - inherited.fontSize, width: size.width / (scale || 1), height: size.height / (scale || 1) }
    node = { ...node, fills: this.paint(inherited.fill, inherited.fillOpacity, inherited, matrix, userBox, node) }
    if (inherited.stroke.trim() !== 'none') this.warn('文字の線（stroke）')
    return [this.add(node)]
  }

  /** 図形のノードに、名前・表示・塗り・線を付けて加える */
  private shape(
    node: Extract<SceneNode, Style>,
    element: SvgElement,
    matrix: Matrix,
    inherited: Inherited,
    userBox: Bounds,
  ): NodeId[] {
    const strokeWidth = (parseLength(inherited.strokeWidth, Math.hypot(this.viewport.width, this.viewport.height) / Math.SQRT2) ?? 1) *
      lengthScale(matrix)
    // 直線には面がないので塗らない
    const isLine = element.name === 'line'
    const fill = isLine ? [] : this.paint(inherited.fill, inherited.fillOpacity, inherited, matrix, userBox, node)
    const stroke = strokeWidth > 0 ? this.paint(inherited.stroke, inherited.strokeOpacity, inherited, matrix, userBox, node) : []
    const id = element.attributes.id
    // 線の端の形（stroke-linecap）は、開いたパスの両端に写す。閉じた形には端がない
    const cap: Cap | null = inherited.lineCap === 'round' || inherited.lineCap === 'square' ? inherited.lineCap : null
    const caps = node.type === 'path' && !node.closed && cap && stroke.length > 0 ? { startCap: cap, endCap: cap } : {}
    const fillRule = node.type === 'path' && inherited.fillRule === 'evenodd' ? { fillRule: 'evenodd' as const } : {}
    const dash = stroke.length > 0 ? this.dashes(inherited, lengthScale(matrix)) : { strokeDashes: [], strokeDashOffset: 0 }
    // miter-clip・arcs（SVG 2）は持てないので、近い miter にする
    const join = inherited.lineJoin.trim()
    const strokeJoin: StrokeJoin = join === 'round' || join === 'bevel' ? join : 'miter'
    const named = {
      ...node,
      ...caps,
      ...fillRule,
      ...dash,
      strokeJoin: stroke.length > 0 ? strokeJoin : 'miter',
      name: id !== undefined && id !== '' ? id : node.name,
      fills: fill,
      strokes: stroke,
      effects: this.filterEffects(element, matrix) ?? [],
      strokeWidth: stroke.length > 0 ? tidy(strokeWidth) : node.strokeWidth,
      visible: inherited.visible,
      opacity: this.opacityOf(element),
    }
    return [this.add(named)]
  }

  /**
   * 要素の filter が影だけの形（filters.ts）なら、kadrokreo の効果にする。読めなければ null（呼び出し側が知らせる）。
   * ずれは要素の座標系からページの向きに直し（kadrokreo の影のずれは回転に従わない）、ぼかしは拡大の分だけ大きくする
   */
  private filterEffects(element: SvgElement, matrix: Matrix): Effect[] | null {
    const raw = this.declared(element).filter?.trim()
    if (raw === undefined || raw === 'none') return null
    const url = /^url\(\s*['"]?#([^'")]*)['"]?\s*\)$/.exec(raw)
    const target = url ? this.definitions.get(url[1].trim()) : undefined
    if (target?.name !== 'filter') return null
    const effects = readShadowFilter(target, (part) => this.declared(part))
    if (!effects) return null
    const scale = lengthScale(matrix)
    return effects.slice(0, MAX_PAINTS).map((effect): Effect => {
      const blur = tidy(effect.stdDeviation * 2 * scale)
      if (effect.type === 'layer-blur') return { type: effect.type, blur, visible: true }
      return {
        type: effect.type,
        x: tidy(matrix[0] * effect.dx + matrix[2] * effect.dy),
        y: tidy(matrix[1] * effect.dx + matrix[3] * effect.dy),
        blur,
        spread: tidy(effect.spread * scale),
        blendMode: effect.blendMode,
        color: effect.color,
        opacity: round4(effect.opacity),
        visible: true,
      }
    })
  }

  /**
   * stroke-dasharray を破線の並び（ページの px）にする。数が奇数なら 2 回繰り返す（SVG の決まり）。
   * 負の数や読めない数があれば、SVG と同じく実線。すべて 0 も実線。stroke-dashoffset はずれ（同じく拡大をかける）にする
   */
  private dashes(inherited: Inherited, scale: number): { strokeDashes: number[]; strokeDashOffset: number } {
    const solid = { strokeDashes: [], strokeDashOffset: 0 }
    const raw = inherited.dashArray.trim()
    if (raw === 'none' || raw === '') return solid
    const diagonal = Math.hypot(this.viewport.width, this.viewport.height) / Math.SQRT2
    const values = raw.split(/[\s,]+/).filter((part) => part !== '').map((part) => parseLength(part, diagonal))
    if (values.length === 0 || values.some((value) => value === null || !Number.isFinite(value) || value < 0)) return solid
    let list = (values as number[]).map((value) => tidy(value * scale))
    if (list.every((value) => value === 0)) return solid
    if (list.length % 2 === 1) list = [...list, ...list]
    if (list.length > MAX_DASHES) {
      this.warn(`${MAX_DASHES} を超える破線の並び（実線にした）`)
      return solid
    }
    const offset = parseLength(inherited.dashOffset, diagonal)
    return { strokeDashes: list, strokeDashOffset: offset !== null && Number.isFinite(offset) ? tidy(offset * scale) : 0 }
  }

  /** 足したノードを囲む矩形（外側のフレームの座標）。空なら null */
  private boundsOf(ids: readonly NodeId[]): Bounds | null {
    return unionBounds(ids.map((id) => outerBounds(this.nodes[id])))
  }

  /**
   * ノードを足す。数が上限に達したら、それより後の要素は読まない（convertElement が stopped を見て止める）。
   * 読みかけの要素（いま足しているノードや、子を読み終えたグループのフレーム）は足す。足さないと、親子のつながりが切れたノードが残るため。
   * 上限を超える分は、入れ子の深さ（上限あり）とマスクの分だけに収まる
   */
  private add(node: SceneNode): NodeId {
    if (this.shared.nodeCount >= MAX_NODES) {
      if (!this.shared.stopped) this.warn(`${MAX_NODES} 個を超えた分の図形（読み飛ばした）`)
      this.shared.stopped = true
    }
    if (!Object.hasOwn(this.nodes, node.id)) this.shared.nodeCount++
    this.nodes[node.id] = node
    return node.id
  }

  /** add で足したノードを取り消す */
  private remove(id: NodeId): void {
    if (!Object.hasOwn(this.nodes, id)) return
    delete this.nodes[id]
    this.shared.nodeCount--
  }

  // ── 塗り ──

  /**
   * fill / stroke の値を塗りにする。色の alpha・fill-opacity（stroke-opacity）・グラデーションの揃った色の透明度は、塗りの不透明度（Paint.opacity）に写す
   */
  private paint(
    raw: string,
    opacity: number,
    inherited: Inherited,
    matrix: Matrix,
    userBox: Bounds,
    node: SceneNode,
  ): Paint[] {
    const { paints, alpha } = this.paintOf(raw, opacity, inherited, matrix, userBox, node)
    return paints.map((paint) => {
      const value = round4(clamp01(paint.opacity * alpha))
      return value === paint.opacity ? paint : { ...paint, opacity: value }
    })
  }

  private paintOf(
    raw: string,
    opacity: number,
    inherited: Inherited,
    matrix: Matrix,
    userBox: Bounds,
    node: SceneNode,
  ): { paints: Paint[]; alpha: number } {
    const value = raw.trim()
    const none = { paints: [], alpha: 1 }
    if (value === 'none') return none
    const url = /^url\(\s*['"]?([^'")]*)['"]?\s*\)\s*(.*)$/.exec(value)
    if (url) {
      const fallback = url[2].trim()
      const target = url[1].trim()
      if (!target.startsWith('#')) {
        this.warn('外部への参照（読まなかった）')
        return fallback !== '' ? this.paintOf(fallback, opacity, inherited, matrix, userBox, node) : none
      }
      const element = this.definitions.get(target.slice(1))
      if (element?.name === 'linearGradient') {
        const paint = this.linearGradient(element, inherited, matrix, userBox, node)
        return paint ? { paints: [paint], alpha: opacity * (this.uniformStopOpacity(element, inherited) ?? 1) } : none
      }
      if (element?.name === 'radialGradient') {
        const paint = this.radialGradient(element, inherited, matrix, userBox, node)
        return paint ? { paints: [paint], alpha: opacity * (this.uniformStopOpacity(element, inherited) ?? 1) } : none
      }
      if (element?.name === 'pattern') {
        // kadrokreo が書き出した角度のグラデーションなら、元の値から戻す
        const conic = this.conicPattern(element, matrix, node) ?? this.wedgePattern(element, matrix, node)
        if (conic) return { paints: [conic], alpha: opacity }
        this.warn('パターンの塗り')
      }
      else this.warn('たどれない塗りの参照')
      return fallback !== '' ? this.paintOf(fallback, opacity, inherited, matrix, userBox, node) : none
    }
    const color = this.color(value, inherited)
    if (!color) {
      this.warn('読めない色')
      return none
    }
    if (color.alpha === 0) return none
    return { paints: [solidPaint(color.color)], alpha: color.alpha * opacity }
  }

  /**
   * kadrokreo の SVG の書き出しが角度のグラデーションを近似した pattern（data-kdr-conic / data-kdr-stops を持つ）を、角度のグラデーションに戻す。
   * 中心は pattern の座標系（要素の座標系）のピクセルなので、ページを経てノードの枠に対する割合に直す。読めなければ null
   */
  private conicPattern(element: SvgElement, matrix: Matrix, node: SceneNode): Paint | null {
    const source = element.attributes['data-kdr-conic']?.trim().split(/\s+/).map(Number)
    const rawStops = element.attributes['data-kdr-stops']
    if (!source || source.length !== 4 || !source.every(Number.isFinite) || rawStops === undefined) return null
    const [x, y, angle, paintOpacity] = source
    const stops: ColorStop[] = []
    for (const item of rawStops.split(',')) {
      const match = /^\s*([\d.eE+-]+)\s+(#[0-9a-fA-F]{6})(?:\s+([\d.eE+-]+))?\s*$/.exec(item)
      const offset = match ? Number(match[1]) : NaN
      const opacity = match?.[3] === undefined ? 1 : Number(match[3])
      if (!match || !(offset >= 0 && offset <= 1) || !(opacity >= 0 && opacity <= 1)) return null
      if (stops.length > 0 && offset < stops[stops.length - 1].offset) return null
      stops.push({ offset, color: match[2].toLowerCase(), opacity })
    }
    if (stops.length < 2 || stops.length > MAX_STOPS || !(paintOpacity >= 0 && paintOpacity <= 1)) return null
    if (node.width === 0 || node.height === 0) return solidPaint(stops[0].color, stops[0].opacity * paintOpacity)
    const center = toNodeSpace(node, applyMatrix(matrix, { x, y }))
    return {
      type: 'conic',
      cx: center.x / node.width,
      cy: center.y / node.height,
      angle,
      stops,
      opacity: paintOpacity,
      visible: true,
      blendMode: 'normal',
    }
  }

  /**
   * 扇形を並べて角度のグラデーションを近似した pattern（中心が同じ扇形の path を、向きの順に 1 周並べたもの。
   * data 属性のない kadrokreo の書き出しや、ほかのツールの近似がこの形）を、角度のグラデーションに戻す。
   * 扇形の並びは pattern ごとに 1 回だけ読み（wedgeFan）、ここではノードの座標系に直す。形が違えば null
   */
  private wedgePattern(element: SvgElement, matrix: Matrix, node: SceneNode): Paint | null {
    if (node.width === 0 || node.height === 0) return null
    if (!this.fanCache.has(element)) this.fanCache.set(element, this.wedgeFan(element))
    const fan = this.fanCache.get(element)
    if (!fan) return null
    const whole = multiply(matrix, fan.transform)
    const toNode = (point: Point) => toNodeSpace(node, applyMatrix(whole, point))
    const center = toNode(fan.center)
    const ahead = toNode({ x: fan.center.x + Math.cos(fan.start), y: fan.center.y + Math.sin(fan.start) })
    const start = Math.atan2(ahead.y - center.y, ahead.x - center.x)
    // 裏返す変換なら回る向きが逆になる。反時計回りは、同じ向きから時計回りに読み替える（位置を 1 から引いて逆に並べる）
    const reflected = whole[0] * whole[3] - whole[1] * whole[2] < 0
    const stops = fan.clockwise !== reflected ? fan.stops : fan.stops.map((stop) => ({ ...stop, offset: round4(1 - stop.offset) })).reverse()
    return {
      type: 'conic',
      cx: round4(center.x / node.width),
      cy: round4(center.y / node.height),
      angle: round4(((((start * 180) / Math.PI) % 360) + 360) % 360),
      stops,
      opacity: fan.opacity,
      visible: true,
      blendMode: 'normal',
    }
  }

  /**
   * pattern の中の扇形の並びを読む（pattern の座標系）。扇形は pattern の直下か、変換のない g 1 つの中の path で、
   * 中心が揃い、回る向きが揃い、真ん中の向きが同じ向きに 1 周だけ進み、すき間がないこと。扇形は 1 つずつ単色なので、
   * 扇形の真ん中の向きに色を置き、直線で補える色を間引いて 16 色までにする（simplifyStops）
   */
  private wedgeFan(element: SvgElement): WedgeFan | null {
    const { attributes } = element
    if (attributes.viewBox !== undefined || attributes.patternContentUnits?.trim() === 'objectBoundingBox') return null
    const transform = attributes.patternTransform === undefined ? IDENTITY : parseTransform(attributes.patternTransform)
    if (!transform) return null
    let parts = element.children.filter((child): child is SvgElement => typeof child !== 'string')
    let opacity = 1
    let groupStyle: Record<string, string> = {}
    if (parts.length === 1 && parts[0].name === 'g' && parts[0].attributes.transform === undefined) {
      groupStyle = this.declared(parts[0])
      opacity = clamp01(parseFraction(groupStyle.opacity) ?? 1)
      parts = parts[0].children.filter((child): child is SvgElement => typeof child !== 'string')
    }
    if (parts.length < MIN_WEDGES || parts.length > MAX_WEDGES) return null
    type Wedge = { center: Point; from: number; span: number; color: string; opacity: number }
    const wedges: Wedge[] = []
    for (const part of parts) {
      if (part.name !== 'path' || part.attributes.transform !== undefined) return null
      let subpaths
      try {
        subpaths = parsePathData(part.attributes.d ?? '')
      } catch (error) {
        if (error instanceof PathDataError) return null
        throw error
      }
      if (subpaths.length !== 1) return null
      const points: Point[] = subpaths[0].vertices.map(({ x, y }) => ({ x, y }))
      // 中心に戻る L を書いた形（M c L a L b L c Z）は、最後の点を除く
      if (points.length > 3 && near(points[points.length - 1], points[0])) points.pop()
      if (points.length < 3) return null
      const [center, first, last] = [points[0], points[1], points[points.length - 1]]
      const from = Math.atan2(first.y - center.y, first.x - center.x)
      const span = wrapAngle(Math.atan2(last.y - center.y, last.x - center.x) - from)
      const declared = this.declared(part)
      const fill = this.color(declared.fill ?? groupStyle.fill ?? 'black', ROOT_INHERITED)
      if (!fill || Math.abs(span) < 1e-6 || Math.abs(span) > Math.PI / 2) return null
      const alpha =
        fill.alpha *
        clamp01(parseFraction(declared['fill-opacity'] ?? groupStyle['fill-opacity']) ?? 1) *
        clamp01(parseFraction(declared.opacity) ?? 1)
      wedges.push({ center, from, span, color: fill.color, opacity: alpha })
    }
    const center = wedges[0].center
    const reach = Math.max(...parts.map((_, i) => Math.hypot(wedges[i].center.x - center.x, wedges[i].center.y - center.y)))
    if (reach > 1e-3) return null
    const direction = Math.sign(wedges[0].span)
    if (wedges.some((wedge) => Math.sign(wedge.span) !== direction)) return null
    const mids = wedges.map((wedge) => wedge.from + wedge.span / 2)
    const steps = mids.map((mid, i) => positiveAngle(direction * (mids[(i + 1) % mids.length] - mid)))
    const turn = steps.reduce((sum, step) => sum + step, 0)
    if (Math.abs(turn - Math.PI * 2) > 1e-3 || steps.some((step) => step <= 0 || step > Math.PI / 2)) return null
    // 扇形の間にすき間がないこと（重ねて描くものもあるので、足りないほうだけ見る）
    if (wedges.reduce((sum, wedge) => sum + Math.abs(wedge.span), 0) < Math.PI * 2 * 0.95) return null
    // 最初の色の向き: 最初の扇形の真ん中から、前の扇形との間の半分だけ戻った向き
    const start = mids[0] - (direction * steps[steps.length - 1]) / 2
    const samples = wedges.map((wedge, i) => ({
      offset: positiveAngle(direction * (mids[i] - start)) / (Math.PI * 2),
      rgba: [...hexRgb(wedge.color), clamp01(wedge.opacity) * 255],
    }))
    const stops = simplifyStops(samples).map(({ offset, rgba }) => ({
      offset: round4(offset),
      color: rgbHex(rgba),
      opacity: round4(clamp01(rgba[3] / 255)),
    }))
    return { transform, center, start, clockwise: direction > 0, stops, opacity: round4(opacity) }
  }

  private color(value: string, inherited: Inherited): Rgba | null {
    if (value === 'currentColor') return parseColor(inherited.color)
    return parseColor(value)
  }

  /** href でたどった先も含めて、最初に見つかった属性・色の並び */
  private gradientChain(element: SvgElement): SvgElement[] {
    const cached = this.chainCache.get(element)
    if (cached) return cached
    const chain = [element]
    this.chainCache.set(element, chain)
    let current = element
    while (chain.length < 8) {
      const href = hrefOf(current)
      if (href === undefined) break
      if (!href.startsWith('#')) {
        this.warn('外部への参照（読まなかった）')
        break
      }
      const next = this.definitions.get(href.slice(1))
      if (!next || chain.includes(next) || (next.name !== 'linearGradient' && next.name !== 'radialGradient')) break
      chain.push(next)
      current = next
    }
    return chain
  }

  /** グラデーションの色の透明度（stop-color の alpha と stop-opacity の積）がすべて同じなら、その値。違えば null */
  private uniformStopOpacity(element: SvgElement, inherited: Inherited): number | null {
    const owner = this.gradientChain(element).find((item) =>
      item.children.some((child) => typeof child !== 'string' && child.name === 'stop'),
    )
    if (!owner) return null
    const alphas = new Set<number>()
    for (const child of owner.children) {
      if (typeof child === 'string' || child.name !== 'stop') continue
      const style = this.declared(child)
      const rawColor = (style['stop-color'] ?? 'black').trim()
      const color = (rawColor === 'currentColor' ? parseColor(inherited.color) : parseColor(rawColor)) ?? { color: '#000000', alpha: 1 }
      alphas.add(round4(clamp01(color.alpha * (parseFraction(style['stop-opacity']) ?? 1))))
    }
    return alphas.size === 1 ? [...alphas][0] : null
  }

  /**
   * グラデーションの色。透明度（stop-color の alpha と stop-opacity の積）がすべて同じなら塗りの不透明度に写すので（paint）色は不透明のまま、
   * 色ごとに違えば色ごとの不透明度に写す
   */
  private stops(element: SvgElement, inherited: Inherited): ColorStop[] {
    const owner = this.gradientChain(element).find((item) =>
      item.children.some((child) => typeof child !== 'string' && child.name === 'stop'),
    )
    if (!owner) return []
    const uniform = this.uniformStopOpacity(element, inherited) !== null
    const stops: ColorStop[] = []
    let previous = 0
    for (const child of owner.children) {
      if (typeof child === 'string' || child.name !== 'stop') continue
      const style = this.declared(child)
      const offset = Math.max(previous, clamp01(parseFraction(child.attributes.offset) ?? 0))
      previous = offset
      const rawColor = (style['stop-color'] ?? 'black').trim()
      const color = (rawColor === 'currentColor' ? parseColor(inherited.color) : parseColor(rawColor)) ?? { color: '#000000', alpha: 1 }
      const opacity = uniform ? 1 : round4(clamp01(color.alpha * (parseFraction(style['stop-opacity']) ?? 1)))
      stops.push({ offset, color: color.color, opacity })
    }
    if (stops.length > MAX_STOPS) {
      this.warn(`${MAX_STOPS} 色を超えるグラデーション（間引いた）`)
      const picked = Array.from({ length: MAX_STOPS }, (_, i) => stops[Math.round((i * (stops.length - 1)) / (MAX_STOPS - 1))])
      return picked
    }
    return stops
  }

  /**
   * linearGradient を kadrokreo の直線状のグラデーションにする。始点と終点をノードの枠に対する割合に直す
   */
  private linearGradient(
    element: SvgElement,
    inherited: Inherited,
    matrix: Matrix,
    userBox: Bounds,
    node: SceneNode,
  ): Paint | null {
    const stops = this.stops(element, inherited)
    if (stops.length === 0) return null
    if (stops.length === 1) return stopPaint(stops[0])
    const chain = this.gradientChain(element)
    const attribute = (name: string) => chain.find((item) => item.attributes[name] !== undefined)?.attributes[name]
    const userSpace = attribute('gradientUnits') === 'userSpaceOnUse'
    const coordinate = (name: string, fallback: number, axis: 'width' | 'height') => {
      const raw = attribute(name)
      if (raw === undefined) return userSpace ? fallback * this.viewport[axis] : fallback
      if (userSpace) return this.length(raw, axis) ?? 0
      return parseFraction(raw) ?? fallback
    }
    const p1 = { x: coordinate('x1', 0, 'width'), y: coordinate('y1', 0, 'height') }
    const p2 = { x: coordinate('x2', 1, 'width'), y: coordinate('y2', 0, 'height') }
    const gradientTransform = parseTransform(attribute('gradientTransform')) ?? IDENTITY
    let toPage: Matrix
    if (userSpace) toPage = multiply(matrix, gradientTransform)
    else {
      // 枠に対する割合の座標。幅や高さが 0 の枠には SVG もグラデーションを描かない
      if (userBox.width === 0 || userBox.height === 0) return stopPaint(stops[stops.length - 1])
      toPage = multiply(multiply(matrix, [userBox.width, 0, 0, userBox.height, userBox.x, userBox.y]), gradientTransform)
    }
    const start = toNodeSpace(node, applyMatrix(toPage, p1))
    const end = toNodeSpace(node, applyMatrix(toPage, p2))
    if (Math.hypot(end.x - start.x, end.y - start.y) < 1e-9) return stopPaint(stops[stops.length - 1])
    // 始点・終点は枠に対する割合で持つ。幅や高さが 0 の向きは中央に置く
    const ratio = (value: number, length: number) => (length > 0 ? round4(value / length) : 0.5)
    const line = { x1: ratio(start.x, node.width), y1: ratio(start.y, node.height), x2: ratio(end.x, node.width), y2: ratio(end.y, node.height) }
    if (!Object.values(line).every(Number.isFinite)) return stopPaint(stops[stops.length - 1])
    if (node.width === 0 || node.height === 0) {
      // つぶれた枠では、SVG の向きの線を枠の割合で表せないので、向きの線に色の位置を写す
      return this.projectedLinear(start, end, stops, node)
    }
    // 斜めに歪めたグラデーション（色が同じ線が始点・終点の線に垂直でない）は、垂直にした形になる
    // SVG で色が同じ線は、グラデーションの座標系で始点・終点の線に垂直。ページに写しても垂直のままか確かめる
    const linear = (v: Point) => ({ x: toPage[0] * v.x + toPage[2] * v.y, y: toPage[1] * v.x + toPage[3] * v.y })
    const along = linear({ x: p2.x - p1.x, y: p2.y - p1.y })
    const across = linear({ x: -(p2.y - p1.y), y: p2.x - p1.x })
    if (Math.abs(along.x * across.x + along.y * across.y) > 1e-6 * Math.hypot(along.x, along.y) * Math.hypot(across.x, across.y)) {
      this.warn('歪めた直線状のグラデーション（色の線を垂直にした）')
    }
    return { type: 'linear', ...line, stops, opacity: 1, visible: true, blendMode: 'normal' }
  }

  /** 向き（度）だけの線に、SVG の始点・終点の位置を写した直線状のグラデーション（つぶれた枠のとき） */
  private projectedLinear(start: Point, end: Point, stops: ColorStop[], node: SceneNode): Paint {
    const angle = tidy((Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI)
    const [from, to] = angleLine(angle, node)
    const lx = to.x - from.x
    const ly = to.y - from.y
    const length = lx * lx + ly * ly
    const along = (p: Point) => (length === 0 ? 0 : ((p.x - from.x) * lx + (p.y - from.y) * ly) / length)
    const t1 = along(start)
    const t2 = along(end)
    let previous = 0
    const mapped = stops.map((stop) => {
      const offset = Math.max(previous, clamp01(round4(t1 + stop.offset * (t2 - t1))))
      previous = offset
      return { ...stop, offset }
    })
    return { type: 'linear', ...linearFromAngle(angle, node), stops: mapped, opacity: 1, visible: true, blendMode: 'normal' }
  }

  /**
   * radialGradient を kadrokreo の円形のグラデーションにする。中心と横・縦の半径をノードの枠に対する割合に直す。
   * 回した楕円は angle に、焦点（fx / fy）は中心からのずれを半径に対する割合にして写す。傾けた（軸が直交しない）楕円は持てないので、中心と半径の長さだけを写す
   */
  private radialGradient(
    element: SvgElement,
    inherited: Inherited,
    matrix: Matrix,
    userBox: Bounds,
    node: SceneNode,
  ): Paint | null {
    const stops = this.stops(element, inherited)
    if (stops.length === 0) return null
    const last: Paint = stopPaint(stops[stops.length - 1])
    if (stops.length === 1) return stopPaint(stops[0])
    const chain = this.gradientChain(element)
    const attribute = (name: string) => chain.find((item) => item.attributes[name] !== undefined)?.attributes[name]
    const userSpace = attribute('gradientUnits') === 'userSpaceOnUse'
    const coordinate = (name: string, axis: 'width' | 'height' | 'diagonal') => {
      const raw = attribute(name)
      if (raw === undefined) return userSpace ? (this.length('50%', axis) ?? 0) : 0.5
      if (userSpace) return this.length(raw, axis) ?? 0
      return parseFraction(raw) ?? 0.5
    }
    const c = { x: coordinate('cx', 'width'), y: coordinate('cy', 'height') }
    const r = coordinate('r', 'diagonal')
    // 焦点（省けば中心）。中心からのずれを半径に対する割合にし、円の外なら円の上に寄せる（SVG 1.1 と同じ）
    let focal = { x: 0, y: 0 }
    if (attribute('fx') !== undefined || attribute('fy') !== undefined) {
      const fx = attribute('fx') === undefined ? c.x : coordinate('fx', 'width')
      const fy = attribute('fy') === undefined ? c.y : coordinate('fy', 'height')
      if (r > 0) focal = clampToUnit({ x: (fx - c.x) / r, y: (fy - c.y) / r })
    }
    const gradientTransform = parseTransform(attribute('gradientTransform')) ?? IDENTITY
    let toPage: Matrix
    if (userSpace) toPage = multiply(matrix, gradientTransform)
    else {
      if (userBox.width === 0 || userBox.height === 0) return last
      toPage = multiply(multiply(matrix, [userBox.width, 0, 0, userBox.height, userBox.x, userBox.y]), gradientTransform)
    }
    if (!(r > 0) || node.width === 0 || node.height === 0) return last
    const center = toNodeSpace(node, applyMatrix(toPage, c))
    const alongX = toNodeSpace(node, applyMatrix(toPage, { x: c.x + r, y: c.y }))
    const alongY = toNodeSpace(node, applyMatrix(toPage, { x: c.x, y: c.y + r }))
    const ux = { x: alongX.x - center.x, y: alongX.y - center.y }
    const uy = { x: alongY.x - center.x, y: alongY.y - center.y }
    const rx = Math.hypot(ux.x, ux.y)
    const ry = Math.hypot(uy.x, uy.y)
    // 2 つの軸が直交していなければ（傾けた楕円）、向きは横の軸に合わせ、ゆがみは捨てる
    if (Math.abs(ux.x * uy.x + ux.y * uy.y) > 1e-6 * rx * ry) this.warn('傾けた円形のグラデーション（回した楕円にした）')
    // 横の軸の向き（ピクセル）。縦横の入れ替わる向きでも、横の半径は横の軸の長さのまま
    const angle = Math.abs(ux.y) < 1e-9 * rx ? (ux.x < 0 ? 180 : 0) : (Math.atan2(ux.y, ux.x) * 180) / Math.PI
    // 楕円は 180° 回すと同じなので、-90° より大きく 90° 以下に揃える
    let turn = angle
    while (turn > 90) turn -= 180
    while (turn <= -90) turn += 180
    const values = [center.x / node.width, center.y / node.height, rx / node.width, ry / node.height].map(round4)
    if (!values.every(Number.isFinite)) return last
    const [cx, cy, rxRatio, ryRatio] = values
    // 焦点をページを経てノードの座標系に写し、kadrokreo の楕円の軸（回した向き）に沿った、半径に対する割合に直す
    let fx = 0
    let fy = 0
    if (focal.x !== 0 || focal.y !== 0) {
      const point = toNodeSpace(node, applyMatrix(toPage, { x: c.x + focal.x * r, y: c.y + focal.y * r }))
      const radians = (turn * Math.PI) / 180
      const dx = point.x - center.x
      const dy = point.y - center.y
      const unit = fitFocus({
        x: (dx * Math.cos(radians) + dy * Math.sin(radians)) / rx,
        y: (-dx * Math.sin(radians) + dy * Math.cos(radians)) / ry,
      })
      if (Number.isFinite(unit.fx) && Number.isFinite(unit.fy)) ({ fx, fy } = unit)
    }
    return { type: 'radial', cx, cy, rx: rxRatio, ry: ryRatio, angle: round4(turn) + 0, fx, fy, stops, opacity: 1, visible: true, blendMode: 'normal' }
  }

  // ── 長さ ──

  private length(raw: string | undefined, axis: 'width' | 'height' | 'diagonal'): number | null {
    const { width, height } = this.viewport
    const base = axis === 'width' ? width : axis === 'height' ? height : Math.hypot(width, height) / Math.SQRT2
    const value = parseLength(raw, base)
    return value !== null && Number.isFinite(value) ? value : null
  }
}

// ── 部品 ──

/** data URI の中身のバイト列。base64 と % の符号化の両方を読む。読めなければ null */
function decodeDataUri(uri: string): Uint8Array<ArrayBuffer> | null {
  const comma = uri.indexOf(',')
  if (comma < 0) return null
  const meta = uri.slice(5, comma)
  // # から後は URL の断片（ブラウザも中身に含めない。SVG の中の色の # は %23 と書く）
  const hash = uri.indexOf('#', comma)
  const data = uri.slice(comma + 1, hash < 0 ? uri.length : hash)
  try {
    if (/;base64$/i.test(meta)) {
      const binary = atob(data.replace(/\s+/g, ''))
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return bytes
    }
    // %xx はそのバイト、それ以外の文字は UTF-8 のバイト列（符号化せずに書いた SVG の日本語など）
    const out: number[] = []
    const encoder = new TextEncoder()
    for (let i = 0; i < data.length; i++) {
      const code = data.charCodeAt(i)
      if (data[i] === '%' && /^[0-9a-fA-F]{2}$/.test(data.slice(i + 1, i + 3))) {
        out.push(parseInt(data.slice(i + 1, i + 3), 16))
        i += 2
      } else if (code < 0x80) out.push(code)
      else {
        const char = String.fromCodePoint(data.codePointAt(i)!)
        for (const byte of encoder.encode(char)) out.push(byte)
        i += char.length - 1
      }
    }
    return new Uint8Array(out)
  } catch {
    return null
  }
}

/** 原点からの長さが 1 を超えていれば、長さ 1 に縮める */
function clampToUnit(point: Point): Point {
  const length = Math.hypot(point.x, point.y)
  return length > 1 ? { x: point.x / length, y: point.y / length } : point
}

/** グラデーションの代わりに 1 色で塗るときの塗り。色の不透明度を塗りの不透明度にする */
function stopPaint(stop: ColorStop): Paint {
  return solidPaint(stop.color, stop.opacity)
}

function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1
}

// ── foreignObject の conic-gradient ──

/** conic-gradient を塗る切り取りの形にできる図形 */
const CONIC_CLIP_SHAPES = new Set(['rect', 'circle', 'ellipse', 'path', 'polygon'])
/** conic-gradient の中で読む色の数 */
const MAX_CONIC_STOPS = 64

function isNone(value: string | undefined): boolean {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' || trimmed === 'none'
}

/** 括弧の外のカンマで分ける */
function splitTopLevel(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let begin = 0
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) {
      parts.push(value.slice(begin, i))
      begin = i + 1
    }
    if (depth < 0) return []
  }
  parts.push(value.slice(begin))
  return depth === 0 ? parts.map((part) => part.trim()) : []
}

/** 角度（deg。0 だけは単位なし）を度で。読めなければ NaN */
function parseDegrees(raw: string): number {
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg)?$/i.exec(raw)
  if (!match) return NaN
  const value = Number(match[1])
  return match[2] === undefined && value !== 0 ? NaN : value
}

/**
 * CSS の conic-gradient(from <角度>, <色> <角度>?, …) を読む。色は rgb() / rgba() / #hex、角度は deg に限る（at での中心の指定、
 * ほかの単位・割合・色の名前・補間の指定は読まない）。位置のない色は CSS と同じく、最初を 0、最後を 360 度にし、間は前後から等分する。
 * 前の色より小さい位置は前の色の位置にそろえる。0〜360 度の外に出る位置は読まない。16 色を超えれば直線で補える色を間引く
 */
export function parseConicGradient(raw: string): { from: number; stops: ColorStop[] } | null {
  const body = /^conic-gradient\(([\s\S]*)\)$/i.exec(raw.trim())
  if (!body) return null
  const parts = splitTopLevel(body[1])
  if (parts.length === 0) return null
  let from = 0
  if (/^from\s/i.test(parts[0])) {
    from = parseDegrees(parts[0].slice(4).trim())
    if (!Number.isFinite(from)) return null
    parts.shift()
  } else if (/^at\s/i.test(parts[0])) return null
  if (parts.length < 2 || parts.length > MAX_CONIC_STOPS) return null
  const listed: { rgba: number[]; at: number | null }[] = []
  for (const part of parts) {
    const match = /^(#[0-9a-f]{3,8}|rgba?\([^)]*\))\s*([\s\S]*)$/i.exec(part)
    if (!match) return null
    const color = parseColor(match[1])
    if (!color) return null
    const rgba = [...hexRgb(color.color), clamp01(color.alpha) * 255]
    const positions = match[2].trim() === '' ? [] : match[2].trim().split(/\s+/)
    if (positions.length > 2) return null
    if (positions.length === 0) listed.push({ rgba, at: null })
    for (const position of positions) {
      const at = parseDegrees(position)
      if (!Number.isFinite(at)) return null
      listed.push({ rgba, at })
    }
  }
  if (listed.length > MAX_CONIC_STOPS) return null
  listed[0].at ??= 0
  listed[listed.length - 1].at ??= 360
  // 前より小さい位置は前にそろえ、位置のない色は前後の位置の間を等分する
  let previous = listed[0].at
  for (let i = 0; i < listed.length; i++) {
    const at = listed[i].at
    if (at === null) {
      let next = i + 1
      while (listed[next].at === null) next++
      const end = Math.max(previous, listed[next].at!)
      for (let k = i; k < next; k++) listed[k].at = previous + ((end - previous) * (k - i + 1)) / (next - i + 1)
      i = next - 1
      continue
    }
    previous = Math.max(previous, at)
    listed[i].at = previous
  }
  if (listed.some((stop) => stop.at! < 0 || stop.at! > 360)) return null
  let samples: StopSample[] = listed.map((stop) => ({ offset: stop.at! / 360, rgba: stop.rgba }))
  if (samples.length > MAX_STOPS) samples = simplifyStops(samples)
  const stops = samples.map(({ offset, rgba }) => ({ offset: round4(offset), color: rgbHex(rgba), opacity: round4(clamp01(rgba[3] / 255)) }))
  return { from, stops }
}

// ── 扇形の pattern ──

/**
 * 扇形の pattern から読んだ角度のグラデーション（pattern の座標系）。transform は patternTransform、start は最初の色の向き（ラジアン）、
 * clockwise は向きが増える向き（画面では時計回り）に色が進むか。stops は clockwise の向きでの並び
 */
type WedgeFan = { transform: Matrix; center: Point; start: number; clockwise: boolean; stops: ColorStop[]; opacity: number }

/** 扇形の pattern と見なす扇形の数 */
const MIN_WEDGES = 8
const MAX_WEDGES = 2048

function near(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6
}

/** 角度を (-π, π] にする */
function wrapAngle(a: number): number {
  const turned = positiveAngle(a)
  return turned > Math.PI ? turned - Math.PI * 2 : turned
}

/** 角度を [0, 2π) にする */
function positiveAngle(a: number): number {
  const full = Math.PI * 2
  return ((a % full) + full) % full
}

function hexRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1, 7), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function rgbHex(rgba: readonly number[]): string {
  return `#${rgba.slice(0, 3).map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`
}

type StopSample = { offset: number; rgba: number[] }

/**
 * 扇形ごとの色（真ん中の向きの位置）を、直線で補える色を間引いて MAX_STOPS 色までにする。
 * 残した色の間で、直線で補った色からいちばん離れた色を残すことをくり返す。両端は 0 と 1 まで直線で延ばす
 */
function simplifyStops(samples: readonly StopSample[]): StopSample[] {
  const mix = (a: StopSample, b: StopSample, offset: number) => {
    const t = b.offset === a.offset ? 0 : (offset - a.offset) / (b.offset - a.offset)
    return a.rgba.map((value, k) => value + (b.rgba[k] - value) * t)
  }
  // 許す差 tolerance で残す色の番号。MAX_STOPS 色に収まらなければ null
  const pick = (tolerance: number): number[] | null => {
    const kept = [0, samples.length - 1]
    for (;;) {
      let worst = { at: -1, error: tolerance }
      for (let k = 0; k + 1 < kept.length; k++) {
        const [a, b] = [samples[kept[k]], samples[kept[k + 1]]]
        for (let i = kept[k] + 1; i < kept[k + 1]; i++) {
          const guess = mix(a, b, samples[i].offset)
          const error = Math.max(...guess.map((value, c) => Math.abs(value - samples[i].rgba[c])))
          if (error > worst.error) worst = { at: i, error }
        }
      }
      if (worst.at < 0) return kept
      if (kept.length >= MAX_STOPS) return null
      kept.push(worst.at)
      kept.sort((x, y) => x - y)
    }
  }
  let kept: number[] | null = null
  // 収まらなければ許す差を広げる（255 を超えれば両端だけで必ず収まる）
  for (let tolerance = 3; !kept; tolerance *= 1.5) kept = pick(tolerance)
  const order = kept.map((i) => samples[i])
  if (order.length === 1) return [{ offset: 0, rgba: order[0].rgba }, { offset: 1, rgba: order[0].rgba }]
  const head = { offset: 0, rgba: mix(order[0], order[1], 0) }
  const tail = { offset: 1, rgba: mix(order[order.length - 2], order[order.length - 1], 1) }
  return [head, ...order.slice(1, -1), tail]
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

function rotationOf(degrees: number): number {
  const value = tidy(degrees)
  return value === 0 || Object.is(value, -0) ? 0 : value
}

/** 木の要素の数（自分を含む） */
function countElements(element: SvgElement): number {
  let count = 1
  for (const child of element.children) if (typeof child !== 'string') count += countElements(child)
  return count
}

function viewBoxOf(element: SvgElement): [number, number, number, number] | null {
  const numbers = parseNumbers(element.attributes.viewBox)
  if (!numbers || numbers.length !== 4 || !(numbers[2] > 0 && numbers[3] > 0)) return null
  return numbers as [number, number, number, number]
}

function viewBoxSize(element: SvgElement): Size | null {
  const viewBox = viewBoxOf(element)
  return viewBox ? { width: viewBox[2], height: viewBox[3] } : null
}

/** viewBox を、size の大きさのビューポートへ写す変換（preserveAspectRatio を含む） */
function viewBoxMatrix(viewBox: readonly number[], size: Size, preserve = 'xMidYMid meet'): Matrix {
  const [minX, minY, width, height] = viewBox
  let sx = size.width / width
  let sy = size.height / height
  const [align = 'xMidYMid', mode = 'meet'] = preserve.trim().split(/\s+/)
  let tx = -minX * sx
  let ty = -minY * sy
  if (align !== 'none') {
    const scale = mode === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy)
    sx = sy = scale
    const extraX = size.width - width * scale
    const extraY = size.height - height * scale
    const fx = align.startsWith('xMid') ? 0.5 : align.startsWith('xMax') ? 1 : 0
    const fy = align.endsWith('YMid') ? 0.5 : align.endsWith('YMax') ? 1 : 0
    tx = -minX * scale + extraX * fx
    ty = -minY * scale + extraY * fy
  }
  return [sx, 0, 0, sy, tx, ty]
}

/** 回転も含めて、ノードを親の中で囲む矩形 */
/** 中身として読む子要素（title・desc の説明を除く） */
function shapeChildren(element: SvgElement): SvgElement[] {
  return element.children.filter((child): child is SvgElement => typeof child !== 'string' && child.name !== 'title' && child.name !== 'desc')
}

/** 参照先（href か xlink:href。前後の空白を除く） */
function hrefOf(element: SvgElement): string | undefined {
  return (element.attributes.href ?? element.attributes['xlink:href'])?.trim()
}

/** 中身をまとめる要素（1 つのフレームにする） */
const GROUP_ELEMENTS = new Set(['g', 'a', 'switch', 'svg'])

function outerBounds(node: SceneNode): Bounds {
  if (node.rotation === 0) return { x: node.x, y: node.y, width: node.width, height: node.height }
  return transformRect(nodeMatrix(node), { x: 0, y: 0, width: node.width, height: node.height })
}

function roundedRect(box: Bounds, rx: number, ry: number): Vertex[] {
  const { x, y, width: w, height: h } = box
  if (rx === 0 || ry === 0) {
    return [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ]
  }
  const kx = rx * KAPPA
  const ky = ry * KAPPA
  return [
    { x: x + rx, y, in: { x: x + rx - kx, y } },
    { x: x + w - rx, y, out: { x: x + w - rx + kx, y } },
    { x: x + w, y: y + ry, in: { x: x + w, y: y + ry - ky } },
    { x: x + w, y: y + h - ry, out: { x: x + w, y: y + h - ry + ky } },
    { x: x + w - rx, y: y + h, in: { x: x + w - rx + kx, y: y + h } },
    { x: x + rx, y: y + h, out: { x: x + rx - kx, y: y + h } },
    { x, y: y + h - ry, in: { x, y: y + h - ry + ky } },
    { x, y: y + ry, out: { x, y: y + ry - ky } },
  ]
}

function fontWeightOf(raw: string): number {
  if (raw === 'bold' || raw === 'bolder') return 700
  if (raw === 'lighter') return 300
  const value = Number(raw)
  if (!Number.isFinite(value)) return 400
  return Math.min(900, Math.max(100, Math.round(value / 100) * 100))
}

function hasDescendant(element: SvgElement, name: string): boolean {
  return element.children.some((child) => typeof child !== 'string' && (child.name === name || hasDescendant(child, name)))
}

/**
 * text の中身を行に分ける。x か dy を持つ tspan（2 つ目以降）は新しい行とみなす。
 * 空白は XML の既定（xml:space="default"）どおり 1 つにまとめる
 */
/**
 * 行の高さ（fontSize に対する割合）。書き出し（document/svgExport.ts）は行ごとに y を持つ tspan を書くので、2 行以上あって
 * 間隔が揃っていればそこから読む。読めなければ null（既定の行の高さのまま）。1 行だけのときは、行の高さを変えても文字の位置は同じ
 */
function lineHeightOf(element: SvgElement, lineCount: number, fontSize: number): number | null {
  if (lineCount < 2) return null
  const ys: number[] = []
  for (const child of element.children) {
    if (typeof child === 'string' || child.name !== 'tspan') continue
    const y = parseNumbers(child.attributes.y)?.[0]
    if (y === undefined) return null
    ys.push(y)
  }
  if (ys.length !== lineCount) return null
  const step = (ys[ys.length - 1] - ys[0]) / (ys.length - 1)
  if (ys.some((y, i) => Math.abs(y - (ys[0] + step * i)) > 0.01)) return null
  const ratio = step / fontSize
  return Number.isFinite(ratio) && ratio >= 0.5 && ratio <= 10 ? Math.round(ratio * 1000) / 1000 : null
}

function textLines(element: SvgElement): string[] {
  const lines: string[] = ['']
  const walk = (nodes: SvgNode[]) => {
    for (const node of nodes) {
      if (typeof node === 'string') {
        lines[lines.length - 1] += node
        continue
      }
      if (node.name !== 'tspan' && node.name !== 'a' && node.name !== 'textPath') continue
      const breaks = node.attributes.x !== undefined || node.attributes.dy !== undefined
      if (breaks && lines[lines.length - 1].trim() !== '') lines.push('')
      walk(node.children)
    }
  }
  walk(element.children)
  return lines.map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line !== '')
}

/** 変換が裏返しを含むか（行列式が負） */
function isFlipped(m: Matrix): boolean {
  return m[0] * m[3] - m[1] * m[2] < 0
}

/** 縦の線 x = cx で左右に映す変換 */
function mirrorAt(cx: number): Matrix {
  return [-1, 0, 0, 1, 2 * cx, 0]
}
