import {
  type MainNode,
  canBindProperty,
  derivedId,
  findMain,
  isInstance,
  isMain,
  type PropertyValue,
} from '../document/component.ts'
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
 * 元 mainId に、targetId のノードを結んだ type のプロパティを足す。名前を省くと、ノードの名前（なければ種類の名前）。
 * 結べないノード、すでにある名前なら変えない。足したプロパティの名前を返す
 */
export function addComponentProperty<T extends Scene>(
  scene: T,
  mainId: NodeId,
  type: ComponentProperty['type'],
  targetId: NodeId,
  name?: string,
): { scene: T; name: string | null } {
  const main = scene.nodes[mainId]
  if (!isMain(main) || !canBindProperty(scene, mainId, type, targetId)) return { scene, name: null }
  const { properties } = main.component
  const key = name?.trim() ?? freshName(properties, scene.nodes[targetId].name.trim() || DEFAULT_NAMES[type])
  if (!usable(key) || properties.some((property) => property.name === key)) return { scene, name: null }
  return { scene: setProperties(scene, main, [...properties, { name: key, type, targets: [targetId], preferred: [] }]), name: key }
}

/** プロパティ name に、targetId のノードも結ぶ。種類が合わない、すでに結んでいるなら変えない */
export function bindComponentProperty<T extends Scene>(scene: T, mainId: NodeId, name: string, targetId: NodeId): T {
  const main = scene.nodes[mainId]
  if (!isMain(main)) return scene
  const property = main.component.properties.find((candidate) => candidate.name === name)
  if (!property || property.targets.includes(targetId) || !canBindProperty(scene, mainId, property.type, targetId)) return scene
  return setProperties(
    scene,
    main,
    main.component.properties.map((other) => (other === property ? { ...other, targets: [...other.targets, targetId] } : other)),
  )
}

/** プロパティ name から、targetId のノードを外す。結んだノードがなくなっても、プロパティは残す */
export function unbindComponentProperty<T extends Scene>(scene: T, mainId: NodeId, name: string, targetId: NodeId): T {
  const main = scene.nodes[mainId]
  if (!isMain(main)) return scene
  const property = main.component.properties.find((candidate) => candidate.name === name)
  if (!property || !property.targets.includes(targetId)) return scene
  return setProperties(
    scene,
    main,
    main.component.properties.map((other) =>
      other === property ? { ...other, targets: other.targets.filter((id) => id !== targetId) } : other,
    ),
  )
}

/** プロパティの名前を変える。空や、すでにある名前なら変えない */
export function renameComponentProperty<T extends Scene>(scene: T, mainId: NodeId, from: string, to: string): T {
  const main = scene.nodes[mainId]
  const name = to.trim()
  if (!isMain(main) || !usable(name) || main.component.properties.some((property) => property.name === name)) return scene
  if (!main.component.properties.some((property) => property.name === from)) return scene
  return setProperties(
    scene,
    main,
    main.component.properties.map((property) => (property.name === from ? { ...property, name } : property)),
  )
}

/** プロパティ name を、並びの to 番目（0 が先頭）へ移す。インスタンスの欄もこの順に並ぶ */
export function moveComponentProperty<T extends Scene>(scene: T, mainId: NodeId, name: string, to: number): T {
  const main = scene.nodes[mainId]
  if (!isMain(main)) return scene
  const { properties } = main.component
  const from = properties.findIndex((property) => property.name === name)
  const index = Math.max(0, Math.min(properties.length - 1, to))
  if (from < 0 || from === index) return scene
  const rest = properties.filter((_, i) => i !== from)
  return setProperties(scene, main, [...rest.slice(0, index), properties[from], ...rest.slice(index)])
}

/**
 * 差し替えのプロパティ name の候補（preferred values）を componentIds にする。並びはそのまま候補の順。
 * 差し替え以外のプロパティや、同じ並びなら変えない
 */
export function setPreferredComponents<T extends Scene>(scene: T, mainId: NodeId, name: string, componentIds: readonly string[]): T {
  const main = scene.nodes[mainId]
  if (!isMain(main)) return scene
  const property = main.component.properties.find((candidate) => candidate.name === name)
  const preferred = [...new Set(componentIds)]
  if (property?.type !== 'instance') return scene
  if (property.preferred.length === preferred.length && property.preferred.every((id, i) => id === preferred[i])) return scene
  return setProperties(
    scene,
    main,
    main.component.properties.map((other) => (other === property ? { ...other, preferred } : other)),
  )
}

/** プロパティを消す。インスタンスに残った上書きは、ふつうの上書きとして残る */
export function removeComponentProperty<T extends Scene>(scene: T, mainId: NodeId, name: string): T {
  const main = scene.nodes[mainId]
  if (!isMain(main) || !main.component.properties.some((property) => property.name === name)) return scene
  return setProperties(
    scene,
    main,
    main.component.properties.filter((property) => property.name !== name),
  )
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
  const page = doc.pages.find((candidate) => candidate.id === pageId)
  const instance = page?.nodes[instanceId]
  if (!page || !isInstance(instance)) return doc
  const main = findMain(doc, instance.component.id)
  const property = main?.node.component.properties.find((candidate) => candidate.name === name)
  if (!main || !property) return doc
  const targets = property.targets.filter((id) => canBindProperty(main.page, main.node.id, property.type, id))

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
