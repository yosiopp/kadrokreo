import type { Bounds } from '../document/geometry.ts'
import type { Handle } from './resize.ts'

/** 揃ったことを示す線。axis が 'x' なら x = position の縦線で、from〜to は y の範囲 */
export type Guide = { axis: 'x' | 'y'; position: number; from: number; to: number }

const xLines = (b: Bounds) => [b.x, b.x + b.width / 2, b.x + b.width]
const yLines = (b: Bounds) => [b.y, b.y + b.height / 2, b.y + b.height]

/** 吸着の対象になる線。移動なら両端と中央、リサイズならハンドルで動く辺だけ */
function movingLines(b: Bounds, handle?: Handle): { x: number[]; y: number[] } {
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

/** 動かしている矩形を、近くにある targets の端か中央に揃えるための移動量 */
export function snapMove(
  bounds: Bounds,
  targets: readonly Bounds[],
  threshold: number,
): { dx: number; dy: number } {
  const lines = movingLines(bounds)
  return {
    dx: nearest(lines.x, targets.flatMap(xLines), threshold),
    dy: nearest(lines.y, targets.flatMap(yLines), threshold),
  }
}

/** リサイズ中の矩形の、ハンドルで動かしている辺を targets に揃える */
export function snapResize(
  bounds: Bounds,
  handle: Handle,
  targets: readonly Bounds[],
  threshold: number,
): Bounds {
  const lines = movingLines(bounds, handle)
  const dx = nearest(lines.x, targets.flatMap(xLines), threshold)
  const dy = nearest(lines.y, targets.flatMap(yLines), threshold)
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

/** bounds の線のうち、targets とぴったり揃っているものをガイドとして返す */
export function findGuides(bounds: Bounds, targets: readonly Bounds[], handle?: Handle): Guide[] {
  const lines = movingLines(bounds, handle)
  const guides: Guide[] = []
  const aligned = (a: number, b: number) => Math.abs(a - b) < 0.01

  for (const position of new Set(lines.x)) {
    const matched = targets.filter((t) => xLines(t).some((line) => aligned(line, position)))
    if (matched.length === 0) continue
    const all = [bounds, ...matched]
    guides.push({
      axis: 'x',
      position,
      from: Math.min(...all.map((b) => b.y)),
      to: Math.max(...all.map((b) => b.y + b.height)),
    })
  }
  for (const position of new Set(lines.y)) {
    const matched = targets.filter((t) => yLines(t).some((line) => aligned(line, position)))
    if (matched.length === 0) continue
    const all = [bounds, ...matched]
    guides.push({
      axis: 'y',
      position,
      from: Math.min(...all.map((b) => b.x)),
      to: Math.max(...all.map((b) => b.x + b.width)),
    })
  }
  return guides
}
