import { type Bounds, type Point, type Size, normalizeAngle } from './geometry.ts'
import type { CornerRadius, Effect, ImageNode, LinearGradient, Paint, Style } from './types.ts'

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

/** グラデーションか（色の位置を持つか） */
export function isGradient(paint: Paint): paint is Exclude<Paint, { type: 'solid' }> {
  return paint.type !== 'solid'
}

/** 塗りの代表の色。単色ならその色、グラデーションなら最初の色 */
export function paintColor(paint: Paint): string {
  return paint.type === 'solid' ? paint.color : paint.stops[0].color
}

/** 単色 1 つだけの塗り。色が null なら塗りなし */
export function solid(color: string | null): Paint[] {
  return color === null ? [] : [{ type: 'solid', color, opacity: 1, visible: true }]
}

/** 線を引くか（表示している線の塗りがあり、太さが 0 でない） */
export function hasStroke(style: Pick<Style, 'strokes' | 'strokeWidth'>): boolean {
  return style.strokeWidth > 0 && style.strokes.some((stroke) => stroke.visible)
}

/** 表示している塗り・効果だけ。全部表示していれば同じ配列を返す */
export function shownPaints<T extends { visible: boolean }>(list: readonly T[]): T[] {
  return list.every((item) => item.visible) ? (list as T[]) : list.filter((item) => item.visible)
}

/**
 * 隠した塗り・線・効果（visible が false）を除いたノード。描画と各出力（CSS・SVG・色の一覧）は、これを通してから読む。
 * 何も隠していなければ同じオブジェクトを返す
 */
export function withoutHidden<T extends object>(node: T): T {
  const lists = node as { fills?: Paint[]; strokes?: Paint[]; effects?: Effect[] }
  const hidden = (list: readonly { visible: boolean }[] | undefined) => list !== undefined && list.some((item) => !item.visible)
  if (!hidden(lists.fills) && !hidden(lists.strokes) && !hidden(lists.effects)) return node
  const out: Record<string, unknown> = { ...(node as Record<string, unknown>) }
  for (const key of ['fills', 'strokes', 'effects'] as const) {
    const list = lists[key]
    if (list !== undefined) out[key] = shownPaints<{ visible: boolean }>(list)
  }
  return out as T
}

/** 落ち影と内側の影に分ける */
export function splitEffects(effects: readonly Effect[]): { drop: Effect[]; inner: Effect[] } {
  return {
    drop: effects.filter((effect) => effect.type === 'drop-shadow'),
    inner: effects.filter((effect) => effect.type === 'inner-shadow'),
  }
}

/** 直線状のグラデーションの始点と終点（ノードの座標系）。描画（canvas）と SVG の出力で同じ線にする */
export function gradientLine(paint: Pick<LinearGradient, 'x1' | 'y1' | 'x2' | 'y2'>, size: Size): [Point, Point] {
  return [
    { x: paint.x1 * size.width, y: paint.y1 * size.height },
    { x: paint.x2 * size.width, y: paint.y2 * size.height },
  ]
}

/**
 * 向き（度）だけを決めたときの、直線状のグラデーションの始点と終点（ノードの座標系）。枠の中心を通る angle の向きの線で、
 * 長さは枠の角がちょうど両端の色になる長さ（CSS の linear-gradient の角度と同じ線）
 */
export function angleLine(angle: number, size: Size): [Point, Point] {
  const radians = (angle * Math.PI) / 180
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

/** 向き（度）だけを決めた直線状のグラデーションの始点・終点（枠に対する割合）。幅や高さが 0 の向きは中央にする */
export function linearFromAngle(angle: number, size: Size): Pick<LinearGradient, 'x1' | 'y1' | 'x2' | 'y2'> {
  const [from, to] = angleLine(angle, size)
  const ratio = (value: number, length: number) => (length > 0 ? tidyRatio(value / length) : 0.5)
  return { x1: ratio(from.x, size.width), y1: ratio(from.y, size.height), x2: ratio(to.x, size.width), y2: ratio(to.y, size.height) }
}

/** 直線状のグラデーションの向き（度。-180 より大きく 180 以下）。始点と終点が重なっていれば 0 */
export function linearAngle(paint: Pick<LinearGradient, 'x1' | 'y1' | 'x2' | 'y2'>, size: Size): number {
  const [from, to] = gradientLine(paint, size)
  if (from.x === to.x && from.y === to.y) return 0
  return normalizeAngle(Math.round(((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI) * 100) / 100)
}

/** 始点・終点が、向きだけを決めたときの線（linearFromAngle）と同じか */
export function isAngleLine(paint: Pick<LinearGradient, 'x1' | 'y1' | 'x2' | 'y2'>, size: Size): boolean {
  const line = linearFromAngle(linearAngle(paint, size), size)
  return (['x1', 'y1', 'x2', 'y2'] as const).every((key) => Math.abs(line[key] - paint[key]) < 1e-3)
}

/** 割合を小数 6 桁に（計算の端数を残さない。向きに直したとき 0.01° もずれない桁） */
function tidyRatio(value: number): number {
  return Math.round(value * 1e6) / 1e6 + 0
}

/**
 * 画像を枠に置く矩形（ノードの座標系）。fit で決まる大きさを scale 倍し、余り（はみ出し）を positionX / positionY の割合で配る。
 * 枠からはみ出した分は描くときに切り落とす。描画（canvas）と CSS の object-view-box で同じ置き方にする
 */
export function imageRect(
  node: Pick<ImageNode, 'width' | 'height' | 'fit' | 'positionX' | 'positionY' | 'scale'>,
  image: Size,
): Bounds {
  const { width, height, fit, positionX, positionY, scale } = node
  let w = width
  let h = height
  if (fit !== 'stretch' && image.width > 0 && image.height > 0) {
    const ratio = (fit === 'cover' ? Math.max : Math.min)(width / image.width, height / image.height)
    w = image.width * ratio
    h = image.height * ratio
  }
  w *= scale
  h *= scale
  // + 0 で -0 を 0 にする
  return { x: (width - w) * positionX + 0, y: (height - h) * positionY + 0, width: w, height: h }
}

/** 角丸の 4 隅の半径（左上・右上・右下・左下） */
export function cornerRadii(radius: CornerRadius): [number, number, number, number] {
  return typeof radius === 'number' ? [radius, radius, radius, radius] : radius
}

/** 4 隅の半径を、揃っていれば数値 1 つにまとめる */
export function compactRadius(radii: readonly [number, number, number, number]): CornerRadius {
  return radii.every((r) => r === radii[0]) ? radii[0] : [...radii]
}

/** 角丸があるか（どれかの隅が 0 より大きい） */
export function isRounded(radius: CornerRadius): boolean {
  return cornerRadii(radius).some((r) => r > 0)
}
