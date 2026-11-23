import { findMain, isInstance, isMain } from '../../src/document/component.ts'
import { canBindProperty } from '../../src/document/componentProperties.ts'
import { getWorldCenter } from '../../src/document/geometry.ts'
import type { ComponentProperty, DesignDocument, NodeId, Scene } from '../../src/document/types.ts'
import { isVariantSet, parseVariantName, propValue, variantProperties, variantSetOf } from '../../src/document/variants.ts'
import {
  createInstance,
  detachComponent,
  hasOverrides,
  listComponents,
  makeComponent,
  nestedInstanceOf,
  pushOverrides,
  resetOverrides,
  swapComponent,
  swapNestedInstance,
} from '../../src/editor/components.ts'
import {
  addComponentProperty,
  bindComponentProperty,
  moveComponentProperty,
  removeComponentProperty,
  alignVariantProperties,
  setVariantSetDescription,
  renameComponentProperty,
  setComponentDescription,
  setPreferredComponents,
  setInstanceProperty,
} from '../../src/editor/componentProperties.ts'
import { updatePage } from '../../src/editor/operations/document.ts'
import { updateNode } from '../../src/editor/operations/tree.ts'
import {
  addVariant,
  addVariantProperty,
  moveVariantProperty,
  moveVariantValue,
  removeVariantProperty,
  renameVariantProperty,
  renameVariantValue,
  selectVariant,
  setVariantValue,
} from '../../src/editor/variants.ts'
import { type Step, UsageError } from '../args.ts'
import { type Session, checkNewId, renameNodeId } from '../session.ts'
import { fitTextEstimated } from '../textMeasure.ts'
import { type Command, checkStep, numberOption, option, positional } from './common.ts'

// コンポーネントのコマンド

export const component: Command = {
  name: 'component',
  kind: 'edit',
  usage: 'component フレーム',
  summary: 'フレームをコンポーネントの元にする',
  run({ session }, step) {
    checkStep(step, { positionals: 1 })
    const id = session.resolveFrame(positional(step, 0, 'フレーム'))
    session.apply((page) => makeComponent(page, id))
  },
}

export const detach: Command = {
  name: 'detach',
  kind: 'edit',
  usage: 'detach フレーム',
  summary: 'コンポーネントとのつながりを外す（元から外すと、インスタンスはただのフレームになる）',
  run({ session }, step) {
    checkStep(step, { positionals: 1 })
    const id = session.resolveFrame(positional(step, 0, 'フレーム'))
    session.apply((page) => detachComponent(page, id))
  },
}

export const instance: Command = {
  name: 'instance',
  kind: 'edit',
  usage: 'instance 元 [--parent フレーム] [--x N --y N] [--id ID] [--name 名前]',
  summary: 'コンポーネントのインスタンスを置く。元は全ページから id か名前で探す。置いたものは「@」で指せる',
  run({ session }, step) {
    checkStep(step, { options: ['parent', 'x', 'y', 'id', 'name'], positionals: 1 })
    const componentId = findComponent(session.document, positional(step, 0, '元'))
    const parent = option(step, 'parent')
    const parentId = parent === undefined ? null : session.resolveFrame(parent)
    const wanted = option(step, 'id')
    if (wanted !== undefined) checkNewId(session.page, wanted)
    const x = numberOption(step, 'x')
    const y = numberOption(step, 'y')
    const name = option(step, 'name')
    const pageId = session.page.id
    let created: NodeId | null = null
    session.applyDocument((doc) => {
      const page = doc.pages.find((candidate) => candidate.id === pageId)!
      const at = parentId === null ? undefined : { center: getWorldCenter(page, parentId), parentId }
      const result = createInstance(doc, pageId, componentId, at)
      if (result.id === null) throw new UsageError('instance: インスタンスを置けません')
      if (parentId !== null && result.document.pages.find((p) => p.id === pageId)!.nodes[result.id].parentId !== parentId) {
        throw new UsageError('instance: そのフレームの中には置けません（インスタンスの中か、元が自分自身を含むことになります）')
      }
      const id = wanted ?? result.id
      created = id
      return updatePage(result.document, pageId, (candidate) => {
        const renamed = renameNodeId(candidate, result.id!, id)
        const patch = { ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }), ...(name === undefined ? {} : { name }) }
        return updateNode(renamed, id, patch)
      })
    })
    session.last = created === null ? [] : [created]
  },
}

