import { measureTextNode } from '../canvas/measure.ts'
import type { NodeId, Scene } from '../document/types.ts'
import { patchNodes } from './operations.ts'

/** テキストノードの大きさを中身に合わせ直す。文字やフォントを変えた後に呼ぶ */
export function fitTextNodes<T extends Scene>(scene: T, ids: readonly NodeId[]): T {
  return patchNodes(scene, ids, (node) => (node.type === 'text' ? measureTextNode(node) : null))
}
