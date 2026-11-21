import {
  type InstanceNode,
  type MainNode,
  OVERRIDE_KEYS,
  derivedId,
  findMain,
  instanceOf,
  isInstance,
  isMain,
  mainsOf,
  owningInstance,
} from '../document/component.ts'
import { type Point, getAbsoluteBounds, poseInParent } from '../document/geometry.ts'
import type {
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

/** テキストノードの大きさを中身に合わせ直す関数。文字の幅を測れる環境（ブラウザ）でだけ渡せる */
export type FitText = <T extends Scene>(scene: T, ids: readonly NodeId[]) => T

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

/** インスタンスを置く場所。center はページ上での中心、parentId は入れるフレーム（null ならページ直下） */
export type InstancePlacement = { center: Point; parentId: NodeId | null }

/**
 * 元（mainId）のインスタンスを pageId のページに置く。中身は次の同期で入る。
 * at を省くと、元と同じページなら元の少し右下、別のページなら原点に、ページ直下で置く。
 * at の親に入れると元が自分自身を含むことになる（循環する）なら、ページ直下に置く。
 */
export function createInstance(
  doc: DesignDocument,
  pageId: PageId,
  componentId: string,
  at?: InstancePlacement,
): { document: DesignDocument; id: NodeId | null } {
  const main = findMain(doc, componentId)
  const page = doc.pages.find((candidate) => candidate.id === pageId)
  if (!main || !page) return { document: doc, id: null }
  const size = { width: main.node.width, height: main.node.height }
  let parentId: NodeId | null = null
  let position = { x: 0, y: 0 }
  if (at) {
    parentId = at.parentId !== null && canHoldInstance(doc, page, at.parentId, componentId) ? at.parentId : null
    const pose = poseInParent(page, parentId, at.center, 0, size)
    position = { x: Math.round(pose.x), y: Math.round(pose.y) }
  } else if (main.page.id === pageId) {
    const bounds = getAbsoluteBounds(main.page, main.node.id)
    position = { x: bounds.x + 20, y: bounds.y + 20 }
  }
  const instance: FrameNode = {
    ...createFrame({ ...position, ...size }),
    name: main.node.name,
    component: { id: componentId, role: 'instance', overrides: {} },
  }
  return {
    document: updatePage(doc, pageId, (base) => insertNode(base, instance, parentId)),
    id: instance.id,
  }
}

/**
 * parentId のフレームの中に、componentId のインスタンスを入れてよいか。
 * インスタンスやその中身の中へは入れられず、元の中に入れると元が自分自身を含むことになる（循環する）なら入れられない。
 */
export function canHoldInstance(doc: DesignDocument, scene: Scene, parentId: NodeId, componentId: string): boolean {
  const parent = scene.nodes[parentId]
  if (parent?.type !== 'frame' || instanceOf(scene, parentId)) return false
  const enclosing = isMain(parent) ? parent.component.id : enclosingMain(scene, parentId)
  return enclosing === null || !componentReach(doc)(componentId, enclosing)
}

/**
 * インスタンスを、別のコンポーネントのインスタンスに差し替える。位置・名前以外の見た目は、次の同期で新しい元に合わせる。
 * 上書きは、元の中でのレイヤー名のたどり方（親から順の名前）が同じノードがあれば、そちらへ移す。なければ捨てる。
 * 差し替えると循環する（インスタンスが入っている元を、新しい元が含むことになる）なら変えない。
 */
export function swapComponent(doc: DesignDocument, pageId: PageId, instanceId: NodeId, componentId: string): DesignDocument {
  const page = doc.pages.find((candidate) => candidate.id === pageId)
  const instance = page?.nodes[instanceId]
  if (!page || !isInstance(instance) || instance.component.id === componentId) return doc
  if (owningInstance(page, instanceId)) return doc
  const parentId = instance.parentId
  if (parentId !== null && !canHoldInstance(doc, page, parentId, componentId)) return doc
  const next = findMain(doc, componentId)
  if (!next) return doc

  const previous = findMain(doc, instance.component.id)
  const overrides: Record<NodeId, Override> = {}
  if (previous) {
    // 新しい元の中のノードを、名前のたどり方で引けるようにする（同じたどり方のものが複数あれば、最初に見つけたもの）
    const byPath = new Map<string, NodeId>()
    for (const id of subtreeIds(next.page, next.node.id)) {
      const path = namePath(next.page, next.node.id, id)
      if (path !== null && !byPath.has(path)) byPath.set(path, id)
    }
    for (const [sourceId, override] of Object.entries(instance.component.overrides)) {
      if (!Object.hasOwn(previous.page.nodes, sourceId)) continue
      const path = namePath(previous.page, previous.node.id, sourceId)
      const target = path === null ? undefined : byPath.get(path)
      if (target !== undefined) overrides[target] = override
    }
  }
  return updatePage(doc, pageId, (base) =>
    updateNode(base, instanceId, {
      name: instance.name === previous?.node.name ? next.node.name : instance.name,
      component: { id: componentId, role: 'instance', overrides },
    }),
  )
}

/** 元（rootId）の中での、id までのレイヤー名のたどり方。元そのものは空文字、元の中になければ null */
function namePath(scene: Scene, rootId: NodeId, id: NodeId): string | null {
  const names: string[] = []
  for (let current: NodeId | null = id; current !== rootId; current = scene.nodes[current].parentId) {
    if (current === null) return null
    names.unshift(scene.nodes[current].name)
  }
  return names.join('\u0000')
}

/** ドキュメントにあるコンポーネントの元。ページの順、ページの中では作った順 */
export function listComponents(doc: DesignDocument): { page: Page; node: MainNode }[] {
  return doc.pages.flatMap((page) =>
    [...mainsOf(page).values()]
      .filter((node) => findMain(doc, node.component.id)?.node === node)
      .map((node) => ({ page, node })),
  )
}

/**
 * ids のうち、インスタンスの中身（写し）でないもの。
 * 写しは色や文言を上書きできるだけで、動かす・消す・複製するといった操作の対象にはしない。
 */
export function withoutCopies(scene: Scene, ids: readonly NodeId[]): NodeId[] {
  return ids.filter((id) => !owningInstance(scene, id))
}

type Source = { instance: InstanceNode; source: SceneNode }

/** インスタンス（の根）か、その中身が、元のどのノードに当たるか */
function sourceOf(doc: DesignDocument, scene: Scene, id: NodeId): Source | null {
  const instance = instanceOf(scene, id)
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
  return found !== null && overridden(found, id)
}

function overridden({ instance, source }: Source, id: NodeId): boolean {
  const { overrides } = instance.component
  return instance.id === id ? Object.keys(overrides).length > 0 : Object.hasOwn(overrides, source.id)
}

/** id（インスタンスの根か、その中身）が、元と違えている項目。根なら、根そのものへの上書きだけ */
export function overriddenKeys(doc: DesignDocument, scene: Scene, id: NodeId): (keyof Override)[] {
  const found = sourceOf(doc, scene, id)
  if (!found) return []
  const override = found.instance.component.overrides[found.source.id]
  return OVERRIDE_KEYS.filter((key) => override?.[key] !== undefined)
}

/**
 * ids の上書きを元に書き込み、上書きを外す。インスタンスの根ならそのインスタンスのすべての上書きを、中身ならそのノードの分を移す。
 * 元を使っているほかのインスタンスにも、次の同期で同じ値が入る（そのインスタンスが上書きしていなければ）。
 * 根の表示・非表示はインスタンスごとの設定なので、元には移さない。fitText を渡すと、元のテキストの大きさを測り直す。
 */
export function pushOverrides(
  doc: DesignDocument,
  pageId: PageId,
  ids: readonly NodeId[],
  fitText?: FitText,
): DesignDocument {
  return ids.reduce((current, id) => {
    const page = current.pages.find((candidate) => candidate.id === pageId)
    const found = page ? sourceOf(current, page, id) : null
    if (!found) return current
    const { instance, source } = found
    const main = findMain(current, instance.component.id)
    if (!main) return current
    const sourceIds = instance.id === id ? Object.keys(instance.component.overrides) : [source.id]
    let next = current
    const overrides = { ...instance.component.overrides }
    for (const sourceId of sourceIds) {
      const override = overrides[sourceId]
      const target = main.page.nodes[sourceId]
      if (!override || !target) continue
      delete overrides[sourceId]
      const pushed = applyOverride(target, override, sourceId === main.node.id)
      next = updatePage(next, main.page.id, (base) => {
        const changed = { ...base, nodes: { ...base.nodes, [sourceId]: pushed } }
        return fitText && pushed.type === 'text' ? fitText(changed, [sourceId]) : changed
      })
    }
    return updatePage(next, pageId, (base) =>
      updateNode(base, instance.id, { component: { ...instance.component, overrides } }),
    )
  }, doc)
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
      const found = sourceOf(doc, next, id)
      if (!found || !overridden(found, id)) return next
      const { instance, source } = found
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
  const mains = collectMains(doc)
  const reaches = componentReach(doc, mains)

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
      if (!main || (enclosing !== null && reaches(instance.component.id, enclosing))) {
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

/**
 * 「コンポーネント from を置くと、その中に to が入るか」を答える関数。
 * 元 A の中に B のインスタンスがあれば「A は B を使う」として、使う関係をたどる。循環を見つけるのに使う。
 */
function componentReach(
  doc: DesignDocument,
  mains: ReadonlyMap<string, { page: Page; node: MainNode }> = collectMains(doc),
): (from: string, to: string) => boolean {
  const uses = new Map<string, Set<string>>()
  for (const [id, main] of mains) {
    const used = new Set<string>()
    for (const nodeId of subtreeIds(main.page, main.node.id)) {
      const node = main.page.nodes[nodeId]
      if (nodeId !== main.node.id && isInstance(node)) used.add(node.component.id)
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

/** コンポーネントの id から、その元（同じ id が複数あれば、先のページにあるもの） */
function collectMains(doc: DesignDocument): Map<string, { page: Page; node: MainNode }> {
  const mains = new Map<string, { page: Page; node: MainNode }>()
  for (const page of doc.pages) {
    for (const [id, node] of mainsOf(page)) {
      if (!mains.has(id)) mains.set(id, { page, node })
    }
  }
  return mains
}

/** id を含む、いちばん近い元のコンポーネントの id。なければ null */
function enclosingMain(scene: Scene, id: NodeId): string | null {
  for (let current = scene.nodes[id].parentId; current !== null; current = scene.nodes[current].parentId) {
    const node = scene.nodes[current]
    if (isMain(node)) return node.component.id
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
  const expected = expectedCopies(page, instance, source, main, fitText)
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
  Object.assign(nodes, expected)
  return { ...cleaned, nodes }
}

/**
 * インスタンスと、その中身のあるべき姿。元の写しに、そのインスタンスの上書きを当てたもの。
 * page は、いまの写しが持っている「測ってある大きさ」を引き継ぐためにだけ見る。
 */
function expectedCopies(
  page: Page,
  instance: InstanceNode,
  source: Scene,
  main: FrameNode,
  fitText: FitText | undefined,
): Record<NodeId, SceneNode> {
  // 写しの id は「インスタンスの id + 元のノードの id」から決める。同じ元からは毎回同じ id になるので、
  // 元が変わっていなければ、作り直しても何も変わらない
  const sourceIds = subtreeIds(source, main.id)
  const copyIds = new Map(sourceIds.map((sourceId) => [sourceId, derivedId(instance.id, sourceId)]))
  const idFor = (sourceId: NodeId) => copyIds.get(sourceId) ?? derivedId(instance.id, sourceId)

  // 元から消えたノードへの上書きは捨てる
  const overrides: Record<NodeId, Override> = {}
  for (const sourceId of sourceIds) {
    const override = instance.component.overrides[sourceId]
    if (override) overrides[sourceId] = override
  }

  const expected: Record<NodeId, SceneNode> = {}
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
    if (copy.type === 'text' && node.type === 'text' && !sameTextStyle(copy, node)) {
      // 文言や書式が違えば大きさも違う。いまの写しが同じ文言と書式なら、その大きさは測ってあるのでそのまま使う
      const current = page.nodes[copy.id]
      if (current?.type === 'text' && sameTextStyle(current, copy)) {
        copy = { ...copy, width: current.width, height: current.height }
      } else {
        stale.push(copy.id)
      }
    }
    expected[copy.id] = copy
  }
  if (Object.keys(overrides).length === 0) return expected
  // 上書きで大きさや表示が変わると、自動で並べるフレームの並びも元とは変わる
  const scene: Scene = { nodes: expected, rootIds: [instance.id] }
  return relayout(fitText ? fitText(scene, stale) : scene).nodes
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
  if (node.type === 'text') {
    if (values.fontSize !== undefined) patch.fontSize = values.fontSize
    if (values.fontFamily !== undefined) patch.fontFamily = values.fontFamily
    if (values.fontWeight !== undefined) patch.fontWeight = values.fontWeight
  }
  if (values.assetId !== undefined && node.type === 'image') patch.assetId = values.assetId
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
