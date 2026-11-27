import { KDR_MAX_MODES, MAX_VARIABLE_NAME_LENGTH } from '../../document/kdr.ts'
import type { DesignDocument, Variable, VariableCollection, VariableId, VariableType } from '../../document/types.ts'
import { isAlias } from '../../document/variables.ts'
import { TOKENS_EXTENSION } from '../../viewer/tokens.ts'
import { createId } from '../nodes.ts'
import { DEFAULT_VARIABLE_VALUES } from './variables.ts'

// 変数の JSON（Design Tokens Community Group の形式）の取り込み。viewer/tokens.ts の variablesJson が書いたものは、モードと別名ごと戻る。
// ほかの道具が書いた JSON は、全部を 1 つのコレクション（Tokens）の最初のモードとして読む。
// 名前が同じ変数（同じコレクション）は値を書き換え、無ければ足す。読めない種類（影・文字の書式の組など）や値は飛ばして知らせる。
// 大きな JSON でも速いよう、コレクションの写しを組み立ててから最後に 1 回だけドキュメントへ入れる（変数の操作を 1 つずつ呼ぶと、
// 呼ぶたびに索引を作り直すので変数の数の 2 乗かかる）

export type TokensImport = { document: DesignDocument; added: number; updated: number; warnings: string[] }

/** 取り込みの誤り（JSON の形でない・大きすぎる） */
export class TokensImportError extends Error {
  override name = 'TokensImportError'
}

/** ほかの道具の JSON を入れるコレクションの名前 */
const DEFAULT_COLLECTION = 'Tokens'
/** 取り込める変数の数の上限（kdr の上限と同じ） */
const MAX_TOKENS = 10_000
/** たどるグループの入れ子の深さの上限 */
const MAX_DEPTH = 100

type Raw = { [key: string]: unknown }

/** 読んだ値。別名は、まだ id に直していない JSON の道筋（text は別名の先が無いときの、文字としての値） */
type ReadValue = { kind: 'value'; value: string | number | boolean } | { kind: 'alias'; path: string; text: string }

type Token = {
  collection: string
  name: string
  /** null は、種類が書いてない別名（先の種類を受け継ぐ） */
  type: VariableType | null
  dtcgType: string | undefined
  /** モードの名前ごとの値 */
  values: Map<string, ReadValue>
  /** JSON の道筋（別名の先を探すため） */
  path: string
}

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 名前として使えるように整える。使えなければ null */
function cleanName(name: string): string | null {
  const trimmed = name.trim()
  // eslint-disable-next-line no-control-regex -- 制御文字を弾くための検査なので、制御文字そのものを書く
  if (trimmed === '' || trimmed.length > MAX_VARIABLE_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) return null
  return trimmed
}

