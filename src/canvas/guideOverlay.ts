import type { Viewport } from './viewport.ts'
import { type Bounds, type Matrix, type Size, applyMatrix, getWorldMatrix, invert, transformRect } from '../document/geometry.ts'
import type { LayoutGrid, NodeId, PageGuide, Scene } from '../document/types.ts'

// ページのガイド線とフレームのレイアウトグリッドを、キャンバスに重ねて描く。editor と viewer で共有する。
// どれも補助の表示なので、描画（render.ts）や書き出しには入れない。座標は CanvasView の drawOverlay と同じ（画面ピクセル）

/**
 * 方眼の線を描く・吸着の相手にする本数の上限（向きごと）。線は見えている範囲（吸着なら動かしているものの近く）だけ作るので、
 * ふつうは届かない。細工したファイルで描画や吸着が止まらないための歯止め
 */
const MAX_GRID_LINES = 2000

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

/** ガイド線の色 */
export const GUIDE_COLOR = '#e8378b'

/** ページのガイド線を、キャンバスの端から端まで引く。active は引き出している・動かしているガイド線（editor。位置の札は editor が描く） */
export function drawGuides(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  size: Size,
  guides: readonly PageGuide[],
  active: { axis: 'x' | 'y'; position: number } | null,
) {
  ctx.save()
  ctx.strokeStyle = GUIDE_COLOR
  ctx.lineWidth = 1
  ctx.beginPath()
  for (const { axis, position } of active ? [...guides, active] : guides) {
    if (axis === 'x') {
      const x = Math.round((position - viewport.x) * viewport.zoom) + 0.5
      ctx.moveTo(x, 0)
      ctx.lineTo(x, size.height)
    } else {
      const y = Math.round((position - viewport.y) * viewport.zoom) + 0.5
      ctx.moveTo(0, y)
      ctx.lineTo(size.width, y)
    }
  }
  ctx.stroke()
  ctx.restore()
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
