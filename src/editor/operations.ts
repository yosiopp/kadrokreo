import {
  type Bounds,
  type Point,
  applyMatrix,
  getAbsoluteBounds,
  getWorldCenter,
  getWorldMatrix,
  getWorldRotation,
  normalizeAngle,
  poseInParent,
  rotateVector,
  tidy,
  unionBounds,
} from '../document/geometry.ts'
import { MAX_DEPTH } from '../document/kdr.ts'
import type {
  Asset,
  AssetId,
  DesignDocument,
  NodeId,
  Page,
  PageId,
  Scene,
  SceneNode,
} from '../document/types.ts'
import { createId } from './nodes.ts'

// ドキュメントもページも不変として扱い、どの操作も新しいものを返す。
// 変化がなければ同じ参照を返すので、履歴側は参照比較で「何も起きなかった」を判定できる。
//
// ノードの操作は 1 ページ分の木（Scene）に対して行う。Page を渡せば Page が返る。

// ── ドキュメントとページ ──

export function createPage(name = 'Page 1'): Page {
  return { id: createId(), name, nodes: {}, rootIds: [] }
}

export function createDocument(name = 'Untitled'): DesignDocument {
  return { name, pages: [createPage()], assets: {} }
}

export function renameDocument(doc: DesignDocument, name: string): DesignDocument {
  return name === doc.name ? doc : { ...doc, name }
}

/** 1 ページだけを書き換える。recipe が同じページを返したら、ドキュメントも同じものを返す */
export function updatePage(
  doc: DesignDocument,
  pageId: PageId,
  recipe: (page: Page) => Page,
): DesignDocument {
  const index = doc.pages.findIndex((page) => page.id === pageId)
  if (index === -1) return doc
  const next = recipe(doc.pages[index])
  return next === doc.pages[index] ? doc : { ...doc, pages: doc.pages.with(index, next) }
}

export function renamePage(doc: DesignDocument, pageId: PageId, name: string): DesignDocument {
  return updatePage(doc, pageId, (page) => (page.name === name ? page : { ...page, name }))
}

/** index を省略すると末尾に足す */
export function addPage(doc: DesignDocument, page: Page, index = doc.pages.length): DesignDocument {
  if (doc.pages.some((other) => other.id === page.id)) throw new Error(`page already exists: ${page.id}`)
  return { ...doc, pages: doc.pages.toSpliced(index, 0, page) }
}

/** ドキュメントには必ず 1 ページ残す */
export function removePage(doc: DesignDocument, pageId: PageId): DesignDocument {
  if (doc.pages.length <= 1 || !doc.pages.some((page) => page.id === pageId)) return doc
  return { ...doc, pages: doc.pages.filter((page) => page.id !== pageId) }
}

/** index は自分を取り除いた後の並びでの位置 */
export function movePage(doc: DesignDocument, pageId: PageId, index: number): DesignDocument {
  const from = doc.pages.findIndex((page) => page.id === pageId)
  if (from === -1) return doc
  const pages = doc.pages.toSpliced(from, 1).toSpliced(index, 0, doc.pages[from])
  return pages.every((page, i) => page === doc.pages[i]) ? doc : { ...doc, pages }
}

/** 中身ごと複製して、元のページのすぐ後ろに置く。ノードの id は振り直す */
export function duplicatePage(
  doc: DesignDocument,
  pageId: PageId,
): { document: DesignDocument; pageId: PageId } | null {
  const index = doc.pages.findIndex((page) => page.id === pageId)
  if (index === -1) return null
  const source = doc.pages[index]
  const fragment = copyFragment(source, doc.assets, source.rootIds)
  const copy = pasteFragment(createPage(`${source.name} のコピー`), fragment).scene
  return { document: addPage(doc, copy, index + 1), pageId: copy.id }
}

export function addAsset(doc: DesignDocument, id: AssetId, asset: Asset): DesignDocument {
  return { ...doc, assets: { ...doc.assets, [id]: asset } }
}

/** どのノードからも使われていないアセットを除く。保存や書き出しの前に呼ぶ */
export function pruneAssets(doc: DesignDocument): DesignDocument {
  const used = new Set<AssetId>()
  for (const page of doc.pages) {
    for (const node of Object.values(page.nodes)) {
      if (node.type === 'image') used.add(node.assetId)
    }
  }
  const ids = Object.keys(doc.assets)
  if (ids.every((id) => used.has(id))) return doc
  return { ...doc, assets: Object.fromEntries(ids.filter((id) => used.has(id)).map((id) => [id, doc.assets[id]])) }
}

// ── ノード ──

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
  return updateSiblings(withNode, parentId, (ids) => insertAt(ids, node.id, index))
}