/** 変数の JSON を、ドキュメントの変数に取り込む */
export function importTokens(doc: DesignDocument, json: unknown): TokensImport {
  if (!isRecord(json)) throw new TokensImportError('変数の JSON ではありません（オブジェクトではありません）')
  const warnings: string[] = []
  const tokens: Token[] = []
  /** コレクションの名前 → JSON に書いてあったモードの並び */
  const collectionModes = new Map<string, string[]>()

  // この道具の書いた JSON は、最上位のグループがコレクション（モードの並びを持つ）
  const ours = Object.entries(json).some(([key, value]) => !key.startsWith('$') && isRecord(value) && modesOf(value) !== null)
  if (ours) {
    for (const [key, group] of Object.entries(json)) {
      if (key.startsWith('$') || !isRecord(group)) continue
      const name = cleanName(key)
      if (name === null) {
        warnings.push(`${key}: コレクションの名前にできないので飛ばしました`)
        continue
      }
      const modes = modesOf(group) ?? ['Mode 1']
      if (modes.length > KDR_MAX_MODES) throw new TokensImportError(`${name}: モードが多すぎます（${KDR_MAX_MODES} 個まで）`)
      collectionModes.set(name, modes)
      collect(group, [key], [], undefined, name, modes, tokens, warnings, 1)
    }
  } else {
    // 同じ名前のコレクションがあれば、その最初のモードに入れる（名前を変えていても余計なモードを足さない）
    const existing = doc.collections.find((collection) => collection.name === DEFAULT_COLLECTION)
    const modes = [existing?.modes[0].name ?? 'Mode 1']
    collectionModes.set(DEFAULT_COLLECTION, modes)
    collect(json, [], [], undefined, DEFAULT_COLLECTION, modes, tokens, warnings, 1)
  }
  if (tokens.length > MAX_TOKENS) throw new TokensImportError(`変数が多すぎます（${MAX_TOKENS} 個まで）`)

  // 種類の書いてない別名は、先の種類を受け継ぐ
  const byPath = new Map(tokens.map((token) => [token.path, token]))
  for (const token of tokens) {
    if (token.type !== null) continue
    const seen = new Set<Token>()
    let current: Token | undefined = token
    while (current && current.type === null && !seen.has(current)) {
      seen.add(current)
      const first: ReadValue | undefined = [...current.values.values()][0]
      current = first?.kind === 'alias' ? byPath.get(first.path) : undefined
    }
    token.type = current?.type ?? null
    if (token.type === null) warnings.push(`${token.path}: 種類が分からないので飛ばしました`)
  }

  // 1. コレクションの写しを作る（無ければ作り、足りないモードを足す。足したモードの値は最初のモードのものを写す）
  type Working = { collection: VariableCollection; byName: Map<string, Variable> }
  const working = new Map<string, Working>()
  const collections = [...doc.collections]
  for (const [name, modes] of collectionModes) {
    // ほかの道具の JSON から変数が 1 つも読めなければ、コレクションを作らない（この道具の JSON の空のコレクションは戻す）
    if (!ours && !tokens.some((token) => token.collection === name)) continue
    const index = collections.findIndex((item) => item.name === name)
    let collection: VariableCollection =
      index === -1
        ? { id: createId(), name, modes: [{ id: createId(), name: modes[0] }], variables: [] }
        : { ...collections[index], modes: [...collections[index].modes], variables: collections[index].variables.map((variable) => ({ ...variable, values: { ...variable.values } })) }
    for (const mode of modes) {
      if (collection.modes.some((item) => item.name === mode)) continue
      if (collection.modes.length >= KDR_MAX_MODES) throw new TokensImportError(`${name}: モードが多すぎます（${KDR_MAX_MODES} 個まで）`)
      const id = createId()
      for (const variable of collection.variables) variable.values[id] = variable.values[collection.modes[0].id]
      collection = { ...collection, modes: [...collection.modes, { id, name: mode }] }
    }
    if (index === -1) collections.push(collection)
    else collections[index] = collection
    working.set(name, { collection, byName: new Map(collection.variables.map((variable) => [variable.name, variable])) })
  }

  // 2. 変数を用意する（ある変数は写しを、無ければ既定の値で足す）
  const ids = new Map<string, VariableId>()
  const variables = new Map<VariableId, Variable>()
  for (const { collection } of working.values()) for (const variable of collection.variables) variables.set(variable.id, variable)
  for (const collection of collections) if (!working.has(collection.name)) for (const variable of collection.variables) variables.set(variable.id, variable)
  const fresh = new Set<VariableId>()
  let added = 0
  let updated = 0
  const usable: Token[] = []
  for (const token of tokens) {
    if (token.type === null) continue
    const { collection, byName } = working.get(token.collection)!
    const existing = byName.get(token.name)
    if (existing) {
      if (existing.type !== token.type) {
        warnings.push(`${token.path}: 同じ名前の ${existing.type} の変数があるので飛ばしました（JSON では ${token.type}）`)
        continue
      }
      if (!ids.has(token.path)) updated++
      ids.set(token.path, existing.id)
    } else {
      const variable: Variable = {
        id: createId(),
        name: token.name,
        type: token.type,
        values: Object.fromEntries(collection.modes.map((mode) => [mode.id, DEFAULT_VARIABLE_VALUES[token.type!]])),
      }
      collection.variables.push(variable)
      byName.set(token.name, variable)
      variables.set(variable.id, variable)
      fresh.add(variable.id)
      ids.set(token.path, variable.id)
      added++
    }
    usable.push(token)
  }

  // 3. 値を入れる。先に値を全部入れてから別名を入れる（入れ替えの途中で、循環していると見誤らないように）。
  // 書かれていないモードは、新しい変数なら最初のモードの値にし、ある変数なら今のまま
  const assignments: { token: Token; variable: Variable; mode: string; modeName: string; read: ReadValue }[] = []
  for (const token of usable) {
    const variable = variables.get(ids.get(token.path)!)!
    const { collection } = working.get(token.collection)!
    const first = token.values.get(collectionModes.get(token.collection)![0])
    for (const mode of collection.modes) {
      const read = token.values.get(mode.name) ?? (fresh.has(variable.id) ? first : undefined)
      if (read) assignments.push({ token, variable, mode: mode.id, modeName: mode.name, read })
    }
  }
  for (const { variable, mode, read } of assignments) if (read.kind === 'value') variable.values[mode] = read.value
  for (const { token, variable, mode, modeName, read } of assignments) {
    if (read.kind !== 'alias') continue
    const target = ids.get(read.path)
    if (target === undefined) {
      // 文字の変数の「{…}」は、別名の先が無ければ、その文字のまま（書き出した文字の値を戻す）
      if (variable.type === 'string') variable.values[mode] = read.text
      else warnings.push(`${token.path}: 別名の先 {${read.path}} が無いので、モード ${modeName} の値を入れませんでした`)
      continue
    }
    if (variables.get(target)!.type !== variable.type) {
      warnings.push(`${token.path}: 別名の先 {${read.path}} の種類が違うので、モード ${modeName} の値を入れませんでした`)
      continue
    }
    if (reaches(variables, target, variable.id)) {
      warnings.push(`${token.path}: 別名が循環するので、モード ${modeName} の値を入れませんでした`)
      continue
    }
    variable.values[mode] = { alias: target }
  }
  return { document: { ...doc, collections }, added, updated, warnings }
}

