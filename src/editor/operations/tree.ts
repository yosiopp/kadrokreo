import { getWorldCenter, getWorldRotation, poseInParent } from '../../document/geometry.ts'
import { MAX_DEPTH } from '../../document/kdr.ts'
import type { NodeId, Scene, SceneNode } from '../../document/types.ts'
import { noteNodeChanges } from '../../document/nodeChanges.ts'

// ドキュメントもページも不変として扱い、どの操作も新しいものを返す。
// 変化がなければ同じ参照を返すので、履歴側は参照比較で「何も起きなかった」を判定できる。
//
// ノードの操作は 1 ページ分の木（Scene）に対して行う。Page を渡せば Page が返る。

// ここはノードの追加・書き換え・削除・親の付け替えと、木をたどる下請け。

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** 木構造に関わるフィールドは insertNode / moveNode / removeNodes でしか変えられない */
export type NodePatch = Partial<DistributiveOmit<SceneNode, 'id' | 'type' | 'parentId' | 'children'>>

const STRUCTURAL_KEYS = new Set(['id', 'type', 'parentId', 'children'])

/** index は兄弟の中での重なり順（0 が最背面）。省略すると最前面 */
export function insertNode<T extends Scene>(
  scene: T,
  node: SceneNode,
  parentId: NodeId | null = null,
  index?: number,
): T {
  if (Object.hasOwn(scene.nodes, node.id)) throw new Error(`node already exists: ${node.id}`)
  const withNode = { ...scene, nodes: { ...scene.nodes, [node.id]: { ...node, parentId } } }
  noteNodeChanges(withNode.nodes, scene.nodes, [node.id])
  return updateSiblings(withNode, parentId, (ids) => insertAt(ids, node.id, index))
}

/** patch を当てたノード。何も変わらなければ、同じ参照を返す */
function patched(node: SceneNode, patch: NodePatch): SceneNode {
  const current: Record<string, unknown> = node
  let next = current
  for (const [key, value] of Object.entries(patch)) {
    // そのノード種別が持たないフィールドは無視する（rect に text を生やさない）
    if (STRUCTURAL_KEYS.has(key) || !Object.hasOwn(current, key)) continue
    if (Object.is(current[key], value)) continue
    if (next === current) next = { ...current }
    next[key] = value
  }
  return next as SceneNode
}

/**
 * ノードごとに決めた patch を、まとめて当てる。patchFor が null を返したノードと、存在しない id は飛ばす。
 * ノードの表を写すのは全体で 1 回なので、たくさんのノードを一度に変えるときは、updateNode を重ねずにこれを使う。
 */
export function patchNodes<T extends Scene>(
  scene: T,
  ids: Iterable<NodeId>,
  patchFor: (node: SceneNode) => NodePatch | null,
): T {
  let nodes: Record<NodeId, SceneNode> | null = null
  const changed: NodeId[] = []
  for (const id of ids) {
    const node = (nodes ?? scene.nodes)[id]
    if (!node) continue
    const patch = patchFor(node)
    const next = patch ? patched(node, patch) : node
    if (next === node) continue
    nodes ??= { ...scene.nodes }
    nodes[id] = next
    changed.push(id)
  }
  if (!nodes) return scene
  // 変えたノードを覚えておく（ストアの後始末が、全部のノードを比べ直さずに済む）
  noteNodeChanges(nodes, scene.nodes, changed)
  return { ...scene, nodes }
}

export function updateNode<T extends Scene>(scene: T, id: NodeId, patch: NodePatch): T {
  return patchNodes(scene, [id], () => patch)
}

export function updateNodes<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  patch: NodePatch,
): T {
  return patchNodes(scene, ids, () => patch)
}

/** 指定ノードを子孫ごと削除する */
export function removeNodes<T extends Scene>(scene: T, ids: readonly NodeId[]): T {
  const doomed = new Set(collectSubtrees(scene, ids))
  if (doomed.size === 0) return scene

  const nodes: Record<NodeId, SceneNode> = {}
  const changed = [...doomed]
  for (const [id, node] of Object.entries(scene.nodes)) {
    if (doomed.has(id)) continue
    if (node.type === 'frame' && node.children.some((childId) => doomed.has(childId))) {
      nodes[id] = { ...node, children: node.children.filter((childId) => !doomed.has(childId)) }
      changed.push(id)
    } else nodes[id] = node
  }
  noteNodeChanges(nodes, scene.nodes, changed)
  return { ...scene, nodes, rootIds: scene.rootIds.filter((id) => !doomed.has(id)) }
}

/**
 * 親の付け替え・重なり順の変更。キャンバス上の見た目の位置と向きは保つ。
 * index は自分を取り除いた後の兄弟の中での位置（0 が最背面）。省略すると最前面。
 */
