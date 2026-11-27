// kdr markup の書き出しを build し直したドキュメントと、元のドキュメントの違いを挙げる。
// 表せずに落としたものの知らせ（markupOut.ts の drops）から漏れたものを、利用者に知らせるための安全網。
// コンポーネントの id は build が振り直すので、元のノードの id で対応を付けてから比べる。
import { isMain, owningInstance } from '../src/document/component.ts'
import type { DesignDocument, NodeId, Page, SceneNode } from '../src/document/types.ts'

/** 知らせる違いの行の上限（それより多ければ件数だけ） */
const MAX_LINES = 20
const GEOMETRY = new Set(['x', 'y', 'width', 'height'])

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b))
}

/** 小さな誤差（パスの頂点の割合など）を除いて同じか */
function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return close(a, b)
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => same(value, b[i]))
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    return [...keys].every((key) => same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
  }
  return a === b
}

/** 作り直した側のコンポーネントの id を、元の id に読み替える */
function renameComponents(node: SceneNode, rename: (id: string) => string): SceneNode {
  if (node.type !== 'frame' || !node.component) return node
  const link = node.component
  if (link.role === 'main') {
    return { ...node, component: { ...link, id: rename(link.id), properties: link.properties.map((property) => ({ ...property, preferred: property.preferred.map(rename) })) } }
  }
  const overrides = Object.fromEntries(
    Object.entries(link.overrides).map(([key, override]) => [key, override.componentId === undefined ? override : { ...override, componentId: rename(override.componentId) }]),
  )
  return { ...node, component: { ...link, id: rename(link.id), overrides } }
}

function label(page: Page, node: SceneNode): string {
  const owner = owningInstance(page, node.id)
  return owner ? `インスタンス ${owner.name}（${owner.id}）の中身 ${node.name}（${node.id}）` : `${node.name}（${node.id}）`
}

export function documentDifferences(original: DesignDocument, rebuilt: DesignDocument): string[] {
  const lines: string[] = []
  if (original.name !== rebuilt.name) lines.push('ドキュメントの名前')
  if (original.fonts.length !== rebuilt.fonts.length) lines.push('埋め込んだ書体')
  const rebuiltPages = new Map(rebuilt.pages.map((page) => [page.id, page]))
  if (original.pages.map((page) => page.id).join('\n') !== rebuilt.pages.map((page) => page.id).join('\n')) lines.push('ページの並び')
  // 元のノードの id で、コンポーネントの id の対応を付ける
  const renames = new Map<string, string>()
  for (const page of original.pages) {
    const other = rebuiltPages.get(page.id)
    if (!other) continue
    for (const node of Object.values(page.nodes)) {
      const counterpart = other.nodes[node.id]
      if (isMain(node) && isMain(counterpart)) renames.set(counterpart.component.id, node.component.id)
    }
  }
  const rename = (id: string) => renames.get(id) ?? id
  let geometry = 0
  const geometryIds: string[] = []
  for (const page of original.pages) {
    const other = rebuiltPages.get(page.id)
    if (!other) {
      lines.push(`ページ ${page.name}（${page.id}）がない`)
      continue
    }
    if (page.name !== other.name) lines.push(`ページ ${page.id} の名前`)
    if (JSON.stringify(page.guides) !== JSON.stringify(other.guides)) lines.push(`ページ ${page.name} のガイド線`)
    if (!same(page.rootIds, other.rootIds)) lines.push(`ページ ${page.name} の直下の並び`)
    for (const node of Object.values(page.nodes)) {
      const counterpart = other.nodes[node.id]
      if (!counterpart) {
        lines.push(`${label(page, node)} がない`)
        continue
      }
      const before = node as unknown as Record<string, unknown>
      const after = renameComponents(counterpart, rename) as unknown as Record<string, unknown>
      const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => !same(before[key], after[key]))
      if (keys.some((key) => GEOMETRY.has(key))) {
        geometry++
        if (geometryIds.length < 5) geometryIds.push(node.id)
      }
      const rest = keys.filter((key) => !GEOMETRY.has(key))
      if (rest.length > 0) lines.push(`${label(page, node)} の ${rest.join('・')}`)
    }
    for (const id of Object.keys(other.nodes)) {
      if (!Object.hasOwn(page.nodes, id)) lines.push(`増えたノード ${(other.nodes[id] as SceneNode).name}（${id as NodeId}）`)
    }
  }
  const shown = lines.slice(0, MAX_LINES).map((line) => `作り直すと元と違う: ${line}`)
  if (lines.length > MAX_LINES) shown.push(`作り直すと元と違うところが、ほかに ${lines.length - MAX_LINES} か所あります`)
  if (geometry > 0) {
    shown.push(
      `作り直すと ${geometry} 個のノードの位置か大きさが変わります（${geometryIds.join(', ')}${geometry > geometryIds.length ? ' …' : ''}。build は並べ直しと文字の幅の見積もりで決め直すので、editor で作った kdr ではずれることがある）`,
    )
  }
  return shown
}