function findComponent(doc: DesignDocument, selector: string): string {
  const mains = listComponents(doc)
  const byId = mains.filter(({ node }) => node.id === selector || node.component.id === selector)
  const found = byId.length > 0 ? byId : mains.filter(({ node }) => node.name === selector)
  if (found.length === 0) throw new UsageError(`コンポーネントの元が見つかりません: ${selector}`)
  if (found.length > 1) {
    throw new UsageError(`${selector}: 同じ名前の元が ${found.length} 個あります。id で指定してください（${found.map(({ node }) => node.id).join(', ')}）`)
  }
  return found[0].node.component.id
}

export const overridePush: Command = {
  name: 'override-push',
  kind: 'edit',
  usage: 'override-push ノード…',
  summary: 'インスタンス（またはその中身）の上書きを元に書き込み、上書きを外す。元を使うほかのインスタンスにも反映される',
  run({ session }, step) {
    checkStep(step, {})
    const ids = session.resolveAll(step.positionals)
    const pageId = session.page.id
    requireOverrides(session.document, session.page, ids, 'override-push')
    session.applyDocument((doc) => pushOverrides(doc, pageId, ids, fitTextEstimated))
  },
}

export const overrideReset: Command = {
  name: 'override-reset',
  kind: 'edit',
  usage: 'override-reset ノード…',
  summary: 'インスタンス（またはその中身）の上書きを捨てて、元と同じ見た目に戻す',
  run({ session }, step) {
    checkStep(step, {})
    const ids = session.resolveAll(step.positionals)
    const pageId = session.page.id
    requireOverrides(session.document, session.page, ids, 'override-reset')
    session.applyDocument((doc) => resetOverrides(doc, pageId, ids))
  },
}

export const swap: Command = {
  name: 'swap',
  kind: 'edit',
  usage: 'swap インスタンス 元',
  summary:
    'インスタンスの元を別のコンポーネントに差し替える。上書きはレイヤー名のたどり方が同じノードへ移す。インスタンスの中の入れ子のインスタンスも差し替えられる',
  run({ session }, step) {
    checkStep(step, { positionals: 2 })
    const id = session.resolveOne(positional(step, 0, 'インスタンス'))
    const componentId = findComponent(session.document, positional(step, 1, '元'))
    const page = session.page
    const nested = nestedInstanceOf(session.document, page, id)
    const current = nested ? nested.componentId : isInstance(page.nodes[id]) ? page.nodes[id].component.id : null
    if (current === null) throw new UsageError(`swap: ${step.positionals[0]} はインスタンスではありません`)
    if (current === componentId) return
    const before = session.document
    session.applyDocument((doc) =>
      nested ? swapNestedInstance(doc, page.id, id, componentId) : swapComponent(doc, page.id, id, componentId),
    )
    if (session.document === before) {
      throw new UsageError('swap: 差し替えられません（元が自分自身を含むことになるか、インスタンスの中身のインスタンスでないものです）')
    }
  },
}

