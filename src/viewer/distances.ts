import { type Bounds, type Point, rotateVector, tidy } from '../document/geometry.ts'

/** 2 つの矩形の間隔を表す線。axis は測る向き（x は横、y は縦。回した枠で測るときは、その枠の横・縦） */
export type Distance = {
  from: Point
  to: Point
  distance: number
  axis: 'x' | 'y'
  /**
   * 線の端から相手の辺まで伸ばす補助線。線が相手の矩形の正面にないとき（斜め向かいにあるときなど）、
   * どの辺までの間隔なのかが分かるように引く
   */
  guide: { from: Point; to: Point } | null
}

/**
 * 選んでいる矩形 a から、相手の矩形 b までの間隔。線は a の中心を通る。
 * 離れていれば向かい合う辺どうし、重なっていれば（b が a を含むときなど）同じ側の辺どうしを測る。
 * 間隔が 0 の向きには線を出さない。
 */
export function measureBetween(a: Bounds, b: Bounds): Distance[] {
  const horizontal = spans(a.x, a.x + a.width, b.x, b.x + b.width).map(([from, to, edge]): Distance => {
    const y = a.y + a.height / 2
    return {
      from: { x: from, y },
      to: { x: to, y },
      distance: tidy(to - from),
      axis: 'x',
      guide: guideTo(y, b.y, b.y + b.height, (along) => ({ x: edge, y: along })),
    }
  })
  const vertical = spans(a.y, a.y + a.height, b.y, b.y + b.height).map(([from, to, edge]): Distance => {
    const x = a.x + a.width / 2
    return {
      from: { x, y: from },
      to: { x, y: to },
      distance: tidy(to - from),
      axis: 'y',
      guide: guideTo(x, b.x, b.x + b.width, (along) => ({ x: along, y: edge })),
    }
  })
  return [...horizontal, ...vertical].filter((item) => item.distance !== 0)
}

/** 回した図形を含む 2 つの間隔。outlines は「何を測ったか」を示すために破線で描く枠（ページ座標の四隅） */
export type Measurement = {
  /** 測った枠の向き（度、0 以上 90 未満）。0 ならページの縦横 */
  angle: number
  distances: Distance[]
  outlines: Point[][]
}

/** 角度が同じとみなす差（度） */
const ANGLE_EPSILON = 0.01

/**
 * ページ座標の四隅（回す前の左上・右上・右下・左下の順）で表した 2 つの図形の間隔。
 * - 2 つの向きが同じ（90° の倍数の違いも同じとみなす）なら、その向きの枠で、辺に沿って測る。
 *   回っていない 2 つは、これまでどおりページの縦横で測ることになる。
 * - 向きが違えば、それぞれを囲むページの縦横の矩形どうしを測る（既存のデザインツールと同じ）。回っている側は、
 *   その矩形を outlines に入れる（線がどこに当たっているのか分かるように）。
 */
export function measureCorners(a: readonly Point[], b: readonly Point[]): Measurement {
  const angleA = edgeAngle(a)
  const angleB = edgeAngle(b)
  const angle = sameAngle(angleA, angleB) ? angleA : 0
  const into = (point: Point) => rotateVector(point, -angle)
  const back = (point: Point) => {
    const p = rotateVector(point, angle)
    return { x: tidy(p.x), y: tidy(p.y) }
  }
  const boxA = boxOf(a.map(into))
  const boxB = boxOf(b.map(into))
  const distances = measureBetween(boxA, boxB).map((item) => ({
    ...item,
    from: back(item.from),
    to: back(item.to),
    guide: item.guide && { from: back(item.guide.from), to: back(item.guide.to) },
  }))
  const outlines = [
    [angleA, boxA],
    [angleB, boxB],
  ]
    .filter(([own]) => !sameAngle(own as number, angle))
    .map(([, box]) => cornersOf(box as Bounds).map(back))
  return { angle: tidy(angle), distances, outlines }
}

/** 四隅から、図形の向き（度、0 以上 90 未満）。大きさのない図形は 0 */
function edgeAngle(corners: readonly Point[]): number {
  const [p0, p1, , p3] = corners
  const top = { x: p1.x - p0.x, y: p1.y - p0.y }
  // 幅が 0 なら、左の辺の向きから求める
  const edge = Math.hypot(top.x, top.y) > 1e-9 ? top : { x: p3.y - p0.y, y: -(p3.x - p0.x) }
  if (Math.hypot(edge.x, edge.y) <= 1e-9) return 0
  const degrees = (Math.atan2(edge.y, edge.x) * 180) / Math.PI
  const wrapped = ((degrees % 90) + 90) % 90
  return 90 - wrapped < ANGLE_EPSILON ? 0 : wrapped
}

function sameAngle(a: number, b: number): boolean {
  const diff = Math.abs(a - b)
  return diff < ANGLE_EPSILON || 90 - diff < ANGLE_EPSILON
}

/** 点を囲む矩形。回した計算の端数で「揃っている辺」がずれないよう、細かく丸める */
function boxOf(points: readonly Point[]): Bounds {
  const round = (value: number) => Math.round(value * 1e6) / 1e6
  const xs = points.map((point) => round(point.x))
  const ys = points.map((point) => round(point.y))
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

function cornersOf(box: Bounds): Point[] {
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ]
}

/**
 * 1 つの向きについて、測る区間を [小さい側, 大きい側, 相手の辺の位置] で返す。
 * a0〜a1 が選んでいる側、b0〜b1 が相手。
 */
function spans(a0: number, a1: number, b0: number, b1: number): [number, number, number][] {
  if (a1 <= b0) return a1 < b0 ? [[a1, b0, b0]] : []
  if (b1 <= a0) return b1 < a0 ? [[b1, a0, b1]] : []
  const result: [number, number, number][] = []
  if (a0 !== b0) result.push([Math.min(a0, b0), Math.max(a0, b0), b0])
  if (a1 !== b1) result.push([Math.min(a1, b1), Math.max(a1, b1), b1])
  return result
}

/** at が相手の範囲（low〜high）の外にあれば、at から近いほうの端までの補助線 */
function guideTo(
  at: number,
  low: number,
  high: number,
  point: (along: number) => Point,
): Distance['guide'] {
  if (at >= low && at <= high) return null
  return { from: point(at), to: point(at < low ? low : high) }
}
