import { getAbsoluteBounds, getWorldCenter, unionBounds } from '../../src/document/geometry.ts'
import { type Alignment, alignNodes, distributeNodes } from '../../src/editor/operations/arrange.ts'
import { flipNodes, rotateNodes } from '../../src/editor/operations/transform.ts'
import { topLevelIds } from '../../src/editor/operations/tree.ts'
import { UsageError } from '../args.ts'
import { type Command, checkStep, flag, option, point, positional } from './common.ts'

// 並べるコマンド（整列・等間隔・回転・反転）。中身は editor の整列ボタン・回転・反転と同じ処理

const ALIGNMENTS: readonly Alignment[] = ['left', 'center', 'right', 'top', 'middle', 'bottom']

export const align: Command = {
  name: 'align',
  kind: 'edit',
  usage: 'align left|center|right|top|middle|bottom ノード…',
  summary: '揃える。複数なら全体を囲む矩形に、1 つなら親フレームに揃える（editor の整列ボタンと同じ）',
  run({ session }, step) {
    checkStep(step, {})
    const alignment = positional(step, 0, '揃え方') as Alignment
    if (!ALIGNMENTS.includes(alignment)) throw new UsageError(`align: 揃え方は ${ALIGNMENTS.join(' / ')} です: ${alignment}`)
    const ids = session.resolveAll(step.positionals.slice(1))
    if (ids.length === 1 && session.page.nodes[ids[0]].parentId === null) {
      throw new UsageError('align: ページ直下のノード 1 つは揃える相手がありません（2 つ以上指定するか、フレームの中のノードを指定してください）')
    }
    session.apply((page) => alignNodes(page, ids, alignment))
  },
}

export const distribute: Command = {
  name: 'distribute',
  kind: 'edit',
  usage: 'distribute horizontal|vertical ノード…',
  summary: '両端のノードは動かさず、間隔が等しくなるように並べ直す（3 つ以上）',
  run({ session }, step) {
    checkStep(step, {})
    const direction = positional(step, 0, '向き（horizontal / vertical）')
    if (direction !== 'horizontal' && direction !== 'vertical') {
      throw new UsageError(`distribute: 向きは horizontal か vertical です: ${direction}`)
    }
    const ids = session.resolveAll(step.positionals.slice(1))
    if (topLevelIds(session.page, ids).length < 3) throw new UsageError('distribute: ノードを 3 つ以上指定してください')
    session.apply((page) => distributeNodes(page, ids, direction === 'horizontal' ? 'x' : 'y'))
  },
}

export const rotate: Command = {
  name: 'rotate',
  kind: 'edit',
  usage: 'rotate 度 ノード… [--each | --pivot x,y]',
  summary:
    '時計回りに回す（いまの角度に足す。角度そのものを決めるなら set rotation=）。ふつうは全体を囲む矩形の中心が軸、--each なら各ノードの中心、--pivot ならページ上の点',
  flags: ['each'],
  run({ session }, step) {
    checkStep(step, { options: ['each', 'pivot'] })
    const raw = positional(step, 0, '角度')
    const delta = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(delta)) throw new UsageError(`rotate: 角度は数値です: ${raw}`)
    const ids = session.resolveAll(step.positionals.slice(1))
    const pivotRaw = option(step, 'pivot')
    const each = flag(step, 'each')
    if (each && pivotRaw !== undefined) throw new UsageError('rotate: --each と --pivot は一緒に指定できません')
    session.apply((page) => {
      if (each) return ids.reduce((next, id) => rotateNodes(next, [id], getWorldCenter(next, id), delta), page)
      let pivot
      if (pivotRaw !== undefined) pivot = point(pivotRaw, '--pivot')
      else {
        const box = unionBounds(topLevelIds(page, ids).map((id) => getAbsoluteBounds(page, id)))!
        pivot = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      }
      return rotateNodes(page, ids, pivot, delta)
    })
  },
}

export const flip: Command = {
  name: 'flip',
  kind: 'edit',
  usage: 'flip horizontal|vertical ノード…',
  summary: '全体を囲む矩形の中心で、左右か上下に裏返す（editor の Shift + H / V と同じ。テキストと画像は字や絵も裏返し、インスタンスは位置と向きだけ）',
  run({ session }, step) {
    checkStep(step, {})
    const direction = positional(step, 0, '向き（horizontal / vertical）')
    if (direction !== 'horizontal' && direction !== 'vertical') {
      throw new UsageError(`flip: 向きは horizontal か vertical です: ${direction}`)
    }
    const ids = session.resolveAll(step.positionals.slice(1))
    session.apply((page) => flipNodes(page, ids, direction))
  },
}
