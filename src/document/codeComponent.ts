import { type InstanceNode, findMain } from './component.ts'
import { instanceProperties } from './componentProperties.ts'
import type { CodeComponent, DesignDocument, Scene } from './types.ts'
import { isBooleanProperty, parseVariantName, variantProperties, variantSetOf } from './variants.ts'

// コンポーネントと実装側の部品の対応（CodeComponent）を読む。viewer のコード（viewer/markup.ts）・インスペクト、editor と CLI が使う。

/**
 * 部品の名前。英大文字で始まる識別子か、. でつないだもの（UI.Button）。小文字で始めると JSX では HTML の要素になり、
 * 予約語（default など）は import に書けないので、先頭は英大文字に限る
 */
export const CODE_NAME_PATTERN = /^[A-Z][\w$]*(\.[A-Za-z_$][\w$]*)*$/
/** props の名前の形。識別子（Vue・JSX の aria-label のように - も許す） */
const CODE_PROP_PATTERN = /^[A-Za-z_$][\w$-]*$/
/** props に使えない名前。値（kdr の文字）が式として読まれたり、React・Vue が特別に扱ったりする */
const RESERVED_PROPS = new Set(['key', 'ref', 'is', 'slot', 'dangerouslySetInnerHTML'])

/** 部品の名前に使えるか（CODE_NAME_PATTERN の形で、長すぎない） */
export function isCodeName(name: string): boolean {
  return name.length <= MAX_CODE_LENGTH && CODE_NAME_PATTERN.test(name)
}

/** import の場所に使えるか（制御文字がなく、長すぎない。空は「読み込まない」） */
export function isCodeFrom(from: string): boolean {
  return from.length <= MAX_CODE_LENGTH && !CODE_FROM_FORBIDDEN.test(from)
}

/** props の名前に使えるか。Vue の v- で始まる名前はディレクティブ（値が式として評価される）なので断る */
export function isCodePropName(name: string): boolean {
  return name.length <= MAX_CODE_LENGTH && CODE_PROP_PATTERN.test(name) && !/^v-/i.test(name) && !RESERVED_PROPS.has(name)
}
/** import の場所に使えない文字（制御文字。コードの 1 行に収める） */
// eslint-disable-next-line no-control-regex -- 制御文字を弾くための検査なので、制御文字そのものを書く
export const CODE_FROM_FORBIDDEN = /[\u0000-\u001f\u007f]/
/** 名前・import の場所・props の名前・値の長さの上限 */
export const MAX_CODE_LENGTH = 200

/** props に渡す値。element は差し替えた先の部品の要素（props なし） */
export type CodeValue = { kind: 'string'; text: string } | { kind: 'boolean'; value: boolean } | { kind: 'element'; code: CodeComponent }

/** 部品の呼び出しに渡す 1 つの props。prop が 'children' なら中身 */
export type CodeArg = { prop: string; value: CodeValue }

/** インスタンスを部品として呼ぶときの、部品と props */
export type CodeCall = { code: CodeComponent; args: CodeArg[] }

/** コンポーネント componentId に対応する実装側の部品。バリアントならまとまりの setCode。対応がなければ null */
export function codeOfComponent(doc: DesignDocument, componentId: string): CodeComponent | null {
  const main = findMain(doc, componentId)
  if (!main) return null
  const set = variantSetOf(main.page, main.node.id)
  // バリアントはまとまりのものだけを見る（バリアント自身の code は使わない。editor にも欄を出さない）
  return set ? set.setCode : main.node.component.code
}

/**
 * プロパティの名前から作る props の名前（`Has Icon` → `hasIcon`、`size` → `size`）。英数字の語がない・数字で始まるなら空文字（写さない）
 */
export function autoPropName(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter((word) => word !== '')
  if (words.length === 0 || /^[0-9]/.test(words[0])) return ''
  const [first, ...rest] = words
  const head = first === first.toUpperCase() ? first.toLowerCase() : first[0].toLowerCase() + first.slice(1)
  return head + rest.map((word) => word[0].toUpperCase() + word.slice(1)).join('')
}

/** プロパティ property を写す props の名前（読み替えがあればそれ、なければ名前から作る）と、値の読み替え */
export function propMapping(code: CodeComponent, property: string): { prop: string; values: Record<string, string> } {
  const mapping = code.props.find((prop) => prop.property === property)
  return mapping ? { prop: mapping.prop, values: mapping.values } : { prop: autoPropName(property), values: {} }
}

/**
 * インスタンスを実装側の部品の呼び出しとして書くときの部品と props。元に対応がなければ null。
 * props の順は、バリアントのプロパティ（名前に書いた順）、コンポーネントのプロパティ（元の properties の順）。
 * 写す先のない（名前を作れない・空にした）プロパティと、対応のない部品への差し替えは出さない。同じ props の名前は先のものを使う
 */
export function codeCall(doc: DesignDocument, scene: Scene, instance: InstanceNode): CodeCall | null {
  const main = findMain(doc, instance.component.id)
  if (!main) return null
  const set = variantSetOf(main.page, main.node.id)
  const code = set ? set.setCode : main.node.component.code
  if (!code) return null
  const args: CodeArg[] = []
  const push = (prop: string, value: CodeValue) => {
    if (prop !== '' && !args.some((arg) => arg.prop === prop)) args.push({ prop, value })
  }
  if (set) {
    const booleans = new Set(variantProperties(main.page, set.id).filter(isBooleanProperty).map((property) => property.name))
    for (const [key, value] of parseVariantName(main.node.name) ?? []) {
      const { prop, values } = propMapping(code, key)
      if (booleans.has(key)) push(prop, { kind: 'boolean', value: value === 'true' })
      else push(prop, { kind: 'string', text: Object.hasOwn(values, value) ? values[value] : value })
    }
  }
  for (const state of instanceProperties(doc, scene, instance)) {
    const { prop } = propMapping(code, state.property.name)
    if (state.property.type === 'boolean') push(prop, { kind: 'boolean', value: state.value === true })
    else if (state.property.type === 'text') push(prop, { kind: 'string', text: String(state.value) })
    else {
      const target = codeOfComponent(doc, String(state.value))
      if (target) push(prop, { kind: 'element', code: target })
    }
  }
  return { code, args }
}
