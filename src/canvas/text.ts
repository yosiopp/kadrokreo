import type { Size } from '../document/geometry.ts'
import type { TextNode } from '../document/types.ts'

export const LINE_HEIGHT = 1.2

type TextStyle = Pick<TextNode, 'fontSize' | 'fontFamily'>

export function applyFont(ctx: CanvasRenderingContext2D, style: TextStyle): void {
  // fontFamily が不正だと代入ごと無視されるので、先にサイズだけ確実に反映しておく
  ctx.font = `${style.fontSize}px sans-serif`
  ctx.font = `${style.fontSize}px ${style.fontFamily}`
}

/** テキストは折り返さず、改行だけで行を分ける */
export function measureText(
  ctx: CanvasRenderingContext2D,
  style: TextStyle & Pick<TextNode, 'text'>,
): Size {
  applyFont(ctx, style)
  const lines = style.text.split('\n')
  const width = Math.max(...lines.map((line) => ctx.measureText(line).width))
  return {
    width: Math.max(1, Math.ceil(width)),
    height: Math.ceil(lines.length * style.fontSize * LINE_HEIGHT),
  }
}