export function moveNode<T extends Scene>(
  scene: T,
  id: NodeId,
  parentId: NodeId | null,
  index?: number,
): T {
  const node = scene.nodes[id]
  if (!node) return scene
  siblingsOf(scene, parentId) // 移動先がフレーム（またはページ）であることの確認
  if (isSelfOrAncestor(scene, id, parentId)) throw new Error(`cannot move node into itself: ${id}`)
  if (parentId !== node.parentId && getDepth(scene, parentId) + subtreeHeight(scene, id) > MAX_DEPTH) {
    return scene
  }

  const detached = updateSiblings(scene, node.parentId, (ids) => ids.filter((other) => other !== id))
  // 親が回っていても、ページ上での位置と向きが変わらないように置き直す
  const pose = poseInParent(
    scene,
    parentId,
    getWorldCenter(scene, id),
    getWorldRotation(scene, id),
    node,
  )
  const moved = { ...node, parentId, x: pose.x, y: pose.y, rotation: pose.rotation }
  const next = updateSiblings(
    { ...detached, nodes: { ...detached.nodes, [id]: moved } },
    parentId,
    (ids) => insertAt(ids, id, index),
  )

  const unchanged =
    node.parentId === parentId && siblingIndex(scene, id) === siblingIndex(next, id)
  return unchanged ? scene : next
}

/** 祖先も一緒に指定されているノードを除く。親を動かせば子もついてくるため */
export function topLevelIds(scene: Scene, ids: readonly NodeId[]): NodeId[] {
  const set = new Set(ids)
  return ids.filter((id) => {
    if (!Object.hasOwn(scene.nodes, id)) return false
    for (let p = scene.nodes[id].parentId; p !== null; p = scene.nodes[p].parentId) {
      if (set.has(p)) return false
    }
    return true
  })
}

/** 重なり順（背面が先）に並べ替える */
export function sortByDocumentOrder(scene: Scene, ids: readonly NodeId[]): NodeId[] {
  const wanted = new Set(ids)
  return collectSubtrees(scene, scene.rootIds).filter((id) => wanted.has(id))
}

/** 親が違うノードだけを parentId の最前面へ移す */
export function reparentNodes<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  parentId: NodeId | null,
): T {
  // 動かすものだけを重なり順に並べる（ドラッグの 1 歩ごとに呼ばれ、たいていは何も動かないので、木全体をたどらない）
  const moving = topLevelIds(scene, ids).filter((id) => scene.nodes[id].parentId !== parentId && !isSelfOrAncestor(scene, id, parentId))
  if (moving.length === 0) return scene
  return (moving.length === 1 ? moving : sortByDocumentOrder(scene, moving)).reduce((next, id) => {
    if (next.nodes[id].parentId === parentId || isSelfOrAncestor(next, id, parentId)) return next
    return moveNode(next, id, parentId)
  }, scene)
}

// ── 木をたどる下請け（operations/ の中で使う） ──

/** ids とその子孫を、重なり順（背面が先、親は子より先）で返す */
export function collectSubtrees(scene: Scene, ids: readonly NodeId[]): NodeId[] {
  const result: NodeId[] = []
  const seen = new Set<NodeId>()
  const stack = ids.filter((id) => Object.hasOwn(scene.nodes, id)).reverse()
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
    const node = scene.nodes[id]
    if (node.type === 'frame') for (const child of node.children.toReversed()) stack.push(child)
  }
  return result
}

/** target が id 自身か、id の子孫であるか */
export function isSelfOrAncestor(scene: Scene, id: NodeId, target: NodeId | null): boolean {
  for (let current = target; current !== null; current = scene.nodes[current].parentId) {
    if (current === id) return true
  }
  return false
}

/** ページ直下のノードを 1 とした入れ子の深さ。ページ自体（null）は 0 */
function getDepth(scene: Scene, id: NodeId | null): number {
  let depth = 0
  for (let current = id; current !== null; current = scene.nodes[current].parentId) depth++
  return depth
}

function subtreeHeight(scene: Scene, id: NodeId): number {
  let height = 0
  const stack = [{ id, level: 1 }]
  while (stack.length > 0) {
    const { id: current, level } = stack.pop()!
    height = Math.max(height, level)
    const node = scene.nodes[current]
    if (node.type === 'frame') {
      for (const child of node.children) stack.push({ id: child, level: level + 1 })
    }
  }
  return height
}

export function siblingsOf(scene: Scene, parentId: NodeId | null): NodeId[] {
  if (parentId === null) return scene.rootIds
  const parent = scene.nodes[parentId]
  if (parent?.type !== 'frame') throw new Error(`parent is not a frame: ${parentId}`)
  return parent.children
}

function siblingIndex(scene: Scene, id: NodeId): number {
  return siblingsOf(scene, scene.nodes[id].parentId).indexOf(id)
}

function updateSiblings<T extends Scene>(
  scene: T,
  parentId: NodeId | null,
  update: (ids: NodeId[]) => NodeId[],
): T {
  const ids = update(siblingsOf(scene, parentId))
  if (parentId === null) return { ...scene, rootIds: ids }
  const parent = scene.nodes[parentId]
  const nodes = { ...scene.nodes, [parentId]: { ...parent, children: ids } as SceneNode }
  noteNodeChanges(nodes, scene.nodes, [parentId])
  return { ...scene, nodes }
}

function insertAt(ids: NodeId[], id: NodeId, index = ids.length): NodeId[] {
  const at = Math.max(0, Math.min(index, ids.length))
  return [...ids.slice(0, at), id, ...ids.slice(at)]
}
