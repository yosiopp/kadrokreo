import type { NodeId, Scene } from './types.ts'

export type Point = { x: number; y: number }
export type Size = { width: number; height: number }
export type Bounds = Point & Size

/** アフィン変換。x' = a·x + c·y + e、y' = b·x + d·y + f（Canvas の transform と同じ並び） */
export type Matrix = readonly [a: number, b: number, c: number, d: number, e: number, f: number]

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** n を先に、m を後に適用する変換 */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

export function invert([a, b, c, d, e, f]: Matrix): Matrix {
  const det = a * d - b * c
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]
}

export function applyMatrix(m: Matrix, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] }
}

/** 時計回りに degrees 回したベクトル（y 軸は下向き） */
export function rotateVector(v: Point, degrees: number): Point {
  if (degrees === 0) return v
  const radians = (degrees * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos }
}

/** -180 より大きく 180 以下に収める */
export function normalizeAngle(degrees: number): number {
  const wrapped = ((((degrees + 180) % 360) + 360) % 360) - 180
  return wrapped === -180 ? 180 : wrapped
}

/** 計算で出る 1e-15 のような端数を落とす */
export function tidy(value: number): number {
  return Math.round(value * 100) / 100
}

type Placed = Point & Size & { rotation: number }

/**
 * ノードの座標系（枠の左上が原点）から親の座標系への変換。
 * 枠の中心を軸に rotation だけ回してから (x, y) へ置く。
 */
export function nodeMatrix(node: Placed): Matrix {
  if (node.rotation === 0) return [1, 0, 0, 1, node.x, node.y]
  const radians = (node.rotation * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const cx = node.width / 2
  const cy = node.height / 2
  return [cos, sin, -sin, cos, node.x + cx - cos * cx + sin * cy, node.y + cy - sin * cx - cos * cy]
}

/** 親の座標系の点を、ノードの座標系（枠の左上が原点、回す前の向き）に直す */
export function toNodeSpace(node: Placed, point: Point): Point {
  const local = { x: point.x - node.x, y: point.y - node.y }
  if (node.rotation === 0) return local
  const cx = node.width / 2
  const cy = node.height / 2
  const turned = rotateVector({ x: local.x - cx, y: local.y - cy }, -node.rotation)
  return { x: turned.x + cx, y: turned.y + cy }
}

/** ノードの座標系からページ座標系への変換。id が null ならページそのもの */
export function getWorldMatrix(scene: Scene, id: NodeId | null): Matrix {
  let matrix = IDENTITY
  for (let current = id; current !== null; current = scene.nodes[current].parentId) {
    matrix = multiply(nodeMatrix(scene.nodes[current]), matrix)
  }
  return matrix
}

/** 祖先の分も合わせた、ページ上での向き */
export function getWorldRotation(scene: Scene, id: NodeId | null): number {
  let rotation = 0
  for (let current = id; current !== null; current = scene.nodes[current].parentId) {
    rotation += scene.nodes[current].rotation
  }
  return rotation
}

/** ページ座標の点を、parentId の中の座標に直す */
export function toLocal(scene: Scene, parentId: NodeId | null, point: Point): Point {
  return parentId === null ? point : applyMatrix(invert(getWorldMatrix(scene, parentId)), point)
}

/** ページ上での中心 */
export function getWorldCenter(scene: Scene, id: NodeId): Point {
  const { width, height } = scene.nodes[id]
  return applyMatrix(getWorldMatrix(scene, id), { x: width / 2, y: height / 2 })
}

/** ページ上での四隅（回す前の左上・右上・右下・左下の順） */
export function getCorners(scene: Scene, id: NodeId): Point[] {
  const { width, height } = scene.nodes[id]
  const matrix = getWorldMatrix(scene, id)
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ].map((corner) => applyMatrix(matrix, corner))
}

/**
 * ページ上で中心が center、向きが rotation になるよう parentId の中に置くための x, y, rotation。
 * 親を付け替えても見た目を変えないために使う。
 */
export function poseInParent(
  scene: Scene,
  parentId: NodeId | null,
  center: Point,
  rotation: number,
  size: Size,
): Placed {
  const local = toLocal(scene, parentId, center)
  return {
    x: tidy(local.x - size.width / 2),
    y: tidy(local.y - size.height / 2),
    width: size.width,
    height: size.height,
    rotation: tidy(normalizeAngle(rotation - getWorldRotation(scene, parentId))),
  }
}

/** rect を変換した四角形を囲む、軸に平行な矩形 */
export function transformRect(m: Matrix, rect: Bounds): Bounds {
  if (m[1] === 0 && m[2] === 0 && m[0] === 1 && m[3] === 1) {
    return { x: rect.x + m[4], y: rect.y + m[5], width: rect.width, height: rect.height }
  }
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ].map((corner) => applyMatrix(m, corner))
  const xs = corners.map((corner) => corner.x)
  const ys = corners.map((corner) => corner.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

/** ページ上でノードを囲む、軸に平行な矩形。回転していれば枠より大きくなる */
export function getAbsoluteBounds(scene: Scene, id: NodeId): Bounds {
  const { width, height } = scene.nodes[id]
  return transformRect(getWorldMatrix(scene, id), { x: 0, y: 0, width, height })
}

export function unionBounds(list: readonly Bounds[]): Bounds | null {
  if (list.length === 0) return null
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const b of list) {
    left = Math.min(left, b.x)
    top = Math.min(top, b.y)
    right = Math.max(right, b.x + b.width)
    bottom = Math.max(bottom, b.y + b.height)
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function getNodesBounds(scene: Scene, ids: readonly NodeId[]): Bounds | null {
  return unionBounds(ids.map((id) => getAbsoluteBounds(scene, id)))
}

/** ページ直下のノード全体を囲む矩形 */
export function getContentBounds(scene: Scene): Bounds | null {
  return getNodesBounds(scene, scene.rootIds)
}

export function intersects(a: Bounds, b: Bounds): boolean {
  return (
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
  )
}

export function boundsFromPoints(a: Point, b: Point): Bounds {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  }
}
