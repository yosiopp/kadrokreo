import type { NodeId, SceneNode } from './types.ts'

// ノードの表（Scene.nodes）を写して書き換えたとき、どの id を変えたかを覚えておく。
// ノードの表は書き換えずに作り直すので、「新しい表 → 元の表と変えた id」をたどれば、
// 全部のノードを比べ直さなくても、2 つの表の間で変わったノードが分かる（ストアの後始末が使う）。
// 覚えていない表（どこかで写して覚えなかった）にたどり着いたら分からない（null）ので、使う側は全部を見る。

type NodeTable = Readonly<Record<NodeId, SceneNode>>

type Origin = { base: NodeTable; ids: readonly NodeId[] }

const origins = new WeakMap<NodeTable, Origin>()

/** たどる段数の上限。後始末の 1 回でつながる写しは数段なので、これを超えたら全部を見てもらう */
const MAX_STEPS = 32

let enabled = true

/** 覚えるのをやめる・再開する（テストで、覚え書きを使わない結果と比べるため） */
export function trackNodeChanges(on: boolean): void {
  enabled = on
}

/**
 * next は base を写して ids のノードだけを書き換えた（足した・消した・置き換えた）表。
 * 覚えたあとに next を書き換えないこと（覚えた id と食い違う）
 */
export function noteNodeChanges(next: NodeTable, base: NodeTable, ids: Iterable<NodeId>): void {
  if (!enabled || next === base) return
  origins.set(next, { base, ids: [...ids] })
}

/**
 * base から next までに変わったかもしれないノードの id（足した・消したものも含む。変わっていないものが混じることはある）。
 * next が base を写して作った表だとたどれなければ null
 */
export function nodeChangesSince(base: NodeTable, next: NodeTable): Set<NodeId> | null {
  if (!enabled) return null
  const ids = new Set<NodeId>()
  let current = next
  for (let step = 0; step <= MAX_STEPS; step++) {
    if (current === base) return ids
    const origin = origins.get(current)
    if (!origin) return null
    for (const id of origin.ids) ids.add(id)
    current = origin.base
  }
  return null
}

/**
 * next から写しの元をさかのぼり、found が値を返す最初の表（table）とその値、そこから next までに変わったノードの id。
 * next 自身で見つかれば ids は空。見つからなければ null
 */
export function findNodeOrigin<T>(
  next: NodeTable,
  found: (table: NodeTable) => T | undefined,
): { value: T; table: NodeTable; ids: Set<NodeId> } | null {
  if (!enabled) return null
  const ids = new Set<NodeId>()
  let current = next
  for (let step = 0; step <= MAX_STEPS; step++) {
    const value = found(current)
    if (value !== undefined) return { value, table: current, ids }
    const origin = origins.get(current)
    if (!origin) return null
    for (const id of origin.ids) ids.add(id)
    current = origin.base
  }
  return null
}

/**
 * a と b の間で変わったかもしれないノードの id。どちらも同じ表から写して作ったとたどれれば、その表からそれぞれへの変更を合わせたもの
 * （ドラッグの 1 歩ずつのように、同じ元から別々に作った 2 つの表を比べるため）。たどれなければ null
 */
export function nodeChangesBetween(a: NodeTable, b: NodeTable): Set<NodeId> | null {
  if (!enabled) return null
  // a からさかのぼった表と、そこから a までに変わった id
  const fromA = new Map<NodeTable, Set<NodeId>>()
  let ids = new Set<NodeId>()
  let current: NodeTable | undefined = a
  for (let step = 0; step <= MAX_STEPS && current; step++) {
    fromA.set(current, ids)
    const origin = origins.get(current)
    if (!origin) break
    ids = new Set([...ids, ...origin.ids])
    current = origin.base
  }
  const fromB = new Set<NodeId>()
  current = b
  for (let step = 0; step <= MAX_STEPS && current; step++) {
    const shared = fromA.get(current)
    if (shared) return shared.size === 0 ? fromB : new Set([...fromB, ...shared])
    const origin = origins.get(current)
    if (!origin) return null
    for (const id of origin.ids) fromB.add(id)
    current = origin.base
  }
  return null
}
