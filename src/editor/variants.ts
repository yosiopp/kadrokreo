import { type MainNode, findMain, isInstance, isMain, mainsOf, owningInstance } from '../document/component.ts'
import { findPage } from '../document/pages.ts'
import type { DesignDocument, NodeId, Page, PageId, Scene } from '../document/types.ts'
import {
  type VariantProps,
  formatVariantName,
  parseVariantName,
  pickVariant,
  propValue,
  variantProperties,
  variantSetOf,
  variantsIn,
} from '../document/variants.ts'
import { inheritComponentProperties } from './componentProperties.ts'
import { swapComponent } from './components.ts'
import { wrapInAutoLayout } from './layout.ts'
import { createId } from './nodes.ts'
import { copyFragment, pasteFragment } from './operations/clipboard.ts'
import { updatePage } from './operations/document.ts'
import { moveNode, updateNode } from './operations/tree.ts'

// バリアントを作る・選ぶ操作。バリアントの表し方（名前の形とまとまり）は document/variants.ts を参照。

/** まとめるときに、名前がプロパティの形でない元へ付けるプロパティ */
const DEFAULT_PROPERTY = '種類'
const DEFAULT_VALUE = '標準'
/** まとまりの余白とバリアントどうしの間隔 */
const SET_SPACING = 20

/**
 * 元 mainId のバリアントを 1 つ増やす（元を複製して、新しいコンポーネントの元にする）。
 * 元がまだまとまりに入っていなければ、元を自動で並べるフレーム（まとまり）で包み、まとまりには元の名前を、
 * 元には「種類=標準」を付ける（名前がすでにプロパティの形なら、そのまま）。
 * 増やしたバリアントは元のすぐ後ろに入り、最後のプロパティの値だけが新しい値（2, 3, …）になる。
 */
export function addVariant(
  doc: DesignDocument,
  pageId: PageId,
  mainId: NodeId,
): { document: DesignDocument; id: NodeId | null } {
  let id: NodeId | null = null
  const document = updatePage(doc, pageId, (page) => {
    const main = page.nodes[mainId]
    if (!isMain(main) || owningInstance(page, mainId)) return page
    let scene = page
    let setId = variantSetOf(page, mainId)?.id ?? null
    if (setId === null) {
      const props = parseVariantName(main.name)
      const wrapped = wrapInAutoLayout(scene, [mainId], props ? 'Variants' : main.name)
      if (wrapped.id === null) return page
      setId = wrapped.id
      const set = wrapped.scene.nodes[setId]
      if (set.type !== 'frame' || !set.layout) return page
      scene = updateNode(wrapped.scene, setId, {
        // 余白を付けても、元のページ上の位置は変わらないように
        x: set.x - SET_SPACING,
        y: set.y - SET_SPACING,
        layout: {
          ...set.layout,
          gap: SET_SPACING,
          crossGap: SET_SPACING,
          paddingTop: SET_SPACING,
          paddingRight: SET_SPACING,
          paddingBottom: SET_SPACING,
          paddingLeft: SET_SPACING,
        },
      })
      if (!props) scene = updateNode(scene, mainId, { name: formatVariantName([[DEFAULT_PROPERTY, DEFAULT_VALUE]]) })
    }

    const source = scene.nodes[mainId]
    const props = parseVariantName(source.name) ?? []
    const pasted = pasteFragment(scene, copyFragment(scene, doc.assets, [mainId]))
    const copyId = pasted.ids[0]
    // 貼り付けた元はインスタンスになるので、新しいコンポーネントの元に戻す
    scene = updateNode(pasted.scene, copyId, {
      name: formatVariantName(nextVariantProps(scene, setId, props)),
      component: { id: createId(), role: 'main', description: '', properties: [] },
    })
    // プロパティはまとまりで揃えるので、複製したバリアントも同じプロパティを持ち、同じたどり方のノードに結ぶ
    scene = inheritComponentProperties(scene, mainId, copyId, doc)
    const set = scene.nodes[setId]
    if (set.type === 'frame') scene = moveNode(scene, copyId, setId, set.children.indexOf(mainId) + 1)
    id = copyId
    return scene
  })
  return { document, id }
}

