import { VARIABLE_TYPES } from '../../src/document/kdr.ts'
import type { DesignDocument, VariableCollection, VariableType, VariableValue } from '../../src/document/types.ts'
import { cssVariableName, isAlias, variableIndex } from '../../src/document/variables.ts'
import {
  VariableError,
  addCollection,
  addMode,
  addVariable,
  removeCollection,
  removeMode,
  removeVariable,
  renameCollection,
  renameMode,
  renameVariable,
  setFrameMode,
  setPageMode,
  setVariableValue,
} from '../../src/editor/operations/variables.ts'
import { type Step, UsageError } from '../args.ts'
import type { Session } from '../session.ts'
import { findVariableByRef } from '../values.ts'
import { type Command, checkStep, flag, option, positional } from './common.ts'

// 変数（コレクション・モード・変数）のコマンド。ノードから指すのは set の var(名前)（values.ts）

/** 変数の操作の誤り（名前の重なりなど）を、使い方の誤りとして知らせる */
function apply(session: Session, recipe: (doc: DesignDocument) => DesignDocument): void {
  try {
    session.applyDocument(recipe)
  } catch (error) {
    if (error instanceof VariableError) throw new UsageError(error.message)
    throw error
  }
}

function collectionByName(doc: DesignDocument, name: string): VariableCollection {
  const collection = doc.collections.find((item) => item.name === name)
  if (!collection) throw new UsageError(`${name} というコレクションがありません（kdr vars で一覧できます）`)
  return collection
}

function modeByName(collection: VariableCollection, name: string) {
  const mode = collection.modes.find((item) => item.name === name)
  if (!mode) throw new UsageError(`${collection.name} に ${name} というモードがありません（${collection.modes.map((item) => item.name).join(' / ')}）`)
  return mode
}

