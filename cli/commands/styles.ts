import { paintOrder } from '../../src/document/layers.ts'
import { isMaskNode } from '../../src/document/mask.ts'
import type { NodeId, Scene } from '../../src/document/types.ts'
import { type ColorFormat, formatColor } from '../../src/viewer/colors.ts'
import { DEFAULT_CODE_STYLE, shadowCss } from '../../src/viewer/inspect.ts'
import {
  type ColorUse,
  type ShadowUse,
  type TextStyleUse,
  compareColorUses,
  compareShadowUses,
  compareTextStyleUses,
  shadowKey,
  summarizePage,
  textStyleCss,
  textStyleKey,
} from '../../src/viewer/summary.ts'
import { type Step, UsageError } from '../args.ts'
import type { Session } from '../session.ts'
import { type Command, checkStep, colorOption, flag } from './common.ts'

// 使われている色・文字の書式・影の集計（colors / text-styles / shadows）。
// 数え方は viewer の「このページの色・文字・影」と同じ summarizePage（見えない色・隠れた色は数えない）。

/** ノードの指し方。--all では、ページをまたいで同じ id があるので、ページの id も付ける */
type NodeRef = { page: string; id: NodeId }
type Use = { count: number; nodes: NodeId[] }
type Merged<T extends Use> = { use: T; count: number; nodes: NodeRef[] }

/** 数える範囲: いまのページ / 全ページ（--all）/ 指定したノードとその中 */
function scopes(session: Session, step: Step): { page: string; scene: Scene }[] {
  const all = flag(step, 'all')
  if (all && step.positionals.length > 0) throw new UsageError(`${step.name}: --all とノードは一緒に指定できません`)
  if (all) return session.document.pages.map((page) => ({ page: page.id, scene: page }))
  const page = session.page
  if (step.positionals.length === 0) return [{ page: page.id, scene: page }]
  // 祖先と一緒に指定したものは、祖先の中で数えるので除く（2 度数えない）。祖先のせいで描かれないものも、viewer と同じく数えない
  const ids = paintOrder(page, session.resolveAll(step.positionals)).filter((id) => drawnAncestors(page, id))
  return [{ page: page.id, scene: { ...page, rootIds: ids } }]
}

/** 祖先がどれも中身を描くか（非表示・不透明度 0・マスク・ブーリアン演算の材料の中なら描かれない。summarizePage が祖先から辿るときと同じ決まり） */
function drawnAncestors(scene: Scene, id: NodeId): boolean {
  for (let p = scene.nodes[id].parentId; p !== null; p = scene.nodes[p].parentId) {
    const node = scene.nodes[p]
    if (!node.visible || node.opacity === 0 || isMaskNode(node) || (node.type === 'frame' && node.booleanOperation !== null)) return false
  }
  return true
}

/** ページごとの集計を、同じもの（key）どうしで足し合わせ、viewer と同じ順に並べる */
function merge<T extends Use>(parts: { page: string; uses: T[] }[], key: (use: T) => string, compare: (a: T, b: T) => number): Merged<T>[] {
  const merged = new Map<string, Merged<T>>()
  for (const { page, uses } of parts) {
    for (const use of uses) {
      const k = key(use)
      const entry = merged.get(k) ?? { use: { ...use, count: 0, nodes: [] }, count: 0, nodes: [] }
      entry.count += use.count
      entry.use.count += use.count
      entry.nodes.push(...use.nodes.map((id) => ({ page, id })))
      merged.set(k, entry)
    }
  }
  return [...merged.values()].sort((a, b) => compare(a.use, b.use))
}

const colorFormat = (step: Step): ColorFormat => colorOption(step) ?? 'hex'

type Kind = 'colors' | 'textStyles' | 'shadows'

function collect(session: Session, step: Step, kind: Kind) {
  const parts = scopes(session, step).map(({ page, scene }) => ({ page, summary: summarizePage(scene) }))
  if (kind === 'colors') return merge<ColorUse>(parts.map(({ page, summary }) => ({ page, uses: summary.colors })), (use) => use.color, compareColorUses)
  if (kind === 'textStyles') {
    return merge<TextStyleUse>(parts.map(({ page, summary }) => ({ page, uses: summary.textStyles })), textStyleKey, compareTextStyleUses)
  }
  return merge<ShadowUse>(parts.map(({ page, summary }) => ({ page, uses: summary.shadows })), (use) => shadowKey(use.shadow), compareShadowUses)
}

const usage = (name: string, color: boolean) => `${name} [ノード…] [--all]${color ? ' [--color hex|rgb|hsl]' : ''} [--json]`
const SCOPE = 'いまのページ（--all なら全ページ、ノードを指定すればその中）で'
const COUNT =
  '。数え方は viewer の一覧と同じ（非表示・不透明度 0・マスクのもの、不透明な塗りの下に隠れた色は数えない）。1 行に値と使われている数（タブ区切り）、--json なら使っているノードの id も'

export const colors: Command = {
  name: 'colors',
  kind: 'query',
  usage: usage('colors', true),
  summary: `${SCOPE}見えている塗りと線の色（グラデーションは各色）を、使われている数の多い順に出す${COUNT}`,
  flags: ['all', 'json'],
  run({ session, print }, step) {
    checkStep(step, { options: ['all', 'json', 'color'] })
    const format = colorFormat(step)
    const list = collect(session, step, 'colors') as Merged<ColorUse>[]
    const rows = list.map(({ use, count, nodes }) => ({ color: use.color, value: formatColor(use.color, format, { upper: true }), count, nodes }))
    if (flag(step, 'json')) print(JSON.stringify(rows, null, 2))
    else if (rows.length > 0) print(rows.map((row) => `${row.value}\t${row.count}`).join('\n'))
  },
}

export const textStyles: Command = {
  name: 'text-styles',
  kind: 'query',
  usage: usage('text-styles', false),
  summary: `${SCOPE}テキストの書式（書体・大きさ・太さ・行の高さ・字間）を、大きい順に CSS の font の形で出す（字間があれば ; letter-spacing: Npx を添える）${COUNT}`,
  flags: ['all', 'json'],
  run({ session, print }, step) {
    checkStep(step, { options: ['all', 'json'] })
    const list = collect(session, step, 'textStyles') as Merged<TextStyleUse>[]
    const rows = list.map(({ use, count, nodes }) => {
      const { count: _count, nodes: _nodes, ...style } = use
      return { ...style, value: textStyleCss(use), count, nodes }
    })
    if (flag(step, 'json')) print(JSON.stringify(rows, null, 2))
    else if (rows.length > 0) print(rows.map((row) => `${row.value}\t${row.count}`).join('\n'))
  },
}

export const shadows: Command = {
  name: 'shadows',
  kind: 'query',
  usage: usage('shadows', true),
  summary: `${SCOPE}影（ドロップシャドウ・内側の影）を、使われている数の多い順に CSS の box-shadow の値の形で出す${COUNT}`,
  flags: ['all', 'json'],
  run({ session, print }, step) {
    checkStep(step, { options: ['all', 'json', 'color'] })
    const style = { ...DEFAULT_CODE_STYLE, color: colorFormat(step) }
    const list = collect(session, step, 'shadows') as Merged<ShadowUse>[]
    const rows = list.map(({ use, count, nodes }) => ({ shadow: use.shadow, value: shadowCss(use.shadow, style), count, nodes }))
    if (flag(step, 'json')) print(JSON.stringify(rows, null, 2))
    else if (rows.length > 0) print(rows.map((row) => `${row.value}\t${row.count}`).join('\n'))
  },
}
