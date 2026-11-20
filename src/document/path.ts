import type { Bounds, Point } from './geometry.ts'
import type { LineNode, PathNode } from './types.ts'

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
