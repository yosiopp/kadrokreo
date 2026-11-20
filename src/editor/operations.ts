import {
  type Bounds,
  getAbsoluteBounds,
  getAbsolutePosition,
  unionBounds,
} from '../document/geometry.ts'
import { MAX_DEPTH } from '../document/kdr.ts'
import type { Asset, AssetId, DesignDocument, NodeId, SceneNode } from '../document/types.ts'
import { createId } from './nodes.ts'

// ドキュメントは不変として扱い、どの操作も新しいドキュメントを返す。
// 変化がなければ同じ参照を返すので、履歴側は参照比較で「何も起きなかった」を判定できる。

export function createDocument(name = 'Untitled'): DesignDocument {
  return { name, nodes: {}, rootIds: [], assets: {} }
}

export function addAsset(doc: DesignDocument, id: AssetId, asset: Asset): DesignDocument {
  return { ...doc, assets: { ...doc.assets, [id]: asset } }
}

/** どのノードからも使われていないアセットを除く。保存や書き出しの前に呼ぶ */
export function pruneAssets(doc: DesignDocument): DesignDocument {
  const used = new Set<AssetId>()
  for (const node of Object.values(doc.nodes)) {
    if (node.type === 'image') used.add(node.assetId)
  }
  const ids = Object.keys(doc.assets)
  if (ids.every((id) => used.has(id))) return doc
  return { ...doc, assets: Object.fromEntries(ids.filter((id) => used.has(id)).map((id) => [id, doc.assets[id]])) }
}

