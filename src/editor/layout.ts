import {
  type Bounds,
  type Point,
  getNodesBounds,
  nodeMatrix,
  tidy,
  toLocal,
  transformRect,
} from '../document/geometry.ts'
import type { AutoLayout, FrameNode, NodeId, Scene, SceneNode } from '../document/types.ts'
import { createFrame } from './nodes.ts'
import {
  type NodePatch,
  insertNode,
  moveNode,
  patchNodes,
  sortByDocumentOrder,
  topLevelIds,
  updateNode,
} from './operations.ts'

// オートレイアウト。フレームの子を children の順に並べ、必要ならフレームの大きさを中身に合わせる。
// 並べた結果は各ノードの x / y / width / height に書き込むので、描画や viewer はこの設定を知らなくてよい。
// ストアが、ページを変更するたびに relayout を通す。

/** 自動で並べるフレームをすべて並べ直す。何も動かなければ同じ参照を返す */
export function relayout<T extends Scene>(scene: T): T {
  // 子のフレームを先に並べる（中身に合わせた大きさが、親の並びに影響する）
  const frames: NodeId[] = []
  const visit = (ids: readonly NodeId[]) => {
    for (const id of ids) {
      const node = scene.nodes[id]
      if (node.type !== 'frame') continue
      visit(node.children)
      if (node.layout) frames.push(id)
    }
  }
  visit(scene.rootIds)
  return frames.reduce((next, id) => layoutFrame(next, id), scene)
}

/** 親の座標系で、子を囲む矩形。回っている子は、囲む矩形の大きさで場所を取る */
function boxOf(node: SceneNode): Bounds {
  return transformRect(nodeMatrix(node), { x: 0, y: 0, width: node.width, height: node.height })
}

/** フレームの子のうち、並べる対象になるもの。非表示の子は場所を取らない */
function visibleItems(scene: Scene, frame: FrameNode): { node: SceneNode; box: Bounds }[] {
  return frame.children
    .map((childId) => scene.nodes[childId])
    .filter((node) => node.visible)
    .map((node) => ({ node, box: boxOf(node) }))
}

function layoutFrame<T extends Scene>(scene: T, id: NodeId): T {
  const frame = scene.nodes[id]
  if (frame.type !== 'frame' || !frame.layout) return scene
  const { direction, gap, paddingX, paddingY, align, justify, widthMode, heightMode } = frame.layout
  const horizontal = direction === 'horizontal'
  // 並べる向き（main）と、それに直交する向き（cross）で考える
  const main = (size: { width: number; height: number }) => (horizontal ? size.width : size.height)
  const cross = (size: { width: number; height: number }) => (horizontal ? size.height : size.width)
  const padMain = horizontal ? paddingX : paddingY
  const padCross = horizontal ? paddingY : paddingX
  const hugMain = (horizontal ? widthMode : heightMode) === 'hug'
  const hugCross = (horizontal ? heightMode : widthMode) === 'hug'

  const items = visibleItems(scene, frame)
  const occupied = items.reduce((sum, item) => sum + main(item.box), 0)
  const contentMain = occupied + gap * Math.max(0, items.length - 1)
  const contentCross = Math.max(0, ...items.map((item) => cross(item.box)))
  const frameMain = hugMain ? contentMain + padMain * 2 : main(frame)
  const frameCross = hugCross ? contentCross + padCross * 2 : cross(frame)

  // 並べる向きに余った分を、寄せ方に従って配る
  const free = frameMain - padMain * 2 - contentMain
  let cursor = padMain
  let step = gap
  if (!hugMain) {
    if (justify === 'center') cursor += free / 2
    else if (justify === 'end') cursor += free
    else if (justify === 'space-between' && items.length > 1 && free > 0) {
      step += free / (items.length - 1)
    }
  }

  const patches = new Map<NodeId, NodePatch>()
  for (const { node, box } of items) {
    const crossAt =
      align === 'start'
        ? padCross
        : align === 'center'
          ? (frameCross - cross(box)) / 2
          : frameCross - padCross - cross(box)
    const target = horizontal ? { x: cursor, y: crossAt } : { x: crossAt, y: cursor }
    patches.set(node.id, {
      x: tidy(node.x + target.x - box.x),
      y: tidy(node.y + target.y - box.y),
    })
    cursor += main(box) + step
  }
  patches.set(id, {
    width: Math.max(1, tidy(horizontal ? frameMain : frameCross)),
    height: Math.max(1, tidy(horizontal ? frameCross : frameMain)),
  })
  return patchNodes(scene, patches.keys(), (node) => patches.get(node.id) ?? null)
}

const DEFAULT_LAYOUT: AutoLayout = {
  direction: 'horizontal',
  gap: 10,
  paddingX: 10,
  paddingY: 10,
  align: 'start',
  justify: 'start',
  widthMode: 'hug',
  heightMode: 'hug',
}

