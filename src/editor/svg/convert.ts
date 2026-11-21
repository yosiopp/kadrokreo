import {
  type Bounds,
  IDENTITY,
  type Matrix,
  type Point,
  type Size,
  applyMatrix,
  multiply,
  rotateVector,
  toNodeSpace,
  transformRect,
  unionBounds,
} from '../../document/geometry.ts'
import { gradientLine } from '../../document/paint.ts'
import { type Vertex, mapVertices, pathBounds, pathFromPoints } from '../../document/path.ts'
import { PathDataError, parsePathData } from '../../document/pathData.ts'
import type { Cap, ColorStop, FrameNode, NodeId, Paint, PathNode, SceneNode, Style, TextNode } from '../../document/types.ts'
import { createEllipse, createFrame, createPath, createRect, createText } from '../nodes.ts'
import type { Fragment } from '../operations/clipboard.ts'
import type { SvgElement, SvgNode } from './xml.ts'
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
//   輪郭ごとのパスをフレームにまとめる（kadrokreo のパスは輪郭を 1 つしか持てないので、穴は塗りつぶされる）。
// - 塗りは単色と linearGradient・radialGradient。kadrokreo の塗りは不透明度を持たないので、fill-opacity などはノードの opacity に寄せる。
// - スクリプト・foreignObject・外部参照は読まない。表せないもの（フィルタ・マスク・クリップパス・パターン・円形のグラデーションなど）は
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
}

export class SvgImportError extends Error {
  override name = 'SvgImportError'
}

/** 作るノードの数の上限。use の入れ子で数が膨らむ細工を止める */
const MAX_NODES = 20_000
/** g のフレームの入れ子の上限（kdr の MAX_DEPTH 100 より余裕をもって小さく）。深い分はフレームを作らずに中身を親へ出す */
const MAX_FRAME_DEPTH = 64
const MAX_USE_DEPTH = 16
/** kdr のパスの頂点数の上限 */
const MAX_PATH_POINTS = 10_000
/** kdr のグラデーションの色の数の上限 */
const MAX_STOPS = 16

/** 円を 4 つの 3 次ベジェ曲線で近似するときの制御点の長さ */
const KAPPA = 0.5522847498

/** 親から受け継ぐ値（presentation attribute と style 属性） */
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
}

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
  style: 'CSS（<style>）',
  image: '画像（<image>）',
}

/** 図形に付いていたら落としたと知らせる属性 */
const SKIPPED_REFERENCES: [string, string][] = [
  ['filter', 'フィルタ'],
  ['mask', 'マスク'],
  ['clip-path', 'クリップパス'],
  ['marker-start', 'マーカー'],
  ['marker-mid', 'マーカー'],
  ['marker-end', 'マーカー'],
]

/** 解析した SVG の木を、kadrokreo のノードに変換する */
export function convertSvg(root: SvgElement, options: SvgImportOptions): SvgImport {
  if (root.name !== 'svg') throw new SvgImportError('svg 要素がありません')
  return new Converter(root, options).run()
}

class Converter {
  private readonly nodes: Record<NodeId, SceneNode> = {}
  private readonly definitions = new Map<string, SvgElement>()
  private readonly warnings = new Map<string, number>()
  private readonly root: SvgElement
  private readonly options: SvgImportOptions
  private nextId = 0
  private stopped = false
  /** ビューポートの大きさ（% の長さの基準） */
  private viewport: Size = { width: 300, height: 150 }
  /** たどっている use の参照先（循環を止める） */
  private readonly using = new Set<string>()

  constructor(root: SvgElement, options: SvgImportOptions) {
    this.root = root
    this.options = options
  }

  run(): SvgImport {
    this.collectDefinitions(this.root)
    const { size, matrix } = this.rootViewport(this.root)
    this.viewport = viewBoxSize(this.root) ?? size
    const inherited = this.inherit(this.root, ROOT_INHERITED)
    const children = this.convertChildren(this.root, matrix, inherited, 1, 0)
    const frame: FrameNode = {
      ...createFrame({ x: 0, y: 0, width: size.width, height: size.height }),
      id: this.id(),
      name: this.options.name,
      fills: [],
      // SVG はビューポートの外を描かない
      clipContent: true,
      opacity: opacityOf(this.root),
      children,
    }
    this.nodes[frame.id] = frame
    for (const child of children) this.nodes[child] = { ...this.nodes[child], parentId: frame.id }
    return {
      fragment: { nodes: this.nodes, rootIds: [frame.id], assets: {} },
      warnings: [...this.warnings].map(([label, count]) => ({ label, count })),
    }
  }

