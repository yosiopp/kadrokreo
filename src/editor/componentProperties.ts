import { type MainNode, derivedId, findMain, isInstance, isMain } from '../document/component.ts'
import { canBindProperty, type PropertyValue } from '../document/componentProperties.ts'
import { namePath, pathIndex } from '../document/componentSource.ts'
import { findPage } from '../document/pages.ts'
import { variantSetOf, variantsIn } from '../document/variants.ts'
import type { ComponentProperty, DesignDocument, NodeId, Override, PageId, Scene } from '../document/types.ts'
import { swapNestedInstance } from './components.ts'
import { updatePage } from './operations/document.ts'
import { updateNode } from './operations/tree.ts'

// コンポーネントの説明文とプロパティ（既存のデザインツールのコンポーネントプロパティ）を編集する操作。
// プロパティは元が持ち、元の中のノードに結ぶ。インスタンスでの値は、結んだノードへの上書きとして書く
// （だから同期・元に反映・上書きを戻すは、ふつうの上書きと同じように効く）。

/** 元の説明文を変える */
export function setComponentDescription<T extends Scene>(scene: T, mainId: NodeId, description: string): T {
  const main = scene.nodes[mainId]
  if (!isMain(main) || main.component.description === description) return scene
  return updateNode(scene, mainId, { component: { ...main.component, description } })
}

function setProperties<T extends Scene>(scene: T, main: MainNode, properties: ComponentProperty[]): T {
  return updateNode(scene, main.id, { component: { ...main.component, properties } })
}

/** プロパティ名に使えるか（空でない） */
function usable(name: string): boolean {
  return name.trim() !== ''
}

/** 種類ごとの、新しいプロパティの名前の元 */
const DEFAULT_NAMES: Record<ComponentProperty['type'], string> = { text: '文言', boolean: '表示', instance: '差し替え' }

