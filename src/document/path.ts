import type { Bounds, Point } from './geometry.ts'
import type { Cap, LineNode, PathNode } from './types.ts'

/** 直線の始点と終点（ノードの座標系） */
export function lineEndpoints(
  line: Pick<LineNode, 'width' | 'height' | 'direction' | 'flipped'>,
): [Point, Point] {
  const { width, height } = line
  const [left, right] =
    line.direction === 'down'
      ? [{ x: 0, y: 0 }, { x: width, y: height }]
      : [{ x: 0, y: height }, { x: width, y: 0 }]
  return line.flipped ? [right, left] : [left, right]
}

/** from を始点、to を終点とする直線の枠と向き */
export function lineBetween(
  from: Point,
  to: Point,
): Bounds & Pick<LineNode, 'direction' | 'flipped'> {
  const sameSign = (to.x - from.x) * (to.y - from.y) >= 0
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
    direction: sameSign ? 'down' : 'up',
    // 始点が右側（垂直な線では下側）にあるとき
    flipped: to.x < from.x || (to.x === from.x && to.y < from.y),
  }
}

/** パスの頂点（ノードの座標系） */
export function pathPoints(path: Pick<PathNode, 'width' | 'height' | 'points'>): Point[] {
  return path.points.map((point) => ({ x: point.x * path.width, y: point.y * path.height }))
}

/** 頂点の並びから、それを囲む枠と、枠に対する割合で表した頂点を作る */
export function pathFromPoints(points: readonly Point[]): Bounds & Pick<PathNode, 'points'> {
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  const width = Math.max(...xs) - x
  const height = Math.max(...ys) - y
  return {
    x,
    y,
    // 水平・垂直に並んだ頂点でも、枠がつぶれないようにする
    width: Math.max(1, width),
    height: Math.max(1, height),
    points: points.map((point) => ({
      x: width === 0 ? 0 : (point.x - x) / width,
      y: height === 0 ? 0 : (point.y - y) / height,
    })),
  }
}

/** 矢印の長さ。線が細くても見える大きさにする */
export function arrowSize(strokeWidth: number): number {
  return Math.max(strokeWidth * 4, 10)
}

/**
 * 端に矢印を付けた線の形。line は線として引く頂点（矢印の根元の手前で止めたもの）、heads は矢印の三角形。
 * 矢印の先が端の位置にちょうど来るよう、線は矢印の分だけ短くする。描画（canvas）と HTML の出力で同じ形にするためのもの。
 */
export function cappedStroke(
  points: readonly Point[],
  style: { strokeWidth: number; startCap: Cap; endCap: Cap },
): { line: Point[]; heads: [Point, Point, Point][] } {
  const size = arrowSize(style.strokeWidth)
  const line = [...points]
  const heads: [Point, Point, Point][] = []
  const addHead = (tipIndex: number, neighborIndex: number) => {
    const tip = points[tipIndex]
    const neighbor = points[neighborIndex]
    const length = Math.hypot(tip.x - neighbor.x, tip.y - neighbor.y)
    if (length === 0) return
    const direction = { x: (tip.x - neighbor.x) / length, y: (tip.y - neighbor.y) / length }
    const inset = Math.min(size * 0.8, length)
    line[tipIndex] = { x: tip.x - direction.x * inset, y: tip.y - direction.y * inset }
    const baseX = tip.x - direction.x * size
    const baseY = tip.y - direction.y * size
    const half = size * 0.4
    heads.push([
      tip,
      { x: baseX - direction.y * half, y: baseY + direction.x * half },
      { x: baseX + direction.y * half, y: baseY - direction.x * half },
    ])
  }
  if (points.length >= 2) {
    if (style.startCap === 'arrow') addHead(0, 1)
    if (style.endCap === 'arrow') addHead(points.length - 1, points.length - 2)
  }
  return { line, heads }
}
