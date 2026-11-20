import { getAbsoluteBounds } from '../document/geometry.ts'
import type {
  ComponentLink,
  DesignDocument,
  FrameNode,
  NodeId,
  Override,
  Page,
  PageId,
  Scene,
  SceneNode,
  TextNode,
} from '../document/types.ts'
import { relayout } from './layout.ts'
import { createFrame, createId } from './nodes.ts'
import { insertNode, removeNodes, updateNode, updatePage } from './operations.ts'

// コンポーネント。フレームを「元（main）」として登録し、その写しである「インスタンス」を置ける。
// インスタンスの中身は、元の子孫をそのまま写した普通のノードで、ページに入っている。
// 元を変えたら syncComponents が写しを作り直す（ストアが変更のたびにかける）ので、
// 描画・当たり判定・viewer・書き出しは、コンポーネントのことを知らなくてよい。
//
// インスタンスごとに変えられるのは、文言・塗り・線の色・表示だけ（上書き）。上書きはインスタンスが持ち、
// 写しを作り直すたびに当て直す。編集する側は写しを普通のノードと同じように書き換えればよく、
// captureOverrides がその変更を上書きとして覚える（これもストアが変更のたびにかける）。
// それ以外の変更は覚えないので、次の同期で元に戻る。形や並びまで変えたければ切り離す。

type InstanceLink = Extract<ComponentLink, { role: 'instance' }>
export type InstanceNode = FrameNode & { component: InstanceLink }

/** テキストノードの大きさを中身に合わせ直す関数。文字の幅を測れる環境（ブラウザ）でだけ渡せる */
export type FitText = <T extends Scene>(scene: T, ids: readonly NodeId[]) => T

/** インスタンスごとに上書きできる項目 */
const OVERRIDE_KEYS = ['text', 'fill', 'fillGradient', 'stroke', 'visible'] as const

/** フレームをコンポーネントの元にする */
export function makeComponent<T extends Scene>(scene: T, id: NodeId): T {
  const node = scene.nodes[id]
  if (node?.type !== 'frame' || node.component) return scene
  return updateNode(scene, id, { component: { id: createId(), role: 'main' } })
}

/**
 * コンポーネントとのつながりを外して、ただのフレームに戻す。
 * 元から外すと、そのインスタンスは次の同期でただのフレームになる（中身は残る）。
 */
export function detachComponent<T extends Scene>(scene: T, id: NodeId): T {
  const node = scene.nodes[id]
  if (node?.type !== 'frame' || !node.component) return scene
  return updateNode(scene, id, { component: null })
}

/** ドキュメントの中から、コンポーネントの元を探す */
export function findMain(
  doc: DesignDocument,
  componentId: string,
): { page: Page; node: FrameNode } | null {
  for (const page of doc.pages) {
    for (const node of Object.values(page.nodes)) {
      if (node.type === 'frame' && node.component?.role === 'main' && node.component.id === componentId) {
        return { page, node }
      }
    }
  }
  return null
}

/**
 * 元（mainId）のインスタンスを、pageId のページ直下に置く。中身は次の同期で入る。
 * 元と同じページなら、元の少し右下に置く。
 */