  private id(): NodeId {
    return `svg${++this.nextId}`
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
    const style = parseStyle(element.attributes.style)
    const get = (name: string): string | undefined => {
      const value = style[name] ?? element.attributes[name]
      return value === undefined || value.trim() === 'inherit' ? undefined : value.trim()
    }
    const next = { ...parent }
    const fill = get('fill')
    if (fill !== undefined) next.fill = fill
    const stroke = get('stroke')
    if (stroke !== undefined) next.stroke = stroke
    const strokeWidth = get('stroke-width')
    if (strokeWidth !== undefined) next.strokeWidth = strokeWidth
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
    const fontFamily = get('font-family')
    if (fontFamily !== undefined) next.fontFamily = fontFamily
    const fontWeight = get('font-weight')
    if (fontWeight !== undefined) next.fontWeight = fontWeight
    const textAnchor = get('text-anchor')
    if (textAnchor !== undefined) next.textAnchor = textAnchor
    const visibility = get('visibility')
    if (visibility !== undefined) next.visible = visibility === 'visible'
    const lineCap = get('stroke-linecap')
    if (lineCap !== undefined) next.lineCap = lineCap
    return next
  }

  // ── 要素 ──

  /** 子要素を順に変換し、できたノードの id を重なり順（先頭が最背面）に返す */
  private convertChildren(element: SvgElement, matrix: Matrix, inherited: Inherited, depth: number, uses: number): NodeId[] {
    const ids: NodeId[] = []
    for (const child of element.children) {
      if (typeof child === 'string') continue
      ids.push(...this.convertElement(child, matrix, inherited, depth, uses))
    }
    return ids
  }

