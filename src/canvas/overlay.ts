import { isComponentPart } from '../document/component.ts'
import type { Point } from '../document/geometry.ts'
import type { NodeId, Scene } from '../document/types.ts'

// ドキュメントの上に重ねて描くもの（選択枠、大きさの札など）の部品。座標はどれも画面ピクセル。
// editor の選択枠と、viewer のインスペクトが同じ見た目になるよう、ここにまとめてある。

/** 選択枠の色 */
export const OVERLAY_ACCENT = '#0d99ff'
/** コンポーネント（元・インスタンス・その中身）の選択枠やフレームの名前の色 */
export const OVERLAY_COMPONENT = '#9747ff'

/** ids の枠を描く色。どれもコンポーネントのものなら紫、そうでなければ青 */
export function overlayColor(scene: Scene, ids: readonly NodeId[]): string {
  return ids.length > 0 && ids.every((id) => isComponentPart(scene, id)) ? OVERLAY_COMPONENT : OVERLAY_ACCENT
}

/** スナップのガイドや、間隔の計測の色 */
export const OVERLAY_GUIDE = '#f24822'

/** 点をつないだ線を引く。線がにじまないよう、ピクセルの中心に合わせる */
export function strokePolyline(ctx: CanvasRenderingContext2D, points: readonly Point[], close: boolean): void {
  ctx.beginPath()
  for (const [index, point] of points.entries()) {
    const x = Math.round(point.x) + 0.5
    const y = Math.round(point.y) + 0.5
    if (index === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  if (close) ctx.closePath()
  ctx.stroke()
}

const BADGE_HEIGHT = 18

/** 色つきの札に、白い文字で text を入れる。center は札の中心 */
export function drawBadge(ctx: CanvasRenderingContext2D, text: string, center: Point, color: string): void {
  ctx.font = '11px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const width = ctx.measureText(text).width + 10
  ctx.fillStyle = color
  ctx.beginPath()
  const left = Math.round(center.x - width / 2)
  const top = Math.round(center.y - BADGE_HEIGHT / 2)
  ctx.roundRect(left, top, width, BADGE_HEIGHT, 4)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.fillText(text, Math.round(center.x), Math.round(center.y) + 0.5)
}
