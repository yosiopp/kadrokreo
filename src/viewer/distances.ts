import { type Bounds, type Point, tidy } from '../document/geometry.ts'

/** 2 つの矩形の間隔を表す、水平か垂直の線 */
export type Distance = {
  from: Point
  to: Point
  distance: number
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
  const horizontal = spans(a.x, a.x + a.width, b.x, b.x + b.width).map(([from, to, edge]) => {
    const y = a.y + a.height / 2
    return {
      from: { x: from, y },
      to: { x: to, y },
      distance: tidy(to - from),
      guide: guideTo(y, b.y, b.y + b.height, (along) => ({ x: edge, y: along })),
    }
  })
  const vertical = spans(a.y, a.y + a.height, b.y, b.y + b.height).map(([from, to, edge]) => {
    const x = a.x + a.width / 2
    return {
      from: { x, y: from },
      to: { x, y: to },
      distance: tidy(to - from),
      guide: guideTo(x, b.x, b.x + b.width, (along) => ({ x: along, y: edge })),
    }
  })
  return [...horizontal, ...vertical]
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
