import { nodeMatrix, tidy, transformRect } from '../document/geometry.ts'
import { followsConstraints } from '../document/autoLayout.ts'
import type { Constraint, FrameNode, NodeId, Scene, SceneNode } from '../document/types.ts'
import { type NodePatch, patchNodes } from './operations/tree.ts'
import { nodeChangesSince } from '../document/nodeChanges.ts'

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
  const resizedFrame = (id: NodeId): [FrameNode, FrameNode] | null => {
    const node = current.nodes[id]
    const previous = before.nodes[id]
    if (node?.type !== 'frame' || previous?.type !== 'frame') return null
    return previous.width !== node.width || previous.height !== node.height ? [previous, node] : null
  }
  const changed = nodeChangesSince(before.nodes, after.nodes)
  if (!changed) {
    // 変わったノードが分からなければ、全部のフレームを上から見る
    const visit = (ids: readonly NodeId[]) => {
      for (const id of ids) {
        if (current.nodes[id].type !== 'frame') continue
        const pair = resizedFrame(id)
        if (pair) current = followParent(before, after, current, pair[0], pair[1], resized)
        visit((current.nodes[id] as FrameNode).children)
      }
    }
    visit(after.rootIds)
    return current
  }
  // 大きさが変わりうるのは、変えたノードと、追従して大きさが変わった子だけ。親から先に（子は親に追従してから比べる）
  const done = new Set<NodeId>()
  const follow = (id: NodeId) => {
    if (done.has(id)) return
    done.add(id)
    const pair = resizedFrame(id)
    if (!pair) return
    current = followParent(before, after, current, pair[0], pair[1], resized)
    for (const child of (current.nodes[id] as FrameNode).children) follow(child)
  }
  const starts = [...changed].filter((id) => resizedFrame(id) !== null)
  const depth = (id: NodeId) => {
    let count = 0
    for (let parent = after.nodes[id].parentId; parent !== null; parent = after.nodes[parent].parentId) count++
    return count
  }
  for (const id of starts.map((id) => [depth(id), id] as const).sort((a, b) => a[0] - b[0])) follow(id[1])
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
  // ブーリアン演算のノードの子は、追従のしかたによらず一緒に拡大・縮小する（結果の形がノードの大きさに合うように。既存のデザインツールと同じ）
  const boolean = frame.booleanOperation !== null
  const targets = frame.children.filter((childId) => {
    const child = after.nodes[childId]
    return (
      previous.children.includes(childId) &&
      before.nodes[childId] === child &&
      followsConstraints(frame, child) &&
      (boolean || child.constraints.horizontal !== 'start' || child.constraints.vertical !== 'start')
    )
  })
  if (targets.length === 0) return current
  return patchNodes(current, targets, (original) => {
    const child: SceneNode = boolean ? { ...original, constraints: { horizontal: 'scale', vertical: 'scale' } } : original
    if (child.rotation !== 0) return followRotated(child, previous, frame, resized)
    const horizontal = constrain(child.constraints.horizontal, child.x, child.width, previous.width, frame.width)
    const vertical = constrain(child.constraints.vertical, child.y, child.height, previous.height, frame.height)
    const patch: NodePatch = { x: tidy(horizontal.start), y: tidy(vertical.start) }
    return resizePatch(child, patch, tidy(horizontal.size), tidy(vertical.size), resized)
  })
}

/** 大きさが変わる向きの書き換えを patch に足す。テキストの高さは中身で決まるので変えない */
function resizePatch(child: SceneNode, patch: NodePatch, width: number, height: number, resized: NodeId[]): NodePatch {
  if (child.type === 'text') height = child.height
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
}

/** 回した図形を囲む矩形（親の座標系） */
function boundingBox(node: Pick<SceneNode, 'x' | 'y' | 'width' | 'height' | 'rotation'>) {
  return transformRect(nodeMatrix(node), { x: 0, y: 0, width: node.width, height: node.height })
}

/**
 * 回した子の追従。親の辺からの距離や割合は、見た目どおり、回した図形を囲む矩形で測る（既存のデザインツールと同じ）。
 * 囲む矩形の大きさが変わる（左右・上下・拡大縮小）ときは、囲む矩形がその大きさになる枠の幅・高さを解き、
 * 解けない角度（45° 付近）や、テキスト（高さが中身で決まる）では、縦横比を保って拡大縮小する・大きさを保つ。
 * どの場合も、囲む矩形の中心を、追従したあとの囲む矩形の中心に合わせる
 */
export function followRotated(child: SceneNode, previous: FrameNode, frame: FrameNode, resized: NodeId[] = []): NodePatch {
  const box = boundingBox(child)
  const horizontal = constrain(child.constraints.horizontal, box.x, box.width, previous.width, frame.width)
  const vertical = constrain(child.constraints.vertical, box.y, box.height, previous.height, frame.height)
  const size = rotatedSize(child, box, horizontal.size, vertical.size)
  const width = tidy(size.width)
  const height = child.type === 'text' ? child.height : tidy(size.height)
  // 新しい大きさで、x / y はそのままにしたときの囲む矩形から、中心のずれを直す
  const moved = boundingBox({ ...child, width, height })
  const patch: NodePatch = {
    x: tidy(child.x + horizontal.start + horizontal.size / 2 - (moved.x + moved.width / 2)),
    y: tidy(child.y + vertical.start + vertical.size / 2 - (moved.y + moved.height / 2)),
  }
  return resizePatch(child, patch, width, height, resized)
}

/** 囲む矩形を boxWidth × boxHeight にする、回した枠の幅・高さ */
function rotatedSize(
  child: SceneNode,
  box: { width: number; height: number },
  boxWidth: number,
  boxHeight: number,
): { width: number; height: number } {
  if (Math.abs(boxWidth - box.width) < 1e-9 && Math.abs(boxHeight - box.height) < 1e-9) return child
  // テキストは高さが中身で決まるので、大きさを保つ（位置だけ追従する）
  if (child.type === 'text') return child
  const radians = (child.rotation * Math.PI) / 180
  const c = Math.abs(Math.cos(radians))
  const s = Math.abs(Math.sin(radians))
  // 囲む矩形の幅 = c·w + s·h、高さ = s·w + c·h を w・h について解く
  const det = c * c - s * s
  if (Math.abs(det) > 0.2) {
    const width = (c * boxWidth - s * boxHeight) / det
    const height = (c * boxHeight - s * boxWidth) / det
    if (width >= 1 && height >= 1) return { width, height }
  }
  // 解けなければ縦横比を保つ。両方の向きが変わるなら、割合の相乗平均
  const rx = box.width === 0 ? 1 : boxWidth / box.width
  const ry = box.height === 0 ? 1 : boxHeight / box.height
  const changedX = Math.abs(rx - 1) > 1e-9
  const changedY = Math.abs(ry - 1) > 1e-9
  const ratio = changedX && changedY ? Math.sqrt(rx * ry) : changedX ? rx : ry
  return { width: Math.max(1, child.width * ratio), height: Math.max(1, child.height * ratio) }
}