/** from から別名をたどって to に着くか（どのモードの別名もたどる） */
function reaches(variables: ReadonlyMap<VariableId, Variable>, from: VariableId, to: VariableId): boolean {
  const seen = new Set<VariableId>()
  const stack = [from]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (id === to) return true
    if (seen.has(id)) continue
    seen.add(id)
    const variable = variables.get(id)
    if (!variable) continue
    for (const value of Object.values(variable.values)) if (isAlias(value)) stack.push((value as { alias: VariableId }).alias)
  }
  return false
}

/** この道具の書いたコレクションのグループのモードの並び。無ければ null */
function modesOf(group: Raw): string[] | null {
  const extension = isRecord(group.$extensions) ? group.$extensions[TOKENS_EXTENSION] : undefined
  if (!isRecord(extension) || !Array.isArray(extension.modes)) return null
  const modes = extension.modes.flatMap((mode) => (typeof mode === 'string' ? (cleanName(mode) ?? []) : []))
  return modes.length > 0 ? [...new Set(modes)] : null
}

/** グループをたどって変数を集める。path は JSON の道筋、names は変数の名前にする部分（コレクションを除く） */
function collect(
  group: Raw,
  path: string[],
  names: string[],
  inheritedType: string | undefined,
  collection: string,
  modes: string[],
  tokens: Token[],
  warnings: string[],
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    warnings.push(`${path.join('.')}: 入れ子が深すぎるので、中を飛ばしました`)
    return
  }
  const groupType = typeof group.$type === 'string' ? group.$type : inheritedType
  for (const [key, value] of Object.entries(group)) {
    if (key.startsWith('$') || !isRecord(value)) continue
    if (tokens.length > MAX_TOKENS) return
    const here = [...path, key]
    const segment = key.trim()
    if (!Object.hasOwn(value, '$value')) {
      collect(value, here, [...names, segment], groupType, collection, modes, tokens, warnings, depth + 1)
      continue
    }
    const name = cleanName([...names, segment].join('/'))
    if (name === null || [...names, segment].some((part) => part === '')) {
      warnings.push(`${here.join('.')}: 変数の名前にできないので飛ばしました`)
      continue
    }
    const dtcgType = typeof value.$type === 'string' ? value.$type : groupType
    const type = variableType(dtcgType, value.$value)
    if (type === undefined) {
      warnings.push(`${here.join('.')}: 種類 ${dtcgType ?? '（なし）'} は変数にできないので飛ばしました`)
      continue
    }
    const values = new Map<string, ReadValue>()
    const first = readValue(value.$value, type, dtcgType)
    if (first === null) {
      warnings.push(`${here.join('.')}: 値が読めないので飛ばしました`)
      continue
    }
    values.set(modes[0], first)
    const extension = isRecord(value.$extensions) ? value.$extensions[TOKENS_EXTENSION] : undefined
    if (isRecord(extension) && isRecord(extension.modes)) {
      for (const [mode, raw] of Object.entries(extension.modes)) {
        if (!modes.includes(mode)) continue
        const read = readValue(raw, type, dtcgType)
        if (read === null) warnings.push(`${here.join('.')}: モード ${mode} の値が読めないので飛ばしました`)
        else values.set(mode, read)
      }
    }
    tokens.push({ collection, name, type, dtcgType, values, path: here.join('.') })
  }
}

