import { KdrError, decodeKdr } from '../../src/document/kdr.ts'
import { nodeKind } from '../../src/document/path.ts'
import type { DesignDocument, EmbeddedFont, NodeId, Page, SceneNode } from '../../src/document/types.ts'
import { listComponents } from '../../src/editor/components.ts'
import { pruneAssets } from '../../src/editor/operations/document.ts'
import { UsageError } from '../args.ts'
import { type Command, checkStep, flag, positional } from './common.ts'

// 2 つの kdr の違い（kdr diff 前 後）。ノードはページの中で id で突き合わせる。
// 入力の kdr は -f でなく 2 つの引数で受け取るので、ほかのコマンドとはつながない（standalone）。

/** 変わった項目 1 つ。path は get の項目と同じく . でつなぐ（配列は丸ごと 1 つの値として比べる） */
export type FieldChange = { path: string; before: unknown; after: unknown }
export type Change = 'added' | 'removed' | 'changed'

export type PageDiff = { change: Change; id: string; name: string; nodes?: number; fields?: FieldChange[] }
export type NodeDiff = {
  change: Change
  page: string
  id: NodeId
  kind: string
  name: string
  parentId: NodeId | null
  /** 増えた・消えたノードの子孫の数（子孫は 1 つずつは並べない） */
  descendants?: number
  fields?: FieldChange[]
}
export type ComponentDiff = { change: Change; id: string; node: NodeId; name: string; page: string }
export type AssetDiff = { change: Change; id: string; mime: string; bytes: number; fields?: FieldChange[] }
export type FontDiff = { change: Change; family: string; weight: number; style: string; fields?: FieldChange[] }

export type DocumentDiff = {
  different: boolean
  document: FieldChange[]
  pages: PageDiff[]
  nodes: NodeDiff[]
  components: ComponentDiff[]
  assets: AssetDiff[]
  fonts: FontDiff[]
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)

/** 2 つの値の違いを、入れ子のオブジェクトは . でつないだ項目ごとに出す。配列は丸ごと比べる */
function fieldChanges(before: unknown, after: unknown, path = '', skip: ReadonlySet<string> = new Set()): FieldChange[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => !skip.has(key))
    return keys.flatMap((key) => fieldChanges(before[key], after[key], path === '' ? key : `${path}.${key}`))
  }
  return same(before, after) ? [] : [{ path, before: before ?? null, after: after ?? null }]
}

/** 両方にあるものだけを残した並び（足した・消したものでなく、並べ替えだけを見るため） */
function commonOrder(ids: readonly NodeId[], other: ReadonlySet<NodeId>): NodeId[] {
  return ids.filter((id) => other.has(id))
}

/** ノードの比べ方: 子の並びは、両方にある子の順が変わったときだけ出す（足した・消した子はそれぞれのノードとして出る） */
function nodeChanges(before: SceneNode, after: SceneNode): FieldChange[] {
  const fields = fieldChanges(before, after, '', new Set(['id', 'children']))
  if (before.type === 'frame' && after.type === 'frame') {
    const a = commonOrder(before.children, new Set(after.children))
    const b = commonOrder(after.children, new Set(before.children))
    if (!same(a, b)) fields.push({ path: 'children', before: a, after: b })
  }
  return fields
}

/** レイヤーパネル（ls）と同じ順: 手前のものが上、親の次に子 */
function* walk(page: Page, ids: readonly NodeId[] = page.rootIds): Generator<SceneNode> {
  for (const id of ids.toReversed()) {
    const node = page.nodes[id]
    yield node
    if (node.type === 'frame') yield* walk(page, node.children)
  }
}

/** 子孫のうち、もう一方のページに無いもの（一緒に増えた・消えたもの）の数。移しただけのノードは別に出るので数えない */
function countDescendants(page: Page, node: SceneNode, other: Page): number {
  if (node.type !== 'frame') return 0
  return node.children.reduce((sum, id) => sum + (Object.hasOwn(other.nodes, id) ? 0 : 1) + countDescendants(page, page.nodes[id], other), 0)
}

function nodeEntry(change: Change, page: Page, node: SceneNode): NodeDiff {
  return { change, page: page.id, id: node.id, kind: nodeKind(node), name: node.name, parentId: node.parentId }
}

/** 同じ id のページの中のノードを比べる。増えた・消えたノードは、親も同じく増えた・消えたなら並べず、いちばん上だけを子孫の数と出す */
function diffNodes(before: Page, after: Page): NodeDiff[] {
  const out: NodeDiff[] = []
  for (const node of walk(after)) {
    const old = Object.hasOwn(before.nodes, node.id) ? before.nodes[node.id] : undefined
    if (old === undefined) {
      if (node.parentId !== null && !Object.hasOwn(before.nodes, node.parentId)) continue
      const descendants = countDescendants(after, node, before)
      out.push({ ...nodeEntry('added', after, node), ...(descendants > 0 ? { descendants } : {}) })
      continue
    }
    const fields = nodeChanges(old, node)
    if (fields.length > 0) out.push({ ...nodeEntry('changed', after, node), fields })
  }
  for (const node of walk(before)) {
    if (Object.hasOwn(after.nodes, node.id)) continue
    if (node.parentId !== null && !Object.hasOwn(after.nodes, node.parentId)) continue
    const descendants = countDescendants(before, node, after)
    out.push({ ...nodeEntry('removed', before, node), ...(descendants > 0 ? { descendants } : {}) })
  }
  return out
}

