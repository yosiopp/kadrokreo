import type { DesignDocument, NodeId } from './types.ts'

export type Point = { x: number; y: number }
export type Size = { width: number; height: number }
export type Bounds = Point & Size

/** ページ座標系での左上の位置 */
export function getAbsolutePosition(doc: DesignDocument, id: NodeId): Point {
  let x = 0
  let y = 0
  for (let current: NodeId | null = id; current !== null; current = doc.nodes[current].parentId) {
    x += doc.nodes[current].x
    y += doc.nodes[current].y
  }
  return { x, y }
}

export function getAbsoluteBounds(doc: DesignDocument, id: NodeId): Bounds {
  const { width, height } = doc.nodes[id]
  return { ...getAbsolutePosition(doc, id), width, height }
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

export function getNodesBounds(doc: DesignDocument, ids: readonly NodeId[]): Bounds | null {
  return unionBounds(ids.map((id) => getAbsoluteBounds(doc, id)))
}

/** ページ直下のノード全体を囲む矩形 */
export function getContentBounds(doc: DesignDocument): Bounds | null {
  return getNodesBounds(doc, doc.rootIds)
}

export function containsPoint(b: Bounds, p: Point): boolean {
  return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height
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