/** 値の書き方を、変数の種類に合わせて読む。var(名前) は別名 */
function parseVariableValue(doc: DesignDocument, type: VariableType, raw: string, label: string): VariableValue {
  const ref = /^var\((.+)\)$/.exec(raw.trim())
  if (ref) return { alias: findVariableByRef(doc.collections, ref[1].trim(), label).id }
  switch (type) {
    case 'color':
      if (!/^#[0-9a-fA-F]{6}$/.test(raw)) throw new UsageError(`${label}: 色は #rrggbb で指定してください: ${raw}`)
      return raw.toLowerCase()
    case 'number': {
      const value = Number(raw)
      if (raw.trim() === '' || !Number.isFinite(value)) throw new UsageError(`${label}: 数値ではありません: ${raw}`)
      return value
    }
    case 'boolean':
      if (raw !== 'true' && raw !== 'false') throw new UsageError(`${label}: true か false を指定してください: ${raw}`)
      return raw === 'true'
    case 'string':
      return raw
  }
}

/** --type を省いたときの種類（値の見た目から） */
function guessType(doc: DesignDocument, raw: string): VariableType {
  const ref = /^var\((.+)\)$/.exec(raw.trim())
  if (ref) return findVariableByRef(doc.collections, ref[1].trim()).type
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return 'color'
  if (raw === 'true' || raw === 'false') return 'boolean'
  if (raw.trim() !== '' && Number.isFinite(Number(raw))) return 'number'
  return 'string'
}

/** モード=値 を、そのコレクションのモードの id と値に */
function modeValues(doc: DesignDocument, collection: VariableCollection, type: VariableType, step: Step) {
  return step.assignments.map(([name, raw]) => ({ mode: modeByName(collection, name).id, value: parseVariableValue(doc, type, raw, name) }))
}

/** 変数の値の見せ方（別名は var(名前)） */
function valueText(doc: DesignDocument, value: VariableValue): string {
  if (!isAlias(value)) return String(value)
  const target = variableIndex(doc.collections).get(value.alias)
  return `var(${target?.variable.name ?? value.alias})`
}

export const vars: Command = {
  name: 'vars',
  kind: 'query',
  usage: 'vars [--json]',
  summary:
    '変数の一覧。1 行に、コレクション・変数の名前・種類・CSS 変数の名前・モードごとの値（モード=値）をタブ区切りで（別名は var(名前)）。--json ならコレクションごとのモードと変数',
  flags: ['json'],
  run({ session, print }, step) {
    checkStep(step, { options: ['json'] })
    const doc = session.document
    if (flag(step, 'json')) {
      const rows = doc.collections.map((collection) => ({
        name: collection.name,
        modes: collection.modes.map((mode) => mode.name),
        variables: collection.variables.map((variable) => ({
          name: variable.name,
          type: variable.type,
          css: cssVariableName(doc.collections, variable.id),
          values: Object.fromEntries(collection.modes.map((mode) => [mode.name, jsonValue(doc, variable.values[mode.id])])),
        })),
      }))
      print(JSON.stringify(rows, null, 2))
      return
    }
    for (const collection of doc.collections) {
      for (const variable of collection.variables) {
        const values = collection.modes.map((mode) => `${mode.name}=${valueText(doc, variable.values[mode.id])}`)
        print([collection.name, variable.name, variable.type, cssVariableName(doc.collections, variable.id), ...values].join('\t'))
      }
    }
  },
}

function jsonValue(doc: DesignDocument, value: VariableValue): unknown {
  return isAlias(value) ? { alias: variableIndex(doc.collections).get(value.alias)?.variable.name ?? value.alias } : value
}

export const collectionAdd: Command = {
  name: 'collection-add',
  kind: 'edit',
  usage: 'collection-add 名前 [--mode 最初のモードの名前]',
  summary: '変数のコレクションを足す。モードは 1 つ（--mode で名前を決める。省くと Mode 1）。モードを増やすのは mode-add',
  run({ session }, step) {
    checkStep(step, { options: ['mode'], positionals: 1 })
    const name = positional(step, 0, 'コレクションの名前')
    apply(session, (doc) => addCollection(doc, name, option(step, 'mode')).document)
  },
}

export const collectionRename: Command = {
  name: 'collection-rename',
  kind: 'edit',
  usage: 'collection-rename 名前 新しい名前',
  summary: 'コレクションの名前を変える',
  run({ session }, step) {
    checkStep(step, { positionals: 2 })
    const collection = collectionByName(session.document, positional(step, 0, 'コレクションの名前'))
    apply(session, (doc) => renameCollection(doc, collection.id, positional(step, 1, '新しい名前')))
  },
}

export const collectionRm: Command = {
  name: 'collection-rm',
  kind: 'edit',
  usage: 'collection-rm 名前',
  summary: 'コレクションを中の変数ごと消す。その変数につないだ色は、つながりを外して今の値のまま残す',
  run({ session }, step) {
    checkStep(step, { positionals: 1 })
    const collection = collectionByName(session.document, positional(step, 0, 'コレクションの名前'))
    apply(session, (doc) => removeCollection(doc, collection.id))
  },
}

export const modeAdd: Command = {
  name: 'mode-add',
  kind: 'edit',
  usage: 'mode-add コレクション モードの名前',
  summary: 'コレクションにモード（Dark など）を足す。変数の値は最初のモードのものを写す（var-set で変える）',
  run({ session }, step) {
    checkStep(step, { positionals: 2 })
    const collection = collectionByName(session.document, positional(step, 0, 'コレクションの名前'))
    apply(session, (doc) => addMode(doc, collection.id, positional(step, 1, 'モードの名前')).document)
  },
}

export const modeRename: Command = {
  name: 'mode-rename',
  kind: 'edit',
  usage: 'mode-rename コレクション モードの名前 新しい名前',
  summary: 'モードの名前を変える',
  run({ session }, step) {
    checkStep(step, { positionals: 3 })
    const collection = collectionByName(session.document, positional(step, 0, 'コレクションの名前'))
    const mode = modeByName(collection, positional(step, 1, 'モードの名前'))
    apply(session, (doc) => renameMode(doc, collection.id, mode.id, positional(step, 2, '新しい名前')))
  },
}

export const modeRm: Command = {
  name: 'mode-rm',
  kind: 'edit',
  usage: 'mode-rm コレクション モードの名前',
  summary: 'モードを消す（最後の 1 つは消せない）。そのモードの値と、そのモードを指すページ・フレームの指定も消す',
  run({ session }, step) {
    checkStep(step, { positionals: 2 })
    const collection = collectionByName(session.document, positional(step, 0, 'コレクションの名前'))
    const mode = modeByName(collection, positional(step, 1, 'モードの名前'))
    apply(session, (doc) => removeMode(doc, collection.id, mode.id))
  },
}

export const mode: Command = {
  name: 'mode',
  kind: 'edit',
  usage: 'mode [フレーム…] コレクション=モード…',
  summary:
    'ページ（フレームを指定すればフレーム）で使う変数のモードを決める。中のノードは、近いフレームの指定、無ければページの指定、それも無ければ最初のモードで変数を解決する。モードに null を書くと指定を消す',
  assignments: 'any',
  run({ session }, step) {
    checkStep(step, { assignments: true })
    if (step.assignments.length === 0) throw new UsageError('mode: 「コレクション=モード」を指定してください')
    const doc = session.document
    const choices = step.assignments.map(([name, raw]) => {
      const collection = collectionByName(doc, name)
      return { collection: collection.id, mode: raw === 'null' ? null : modeByName(collection, raw).id }
    })
    const pageId = session.page.id
    const frames = step.positionals.length === 0 ? [] : step.positionals.map((selector) => session.resolveFrame(selector))
    apply(session, (current) =>
      choices.reduce(
        (next, choice) =>
          frames.length === 0
            ? setPageMode(next, pageId, choice.collection, choice.mode)
            : frames.reduce((acc, frame) => setFrameMode(acc, pageId, frame, choice.collection, choice.mode), next),
        current,
      ),
    )
  },
}

export const varAdd: Command = {
  name: 'var-add',
  kind: 'edit',
  usage: 'var-add 名前 値 [--type color|number|string|boolean] [--collection コレクション] [モード=値…]',
  summary:
    '変数を足す（名前の / はグループの区切り。例 color/primary）。値はどのモードにも入れ、モード=値 で個別に変える。var(名前) と書けば別の変数の別名になる。' +
    '--type を省くと値の見た目から決める（#rrggbb は色）。コレクションが 1 つならそこに、無ければ Variables を作って足す。ノードの色から指すのは set の fill=var(名前)',
  assignments: 'any',
  run({ session }, step) {
    checkStep(step, { options: ['type', 'collection'], positionals: 2, assignments: true })
    const name = positional(step, 0, '変数の名前')
    const raw = positional(step, 1, '値')
    const rawType = option(step, 'type')
    if (rawType !== undefined && !(VARIABLE_TYPES as readonly string[]).includes(rawType)) {
      throw new UsageError(`var-add: --type は ${VARIABLE_TYPES.join(' / ')} です: ${rawType}`)
    }
    const collectionName = option(step, 'collection')
    apply(session, (doc) => {
      const type = (rawType as VariableType | undefined) ?? guessType(doc, raw)
      let current = doc
      let collection = collectionName === undefined ? undefined : doc.collections.find((item) => item.name === collectionName)
      if (!collection) {
        if (collectionName === undefined && doc.collections.length > 1) {
          throw new UsageError(`var-add: コレクションが複数あります。--collection で指定してください（${doc.collections.map((item) => item.name).join(' / ')}）`)
        }
        collection = doc.collections[0]
        if (!collection || collectionName !== undefined) {
          const added = addCollection(current, collectionName ?? 'Variables')
          current = added.document
          collection = current.collections.find((item) => item.id === added.id)!
        }
      }
      const added = addVariable(current, collection.id, name, type, parseVariableValue(current, type, raw, name))
      return modeValues(added.document, collection, type, step).reduce(
        (next, { mode: modeId, value }) => setVariableValue(next, added.id, value, modeId),
        added.document,
      )
    })
  },
}

export const varSet: Command = {
  name: 'var-set',
  kind: 'edit',
  usage: 'var-set 変数 [値] [モード=値…]',
  summary: '変数の値を変える。値はすべてのモードに、モード=値 はそのモードだけに入れる。var(名前) で別名にする。つないだノードの色も変わる',
  assignments: 'any',
  run({ session }, step) {
    checkStep(step, { positionals: 2, assignments: true })
    const ref = positional(step, 0, '変数の名前')
    const raw = step.positionals[1]
    if (raw === undefined && step.assignments.length === 0) throw new UsageError('var-set: 値か「モード=値」を指定してください')
    const doc = session.document
    const variable = findVariableByRef(doc.collections, ref)
    const collection = variableIndex(doc.collections).get(variable.id)!.collection
    const all = raw === undefined ? null : parseVariableValue(doc, variable.type, raw, ref)
    const each = modeValues(doc, collection, variable.type, step)
    apply(session, (current) =>
      each.reduce((next, { mode: modeId, value }) => setVariableValue(next, variable.id, value, modeId), all === null ? current : setVariableValue(current, variable.id, all)),
    )
  },
}

export const varRename: Command = {
  name: 'var-rename',
  kind: 'edit',
  usage: 'var-rename 変数 新しい名前',
  summary: '変数の名前を変える（つないだノードや別名はそのまま）',
  run({ session }, step) {
    checkStep(step, { positionals: 2 })
    const variable = findVariableByRef(session.document.collections, positional(step, 0, '変数の名前'))
    apply(session, (doc) => renameVariable(doc, variable.id, positional(step, 1, '新しい名前')))
  },
}

export const varRm: Command = {
  name: 'var-rm',
  kind: 'edit',
  usage: 'var-rm 変数…',
  summary: '変数を消す。つないだ色はつながりを外して今の値のまま残し、ほかの変数からの別名は今の値に置き換える',
  run({ session }, step) {
    checkStep(step, {})
    if (step.positionals.length === 0) throw new UsageError('var-rm: 変数の名前を指定してください')
    const ids = step.positionals.map((ref) => findVariableByRef(session.document.collections, ref).id)
    apply(session, (doc) => ids.reduce(removeVariable, doc))
  },
}