function diffPages(before: DesignDocument, after: DesignDocument): { pages: PageDiff[]; nodes: NodeDiff[] } {
  const pages: PageDiff[] = []
  const nodes: NodeDiff[] = []
  const oldPages = new Map(before.pages.map((page) => [page.id, page]))
  const newIds = new Set(after.pages.map((page) => page.id))
  // ページの順は、両方にあるページの中での位置で比べる（ページを足しただけで後ろのページが「動いた」とならないように）
  const oldOrder = before.pages.map((page) => page.id).filter((id) => newIds.has(id))
  const newOrder = after.pages.map((page) => page.id).filter((id) => oldPages.has(id))
  for (const page of after.pages) {
    const old = oldPages.get(page.id)
    if (old === undefined) {
      pages.push({ change: 'added', id: page.id, name: page.name, nodes: Object.keys(page.nodes).length })
      continue
    }
    const fields = fieldChanges({ name: old.name }, { name: page.name })
    const from = oldOrder.indexOf(page.id)
    const to = newOrder.indexOf(page.id)
    if (from !== to) fields.push({ path: 'index', before: from, after: to })
    const roots = [commonOrder(old.rootIds, new Set(page.rootIds)), commonOrder(page.rootIds, new Set(old.rootIds))]
    if (!same(roots[0], roots[1])) fields.push({ path: 'rootIds', before: roots[0], after: roots[1] })
    if (fields.length > 0) pages.push({ change: 'changed', id: page.id, name: page.name, fields })
    nodes.push(...diffNodes(old, page))
  }
  for (const page of before.pages) {
    if (!newIds.has(page.id)) pages.push({ change: 'removed', id: page.id, name: page.name, nodes: Object.keys(page.nodes).length })
  }
  return { pages, nodes }
}

function diffComponents(before: DesignDocument, after: DesignDocument): ComponentDiff[] {
  const entry = (change: Change, { page, node }: ReturnType<typeof listComponents>[number]): ComponentDiff => ({
    change,
    id: node.component.id,
    node: node.id,
    name: node.name,
    page: page.id,
  })
  const oldList = listComponents(before)
  const newList = listComponents(after)
  const oldIds = new Set(oldList.map(({ node }) => node.component.id))
  const newIds = new Set(newList.map(({ node }) => node.component.id))
  return [
    ...newList.filter(({ node }) => !oldIds.has(node.component.id)).map((main) => entry('added', main)),
    ...oldList.filter(({ node }) => !newIds.has(node.component.id)).map((main) => entry('removed', main)),
  ]
}

