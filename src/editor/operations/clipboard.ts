import { getWorldCenter, getWorldRotation, poseInParent } from '../../document/geometry.ts'
import type { Asset, AssetId, NodeId, Scene, SceneNode } from '../../document/types.ts'
import { createId } from '../nodes.ts'
import { collectSubtrees, insertNode, siblingsOf, sortByDocumentOrder, topLevelIds } from './tree.ts'

// コピーと貼り付け（複製もこれを使う）。ドキュメントへ貼るときは document.ts の pasteIntoPage

/**
 * コピーしたノード群。rootIds のノードの x, y, rotation はページ直下に置いたときの値、parentId はコピー元の親。
 * 別のドキュメントへ貼り付けても画像が欠けないよう、使っているアセットも持つ。
 */
export type Fragment = {
  nodes: Record<NodeId, SceneNode>
  rootIds: NodeId[]
  assets: Record<AssetId, Asset>
}

export function copyFragment(
  scene: Scene,
  assets: Record<AssetId, Asset>,
  ids: readonly NodeId[],
): Fragment {
  const rootIds = sortByDocumentOrder(scene, topLevelIds(scene, ids))
  const nodes: Record<NodeId, SceneNode> = {}
  for (const id of collectSubtrees(scene, rootIds)) nodes[id] = scene.nodes[id]
  for (const id of rootIds) {
    const pose = poseInParent(
      scene,
      null,
      getWorldCenter(scene, id),
      getWorldRotation(scene, id),
      nodes[id],
    )
    nodes[id] = { ...nodes[id], x: pose.x, y: pose.y, rotation: pose.rotation }
  }

  const used: Record<AssetId, Asset> = {}
  for (const node of Object.values(nodes)) {
    if (node.type === 'image') used[node.assetId] = assets[node.assetId]
  }
  return { nodes, rootIds, assets: used }
}

/**
 * id を振り直してノードを貼り付ける。コピー元の親が残っていればその中へ、なければページ直下へ置く。
 * 重なり順は親の最前面。aboveSource なら、コピー元が同じ親に残っていれば、そのすぐ上（重なり順で 1 つ前面）に置く（複製）。
 * アセットは足さないので、ドキュメントへ貼るときは pasteIntoPage を使う。
 */
export function pasteFragment<T extends Scene>(
  scene: T,
  fragment: Fragment,
  offset = 0,
  { aboveSource = false }: { aboveSource?: boolean } = {},
): { scene: T; ids: NodeId[] } {
  const newIds = new Map(Object.keys(fragment.nodes).map((id) => [id, createId()]))
  const clones: Record<NodeId, SceneNode> = {}
  for (const [id, node] of Object.entries(fragment.nodes)) {
    const clone = { ...node, id: newIds.get(id)! }
    if (clone.parentId !== null && newIds.has(clone.parentId)) {
      clone.parentId = newIds.get(clone.parentId)!
    }
    if (clone.type === 'frame') {
      clone.children = clone.children.map((child) => newIds.get(child)!)
      // コンポーネントの元は 1 つだけ。元を複製したものは、そのインスタンスになる
      if (clone.component?.role === 'main') {
        clone.component = { id: clone.component.id, role: 'instance', overrides: {}, flipX: false, flipY: false }
      }
    }
    clones[clone.id] = clone
  }

  const ids = fragment.rootIds.map((id) => newIds.get(id)!)
  let next = scene
  for (const [i, id] of ids.entries()) {
    const { [id]: root, ...rest } = clones
    const parent = root.parentId === null ? undefined : scene.nodes[root.parentId]
    const parentId = parent?.type === 'frame' ? parent.id : null
    const center = { x: root.x + root.width / 2 + offset, y: root.y + root.height / 2 + offset }
    const pose = poseInParent(scene, parentId, center, root.rotation, root)
    const placed = { ...root, x: pose.x, y: pose.y, rotation: pose.rotation }
    const sourceId = fragment.rootIds[i]
    const index = aboveSource && next.nodes[sourceId]?.parentId === parentId
      ? siblingsOf(next, parentId).indexOf(sourceId) + 1
      : undefined
    // 子孫は親より先に nodes へ入れておく（重複して入れても同じ値なので害はない）
    next = insertNode({ ...next, nodes: { ...next.nodes, ...descendantsOf(rest, root) } }, placed, parentId, index)
  }
  return { scene: next, ids }
}

/** 複製（Cmd + D）。元の親の中で、元のすぐ上（重なり順で 1 つ前面）に置く。同じページの中なので画像は足さない */
export function duplicateNodes<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  offset: number,
): { scene: T; ids: NodeId[] } {
  return pasteFragment(scene, copyFragment(scene, {}, ids), offset, { aboveSource: true })
}

function descendantsOf(pool: Record<NodeId, SceneNode>, root: SceneNode): Record<NodeId, SceneNode> {
  const found: Record<NodeId, SceneNode> = {}
  const stack = root.type === 'frame' ? [...root.children] : []
  while (stack.length > 0) {
    const node = pool[stack.pop()!]
    found[node.id] = node
    if (node.type === 'frame') for (const child of node.children) stack.push(child)
  }
  return found
}
