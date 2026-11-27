import { OVERLAY_ACCENT } from '../../canvas/overlay.ts'
import { GUIDE_COLOR } from '../../canvas/guideOverlay.ts'
import { type Viewport, worldToScreen } from '../../canvas/viewport.ts'
import type { Bounds, Point, Size } from '../../document/geometry.ts'

// キャンバスの上と左に重ねて描く目盛り（ルーラー）。目盛りの値はページ座標。
// キャンバスの色はテーマによらず同じなので、ルーラーの色も固定にする

/** ルーラーの帯の太さ（画面ピクセル） */
export const RULER_SIZE = 20
/** 目盛りの数字の間隔の、画面上の最小の幅（ピクセル） */
const MIN_LABEL_GAP = 60

const RULER_BG = 'rgba(250, 250, 251, 0.96)'
const RULER_LINE = '#c4c7cf'
const RULER_TEXT = '#6b7280'
/** 選んでいるものの範囲を示す帯 */
const RULER_RANGE = 'rgba(13, 153, 255, 0.16)'

/** 画面上で minGap ピクセル以上になる、1・2・5 × 10 の累乗の間隔（ページ座標） */
export function rulerStep(zoom: number, minGap = MIN_LABEL_GAP): number {
  const raw = minGap / zoom
  const power = 10 ** Math.floor(Math.log10(raw))
  for (const factor of [1, 2, 5, 10]) {
    if (power * factor >= raw - 1e-9) return power * factor
  }
  return power * 10
}

/** from〜to（ページ座標）に入る、step の倍数の値 */
export function rulerTicks(from: number, to: number, step: number): number[] {
  const ticks: number[] = []
  for (let i = Math.ceil(from / step); i * step <= to; i++) ticks.push(i * step)
  return ticks
}

/** 目盛りの数字。小さな間隔の端数は、間隔に合わせた桁で丸める（0.1 + 0.2 のような誤差を出さない） */
export function rulerLabel(value: number, step: number): string {
  const digits = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)))
  const text = value.toFixed(digits)
  return text === '-0' ? '0' : text
}

/** ガイド線を離すと消える所か。ルーラーの上と、それより外（キャンバスの上・左の外。ポインタをキャプチャしているので届く） */
export function inGuideTrash(screen: Point): boolean {
  return screen.x < RULER_SIZE || screen.y < RULER_SIZE
}

/** 画面座標 screen がどちらのルーラーの上か（角は上のルーラーとして扱う） */
export function rulerAt(screen: Point): 'top' | 'left' | null {
  if (screen.y >= 0 && screen.y < RULER_SIZE && screen.x >= 0) return 'top'
  if (screen.x >= 0 && screen.x < RULER_SIZE && screen.y >= 0) return 'left'
  return null
}