export function renameDocument(doc: DesignDocument, name: string): DesignDocument {
  return name === doc.name ? doc : { ...doc, name }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** 木構造に関わるフィールドは insertNode / moveNode / removeNodes でしか変えられない */
export type NodePatch = Partial<DistributiveOmit<SceneNode, 'id' | 'type' | 'parentId' | 'children'>>

const STRUCTURAL_KEYS = new Set(['id', 'type', 'parentId', 'children'])

/** index は兄弟の中での重なり順（0 が最背面）。省略すると最前面 */
export function insertNode(
  doc: DesignDocument,
  node: SceneNode,
  parentId: NodeId | null = null,
  index?: number,
): DesignDocument {
  if (Object.hasOwn(doc.nodes, node.id)) throw new Error(`node already exists: ${node.id}`)
  const withNode = { ...doc, nodes: { ...doc.nodes, [node.id]: { ...node, parentId } } }
  return updateSiblings(withNode, parentId, (ids) => insertAt(ids, node.id, index))
}

export function updateNode(doc: DesignDocument, id: NodeId, patch: NodePatch): DesignDocument {
  const node: Record<string, unknown> | undefined = doc.nodes[id]
  if (!node) return doc

  let next = node
  for (const [key, value] of Object.entries(patch)) {
    // そのノード種別が持たないフィールドは無視する（rect に text を生やさない）
    if (STRUCTURAL_KEYS.has(key) || !Object.hasOwn(node, key)) continue
    if (Object.is(node[key], value)) continue
    if (next === node) next = { ...node }
    next[key] = value
  }
  if (next === node) return doc
  return { ...doc, nodes: { ...doc.nodes, [id]: next as SceneNode } }
}

export function updateNodes(
  doc: DesignDocument,
  ids: readonly NodeId[],
  patch: NodePatch,
): DesignDocument {
  return ids.reduce((next, id) => updateNode(next, id, patch), doc)
}

/** 指定ノードを子孫ごと削除する */
export function removeNodes(doc: DesignDocument, ids: readonly NodeId[]): DesignDocument {
  const doomed = new Set(collectSubtrees(doc, ids))
  if (doomed.size === 0) return doc

  const nodes: Record<NodeId, SceneNode> = {}
  for (const [id, node] of Object.entries(doc.nodes)) {
    if (doomed.has(id)) continue
    nodes[id] =
      node.type === 'frame' && node.children.some((childId) => doomed.has(childId))
        ? { ...node, children: node.children.filter((childId) => !doomed.has(childId)) }
        : node
  }
  return { ...doc, nodes, rootIds: doc.rootIds.filter((id) => !doomed.has(id)) }
}

/**
 * 親の付け替え・重なり順の変更。キャンバス上の見た目の位置は保つ。
 * index は自分を取り除いた後の兄弟の中での位置（0 が最背面）。省略すると最前面。
 */
export function moveNode(
  doc: DesignDocument,
  id: NodeId,
  parentId: NodeId | null,
  index?: number,
): DesignDocument {
  const node = doc.nodes[id]
  if (!node) return doc
  siblingsOf(doc, parentId) // 移動先がフレーム（またはページ）であることの確認
  if (isSelfOrAncestor(doc, id, parentId)) throw new Error(`cannot move node into itself: ${id}`)
  if (parentId !== node.parentId && getDepth(doc, parentId) + subtreeHeight(doc, id) > MAX_DEPTH) {
    return doc
  }

  const detached = updateSiblings(doc, node.parentId, (ids) => ids.filter((other) => other !== id))
  const from = getAbsolutePosition(doc, id)
  const origin = parentId === null ? { x: 0, y: 0 } : getAbsolutePosition(doc, parentId)
  const moved = { ...node, parentId, x: from.x - origin.x, y: from.y - origin.y }
  const next = updateSiblings(
    { ...detached, nodes: { ...detached.nodes, [id]: moved } },
    parentId,
    (ids) => insertAt(ids, id, index),
  )

  const unchanged =
    node.parentId === parentId && siblingIndex(doc, id) === siblingIndex(next, id)
  return unchanged ? doc : next
}

/** 祖先も一緒に指定されているノードを除く。親を動かせば子もついてくるため */
export function topLevelIds(doc: DesignDocument, ids: readonly NodeId[]): NodeId[] {
  const set = new Set(ids)
  return ids.filter((id) => {
    if (!Object.hasOwn(doc.nodes, id)) return false
    for (let p = doc.nodes[id].parentId; p !== null; p = doc.nodes[p].parentId) {
      if (set.has(p)) return false
    }
    return true
  })
}

/** 重なり順（背面が先）に並べ替える */
export function sortByDocumentOrder(doc: DesignDocument, ids: readonly NodeId[]): NodeId[] {
  const wanted = new Set(ids)
  return collectSubtrees(doc, doc.rootIds).filter((id) => wanted.has(id))
}

export function translateNodes(
  doc: DesignDocument,
  ids: readonly NodeId[],
  dx: number,
  dy: number,
): DesignDocument {
  if (dx === 0 && dy === 0) return doc
  return topLevelIds(doc, ids).reduce((next, id) => {
    const node = doc.nodes[id]
    return updateNode(next, id, { x: node.x + dx, y: node.y + dy })
  }, doc)
}

/**
 * ページ座標の矩形 from に収まっていたノード群を、to に収まるよう拡大縮小する。
 * 子の位置と大きさは変えない。
 * テキストは幅を変えると折り返しに切り替わる。高さは中身で決まるので、呼び出し側で合わせ直すこと。
 */
export function resizeNodes(
  doc: DesignDocument,
  ids: readonly NodeId[],
  from: Bounds,
  to: Bounds,
): DesignDocument {
  const scaleX = from.width === 0 ? 1 : to.width / from.width
  const scaleY = from.height === 0 ? 1 : to.height / from.height
  return topLevelIds(doc, ids).reduce((next, id) => {
    const node = doc.nodes[id]
    const abs = getAbsoluteBounds(doc, id)
    const left = Math.round(to.x + (abs.x - from.x) * scaleX)
    const top = Math.round(to.y + (abs.y - from.y) * scaleY)
    const position = { x: node.x + left - abs.x, y: node.y + top - abs.y }
    const right = Math.round(to.x + (abs.x + abs.width - from.x) * scaleX)
    const bottom = Math.round(to.y + (abs.y + abs.height - from.y) * scaleY)
    const width = Math.max(1, right - left)
    if (node.type === 'text') {
      if (width === node.width) return updateNode(next, id, position)
      return updateNode(next, id, { ...position, width, autoWidth: false })
    }
    // 直線は水平・垂直にできるよう、幅や高さが 0 になってよい
    if (node.type === 'line') {
      return updateNode(next, id, { ...position, width: right - left, height: bottom - top })
    }
    return updateNode(next, id, { ...position, width, height: Math.max(1, bottom - top) })
  }, doc)
}

/** 親が違うノードだけを parentId の最前面へ移す */
export function reparentNodes(
  doc: DesignDocument,
  ids: readonly NodeId[],
  parentId: NodeId | null,
): DesignDocument {
  return sortByDocumentOrder(doc, topLevelIds(doc, ids)).reduce((next, id) => {
    if (next.nodes[id].parentId === parentId || isSelfOrAncestor(next, id, parentId)) return next
    return moveNode(next, id, parentId)
  }, doc)
}

export type Alignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'

/** 複数なら選択範囲に、1 つなら親フレームに揃える */
export function alignNodes(
  doc: DesignDocument,
  ids: readonly NodeId[],
  alignment: Alignment,
): DesignDocument {
  const targets = topLevelIds(doc, ids)
  const single = targets.length === 1 ? doc.nodes[targets[0]] : null
  const reference = single
    ? single.parentId === null
      ? null
      : getAbsoluteBounds(doc, single.parentId)
    : unionBounds(targets.map((id) => getAbsoluteBounds(doc, id)))
  if (!reference) return doc

  return targets.reduce((next, id) => {
    const node = doc.nodes[id]
    const abs = getAbsoluteBounds(doc, id)
    const offsets: Record<Alignment, [number, number]> = {
      left: [reference.x - abs.x, 0],
      center: [reference.x + (reference.width - abs.width) / 2 - abs.x, 0],
      right: [reference.x + reference.width - abs.width - abs.x, 0],
      top: [0, reference.y - abs.y],
      middle: [0, reference.y + (reference.height - abs.height) / 2 - abs.y],
      bottom: [0, reference.y + reference.height - abs.height - abs.y],
    }
    const [dx, dy] = offsets[alignment]
    return updateNode(next, id, { x: Math.round(node.x + dx), y: Math.round(node.y + dy) })
  }, doc)
}

/** 両端の位置は変えずに、間隔が等しくなるよう並べ直す。3 つ以上で意味がある */
export function distributeNodes(
  doc: DesignDocument,
  ids: readonly NodeId[],
  axis: 'x' | 'y',
): DesignDocument {
  const size = axis === 'x' ? 'width' : 'height'
  const items = topLevelIds(doc, ids)
    .map((id) => ({ id, bounds: getAbsoluteBounds(doc, id) }))
    .sort((a, b) => a.bounds[axis] - b.bounds[axis])
  if (items.length < 3) return doc

  const first = items[0].bounds
  const last = items[items.length - 1].bounds
  const occupied = items.reduce((sum, item) => sum + item.bounds[size], 0)
  const gap = (last[axis] + last[size] - first[axis] - occupied) / (items.length - 1)

  let position = first[axis]
  return items.reduce((next, { id, bounds }) => {
    const delta = Math.round(position - bounds[axis])
    position += bounds[size] + gap
    return updateNode(next, id, { [axis]: doc.nodes[id][axis] + delta })
  }, doc)
}

export type Placement = 'above' | 'below' | 'inside'

/** レイヤーパネルでのドロップ。target のすぐ手前・すぐ奥・中（最前面）へ、互いの重なり順を保って移す */
export function placeNodes(
  doc: DesignDocument,
  ids: readonly NodeId[],
  targetId: NodeId,
  placement: Placement,
): DesignDocument {
  const target = doc.nodes[targetId]
  if (!target || (placement === 'inside' && target.type !== 'frame')) return doc
  const moving = sortByDocumentOrder(doc, topLevelIds(doc, ids))
  if (moving.some((id) => isSelfOrAncestor(doc, id, targetId))) return doc

  if (placement === 'inside') {
    return moving.reduce((next, id) => moveNode(next, id, targetId), doc)
  }
  // 同じ位置へ順に差し込むので、手前に置くときは前面のものから入れると順序が保たれる
  const order = placement === 'above' ? moving.toReversed() : moving
  return order.reduce((next, id) => {
    const siblings = siblingsOf(next, target.parentId).filter((other) => other !== id)
    const index = siblings.indexOf(targetId) + (placement === 'above' ? 1 : 0)
    return moveNode(next, id, target.parentId, index)
  }, doc)
}

export type ReorderDirection = 'front' | 'back' | 'forward' | 'backward'

export function reorderNodes(
  doc: DesignDocument,
  ids: readonly NodeId[],
  direction: ReorderDirection,
): DesignDocument {
  const moving = sortByDocumentOrder(doc, topLevelIds(doc, ids))
  if (direction === 'front') {
    return moving.reduce((next, id) => moveNode(next, id, next.nodes[id].parentId), doc)
  }
  if (direction === 'back') {
    return moving.toReversed().reduce((next, id) => moveNode(next, id, next.nodes[id].parentId, 0), doc)
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
  }, doc)
}