function diffAssets(before: DesignDocument, after: DesignDocument): AssetDiff[] {
  const out: AssetDiff[] = []
  for (const [id, asset] of Object.entries(after.assets)) {
    const old = Object.hasOwn(before.assets, id) ? before.assets[id] : undefined
    const entry = { id, mime: asset.mime, bytes: asset.bytes.length }
    if (old === undefined) out.push({ change: 'added', ...entry })
    else {
      // id は中身のハッシュなので、ふつうは変わらない。種類（mime）だけが変わることはありうる
      const fields = fieldChanges({ mime: old.mime, bytes: old.bytes.length }, { mime: asset.mime, bytes: asset.bytes.length })
      if (fields.length === 0 && !sameBytes(old.bytes, asset.bytes)) fields.push({ path: 'bytes', before: old.bytes.length, after: asset.bytes.length })
      if (fields.length > 0) out.push({ change: 'changed', ...entry, fields })
    }
  }
  for (const [id, asset] of Object.entries(before.assets)) {
    if (!Object.hasOwn(after.assets, id)) out.push({ change: 'removed', id, mime: asset.mime, bytes: asset.bytes.length })
  }
  return out
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

function diffFonts(before: DesignDocument, after: DesignDocument): FontDiff[] {
  const key = (font: EmbeddedFont) => `${font.family}\u0000${font.weight}\u0000${font.style}`
  const face = (font: EmbeddedFont) => ({ family: font.family, weight: font.weight, style: font.style })
  const oldFonts = new Map(before.fonts.map((font) => [key(font), font]))
  const newKeys = new Set(after.fonts.map(key))
  const out: FontDiff[] = []
  for (const font of after.fonts) {
    const old = oldFonts.get(key(font))
    if (old === undefined) out.push({ change: 'added', ...face(font) })
    else {
      const fields = fieldChanges(old, font)
      if (fields.length > 0) out.push({ change: 'changed', ...face(font), fields })
    }
  }
  for (const font of before.fonts) if (!newKeys.has(key(font))) out.push({ change: 'removed', ...face(font) })
  return out
}

/** 2 つのドキュメントの違い。使われていない画像・書体のファイルは保存のときに除かれるので、比べる前に除く */
export function diffDocuments(beforeDoc: DesignDocument, afterDoc: DesignDocument): DocumentDiff {
  const before = pruneAssets(beforeDoc)
  const after = pruneAssets(afterDoc)
  const { pages, nodes } = diffPages(before, after)
  const result = {
    document: fieldChanges({ name: before.name }, { name: after.name }),
    pages,
    nodes,
    components: diffComponents(before, after),
    assets: diffAssets(before, after),
    fonts: diffFonts(before, after),
  }
  return { different: Object.values(result).some((list) => list.length > 0), ...result }
}

// ── テキストの出力 ──

const MARK: Record<Change, string> = { added: '+', removed: '-', changed: '~' }
const MAX_VALUE = 80

function formatValue(value: unknown): string {
  const text = JSON.stringify(value) ?? 'null'
  return text.length > MAX_VALUE ? text.slice(0, MAX_VALUE - 1) + '…' : text
}

function fieldLines(fields: readonly FieldChange[] | undefined): string[] {
  return (fields ?? []).map((field) => `    ${field.path}: ${formatValue(field.before)} → ${formatValue(field.after)}`)
}

/** 人が読む形。違いが無ければ空 */
export function formatDiff(diff: DocumentDiff, before: DesignDocument, after: DesignDocument): string {
  const lines: string[] = []
  if (diff.document.length > 0) lines.push('~ document', ...fieldLines(diff.document))
  for (const page of diff.pages) {
    const count = page.nodes === undefined ? '' : `  nodes:${page.nodes}`
    lines.push(`${MARK[page.change]} page ${JSON.stringify(page.name)}  ${page.id}${count}`, ...fieldLines(page.fields))
  }
  for (const component of diff.components) {
    lines.push(`${MARK[component.change]} component ${JSON.stringify(component.name)}  ${component.node}  page:${component.page}`)
  }
  for (const asset of diff.assets) {
    lines.push(`${MARK[asset.change]} asset ${asset.id}  ${asset.mime}  ${asset.bytes} bytes`, ...fieldLines(asset.fields))
  }
  for (const font of diff.fonts) {
    const style = font.style === 'italic' ? ' italic' : ''
    lines.push(`${MARK[font.change]} font ${JSON.stringify(font.family)}  ${font.weight}${style}`, ...fieldLines(font.fields))
  }
  // ノードはページごとに見出しを付ける（ls --all と同じ形）
  const pageName = new Map([...before.pages, ...after.pages].map((page) => [page.id, page.name]))
  let current: string | null = null
  for (const node of diff.nodes) {
    if (node.page !== current) {
      current = node.page
      lines.push(`# ${pageName.get(node.page)}  ${node.page}`)
    }
    const descendants = node.descendants === undefined ? '' : `  (+${node.descendants} descendants)`
    lines.push(`${MARK[node.change]} ${node.kind} ${JSON.stringify(node.name)}  ${node.id}${descendants}`, ...fieldLines(node.fields))
  }
  return lines.join('\n')
}

// ── コマンド ──

async function load(read: (path: string) => Promise<Uint8Array<ArrayBuffer>>, path: string): Promise<DesignDocument> {
  try {
    return await decodeKdr(new Blob([await read(path)]))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const label = path === '-' ? '標準入力' : path
    throw error instanceof KdrError ? new KdrError(`${label}: ${message}`) : new Error(`${label}: ${message}`)
  }
}

export const diff: Command = {
  name: 'diff',
  kind: 'query',
  standalone: true,
  reports: true,
  usage: 'diff 前.kdr 後.kdr [--json]',
  summary:
    '2 つの kdr のノード単位の違い（増えた +・消えた -・変わった ~ と、変わった項目の前後の値）と、ページ・コンポーネント・画像・書体の増減を出す。違いが無ければ何も出さず終了コード 0、あれば 1。- で片方を標準入力から読む。ほかのコマンドや -f とはつなげない',
  flags: ['json'],
  async run({ readInput, stdinIsTTY, print, report }, step) {
    checkStep(step, { options: ['json'], positionals: 2 })
    const paths = [positional(step, 0, '前の kdr ファイル'), positional(step, 1, '後の kdr ファイル')]
    if (paths[0] === '-' && paths[1] === '-') throw new UsageError('標準入力（-）から読めるのは片方だけです')
    if (paths.includes('-') && stdinIsTTY) throw new UsageError('標準入力（-）が端末です。パイプで kdr を渡してください')
    const before = await load(readInput, paths[0])
    const after = await load(readInput, paths[1])
    const result = diffDocuments(before, after)
    if (result.different) report()
    if (flag(step, 'json')) print(JSON.stringify(result, null, 2))
    else if (result.different) print(formatDiff(result, before, after))
  },
}
