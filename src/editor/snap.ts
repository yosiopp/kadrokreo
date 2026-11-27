import { type Bounds, type Point, boundsFromPoints, rotateVector, unionBounds } from '../document/geometry.ts'
import type { Handle } from './resize.ts'

/**
 * 揃ったことを示す線。axis が 'x' なら x = position の縦線で、from〜to は y の範囲。
 * rotation があれば、ページを -rotation 度回した座標（`toFrame`）での線（回した図形の向きに沿った線）
 */
export type Guide = { axis: 'x' | 'y'; position: number; from: number; to: number; rotation?: number }

/**
 * 吸着の相手と、動かしている側の形。矩形の端と中央に加えて、xs / ys の線にも揃える
 * （斜めに回った図形の角。囲む矩形の端だけでなく、角どうしも揃えられるように）
 */
export type SnapShape = Bounds & { xs?: readonly number[]; ys?: readonly number[] }

/**
 * 吸着の相手になる 1 本の線（ガイド線やレイアウトグリッドの線）。axis が 'x' なら x = position の縦線。
 * from〜to はその線が引かれている範囲（縦線なら y の範囲）で、揃ったことを示す線の長さに使う。端の無い線（ガイド線）は ±Infinity
 */
export type SnapLine = { axis: 'x' | 'y'; position: number; from: number; to: number }

const linePositions = (lines: readonly SnapLine[], axis: 'x' | 'y') => lines.filter((line) => line.axis === axis).map((line) => line.position)

const xLines = (b: SnapShape) => [b.x, b.x + b.width / 2, b.x + b.width, ...(b.xs ?? [])]
const yLines = (b: SnapShape) => [b.y, b.y + b.height / 2, b.y + b.height, ...(b.ys ?? [])]

/** ページ座標の点を、rotation 度回した向きの座標に直す（その向きでは、同じ角度に回した図形の辺が縦横になる） */
export function toFrame(point: Point, rotation: number): Point {
  return rotation === 0 ? point : rotateVector(point, -rotation)
}

/**
 * 図形の四隅（ページ座標）の組から、rotation 度の向きで見た吸着の形を作る。
 * 枠はすべてを囲む矩形。その向きで斜めになっている図形は、角も揃える線にする。
 */
export function snapShape(cornerSets: readonly (readonly Point[])[], rotation = 0): SnapShape | null {
  const xs: number[] = []
  const ys: number[] = []
  const boxes: Bounds[] = []
  for (const corners of cornerSets) {
    const points = corners.map((corner) => toFrame(corner, rotation))
    if (points.length === 0) continue
    boxes.push(unionBounds(points.map((p) => boundsFromPoints(p, p)))!)
    // 縦横に沿った矩形なら、角は枠の端と同じなので足さない
    const aligned = points.every((p, i) => {
      const next = points[(i + 1) % points.length]
      return Math.abs(p.x - next.x) < 0.01 || Math.abs(p.y - next.y) < 0.01
    })
    if (aligned) continue
    for (const p of points) {
      xs.push(p.x)
      ys.push(p.y)
    }
  }
  const bounds = unionBounds(boxes)
  return bounds && { ...bounds, xs, ys }
}

/** 吸着の対象になる線。移動なら両端と中央、リサイズならハンドルで動く辺だけ */
function movingLines(b: SnapShape, handle?: Handle): { x: number[]; y: number[] } {
  if (!handle) return { x: xLines(b), y: yLines(b) }
  return {
    x: handle.includes('w') ? [b.x] : handle.includes('e') ? [b.x + b.width] : [],
    y: handle.includes('n') ? [b.y] : handle.includes('s') ? [b.y + b.height] : [],
  }
}

/** lines のどれかを targets のどれかに合わせるための最小の移動量。threshold 以内になければ 0 */
function nearest(lines: number[], targets: number[], threshold: number): number {
  let best = 0
  let bestDistance = Infinity
  for (const line of lines) {
    for (const target of targets) {
      const distance = Math.abs(target - line)
      if (distance <= threshold && distance < bestDistance) {
        bestDistance = distance
        best = target - line
      }
    }
  }
  return best
}

/** 動かしている矩形を、近くにある targets の端か中央（と snapLines の線）に揃えるための移動量 */
export function snapMove(
  bounds: SnapShape,
  targets: readonly SnapShape[],
  threshold: number,
  snapLines: readonly SnapLine[] = [],
): { dx: number; dy: number } {
  const lines = movingLines(bounds)
  return {
    dx: nearest(lines.x, [...targets.flatMap(xLines), ...linePositions(snapLines, 'x')], threshold),
    dy: nearest(lines.y, [...targets.flatMap(yLines), ...linePositions(snapLines, 'y')], threshold),
  }
}

/** リサイズ中の矩形の、ハンドルで動かしている辺を targets（と snapLines の線）に揃える */
export function snapResize(
  bounds: Bounds,
  handle: Handle,
  targets: readonly SnapShape[],
  threshold: number,
  snapLines: readonly SnapLine[] = [],
): Bounds {
  const lines = movingLines(bounds, handle)
  const dx = nearest(lines.x, [...targets.flatMap(xLines), ...linePositions(snapLines, 'x')], threshold)
  const dy = nearest(lines.y, [...targets.flatMap(yLines), ...linePositions(snapLines, 'y')], threshold)
  let { x, y, width, height } = bounds
  if (handle.includes('w')) {
    x += dx
    width -= dx
  } else {
    width += dx
  }
  if (handle.includes('n')) {
    y += dy
    height -= dy
  } else {
    height += dy
  }
  return { x, y, width: Math.max(1, width), height: Math.max(1, height) }
}

/**
 * bounds の線のうち、targets（と snapLines の線）とぴったり揃っているものをガイドとして返す。
 * 揃った線の長さは、揃ったものの範囲を合わせたもの（端の無い線は、範囲に入れない）
 */
export function findGuides(bounds: SnapShape, targets: readonly SnapShape[], handle?: Handle, snapLines: readonly SnapLine[] = []): Guide[] {
  const lines = movingLines(bounds, handle)
  const guides: Guide[] = []
  const aligned = (a: number, b: number) => Math.abs(a - b) < 0.01
  const finite = (values: number[]) => values.filter((value) => Number.isFinite(value))

  for (const position of new Set(lines.x)) {
    const matched = targets.filter((t) => xLines(t).some((line) => aligned(line, position)))
    const matchedLines = snapLines.filter((line) => line.axis === 'x' && aligned(line.position, position))
    if (matched.length === 0 && matchedLines.length === 0) continue
    const all = [bounds, ...matched]
    guides.push({
      axis: 'x',
      position,
      from: Math.min(...all.map((b) => b.y), ...finite(matchedLines.map((line) => line.from))),
      to: Math.max(...all.map((b) => b.y + b.height), ...finite(matchedLines.map((line) => line.to))),
    })
  }
  for (const position of new Set(lines.y)) {
    const matched = targets.filter((t) => yLines(t).some((line) => aligned(line, position)))
    const matchedLines = snapLines.filter((line) => line.axis === 'y' && aligned(line.position, position))
    if (matched.length === 0 && matchedLines.length === 0) continue
    const all = [bounds, ...matched]
    guides.push({
      axis: 'y',
      position,
      from: Math.min(...all.map((b) => b.x), ...finite(matchedLines.map((line) => line.from))),
      to: Math.max(...all.map((b) => b.x + b.width), ...finite(matchedLines.map((line) => line.to))),
    })
  }
  return guides
}