/**
 * コピーしたノード群。rootIds のノードの x, y はページ座標、parentId はコピー元の親。
 * 別のドキュメントへ貼り付けても画像が欠けないよう、使っているアセットも持つ。
 */
export type Fragment = {
  nodes: Record<NodeId, SceneNode>
  rootIds: NodeId[]
  assets: Record<AssetId, Asset>
}

export function copyFragment(doc: DesignDocument, ids: readonly NodeId[]): Fragment {
  const rootIds = sortByDocumentOrder(doc, topLevelIds(doc, ids))
  const nodes: Record<NodeId, SceneNode> = {}
  for (const id of collectSubtrees(doc, rootIds)) nodes[id] = doc.nodes[id]
  for (const id of rootIds) nodes[id] = { ...nodes[id], ...getAbsolutePosition(doc, id) }

  const assets: Record<AssetId, Asset> = {}
  for (const node of Object.values(nodes)) {
    if (node.type === 'image') assets[node.assetId] = doc.assets[node.assetId]
  }
  return { nodes, rootIds, assets }
}

/** id を振り直して貼り付ける。コピー元の親が残っていればその中へ、なければページ直下へ置く */
export function pasteFragment(
  doc: DesignDocument,
  fragment: Fragment,
  offset = 0,
): { document: DesignDocument; ids: NodeId[] } {
  const newIds = new Map(Object.keys(fragment.nodes).map((id) => [id, createId()]))
  const clones: Record<NodeId, SceneNode> = {}
  for (const [id, node] of Object.entries(fragment.nodes)) {
    const clone = { ...node, id: newIds.get(id)! }
    if (clone.parentId !== null && newIds.has(clone.parentId)) {
      clone.parentId = newIds.get(clone.parentId)!
    }
    if (clone.type === 'frame') clone.children = clone.children.map((child) => newIds.get(child)!)
    clones[clone.id] = clone
  }

  const ids = fragment.rootIds.map((id) => newIds.get(id)!)
  // 同じ id のアセットは中身も同じなので、すでにあるものはそのまま使う
  const missing = Object.keys(fragment.assets).some((id) => !Object.hasOwn(doc.assets, id))
  let next = missing ? { ...doc, assets: { ...fragment.assets, ...doc.assets } } : doc
  for (const id of ids) {
    const { [id]: root, ...rest } = clones
    const parent = root.parentId === null ? undefined : doc.nodes[root.parentId]
    const parentId = parent?.type === 'frame' ? parent.id : null
    const origin = parentId === null ? { x: 0, y: 0 } : getAbsolutePosition(doc, parentId)
    const placed = { ...root, x: root.x - origin.x + offset, y: root.y - origin.y + offset }
    // 子孫は親より先に nodes へ入れておく（重複して入れても同じ値なので害はない）
    next = insertNode({ ...next, nodes: { ...next.nodes, ...descendantsOf(rest, root) } }, placed, parentId)
  }
  return { document: next, ids }
}