export function updateNode<T extends Scene>(scene: T, id: NodeId, patch: NodePatch): T {
  const node: Record<string, unknown> | undefined = scene.nodes[id]
  if (!node) return scene

  let next = node
  for (const [key, value] of Object.entries(patch)) {
    // そのノード種別が持たないフィールドは無視する（rect に text を生やさない）
    if (STRUCTURAL_KEYS.has(key) || !Object.hasOwn(node, key)) continue
    if (Object.is(node[key], value)) continue
    if (next === node) next = { ...node }
    next[key] = value
  }
  if (next === node) return scene
  return { ...scene, nodes: { ...scene.nodes, [id]: next as SceneNode } }
}

export function updateNodes<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  patch: NodePatch,
): T {
  return ids.reduce((next, id) => updateNode(next, id, patch), scene)
}

/** 指定ノードを子孫ごと削除する */
export function removeNodes<T extends Scene>(scene: T, ids: readonly NodeId[]): T {
  const doomed = new Set(collectSubtrees(scene, ids))
  if (doomed.size === 0) return scene

  const nodes: Record<NodeId, SceneNode> = {}
  for (const [id, node] of Object.entries(scene.nodes)) {
    if (doomed.has(id)) continue
    nodes[id] =
      node.type === 'frame' && node.children.some((childId) => doomed.has(childId))
        ? { ...node, children: node.children.filter((childId) => !doomed.has(childId)) }
        : node
  }
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

/** dx, dy はページ上での移動量 */
export function translateNodes<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  dx: number,
  dy: number,
): T {
  if (dx === 0 && dy === 0) return scene
  return topLevelIds(scene, ids).reduce(
    (next, id) => updateNode(next, id, shifted(scene, id, dx, dy)),
    scene,
  )
}

/** ページ上で (dx, dy) だけ動かしたときの x, y。親が回っていれば、親の向きに合わせて移動量を直す */
function shifted(scene: Scene, id: NodeId, dx: number, dy: number): Point {
  const node = scene.nodes[id]
  const delta = rotateVector({ x: dx, y: dy }, -getWorldRotation(scene, node.parentId))
  return { x: tidy(node.x + delta.x), y: tidy(node.y + delta.y) }
}

/** ページ上の点 pivot を軸に、まとめて delta 度（時計回り）回す */
export function rotateNodes<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  pivot: Point,
  delta: number,
): T {
  if (delta === 0) return scene
  return topLevelIds(scene, ids).reduce((next, id) => {
    const node = scene.nodes[id]
    const center = getWorldCenter(scene, id)
    const arm = rotateVector({ x: center.x - pivot.x, y: center.y - pivot.y }, delta)
    const pose = poseInParent(
      scene,
      node.parentId,
      { x: pivot.x + arm.x, y: pivot.y + arm.y },
      getWorldRotation(scene, id) + delta,
      node,
    )
    return updateNode(next, id, { x: pose.x, y: pose.y, rotation: pose.rotation })
  }, scene)
}

/**
 * ノードの枠を、いまのノードの座標系で表した box に変える。向きは変えない。
 * 回転したノードを、回転した軸に沿ってリサイズするのに使う。
 */
export function reshapeNode<T extends Scene>(scene: T, id: NodeId, box: Bounds): T {
  const node = scene.nodes[id]
  if (!node) return scene
  const center = applyMatrix(getWorldMatrix(scene, id), {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  })
  const size = { width: box.width, height: node.type === 'text' ? node.height : box.height }
  const pose = poseInParent(scene, node.parentId, center, getWorldRotation(scene, id), size)
  const patch = { x: pose.x, y: pose.y, ...size }
  if (node.type === 'text' && box.width !== node.width) {
    return updateNode(scene, id, { ...patch, autoWidth: false })
  }
  return updateNode(scene, id, patch)
}

/**
 * ページ座標の矩形 from に収まっていたノード群を、to に収まるよう拡大縮小する。
 * 子の位置と大きさは変えない。
 * 斜めに回っているノードは歪ませられないので、中心を動かし、面積が合う倍率で大きさを変える。
 * テキストは幅を変えると折り返しに切り替わる。高さは中身で決まるので、呼び出し側で合わせ直すこと。
 */
export function resizeNodes<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  from: Bounds,
  to: Bounds,
): T {
  const scaleX = from.width === 0 ? 1 : to.width / from.width
  const scaleY = from.height === 0 ? 1 : to.height / from.height
  return topLevelIds(scene, ids).reduce((next, id) => {
    const node = scene.nodes[id]
    const rotation = normalizeAngle(getWorldRotation(scene, id))
    // ページ上では回っていなくても、親と逆向きに回して打ち消しているノードはこちらで扱う
    if (rotation !== 0 || node.rotation !== 0) {
      const center = getWorldCenter(scene, id)
      const moved = {
        x: to.x + (center.x - from.x) * scaleX,
        y: to.y + (center.y - from.y) * scaleY,
      }
      // 90° 回っていれば縦と横が入れ替わる
      const uniform = Math.sqrt(Math.abs(scaleX * scaleY))
      const [scaleW, scaleH] =
        rotation === 0 || rotation === 180
          ? [Math.abs(scaleX), Math.abs(scaleY)]
          : Math.abs(rotation) === 90
            ? [Math.abs(scaleY), Math.abs(scaleX)]
            : [uniform, uniform]
      const minSize = node.type === 'line' ? 0 : 1
      const size = {
        width: Math.max(minSize, Math.round(node.width * scaleW)),
        height: node.type === 'text' ? node.height : Math.max(minSize, Math.round(node.height * scaleH)),
      }
      const pose = poseInParent(scene, node.parentId, moved, getWorldRotation(scene, id), size)
      const patch = { x: pose.x, y: pose.y, ...size }
      if (node.type === 'text' && size.width !== node.width) {
        return updateNode(next, id, { ...patch, autoWidth: false })
      }
      return updateNode(next, id, patch)
    }

    const abs = getAbsoluteBounds(scene, id)
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
  }, scene)
}

