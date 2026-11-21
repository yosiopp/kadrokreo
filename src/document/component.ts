import type {
  ComponentLink,
  ComponentProperty,
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

/** プロパティの値。text は文言、boolean は表示、instance は入れ子のインスタンスの元（コンポーネントの id） */
export type PropertyValue = string | boolean

/** インスタンスでのプロパティの値と、元と違えているか */
export type PropertyState = { property: ComponentProperty; value: PropertyValue; overridden: boolean }

/** プロパティを結べるノードか（元 main の中にあり、元そのものでも写しでもなく、種類が合う） */
export function canBindProperty(scene: Scene, mainId: NodeId, type: ComponentProperty['type'], targetId: NodeId): boolean {
  const target = scene.nodes[targetId]
  if (!target || targetId === mainId || owningInstance(scene, targetId)) return false
  // いちばん近い元が main であること（間に別の元があれば、そちらのプロパティになる）
  let current = target.parentId
  while (current !== null && current !== mainId && !isMain(scene.nodes[current])) current = scene.nodes[current].parentId
  if (current !== mainId) return false
  if (type === 'text') return target.type === 'text'
  if (type === 'instance') return isInstance(target)
  return true
}

/** id を含む、いちばん近い元。id が元ならそれ自身。なければ null */
export function enclosingMainNode(scene: Scene, id: NodeId): MainNode | null {
  for (let current: NodeId | null = id; current !== null; current = scene.nodes[current].parentId) {
    const node = scene.nodes[current]
    if (isMain(node)) return node
  }
  return null
}

/**
 * インスタンスでの、元のプロパティの値。結んだノードのうち最初の有効なものの写しから読む（写しには上書きも入っている）。
 * 有効なノードがないプロパティは出さない
 */
export function instanceProperties(doc: DesignDocument, scene: Scene, instance: InstanceNode): PropertyState[] {
  const main = findMain(doc, instance.component.id)
  if (!main) return []
  const states: PropertyState[] = []
  for (const property of main.node.component.properties) {
    const target = property.targets.find((id) => canBindProperty(main.page, main.node.id, property.type, id))
    if (target === undefined) continue
    const override = instance.component.overrides[target]
    const source = main.page.nodes[target]
    const copy = scene.nodes[derivedId(instance.id, target)]
    if (property.type === 'instance') {
      const value = override?.componentId ?? (isInstance(source) ? source.component.id : '')
      states.push({ property, value, overridden: override?.componentId !== undefined })
    } else if (property.type === 'text') {
      const value = copy?.type === 'text' ? copy.text : source.type === 'text' ? source.text : ''
      states.push({ property, value, overridden: override?.text !== undefined })
    } else {
      states.push({ property, value: copy?.visible ?? source.visible, overridden: override?.visible !== undefined })
    }
  }
  return states
}
