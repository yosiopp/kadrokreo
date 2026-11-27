import { isAlias, resolveVariable, variableIndex } from '../../document/variables.ts'
import type {
  CollectionId,
  DesignDocument,
  Effect,
  ModeId,
  ModeSelection,
  NodeId,
  Override,
  Page,
  PageId,
  Paint,
  SceneNode,
  Variable,
  VariableCollection,
  VariableId,
  VariableType,
  VariableValue,
} from '../../document/types.ts'
import { createId } from '../nodes.ts'
import { updatePage } from './document.ts'

// 変数（コレクション・モード・変数）の操作。どれも新しいドキュメントを返し、変化がなければ同じ参照を返す。
// つながりのある値の解決し直しは、ストアの後始末（document/variables.ts の applyVariables）がする。
// 名前の重なりや値の形の誤りは VariableError にする（画面や CLI がそのまま知らせる）

export class VariableError extends Error {
  override name = 'VariableError'
}

/** 新しい変数の既定値 */
export const DEFAULT_VARIABLE_VALUES: Record<VariableType, string | number | boolean> = {
  color: '#000000',
  number: 0,
  string: '',
  boolean: true,
}

export function findCollection(doc: DesignDocument, id: CollectionId): VariableCollection | undefined {
  return doc.collections.find((collection) => collection.id === id)
}

export function findVariable(doc: DesignDocument, id: VariableId): { variable: Variable; collection: VariableCollection } | undefined {
  return variableIndex(doc.collections).get(id)
}

function checkName(name: string, what: string): string {
  const trimmed = name.trim()
  if (trimmed === '') throw new VariableError(`${what}の名前が空です`)
  return trimmed
}

function updateCollection(doc: DesignDocument, id: CollectionId, recipe: (collection: VariableCollection) => VariableCollection): DesignDocument {
  const index = doc.collections.findIndex((collection) => collection.id === id)
  if (index === -1) return doc
  const next = recipe(doc.collections[index])
  return next === doc.collections[index] ? doc : { ...doc, collections: doc.collections.with(index, next) }
}

function updateVariable(doc: DesignDocument, id: VariableId, recipe: (variable: Variable, collection: VariableCollection) => Variable): DesignDocument {
  const found = findVariable(doc, id)
  if (!found) return doc
  return updateCollection(doc, found.collection.id, (collection) => {
    const index = collection.variables.findIndex((variable) => variable.id === id)
    const next = recipe(collection.variables[index], collection)
    return next === collection.variables[index] ? collection : { ...collection, variables: collection.variables.with(index, next) }
  })
}

/** コレクションを足す（モードを 1 つ持つ）。名前が重なるときは VariableError */
export function addCollection(doc: DesignDocument, name: string, modeName = 'Mode 1'): { document: DesignDocument; id: CollectionId } {
  const collectionName = checkName(name, 'コレクション')
  if (doc.collections.some((collection) => collection.name === collectionName)) {
    throw new VariableError(`同じ名前のコレクションがあります: ${collectionName}`)
  }
  const collection: VariableCollection = {
    id: createId(),
    name: collectionName,
    modes: [{ id: createId(), name: checkName(modeName, 'モード') }],
    variables: [],
  }
  return { document: { ...doc, collections: [...doc.collections, collection] }, id: collection.id }
}

export function renameCollection(doc: DesignDocument, id: CollectionId, name: string): DesignDocument {
  const collectionName = checkName(name, 'コレクション')
  if (doc.collections.some((collection) => collection.id !== id && collection.name === collectionName)) {
    throw new VariableError(`同じ名前のコレクションがあります: ${collectionName}`)
  }
  return updateCollection(doc, id, (collection) => (collection.name === collectionName ? collection : { ...collection, name: collectionName }))
}

/** コレクションを消す。その変数へのつながりは外し（値は残す）、別のコレクションからの別名は値に置き換え、モードの指定も消す */
export function removeCollection(doc: DesignDocument, id: CollectionId): DesignDocument {
  const collection = findCollection(doc, id)
  if (!collection) return doc
  const removed = new Set(collection.variables.map((variable) => variable.id))
  const inlined = inlineAliases(doc, removed)
  return clearSelections(detachVariables({ ...inlined, collections: inlined.collections.filter((item) => item.id !== id) }, removed), id, null)
}

