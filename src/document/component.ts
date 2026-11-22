import type {
  ComponentLink,
  DesignDocument,
  FrameNode,
  NodeId,
  Override,
  Page,
  Scene,
  SceneNode,
} from './types.ts'

// コンポーネントのつながりを読むための関数。同期や編集（editor/components.ts）と、viewer の表示の両方が使う。

export type MainNode = FrameNode & { component: Extract<ComponentLink, { role: 'main' }> }
export type InstanceNode = FrameNode & { component: Extract<ComponentLink, { role: 'instance' }> }

/** インスタンスごとに上書きできる項目 */
export const OVERRIDE_KEYS = [
  'text',
  'fills',
  'strokes',
  'visible',
  'fontSize',
  'fontFamily',
  'fontWeight',
  'assetId',
  'componentId',
] as const satisfies readonly (keyof Override)[]

/** コンポーネントの元か */
export function isMain(node: SceneNode | undefined): node is MainNode {
  return node?.type === 'frame' && node.component?.role === 'main'
}

/** インスタンスか（中へ入れたり、中身を動かしたりできない） */
export function isInstance(node: SceneNode | undefined): node is InstanceNode {
  return node?.type === 'frame' && node.component?.role === 'instance'
}

/** id がインスタンスの中身（写し）なら、そのインスタンス。インスタンス自身や、ふつうのノードなら null */
export function owningInstance(scene: Scene, id: NodeId): InstanceNode | null {
  let current = scene.nodes[id]?.parentId ?? null
  while (current !== null) {
    const node = scene.nodes[current]
    if (isInstance(node)) return node
    current = node.parentId
  }
  return null
}

/** id がインスタンスか、その中身なら、そのインスタンス */
export function instanceOf(scene: Scene, id: NodeId): InstanceNode | null {
  const node = scene.nodes[id]
  return isInstance(node) ? node : owningInstance(scene, id)
}

// ページは不変なので、ページごとに一度だけ元を集めておく（探すたびに全ノードを見ない）
const mainsByPage = new WeakMap<Page, ReadonlyMap<string, MainNode>>()

/** ページにある元を、コンポーネントの id から引けるようにしたもの。同じ id の元が複数あれば、先にあるもの */
export function mainsOf(page: Page): ReadonlyMap<string, MainNode> {
  let mains = mainsByPage.get(page)
  if (!mains) {
    const found = new Map<string, MainNode>()
    for (const node of Object.values(page.nodes)) {
      if (isMain(node) && !found.has(node.component.id)) found.set(node.component.id, node)
    }
    mainsByPage.set(page, found)
    mains = found
  }
  return mains
}

/**
 * 元の集まりが page と同じだと分かっている next に、page で集めたものを引き継ぐ（同期が使う）。
 * 同期はインスタンスの中身だけを入れ替え、元のノードには触らないので、毎回ページの全部のノードを見直さずに済む
 */
export function inheritMains(next: Page, page: Page): void {
  const mains = mainsByPage.get(page)
  if (mains && !mainsByPage.has(next)) mainsByPage.set(next, mains)
}

/** ドキュメントの中から、コンポーネントの元を探す */
export function findMain(doc: DesignDocument, componentId: string): { page: Page; node: MainNode } | null {
  for (const page of doc.pages) {
    const node = mainsOf(page).get(componentId)
    if (node) return { page, node }
  }
  return null
}

/**
 * インスタンスの中身（写し）の id。インスタンスの id と、元の側のノードの id から決まる。
 * 文字列のハッシュ（cyrb53）を 36 進数にしたもの。
 */
export function derivedId(instanceId: NodeId, sourceId: NodeId): NodeId {
  // 同期は元が変わるたびに全部の写しの id を出し直すので、出したものを覚えておく（large で 1 回 2ms ほど）
  let bySource = derivedIds.get(instanceId)
  if (bySource === undefined) {
    if (derivedIds.size >= MAX_DERIVED_INSTANCES) derivedIds.clear()
    bySource = new Map()
    derivedIds.set(instanceId, bySource)
  }
  let id = bySource.get(sourceId)
  if (id === undefined) {
    id = hashId(instanceId, sourceId)
    bySource.set(sourceId, id)
  }
  return id
}

const derivedIds = new Map<NodeId, Map<NodeId, NodeId>>()
const MAX_DERIVED_INSTANCES = 20_000

function hashId(instanceId: NodeId, sourceId: NodeId): NodeId {
  const text = `${instanceId}:${sourceId}`
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `i${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`
}
