import { type Bounds, applyMatrix, nodeMatrix, unionBounds } from './geometry.ts'
import { type ShapeNode, maskFillRule, roundedRectContour, shapeContours } from './mask.ts'
import { strokeOutline } from './outlineStroke.ts'
import { hasStroke } from './paint.ts'
import { type Contour, type Vertex, mapVertices, pathBounds } from './path.ts'
import { type BooleanShape, booleanContours } from './pathBoolean.ts'
import type { BooleanOperation, FrameNode, PathNode, PathPoint, RectNode, Scene, SceneNode } from './types.ts'

// ブーリアン演算のノード（FrameNode の booleanOperation が null でないもの）。子を描かず、子の形に演算をかけた結果を描く。
// 描画・当たり判定・SVG の書き出し・Dev モードは、演算のノードを drawnNode で「結果の形を持つパス」に置き換えて扱う。
// 結果は子が変わらない限り覚えておく（2 つの円で数 ms、頂点の多い形では数十 ms かかる）。子がそろって平行移動しただけなら前の結果をずらして使い、
// editor のドラッグ中は重い演算を計算し直さずに前の結果を見せる（deferSlowBooleans）。

/** ブーリアン演算のノード */
export type BooleanNode = FrameNode & { booleanOperation: BooleanOperation }

export function isBooleanNode(node: SceneNode): node is BooleanNode {
  return node.type === 'frame' && node.booleanOperation !== null
}

/** 演算に入れられる種類か（テキストは入らない） */
export function canBoolean(node: SceneNode): boolean {
  return node.type !== 'text'
}

/** 子の形（子の座標系）。演算に入らないものは null */
function ownShape(scene: Scene, node: SceneNode): BooleanShape | null {
  switch (node.type) {
    case 'text':
      return null
    case 'rect':
    case 'path':
    case 'ellipse':
      return { contours: shapeContours(node), fillRule: maskFillRule(node) }
    case 'image':
      return { contours: [roundedRectContour(node.width, node.height, node.cornerRadius)], fillRule: 'nonzero' }
    case 'frame':
      if (isBooleanNode(node)) return { contours: booleanResult(scene, node), fillRule: 'evenodd' }
      return { contours: [roundedRectContour(node.width, node.height, node.cornerRadius)], fillRule: 'nonzero' }
  }
}

/**
 * 子の線の形（子の座標系、線の輪郭化と同じ形）。線を含める演算のノードで、子の形に合体する。
 * 線を持たない種類（テキスト・画像）と、線のない子は null。フレームは枠の角丸の矩形、入れ子の演算のノードは結果のパスの線
 */
function strokeShape(scene: Scene, node: SceneNode): BooleanShape | null {
  let stroked: ShapeNode
  switch (node.type) {
    case 'text':
    case 'image':
      return null
    case 'rect':
    case 'path':
    case 'ellipse':
      stroked = node
      break
    case 'frame':
      stroked = isBooleanNode(node) ? booleanPath(scene, node) : ({ ...node, type: 'rect' } as unknown as RectNode)
      break
  }
  if (!hasStroke(stroked)) return null
  const contours = strokeOutline(stroked)
  return contours.length === 0 ? null : { contours, fillRule: 'nonzero' }
}

/** 子の形に線の形を合体したもの（線を含める演算のノードの子）。線がなければ形のまま */
function withStroke(scene: Scene, node: SceneNode, shape: BooleanShape): BooleanShape {
  const stroke = strokeShape(scene, node)
  return stroke ? { contours: booleanContours([shape, stroke], 'union'), fillRule: 'evenodd' } : shape
}

/** 演算に入る子（見えていて、演算に入れられる種類のもの）。Dev モードの「元の図形 N 個」も、これを数える */
export function booleanParts(scene: Scene, node: BooleanNode): SceneNode[] {
  return node.children.flatMap((id) => {
    const child = scene.nodes[id]
    return child && child.visible && canBoolean(child) ? [child] : []
  })
}

/** 演算のノードの子の形（演算のノードの座標系）。隠した子と、入らない子は除く */
function booleanShapes(scene: Scene, node: BooleanNode): BooleanShape[] {
  return booleanParts(scene, node).flatMap((child) => {
    const own = ownShape(scene, child)
    if (!own) return []
    const shape = node.booleanIncludeStrokes ? withStroke(scene, child, own) : own
    const m = nodeMatrix(child)
    return [{ fillRule: shape.fillRule, contours: shape.contours.map((c) => ({ vertices: mapVertices(c.vertices, (p) => applyMatrix(m, p)), closed: true })) }]
  })
}

