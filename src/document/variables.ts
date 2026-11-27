// 変数（名前の付いた値、デザイントークン）の解決。
//
// ノードの色などには、いつも解決済みの値が入っている（ファイルにも書く）。変数を指す印（塗り・線・グラデーションの色・影の variable）は
// その横にあり、変数の値やモードの指定が変わったら、applyVariables でつながりのある値を解決し直す（読み込みのときと、editor の後始末）。
// 描画や書き出しのように表示するだけの処理は、変数を読まなくてよい。
//
// ノードで使うモードは、自分から上へたどって最初にそのコレクションの指定（modes）があるフレーム、無ければページ、
// それも無ければコレクションの最初のモード。別名（{ alias }）の先が別のコレクションの変数なら、その先のコレクションのモードを
// 同じノードの位置で決める。
import type {
  ColorStop,
  DesignDocument,
  Effect,
  ModeId,
  ModeSelection,
  NodeId,
  Override,
  Page,
  Paint,
  SceneNode,
  Variable,
  VariableCollection,
  VariableId,
  VariableValue,
} from './types.ts'

/** 別名をたどる深さの上限（循環は読み込みで拒んでいるが、念のため） */
export const MAX_ALIAS_DEPTH = 32

export type VariableEntry = { variable: Variable; collection: VariableCollection }

const indexes = new WeakMap<readonly VariableCollection[], ReadonlyMap<VariableId, VariableEntry>>()

/** 変数の id から、変数とそのコレクション */
export function variableIndex(collections: readonly VariableCollection[]): ReadonlyMap<VariableId, VariableEntry> {
  const known = indexes.get(collections)
  if (known) return known
  const index = new Map<VariableId, VariableEntry>()
  for (const collection of collections) for (const variable of collection.variables) index.set(variable.id, { variable, collection })
  indexes.set(collections, index)
  return index
}

/** コレクションで使うモードを決める関数 */
export type ModeLookup = (collection: VariableCollection) => ModeId

export function isAlias(value: VariableValue): value is { alias: VariableId } {
  return typeof value === 'object' && value !== null
}

/** 変数の、あるモードの値（別名ならそのまま返す）。モードが無ければ最初のモードの値 */
export function modeValue(variable: Variable, collection: VariableCollection, mode: ModeId): VariableValue {
  return Object.hasOwn(variable.values, mode) ? variable.values[mode] : variable.values[collection.modes[0].id]
}

/**
 * 変数を解決した値。別名をたどる。変数が無い・たどりきれない（深すぎる）なら undefined
 */
export function resolveVariable(
  index: ReadonlyMap<VariableId, VariableEntry>,
  id: VariableId,
  lookup: ModeLookup,
): string | number | boolean | undefined {
  let current = id
  for (let depth = 0; depth <= MAX_ALIAS_DEPTH; depth++) {
    const entry = index.get(current)
    if (!entry) return undefined
    const value = modeValue(entry.variable, entry.collection, lookup(entry.collection))
    if (!isAlias(value)) return value
    current = value.alias
  }
  return undefined
}

/** 指定 selection のうち、コレクションにあるモードを指しているもの */
function selected(selection: ModeSelection | undefined, collection: VariableCollection): ModeId | undefined {
  if (!selection || !Object.hasOwn(selection, collection.id)) return undefined
  const mode = selection[collection.id]
  return collection.modes.some((item) => item.id === mode) ? mode : undefined
}

/**
 * ノード id の位置で使うモードを決める関数（id が null ならページ直下）。
 * view はページの指定の代わりに使う指定（viewer の切り替え）。フレームの指定はそれより強い
 */
export function modesAt(page: Page, id: NodeId | null, view?: ModeSelection): ModeLookup {
  return (collection) => {
    for (let current = id; current !== null; ) {
      const node: SceneNode | undefined = page.nodes[current]
      if (!node) break
      if (node.type === 'frame') {
        const mode = selected(node.modes, collection)
        if (mode !== undefined) return mode
      }
      current = node.parentId
    }
    return selected(view, collection) ?? selected(page.modes, collection) ?? collection.modes[0].id
  }
}

