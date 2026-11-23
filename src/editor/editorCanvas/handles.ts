import { type Viewport, worldToScreen } from '../../canvas/viewport.ts'
import {
  type Bounds,
  type Matrix,
  type Point,
  type Size,
  applyMatrix,
  getNodesBounds,
  getWorldMatrix,
  getWorldRotation,
  normalizeAngle,
} from '../../document/geometry.ts'
import { type Contour, type NodeKind, type Vertex, mapVertices, nodeKind, pathContours, pathPoints } from '../../document/path.ts'
import type { NodeId, PathNode, Scene } from '../../document/types.ts'
import { HANDLES, type Handle, handlePoint } from '../resize.ts'

// キャンバスの上に出す選択枠とハンドルの位置、ポインタの座標の丸めなど、EditorCanvas が使う計算

export const SNAP_DISTANCE = 6
export const DRAG_THRESHOLD = 4
export const HANDLE_SIZE = 8
/** 回転ハンドルを枠の上辺からどれだけ離すか（画面ピクセル） */
const ROTATE_HANDLE_OFFSET = 22

/**
 * 選択範囲を囲む枠。1 つだけ選んでいてそれが回っていれば、その向きに合わせる。
 * それ以外は軸に平行に囲む。
 */
export type SelectionBox = {
  ids: NodeId[]
  /** 枠の座標系（左上が原点）からページ座標系への変換 */
  matrix: Matrix
  size: Size
  /** ページ上での枠の向き（度） */
  rotation: number
  /** ページ上で囲む、軸に平行な矩形 */
  bounds: Bounds
  /** 枠がノードの向きに合っているとき、そのノード */
  oriented: NodeId | null
}

const NAMES = {
  frame: 'Frame',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  path: 'Path',
  text: 'Text',
  image: 'Image',
  boolean: 'Boolean',
} as const

export function nextName(page: Scene, type: NodeKind): string {
  const count = Object.values(page.nodes).filter((node) => nodeKind(node) === type).length
  return `${NAMES[type]} ${count + 1}`
}

export function toScreenBounds(viewport: Viewport, bounds: Bounds): Bounds {
  return {
    ...worldToScreen(viewport, bounds),
    width: bounds.width * viewport.zoom,
    height: bounds.height * viewport.zoom,
  }
}

