import { type ReorderDirection, reorderNodes } from '../../src/editor/operations/arrange.ts'
import { moveNode, patchNodes, removeNodes } from '../../src/editor/operations/tree.ts'
import { UsageError } from '../args.ts'
import { estimateTextSize } from '../textMeasure.ts'
import { buildPatch } from '../values.ts'
import { type Command, checkStep, flag, numberOption, option, positional } from './common.ts'

// ノードを変えるコマンド（設定・削除・親の付け替え・重なり順）

const TEXT_KEYS = new Set(['text', 'fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'sizing', 'width', 'minWidth', 'maxWidth'])

export const set: Command = {
  name: 'set',
  kind: 'edit',
  assignments: true,
  usage: 'set ノード… 名前=値…',
  summary: '設定を変える（例: fill=#ff0000 cornerRadius=8 shadow.blur=4 text=こんにちは constraints.horizontal=end）。null で塗りなどを外す。fill・stroke・shadow は、いちばん上の塗り・線と最初の影の略記',
  run({ session }, step) {
    checkStep(step, { assignments: true })
    if (step.assignments.length === 0) throw new UsageError('set: 「名前=値」を指定してください')
    const ids = session.resolveAll(step.positionals)
    const page = session.page
    const patches = new Map(ids.map((id) => [id, buildPatch(page.nodes[id], step.assignments)]))
    const refit = step.assignments.some(([key]) => TEXT_KEYS.has(key.split('.')[0]))
    session.apply((base) =>
      patchNodes(base, ids, (node) => {
        const patch = patches.get(node.id)!
        if (!refit || node.type !== 'text') return patch
        return { ...patch, ...estimateTextSize({ ...node, ...patch } as typeof node) }
      }),
    )
  },
}

export const rm: Command = {
  name: 'rm',
  kind: 'edit',
  usage: 'rm ノード…',
  summary: 'ノードを中身ごと消す',
  run({ session }, step) {
    checkStep(step, {})
    const ids = session.resolveAll(step.positionals)
    session.apply((page) => removeNodes(page, ids))
  },
}

export const mv: Command = {
  name: 'mv',
  kind: 'edit',
  usage: 'mv ノード… (--parent フレーム | --root) [--index N]',
  summary: '別のフレームへ入れる・ページ直下へ出す。ページ上の見た目の位置は保つ。--index は兄弟の中での重なり順（0 が最背面）',
  flags: ['root'],
  run({ session }, step) {
    checkStep(step, { options: ['parent', 'root', 'index'] })
    const ids = session.resolveAll(step.positionals)
    const parent = option(step, 'parent')
    if ((parent === undefined) === !flag(step, 'root')) throw new UsageError('mv: --parent か --root のどちらかを指定してください')
    const parentId = parent === undefined ? null : session.resolveFrame(parent)
    const index = numberOption(step, 'index')
    session.apply((page) =>
      ids.reduce((next, id, i) => moveNode(next, id, parentId, index === undefined ? undefined : index + i), page),
    )
  },
}

export const order: Command = {
  name: 'order',
  kind: 'edit',
  usage: 'order front|back|forward|backward ノード…',
  summary: '重なり順を変える（最前面・最背面・1 つ手前・1 つ奥）',
  run({ session }, step) {
    checkStep(step, {})
    const direction = positional(step, 0, '向き') as ReorderDirection
    if (!['front', 'back', 'forward', 'backward'].includes(direction)) {
      throw new UsageError(`order: 向きは front / back / forward / backward です: ${direction}`)
    }
    const ids = session.resolveAll(step.positionals.slice(1))
    session.apply((page) => reorderNodes(page, ids, direction))
  },
}