export const variantAdd: Command = {
  name: 'variant-add',
  kind: 'edit',
  assignments: 'any',
  usage: 'variant-add 元 [--id ID] [プロパティ=値…]',
  summary:
    '元を複製してバリアントを 1 つ増やす（まとまりがなければ作り、元に「種類=標準」を付ける）。プロパティ=値 で新しいバリアントの値を決める。増やしたものは「@」で指せる',
  run({ session }, step) {
    checkStep(step, { options: ['id'], positionals: 1, assignments: true })
    const mainId = session.resolveOne(positional(step, 0, '元'))
    if (!isMain(session.page.nodes[mainId])) throw new UsageError(`variant-add: ${step.positionals[0]} はコンポーネントの元ではありません`)
    const wanted = option(step, 'id')
    if (wanted !== undefined) checkNewId(session.page, wanted)
    const pageId = session.page.id
    let created: NodeId | null = null
    session.applyDocument((doc) => {
      const result = addVariant(doc, pageId, mainId)
      if (result.id === null) throw new UsageError('variant-add: バリアントを増やせません（インスタンスの中の元です）')
      const id = wanted ?? result.id
      created = id
      return updatePage(result.document, pageId, (page) => {
        let next = renameNodeId(page, result.id!, id)
        for (const [key, value] of step.assignments) {
          const props = parseVariantName(next.nodes[id].name) ?? []
          if (propValue(props, key) === undefined) {
            throw new UsageError(`variant-add: プロパティ ${key} がありません（あるもの: ${props.map(([name]) => name).join(', ')}）`)
          }
          const changed = setVariantValue(next, id, key, value)
          if (changed === next && propValue(props, key) !== value.trim()) {
            throw new UsageError(`variant-add: 値に使えない文字（, =）を含むか空です: ${value}`)
          }
          next = changed
        }
        return next
      })
    })
    session.last = created === null ? [] : [created]
  },
}

export const variant: Command = {
  name: 'variant',
  kind: 'edit',
  assignments: 'any',
  usage: 'variant インスタンス… プロパティ=値…',
  summary: 'インスタンスのバリアントを選ぶ（元のまとまりから、そのプロパティの値を持ち、ほかのプロパティがいちばん合うものに差し替える）',
  run({ session }, step) {
    checkStep(step, { assignments: true })
    if (step.assignments.length === 0) throw new UsageError('variant: 「プロパティ=値」を指定してください')
    const ids = session.resolveAll(step.positionals)
    const pageId = session.page.id
    for (const id of ids) {
      if (!isInstance(session.page.nodes[id])) throw new UsageError(`variant: ${id} はインスタンスではありません`)
    }
    session.applyDocument((doc) =>
      ids.reduce(
        (current, id) =>
          step.assignments.reduce((next, [key, value]) => {
            const chosen = selectVariant(next, pageId, id, key, value)
            if (chosen === next && currentValue(next, pageId, id, key) !== value) {
              throw new UsageError(`variant: ${id} の元のまとまりに ${key}=${value} のバリアントがありません`)
            }
            return chosen
          }, current),
        doc,
      ),
    )
  },
}

/** インスタンスの元のバリアントの、プロパティ key の値 */
function currentValue(doc: DesignDocument, pageId: string, id: NodeId, key: string): string | undefined {
  const node = doc.pages.find((page) => page.id === pageId)?.nodes[id]
  if (!isInstance(node)) return undefined
  const main = findMain(doc, node.component.id)
  return main ? propValue(parseVariantName(main.node.name) ?? [], key) : undefined
}

function requireOverrides(doc: DesignDocument, scene: Scene, ids: readonly NodeId[], name: string): void {
  for (const id of ids) {
    if (!hasOverrides(doc, scene, id)) throw new UsageError(`${name}: ${id} には上書きがありません（インスタンスかその中身を指定してください）`)
  }
}

export const describe_: Command = {
  name: 'describe',
  kind: 'edit',
  usage: 'describe 元|まとまり 説明文',
  summary: 'コンポーネントの元、またはバリアントのまとまりに説明文を付ける（空文字 "" で外す）',
  run({ session }, step) {
    checkStep(step, { positionals: 2 })
    const id = session.resolveOne(positional(step, 0, '元'))
    const text = step.positionals[1]
    if (isVariantSet(session.page, id)) {
      session.apply((page) => setVariantSetDescription(page, id, text))
      return
    }
    if (!isMain(session.page.nodes[id])) {
      throw new UsageError(`describe: ${step.positionals[0]} はコンポーネントの元でもバリアントのまとまりでもありません`)
    }
    session.apply((page) => setComponentDescription(page, id, text))
  },
}

