import { tidy } from '../document/geometry.ts'
import { followsConstraints } from '../document/autoLayout.ts'
import type { Constraint, FrameNode, NodeId, Scene } from '../document/types.ts'
import { type NodePatch, patchNodes } from './operations.ts'

// 親のフレームの大きさが変わったときに、子を親の辺に追従させる（既存のデザインツールの constraints）。
// 効くのは、親が自動で並べないフレームの子と、自動で並べるフレームの並びから外した子。
// ストアが変更のたびに、変更の前と後を比べて当てる（どの操作で大きさが変わったかを気にしなくてよい）。

/**
 * 1 つの向きの、追従したあとの位置と大きさ。from / to は親の大きさ、start / size は子の位置と大きさ。
 * 伸縮しても 1 より小さくはしない
 */
export function constrain(
  constraint: Constraint,
  start: number,
  size: number,
  from: number,
  to: number,
): { start: number; size: number } {
  const delta = to - from
  switch (constraint) {
    case 'start':
      return { start, size }
    case 'end':
      return { start: start + delta, size }
    case 'center':
      return { start: start + delta / 2, size }
    case 'stretch':
      return { start, size: Math.max(1, size + delta) }
    case 'scale': {
      const ratio = from === 0 ? 1 : to / from
      return { start: start * ratio, size: Math.max(1, size * ratio) }
    }
  }
}

/**
 * before から after への変更で大きさが変わったフレームの子を、追従のしかたに従って動かす。
 * 動かすのは、変更の前からその親にいて、この変更で自分では変わっていない子だけ
 * （利用者が一緒に動かした子や、新しく入れた子はそのまま）。追従して大きさが変わったフレームの子も、続けて追従する。
 * テキストの幅を変えると折り返しにするので、高さの測り直しが要る。測り直したテキストの id を resized に入れる
 */
export function applyConstraints<T extends Scene>(before: Scene, after: T, resized: NodeId[] = []): T {
  if (before === after) return after
  let current = after
  const visit = (ids: readonly NodeId[]) => {
    for (const id of ids) {
      const node = current.nodes[id]
      if (node.type !== 'frame') continue
      const previous = before.nodes[id]
      if (previous?.type === 'frame' && (previous.width !== node.width || previous.height !== node.height)) {
        current = followParent(before, after, current, previous, node, resized)
      }
      visit((current.nodes[id] as FrameNode).children)
    }
  }
  visit(after.rootIds)
  return current
}

function followParent<T extends Scene>(
  before: Scene,
  after: T,
  current: T,
  previous: FrameNode,
  frame: FrameNode,
  resized: NodeId[],
): T {
  const targets = frame.children.filter((childId) => {
    const child = after.nodes[childId]
    return (
      previous.children.includes(childId) &&
      before.nodes[childId] === child &&
      followsConstraints(frame, child) &&
      (child.constraints.horizontal !== 'start' || child.constraints.vertical !== 'start')
    )
  })
  if (targets.length === 0) return current
  return patchNodes(current, targets, (child) => {
    const horizontal = constrain(child.constraints.horizontal, child.x, child.width, previous.width, frame.width)
    const vertical = constrain(child.constraints.vertical, child.y, child.height, previous.height, frame.height)
    const patch: NodePatch = { x: tidy(horizontal.start), y: tidy(vertical.start) }
    const width = tidy(horizontal.size)
    // テキストの高さは中身で決まる
    const height = child.type === 'text' ? child.height : tidy(vertical.size)
    if (width !== child.width) {
      patch.width = width
      // 中身に合わせていた向きを伸縮したら固定にする（そうしないと中身の大きさへ戻る）
      if (child.sizing.width === 'hug') patch.sizing = { ...child.sizing, width: 'fixed' }
      if (child.type === 'text') resized.push(child.id)
    }
    if (height !== child.height) {
      patch.height = height
      if (child.sizing.height === 'hug') patch.sizing = { ...(patch.sizing ?? child.sizing), height: 'fixed' }
    }
    return patch
  })
}
