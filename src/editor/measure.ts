import { FRAME_LABEL_FONT } from '../canvas/render.ts'
import { type TextStyle, measureText } from '../canvas/text.ts'
import type { Size } from '../document/geometry.ts'
import type { NodeId, Scene } from '../document/types.ts'
import { updateNode } from './operations.ts'

let shared: CanvasRenderingContext2D | null = null

function context(): CanvasRenderingContext2D {
  shared ??= document.createElement('canvas').getContext('2d')!
  return shared
}

export function measureTextNode(style: TextStyle): Size {
  return measureText(context(), style)
}

export function measureFrameLabel(text: string): number {
  const ctx = context()
  ctx.font = FRAME_LABEL_FONT
  return ctx.measureText(text).width
}

/** テキストノードの大きさを中身に合わせ直す。文字やフォントを変えた後に呼ぶ */
export function fitTextNodes<T extends Scene>(scene: T, ids: readonly NodeId[]): T {
  return ids.reduce((next, id) => {
    const node = next.nodes[id]
    return node?.type === 'text' ? updateNode(next, id, measureTextNode(node)) : next
  }, scene)
}
