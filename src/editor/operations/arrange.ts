import { getAbsoluteBounds, getWorldRotation, unionBounds } from '../../document/geometry.ts'
import type { NodeId, Scene } from '../../document/types.ts'
import { shifted } from './transform.ts'
import {
  type NodePatch,
  isSelfOrAncestor,
  moveNode,
  patchNodes,
  siblingsOf,
  sortByDocumentOrder,
  topLevelIds,
} from './tree.ts'

// 整列・等間隔・重なり順の変更

export type Alignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'

/** 複数なら選択範囲に、1 つなら親フレームに揃える */
export function alignNodes<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  alignment: Alignment,
): T {
  const targets = topLevelIds(scene, ids)
  const single = targets.length === 1 ? scene.nodes[targets[0]] : null
  const reference = single
    ? single.parentId === null
      ? null
      : getAbsoluteBounds(scene, single.parentId)
    : unionBounds(targets.map((id) => getAbsoluteBounds(scene, id)))
  if (!reference) return scene

  return patchNodes(scene, targets, ({ id }) => {
    const abs = getAbsoluteBounds(scene, id)
    const offsets: Record<Alignment, [number, number]> = {
      left: [reference.x - abs.x, 0],
      center: [reference.x + (reference.width - abs.width) / 2 - abs.x, 0],
      right: [reference.x + reference.width - abs.width - abs.x, 0],
      top: [0, reference.y - abs.y],
      middle: [0, reference.y + (reference.height - abs.height) / 2 - abs.y],
      bottom: [0, reference.y + reference.height - abs.height - abs.y],
    }
    const [dx, dy] = offsets[alignment]
    const position = shifted(scene, id, dx, dy)
    // 回っていなければ、これまでどおり整数の位置に置く
    if (getWorldRotation(scene, id) !== 0) return position
    return { x: Math.round(position.x), y: Math.round(position.y) }
  })
}

/** 両端の位置は変えずに、間隔が等しくなるよう並べ直す。3 つ以上で意味がある */
export function distributeNodes<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  axis: 'x' | 'y',
): T {
  const size = axis === 'x' ? 'width' : 'height'
  const items = topLevelIds(scene, ids)
    .map((id) => ({ id, bounds: getAbsoluteBounds(scene, id) }))
    .sort((a, b) => a.bounds[axis] - b.bounds[axis])
  if (items.length < 3) return scene

  const first = items[0].bounds
  const last = items[items.length - 1].bounds
  const occupied = items.reduce((sum, item) => sum + item.bounds[size], 0)
  const gap = (last[axis] + last[size] - first[axis] - occupied) / (items.length - 1)

  let position = first[axis]
  const patches = new Map<NodeId, NodePatch>()
  for (const { id, bounds } of items) {
    const delta = Math.round(position - bounds[axis])
    position += bounds[size] + gap
    patches.set(id, shifted(scene, id, axis === 'x' ? delta : 0, axis === 'y' ? delta : 0))
  }
  return patchNodes(scene, patches.keys(), (node) => patches.get(node.id) ?? null)
}

export type Placement = 'above' | 'below' | 'inside'

/** レイヤーパネルでのドロップ。target のすぐ手前・すぐ奥・中（最前面）へ、互いの重なり順を保って移す */
export function placeNodes<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  targetId: NodeId,
  placement: Placement,
): T {
  const target = scene.nodes[targetId]
  if (!target || (placement === 'inside' && target.type !== 'frame')) return scene
  const moving = sortByDocumentOrder(scene, topLevelIds(scene, ids))
  if (moving.some((id) => isSelfOrAncestor(scene, id, targetId))) return scene

  if (placement === 'inside') {
    return moving.reduce((next, id) => moveNode(next, id, targetId), scene)
  }
  // 同じ位置へ順に差し込むので、手前に置くときは前面のものから入れると順序が保たれる
  const order = placement === 'above' ? moving.toReversed() : moving
  return order.reduce((next, id) => {
    const siblings = siblingsOf(next, target.parentId).filter((other) => other !== id)
    const index = siblings.indexOf(targetId) + (placement === 'above' ? 1 : 0)
    return moveNode(next, id, target.parentId, index)
  }, scene)
}

export type ReorderDirection = 'front' | 'back' | 'forward' | 'backward'

export function reorderNodes<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  direction: ReorderDirection,
): T {
  const moving = sortByDocumentOrder(scene, topLevelIds(scene, ids))
  if (direction === 'front') {
    return moving.reduce((next, id) => moveNode(next, id, next.nodes[id].parentId), scene)
  }
  if (direction === 'back') {
    return moving.toReversed().reduce((next, id) => moveNode(next, id, next.nodes[id].parentId, 0), scene)
  }

  const step = direction === 'forward' ? 1 : -1
  // 進む向きの先頭にいるものから動かすと、複数選択でも互いを追い越さない
  const order = step === 1 ? moving.toReversed() : moving
  const settled = new Set<NodeId>()
  return order.reduce((next, id) => {
    const parentId = next.nodes[id].parentId
    const siblings = siblingsOf(next, parentId)
    const index = siblings.indexOf(id)
    const neighbor = siblings[index + step]
    settled.add(id)
    // すでに端にいる、または先に動かした選択中のノードに突き当たったら止まる
    if (neighbor === undefined || settled.has(neighbor)) return next
    return moveNode(next, id, parentId, index + step)
  }, scene)
}