/**
 * 結果を左右するノード。direct は直接の子、nested は入れ子の演算のノードの子孫。
 * どれかが別のオブジェクトに変われば計算し直す（直接の子がそろって同じだけ平行移動しただけなら、前の結果をずらして使う）
 */
function inputsOf(scene: Scene, node: BooleanNode): { direct: SceneNode[]; nested: SceneNode[] } {
  const direct: SceneNode[] = []
  const nested: SceneNode[] = []
  const visit = (ids: readonly string[], list: SceneNode[]) => {
    for (const id of ids) {
      const child = scene.nodes[id]
      if (!child) continue
      list.push(child)
      if (child.type === 'frame' && child.booleanOperation !== null) visit(child.children, nested)
    }
  }
  visit(node.children, direct)
  return { direct, nested }
}

type CachedResult = {
  op: BooleanOperation
  includeStrokes: boolean
  direct: SceneNode[]
  nested: SceneNode[]
  contours: Contour[]
  /** 計算にかかった時間（ms）。ドラッグ中に計算を後回しにするかを決める */
  cost: number
}

// 子の並び（children の配列）ごとに覚える。演算のノード自身を動かしても children の配列は同じなので、計算し直さない
const resultCache = new WeakMap<readonly string[], CachedResult>()

/** 位置（x / y）のほかが同じか。同じなら位置のずれ、違えば null */
function shiftBetween(before: SceneNode, after: SceneNode): { dx: number; dy: number } | null {
  if (before === after) return { dx: 0, dy: 0 }
  const keys = Object.keys(after) as (keyof SceneNode)[]
  if (keys.length !== Object.keys(before).length) return null
  for (const key of keys) {
    if (key !== 'x' && key !== 'y' && before[key] !== after[key]) return null
  }
  return { dx: after.x - before.x, dy: after.y - before.y }
}

/** 前の入力から、直接の子がそろって同じだけ平行移動しただけか。そうなら、そのずれ */
function commonShift(cached: CachedResult, direct: readonly SceneNode[], nested: readonly SceneNode[]): { dx: number; dy: number } | null {
  if (cached.direct.length !== direct.length || cached.nested.length !== nested.length) return null
  if (!cached.nested.every((input, i) => input === nested[i])) return null
  let shift: { dx: number; dy: number } | null = null
  for (let i = 0; i < direct.length; i++) {
    const next = shiftBetween(cached.direct[i], direct[i])
    if (!next) return null
    if (shift && (Math.abs(shift.dx - next.dx) > 1e-9 || Math.abs(shift.dy - next.dy) > 1e-9)) return null
    shift = next
  }
  return shift ?? { dx: 0, dy: 0 }
}

/** ドラッグ中に後回しにする計算の重さ（ms）。これより軽い演算はドラッグ中も毎回計算する */
const DEFER_COST = 8

let deferring = false
let deferred = false

/**
 * ドラッグ中（editor のストアのプレビュー中）は、計算に DEFER_COST 以上かかった演算のノードを計算し直さず、前の結果をそのまま見せる。
 * 前の結果は演算のノードの座標系にあるので、ノードごと動かせば一緒に動く。false に戻したあとで計算し直す
 */
export function deferSlowBooleans(on: boolean): void {
  deferring = on
}

/** deferSlowBooleans の間に後回しにした演算があったか（読むと消える）。あれば、確定するときに計算し直す */
export function takeDeferredBooleans(): boolean {
  const result = deferred
  deferred = false
  return result
}

/** 演算の結果の輪郭（演算のノードの座標系、evenodd で塗る）。何も残らなければ空 */
export function booleanResult(scene: Scene, node: BooleanNode): Contour[] {
  const { direct, nested } = inputsOf(scene, node)
  const cached = resultCache.get(node.children)
  const includeStrokes = node.booleanIncludeStrokes
  if (cached && cached.op === node.booleanOperation && cached.includeStrokes === includeStrokes) {
    const shift = commonShift(cached, direct, nested)
    if (shift) {
      if (shift.dx === 0 && shift.dy === 0) return cached.contours
      const { dx, dy } = shift
      const contours = cached.contours.map((contour) => ({ vertices: mapVertices(contour.vertices, (p) => ({ x: p.x + dx, y: p.y + dy })), closed: true }))
      resultCache.set(node.children, { ...cached, direct, nested, contours })
      return contours
    }
    if (deferring && cached.cost >= DEFER_COST) {
      deferred = true
      return cached.contours
    }
  }
  const start = performance.now()
  const shapes = booleanShapes(scene, node)
  const contours = shapes.length === 0 ? [] : booleanContours(shapes, node.booleanOperation)
  resultCache.set(node.children, { op: node.booleanOperation, includeStrokes, direct, nested, contours, cost: performance.now() - start })
  return contours
}