/**
 * つながりのある値を解決し直したドキュメント。変わらなければ doc をそのまま返す（変わったページ・ノードだけを作り直す）。
 * before を渡すと、コレクションが同じなら before から変わっていないページは見ない
 */
export function applyVariables(doc: DesignDocument, before?: DesignDocument, view?: ModeSelection): DesignDocument {
  if (doc.collections.length === 0) return doc
  const index = variableIndex(doc.collections)
  const all = !before || before.collections !== doc.collections || view !== undefined
  let changed = false
  const pages = doc.pages.map((page) => {
    if (!all && before.pages.includes(page)) return page
    const next = applyToPage(page, index, view)
    if (next !== page) changed = true
    return next
  })
  return changed ? { ...doc, pages } : doc
}

function applyToPage(page: Page, index: ReadonlyMap<VariableId, VariableEntry>, view: ModeSelection | undefined): Page {
  let nodes: Record<NodeId, SceneNode> | null = null
  for (const id in page.nodes) {
    const node = page.nodes[id]
    if (!hasBinding(node)) continue
    const lookup = modesAt(page, id, view)
    const color = (variable: VariableId, fallback: string): string => {
      const value = resolveVariable(index, variable, lookup)
      return typeof value === 'string' && index.get(variable)?.variable.type === 'color' ? value : fallback
    }
    const next = resolveNode(node, color)
    if (next !== node) (nodes ??= { ...page.nodes })[id] = next
  }
  return nodes ? { ...page, nodes } : page
}

type ColorResolver = (variable: VariableId, fallback: string) => string

/** 色のつながりを持つか（速く飛ばすため） */
function hasBinding(node: SceneNode): boolean {
  if ('fills' in node && node.fills.some(paintBound)) return true
  if ('strokes' in node && node.strokes.some(paintBound)) return true
  if (node.effects.some((effect) => 'variable' in effect && effect.variable !== undefined)) return true
  if (node.type === 'frame' && node.component?.role === 'instance') {
    return Object.values(node.component.overrides).some(
      (override) => override.fills?.some(paintBound) === true || override.strokes?.some(paintBound) === true,
    )
  }
  return false
}

function paintBound(paint: Paint): boolean {
  return paint.type === 'solid' ? paint.variable !== undefined : paint.stops.some((stop) => stop.variable !== undefined)
}

function resolveNode(node: SceneNode, color: ColorResolver): SceneNode {
  let next = node
  const set = <K extends keyof SceneNode>(key: K, value: SceneNode[K]) => {
    if (value !== node[key]) next = { ...next, [key]: value } as SceneNode
  }
  if ('fills' in node) set('fills' as keyof SceneNode, resolvePaints(node.fills, color) as never)
  if ('strokes' in node) set('strokes' as keyof SceneNode, resolvePaints(node.strokes, color) as never)
  set('effects', resolveEffects(node.effects, color))
  if (node.type === 'frame' && node.component?.role === 'instance') {
    const overrides = node.component.overrides
    let resolved: Record<NodeId, Override> | null = null
    for (const [id, override] of Object.entries(overrides)) {
      const fills = override.fills && resolvePaints(override.fills, color)
      const strokes = override.strokes && resolvePaints(override.strokes, color)
      if (fills !== override.fills || strokes !== override.strokes) {
        ;(resolved ??= { ...overrides })[id] = {
          ...override,
          ...(fills ? { fills } : {}),
          ...(strokes ? { strokes } : {}),
        }
      }
    }
    if (resolved && next.type === 'frame' && next.component?.role === 'instance') {
      next = { ...next, component: { ...next.component, overrides: resolved } }
    }
  }
  return next
}

