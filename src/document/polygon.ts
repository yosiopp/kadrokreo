import type { Point } from './geometry.ts'
import type { PathPoint } from './types.ts'

// 正多角形と星の頂点。editor のツールと CLI（add・マークアップ）が使う。
// できるのはふつうの閉じたパス（頂点の数を後から変えられる専用のノードにはしない）。頂点は枠いっぱいに広げた割合で持つので、
// 枠の大きさを変えれば形も伸び縮みする。正多角形のまま置くには、枠の縦横比を aspect に合わせる。

/** 頂点（星は先の数）の数の範囲 */
export const POLYGON_MIN_COUNT = 3
export const POLYGON_MAX_COUNT = 100

/** 星の内側の頂点の、外側に対する半径の比の既定（正五角形から作る星（五芒星）の比 ≒ 0.382） */
export const STAR_DEFAULT_RATIO = 0.382

export type PolygonShape = {
  /** 枠に対する割合の頂点（最初の頂点が上の真ん中、時計回り） */
  points: PathPoint[]
  /** 正多角形・正しい形の星になる枠の縦横比（幅 / 高さ） */
  aspect: number
}

/** 正多角形（count 角形）。最初の頂点を真上に置く */
export function regularPolygon(count: number): PolygonShape {
  checkCount(count)
  return fit(Array.from({ length: count }, (_, i) => onCircle(1, i / count)))
}

/** 星（先が count 個）。ratio は内側の頂点の半径の、先の半径に対する比（0 より大きく 1 未満） */
export function star(count: number, ratio = STAR_DEFAULT_RATIO): PolygonShape {
  checkCount(count)
  if (!(ratio > 0 && ratio < 1)) throw new RangeError(`星の内側の比は 0 より大きく 1 未満です: ${ratio}`)
  return fit(Array.from({ length: count * 2 }, (_, i) => onCircle(i % 2 === 0 ? 1 : ratio, i / (count * 2))))
}

/** 枠の大きさを、縦横の片方か両方を省いたときに決める。省いた側は aspect から（両方なければ幅を size にする） */
export function polygonSize(aspect: number, width?: number, height?: number, size = 100): { width: number; height: number } {
  if (width !== undefined && height !== undefined) return { width, height }
  if (width !== undefined) return { width, height: round2(width / aspect) }
  if (height !== undefined) return { width: round2(height * aspect), height }
  return { width: size, height: round2(size / aspect) }
}

function checkCount(count: number): void {
  if (!Number.isInteger(count) || count < POLYGON_MIN_COUNT || count > POLYGON_MAX_COUNT) {
    throw new RangeError(`頂点の数は ${POLYGON_MIN_COUNT}〜${POLYGON_MAX_COUNT} の整数です: ${count}`)
  }
}

/** 半径 radius の円の上で、真上から時計回りに turn（1 で 1 周）だけ進んだ点 */
function onCircle(radius: number, turn: number): Point {
  const angle = turn * Math.PI * 2 - Math.PI / 2
  return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) }
}

/** 頂点を囲む矩形に対する割合に直す */
function fit(vertices: readonly Point[]): PolygonShape {
  const xs = vertices.map((p) => p.x)
  const ys = vertices.map((p) => p.y)
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  const width = Math.max(...xs) - left
  const height = Math.max(...ys) - top
  return {
    points: vertices.map((p) => ({ x: clean((p.x - left) / width), y: clean((p.y - top) / height) })),
    aspect: width / height,
  }
}

/** 計算の誤差（1e-16 など）を落とす。kdr に書く値を短く、比べやすくする */
function clean(value: number): number {
  return Math.round(value * 1e9) / 1e9
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