/** モードを足す。値は最初のモードのものを写す */
export function addMode(doc: DesignDocument, collectionId: CollectionId, name: string): { document: DesignDocument; id: ModeId } {
  const modeName = checkName(name, 'モード')
  const id = createId()
  const document = updateCollection(doc, collectionId, (collection) => {
    if (collection.modes.some((mode) => mode.name === modeName)) throw new VariableError(`同じ名前のモードがあります: ${modeName}`)
    const first = collection.modes[0].id
    return {
      ...collection,
      modes: [...collection.modes, { id, name: modeName }],
      variables: collection.variables.map((variable) => ({ ...variable, values: { ...variable.values, [id]: variable.values[first] } })),
    }
  })
  if (document === doc) throw new VariableError('コレクションがありません')
  return { document, id }
}

export function renameMode(doc: DesignDocument, collectionId: CollectionId, modeId: ModeId, name: string): DesignDocument {
  const modeName = checkName(name, 'モード')
  return updateCollection(doc, collectionId, (collection) => {
    if (collection.modes.some((mode) => mode.id !== modeId && mode.name === modeName)) throw new VariableError(`同じ名前のモードがあります: ${modeName}`)
    const index = collection.modes.findIndex((mode) => mode.id === modeId)
    if (index === -1 || collection.modes[index].name === modeName) return collection
    return { ...collection, modes: collection.modes.with(index, { id: modeId, name: modeName }) }
  })
}

/** モードを消す（最後の 1 つは消せない）。そのモードの値と、そのモードを指すページ・フレームの指定も消す */
export function removeMode(doc: DesignDocument, collectionId: CollectionId, modeId: ModeId): DesignDocument {
  const collection = findCollection(doc, collectionId)
  if (!collection || !collection.modes.some((mode) => mode.id === modeId)) return doc
  if (collection.modes.length === 1) throw new VariableError('最後のモードは消せません')
  const next = updateCollection(doc, collectionId, (item) => ({
    ...item,
    modes: item.modes.filter((mode) => mode.id !== modeId),
    variables: item.variables.map((variable) => {
      const values = { ...variable.values }
      delete values[modeId]
      return { ...variable, values }
    }),
  }))
  return clearSelections(next, collectionId, modeId)
}

/** 変数を足す。value はどのモードにも同じ値を入れる。名前が重なる・値の形が違うときは VariableError */
export function addVariable(
  doc: DesignDocument,
  collectionId: CollectionId,
  name: string,
  type: VariableType,
  value: VariableValue = DEFAULT_VARIABLE_VALUES[type],
): { document: DesignDocument; id: VariableId } {
  const variableName = checkName(name, '変数')
  const collection = findCollection(doc, collectionId)
  if (!collection) throw new VariableError('コレクションがありません')
  if (collection.variables.some((variable) => variable.name === variableName)) throw new VariableError(`同じ名前の変数があります: ${variableName}`)
  const id = createId()
  checkValue(doc, { id, name: variableName, type, values: {} }, value)
  const variable: Variable = { id, name: variableName, type, values: Object.fromEntries(collection.modes.map((mode) => [mode.id, value])) }
  return { document: updateCollection(doc, collectionId, (item) => ({ ...item, variables: [...item.variables, variable] })), id }
}

export function renameVariable(doc: DesignDocument, id: VariableId, name: string): DesignDocument {
  const variableName = checkName(name, '変数')
  return updateVariable(doc, id, (variable, collection) => {
    if (collection.variables.some((other) => other.id !== id && other.name === variableName)) throw new VariableError(`同じ名前の変数があります: ${variableName}`)
    return variable.name === variableName ? variable : { ...variable, name: variableName }
  })
}

/** 変数の 1 つのモードの値（mode を省くとすべてのモード）。別名は同じ種類の変数だけを指せ、循環してはいけない */
export function setVariableValue(doc: DesignDocument, id: VariableId, value: VariableValue, mode?: ModeId): DesignDocument {
  return updateVariable(doc, id, (variable, collection) => {
    checkValue(doc, variable, value)
    const modes = mode === undefined ? collection.modes.map((item) => item.id) : [mode]
    if (!modes.every((item) => collection.modes.some((other) => other.id === item))) throw new VariableError('モードがありません')
    if (modes.every((item) => sameValue(variable.values[item], value))) return variable
    return { ...variable, values: { ...variable.values, ...Object.fromEntries(modes.map((item) => [item, value])) } }
  })
}

function sameValue(a: VariableValue | undefined, b: VariableValue): boolean {
  if (a === undefined) return false
  if (isAlias(a) || isAlias(b)) return isAlias(a) && isAlias(b) && a.alias === b.alias
  return a === b
}

const COLOR = /^#[0-9a-fA-F]{6}$/