export const propAlign: Command = {
  name: 'prop-align',
  kind: 'edit',
  usage: 'prop-align まとまり',
  summary:
    'バリアントのまとまりで、どれかのバリアントにだけあるコンポーネントのプロパティをすべてのバリアントに足し、結ぶノード（同じ名前のレイヤー）と並びを揃える。まとまりの代わりに中のバリアントを指してもよい',
  run({ session }, step) {
    checkStep(step, { positionals: 1 })
    const setId = resolveVariantSet(session, positional(step, 0, 'まとまり'), step.name)
    session.apply((page) => alignVariantProperties(page, setId, session.document))
  },
}

const PROPERTY_TYPES = ['text', 'boolean', 'instance'] as const

export const propAdd: Command = {
  name: 'prop-add',
  kind: 'edit',
  usage: 'prop-add 元 text|boolean|instance ノード… [--name 名前]',
  summary:
    '元のプロパティを作り、元の中のノードに結ぶ。text は文言、boolean は表示、instance は入れ子のインスタンスの元。同じ名前のプロパティがあれば、そこへノードを結び足す',
  run({ session }, step) {
    checkStep(step, { options: ['name'] })
    const mainId = session.resolveOne(positional(step, 0, '元'))
    const main = session.page.nodes[mainId]
    if (!isMain(main)) throw new UsageError(`prop-add: ${step.positionals[0]} はコンポーネントの元ではありません`)
    const type = positional(step, 1, '種類')
    if (!(PROPERTY_TYPES as readonly string[]).includes(type)) {
      throw new UsageError(`prop-add: 種類は ${PROPERTY_TYPES.join(' / ')} のどれかです: ${type}`)
    }
    const targets = session.resolveAll(step.positionals.slice(2))
    if (targets.length === 0) throw new UsageError('prop-add: 結ぶノードを指定してください')
    const name = option(step, 'name')
    session.apply((page) => {
      let next = page
      let key = name
      for (const target of targets) {
        if (!canBindProperty(next, mainId, type as ComponentProperty['type'], target, session.document)) {
          throw new UsageError(`prop-add: ${target} は ${type} のプロパティに結べません（元の中の、種類の合うノードを指定してください）`)
        }
        const current = next.nodes[mainId]
        const existing = key !== undefined && isMain(current) && current.component.properties.find((property) => property.name === key)
        if (existing) {
          if (existing.type !== type) throw new UsageError(`prop-add: プロパティ ${key} は ${existing.type} です`)
          next = bindComponentProperty(next, mainId, existing.name, target, session.document)
        } else {
          const added = addComponentProperty(next, mainId, type as ComponentProperty['type'], target, key, session.document)
          if (added.name === null) throw new UsageError(`prop-add: プロパティの名前が空です`)
          next = added.scene
          key = added.name
        }
      }
      return next
    })
  },
}

/** 元を指すセレクタを元の id にし、プロパティ key があることを確かめる */
function resolvePropertyMain(
  session: Session,
  step: Step,
  key: string,
): { mainId: NodeId; property: ComponentProperty } {
  const mainId = session.resolveOne(positional(step, 0, '元'))
  const main = session.page.nodes[mainId]
  if (!isMain(main)) throw new UsageError(`${step.name}: ${step.positionals[0]} はコンポーネントの元ではありません`)
  const property = main.component.properties.find((candidate) => candidate.name === key)
  if (!property) {
    const names = main.component.properties.map((candidate) => candidate.name)
    throw new UsageError(`${step.name}: プロパティ ${key} がありません（あるもの: ${names.join(', ')}）`)
  }
  return { mainId, property }
}

/** バリアントなら、まとまりのすべてのバリアントにかかることを書き添える */
const SHARED_NOTE = '元がバリアントなら、まとまりのすべてのバリアントで揃える'