/** 結果を囲む矩形（演算のノードの座標系）。何も残らなければ null */
export function booleanBounds(scene: Scene, node: BooleanNode): Bounds | null {
  const contours = booleanResult(scene, node)
  if (boundsCache.has(contours)) return boundsCache.get(contours)!
  const bounds = unionBounds(contours.map((contour) => pathBounds(contour.vertices, true)))
  boundsCache.set(contours, bounds)
  return bounds
}

// 結果ごとの囲む矩形（ストアが変更のたびに枠合わせで読むので、頂点を毎回なめない）
const boundsCache = new WeakMap<Contour[], Bounds | null>()

const pathCache = new WeakMap<BooleanNode, { contours: Contour[]; path: PathNode }>()

/**
 * 演算のノードを、結果の形を持つパスにしたもの（id・位置・大きさ・塗り・線・効果は演算のノードのまま）。
 * 頂点は演算のノードの枠に対する割合なので、枠が結果を囲む矩形からずれていても、同じ所に描かれる
 */
export function booleanPath(scene: Scene, node: BooleanNode): PathNode {
  const contours = booleanResult(scene, node)
  const cached = pathCache.get(node)
  if (cached && cached.contours === contours) return cached.path
  const { width, height } = node
  const fx = (value: number) => (width === 0 ? 0 : value / width)
  const fy = (value: number) => (height === 0 ? 0 : value / height)
  const ratios = (vertices: readonly Vertex[]): PathPoint[] =>
    vertices.map((vertex) => {
      const point: PathPoint = { x: fx(vertex.x), y: fy(vertex.y) }
      if (vertex.in) point.in = { x: fx(vertex.in.x - vertex.x), y: fy(vertex.in.y - vertex.y) }
      if (vertex.out) point.out = { x: fx(vertex.out.x - vertex.x), y: fy(vertex.out.y - vertex.y) }
      return point
    })
  const [first, ...rest] = contours
  const path: PathNode = {
    id: node.id,
    name: node.name,
    parentId: node.parentId,
    x: node.x,
    y: node.y,
    width,
    height,
    rotation: node.rotation,
    visible: node.visible,
    locked: node.locked,
    opacity: node.opacity,
    blendMode: node.blendMode,
    sizing: node.sizing,
    layoutPositioning: node.layoutPositioning,
    constraints: node.constraints,
    minWidth: node.minWidth,
    maxWidth: node.maxWidth,
    minHeight: node.minHeight,
    maxHeight: node.maxHeight,
    fills: node.fills,
    strokes: node.strokes,
    strokeWidth: node.strokeWidth,
    strokeDashes: node.strokeDashes,
    strokeDashOffset: node.strokeDashOffset,
    strokeJoin: node.strokeJoin,
    effects: node.effects,
    type: 'path',
    // 何も残らなければ、何も塗らない（頂点が 1 か所に重なった）形
    points: first ? ratios(first.vertices) : [{ x: 0, y: 0 }, { x: 0, y: 0 }],
    closed: true,
    startCap: 'none',
    endCap: 'none',
    capSize: 0,
    contours: rest.map((contour) => ({ points: ratios(contour.vertices), closed: true })),
    fillRule: 'evenodd',
    isMask: false,
    maskType: 'vector',
  }
  pathCache.set(node, { contours, path })
  return path
}

/** 描くときの形。演算のノードは結果のパス、そのほかはそのまま */
export function drawnNode(scene: Scene, node: SceneNode): SceneNode {
  return isBooleanNode(node) ? booleanPath(scene, node) : node
}

/** 演算の名前（画面の呼び名） */
export const BOOLEAN_OPERATION_LABELS: Record<BooleanOperation, string> = {
  union: '合体',
  subtract: '差し引き',
  intersect: '交差',
  exclude: '除外',
}