/** まとまりの中にまだない組み合わせになるよう、最後のプロパティの値を 2, 3, … と変えたもの */
function nextVariantProps(scene: Scene, setId: NodeId, props: VariantProps): VariantProps {
  if (props.length === 0) return [[DEFAULT_PROPERTY, '2']]
  const names = new Set(variantsIn(scene, setId).map((variant) => variant.name))
  const [key] = props[props.length - 1]
  for (let n = 2; ; n++) {
    const next = props.map(([other, value]) => [other, other === key ? String(n) : value] as const)
    if (!names.has(formatVariantName(next))) return next
  }
}

/** バリアント mainId のプロパティ key の値を value にする（名前を書き換える）。value が空なら変えない */
export function setVariantValue<T extends Scene>(scene: T, mainId: NodeId, key: string, value: string): T {
  const main = scene.nodes[mainId]
  const props = main && parseVariantName(main.name)
  const trimmed = value.trim()
  if (!props || trimmed === '' || trimmed.includes(',') || trimmed.includes('=')) return scene
  if (propValue(props, key) === undefined) return scene
  return updateNode(scene, mainId, {
    name: formatVariantName(props.map(([other, current]) => [other, other === key ? trimmed : current] as const)),
  })
}

/**
 * まとまり setId のすべてのバリアントで、プロパティ名 from を to に変える。
 * to が空か、すでにあるプロパティ名なら変えない
 */
export function renameVariantProperty<T extends Scene>(scene: T, setId: NodeId, from: string, to: string): T {
  const name = to.trim()
  if (name === '' || name.includes(',') || name.includes('=')) return scene
  const variants = variantsIn(scene, setId)
  if (variants.some((variant) => propValue(parseVariantName(variant.name) ?? [], name) !== undefined)) return scene
  return variants.reduce((next, variant) => {
    const props = parseVariantName(variant.name) ?? []
    return updateNode(next, variant.id, {
      name: formatVariantName(props.map(([key, value]) => [key === from ? name : key, value] as const)),
    })
  }, scene)
}

/**
 * まとまり setId のすべてのバリアントに、プロパティを 1 つ足す（名前の最後に「name=value」を書き足す）。
 * name を省くと「プロパティ1」「プロパティ2」… のうちまだないもの。名前や値が使えない、またはすでにあるなら変えない。
 * 足したプロパティ名を返す（変えなければ null）
 */
export function addVariantProperty<T extends Scene>(
  scene: T,
  setId: NodeId,
  name?: string,
  value = DEFAULT_VALUE,
): { scene: T; name: string | null } {
  const variants = variantsIn(scene, setId)
  const used = new Set(variants.flatMap((variant) => (parseVariantName(variant.name) ?? []).map(([key]) => key)))
  let key = name?.trim() ?? ''
  if (name === undefined) {
    for (let n = 1; used.has(key) || key === ''; n++) key = `プロパティ${n}`
  }
  const trimmed = value.trim()
  if (variants.length === 0 || !usable(key) || !usable(trimmed) || used.has(key)) return { scene, name: null }
  const next = variants.reduce((current, variant) => {
    const props = parseVariantName(variant.name) ?? []
    return updateNode(current, variant.id, { name: formatVariantName([...props, [key, trimmed]]) })
  }, scene)
  return { scene: next, name: key }
}

/**
 * まとまり setId のすべてのバリアントから、プロパティ key を消す（名前から「key=値」を外す）。
 * 消すとプロパティが 1 つもなくなる（名前がバリアントの形でなくなる）バリアントがあれば変えない
 */
export function removeVariantProperty<T extends Scene>(scene: T, setId: NodeId, key: string): T {
  const variants = variantsIn(scene, setId)
  const rest = variants.map((variant) => (parseVariantName(variant.name) ?? []).filter(([other]) => other !== key))
  if (rest.some((props) => props.length === 0)) return scene
  return variants.reduce(
    (current, variant, index) =>
      rest[index].length === parseVariantName(variant.name)?.length
        ? current
        : updateNode(current, variant.id, { name: formatVariantName(rest[index]) }),
    scene,
  )
}

/** プロパティ名や値に使えるか（空でなく、名前の区切りの「,」「=」を含まない） */
function usable(text: string): boolean {
  return text !== '' && !text.includes(',') && !text.includes('=')
}

/**
 * インスタンスのプロパティ key を value にする: 元のまとまりから、そのプロパティを持ち、
 * ほかのプロパティがいまと多く一致するバリアントを選んで差し替える（上書きは swapComponent と同じく名前で移す）
 */