  private convertElement(element: SvgElement, parentMatrix: Matrix, parentInherited: Inherited, depth: number, uses: number): NodeId[] {
    if (this.stopped) return []
    const { name, attributes } = element
    if (DEFINITIONS.has(name)) return []
    const skipped = SKIPPED_ELEMENTS[name]
    if (skipped) {
      this.warn(skipped)
      return []
    }
    const style = parseStyle(attributes.style)
    if ((style.display ?? attributes.display)?.trim() === 'none') return []
    const transform = parseTransform(attributes.transform)
    const matrix = transform ? multiply(parentMatrix, transform) : parentMatrix
    if (!transform) this.warn('読めない transform（無視した）')
    const inherited = this.inherit(element, parentInherited)
    for (const [attribute, label] of SKIPPED_REFERENCES) {
      const value = style[attribute] ?? attributes[attribute]
      if (value !== undefined && value.trim() !== 'none') this.warn(label)
    }

    switch (name) {
      case 'g':
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
        return this.path(element, [from, to], false, matrix, inherited, 'Line')
      }
      case 'polyline':
      case 'polygon': {
        const numbers = parseNumbers(attributes.points) ?? []
        const points: Point[] = []
        for (let i = 0; i + 1 < numbers.length; i += 2) points.push({ x: numbers[i], y: numbers[i + 1] })
        if (points.length < 2) return []
        return this.path(element, points, name === 'polygon', matrix, inherited, 'Path')
      }
      case 'path':
        return this.pathData(element, matrix, inherited)
      case 'text':
        return this.text(element, matrix, inherited)
      default:
        this.warn(`対応していない要素（<${name}>）`)
        return []
    }
  }

  /** g などをフレームにする。中身がなければ作らない。深すぎればフレームを作らずに中身を返す */
  private group(element: SvgElement, children: NodeId[], depth: number): NodeId[] {
    if (children.length === 0) return []
    const opacity = opacityOf(element)
    if (depth > MAX_FRAME_DEPTH) {
      this.warn('深すぎるグループの入れ子（フレームにせずにまとめた）')
      for (const id of children) this.nodes[id] = { ...this.nodes[id], opacity: this.nodes[id].opacity * opacity }
      return children
    }
    const box = unionBounds(children.map((id) => outerBounds(this.nodes[id])))!
    const frame: FrameNode = {
      ...createFrame({ x: box.x, y: box.y, width: Math.max(1, box.width), height: Math.max(1, box.height) }),
      id: this.id(),
      name: element.attributes.id ?? 'Group',
      fills: [],
      clipContent: false,
      opacity,
      children,
    }
    // 子の座標は、ここまでは SVG 全体のフレームの座標。これからは g のフレームの左上が原点
    for (const id of children) {
      const child = this.nodes[id]
      this.nodes[id] = { ...child, parentId: frame.id, x: child.x - box.x, y: child.y - box.y }
    }
    return [this.add(frame)]
  }

  private use(element: SvgElement, matrix: Matrix, inherited: Inherited, depth: number, uses: number): NodeId[] {
    const href = element.attributes.href ?? element.attributes['xlink:href']
    if (href === undefined) return []
    if (!href.trim().startsWith('#')) {
      this.warn('外部への参照（読まなかった）')
      return []
    }
    const id = href.trim().slice(1)
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
    return this.path(element, roundedRect(userBox, rx, ry), true, matrix, inherited, 'Rectangle', userBox)
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
    return this.path(element, ellipseVertices(cx, cy, rx, ry), true, matrix, inherited, 'Ellipse', userBox)
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

  private path(
    element: SvgElement,
    userVertices: Vertex[],
    closed: boolean,
    matrix: Matrix,
    inherited: Inherited,
    fallbackName: string,
    userBox: Bounds = pathBounds(userVertices, closed),
  ): NodeId[] {
    if (userVertices.length < 2) return []
    if (userVertices.length > MAX_PATH_POINTS) {
      this.warn('頂点が多すぎるパス（読み飛ばした）')
      return []
    }
    const vertices = mapVertices(userVertices, (point) => applyMatrix(matrix, point))
    const node: PathNode = { ...createPath(pathFromPoints(vertices, closed), closed), name: fallbackName }
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
    subpaths = subpaths.filter((subpath) => subpath.vertices.length >= 2)
    if (subpaths.length === 0) return []
    // objectBoundingBox のグラデーションは、輪郭をすべて合わせた枠に対してかかる
    const userBox = unionBounds(subpaths.map((subpath) => pathBounds(subpath.vertices, subpath.closed)))!
    if (subpaths.length === 1) {
      return this.path(element, subpaths[0].vertices, subpaths[0].closed, matrix, inherited, 'Path', userBox)
    }
    const fill = inherited.fill.trim()
    if (fill !== 'none' && subpaths.filter((subpath) => subpath.closed).length > 1) {
      this.warn('輪郭が複数あるパス（輪郭ごとのパスに分けた。穴は塗りつぶされる）')
    }
    const plain = { ...element, attributes: { ...element.attributes, id: '' } }
    const parts = subpaths.flatMap((subpath, i) => {
      const ids = this.path(plain, subpath.vertices, subpath.closed, matrix, inherited, `${element.attributes.id ?? 'Path'} ${i + 1}`, userBox)
      return ids
    })
    return this.group({ name: 'g', attributes: { id: element.attributes.id ?? 'Path' }, children: [] }, parts, 0)
  }

  private text(element: SvgElement, matrix: Matrix, inherited: Inherited): NodeId[] {
    const lines = textLines(element)
    if (lines.length === 0) return []
    const a = element.attributes
    const x = (parseNumbers(a.x)?.[0] ?? 0) + (parseNumbers(a.dx)?.[0] ?? 0)
    const y = (parseNumbers(a.y)?.[0] ?? 0) + (parseNumbers(a.dy)?.[0] ?? 0)
    const pose = decompose(matrix)
    if (!pose) this.warn('歪めたり裏返したりしたテキスト（回転と拡大だけにした）')
    const scale = lengthScale(matrix)
    const rotation = pose ? pose.rotation : (Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI
    const anchor = inherited.textAnchor === 'middle' ? 'center' : inherited.textAnchor === 'end' ? 'right' : 'left'
    const base = createText({ x: 0, y: 0, width: 0, height: 0 }, lines.join('\n'))
    let node: TextNode = {
      ...base,
      fontSize: Math.max(1, round(inherited.fontSize * scale)),
      fontFamily: inherited.fontFamily,
      fontWeight: fontWeightOf(inherited.fontWeight),
      textAlign: anchor,
    }
    const size = this.options.measureText(node)
    node = { ...node, ...size }
    // SVG の (x, y) は 1 行目の基線の、text-anchor の側の端。kadrokreo のテキストは枠の左上で置く
    const baseline = ((node.lineHeight - 1.12) / 2 + 0.9) * node.fontSize
    const offsetX = anchor === 'center' ? -size.width / 2 : anchor === 'right' ? -size.width : 0
    const origin = applyMatrix(matrix, { x, y })
    const center = rotateVector({ x: offsetX + size.width / 2, y: -baseline + size.height / 2 }, rotation)
    node = {
      ...node,
      x: origin.x + center.x - size.width / 2,
      y: origin.y + center.y - size.height / 2,
      rotation: rotationOf(rotation),
      name: a.id ?? lines[0].slice(0, 40),
      visible: inherited.visible,
      opacity: opacityOf(element),
    }
    const userBox = { x, y: y - inherited.fontSize, width: size.width / (scale || 1), height: size.height / (scale || 1) }
    const fill = this.paint(inherited.fill, inherited.fillOpacity, inherited, matrix, userBox, node)
    node = { ...node, fills: fill.paints, opacity: node.opacity * fill.alpha }
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
    const fill = isLine ? { paints: [], alpha: 1 } : this.paint(inherited.fill, inherited.fillOpacity, inherited, matrix, userBox, node)
    const stroke = strokeWidth > 0
      ? this.paint(inherited.stroke, inherited.strokeOpacity, inherited, matrix, userBox, node)
      : { paints: [], alpha: 1 }
    // 塗りの不透明度はノードの opacity に寄せる。塗りと線で違えば、見えている方に合わせる
    let alpha = 1
    if (fill.paints.length > 0 && stroke.paints.length > 0) {
      if (Math.abs(fill.alpha - stroke.alpha) > 1e-6) this.warn('塗りと線で違う不透明度（片方に揃えた）')
      alpha = Math.max(fill.alpha, stroke.alpha)
    } else if (fill.paints.length > 0) alpha = fill.alpha
    else if (stroke.paints.length > 0) alpha = stroke.alpha
    const id = element.attributes.id
    // 線の端の形（stroke-linecap）は、開いたパスの両端に写す。閉じた形には端がない
    const cap: Cap | null = inherited.lineCap === 'round' || inherited.lineCap === 'square' ? inherited.lineCap : null
    const caps = node.type === 'path' && !node.closed && cap && stroke.paints.length > 0 ? { startCap: cap, endCap: cap } : {}
    const named = {
      ...node,
      ...caps,
      name: id !== undefined && id !== '' ? id : node.name,
      fills: fill.paints,
      strokes: stroke.paints,
      strokeWidth: stroke.paints.length > 0 ? round(strokeWidth) : node.strokeWidth,
      visible: inherited.visible,
      opacity: opacityOf(element) * alpha,
    }
    return [this.add(named)]
  }

  private add(node: SceneNode): NodeId {
    if (Object.keys(this.nodes).length >= MAX_NODES) {
      if (!this.stopped) this.warn(`${MAX_NODES} 個を超えた分の図形（読み飛ばした）`)
      this.stopped = true
    }
    this.nodes[node.id] = node
    return node.id
  }

  // ── 塗り ──

  /**
   * fill / stroke の値を塗りにする。alpha は塗りの不透明度（色の alpha と fill-opacity の積）で、呼び出し側がノードの opacity に寄せる
   */
  private paint(
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
        return fallback !== '' ? this.paint(fallback, opacity, inherited, matrix, userBox, node) : none
      }
      const element = this.definitions.get(target.slice(1))
      if (element?.name === 'linearGradient') {
        const paint = this.linearGradient(element, inherited, matrix, userBox, node)
        return paint ? { paints: [paint], alpha: opacity } : none
      }
      if (element?.name === 'radialGradient') {
        const paint = this.radialGradient(element, inherited, matrix, userBox, node)
        return paint ? { paints: [paint], alpha: opacity } : none
      }
      if (element?.name === 'pattern') this.warn('パターンの塗り')
      else this.warn('たどれない塗りの参照')
      return fallback !== '' ? this.paint(fallback, opacity, inherited, matrix, userBox, node) : none
    }
    const color = this.color(value, inherited)
    if (!color) {
      this.warn('読めない色')
      return none
    }
    if (color.alpha === 0) return none
    return { paints: [{ type: 'solid', color: color.color }], alpha: color.alpha * opacity }
  }

  private color(value: string, inherited: Inherited): Rgba | null {
    if (value === 'currentColor') return parseColor(inherited.color)
    return parseColor(value)
  }

  /** href でたどった先も含めて、最初に見つかった属性・色の並び */
  private gradientChain(element: SvgElement): SvgElement[] {
    const chain = [element]
    let current = element
    while (chain.length < 8) {
      const href = (current.attributes.href ?? current.attributes['xlink:href'])?.trim()
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

  private stops(element: SvgElement, inherited: Inherited): ColorStop[] {
    const owner = this.gradientChain(element).find((item) =>
      item.children.some((child) => typeof child !== 'string' && child.name === 'stop'),
    )
    if (!owner) return []
    const stops: ColorStop[] = []
    let translucent = false
    let previous = 0
    for (const child of owner.children) {
      if (typeof child === 'string' || child.name !== 'stop') continue
      const style = parseStyle(child.attributes.style)
      const offset = Math.max(previous, clamp01(parseFraction(child.attributes.offset) ?? 0))
      previous = offset
      const rawColor = (style['stop-color'] ?? child.attributes['stop-color'] ?? 'black').trim()
      const color = (rawColor === 'currentColor' ? parseColor(inherited.color) : parseColor(rawColor)) ?? { color: '#000000', alpha: 1 }
      const opacity = parseFraction(style['stop-opacity'] ?? child.attributes['stop-opacity']) ?? 1
      if (color.alpha * opacity < 1) translucent = true
      stops.push({ offset, color: color.color })
    }
    if (translucent) this.warn('グラデーションの色の透明度')
    if (stops.length > MAX_STOPS) {
      this.warn(`${MAX_STOPS} 色を超えるグラデーション（間引いた）`)
      const picked = Array.from({ length: MAX_STOPS }, (_, i) => stops[Math.round((i * (stops.length - 1)) / (MAX_STOPS - 1))])
      return picked
    }
    return stops
  }

  /**
   * linearGradient を kadrokreo の直線状のグラデーションにする。kadrokreo のグラデーションは向き（angle）だけを持ち、
   * 枠の角から角まで色が変わるので、SVG の始点と終点がその線のどこに当たるかを求め、色の位置をそこへ写す
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
    if (stops.length === 1) return { type: 'solid', color: stops[0].color }
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
      if (userBox.width === 0 || userBox.height === 0) return { type: 'solid', color: stops[stops.length - 1].color }
      toPage = multiply(multiply(matrix, [userBox.width, 0, 0, userBox.height, userBox.x, userBox.y]), gradientTransform)
    }
    const start = toNodeSpace(node, applyMatrix(toPage, p1))
    const end = toNodeSpace(node, applyMatrix(toPage, p2))
    const dx = end.x - start.x
    const dy = end.y - start.y
    if (Math.hypot(dx, dy) < 1e-9) return { type: 'solid', color: stops[stops.length - 1].color }
    const angle = round((Math.atan2(dy, dx) * 180) / Math.PI)
    const [from, to] = gradientLine({ type: 'linear', angle, stops }, node)
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
      return { offset, color: stop.color }
    })
    return { type: 'linear', angle, stops: mapped }
  }

  /**
   * radialGradient を kadrokreo の円形のグラデーションにする。中心と横・縦の半径をノードの枠に対する割合に直す。
   * 焦点（fx / fy）と、回したり傾けたりした楕円の向きは持てないので、中心と半径の長さだけを写す
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
    const last: Paint = { type: 'solid', color: stops[stops.length - 1].color }
    if (stops.length === 1) return { type: 'solid', color: stops[0].color }
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
    if (attribute('fx') !== undefined || attribute('fy') !== undefined) {
      const fx = attribute('fx') === undefined ? c.x : coordinate('fx', 'width')
      const fy = attribute('fy') === undefined ? c.y : coordinate('fy', 'height')
      if (fx !== c.x || fy !== c.y) this.warn('円形のグラデーションの焦点（中心に寄せた）')
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
    const tilt = Math.abs(alongX.y - center.y) + Math.abs(alongY.x - center.x)
    if (tilt > 1e-6 * (node.width + node.height)) this.warn('回した・傾けた円形のグラデーション（向きをなくした）')
    const rx = Math.hypot(alongX.x - center.x, alongX.y - center.y)
    const ry = Math.hypot(alongY.x - center.x, alongY.y - center.y)
    const values = [center.x / node.width, center.y / node.height, rx / node.width, ry / node.height].map(round4)
    if (!values.every(Number.isFinite)) return last
    const [cx, cy, rxRatio, ryRatio] = values
    return { type: 'radial', cx, cy, rx: rxRatio, ry: ryRatio, stops }
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

function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

function rotationOf(degrees: number): number {
  const value = round(degrees)
  return value === 0 || Object.is(value, -0) ? 0 : value
}

function opacityOf(element: SvgElement): number {
  const raw = parseStyle(element.attributes.style).opacity ?? element.attributes.opacity
  const value = parseFraction(raw)
  return value === null ? 1 : clamp01(value)
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
export function viewBoxMatrix(viewBox: readonly number[], size: Size, preserve = 'xMidYMid meet'): Matrix {
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
function outerBounds(node: SceneNode): Bounds {
  if (node.rotation === 0) return { x: node.x, y: node.y, width: node.width, height: node.height }
  const radians = (node.rotation * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const cx = node.width / 2
  const cy = node.height / 2
  const m: Matrix = [cos, sin, -sin, cos, node.x + cx - cos * cx + sin * cy, node.y + cy - sin * cx - cos * cy]
  return transformRect(m, { x: 0, y: 0, width: node.width, height: node.height })
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

function ellipseVertices(cx: number, cy: number, rx: number, ry: number): Vertex[] {
  const kx = rx * KAPPA
  const ky = ry * KAPPA
  return [
    { x: cx + rx, y: cy, in: { x: cx + rx, y: cy - ky }, out: { x: cx + rx, y: cy + ky } },
    { x: cx, y: cy + ry, in: { x: cx + kx, y: cy + ry }, out: { x: cx - kx, y: cy + ry } },
    { x: cx - rx, y: cy, in: { x: cx - rx, y: cy + ky }, out: { x: cx - rx, y: cy - ky } },
    { x: cx, y: cy - ry, in: { x: cx - kx, y: cy - ry }, out: { x: cx + kx, y: cy - ry } },
  ]
}

function fontWeightOf(raw: string): number {
  if (raw === 'bold' || raw === 'bolder') return 700
  if (raw === 'lighter') return 300
  const value = Number(raw)
  if (!Number.isFinite(value)) return 400
  return Math.min(900, Math.max(100, Math.round(value / 100) * 100))
}

/**
 * text の中身を行に分ける。x か dy を持つ tspan（2 つ目以降）は新しい行とみなす。
 * 空白は XML の既定（xml:space="default"）どおり 1 つにまとめる
 */
function textLines(element: SvgElement): string[] {
  const lines: string[] = ['']
  const walk = (nodes: SvgNode[]) => {
    for (const node of nodes) {
      if (typeof node === 'string') {
        lines[lines.length - 1] += node
        continue
      }
      if (node.name !== 'tspan' && node.name !== 'a') continue
      const breaks = node.attributes.x !== undefined || node.attributes.dy !== undefined
      if (breaks && lines[lines.length - 1].trim() !== '') lines.push('')
      walk(node.children)
    }
  }
  walk(element.children)
  return lines.map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line !== '')
}