export function createInstance(
  doc: DesignDocument,
  pageId: PageId,
  componentId: string,
): { document: DesignDocument; id: NodeId | null } {
  const main = findMain(doc, componentId)
  if (!main) return { document: doc, id: null }
  const bounds = main.page.id === pageId ? getAbsoluteBounds(main.page, main.node.id) : null
  const instance: FrameNode = {
    ...createFrame({
      x: bounds ? bounds.x + 20 : 0,
      y: bounds ? bounds.y + 20 : 0,
      width: main.node.width,
      height: main.node.height,
    }),
    name: main.node.name,
    component: { id: componentId, role: 'instance', overrides: {} },
  }
  return {
    document: updatePage(doc, pageId, (page) => insertNode(page, instance)),
    id: instance.id,
  }
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

/** インスタンス（の根）か、その中身が、元のどのノードに当たるか */
function sourceOf(
  doc: DesignDocument,
  scene: Scene,
  id: NodeId,
): { instance: InstanceNode; source: SceneNode } | null {
  const node = scene.nodes[id]
  const instance = isInstance(node) ? node : owningInstance(scene, id)
  if (!instance) return null
  const main = findMain(doc, instance.component.id)
  if (!main) return null
  if (instance.id === id) return { instance, source: main.node }
  const sourceId = subtreeIds(main.page, main.node.id).find(
    (candidate) => candidate !== main.node.id && derivedId(instance.id, candidate) === id,
  )
  return sourceId === undefined ? null : { instance, source: main.page.nodes[sourceId] }
}

/**
 * インスタンスやその中身に加えた変更のうち、上書きできる項目を、そのインスタンスの上書きとして覚える。
 * before は変更の前、after は変更の後のドキュメント。元と同じ値に戻した項目は、上書きから外す。
 * 上書きできない項目の変更はここでは何もしないので、次の同期で元に戻る。
 */
export function captureOverrides(before: DesignDocument, after: DesignDocument): DesignDocument {
  if (after === before) return after
  let changed = false
  const pages = after.pages.map((page) => {
    const old = before.pages.find((candidate) => candidate.id === page.id)
    if (!old || old === page) return page
    let next = page
    for (const node of Object.values(page.nodes)) {
      const previous = old.nodes[node.id]
      if (!previous || previous === node || previous.type !== node.type) continue
      const keys = OVERRIDE_KEYS.filter((key) => !sameValue(valueOf(previous, key), valueOf(node, key)))
      if (keys.length === 0) continue
      const found = sourceOf(after, next, node.id)
      if (!found) continue
      const { instance, source } = found
      // 変更の前から同じコンポーネントのインスタンスだったものだけ。貼り付けた直後などは、まだ写しができていない
      const was = old.nodes[instance.id]
      if (!isInstance(was) || was.component.id !== instance.component.id) continue

      const entry: Record<string, unknown> = { ...instance.component.overrides[source.id] }
      for (const key of keys) {
        // 根の表示・非表示は、インスタンス自身の設定
        if (key === 'visible' && node.id === instance.id) continue
        if (sameValue(valueOf(node, key), valueOf(source, key))) delete entry[key]
        else entry[key] = valueOf(node, key)
      }
      const overrides = { ...instance.component.overrides }
      delete overrides[source.id]
      if (Object.keys(entry).length > 0) overrides[source.id] = entry as Override
      next = updateNode(next, instance.id, { component: { ...instance.component, overrides } })
    }
    if (next !== page) changed = true
    return next
  })
  return changed ? { ...after, pages } : after
}

/** 上書きがあるか。id がインスタンスならどこか 1 つでも、その中身ならそのノードについて */
export function hasOverrides(doc: DesignDocument, scene: Scene, id: NodeId): boolean {
  const found = sourceOf(doc, scene, id)
  if (!found) return false
  const { overrides } = found.instance.component
  return found.instance.id === id ? Object.keys(overrides).length > 0 : Object.hasOwn(overrides, found.source.id)
}

/**
 * 上書きを捨てて、元と同じ見た目に戻す（実際に戻るのは次の同期）。
 * id がインスタンスならすべての上書きを、その中身ならそのノードの分だけを捨てる。
 */
export function resetOverrides(
  doc: DesignDocument,
  pageId: PageId,
  ids: readonly NodeId[],
): DesignDocument {
  return updatePage(doc, pageId, (page) =>
    ids.reduce((next, id) => {
      if (!hasOverrides(doc, next, id)) return next
      const { instance, source } = sourceOf(doc, next, id)!
      const overrides = instance.id === id ? {} : { ...instance.component.overrides }
      delete overrides[source.id]
      return updateNode(next, instance.id, { component: { ...instance.component, overrides } })
    }, page),
  )
}

/**
 * すべてのインスタンスの中身を、元に合わせて作り直す。
 * 元がなくなったインスタンスは、ただのフレームにする。すでに合っていれば同じ参照を返す。
 * fitText を渡すと、文言を上書きしたテキストの大きさを測り直す。
 */
export function syncComponents(doc: DesignDocument, fitText?: FitText): DesignDocument {
  // 元の中にインスタンスがあると、内側から順に直す必要がある。変化がなくなるまで繰り返す
  let current = doc
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = syncOnce(current, fitText)
    if (next === current) break
    current = next
  }
  return current
}

