import { gridBands, gridSteps } from '../canvas/guideOverlay.ts'
import { type Bounds, applyMatrix, getWorldMatrix, invert, transformRect } from '../document/geometry.ts'
import type { FrameNode, LayoutGrid, NodeId, Scene } from '../document/types.ts'
import type { SnapLine } from './snap.ts'

// フレームのレイアウトグリッド（カラム・行・方眼）の形と、重ね描き・吸着の線。
// 描き方は canvas/guideOverlay.ts（viewer と共有）。ここは editor の吸着の線とパネルの既定値

/** 1 つのフレームに足せるレイアウトグリッドの数（kdr の読み込みの上限と同じ） */
export const MAX_LAYOUT_GRIDS = 100

/** 新しく足すレイアウトグリッド（12 カラム、溝と余白 20） */
export const DEFAULT_COLUMNS: Extract<LayoutGrid, { type: 'columns' | 'rows' }> = { type: 'columns', count: 12, gutter: 20, margin: 20 }

/**
 * フレームの座標系での、吸着の線（帯の両端と方眼の線）。範囲はフレームの中。
 * near（フレームの座標）を渡すと、方眼の線はその範囲に入るものだけにする（大きなフレームの細かい方眼で線が多くなりすぎないように）
 */
export function frameGridLines(frame: Pick<FrameNode, 'width' | 'height' | 'layoutGrids'>, near: Bounds | null = null): SnapLine[] {
  const lines: SnapLine[] = []
  for (const grid of frame.layoutGrids) {
    if (grid.type === 'grid') {
      const xs = near ? gridSteps(grid.size, frame.width, near.x, near.x + near.width) : gridSteps(grid.size, frame.width)
      const ys = near ? gridSteps(grid.size, frame.height, near.y, near.y + near.height) : gridSteps(grid.size, frame.height)
      for (const x of xs) lines.push({ axis: 'x', position: x, from: 0, to: frame.height })
      for (const y of ys) lines.push({ axis: 'y', position: y, from: 0, to: frame.width })
      continue
    }
    const columns = grid.type === 'columns'
    for (const band of gridBands(grid, columns ? frame.width : frame.height)) {
      for (const position of [band.start, band.start + band.size]) {
        lines.push(columns ? { axis: 'x', position, from: 0, to: frame.height } : { axis: 'y', position, from: 0, to: frame.width })
      }
    }
  }
  return lines
}

/**
 * フレーム frameId のレイアウトグリッドの線を、ページ座標の吸着の線にする。near（ページ座標）は動かしているものの近くの範囲で、
 * 方眼の線はそこに入るものだけにする。フレーム（と先祖）が回っていて、縦横がページの縦横に沿わないときは空（斜めの線には吸着しない）
 */
export function layoutGridSnapLines(scene: Scene, frameId: NodeId | null, near: Bounds | null = null): SnapLine[] {
  const frame = frameId === null ? null : scene.nodes[frameId]
  if (frame?.type !== 'frame' || frame.layoutGrids.length === 0) return []
  const matrix = getWorldMatrix(scene, frame.id)
  const [a, b, c, d] = matrix
  const eps = 1e-6
  const aligned = Math.abs(b) < eps && Math.abs(c) < eps
  const swapped = Math.abs(a) < eps && Math.abs(d) < eps
  if (!aligned && !swapped) return []
  const local = near && transformRect(invert(matrix), near)
  return frameGridLines(frame, local).map((line) => {
    // フレームの座標の線の 1 点と範囲の両端を、ページ座標に直す
    const along = (value: number) => (line.axis === 'x' ? { x: line.position, y: value } : { x: value, y: line.position })
    const p = applyMatrix(matrix, along(line.from))
    const q = applyMatrix(matrix, along(line.to))
    // 90° 回っていれば縦横が入れ替わる
    const axis = (line.axis === 'x') === aligned ? 'x' : 'y'
    return axis === 'x'
      ? { axis, position: p.x, from: Math.min(p.y, q.y), to: Math.max(p.y, q.y) }
      : { axis, position: p.y, from: Math.min(p.x, q.x), to: Math.max(p.x, q.x) }
  })
}
