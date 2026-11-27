import { type Viewport } from '../canvas/viewport.ts'
import { type Bounds, type Matrix, type Size, applyMatrix, getWorldMatrix, invert, transformRect } from '../document/geometry.ts'
import type { FrameNode, LayoutGrid, NodeId, Scene } from '../document/types.ts'
import type { SnapLine } from './snap.ts'

// フレームのレイアウトグリッド（カラム・行・方眼）の形と、重ね描き・吸着の線。
// どれも editor の補助なので、描画（canvas/render.ts）や書き出しには入れない

/** 1 つのフレームに足せるレイアウトグリッドの数（kdr の読み込みの上限と同じ） */
export const MAX_LAYOUT_GRIDS = 100
/**
 * 方眼の線を描く・吸着の相手にする本数の上限（向きごと）。線は見えている範囲（吸着なら動かしているものの近く）だけ作るので、
 * ふつうは届かない。細工したファイルで描画や吸着が止まらないための歯止め
 */
const MAX_GRID_LINES = 2000

/** 新しく足すレイアウトグリッド（12 カラム、溝と余白 20） */
export const DEFAULT_COLUMNS: Extract<LayoutGrid, { type: 'columns' | 'rows' }> = { type: 'columns', count: 12, gutter: 20, margin: 20 }

/** 帯（カラム・行）の、フレームの中での始まりと幅。帯の幅が 0 以下になるほど詰まっていれば空 */
export function gridBands(grid: Extract<LayoutGrid, { type: 'columns' | 'rows' }>, length: number): { start: number; size: number }[] {
  const size = (length - grid.margin * 2 - grid.gutter * (grid.count - 1)) / grid.count
  if (!(size > 0)) return []
  return Array.from({ length: grid.count }, (_, i) => ({ start: grid.margin + i * (size + grid.gutter), size }))
}

/**
 * 方眼の線の位置。0 から length までの size 間隔のうち、from〜to に入るもの（省けば全部）。本数は上限まで
 */
export function gridSteps(size: number, length: number, from = 0, to = length): number[] {
  const first = Math.max(0, Math.ceil(from / size - 1e-9))
  const last = Math.min(Math.floor(length / size + 1e-9), Math.floor(to / size + 1e-9))
  const steps: number[] = []
  for (let i = first; i <= last && steps.length < MAX_GRID_LINES; i++) steps.push(i * size)
  return steps
}

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

/** 見えているか（自分と先祖が全部 visible） */
function shown(scene: Scene, id: NodeId): boolean {
  for (let current: NodeId | null = id; current !== null; current = scene.nodes[current].parentId) {
    if (!scene.nodes[current].visible) return false
  }
  return true
}

/** 矩形 a と b が重なるか */
function overlaps(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** ページ座標で、行列 matrix の座標系の矩形 (0, 0, size) の四隅をなぞる（クリップに使う） */
function traceRect(ctx: CanvasRenderingContext2D, matrix: Matrix, size: Size) {
  const corners = [
    { x: 0, y: 0 },
    { x: size.width, y: 0 },
    { x: size.width, y: size.height },
    { x: 0, y: size.height },
  ].map((point) => applyMatrix(matrix, point))
  ctx.moveTo(corners[0].x, corners[0].y)
  for (const corner of corners.slice(1)) ctx.lineTo(corner.x, corner.y)
  ctx.closePath()
}

const BAND_FILL = 'rgba(255, 66, 66, 0.1)'
const GRID_LINE = 'rgba(255, 66, 66, 0.28)'

/**
 * レイアウトグリッドを持つ、見えているフレーム全部に、グリッドを重ねて描く（フレームが回っていればその向きのまま）。
 * 画面に入らないフレームは飛ばし、方眼の線は見えている範囲だけ引く。先祖の「はみ出した中身を隠す」フレームの外には描かない。
 * size は画面の大きさ（CSS ピクセル）
 */
export function drawLayoutGrids(ctx: CanvasRenderingContext2D, viewport: Viewport, size: Size, scene: Scene) {
  const view = { x: viewport.x, y: viewport.y, width: size.width / viewport.zoom, height: size.height / viewport.zoom }
  for (const node of Object.values(scene.nodes)) {
    // ブーリアン演算のノードは子を描かない形なので、グリッドも出さない
    if (node.type !== 'frame' || node.layoutGrids.length === 0 || node.booleanOperation !== null || !shown(scene, node.id)) continue
    const matrix = getWorldMatrix(scene, node.id)
    if (!overlaps(transformRect(matrix, { x: 0, y: 0, width: node.width, height: node.height }), view)) continue
    // 見えている範囲（フレームの座標）
    const visible = transformRect(invert(matrix), view)
    ctx.save()
    // 画面 = (ページ - viewport) × zoom
    ctx.scale(viewport.zoom, viewport.zoom)
    ctx.translate(-viewport.x, -viewport.y)
    // 先祖の、はみ出した中身を隠すフレームの枠と、自分の枠で切る（ページ座標でなぞる）
    for (let current: NodeId | null = node.id; current !== null; current = scene.nodes[current].parentId) {
      const clipper = scene.nodes[current]
      if (current !== node.id && (clipper.type !== 'frame' || !clipper.clipContent)) continue
      ctx.beginPath()
      traceRect(ctx, getWorldMatrix(scene, current), clipper)
      ctx.clip()
    }
    ctx.transform(...matrix)
    for (const grid of node.layoutGrids) {
      if (grid.type === 'grid') {
        // 画面で 3 ピクセルより細かい方眼は描かない（塗りつぶしたように見えるだけなので）
        if (grid.size * viewport.zoom < 3) continue
        // 線は拡大しても 1 ピクセル
        ctx.lineWidth = 1 / viewport.zoom
        ctx.strokeStyle = GRID_LINE
        ctx.beginPath()
        for (const x of gridSteps(grid.size, node.width, visible.x, visible.x + visible.width)) {
          ctx.moveTo(x, 0)
          ctx.lineTo(x, node.height)
        }
        for (const y of gridSteps(grid.size, node.height, visible.y, visible.y + visible.height)) {
          ctx.moveTo(0, y)
          ctx.lineTo(node.width, y)
        }
        ctx.stroke()
        continue
      }
      ctx.fillStyle = BAND_FILL
      const columns = grid.type === 'columns'
      for (const band of gridBands(grid, columns ? node.width : node.height)) {
        if (columns) ctx.fillRect(band.start, 0, band.size, node.height)
        else ctx.fillRect(0, band.start, node.width, band.size)
      }
    }
    ctx.restore()
  }
}
