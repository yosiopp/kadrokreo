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
  return `"${String(value).replace(/[\\"<]/g, (char) => `\\${char.charCodeAt(0).toString(16)} `).replace(/\n/g, '\\a ')}"`
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
