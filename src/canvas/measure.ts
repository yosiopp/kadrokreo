import type { Size } from '../document/geometry.ts'
import { FRAME_LABEL_FONT } from './labels.ts'
import { type FontStyle, type TextStyle, fontMetrics, measureText } from './text.ts'

// 文字の幅を測る。測るためだけのキャンバスを 1 つ持つ（ブラウザでしか使えない）

let shared: CanvasRenderingContext2D | null = null

function context(): CanvasRenderingContext2D {
  shared ??= document.createElement('canvas').getContext('2d')!
  return shared
}

/** テキストの中身を収めるのに要る大きさ */
export function measureTextNode(style: TextStyle): Size {
  return measureText(context(), style)
}

/** フォントの上下の高さ（SVG の取り込みで、基線からテキストの枠の上端を求める） */
export function measureFontMetrics(style: FontStyle): { ascent: number; descent: number } {
  return fontMetrics(context(), style)
}

/** フレームの名前ラベルの幅（画面ピクセル）。ラベルの当たり判定に使う */
export function measureFrameLabel(text: string): number {
  const ctx = context()
  ctx.font = FRAME_LABEL_FONT
  return ctx.measureText(text).width
}