export const propRename: Command = {
  name: 'prop-rename',
  kind: 'edit',
  usage: 'prop-rename 元 名前 新しい名前',
  summary: `元のプロパティの名前を変える。${SHARED_NOTE}`,
  run({ session }, step) {
    checkStep(step, { positionals: 3 })
    const { mainId } = resolvePropertyMain(session, step, positional(step, 1, '名前'))
    const from = step.positionals[1]
    const to = positional(step, 2, '新しい名前')
    if (from === to.trim()) return
    session.apply((page) => {
      const next = renameComponentProperty(page, mainId, from, to)
      if (next === page) throw new UsageError(`${step.name}: 名前が空か、プロパティ ${to} はもうあります`)
      return next
    })
  },
}

export const propRm: Command = {
  name: 'prop-rm',
  kind: 'edit',
  usage: 'prop-rm 元 名前',
  summary: `元のプロパティを消す（インスタンスの値は、ふつうの上書きとして残る）。${SHARED_NOTE}`,
  run({ session }, step) {
    checkStep(step, { positionals: 2 })
    const { mainId } = resolvePropertyMain(session, step, positional(step, 1, '名前'))
    session.apply((page) => removeComponentProperty(page, mainId, step.positionals[1]))
  },
}

export const propOrder: Command = {
  name: 'prop-order',
  kind: 'edit',
  usage: 'prop-order 元 名前 位置',
  summary: `元のプロパティを並びの「位置」番目（0 が先頭）へ移す。インスタンスの欄もこの順になる。${SHARED_NOTE}`,
  run({ session }, step) {
    checkStep(step, { positionals: 3 })
    const { mainId } = resolvePropertyMain(session, step, positional(step, 1, '名前'))
    const raw = positional(step, 2, '位置')
    const index = Number(raw)
    if (!Number.isInteger(index) || index < 0) throw new UsageError(`${step.name}: 位置は 0 以上の整数です: ${raw}`)
    session.apply((page) => moveComponentProperty(page, mainId, step.positionals[1], index))
  },
}

export const propPrefer: Command = {
  name: 'prop-prefer',
  kind: 'edit',
  usage: 'prop-prefer 元 名前 [候補の元…]',
  summary: `差し替えのプロパティの候補（インスタンスで選ぶ欄の先頭に出す元）を、この順に決める。候補を省くと外す。${SHARED_NOTE}`,
  run({ session }, step) {
    checkStep(step, {})
    const { mainId, property } = resolvePropertyMain(session, step, positional(step, 1, '名前'))
    if (property.type !== 'instance') throw new UsageError(`${step.name}: プロパティ ${property.name} は差し替え（instance）ではありません`)
    const ids = step.positionals.slice(2).map((selector) => findComponent(session.document, selector))
    session.apply((page) => setPreferredComponents(page, mainId, property.name, ids))
  },
}

export const prop: Command = {
  name: 'prop',
  kind: 'edit',
  assignments: 'any',
  usage: 'prop インスタンス… 名前=値…',
  summary: 'インスタンスのプロパティの値を決める（text は文字、boolean は true / false、instance は元の id か名前）',
  run({ session }, step) {
    checkStep(step, { assignments: true })
    if (step.assignments.length === 0) throw new UsageError('prop: 「名前=値」を指定してください')
    const ids = session.resolveAll(step.positionals)
    const pageId = session.page.id
    session.applyDocument((doc) =>
      ids.reduce((current, id) => {
        const node = current.pages.find((page) => page.id === pageId)!.nodes[id]
        if (!isInstance(node)) throw new UsageError(`prop: ${id} はインスタンスではありません`)
        const main = findMain(current, node.component.id)
        return step.assignments.reduce((next, [key, raw]) => {
          const property = main?.node.component.properties.find((candidate) => candidate.name === key)
          if (!property) {
            const names = main?.node.component.properties.map((candidate) => candidate.name) ?? []
            throw new UsageError(`prop: プロパティ ${key} がありません（あるもの: ${names.join(', ')}）`)
          }
          let value: string | boolean = raw
          if (property.type === 'boolean') {
            if (raw !== 'true' && raw !== 'false') throw new UsageError(`prop: ${key} は true か false です: ${raw}`)
            value = raw === 'true'
          } else if (property.type === 'instance') {
            value = findComponent(next, raw)
          }
          return setInstanceProperty(next, pageId, id, key, value)
        }, current)
      }, doc),
    )
  },
}

