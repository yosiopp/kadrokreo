import { type Bounds, applyMatrix, nodeMatrix, unionBounds } from './geometry.ts'
import { type MaskNode, maskFillRule, roundedRectContour, shapeContours } from './mask.ts'
import { strokeOutline } from './outlineStroke.ts'
import { hasStroke } from './paint.ts'
import { type Contour, type Vertex, mapVertices, pathBounds } from './path.ts'
import { type BooleanShape, booleanContours } from './pathBoolean.ts'
import type { BooleanOperation, FrameNode, PathNode, PathPoint, RectNode, Scene, SceneNode } from './types.ts'

// ブーリアン演算のノード（FrameNode の booleanOperation が null でないもの）。子を描かず、子の形に演算をかけた結果を描く。
// 描画・当たり判定・SVG の書き出し・Dev モードは、演算のノードを drawnNode で「結果の形を持つパス」に置き換えて扱う。
// 結果は子が変わらない限り覚えておく（2 つの円で数 ms、頂点の多い形では数十 ms かかる）。

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
  let stroked: MaskNode
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

/** 結果を左右するノード（子孫すべて）。どれかが別のオブジェクトに変われば計算し直す */
function inputsOf(scene: Scene, node: BooleanNode): SceneNode[] {
  const list: SceneNode[] = []
  const visit = (ids: readonly string[]) => {
    for (const id of ids) {
      const child = scene.nodes[id]
      if (!child) continue
      list.push(child)
      if (child.type === 'frame' && child.booleanOperation !== null) visit(child.children)
    }
  }
  visit(node.children)
  return list
}

const resultCache = new WeakMap<BooleanNode, { inputs: SceneNode[]; contours: Contour[] }>()

/** 演算の結果の輪郭（演算のノードの座標系、evenodd で塗る）。何も残らなければ空 */
export function booleanResult(scene: Scene, node: BooleanNode): Contour[] {
  const inputs = inputsOf(scene, node)
  const cached = resultCache.get(node)
  if (cached && cached.inputs.length === inputs.length && cached.inputs.every((input, i) => input === inputs[i])) return cached.contours
  const shapes = booleanShapes(scene, node)
  const contours = shapes.length === 0 ? [] : booleanContours(shapes, node.booleanOperation)
  resultCache.set(node, { inputs, contours })
  return contours
}

/** 結果を囲む矩形（演算のノードの座標系）。何も残らなければ null */
export function booleanBounds(scene: Scene, node: BooleanNode): Bounds | null {
  return unionBounds(booleanResult(scene, node).map((contour) => pathBounds(contour.vertices, true)))
}

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
