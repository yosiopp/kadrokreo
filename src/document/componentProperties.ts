import { type InstanceNode, type MainNode, derivedId, findMain, isInstance, isMain, owningInstance } from './component.ts'
import { representedLink, sourceContext } from './componentSource.ts'
import type { ComponentProperty, DesignDocument, NodeId, Scene } from './types.ts'

// コンポーネントのプロパティを読む関数。editor のパネル・編集と、viewer のインスペクトが使う。

/** プロパティの値。text は文言、boolean は表示、instance は入れ子のインスタンスの元（コンポーネントの id） */
export type PropertyValue = string | boolean

/** インスタンスでのプロパティの値と、元と違えているか */
export type PropertyState = { property: ComponentProperty; value: PropertyValue; overridden: boolean }

/**
 * プロパティを結べるノードか（元 main の中にあり、元そのものでなく、種類が合う）。
 * main の中に置いた入れ子のインスタンスの中身（写し）にも結べる（上書きのキーは元の側の写しの id で、入れ子の中の上書きと同じ形）。
 * 差し替えを写しに結べるのは、写しがインスタンスを写したもの（入れ子の中の入れ子のインスタンス）のときで、
 * それを確かめるのにほかのページの元も見るので doc が要る（渡さなければ、写しには差し替えを結べない）
 */
export function canBindProperty(
  scene: Scene,
  mainId: NodeId,
  type: ComponentProperty['type'],
  targetId: NodeId,
  doc?: DesignDocument,
): boolean {
  const target = scene.nodes[targetId]
  if (!target || targetId === mainId) return false
  const copy = owningInstance(scene, targetId) !== null
  // いちばん近い元が main であること（間に別の元があれば、そちらのプロパティになる）
  let current = target.parentId
  while (current !== null && current !== mainId && !isMain(scene.nodes[current])) current = scene.nodes[current].parentId
  if (current !== mainId) return false
  if (type === 'text') return target.type === 'text'
  if (type === 'instance') {
    if (!copy) return isInstance(target)
    return doc !== undefined && representedLink(sourceContext(doc), scene, targetId) !== null
  }
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
    const target = property.targets.find((id) => canBindProperty(main.page, main.node.id, property.type, id, doc))
    if (target === undefined) continue
    const override = instance.component.overrides[target]
    const source = main.page.nodes[target]
    const copy = scene.nodes[derivedId(instance.id, target)]
    if (property.type === 'instance') {
      const value = override?.componentId ?? representedComponent(doc, main.page, target)
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

/** 元のページの id のノードが写しているコンポーネント（インスタンスならその元、入れ子の中の入れ子の写しならたどったもの）。なければ空文字 */
function representedComponent(doc: DesignDocument, page: Scene, id: NodeId): string {
  const node = page.nodes[id]
  if (isInstance(node)) return node.component.id
  return representedLink(sourceContext(doc), page, id)?.id ?? ''
}