/** 値が変数の種類に合うか。別名なら、先があり、同じ種類で、たどって自分に戻らないこと */
function checkValue(doc: DesignDocument, variable: Variable, value: VariableValue): void {
  if (isAlias(value)) {
    const target = findVariable(doc, value.alias)
    if (!target) throw new VariableError('別名の先の変数がありません')
    if (target.variable.type !== variable.type) throw new VariableError('別名の先の変数の種類が違います')
    if (aliasReaches(doc, value.alias, variable.id)) throw new VariableError('別名が循環します')
    return
  }
  const ok =
    variable.type === 'color'
      ? typeof value === 'string' && COLOR.test(value)
      : variable.type === 'number'
        ? typeof value === 'number' && Number.isFinite(value)
        : variable.type === 'string'
          ? typeof value === 'string'
          : typeof value === 'boolean'
  if (!ok) throw new VariableError(variable.type === 'color' ? '色は #rrggbb で指定してください' : `${variable.type} の値ではありません`)
}

/** from から別名をたどって to に着くか（どのモードの別名もたどる） */
function aliasReaches(doc: DesignDocument, from: VariableId, to: VariableId): boolean {
  const seen = new Set<VariableId>()
  const stack = [from]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (id === to) return true
    if (seen.has(id)) continue
    seen.add(id)
    const found = findVariable(doc, id)
    if (!found) continue
    for (const value of Object.values(found.variable.values)) if (isAlias(value)) stack.push(value.alias)
  }
  return false
}

/** 変数を消す。つながりは外して値を残し、ほかの変数からの別名はその時点の値に置き換える */
export function removeVariable(doc: DesignDocument, id: VariableId): DesignDocument {
  const found = findVariable(doc, id)
  if (!found) return doc
  const removed = new Set([id])
  const inlined = inlineAliases(doc, removed)
  const next = updateCollection(inlined, found.collection.id, (collection) => ({
    ...collection,
    variables: collection.variables.filter((variable) => variable.id !== id),
  }))
  return detachVariables(next, removed)
}

/** removed の変数を指す別名（removed に入っていない変数の値）を、そのモードで解決した値に置き換える */
function inlineAliases(doc: DesignDocument, removed: ReadonlySet<VariableId>): DesignDocument {
  const index = variableIndex(doc.collections)
  let changed = false
  const collections = doc.collections.map((collection) => {
    let variables: Variable[] | null = null
    for (const [i, variable] of collection.variables.entries()) {
      if (removed.has(variable.id)) continue
      let values: Record<ModeId, VariableValue> | null = null
      for (const [mode, value] of Object.entries(variable.values)) {
        if (!isAlias(value) || !removed.has(value.alias)) continue
        const resolved = resolveVariable(index, value.alias, (other) => (other.id === collection.id ? mode : other.modes[0].id))
        ;(values ??= { ...variable.values })[mode] = resolved ?? DEFAULT_VARIABLE_VALUES[variable.type]
      }
      if (values) (variables ??= [...collection.variables])[i] = { ...variable, values }
    }
    if (!variables) return collection
    changed = true
    return { ...collection, variables }
  })
  return changed ? { ...doc, collections } : doc
}

/** removed の変数へのつながり（塗り・線・グラデーションの色・影、インスタンスの上書きの塗り・線）を外す。値は残す */
export function detachVariables(doc: DesignDocument, removed: ReadonlySet<VariableId>): DesignDocument {
  let changed = false
  const pages = doc.pages.map((page) => {
    let nodes: Record<NodeId, SceneNode> | null = null
    for (const id in page.nodes) {
      const node = page.nodes[id]
      const next = detachNode(node, removed)
      if (next !== node) (nodes ??= { ...page.nodes })[id] = next
    }
    if (!nodes) return page
    changed = true
    return { ...page, nodes }
  })
  return changed ? { ...doc, pages } : doc
}

function detachNode(node: SceneNode, removed: ReadonlySet<VariableId>): SceneNode {
  let next = node
  if ('fills' in node) {
    const fills = detachPaints(node.fills, removed)
    if (fills !== node.fills) next = { ...next, fills } as SceneNode
  }
  if ('strokes' in node) {
    const strokes = detachPaints(node.strokes, removed)
    if (strokes !== node.strokes) next = { ...next, strokes } as SceneNode
  }
  const effects = detachEffects(node.effects, removed)
  if (effects !== node.effects) next = { ...next, effects } as SceneNode
  if (next.type === 'frame' && next.component?.role === 'instance') {
    const overrides = next.component.overrides
    let detached: Record<NodeId, Override> | null = null
    for (const [id, override] of Object.entries(overrides)) {
      const fills = override.fills && detachPaints(override.fills, removed)
      const strokes = override.strokes && detachPaints(override.strokes, removed)
      if (fills !== override.fills || strokes !== override.strokes) {
        ;(detached ??= { ...overrides })[id] = { ...override, ...(fills ? { fills } : {}), ...(strokes ? { strokes } : {}) }
      }
    }
    if (detached) next = { ...next, component: { ...next.component, overrides: detached } }
  }
  return next
}