/** ルーラーを描く。range は選んでいるものの範囲（ページ座標）で、目盛りの上に色の帯で示す */
export function drawRulers(ctx: CanvasRenderingContext2D, viewport: Viewport, size: Size, range: Bounds | null) {
  const step = rulerStep(viewport.zoom)
  // 数字の間を 10 に分けた短い目盛り。詰まりすぎるときは 5 つに分ける
  const minor = step * viewport.zoom >= 80 ? step / 10 : step / 5
  const origin = worldToScreen(viewport, { x: 0, y: 0 })

  ctx.save()
  ctx.fillStyle = RULER_BG
  ctx.fillRect(0, 0, size.width, RULER_SIZE)
  ctx.fillRect(0, RULER_SIZE, RULER_SIZE, size.height - RULER_SIZE)

  if (range) {
    const from = worldToScreen(viewport, range)
    const x0 = Math.max(RULER_SIZE, from.x)
    const x1 = Math.min(size.width, from.x + Math.max(1, range.width * viewport.zoom))
    const y0 = Math.max(RULER_SIZE, from.y)
    const y1 = Math.min(size.height, from.y + Math.max(1, range.height * viewport.zoom))
    ctx.fillStyle = RULER_RANGE
    if (x1 > x0) ctx.fillRect(x0, 0, x1 - x0, RULER_SIZE)
    if (y1 > y0) ctx.fillRect(0, y0, RULER_SIZE, y1 - y0)
  }

  ctx.strokeStyle = RULER_LINE
  ctx.lineWidth = 1
  ctx.beginPath()
  // 帯とキャンバスの境目
  ctx.moveTo(0, RULER_SIZE - 0.5)
  ctx.lineTo(size.width, RULER_SIZE - 0.5)
  ctx.moveTo(RULER_SIZE - 0.5, 0)
  ctx.lineTo(RULER_SIZE - 0.5, size.height)

  const left = viewport.x
  const top = viewport.y
  const right = viewport.x + size.width / viewport.zoom
  const bottom = viewport.y + size.height / viewport.zoom
  for (const value of rulerTicks(left, right, minor)) {
    const x = Math.round((value - viewport.x) * viewport.zoom) + 0.5
    if (x < RULER_SIZE) continue
    const major = Math.abs(value / step - Math.round(value / step)) < 1e-6
    ctx.moveTo(x, major ? 0 : RULER_SIZE - 5)
    ctx.lineTo(x, RULER_SIZE)
  }
  for (const value of rulerTicks(top, bottom, minor)) {
    const y = Math.round((value - viewport.y) * viewport.zoom) + 0.5
    if (y < RULER_SIZE) continue
    const major = Math.abs(value / step - Math.round(value / step)) < 1e-6
    ctx.moveTo(major ? 0 : RULER_SIZE - 5, y)
    ctx.lineTo(RULER_SIZE, y)
  }
  ctx.stroke()

  ctx.fillStyle = RULER_TEXT
  ctx.font = '10px system-ui, sans-serif'
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  for (const value of rulerTicks(left, right, step)) {
    const x = Math.round((value - viewport.x) * viewport.zoom)
    if (x < RULER_SIZE) continue
    ctx.fillText(rulerLabel(value, step), x + 3, 3)
  }
  for (const value of rulerTicks(top, bottom, step)) {
    const y = Math.round((value - viewport.y) * viewport.zoom)
    if (y < RULER_SIZE) continue
    // 左のルーラーの数字は、縦に回して目盛りの下へ書く
    ctx.save()
    ctx.translate(3, y + 3)
    ctx.rotate(-Math.PI / 2)
    ctx.textAlign = 'right'
    ctx.fillText(rulerLabel(value, step), 0, 0)
    ctx.restore()
  }

  // 原点（ページの 0）の位置に、アクセント色の短い印
  ctx.fillStyle = OVERLAY_ACCENT
  if (origin.x >= RULER_SIZE && origin.x <= size.width) ctx.fillRect(Math.round(origin.x), RULER_SIZE - 3, 1, 3)
  if (origin.y >= RULER_SIZE && origin.y <= size.height) ctx.fillRect(RULER_SIZE - 3, Math.round(origin.y), 3, 1)

  // 角の四角
  ctx.fillStyle = RULER_BG
  ctx.fillRect(0, 0, RULER_SIZE - 1, RULER_SIZE - 1)
  ctx.restore()
}

/** 引き出している・動かしているガイド線の位置を、ルーラーの上に札で出す（ルーラーを描いたあとに呼ぶ） */
export function drawGuideLabel(ctx: CanvasRenderingContext2D, viewport: Viewport, guide: { axis: 'x' | 'y'; position: number }) {
  const text = rulerLabel(guide.position, 1)
  ctx.save()
  ctx.font = '10px system-ui, sans-serif'
  const width = ctx.measureText(text).width + 8
  const at = worldToScreen(viewport, { x: guide.position, y: guide.position })
  ctx.fillStyle = GUIDE_COLOR
  if (guide.axis === 'x') {
    const x = Math.round(at.x - width / 2)
    ctx.fillRect(x, 3, width, RULER_SIZE - 6)
    ctx.fillStyle = '#ffffff'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, x + 4, RULER_SIZE / 2)
  } else {
    const y = Math.round(at.y - width / 2)
    ctx.fillRect(3, y, RULER_SIZE - 6, width)
    ctx.fillStyle = '#ffffff'
    ctx.translate(RULER_SIZE / 2, y + width - 4)
    ctx.rotate(-Math.PI / 2)
    ctx.textBaseline = 'middle'
    ctx.fillText(text, 0, 0)
  }
  ctx.restore()
}
