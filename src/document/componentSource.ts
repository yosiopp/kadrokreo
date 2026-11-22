import { type InstanceNode, type MainNode, derivedId, isInstance, isMain, mainsOf, owningInstance } from './component.ts'
import type { DesignDocument, FrameNode, NodeId, Override, Page, Scene, SceneNode } from './types.ts'

// インスタンスの写しが、元のどのノードを写したものかをたどる関数。同期（editor/components.ts）と、
// viewer・editor のプロパティ（入れ子の中の入れ子への差し替えのプロパティ）が使う。
// 同期は写しを作り直すのに大きさや並びまで要るが、ここで要るのは木の形（どのノードがどのインスタンスか）だけなので、
// 差し替えた中身は形だけ作る（copyShape）。写しの id の決め方（derivedId）と差し替えの当て方は同期と同じにしてあるので、
// 同期した後のページの写しと同じ id の木になる。

/** 入れ子の深さの上限。同期の繰り返しの上限と同じ */
export const MAX_DEPTH = 8

/** コンポーネントの id から、その元（同じ id が複数あれば、先のページにあるもの） */
export function collectMains(doc: DesignDocument): Map<string, { page: Page; node: MainNode }> {
  const mains = new Map<string, { page: Page; node: MainNode }>()
  for (const page of doc.pages) {
    for (const [id, node] of mainsOf(page)) {
      if (!mains.has(id)) mains.set(id, { page, node })
    }
  }
  return mains
}

/** rootId とその子孫の id（rootId が先頭） */
export function subtreeIds(scene: Scene, rootId: NodeId): NodeId[] {
  const ids: NodeId[] = []
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop()!
    ids.push(id)
    const node = scene.nodes[id]
    if (node.type === 'frame') for (const child of node.children) stack.push(child)
  }
  return ids
}

/** id を含む、いちばん近い元のコンポーネントの id（id 自身は見ない）。なければ null */
export function enclosingMain(scene: Scene, id: NodeId): string | null {
  for (let current = scene.nodes[id].parentId; current !== null; current = scene.nodes[current].parentId) {
    const node = scene.nodes[current]
    if (isMain(node)) return node.component.id
  }
  return null
}

/**
 * 「コンポーネント from を置くと、その中に to が入るか」を答える関数。
 * 元 A の中に B のインスタンスがあれば「A は B を使う」として、使う関係をたどる。循環を見つけるのに使う。
 */
export function componentReach(
  doc: DesignDocument,
  mains: ReadonlyMap<string, { page: Page; node: MainNode }> = collectMains(doc),
): (from: string, to: string) => boolean {
  const uses = new Map<string, Set<string>>()
  for (const [id, main] of mains) {
    const used = new Set<string>()
    for (const nodeId of subtreeIds(main.page, main.node.id)) {
      const node = main.page.nodes[nodeId]
      if (nodeId === main.node.id || !isInstance(node)) continue
      used.add(node.component.id)
      // 中で入れ子のインスタンスを差し替えていれば、差し替え先も使っている
      for (const override of Object.values(node.component.overrides)) {
        if (override.componentId !== undefined) used.add(override.componentId)
      }
    }
    uses.set(id, used)
  }
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true
    if (seen.has(from)) return false
    seen.add(from)
    return [...(uses.get(from) ?? [])].some((next) => reaches(next, to, seen))
  }
  return (from, to) => reaches(from, to)
}

/** 元（rootId）の中での、id までのレイヤー名のたどり方。元そのものは空文字、元の中になければ null */
export function namePath(scene: Scene, rootId: NodeId, id: NodeId): string | null {
  const names: string[] = []
  for (let current: NodeId | null = id; current !== rootId; current = scene.nodes[current].parentId) {
    if (current === null) return null
    names.unshift(scene.nodes[current].name)
  }
  return names.join('\u0000')
}

/** rootId の中のノードを、rootId からのレイヤー名のたどり方で引けるようにしたもの（同じたどり方なら最初のもの） */
export function pathIndex(scene: Scene, rootId: NodeId): Map<string, NodeId> {
  const byPath = new Map<string, NodeId>()
  for (const id of subtreeIds(scene, rootId)) {
    const path = namePath(scene, rootId, id)
    if (path !== null && !byPath.has(path)) byPath.set(path, id)
  }
  return byPath
}

/**
 * 上書きを、元 previous の中から元 next の中へ移す。キーは、レイヤー名のたどり方（親から順の名前）が同じノードに付け替え、
 * 同じたどり方のノードがなければ捨てる（同じたどり方のものが複数あれば、最初に見つけたもの）。元そのものへの上書きは元へ
 */
export function moveOverrides(
  previous: { page: Scene; node: FrameNode },
  next: { page: Scene; node: FrameNode },
  overrides: Record<NodeId, Override>,
): Record<NodeId, Override> {
  const byPath = pathIndex(next.page, next.node.id)
  const moved: Record<NodeId, Override> = {}
  for (const [sourceId, override] of Object.entries(overrides)) {
    if (!Object.hasOwn(previous.page.nodes, sourceId)) continue
    const path = namePath(previous.page, previous.node.id, sourceId)
    const target = path === null ? undefined : byPath.get(path)
    if (target !== undefined) moved[target] = override
  }
  return moved
}

/**
 * インスタンスの中で差し替え先にできないコンポーネントを決める、コンポーネントの id の並び。
 * インスタンス自身の元と、インスタンスを含む元。差し替え先がこのどれかを含むと循環する
 */
