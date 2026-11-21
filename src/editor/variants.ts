import { findMain, isInstance, isMain, owningInstance } from '../document/component.ts'
import type { DesignDocument, NodeId, PageId, Scene } from '../document/types.ts'
import {
  type VariantProps,
  formatVariantName,
  parseVariantName,
  pickVariant,
  propValue,
  variantSetOf,
  variantsIn,
} from '../document/variants.ts'
import { swapComponent } from './components.ts'
import { wrapInAutoLayout } from './layout.ts'
import { createId } from './nodes.ts'
import { copyFragment, moveNode, pasteFragment, updateNode, updatePage } from './operations.ts'

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
      component: { id: createId(), role: 'main' },
    })
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
  const page = doc.pages.find((candidate) => candidate.id === pageId)
  const instance = page?.nodes[instanceId]
  if (!isInstance(instance)) return doc
  const main = findMain(doc, instance.component.id)
  const set = main && variantSetOf(main.page, main.node.id)
  if (!main || !set) return doc
  const current = parseVariantName(main.node.name) ?? []
  const next = pickVariant(variantsIn(main.page, set.id), current, key, value)
  return next ? swapComponent(doc, pageId, instanceId, next.component.id) : doc
}