/**
 * フレームを自動で並べるようにする。見た目がなるべく変わらないよう、
 * いまの子の並び方から向き・順番・間隔・余白を決める。
 */
export function enableAutoLayout<T extends Scene>(scene: T, id: NodeId): T {
  const frame = scene.nodes[id]
  if (frame?.type !== 'frame' || frame.layout) return scene

  const items = visibleItems(scene, frame)
  if (items.length === 0) return updateNode(scene, id, { layout: DEFAULT_LAYOUT })

  // 子の中心が、横と縦のどちらに広がっているかで向きを決める
  const centers = items.map(({ box }) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 }))
  const spread = (axis: 'x' | 'y') =>
    Math.max(...centers.map((c) => c[axis])) - Math.min(...centers.map((c) => c[axis]))
  const horizontal = spread('x') >= spread('y')
  const axis = horizontal ? 'x' : 'y'
  const size = horizontal ? 'width' : 'height'

  // いまの位置の順に並べる。非表示の子は、元の順のまま後ろへ回す
  const sorted = items.toSorted((a, b) => a.box[axis] - b.box[axis])
  const hidden = frame.children.filter((childId) => !scene.nodes[childId].visible)
  const children = [...sorted.map((item) => item.node.id), ...hidden]

  // 間隔は、隣り合う子の隙間の平均。重なっていれば 0
  const gaps = sorted.slice(1).map((item, i) => item.box[axis] - (sorted[i].box[axis] + sorted[i].box[size]))
  const gap = gaps.length > 0 ? Math.max(0, Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)) : 10
  const left = Math.min(...items.map((item) => item.box.x))
  const top = Math.min(...items.map((item) => item.box.y))

  const layout: AutoLayout = {
    ...DEFAULT_LAYOUT,
    direction: horizontal ? 'horizontal' : 'vertical',
    gap,
    paddingX: Math.max(0, Math.round(left)),
    paddingY: Math.max(0, Math.round(top)),
  }
  const next = { ...frame, children, layout } satisfies FrameNode
  return relayout({ ...scene, nodes: { ...scene.nodes, [id]: next } })
}

/**
 * 選んだノードを、自動で並べる新しいフレームにまとめる。
 * フレームは、まとめたノードのうち最も手前にあったものの位置に入る。
 */
export function wrapInAutoLayout<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  name: string,
): { scene: T; id: NodeId | null } {
  const targets = sortByDocumentOrder(scene, topLevelIds(scene, ids))
  const bounds = getNodesBounds(scene, targets)
  if (!bounds) return { scene, id: null }

  // 同じ親の中でまとめる。親が混ざっていたら、最も手前のノードの親に合わせる
  const front = scene.nodes[targets[targets.length - 1]]
  const parentId = front.parentId
  const siblings = parentId === null ? scene.rootIds : (scene.nodes[parentId] as FrameNode).children
  const origin = toLocal(scene, parentId, bounds)
  const frame: FrameNode = {
    ...createFrame({ x: origin.x, y: origin.y, width: bounds.width, height: bounds.height }),
    name,
    // まとめるだけの枠なので、塗らず、はみ出しも隠さない
    fill: null,
    clipContent: false,
  }

  let next = insertNode(scene, frame, parentId, siblings.indexOf(front.id) + 1)
  for (const id of targets) next = moveNode(next, id, frame.id)
  return { scene: enableAutoLayout(next, frame.id), id: frame.id }
}

/**
 * 自動で並べるフレームの中へ、ポインタの位置に応じた順番で入れる（並べ替える）。
 * point はページ座標。
 */
export function placeInLayout<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  parentId: NodeId,
  point: Point,
): T {
  const parent = scene.nodes[parentId]
  if (parent?.type !== 'frame' || !parent.layout) return scene
  const axis = parent.layout.direction === 'horizontal' ? 'x' : 'y'
  const size = axis === 'x' ? 'width' : 'height'
  const local = toLocal(scene, parentId, point)

  const moving = sortByDocumentOrder(scene, topLevelIds(scene, ids))
  const others = parent.children.filter((id) => !moving.includes(id))
  // ポインタより手前に中心がある兄弟の後ろへ入れる
  const before = others.filter((id) => {
    const node = scene.nodes[id]
    if (!node.visible) return false
    const box = boxOf(node)
    return box[axis] + box[size] / 2 < local[axis]
  })
  const anchor = before.at(-1)
  // 1 つずつ anchor の直後へ入れていく。まだ動かしていないノードが間に残っていても順番が狂わないよう、
  // anchor の位置は毎回数え直す
  return moving.reduce((next, id, placed) => {
    const siblings = (next.nodes[parentId] as FrameNode).children.filter((other) => other !== id)
    const start = anchor === undefined ? 0 : siblings.indexOf(anchor) + 1
    return moveNode(next, id, parentId, start + placed)
  }, scene)
}
