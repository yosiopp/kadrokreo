import type { VariableCollection, VariableId, VariableValue } from '../document/types.ts'
import { cssIdent, cssVariableName, isAlias, variableIndex } from '../document/variables.ts'
import { type ColorFormat, formatColor } from './colors.ts'

// 変数の CSS（CSS 変数の定義）。最初のモードを :root に、ほかのモードを data 属性のセレクタ（[data-theme="dark"]）に書く。
// 属性名はコレクションの名前、値はモードの名前から作る（document/variables.ts の cssIdent）。別名は var(--別名の先) で書く。
// 真偽の変数は CSS で使い道がないので書かない

/** ids の変数（と、別名でたどる先の変数）の定義。ids を省くとすべての変数。書くものがなければ空文字 */
export function variablesCss(collections: readonly VariableCollection[], ids?: Iterable<VariableId>, color: ColorFormat = 'hex'): string {
  const wanted = ids === undefined ? null : withAliasTargets(collections, ids)
  const root: string[] = []
  const blocks: string[] = []
  for (const collection of collections) {
    const variables = collection.variables.filter((variable) => variable.type !== 'boolean' && (wanted === null || wanted.has(variable.id)))
    if (variables.length === 0) continue
    for (const [i, mode] of collection.modes.entries()) {
      const lines = variables.map((variable) => `  ${cssVariableName(collections, variable.id)}: ${valueCss(collections, variable.values[mode.id], color)};`)
      if (i === 0) root.push(...lines)
      else blocks.push(`${modeSelector(collection, mode.id)} {\n${lines.join('\n')}\n}`)
    }
  }
  if (root.length === 0) return ''
  return [`:root {\n${root.join('\n')}\n}`, ...blocks].join('\n\n')
}

/** モードを切り替えるセレクタ（[data-コレクション="モード"]） */
export function modeSelector(collection: VariableCollection, modeId: string): string {
  const mode = collection.modes.find((item) => item.id === modeId)
  return `[${modeAttribute(collection)}="${cssIdent(mode?.name ?? modeId) || modeId}"]`
}

/** モードを切り替える data 属性の名前 */
export function modeAttribute(collection: VariableCollection): string {
  return `data-${cssIdent(collection.name) || collection.id.toLowerCase()}`
}

function valueCss(collections: readonly VariableCollection[], value: VariableValue, color: ColorFormat): string {
  if (isAlias(value)) return `var(${cssVariableName(collections, value.alias)})`
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)) return formatColor(value, color)
  // 文字は CSS の文字列にする（" と \ と改行はエスケープ。<style> を閉じられないよう < も）
  return `"${String(value).replace(/[\\"<\n\r\f]/g, (char) => `\\${char.charCodeAt(0).toString(16)} `)}"`
}

/** ids と、そこから別名でたどれる変数の id（無い変数は除く） */
function withAliasTargets(collections: readonly VariableCollection[], ids: Iterable<VariableId>): Set<VariableId> {
  const index = variableIndex(collections)
  const out = new Set<VariableId>()
  const stack = [...ids]
  while (stack.length > 0) {
    const id = stack.pop()!
    const entry = index.get(id)
    if (!entry || out.has(id)) continue
    out.add(id)
    for (const value of Object.values(entry.variable.values)) if (isAlias(value)) stack.push(value.alias)
  }
  return out
}

// 変数の JSON（Design Tokens Community Group の形式）。コレクションを最上位のグループにし、変数の名前の / をグループの区切りにする。
// $value は最初のモードの値、ほかのモードの値は $extensions.kadrokreo.modes にモードの名前ごとに入れる（取り込みで戻せるように）。
// コレクションのモードの並びは、コレクションのグループの $extensions.kadrokreo.modes。別名は {コレクション.グループ.名前}。
// 種類は color・number・string・boolean（string と boolean はこの形式の決まりにない種類で、ほかの道具は読まないことがある）

/** JSON にできない変数（名前に . { } があるなど） */
export class TokensError extends Error {
  override name = 'TokensError'
}

/** 取り込みでも使う、この形式の拡張の名前 */
export const TOKENS_EXTENSION = 'kadrokreo'

type TokenGroup = { [key: string]: unknown }

/** 変数の JSON の文字列 */
export function variablesJson(collections: readonly VariableCollection[]): string {
  const index = variableIndex(collections)
  const pathOf = (id: VariableId) => {
    const entry = index.get(id)!
    return [entry.collection.name, ...entry.variable.name.split('/')]
  }
  const reference = (value: VariableValue) => (isAlias(value) ? `{${pathOf(value.alias).join('.')}}` : value)
  // グループはプロトタイプを持たないオブジェクトにする（__proto__ や constructor という名前も、ふつうの項目として書く）
  const group = (): TokenGroup => Object.create(null) as TokenGroup
  const root = group()
  for (const collection of collections) {
    checkSegment(collection.name, collection.name)
    if (Object.hasOwn(root, collection.name)) throw new TokensError(`同じ名前のコレクションがあります: ${collection.name}`)
    const top = group()
    top.$extensions = { [TOKENS_EXTENSION]: { modes: collection.modes.map((mode) => mode.name) } }
    root[collection.name] = top
    for (const variable of collection.variables) {
      const segments = variable.name.split('/')
      for (const segment of segments) checkSegment(segment, variable.name)
      let parent = top
      for (const segment of segments.slice(0, -1)) {
        if (Object.hasOwn(parent, segment) && Object.hasOwn(parent[segment] as object, '$value')) {
          throw new TokensError(`${variable.name}: グループと同じ名前の変数があります（${segment}）`)
        }
        if (!Object.hasOwn(parent, segment)) parent[segment] = group()
        parent = parent[segment] as TokenGroup
      }
      const last = segments[segments.length - 1]
      if (Object.hasOwn(parent, last)) throw new TokensError(`${variable.name}: グループと同じ名前の変数があります`)
      const [first, ...rest] = collection.modes
      parent[last] = {
        $type: variable.type,
        $value: reference(variable.values[first.id]),
        ...(rest.length > 0
          ? { $extensions: { [TOKENS_EXTENSION]: { modes: Object.fromEntries(rest.map((mode) => [mode.name, reference(variable.values[mode.id])])) } } }
          : {}),
      }
    }
  }
  return `${JSON.stringify(root, null, 2)}\n`
}

/** JSON の名前にできるか（空、. { } を含む、$ で始まるものはできない） */
function checkSegment(segment: string, name: string): void {
  if (segment === '' || /[.{}]/.test(segment) || segment.startsWith('$')) {
    throw new TokensError(`${name}: JSON に書けない名前です（空の区切り、. { } を含む、$ で始まる名前は書けません）`)
  }
}
