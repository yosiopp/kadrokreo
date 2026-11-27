import type { NodeId } from '../../src/document/types.ts'
import { enableAutoLayout, setAutoLayoutEnabled, setLayoutFill, wrapInAutoLayout } from '../../src/editor/layout.ts'
import { updateNode } from '../../src/editor/operations/tree.ts'
import { UsageError } from '../args.ts'
import { checkNewId, renameNodeId } from '../session.ts'
import { buildPatch } from '../values.ts'
import { type Command, checkStep, flag, option, positional } from './common.ts'

// オートレイアウトのコマンド

/** 並べ方の「名前=値」は layout の中の項目。大きさの決め方（sizing.width=hug など）だけはノードの項目 */
const LAYOUT_PREFIX = (assignments: readonly [string, string][]) =>
  assignments.map(
    ([key, value]) => [key.startsWith('layout.') || key.startsWith('sizing.') ? key : `layout.${key}`, value] as [string, string],
  )

export const autoLayout: Command = {
  name: 'auto-layout',
  kind: 'edit',
  assignments: true,
  usage: 'auto-layout フレーム [--off] [direction=vertical gap=8 padding=16 align=center wrap=true crossGap=8 alignContent=space-between …]\n' +
    '      グリッド: mode=grid columns=3 [columnWidth=120（null で等分）] gap=列の間隔 crossGap=行の間隔',
  summary: 'フレームの中身を自動で並べるようにする（--off でやめる）。名前=値 で並べ方を変える',
  flags: ['off'],
  run({ session }, step) {
    checkStep(step, { options: ['off'], positionals: 1, assignments: true })
    const id = session.resolveFrame(positional(step, 0, 'フレーム'))
    if (flag(step, 'off')) {
      session.apply((page) => setAutoLayoutEnabled(page, [id], false))
      return
    }
    session.apply((page) => {
      const enabled = enableAutoLayout(page, id)
      return updateNode(enabled, id, buildPatch(enabled.nodes[id], LAYOUT_PREFIX(step.assignments)))
    })
  },
}

export const wrap: Command = {
  name: 'wrap',
  kind: 'edit',
  assignments: true,
  usage: 'wrap ノード… [--name 名前] [--id ID] [direction=… gap=… padding=…]',
  summary: 'ノードを、自動で並べる新しいフレームにまとめる。まとめたフレームは「@」で指せる',
  run({ session }, step) {
    checkStep(step, { options: ['name', 'id'], assignments: true })
    const ids = session.resolveAll(step.positionals)
    const name = option(step, 'name') ?? 'Frame'
    const wanted = option(step, 'id')
    if (wanted !== undefined) checkNewId(session.page, wanted)
    let created: NodeId | null = null
    session.apply((page) => {
      const result = wrapInAutoLayout(page, ids, name)
      if (result.id === null) return page
      created = wanted ?? result.id
      const renamed = wanted === undefined ? result.scene : renameNodeId(result.scene, result.id, wanted)
      return updateNode(renamed, created, buildPatch(renamed.nodes[created], LAYOUT_PREFIX(step.assignments)))
    })
    session.last = created === null ? [] : [created]
  },
}

export const layoutFill: Command = {
  name: 'layout-fill',
  kind: 'edit',
  usage: 'layout-fill width|height ノード… [--off]',
  summary: '自動で並べるフレームの子を、その向きに親いっぱいまで伸ばす（--off でやめる）',
  flags: ['off'],
  run({ session }, step) {
    checkStep(step, { options: ['off'] })
    const axis = positional(step, 0, '向き（width / height）')
    if (axis !== 'width' && axis !== 'height') throw new UsageError(`layout-fill: 向きは width か height です: ${axis}`)
    const ids = session.resolveAll(step.positionals.slice(1))
    session.apply((page) => setLayoutFill(page, ids, axis, !flag(step, 'off')))
  },
}