function detachPaints(paints: Paint[], removed: ReadonlySet<VariableId>): Paint[] {
  let out: Paint[] | null = null
  for (const [i, paint] of paints.entries()) {
    let next: Paint = paint
    if (paint.type === 'solid') {
      if (paint.variable !== undefined && removed.has(paint.variable)) next = withoutVariable(paint)
    } else if (paint.stops.some((stop) => stop.variable !== undefined && removed.has(stop.variable))) {
      next = { ...paint, stops: paint.stops.map((stop) => (stop.variable !== undefined && removed.has(stop.variable) ? withoutVariable(stop) : stop)) }
    }
    if (next !== paint) (out ??= [...paints])[i] = next
  }
  return out ?? paints
}

function detachEffects(effects: Effect[], removed: ReadonlySet<VariableId>): Effect[] {
  let out: Effect[] | null = null
  for (const [i, effect] of effects.entries()) {
    if ('variable' in effect && effect.variable !== undefined && removed.has(effect.variable)) (out ??= [...effects])[i] = withoutVariable(effect)
  }
  return out ?? effects
}

/** variable を持たない写し */
export function withoutVariable<T extends { variable?: VariableId }>(value: T): T {
  const { variable: _variable, ...rest } = value
  return rest as T
}

/** collectionId のモードの指定のうち、modeId（null ならどのモードでも）を指すものを、ページとフレームから消す */
function clearSelections(doc: DesignDocument, collectionId: CollectionId, modeId: ModeId | null): DesignDocument {
  const hits = (modes: ModeSelection | undefined) =>
    modes !== undefined && Object.hasOwn(modes, collectionId) && (modeId === null || modes[collectionId] === modeId)
  let changed = false
  const pages = doc.pages.map((page) => {
    let next: Page = page
    if (hits(page.modes)) next = withSelection(next, collectionId, null)
    let nodes: Record<NodeId, SceneNode> | null = null
    for (const id in page.nodes) {
      const node = page.nodes[id]
      if (node.type === 'frame' && hits(node.modes)) (nodes ??= { ...page.nodes })[id] = withSelection(node, collectionId, null)
    }
    if (nodes) next = { ...next, nodes }
    if (next !== page) changed = true
    return next
  })
  return changed ? { ...doc, pages } : doc
}

/** モードの指定を 1 つ変えた写し（mode が null なら指定を消す。空になれば modes ごと消す） */
export function withSelection<T extends { modes?: ModeSelection }>(target: T, collectionId: CollectionId, mode: ModeId | null): T {
  const modes = { ...target.modes }
  if (mode === null) delete modes[collectionId]
  else modes[collectionId] = mode
  if (Object.keys(modes).length > 0) return { ...target, modes }
  const { modes: _modes, ...rest } = target
  return rest as T
}

/** ページのモードの指定を変える（mode が null なら指定を消す） */
export function setPageMode(doc: DesignDocument, pageId: PageId, collectionId: CollectionId, mode: ModeId | null): DesignDocument {
  return updatePage(doc, pageId, (page) => ((page.modes?.[collectionId] ?? null) === mode ? page : withSelection(page, collectionId, mode)))
}

/** フレームのモードの指定を変える（mode が null なら指定を消す） */
export function setFrameMode(doc: DesignDocument, pageId: PageId, frameId: NodeId, collectionId: CollectionId, mode: ModeId | null): DesignDocument {
  return updatePage(doc, pageId, (page) => {
    const node = page.nodes[frameId]
    if (node?.type !== 'frame' || (node.modes?.[collectionId] ?? null) === mode) return page
    return { ...page, nodes: { ...page.nodes, [frameId]: withSelection(node, collectionId, mode) } }
  })
}

/** 名前で変数を探す。collection を省くと全部のコレクションから（同じ名前が 2 つあれば VariableError） */
export function variableByName(doc: DesignDocument, name: string, collection?: CollectionId): Variable | undefined {
  const hits = doc.collections
    .filter((item) => collection === undefined || item.id === collection)
    .flatMap((item) => item.variables.filter((variable) => variable.name === name))
  if (hits.length > 1) throw new VariableError(`同じ名前の変数が複数のコレクションにあります: ${name}（コレクション名:変数名 で指定してください）`)
  return hits[0]
}
