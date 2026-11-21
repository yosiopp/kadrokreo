import { type MainNode, isMain, instanceOf } from './component.ts'
import type { FrameNode, NodeId, Scene } from './types.ts'

// コンポーネントのバリアント（「ボタン」の大・小、標準・押下など）を読むための関数。editor と viewer の両方が使う。
//
// kdr に専用の項目は持たない。既存のデザインツールと同じく、名前で表す:
// - バリアントは、名前が「プロパティ=値」をカンマでつないだ形（`サイズ=大, 状態=押下`）のコンポーネントの元
// - バリアントのまとまりは、そういう元を子に持つフレーム（ふつうのフレームで、元やインスタンスの中ではないもの）
// まとまりの中の元どうしを、プロパティの値で選び分けられる（インスタンスの差し替え）。

/** バリアントのプロパティ。名前と値の組を、名前に書いた順に */
export type VariantProps = readonly (readonly [string, string])[]

/** まとまり全体のプロパティ。値は、まとまりの中で最初に出てきた順 */
export type VariantProperty = { name: string; values: string[] }

/**
 * 名前をバリアントのプロパティとして読む。「プロパティ=値」をカンマでつないだ形でなければ null。
 * 前後の空白は無視する。プロパティ名・値が空のもの、同じプロパティ名が 2 回出てくるものは、その形とみなさない
 */
export function parseVariantName(name: string): VariantProps | null {
  const props: [string, string][] = []
  for (const part of name.split(',')) {
    const at = part.indexOf('=')
    if (at < 0) return null
    const key = part.slice(0, at).trim()
    const value = part.slice(at + 1).trim()
    if (key === '' || value === '' || props.some(([other]) => other === key)) return null
    props.push([key, value])
  }
  return props
}

/** プロパティを名前の形に戻す */
export function formatVariantName(props: VariantProps): string {
  return props.map(([key, value]) => `${key}=${value}`).join(', ')
}

/** プロパティの値。なければ undefined */
export function propValue(props: VariantProps, key: string): string | undefined {
  return props.find(([other]) => other === key)?.[1]
}

/**
 * コンポーネントの元か、インスタンスか、その中身か、バリアントのまとまり。画面ではこれらを紫で見分けられるようにする
 */
export function isComponentPart(scene: Scene, id: NodeId): boolean {
  return isMain(scene.nodes[id]) || instanceOf(scene, id) !== null || isVariantSet(scene, id)
}

/** id がバリアントのまとまり（バリアントを子に持つ、ふつうのフレーム）か */
export function isVariantSet(scene: Scene, id: NodeId): boolean {
  return variantsIn(scene, id).length > 0
}

/** まとまり setId の中のバリアント（子の順）。まとまりでなければ空 */
export function variantsIn(scene: Scene, setId: NodeId): MainNode[] {
  const set = scene.nodes[setId]
  if (set?.type !== 'frame' || set.component || instanceOf(scene, setId) || insideMain(scene, setId)) return []
  return set.children.flatMap((childId) => {
    const child = scene.nodes[childId]
    return isMain(child) && parseVariantName(child.name) !== null ? [child] : []
  })
}

/** 元 mainId がバリアントなら、そのまとまり */
export function variantSetOf(scene: Scene, mainId: NodeId): FrameNode | null {
  const main = scene.nodes[mainId]
  if (!isMain(main) || main.parentId === null || parseVariantName(main.name) === null) return null
  const set = scene.nodes[main.parentId]
  return set.type === 'frame' && isVariantSet(scene, set.id) ? set : null
}

/** まとまりのプロパティと、それぞれが取る値 */
export function variantProperties(scene: Scene, setId: NodeId): VariantProperty[] {
  const properties: VariantProperty[] = []
  for (const variant of variantsIn(scene, setId)) {
    for (const [key, value] of parseVariantName(variant.name) ?? []) {
      let property = properties.find((candidate) => candidate.name === key)
      if (!property) {
        property = { name: key, values: [] }
        properties.push(property)
      }
      if (!property.values.includes(value)) property.values.push(value)
    }
  }
  return properties
}

/**
 * いまのバリアント（current）から、プロパティ key を value に変えたときに選ぶバリアント。
 * key が value のもののうち、ほかのプロパティがいまと多く一致するもの（同じなら先にあるもの）。なければ null
 */
export function pickVariant(variants: readonly MainNode[], current: VariantProps, key: string, value: string): MainNode | null {
  let best: MainNode | null = null
  let bestScore = -1
  for (const variant of variants) {
    const props = parseVariantName(variant.name)
    if (!props || propValue(props, key) !== value) continue
    const score = current.filter(([other, otherValue]) => other !== key && propValue(props, other) === otherValue).length
    if (score > bestScore) {
      best = variant
      bestScore = score
    }
  }
  return best
}

/** id の祖先にコンポーネントの元があるか */
function insideMain(scene: Scene, id: NodeId): boolean {
  for (let current = scene.nodes[id]?.parentId ?? null; current !== null; current = scene.nodes[current].parentId) {
    if (isMain(scene.nodes[current])) return true
  }
  return false
}