/** まとまりか、まとまりの中のバリアントを指すセレクタを、まとまりの id にする */
function resolveVariantSet(session: Session, selector: string, name: string): NodeId {
  const id = session.resolveOne(selector)
  const page = session.page
  if (isVariantSet(page, id)) return id
  const set = variantSetOf(page, id)
  if (set) return set.id
  throw new UsageError(`${name}: ${selector} はバリアントのまとまりでも、その中のバリアントでもありません`)
}

function propertyNames(scene: Scene, setId: NodeId): string[] {
  return variantProperties(scene, setId).map((property) => property.name)
}

function requireProperty(scene: Scene, setId: NodeId, key: string, name: string): void {
  const names = propertyNames(scene, setId)
  if (!names.includes(key)) throw new UsageError(`${name}: プロパティ ${key} がありません（あるもの: ${names.join(', ')}）`)
}

export const variantPropAdd: Command = {
  name: 'variant-prop-add',
  kind: 'edit',
  usage: 'variant-prop-add まとまり 名前 [値]',
  summary:
    'バリアントのまとまりのすべてのバリアントにプロパティを足す（値を省くと「標準」）。まとまりの代わりに中のバリアントを指してもよい（editor のバリアントのプロパティの「＋」と同じ）',
  run({ session }, step) {
    checkStep(step, { positionals: 3 })
    const setId = resolveVariantSet(session, positional(step, 0, 'まとまり'), step.name)
    const key = positional(step, 1, '名前')
    const value = step.positionals[2]
    if (propertyNames(session.page, setId).includes(key.trim())) throw new UsageError(`${step.name}: プロパティ ${key} はもうあります`)
    session.apply((page) => {
      const result = addVariantProperty(page, setId, key, value)
      if (result.name === null) throw new UsageError(`${step.name}: 名前と値は空でなく、「,」「=」を含まないものにしてください`)
      return result.scene
    })
  },
}

export const variantPropRename: Command = {
  name: 'variant-prop-rename',
  kind: 'edit',
  usage: 'variant-prop-rename まとまり 名前 新しい名前',
  summary: 'バリアントのまとまりのプロパティの名前を、すべてのバリアントで変える。まとまりの代わりに中のバリアントを指してもよい',
  run({ session }, step) {
    checkStep(step, { positionals: 3 })
    const setId = resolveVariantSet(session, positional(step, 0, 'まとまり'), step.name)
    const from = positional(step, 1, '名前')
    const to = positional(step, 2, '新しい名前')
    requireProperty(session.page, setId, from, step.name)
    if (from === to.trim()) return
    if (propertyNames(session.page, setId).includes(to.trim())) throw new UsageError(`${step.name}: プロパティ ${to} はもうあります`)
    session.apply((page) => {
      const next = renameVariantProperty(page, setId, from, to)
      if (next === page) throw new UsageError(`${step.name}: 名前は空でなく、「,」「=」を含まないものにしてください: ${to}`)
      return next
    })
  },
}

export const variantPropRm: Command = {
  name: 'variant-prop-rm',
  kind: 'edit',
  usage: 'variant-prop-rm まとまり 名前',
  summary:
    'バリアントのまとまりのすべてのバリアントからプロパティを消す。プロパティが 1 つもなくなるバリアントができるなら消さない。まとまりの代わりに中のバリアントを指してもよい',
  run({ session }, step) {
    checkStep(step, { positionals: 2 })
    const setId = resolveVariantSet(session, positional(step, 0, 'まとまり'), step.name)
    const key = positional(step, 1, '名前')
    requireProperty(session.page, setId, key, step.name)
    session.apply((page) => {
      const next = removeVariantProperty(page, setId, key)
      if (next === page) throw new UsageError(`${step.name}: ${key} を消すとプロパティが 1 つもないバリアントができます`)
      return next
    })
  },
}

