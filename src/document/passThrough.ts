import type { Bounds } from './geometry.ts'
import { isMaskNode } from './mask.ts'
import { type TextLinesOf, blurRadius, getPaintedBounds, hasStroke, isShadow, withoutHidden } from './paint.ts'
import type { Scene, SceneNode } from './types.ts'

// フレームの通過（pass through）を、SVG・CSS の書き出しでどう書くか。
// 描画（canvas/render.ts）は、半透明の通過のフレームを「後ろ × (1 − 不透明度) + 後ろに子をそのまま混ぜた絵 × 不透明度」で描く。
// SVG の g・CSS の要素の opacity は中身をまとめてから混ぜる（子の描画モードは後ろに届かず、子どうしの重なりも透けない）ので、そのままでは書けない。
// ただし、子が 1 枚の絵として描かれ、互いに重ならず、フレーム自身が何も描かなければ、どの点でも混ざるのは「後ろ」と「子 1 つ」だけになる。
// そのときは、フレームの不透明度を子に配る（子の opacity に掛ける）と描画と同じ式になる
// （子の描画モードが X なら、子の位置は 後ろ × (1 − a) + X(後ろ, 子) × a）。

/** 描画が通過として描くフレームか（不透明なら、まとめずに描くふつうの道と同じ見た目なので含めない。レイヤーのぼかしがあれば 1 枚の絵にまとめる） */
export function isPassThroughFrame(node: SceneNode): boolean {
  return (
    node.type === 'frame' && node.passThrough && node.blendMode === 'normal' && node.opacity < 1 && node.children.length > 0 &&
    blurRadius(withoutHidden(node).effects, 'layer-blur') === 0
  )
}

/**
 * 通過のフレームの不透明度を子に配れるなら、その不透明度（子の opacity に掛ける値）。配れなければ null（通過のフレームでないときも）。
 * 配れるのは、フレームが塗り・線・影を持たず、描く子（マスクは不可）がどれも 1 枚の絵で、描かれる範囲が互いに重ならないとき
 */
export function passThroughFade(scene: Scene, node: SceneNode, textLines?: TextLinesOf): number | null {
  if (node.type !== 'frame' || !isPassThroughFrame(node)) return null
  const shown = withoutHidden(node)
  if (shown.fills.length > 0 || hasStroke(shown) || shown.effects.some(isShadow)) return null
  if (node.children.some((id) => !Object.hasOwn(scene.nodes, id))) return null
  const drawn = node.children.map((id) => scene.nodes[id]).filter((child) => child.visible && child.opacity > 0)
  if (drawn.some((child) => isMaskNode(child) || !isOneLayer(scene, child, textLines))) return null
  const boxes = drawn.flatMap((child) => getPaintedBounds(scene, [child.id], textLines) ?? [])
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) if (overlaps(boxes[i], boxes[j])) return null
  }
  return node.opacity
}

/**
 * 1 枚の絵として後ろに混ざるか。図形は 1 枚。フレームは、中身をまとめて描くもの（半透明・描画モード・レイヤーのぼかし）、
 * 子のないもの、子に不透明度を配れる通過のフレーム
 */
function isOneLayer(scene: Scene, node: SceneNode, textLines?: TextLinesOf): boolean {
  if (node.type !== 'frame' || node.children.length === 0) return true
  if (isPassThroughFrame(node)) return passThroughFade(scene, node, textLines) !== null
  return node.opacity < 1 || node.blendMode !== 'normal' || blurRadius(withoutHidden(node).effects, 'layer-blur') > 0
}

function overlaps(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}