/** 入れ子の深さの上限を兼ねる。これより深い入れ子は、次の変更のときに続きが直る */
const MAX_PASSES = 8

function syncOnce(doc: DesignDocument, fitText: FitText | undefined): DesignDocument {
  const mains = new Map<string, { page: Page; node: FrameNode }>()
  for (const page of doc.pages) {
    for (const node of Object.values(page.nodes)) {
      if (node.type === 'frame' && node.component?.role === 'main' && !mains.has(node.component.id)) {
        mains.set(node.component.id, { page, node })
      }
    }
  }

  // 元 A の中に B のインスタンスがあれば「A は B を使う」。循環を見つけるのに使う
  const uses = new Map<string, Set<string>>()
  for (const [id, main] of mains) {
    const used = new Set<string>()
    for (const nodeId of subtreeIds(main.page, main.node.id)) {
      const node = main.page.nodes[nodeId]
      if (nodeId === main.node.id || node.type !== 'frame') continue
      if (node.component?.role === 'instance') used.add(node.component.id)
    }
    uses.set(id, used)
  }
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true
    if (seen.has(from)) return false
    seen.add(from)
    return [...(uses.get(from) ?? [])].some((next) => reaches(next, to, seen))
  }

  let changed = false
  const pages = doc.pages.map((page) => {
    let next = page
    for (const node of Object.values(page.nodes)) {
      // 作り直しの途中で消えたノードは飛ばす
      const instance = next.nodes[node.id]
      if (!isInstance(instance)) continue
      const main = mains.get(instance.component.id)
      // 元がない、または自分自身を含むことになる（循環する）なら、ただのフレームにする
      const enclosing = enclosingMain(next, instance.id)
      if (!main || (enclosing !== null && reaches(main.node.component!.id, enclosing))) {
        next = updateNode(next, instance.id, { component: null })
        continue
      }
      next = rebuild(next, instance, main.page, main.node, fitText)
    }
    if (next !== page) changed = true
    return next
  })
  return changed ? { ...doc, pages } : doc
}

/** id を含む、いちばん近い元のコンポーネントの id。なければ null */
function enclosingMain(scene: Scene, id: NodeId): string | null {
  for (let current = scene.nodes[id].parentId; current !== null; current = scene.nodes[current].parentId) {
    const node = scene.nodes[current]
    if (node.type === 'frame' && node.component?.role === 'main') return node.component.id
  }
  return null
}

function subtreeIds(scene: Scene, rootId: NodeId): NodeId[] {
  const ids: NodeId[] = []
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop()!
    ids.push(id)
    const node = scene.nodes[id]
    if (node.type === 'frame') stack.push(...node.children)
  }
  return ids
}