export function selectVariant(
  doc: DesignDocument,
  pageId: PageId,
  instanceId: NodeId,
  key: string,
  value: string,
): DesignDocument {
  const page = findPage(doc, pageId)
  const instance = page?.nodes[instanceId]
  if (!isInstance(instance)) return doc
  const main = findMain(doc, instance.component.id)
  const set = main && variantSetOf(main.page, main.node.id)
  if (!main || !set) return doc
  const current = parseVariantName(main.node.name) ?? []
  const next = pickVariant(variantsIn(main.page, set.id), current, key, value)
  return next ? swapComponent(doc, pageId, instanceId, next.component.id) : doc
}

/**
 * まとまり setId のプロパティ key を、プロパティの並びの index 番目へ移す（すべてのバリアントの名前で、プロパティの順を並べ替える）。
 * プロパティの並びは、まとまりの中で最初に出てきた順（variantProperties）
 */
export function moveVariantProperty<T extends Scene>(scene: T, setId: NodeId, key: string, index: number): T {
  const order = variantProperties(scene, setId).map((property) => property.name)
  const from = order.indexOf(key)
  const to = Math.max(0, Math.min(order.length - 1, index))
  if (from < 0 || from === to) return scene
  order.splice(from, 1)
  order.splice(to, 0, key)
  return variantsIn(scene, setId).reduce((current, variant) => {
    const props = parseVariantName(variant.name) ?? []
    const sorted = [...props].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    const name = formatVariantName(sorted)
    return name === variant.name ? current : updateNode(current, variant.id, { name })
  }, scene)
}

/**
 * まとまり setId のプロパティ key の値 from を、すべてのバリアントで to に変える。
 * to が使えない、またはすでにある値なら変えない（同じ組み合わせのバリアントができないように）
 */
export function renameVariantValue<T extends Scene>(scene: T, setId: NodeId, key: string, from: string, to: string): T {
  const value = to.trim()
  const property = variantProperties(scene, setId).find((candidate) => candidate.name === key)
  if (!property || !property.values.includes(from) || !usable(value) || property.values.includes(value)) return scene
  return variantsIn(scene, setId).reduce((current, variant) => {
    const props = parseVariantName(variant.name) ?? []
    if (propValue(props, key) !== from) return current
    return updateNode(current, variant.id, {
      name: formatVariantName(props.map(([other, current]) => [other, other === key ? value : current] as const)),
    })
  }, scene)
}

/**
 * まとまり setId のプロパティ key の値 value を、値の並びの index 番目へ移す。
 * 値の並びは、まとまりの中で最初に出てきた順なので、バリアントの並び（まとまりの子の順）を、その値の順に並べ替える。
 * 同じ値のバリアントどうしの順と、プロパティを持たない子の位置は変えない
 */
export function moveVariantValue<T extends Scene>(scene: T, setId: NodeId, key: string, value: string, index: number): T {
  const property = variantProperties(scene, setId).find((candidate) => candidate.name === key)
  const set = scene.nodes[setId]
  if (!property || set?.type !== 'frame') return scene
  const order = [...property.values]
  const from = order.indexOf(value)
  const to = Math.max(0, Math.min(order.length - 1, index))
  if (from < 0 || from === to) return scene
  order.splice(from, 1)
  order.splice(to, 0, value)
  const variants = variantsIn(scene, setId)
  const rank = (id: NodeId) => {
    const variant = variants.find((candidate) => candidate.id === id)
    const current = variant && propValue(parseVariantName(variant.name) ?? [], key)
    return current === undefined ? order.length : order.indexOf(current)
  }
  // バリアントのいる位置だけを、値の順に並べ直したバリアントで埋める
  const slots = set.children.filter((id) => variants.some((variant) => variant.id === id))
  const sorted = [...slots].sort((a, b) => rank(a) - rank(b))
  let next = 0
  const children = set.children.map((id) => (slots.includes(id) ? sorted[next++] : id))
  // 子の並べ替えだけで、親子のつながりは変わらない
  return { ...scene, nodes: { ...scene.nodes, [setId]: { ...set, children } } }
}

/**
 * まとまり setId のプロパティ key に値を 1 つ足す: いまのバリアント（mainId、省けば最初のバリアント）を複製し、key の値を value にする。
 * value を省くと、まだない「値2」「値3」…。値が使えない、またはすでにあるなら変えない
 */