export function swapChain(scene: Scene, instance: InstanceNode): string[] {
  const enclosing = enclosingMain(scene, instance.id)
  return enclosing === null ? [instance.component.id] : [instance.component.id, enclosing]
}

/** id が rootId の子孫か */
export function isInside(scene: Scene, id: NodeId, rootId: NodeId): boolean {
  for (let current = scene.nodes[id]?.parentId ?? null; current !== null; current = scene.nodes[current].parentId) {
    if (current === rootId) return true
  }
  return false
}

/** たどるあいだ使い回す、元の一覧と「含むか」の答え */
export type SourceContext = {
  doc: DesignDocument
  mains: ReadonlyMap<string, { page: Page; node: MainNode }>
  reaches: (from: string, to: string) => boolean
}

// ドキュメントは不変なので、ドキュメントごとに一度だけ作っておく（パネルが何度も呼ぶ）
const contexts = new WeakMap<DesignDocument, SourceContext>()

export function sourceContext(doc: DesignDocument): SourceContext {
  let ctx = contexts.get(doc)
  if (!ctx) {
    const mains = collectMains(doc)
    ctx = { doc, mains, reaches: componentReach(doc, mains) }
    contexts.set(doc, ctx)
  }
  return ctx
}

/**
 * id のノードが、どのインスタンスを写したものか（そのインスタンスのつながり）。インスタンスそのものならそのつながり、
 * インスタンスの写し（元の中に置いたインスタンスの写しや、そのまた中のインスタンスの写し、差し替えた先の中のインスタンスの写し）なら、
 * 写しをたどって見つけたもの。インスタンスに当たらなければ null
 */
export function representedLink(
  ctx: SourceContext,
  scene: Scene,
  id: NodeId,
  depth = 0,
): InstanceNode['component'] | null {
  const node = scene.nodes[id]
  if (isInstance(node)) return node.component
  if (node?.type !== 'frame' || depth >= MAX_DEPTH) return null
  const instance = owningInstance(scene, id)
  const main = instance ? ctx.mains.get(instance.component.id) : undefined
  if (!instance || !main) return null
  const tree = topologyOf(ctx, main.page, main.node.id, instance.component.overrides, swapChain(scene, instance), depth + 1)
  const sourceId = subtreeIds(tree, main.node.id).find(
    (candidate) => candidate !== main.node.id && derivedId(instance.id, candidate) === id,
  )
  return sourceId === undefined ? null : representedLink(ctx, tree, sourceId, depth + 1)
}

/**
 * 元 mainId の木（source）に、上書きの入れ子のインスタンスの差し替え（componentId）を当てた木の形。
 * 同期の swappedSource（editor/components.ts）と同じ順で当てるが、差し替えた中身は大きさや上書きの値を当てず、形だけ写す
 */
function topologyOf(
  ctx: SourceContext,
  source: Scene,
  mainId: NodeId,
  overrides: Record<NodeId, Override>,
  chain: readonly string[],
  depth: number,
): Scene {
  let scene = source
  let pending = Object.entries(overrides).filter(
    ([sourceId, override]) => override.componentId !== undefined && sourceId !== mainId,
  )
  while (pending.length > 0 && depth < MAX_DEPTH) {
    // 外側の差し替えでできるノードを指すものは、まだ木にない。次の回に回す
    const ready = pending.filter(([sourceId]) => Object.hasOwn(scene.nodes, sourceId))
    if (ready.length === 0) break
    pending = pending.filter(([sourceId]) => !Object.hasOwn(scene.nodes, sourceId))
    for (const [sourceId, override] of ready) {
      const componentId = override.componentId!
      if (!Object.hasOwn(scene.nodes, sourceId) || !isInside(scene, sourceId, mainId)) continue
      const nested = scene.nodes[sourceId]
      const link = representedLink(ctx, scene, sourceId, depth)
      if (nested.type !== 'frame' || !link || link.id === componentId) continue
      const next = ctx.mains.get(componentId)
      if (!next || chain.some((id) => ctx.reaches(componentId, id))) continue
      const previous = ctx.mains.get(link.id)
      const swapped: InstanceNode = {
        ...nested,
        component: {
          id: componentId,
          role: 'instance',
          overrides: previous ? moveOverrides(previous, next, link.overrides) : {},
        },
      }
      scene = copyShape(ctx, scene, swapped, next, [...chain, componentId], depth + 1)
    }
  }
  return scene
}

/** インスタンス instance の中身を、元 main（の差し替えを当てた木）の形の写しに置き換える */
function copyShape(
  ctx: SourceContext,
  scene: Scene,
  instance: InstanceNode,
  main: { page: Page; node: MainNode },
  chain: readonly string[],
  depth: number,
): Scene {
  const source = topologyOf(ctx, main.page, main.node.id, instance.component.overrides, chain, depth)
  const nodes = { ...scene.nodes }
  for (const id of subtreeIds(scene, instance.id)) delete nodes[id]
  const idFor = (sourceId: NodeId) => derivedId(instance.id, sourceId)
  nodes[instance.id] = { ...instance, children: main.node.children.map(idFor) }
  for (const sourceId of subtreeIds(source, main.node.id)) {
    if (sourceId === main.node.id) continue
    const node = source.nodes[sourceId]
    const copy = {
      ...node,
      id: idFor(sourceId),
      parentId: node.parentId === main.node.id ? instance.id : idFor(node.parentId!),
    } as SceneNode
    if (copy.type === 'frame') {
      copy.children = copy.children.map(idFor)
      copy.component = null
    }
    nodes[copy.id] = copy
  }
  return { ...scene, nodes }
}
