import { layerOrder } from '../../src/document/layers.ts'
import type { NodeId, Page, Scene } from '../../src/document/types.ts'
import { type ReorderDirection, reorderNodes } from '../../src/editor/operations/arrange.ts'
import { updatePage } from '../../src/editor/operations/document.ts'
import { moveNode, patchNodes, removeNodes } from '../../src/editor/operations/tree.ts'
import { refitPath } from '../../src/editor/pathEdit.ts'
import { UsageError } from '../args.ts'
import { estimateTextSize } from '../textMeasure.ts'
import { buildPatch } from '../values.ts'
import { type Command, checkStep, flag, numberOption, option, positional } from './common.ts'

// ノードを変えるコマンド（設定・文言の置き換え・削除・親の付け替え・重なり順）

const TEXT_KEYS = new Set(['text', 'fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'letterSpacing', 'sizing', 'width', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight'])

export const set: Command = {
  name: 'set',
  kind: 'edit',
  assignments: true,
  usage: 'set ノード… 名前=値…',
  summary: '設定を変える（例: fill=#ff0000 cornerRadius=8 shadow.blur=4 text=こんにちは constraints.horizontal=end）。null で塗りなどを外す。fill=var(color/primary) で色の変数につなぐ（stroke・shadow.color・fills.0.color も。色を直接書けばつながりは外れる）。cornerRadius=var(radius/md) gap=var(space/md) text=var(copy/title) visible=var(flag) のように、数値・文字・真偽の変数も項目につなげる。fill・stroke・shadow は、いちばん上の塗り・線と最初の影の略記（shadow.spread=4 で広がり）。blur=8 / backgroundBlur=8 はレイヤー・背景のぼかし（null で外す）、blendMode=multiply はノードの描画モード。cornerRadius=8,8,0,0 で角丸を 4 隅ばらばらに（左上・右上・右下・左下）。パスは radius=8 で全部の輪郭の頂点の角を丸める（頂点ごとなら 8,0,8 と通し番号の順に）。radius.1=8 なら 2 つ目の輪郭だけ（0 が最初の輪郭）。端の形は startCap / endCap=none|round|square|arrow|circle|diamond、印の大きさは capSize=16。破線は dash=4,2（null で実線）、そのずれは dashOffset=2、線の角の形は join=miter|round|bevel。大きさの決め方は width=fill|hug（数値なら、その大きさで固定）、行の高さは lineHeight=1.5（倍率）か 24px、字間は letterSpacing=2（px）か 0.05em、文字の装飾は textDecoration=underline|line-through|none。フレームは layout=row|column で自動で並べ（余白も間隔も 0 から）、並べ方を gap=8 padding="12 40"（1〜4 個、CSS と同じ順）align=center justify=space-between で決める',
  run({ session }, step) {
    checkStep(step, { assignments: true })
    if (step.assignments.length === 0) throw new UsageError('set: 「名前=値」を指定してください')
    const ids = session.resolveAll(step.positionals)
    const page = session.page
    const patches = new Map(ids.map((id) => [id, buildPatch(page.nodes[id], step.assignments, session.document.collections)]))
    const refit = step.assignments.some(([key]) => TEXT_KEYS.has(key.split('.')[0]))
    // 角の丸め（radius=）を変えたら、枠を描く形に合わせ直す。points を直接書いたときは書いた値のまま（割合を直接指定できるように）
    const rounding = step.assignments.some(([key]) => key === 'radius' || key.startsWith('radius.'))
    const reshaped = rounding ? ids.filter((id) => page.nodes[id].type === 'path') : []
    session.apply((base) =>
      reshaped.reduce(
        (scene, id) => refitPath(scene, id),
        patchNodes(base, ids, (node) => {
          const patch = patches.get(node.id)!
          if (!refit || node.type !== 'text') return patch
          return { ...patch, ...estimateTextSize({ ...node, ...patch } as typeof node) }
        }),
      ),
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

export const replace: Command = {
  name: 'replace',
  kind: 'edit',
  usage: 'replace 探す文字列 置き換える文字列 [--all-pages] [--ignore-case]',
  summary:
    'テキストの内容から文字列を探し、すべて置き換える（文字列そのままで探す。レイヤー名は変えない）。既定はいまのページだけで大文字と小文字を区別し、--all-pages で全部のページ、--ignore-case で区別しない。' +
    '置き換えたノード（ページ・id・道筋・件数）と合計を標準エラーに出す。大きさは測り直す。コンポーネントの元を置き換えるとインスタンスにも伝わり、写しで上書きした文言はその上書きを置き換える',
  flags: ['all-pages', 'ignore-case'],
  run({ session, warn }, step) {
    checkStep(step, { positionals: 2, options: ['all-pages', 'ignore-case'] })
    const search = positional(step, 0, '探す文字列')
    const replacement = positional(step, 1, '置き換える文字列')
    if (search === '') throw new UsageError('replace: 探す文字列が空です')
    const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flag(step, 'ignore-case') ? 'giu' : 'gu')
    const pages = flag(step, 'all-pages') ? session.document.pages : [session.page]
    const found = pages.map((page) => ({ page, hits: textMatches(page, pattern) })).filter(({ hits }) => hits.length > 0)
    if (found.length === 0) {
      warn(`replace: 「${search}」を含むテキストはありません`)
      return
    }
    const targets = new Map(found.map(({ page, hits }) => [page.id, hits.map((hit) => hit.id)]))
    session.applyDocument((doc) =>
      [...targets].reduce(
        (next, [pageId, ids]) =>
          updatePage(next, pageId, (page) =>
            patchNodes(page, ids, (node) => {
              if (node.type !== 'text') return null
              // 置き換える文字列の $ を特別扱いしないよう、関数で返す
              const text = node.text.replace(pattern, () => replacement)
              return { text, ...estimateTextSize({ ...node, text }) }
            }),
          ),
        doc,
      ),
    )
    const lines = found.flatMap(({ page, hits }) => hits.map((hit) => `${page.name}\t${hit.id}\t${namePath(page, hit.id)}\t${hit.count} か所`))
    const total = found.reduce((sum, { hits }) => sum + hits.reduce((n, hit) => n + hit.count, 0), 0)
    const nodes = found.reduce((sum, { hits }) => sum + hits.length, 0)
    for (const line of lines) warn(line)
    warn(`${nodes} 個のテキストの ${total} か所を置き換えました`)
  },
}

/** 文字列を含むテキストと、その数（レイヤーの一覧と同じ順） */
function textMatches(page: Page, pattern: RegExp): { id: NodeId; count: number }[] {
  const hits: { id: NodeId; count: number }[] = []
  const visit = (parentId: NodeId | null) => {
    for (const id of layerOrder(page, parentId)) {
      const node = page.nodes[id]
      if (node.type === 'text') {
        const count = node.text.match(pattern)?.length ?? 0
        if (count > 0) hits.push({ id, count })
      }
      visit(id)
    }
  }
  visit(null)
  return hits
}

/** レイヤー名を親からつないだ道筋（find と同じ形） */
function namePath(scene: Scene, id: NodeId): string {
  const names: string[] = []
  for (let current: NodeId | null = id; current !== null; current = scene.nodes[current].parentId) names.unshift(scene.nodes[current].name)
  return names.join('/')
}