export function roundPoint(p: Point): Point {
  return { x: Math.round(p.x), y: Math.round(p.y) }
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** 直線の両端（始点・終点の順）またはパスの頂点と制御点（ページ座標） */
export function editablePoints(page: Scene, node: PathNode): Vertex[] {
  const matrix = getWorldMatrix(page, node.id)
  return mapVertices(pathPoints(node), (point) => applyMatrix(matrix, point))
}

/** パスのすべての輪郭の頂点と制御点（ページ座標）。先頭が最初の輪郭。頂点は輪郭をつないだ通し番号で扱う（pathEdit.ts） */
export function editableContours(page: Scene, node: PathNode): Contour[] {
  const matrix = getWorldMatrix(page, node.id)
  return pathContours(node).map((contour) => ({
    vertices: mapVertices(contour.vertices, (point) => applyMatrix(matrix, point)),
    closed: contour.closed,
  }))
}

/** visibleControls を輪郭ごとに出し、番号を通し番号にしたもの */
export function visibleContourControls(
  contours: readonly Contour[],
  selected: readonly number[],
): { index: number; part: 'in' | 'out'; point: Point }[] {
  let start = 0
  return contours.flatMap(({ vertices, closed }) => {
    const local = selected.map((index) => index - start).filter((index) => index >= 0 && index < vertices.length)
    const controls = visibleControls(vertices, local, closed).map((control) => ({ ...control, index: control.index + start }))
    start += vertices.length
    return controls
  })
}

/** つかんだ点が頂点そのものか、その制御点か */
export type PointPart = 'vertex' | 'in' | 'out'

/**
 * 頂点を編集中に出す制御点のハンドル。選んだ頂点の 2 つと、両隣の頂点のうち選んだ頂点へ向かう辺の制御点
 * （どちらの端の曲がり具合も、選んだ頂点のまわりで直せるように）。頂点を複数選んでいれば、それぞれの分をまとめる
 */
function visibleControls(
  vertices: readonly Vertex[],
  selected: readonly number[],
  closed: boolean,
): { index: number; part: 'in' | 'out'; point: Point }[] {
  const count = vertices.length
  const controls: { index: number; part: 'in' | 'out'; point: Point }[] = []
  const seen = new Set<string>()
  const add = (index: number, part: 'in' | 'out') => {
    const point = vertices[index]?.[part]
    const key = `${index}${part}`
    if (point && !seen.has(key)) {
      seen.add(key)
      controls.push({ index, part, point })
    }
  }
  for (const index of selected) {
    if (!vertices[index]) continue
    add(index, 'in')
    add(index, 'out')
    const prev = index > 0 ? index - 1 : closed ? count - 1 : -1
    const next = index < count - 1 ? index + 1 : closed ? 0 : -1
    if (prev >= 0 && prev !== index) add(prev, 'out')
    if (next >= 0 && next !== index) add(next, 'in')
  }
  return controls
}

/** ハンドルを引いた後の枠の大きさを整数にする。つかんでいない側の辺は動かさない */
export function roundBox(box: Bounds, handle: Handle): Bounds {
  const width = Math.max(1, Math.round(box.width))
  const height = Math.max(1, Math.round(box.height))
  return {
    x: handle.includes('w') ? box.x + box.width - width : box.x,
    y: handle.includes('n') ? box.y + box.height - height : box.y,
    width,
    height,
  }
}

/** from から見た to の向きを 45° 刻みに揃える */
export function constrainAngle(from: Point, to: Point): Point {
  const step = Math.PI / 4
  const angle = Math.round(Math.atan2(to.y - from.y, to.x - from.x) / step) * step
  const length = distance(from, to)
  return roundPoint({ x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length })
}

/** from から見た to の向き（度）。右が 0 で時計回り */
export function angleFrom(from: Point, to: Point): number {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI
}

/** ids を囲む、リサイズと回転のハンドルを出す枠 */
export function selectionBoxOf(page: Scene, ids: NodeId[]): SelectionBox | null {
  const bounds = getNodesBounds(page, ids)
  if (!bounds) return null

  const rotation = ids.length === 1 ? normalizeAngle(getWorldRotation(page, ids[0])) : 0
  if (rotation !== 0) {
    const { width, height } = page.nodes[ids[0]]
    const matrix = getWorldMatrix(page, ids[0])
    return { ids, matrix, size: { width, height }, rotation, bounds, oriented: ids[0] }
  }
  return {
    ids,
    matrix: [1, 0, 0, 1, bounds.x, bounds.y],
    size: { width: bounds.width, height: bounds.height },
    rotation: 0,
    bounds,
    oriented: null,
  }
}

/** 枠の座標系の点を画面座標に直す */
export function boxToScreen(viewport: Viewport, box: SelectionBox, point: Point): Point {
  return worldToScreen(viewport, applyMatrix(box.matrix, point))
}

/** 小さく映っているときは辺のハンドルを出さない。角と重なってつかめなくなるため */
export function visibleHandles(viewport: Viewport, box: SelectionBox): Handle[] {
  const width = box.size.width * viewport.zoom
  const height = box.size.height * viewport.zoom
  return HANDLES.filter((handle) => {
    if (handle.length === 2) return true
    return handle === 'n' || handle === 's' ? width >= 24 : height >= 24
  })
}

/** 回転ハンドルの位置（画面座標）。枠の上辺の中央から少し離す */
export function rotateHandlePoint(viewport: Viewport, box: SelectionBox): Point {
  const offset = ROTATE_HANDLE_OFFSET / viewport.zoom
  return boxToScreen(viewport, box, { x: box.size.width / 2, y: -offset })
}

/** screen にあるリサイズのハンドル */
export function handleAt(viewport: Viewport, box: SelectionBox | null, screen: Point): Handle | null {
  if (!box) return null
  // 角を先に調べる
  const handles = visibleHandles(viewport, box).toSorted((a, b) => b.length - a.length)
  for (const handle of handles) {
    const p = boxToScreen(viewport, box, handlePoint({ x: 0, y: 0, ...box.size }, handle))
    if (Math.abs(p.x - screen.x) <= HANDLE_SIZE && Math.abs(p.y - screen.y) <= HANDLE_SIZE) {
      return handle
    }
  }
  return null
}

export function rotateHandleAt(viewport: Viewport, box: SelectionBox | null, screen: Point): boolean {
  return box !== null && distance(rotateHandlePoint(viewport, box), screen) <= HANDLE_SIZE
}
