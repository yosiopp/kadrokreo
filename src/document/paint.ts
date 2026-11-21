import type { Point, Size } from './geometry.ts'
import type { LinearGradient, Paint, Style } from './types.ts'

// 塗り（Paint）の配列を読む関数。配列は先頭が一番下なので、いちばん上に見えるのは最後の要素

/** いちばん上の塗り。なければ null */
export function topPaint(paints: readonly Paint[]): Paint | null {
  return paints.length === 0 ? null : paints[paints.length - 1]
}

/** いちばん上の塗りが単色ならその色。グラデーションや塗りなしなら null */
export function solidColor(paints: readonly Paint[]): string | null {
  const paint = topPaint(paints)
  return paint?.type === 'solid' ? paint.color : null
}

/** 塗りの代表の色。単色ならその色、グラデーションなら最初の色 */
export function paintColor(paint: Paint): string {
  return paint.type === 'solid' ? paint.color : paint.stops[0].color
}

/** 単色 1 つだけの塗り。色が null なら塗りなし */
export function solid(color: string | null): Paint[] {
  return color === null ? [] : [{ type: 'solid', color }]
}

/** 線を引くか（線の塗りがあり、太さが 0 でない） */
export function hasStroke(style: Pick<Style, 'strokes' | 'strokeWidth'>): boolean {
  return style.strokes.length > 0 && style.strokeWidth > 0
}

/**
 * 直線状のグラデーションの始まりと終わりの点（ノードの座標系）。枠の中心を通る angle の向きの線で、
 * 長さは枠の角がちょうど両端の色になる長さ。描画（canvas）と SVG の出力で同じ線にする
 */
export function gradientLine(paint: LinearGradient, size: Size): [Point, Point] {
  const radians = (paint.angle * Math.PI) / 180
  const dx = Math.cos(radians)
  const dy = Math.sin(radians)
  const half = (Math.abs(size.width * dx) + Math.abs(size.height * dy)) / 2
  const cx = size.width / 2
  const cy = size.height / 2
  return [
    { x: cx - dx * half, y: cy - dy * half },
    { x: cx + dx * half, y: cy + dy * half },
  ]
}
