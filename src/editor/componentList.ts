import type { MainNode } from '../document/component.ts'
import type { DesignDocument, NodeId, Page } from '../document/types.ts'
import { variantSetOf, variantsIn } from '../document/variants.ts'
import { listComponents } from './components.ts'

// コンポーネントの一覧のパネル（ComponentsPanel）に並べる行を決める

/** 並べ方。document はページの順（ページの中では作った順）、name は名前の順 */
export type ComponentSort = 'document' | 'name'

/** 一覧の 1 行 */
export type ComponentEntry = {
  page: Page
  /** 押したときに置く元。まとまりの行なら、最初のバリアント（検索中は当てはまった最初のもの） */
  node: MainNode
  /** 行に出す名前。まとまりならまとまりの名前 */
  name: string
  /** 名前にポインタを重ねたときに出す説明文。まとまりならまとまりの説明文（フレームの setDescription） */
  description: string
  /** 「元を表示」で選ぶノード。まとまりならまとまり */
  shownId: NodeId
  /** まとまりなら、その中のバリアントの行（まとまりの中の順）。まとまりでなければ空 */
  variants: ComponentEntry[]
}

/**
 * 一覧の行。バリアントはまとまりごとに 1 行にまとめ、その下にバリアントの行を持たせる。
 * query があれば、名前に含むもの（大文字と小文字は区別しない）だけに絞る。まとまりは、まとまりの名前が当てはまれば
 * すべてのバリアントを、そうでなければ当てはまったバリアントだけを残す
 */
export function componentEntries(doc: DesignDocument, query: string, sort: ComponentSort): ComponentEntry[] {
  const needle = query.trim().toLowerCase()
  const matches = (name: string) => needle === '' || name.toLowerCase().includes(needle)
  const seen = new Set<string>()
  const entries = listComponents(doc).flatMap(({ page, node }): ComponentEntry[] => {
    const set = variantSetOf(page, node.id)
    if (!set) return matches(node.name) ? [{ page, node, name: node.name, description: node.component.description, shownId: node.id, variants: [] }] : []
    const key = `${page.id}:${set.id}`
    if (seen.has(key)) return []
    seen.add(key)
    const all = variantsIn(page, set.id)
    const variants = matches(set.name) ? all : all.filter((variant) => matches(variant.name))
    if (variants.length === 0) return []
    return [
      {
        page,
        node: variants[0],
        name: set.name,
        description: set.setDescription,
        shownId: set.id,
        variants: variants.map((variant) => ({
          page,
          node: variant,
          name: variant.name,
          description: variant.component.description,
          shownId: variant.id,
          variants: [],
        })),
      },
    ]
  })
  if (sort === 'name') entries.sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }))
  return entries
}

/** ページごとの見出しを付けるときの、ページと、そのページの行 */
export type ComponentGroup = { page: Page; entries: ComponentEntry[] }

/** 行をページごとにまとめる（行の順のまま。同じページの行が離れていれば、別のまとまりになる） */
export function groupByPage(entries: readonly ComponentEntry[]): ComponentGroup[] {
  const groups: ComponentGroup[] = []
  for (const entry of entries) {
    const last = groups.at(-1)
    if (last && last.page.id === entry.page.id) last.entries.push(entry)
    else groups.push({ page: entry.page, entries: [entry] })
  }
  return groups
}