/** 塗りの並びのつながりを解決したもの。変わらなければ同じ配列 */
export function resolvePaints(paints: Paint[], color: ColorResolver): Paint[] {
  let out: Paint[] | null = null
  for (const [i, paint] of paints.entries()) {
    const next = resolvePaint(paint, color)
    if (next !== paint) (out ??= [...paints])[i] = next
  }
  return out ?? paints
}

function resolvePaint(paint: Paint, color: ColorResolver): Paint {
  if (paint.type === 'solid') {
    if (paint.variable === undefined) return paint
    const value = color(paint.variable, paint.color)
    return value === paint.color ? paint : { ...paint, color: value }
  }
  let stops: ColorStop[] | null = null
  for (const [i, stop] of paint.stops.entries()) {
    if (stop.variable === undefined) continue
    const value = color(stop.variable, stop.color)
    if (value !== stop.color) (stops ??= [...paint.stops])[i] = { ...stop, color: value }
  }
  return stops ? { ...paint, stops } : paint
}

function resolveEffects(effects: Effect[], color: ColorResolver): Effect[] {
  let out: Effect[] | null = null
  for (const [i, effect] of effects.entries()) {
    if (!('variable' in effect) || effect.variable === undefined) continue
    const value = color(effect.variable, effect.color)
    if (value !== effect.color) (out ??= [...effects])[i] = { ...effect, color: value }
  }
  return out ?? effects
}

/** ノード（とインスタンスの上書き）が色をつないでいる変数の id */
export function boundVariables(node: SceneNode): VariableId[] {
  const ids: VariableId[] = []
  const paints = (list: readonly Paint[]) => {
    for (const paint of list) {
      if (paint.type === 'solid') {
        if (paint.variable !== undefined) ids.push(paint.variable)
      } else for (const stop of paint.stops) if (stop.variable !== undefined) ids.push(stop.variable)
    }
  }
  if ('fills' in node) paints(node.fills)
  if ('strokes' in node) paints(node.strokes)
  for (const effect of node.effects) if ('variable' in effect && effect.variable !== undefined) ids.push(effect.variable)
  if (node.type === 'frame' && node.component?.role === 'instance') {
    for (const override of Object.values(node.component.overrides)) {
      if (override.fills) paints(override.fills)
      if (override.strokes) paints(override.strokes)
    }
  }
  return ids
}

/**
 * CSS 変数の名前（-- を含む）。name の / で区切ったそれぞれを小文字にし、英数字・_・- 以外（空白や記号）を - にしてつなぐ。
 * 別のコレクションに同じ名前になる変数があるときだけ、コレクションの名前を前に付ける
 */
export function cssVariableName(collections: readonly VariableCollection[], id: VariableId): string {
  return cssVariableNames(collections).get(id) ?? `--${cssIdent(id)}`
}

const cssNames = new WeakMap<readonly VariableCollection[], ReadonlyMap<VariableId, string>>()

export function cssVariableNames(collections: readonly VariableCollection[]): ReadonlyMap<VariableId, string> {
  const known = cssNames.get(collections)
  if (known) return known
  const base = new Map<VariableId, string>()
  const count = new Map<string, number>()
  for (const collection of collections) {
    for (const variable of collection.variables) {
      const name = variable.name.split('/').map(cssIdent).filter((part) => part !== '').join('-') || cssIdent(variable.id)
      base.set(variable.id, name)
      count.set(name, (count.get(name) ?? 0) + 1)
    }
  }
  const names = new Map<VariableId, string>()
  for (const collection of collections) {
    for (const variable of collection.variables) {
      const name = base.get(variable.id)!
      names.set(variable.id, (count.get(name)! > 1 ? `--${cssIdent(collection.name) || cssIdent(collection.id)}-` : '--') + name)
    }
  }
  cssNames.set(collections, names)
  return names
}

/** CSS の名前に使える形（小文字、英数字・_・- 以外は -、- の重なりと両端の - は除く）。日本語などはそのまま残す */
export function cssIdent(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s!-,./:-@[-^`{-~]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}