/** 親が違うノードだけを parentId の最前面へ移す */
export function reparentNodes<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  parentId: NodeId | null,
): T {
  return sortByDocumentOrder(scene, topLevelIds(scene, ids)).reduce((next, id) => {
    if (next.nodes[id].parentId === parentId || isSelfOrAncestor(next, id, parentId)) return next
    return moveNode(next, id, parentId)
  }, scene)
}

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

  return targets.reduce((next, id) => {
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
    if (getWorldRotation(scene, id) !== 0) return updateNode(next, id, position)
    return updateNode(next, id, { x: Math.round(position.x), y: Math.round(position.y) })
  }, scene)
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
  return items.reduce((next, { id, bounds }) => {
    const delta = Math.round(position - bounds[axis])
    position += bounds[size] + gap
    return updateNode(next, id, shifted(scene, id, axis === 'x' ? delta : 0, axis === 'y' ? delta : 0))
  }, scene)
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
 * アセットは足さないので、ドキュメントへ貼るときは pasteIntoPage を使う。
 */
export function pasteFragment<T extends Scene>(
  scene: T,
  fragment: Fragment,
  offset = 0,
): { scene: T; ids: NodeId[] } {
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
  let next = scene
  for (const id of ids) {
    const { [id]: root, ...rest } = clones
    const parent = root.parentId === null ? undefined : scene.nodes[root.parentId]
    const parentId = parent?.type === 'frame' ? parent.id : null
    const center = { x: root.x + root.width / 2 + offset, y: root.y + root.height / 2 + offset }
    const pose = poseInParent(scene, parentId, center, root.rotation, root)
    const placed = { ...root, x: pose.x, y: pose.y, rotation: pose.rotation }
    // 子孫は親より先に nodes へ入れておく（重複して入れても同じ値なので害はない）
    next = insertNode({ ...next, nodes: { ...next.nodes, ...descendantsOf(rest, root) } }, placed, parentId)
  }
  return { scene: next, ids }
}

/** ページへ貼り付け、足りないアセットをドキュメントに足す */
export function pasteIntoPage(
  doc: DesignDocument,
  pageId: PageId,
  fragment: Fragment,
  offset = 0,
): { document: DesignDocument; ids: NodeId[] } {
  let ids: NodeId[] = []
  const pasted = updatePage(doc, pageId, (page) => {
    const result = pasteFragment(page, fragment, offset)
    ids = result.ids
    return result.scene
  })
  // 同じ id のアセットは中身も同じなので、すでにあるものはそのまま使う
  const missing = Object.keys(fragment.assets).some((id) => !Object.hasOwn(doc.assets, id))
  const document = missing ? { ...pasted, assets: { ...fragment.assets, ...doc.assets } } : pasted
  return { document, ids }
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
function collectSubtrees(scene: Scene, ids: readonly NodeId[]): NodeId[] {
  const result: NodeId[] = []
  const seen = new Set<NodeId>()
  const stack = ids.filter((id) => Object.hasOwn(scene.nodes, id)).reverse()
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
    const node = scene.nodes[id]
    if (node.type === 'frame') stack.push(...node.children.toReversed())
  }
  return result
}

/** target が id 自身か、id の子孫であるか */
function isSelfOrAncestor(scene: Scene, id: NodeId, target: NodeId | null): boolean {
  for (let current = target; current !== null; current = scene.nodes[current].parentId) {
    if (current === id) return true
  }
  return false
}

/** ページ直下のノードを 1 とした入れ子の深さ。ページ自体（null）は 0 */
export function getDepth(scene: Scene, id: NodeId | null): number {
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

function siblingsOf(scene: Scene, parentId: NodeId | null): NodeId[] {
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
  return { ...scene, nodes: { ...scene.nodes, [parentId]: { ...parent, children: ids } as SceneNode } }
}

function insertAt(ids: NodeId[], id: NodeId, index = ids.length): NodeId[] {
  const at = Math.max(0, Math.min(index, ids.length))
  return [...ids.slice(0, at), id, ...ids.slice(at)]
}