/** まだない名前。base、base 2、base 3 … */
function freshName(properties: readonly ComponentProperty[], base: string): string {
  const used = new Set(properties.map((property) => property.name))
  if (!used.has(base)) return base
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`
}

/**
 * プロパティを揃えるバリアント。元 mainId がバリアントのまとまりに入っていれば、まとまりのすべてのバリアント（mainId が先頭）、
 * そうでなければ mainId だけ。map は、mainId の中のノードに当たる、そのバリアントの中のノード（レイヤー名のたどり方が同じもの）
 */
type Variant = { main: MainNode; map: (id: NodeId) => NodeId | null }

function sharingVariants(scene: Scene, main: MainNode): Variant[] {
  const set = variantSetOf(scene, main.id)
  const others = set ? variantsIn(scene, set.id).filter((variant) => variant.id !== main.id) : []
  return [
    { main, map: (id) => id },
    ...others.map((variant): Variant => {
      let index: Map<string, NodeId> | null = null
      return {
        main: variant,
        map: (id) => {
          const path = namePath(scene, main.id, id)
          if (path === null || path === '') return null
          index ??= pathIndex(scene, variant.id)
          return index.get(path) ?? null
        },
      }
    }),
  ]
}

/** バリアントごとに、プロパティの並びを update で変える（null か同じ並びなら変えない） */
function updateVariants<T extends Scene>(
  scene: T,
  variants: readonly Variant[],
  update: (variant: Variant, properties: ComponentProperty[]) => ComponentProperty[] | null,
): T {
  let next = scene
  for (const variant of variants) {
    const { properties } = variant.main.component
    const changed = update(variant, properties)
    if (changed && changed !== properties) next = setProperties(next, next.nodes[variant.main.id] as MainNode, changed)
  }
  return next
}

/**
 * バリアント variant で、プロパティ name（種類 type）に、元の側の targetId に当たるノードを結ぶ。
 * プロパティがなければ作る（ほかのバリアントと揃える）。種類の違う同じ名前のものがあれば変えない
 */
function bindIn(
  scene: Scene,
  variant: Variant,
  properties: ComponentProperty[],
  name: string,
  type: ComponentProperty['type'],
  targetId: NodeId,
  doc: DesignDocument | undefined,
): ComponentProperty[] | null {
  const target = variant.map(targetId)
  const bindable = target !== null && canBindProperty(scene, variant.main.id, type, target, doc)
  const existing = properties.find((property) => property.name === name)
  if (!existing) {
    return [...properties, { name, type, targets: bindable ? [target] : [], preferred: [] }]
  }
  if (existing.type !== type || !bindable || existing.targets.includes(target)) return null
  return properties.map((other) => (other === existing ? { ...other, targets: [...other.targets, target] } : other))
}

/**
 * 元 mainId に、targetId のノードを結んだ type のプロパティを足す。名前を省くと、ノードの名前（なければ種類の名前）。
 * 結べないノード、すでにある名前なら変えない。足したプロパティの名前を返す。
 * 元がバリアントなら、まとまりのほかのバリアントにも同じ名前で足し、レイヤー名のたどり方が同じノードを結ぶ（既存のデザインツールのまとまりのプロパティ）。
 * doc を渡すと、入れ子の中の入れ子のインスタンス（写し）にも差し替えを結べる
 */
export function addComponentProperty<T extends Scene>(
  scene: T,
  mainId: NodeId,
  type: ComponentProperty['type'],
  targetId: NodeId,
  name?: string,
  doc?: DesignDocument,
): { scene: T; name: string | null } {
  const main = scene.nodes[mainId]
  if (!isMain(main) || !canBindProperty(scene, mainId, type, targetId, doc)) return { scene, name: null }
  const variants = sharingVariants(scene, main)
  const taken = variants.flatMap((variant) => variant.main.component.properties)
  const key = name?.trim() ?? freshName(taken, scene.nodes[targetId].name.trim() || DEFAULT_NAMES[type])
  if (!usable(key) || main.component.properties.some((property) => property.name === key)) return { scene, name: null }
  return {
    scene: updateVariants(scene, variants, (variant, properties) => bindIn(scene, variant, properties, key, type, targetId, doc)),
    name: key,
  }
}

/**
 * プロパティ name に、targetId のノードも結ぶ。種類が合わない、すでに結んでいるなら変えない。
 * 元がバリアントなら、まとまりのほかのバリアントでも、レイヤー名のたどり方が同じノードを結ぶ
 */
export function bindComponentProperty<T extends Scene>(
  scene: T,
  mainId: NodeId,
  name: string,
  targetId: NodeId,
  doc?: DesignDocument,
): T {
  const main = scene.nodes[mainId]
  if (!isMain(main)) return scene
  const property = main.component.properties.find((candidate) => candidate.name === name)
  if (!property || property.targets.includes(targetId) || !canBindProperty(scene, mainId, property.type, targetId, doc)) return scene
  return updateVariants(scene, sharingVariants(scene, main), (variant, properties) =>
    bindIn(scene, variant, properties, name, property.type, targetId, doc),
  )
}

/**
 * プロパティ name から、targetId のノードを外す。結んだノードがなくなっても、プロパティは残す。
 * 元がバリアントなら、まとまりのほかのバリアントでも、レイヤー名のたどり方が同じノードを外す
 */
export function unbindComponentProperty<T extends Scene>(scene: T, mainId: NodeId, name: string, targetId: NodeId): T {
  const main = scene.nodes[mainId]
  if (!isMain(main)) return scene
  const property = main.component.properties.find((candidate) => candidate.name === name)
  if (!property || !property.targets.includes(targetId)) return scene
  return updateVariants(scene, sharingVariants(scene, main), (variant, properties) => {
    const target = variant.map(targetId)
    const own = properties.find((candidate) => candidate.name === name)
    if (target === null || !own?.targets.includes(target)) return null
    return properties.map((other) => (other === own ? { ...other, targets: other.targets.filter((id) => id !== target) } : other))
  })
}

/** プロパティの名前を変える。空や、すでにある名前なら変えない。元がバリアントなら、まとまりのすべてのバリアントで変える */
export function renameComponentProperty<T extends Scene>(scene: T, mainId: NodeId, from: string, to: string): T {
  const main = scene.nodes[mainId]
  const name = to.trim()
  if (!isMain(main) || !usable(name) || main.component.properties.some((property) => property.name === name)) return scene
  if (!main.component.properties.some((property) => property.name === from)) return scene
  return updateVariants(scene, sharingVariants(scene, main), (_, properties) => {
    if (!properties.some((property) => property.name === from) || properties.some((property) => property.name === name)) return null
    return properties.map((property) => (property.name === from ? { ...property, name } : property))
  })
}

/**
 * プロパティ name を、並びの to 番目（0 が先頭）へ移す。インスタンスの欄もこの順に並ぶ。
 * 元がバリアントなら、まとまりのほかのバリアントも同じ順に並べる（その元にない名前のものは後ろに残す）
 */
export function moveComponentProperty<T extends Scene>(scene: T, mainId: NodeId, name: string, to: number): T {
  const main = scene.nodes[mainId]
  if (!isMain(main)) return scene
  const { properties } = main.component
  const from = properties.findIndex((property) => property.name === name)
  const index = Math.max(0, Math.min(properties.length - 1, to))
  if (from < 0 || from === index) return scene
  const rest = properties.filter((_, i) => i !== from)
  const order = [...rest.slice(0, index), properties[from], ...rest.slice(index)]
  const rank = new Map(order.map((property, i) => [property.name, i]))
  return updateVariants(scene, sharingVariants(scene, main), (variant, own) => {
    if (variant.main.id === mainId) return order
    const sorted = [...own].sort((a, b) => (rank.get(a.name) ?? Infinity) - (rank.get(b.name) ?? Infinity))
    return sorted.every((property, i) => property === own[i]) ? null : sorted
  })
}

/**
 * 差し替えのプロパティ name の候補（preferred values）を componentIds にする。並びはそのまま候補の順。
 * 差し替え以外のプロパティや、同じ並びなら変えない。元がバリアントなら、まとまりのすべてのバリアントで変える
 */
export function setPreferredComponents<T extends Scene>(scene: T, mainId: NodeId, name: string, componentIds: readonly string[]): T {
  const main = scene.nodes[mainId]
  if (!isMain(main)) return scene
  const property = main.component.properties.find((candidate) => candidate.name === name)
  const preferred = [...new Set(componentIds)]
  if (property?.type !== 'instance') return scene
  if (property.preferred.length === preferred.length && property.preferred.every((id, i) => id === preferred[i])) return scene
  return updateVariants(scene, sharingVariants(scene, main), (_, properties) => {
    const own = properties.find((candidate) => candidate.name === name)
    if (own?.type !== 'instance') return null
    return properties.map((other) => (other === own ? { ...other, preferred } : other))
  })
}

/** プロパティを消す。インスタンスに残った上書きは、ふつうの上書きとして残る。元がバリアントなら、まとまりのすべてのバリアントから消す */
export function removeComponentProperty<T extends Scene>(scene: T, mainId: NodeId, name: string): T {
  const main = scene.nodes[mainId]
  if (!isMain(main) || !main.component.properties.some((property) => property.name === name)) return scene
  return updateVariants(scene, sharingVariants(scene, main), (_, properties) =>
    properties.some((property) => property.name === name) ? properties.filter((property) => property.name !== name) : null,
  )
}

/**
 * 元 fromId のプロパティを、元 toId（fromId を複製したバリアントなど）に写す。結ぶノードはレイヤー名のたどり方が同じもの。
 * toId がもともと持っていたプロパティは捨てる
 */
export function inheritComponentProperties<T extends Scene>(scene: T, fromId: NodeId, toId: NodeId, doc?: DesignDocument): T {
  const from = scene.nodes[fromId]
  const to = scene.nodes[toId]
  if (!isMain(from) || !isMain(to)) return scene
  const index = pathIndex(scene, toId)
  const properties = from.component.properties.map((property) => ({
    ...property,
    targets: property.targets.flatMap((id) => {
      const path = namePath(scene, fromId, id)
      const target = path === null || path === '' ? undefined : index.get(path)
      return target !== undefined && canBindProperty(scene, toId, property.type, target, doc) ? [target] : []
    }),
  }))
  return setProperties(scene, to, properties)
}

/**
 * インスタンスのプロパティ name を value にする。結んだノードすべてへの上書きとして書き、元と同じ値なら上書きを外す。
 * 差し替えのプロパティは、結んだ入れ子のインスタンスを value のコンポーネントに差し替える（循環するものは変えない）
 */
export function setInstanceProperty(
  doc: DesignDocument,
  pageId: PageId,
  instanceId: NodeId,
  name: string,
  value: PropertyValue,
): DesignDocument {
  const page = findPage(doc, pageId)
  const instance = page?.nodes[instanceId]
  if (!page || !isInstance(instance)) return doc
  const main = findMain(doc, instance.component.id)
  const property = main?.node.component.properties.find((candidate) => candidate.name === name)
  if (!main || !property) return doc
  const targets = property.targets.filter((id) => canBindProperty(main.page, main.node.id, property.type, id, doc))

  if (property.type === 'instance') {
    if (typeof value !== 'string') return doc
    return targets.reduce(
      (current, target) => swapNestedInstance(current, pageId, derivedId(instanceId, target), value),
      doc,
    )
  }
  const key = property.type === 'text' ? 'text' : 'visible'
  if (typeof value !== (key === 'text' ? 'string' : 'boolean')) return doc
  const overrides = { ...instance.component.overrides }
  for (const target of targets) {
    const source = main.page.nodes[target] as unknown as Record<string, unknown>
    const entry: Record<string, unknown> = { ...overrides[target] }
    if (source[key] === value) delete entry[key]
    else entry[key] = value
    if (Object.keys(entry).length > 0) overrides[target] = entry as Override
    else delete overrides[target]
  }
  return updatePage(doc, pageId, (base) =>
    updateNode(base, instanceId, { component: { ...instance.component, overrides } }),
  )
}

/** まとまりの説明文を変える。setId がバリアントのまとまりでなければ変えない */
export function setVariantSetDescription<T extends Scene>(scene: T, setId: NodeId, description: string): T {
  const set = scene.nodes[setId]
  if (set?.type !== 'frame' || variantsIn(scene, setId).length === 0 || set.setDescription === description) return scene
  return updateNode(scene, setId, { setDescription: description })
}

/**
 * まとまり setId のすべてのバリアントのプロパティを揃える。どれかのバリアントにあるプロパティを、名前でほかのバリアントにも足し、
 * 結ぶノードはレイヤー名のたどり方が同じもの（どれかのバリアントで結んでいれば結ぶ）、差し替えの候補は最初に持っていたバリアントのもの、
 * 並びはまとまりの中で最初に出てきた順にする。同じ名前で種類が違うものは、そのバリアントでは変えない。
 * まとまりへ外から入れた元や、前の版で揃っていなかったプロパティを一度に揃えるための操作（ふだんの編集はまとまりにかかる）
 */
export function alignVariantProperties<T extends Scene>(scene: T, setId: NodeId, doc?: DesignDocument): T {
  const variants = variantsIn(scene, setId)
  if (variants.length < 2) return scene
  // 名前ごとに、最初に持っていたバリアントのプロパティ（種類・候補の基準）と、持っているバリアントの組
  const order: string[] = []
  const owners = new Map<string, { first: ComponentProperty; holders: { main: MainNode; property: ComponentProperty }[] }>()
  for (const main of variants) {
    for (const property of main.component.properties) {
      let entry = owners.get(property.name)
      if (!entry) {
        entry = { first: property, holders: [] }
        owners.set(property.name, entry)
        order.push(property.name)
      }
      if (property.type === entry.first.type) entry.holders.push({ main, property })
    }
  }
  const rank = new Map(order.map((name, i) => [name, i]))
  let next = scene
  for (const main of variants) {
    const index = pathIndex(scene, main.id)
    const mapped = (from: MainNode, id: NodeId): NodeId | null => {
      if (from.id === main.id) return id
      const path = namePath(scene, from.id, id)
      return path === null || path === '' ? null : (index.get(path) ?? null)
    }
    const own = main.component.properties
    const properties = order.flatMap((name): ComponentProperty[] => {
      const { first, holders } = owners.get(name)!
      const mine = own.find((property) => property.name === name)
      if (mine && mine.type !== first.type) return [mine]
      const targets: NodeId[] = [...(mine?.targets ?? [])]
      for (const holder of holders) {
        for (const id of holder.property.targets) {
          const target = mapped(holder.main, id)
          if (target !== null && !targets.includes(target) && canBindProperty(scene, main.id, first.type, target, doc)) targets.push(target)
        }
      }
      return [{ name, type: first.type, targets, preferred: mine?.preferred ?? first.preferred }]
    })
    properties.sort((a, b) => rank.get(a.name)! - rank.get(b.name)!)
    const same =
      properties.length === own.length &&
      properties.every(
        (property, i) =>
          property.name === own[i].name &&
          property.type === own[i].type &&
          property.targets.length === own[i].targets.length &&
          property.targets.every((id, j) => id === own[i].targets[j]) &&
          property.preferred === own[i].preferred,
      )
    if (!same) next = setProperties(next, next.nodes[main.id] as MainNode, properties)
  }
  return next
}