function descendantsOf(pool: Record<NodeId, SceneNode>, root: SceneNode): Record<NodeId, SceneNode> {
  const found: Record<NodeId, SceneNode> = {}
  const stack = root.type === 'frame' ? [...root.children] : []
  while (stack.length > 0) {
    const node = pool[stack.pop()!]
    found[node.id] = node
    if (node.type === 'frame') stack.push(...node.children)
  }
  return found
}

/** ids とその子孫を、重なり順（背面が先、親は子より先）で返す */
function collectSubtrees(doc: DesignDocument, ids: readonly NodeId[]): NodeId[] {
  const result: NodeId[] = []
  const seen = new Set<NodeId>()
  const stack = ids.filter((id) => Object.hasOwn(doc.nodes, id)).reverse()
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
    const node = doc.nodes[id]
    if (node.type === 'frame') stack.push(...node.children.toReversed())
  }
  return result
}

/** target が id 自身か、id の子孫であるか */
function isSelfOrAncestor(doc: DesignDocument, id: NodeId, target: NodeId | null): boolean {
  for (let current = target; current !== null; current = doc.nodes[current].parentId) {
    if (current === id) return true
  }
  return false
}

/** ページ直下のノードを 1 とした入れ子の深さ。ページ自体（null）は 0 */
export function getDepth(doc: DesignDocument, id: NodeId | null): number {
  let depth = 0
  for (let current = id; current !== null; current = doc.nodes[current].parentId) depth++
  return depth
}

function subtreeHeight(doc: DesignDocument, id: NodeId): number {
  let height = 0
  const stack = [{ id, level: 1 }]
  while (stack.length > 0) {
    const { id: current, level } = stack.pop()!
    height = Math.max(height, level)
    const node = doc.nodes[current]
    if (node.type === 'frame') {
      for (const child of node.children) stack.push({ id: child, level: level + 1 })
    }
  }
  return height
}

function siblingsOf(doc: DesignDocument, parentId: NodeId | null): NodeId[] {
  if (parentId === null) return doc.rootIds
  const parent = doc.nodes[parentId]
  if (parent?.type !== 'frame') throw new Error(`parent is not a frame: ${parentId}`)
  return parent.children
}

function siblingIndex(doc: DesignDocument, id: NodeId): number {
  return siblingsOf(doc, doc.nodes[id].parentId).indexOf(id)
}

function updateSiblings(
  doc: DesignDocument,
  parentId: NodeId | null,
  update: (ids: NodeId[]) => NodeId[],
): DesignDocument {
  const ids = update(siblingsOf(doc, parentId))
  if (parentId === null) return { ...doc, rootIds: ids }
  const parent = doc.nodes[parentId]
  return { ...doc, nodes: { ...doc.nodes, [parentId]: { ...parent, children: ids } as SceneNode } }
}

function insertAt(ids: NodeId[], id: NodeId, index = ids.length): NodeId[] {
  const at = Math.max(0, Math.min(index, ids.length))
  return [...ids.slice(0, at), id, ...ids.slice(at)]
}