/** インスタンスの中身を、元の写しに上書きを当てたものに置き換える。すでに同じなら何もしない */
function rebuild(
  page: Page,
  instance: InstanceNode,
  source: Scene,
  main: FrameNode,
  fitText: FitText | undefined,
): Page {
  // 写しの id は「インスタンスの id + 元のノードの id」から決める。同じ元からは毎回同じ id になるので、
  // 元が変わっていなければ、作り直しても何も変わらない
  const idFor = (sourceId: NodeId) => derivedId(instance.id, sourceId)

  // 元から消えたノードへの上書きは捨てる
  const sourceIds = subtreeIds(source, main.id)
  const overrides: Record<NodeId, Override> = {}
  for (const sourceId of sourceIds) {
    const override = instance.component.overrides[sourceId]
    if (override) overrides[sourceId] = override
  }

  let expected: Record<NodeId, SceneNode> = {}
  const root: FrameNode = {
    ...main,
    // 置き場所と表示の設定は、インスタンスごとに持つ
    id: instance.id,
    name: instance.name,
    parentId: instance.parentId,
    x: instance.x,
    y: instance.y,
    rotation: instance.rotation,
    visible: instance.visible,
    locked: instance.locked,
    opacity: instance.opacity,
    component: { ...instance.component, overrides },
    children: main.children.map(idFor),
  }
  expected[instance.id] = applyOverride(root, overrides[main.id], true)

  // 文言を上書きしたテキストのうち、大きさを測り直すもの
  const stale: NodeId[] = []
  for (const sourceId of sourceIds) {
    if (sourceId === main.id) continue
    const node = source.nodes[sourceId]
    let copy = applyOverride(
      {
        ...node,
        id: idFor(sourceId),
        parentId: node.parentId === main.id ? instance.id : idFor(node.parentId!),
      },
      overrides[sourceId],
      false,
    )
    if (copy.type === 'frame') {
      copy.children = copy.children.map(idFor)
      // 写しの中にあるのは、ただの写し。入れ子のインスタンスとして別に同期されないようにする
      copy.component = null
    }
    if (copy.type === 'text' && node.type === 'text' && copy.text !== node.text) {
      // 文言が違えば大きさも違う。いまの写しが同じ文言と書式なら、その大きさは測ってあるのでそのまま使う
      const current = page.nodes[copy.id]
      if (current?.type === 'text' && sameTextStyle(current, copy)) {
        copy = { ...copy, width: current.width, height: current.height }
      } else {
        stale.push(copy.id)
      }
    }
    expected[copy.id] = copy
  }
  if (Object.keys(overrides).length > 0) {
    // 上書きで大きさや表示が変わると、自動で並べるフレームの並びも元とは変わる
    const scene: Scene = { nodes: expected, rootIds: [instance.id] }
    expected = relayout(fitText ? fitText(scene, stale) : scene).nodes
  }

  const currentIds = subtreeIds(page, instance.id)
  const same =
    currentIds.length === Object.keys(expected).length &&
    currentIds.every((id) => sameNode(page.nodes[id], expected[id]))
  if (same) return page

  // 写しと同じ id のノードがインスタンスの外にあれば（写しを外へ出してしまったとき）、二重にならないよう消す
  const inside = new Set(currentIds)
  const strays = Object.keys(expected).filter((id) => Object.hasOwn(page.nodes, id) && !inside.has(id))
  const cleaned = strays.length > 0 ? removeNodes(page, strays) : page

  const nodes = { ...cleaned.nodes }
  for (const id of currentIds) delete nodes[id]
  return { ...cleaned, nodes: { ...nodes, ...expected } }
}

/** 上書きのうち、このノードに当てられるものを当てる。root はインスタンスの根 */
function applyOverride<N extends SceneNode>(node: N, values: Override | undefined, root: boolean): N {
  if (!values) return node
  const patch: Override = {}
  if (values.text !== undefined && node.type === 'text') patch.text = values.text
  // テキストは塗りを、直線は線を消せない
  if (values.fill !== undefined && 'fill' in node && (values.fill !== null || node.type !== 'text')) {
    patch.fill = values.fill
  }
  if (values.fillGradient !== undefined && 'fillGradient' in node) patch.fillGradient = values.fillGradient
  if (values.stroke !== undefined && 'stroke' in node && (values.stroke !== null || node.type !== 'line')) {
    patch.stroke = values.stroke
  }
  // 根の表示・非表示は、インスタンス自身の設定
  if (values.visible !== undefined && !root) patch.visible = values.visible
  return { ...node, ...patch }
}

/** 大きさを決める項目が同じか（同じなら、測った大きさも同じになる） */
function sameTextStyle(a: TextNode, b: TextNode): boolean {
  return (
    a.text === b.text &&
    a.fontSize === b.fontSize &&
    a.fontFamily === b.fontFamily &&
    a.fontWeight === b.fontWeight &&
    a.lineHeight === b.lineHeight &&
    a.autoWidth === b.autoWidth &&
    (a.autoWidth || a.width === b.width)
  )
}

function valueOf(node: SceneNode, key: string): unknown {
  return (node as Record<string, unknown>)[key]
}

function sameValue(a: unknown, b: unknown): boolean {
  return Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b)
}

/** 項目の並び順が違っていても（ファイルから読んだノードと、編集中に作ったノードなど）同じとみなす */
function sameNode(a: SceneNode, b: SceneNode | undefined): boolean {
  if (b === undefined) return false
  const left: Record<string, unknown> = a
  const right: Record<string, unknown> = b
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => sameValue(left[key], right[key]))
  )
}

/** 2 つの id から決まる id。文字列のハッシュ（cyrb53）を 36 進数にしたもの */
function derivedId(instanceId: NodeId, sourceId: NodeId): NodeId {
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