/** DTCG の種類（と値）から変数の種類。種類の無い別名は null（先から受け継ぐ）、変数にできなければ undefined */
function variableType(type: string | undefined, value: unknown): VariableType | null | undefined {
  switch (type) {
    case 'color':
      return 'color'
    case 'number':
    case 'dimension':
    case 'fontWeight':
      return 'number'
    case 'string':
    case 'fontFamily':
      return 'string'
    case 'boolean':
      return 'boolean'
    case undefined:
      // 種類が書いていなければ、値の形から
      if (typeof value === 'number') return 'number'
      if (typeof value === 'boolean') return 'boolean'
      if (typeof value === 'string') return /^\{.+\}$/.test(value.trim()) ? null : /^#[0-9a-fA-F]{3,8}$/.test(value) ? 'color' : 'string'
      return undefined
    default:
      return undefined
  }
}

const FONT_WEIGHTS: Record<string, number> = {
  thin: 100,
  hairline: 100,
  'extra-light': 200,
  'ultra-light': 200,
  light: 300,
  normal: 400,
  regular: 400,
  book: 400,
  medium: 500,
  'semi-bold': 600,
  'demi-bold': 600,
  bold: 700,
  'extra-bold': 800,
  'ultra-bold': 800,
  black: 900,
  heavy: 900,
}

/** 値を読む。別名（{a.b.c}）はそのまま道筋で返す。読めなければ null */
function readValue(raw: unknown, type: VariableType | null, dtcgType: string | undefined): ReadValue | null {
  if (typeof raw === 'string') {
    const alias = /^\{(.+)\}$/.exec(raw.trim())
    if (alias) return { kind: 'alias', path: alias[1], text: raw }
  }
  if (type === null) return null
  const value = plainValue(raw, type, dtcgType)
  return value === null ? null : { kind: 'value', value }
}

function plainValue(raw: unknown, type: VariableType, dtcgType: string | undefined): string | number | boolean | null {
  switch (type) {
    case 'color':
      return color(raw)
    case 'number':
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw
      if (dtcgType === 'fontWeight' && typeof raw === 'string') return Object.hasOwn(FONT_WEIGHTS, raw.toLowerCase()) ? FONT_WEIGHTS[raw.toLowerCase()] : null
      return dimension(raw)
    case 'string':
      if (typeof raw === 'string') return raw
      // 書体の並びは CSS の font-family と同じくカンマでつなぐ
      if (Array.isArray(raw) && raw.every((item) => typeof item === 'string')) return raw.join(', ')
      return null
    case 'boolean':
      return typeof raw === 'boolean' ? raw : null
  }
}

/** 長さ。px はそのまま、rem・em は 16px として直す。{ value, unit } の形も読む */
function dimension(raw: unknown): number | null {
  let value: number
  let unit: string
  if (isRecord(raw) && typeof raw.value === 'number' && typeof raw.unit === 'string') {
    value = raw.value
    unit = raw.unit
  } else if (typeof raw === 'string') {
    const match = /^(-?\d*\.?\d+)\s*(px|rem|em)?$/.exec(raw.trim())
    if (!match) return null
    value = Number(match[1])
    unit = match[2] ?? 'px'
  } else return null
  if (!Number.isFinite(value)) return null
  return unit === 'px' ? value : unit === 'rem' || unit === 'em' ? value * 16 : null
}

/** 色。#rgb・#rrggbb（#rrggbbaa・#rgba の透明度は捨てる）と、hex を持つ色のオブジェクト・sRGB の components を読む */
function color(raw: unknown): string | null {
  if (isRecord(raw)) {
    if (typeof raw.hex === 'string') return color(raw.hex)
    if (raw.colorSpace === 'srgb' && Array.isArray(raw.components) && raw.components.length === 3 && raw.components.every((c) => typeof c === 'number')) {
      return `#${(raw.components as number[]).map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('')}`
    }
    return null
  }
  if (typeof raw !== 'string') return null
  const text = raw.trim().toLowerCase()
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(text)) return text.slice(0, 7)
  if (/^#[0-9a-f]{3}[0-9a-f]?$/.test(text)) return `#${[...text.slice(1, 4)].map((c) => c + c).join('')}`
  return null
}