export const variantValueRename: Command = {
  name: 'variant-value-rename',
  kind: 'edit',
  usage: 'variant-value-rename まとまり プロパティ 値 新しい値',
  summary: 'バリアントのまとまりのプロパティの値を、その値を持つすべてのバリアントで変える。まとまりの代わりに中のバリアントを指してもよい',
  run({ session }, step) {
    checkStep(step, { positionals: 4 })
    const setId = resolveVariantSet(session, positional(step, 0, 'まとまり'), step.name)
    const key = positional(step, 1, 'プロパティ')
    const from = positional(step, 2, '値')
    const to = positional(step, 3, '新しい値')
    requireProperty(session.page, setId, key, step.name)
    const values = variantProperties(session.page, setId).find((property) => property.name === key)!.values
    if (!values.includes(from)) throw new UsageError(`${step.name}: ${key} に値 ${from} がありません（あるもの: ${values.join(', ')}）`)
    if (from === to.trim()) return
    if (values.includes(to.trim())) throw new UsageError(`${step.name}: ${key} の値 ${to} はもうあります`)
    session.apply((page) => {
      const next = renameVariantValue(page, setId, key, from, to)
      if (next === page) throw new UsageError(`${step.name}: 値は空でなく、「,」「=」を含まないものにしてください: ${to}`)
      return next
    })
  },
}

/** 「位置」（0 が先頭の整数）を読む。並びより大きければ最後へ */
function orderIndex(step: Step, at: number): number {
  const raw = positional(step, at, '位置')
  const index = Number(raw)
  if (!Number.isInteger(index) || index < 0) throw new UsageError(`${step.name}: 位置は 0 以上の整数です: ${raw}`)
  return index
}

export const variantPropOrder: Command = {
  name: 'variant-prop-order',
  kind: 'edit',
  usage: 'variant-prop-order まとまり 名前 位置',
  summary:
    'バリアントのまとまりのプロパティを、並びの「位置」番目（0 が先頭）へ移す。すべてのバリアントの名前の中のプロパティの順を揃えて書き換える。まとまりの代わりに中のバリアントを指してもよい（editor のバリアントのプロパティのドラッグと同じ）',
  run({ session }, step) {
    checkStep(step, { positionals: 3 })
    const setId = resolveVariantSet(session, positional(step, 0, 'まとまり'), step.name)
    const key = positional(step, 1, '名前')
    requireProperty(session.page, setId, key, step.name)
    const index = orderIndex(step, 2)
    session.apply((page) => moveVariantProperty(page, setId, key, index))
  },
}

export const variantValueOrder: Command = {
  name: 'variant-value-order',
  kind: 'edit',
  usage: 'variant-value-order まとまり プロパティ 値 位置',
  summary:
    'バリアントのまとまりのプロパティの値を、並びの「位置」番目（0 が先頭）へ移す。値の順はまとまりの中のバリアントの並び順なので、バリアントの並びを値の順に並べ直す（オートレイアウトのまとまりなら、並びに沿って位置も入れ替わる）。まとまりの代わりに中のバリアントを指してもよい',
  run({ session }, step) {
    checkStep(step, { positionals: 4 })
    const setId = resolveVariantSet(session, positional(step, 0, 'まとまり'), step.name)
    const key = positional(step, 1, 'プロパティ')
    const value = positional(step, 2, '値')
    requireProperty(session.page, setId, key, step.name)
    const values = variantProperties(session.page, setId).find((property) => property.name === key)!.values
    if (!values.includes(value)) throw new UsageError(`${step.name}: ${key} に値 ${value} がありません（あるもの: ${values.join(', ')}）`)
    const index = orderIndex(step, 3)
    session.apply((page) => moveVariantValue(page, setId, key, value, index))
  },
}