export function addVariantValue(
  doc: DesignDocument,
  pageId: PageId,
  setId: NodeId,
  key: string,
  value?: string,
): { document: DesignDocument; id: NodeId | null } {
  const page = findPage(doc, pageId)
  if (!page) return { document: doc, id: null }
  const property = variantProperties(page, setId).find((candidate) => candidate.name === key)
  const source = variantsIn(page, setId)[0]
  let text = value?.trim() ?? ''
  if (value === undefined) {
    for (let n = 2; text === '' || property?.values.includes(text); n++) text = `値${n}`
  }
  if (!property || !source || !usable(text) || property.values.includes(text)) return { document: doc, id: null }
  const added = addVariant(doc, pageId, source.id)
  if (added.id === null) return added
  const id = added.id
  return { document: updatePage(added.document, pageId, (base) => setVariantValue(base, id, key, text)), id }
}

/**
 * 親が変わったコンポーネントの元の名前を、入った先・出た先に合わせる（ストアが変更のたびにかける）。
 * まとまりは名前で決まるので、名前を変えないと、まとまりから出したバリアントを入れた先のフレームがまとまりになってしまう。
 * - ほかのバリアントがあるまとまりへ入れたら、そのまとまりのプロパティでバリアントの名前を付ける（入れた元にある値は使い、
 *   ないものは最初のバリアントの値。組み合わせが重なれば最初のプロパティを新しい値にする）
 * - まとまりから出したバリアントは、まとまりの名前と値をつないだ、プロパティの形でない名前にする（「ボタン（大, 押下）」）
 * 変わらなければ同じ参照を返す
 */
export function fitMovedVariants(before: DesignDocument, after: DesignDocument): DesignDocument {
  if (before === after) return after
  let changed = false
  const pages = after.pages.map((page) => {
    if (before.pages.includes(page)) return page
    const prior = findPage(before, page.id)
    if (!prior) return page
    const moved = [...mainsOf(page).values()].filter((main) => {
      const old = prior.nodes[main.id]
      return old !== undefined && old.parentId !== main.parentId
    })
    if (moved.length === 0) return page
    let scene: Page = page
    // まだ名前を合わせていない、動かした元（入った先のまとまりのバリアントとしては数えない）
    const pending = new Set(moved.map((main) => main.id))
    for (const main of moved) {
      pending.delete(main.id)
      const others = main.parentId === null ? [] : variantsIn(scene, main.parentId).filter((v) => v.id !== main.id && !pending.has(v.id))
      const oldSet = variantSetOf(prior, main.id)
      let name: string | null = null
      if (others.length > 0) name = joinedVariantName(scene.nodes[main.id].name, others)
      else if (oldSet) name = leftVariantName(oldSet.name, parseVariantName(prior.nodes[main.id].name) ?? [])
      if (name !== null && name !== scene.nodes[main.id].name) scene = updateNode(scene, main.id, { name })
    }
    if (scene !== page) changed = true
    return scene
  })
  return changed ? { ...after, pages } : after
}

/** 名前に使うと形が崩れる文字（カンマと等号）を空白にする */
function plain(text: string): string {
  return text.replace(/[,=]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** まとまりから出したバリアントの名前。まとまりの名前と値をつないだもの（プロパティの形ではない） */
function leftVariantName(setName: string, props: VariantProps): string {
  const values = props.map(([, value]) => plain(value)).join(', ')
  const base = plain(setName) || 'コンポーネント'
  return values === '' ? base : `${base}（${values}）`
}

/** まとまり（バリアントは others）へ入れた元の名前。まとまりのプロパティの形に揃える */
function joinedVariantName(name: string, others: readonly MainNode[]): string {
  const own = parseVariantName(name)
  const properties: { name: string; first: string }[] = []
  for (const variant of others) {
    for (const [key, value] of parseVariantName(variant.name) ?? []) {
      if (!properties.some((property) => property.name === key)) properties.push({ name: key, first: value })
    }
  }
  const props: [string, string][] = properties.map(({ name: key, first }) => [key, (own && propValue(own, key)) ?? first])
  const taken = new Set(others.map((variant) => formatVariantName(parseVariantName(variant.name) ?? [])))
  if (!taken.has(formatVariantName(props))) return formatVariantName(props)
  // 組み合わせが重なるので、最初のプロパティを新しい値にする。名前がプロパティの形でなければ、その名前を値に
  const base = (own ? props[0][1] : plain(name)) || props[0][1]
  for (let n = own ? 2 : 1; ; n++) {
    props[0] = [props[0][0], n === 1 ? base : `${base} ${n}`]
    if (!taken.has(formatVariantName(props))) return formatVariantName(props)
  }
}
