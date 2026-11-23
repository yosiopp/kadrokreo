import { isInstance } from './component.ts'
import type { NodeId, Scene, SceneNode } from './types.ts'

// レイヤー一覧としての、ノードの木の並べ方。editor と viewer の一覧、キーボードでの移動、検索が、同じ並びを使う。

/**
 * parentId の子（null ならページ直下）を、レイヤー一覧に出す順に並べる。
 * 手前にあるものほど先。自動で並べるフレームの中だけは、キャンバスでの並び順（先頭が先）のまま。
 */
export function layerOrder(scene: Scene, parentId: NodeId | null): NodeId[] {
  if (parentId === null) return scene.rootIds.toReversed()
  const parent = scene.nodes[parentId]
  if (parent?.type !== 'frame') return []
  return parent.layout ? [...parent.children] : parent.children.toReversed()
}

/**
 * フレームの中身を一覧に出すか。ふつうのフレームは開いた状態、インスタンスは閉じた状態から始まり、
 * toggled に入っているものは、その逆になる。held に入っているものは、いつも開く（選んでいるものを隠さないために使う）。
 */
export type Folding = { toggled: ReadonlySet<NodeId>; held: ReadonlySet<NodeId> }

export function isOpen(node: SceneNode, { toggled, held }: Folding): boolean {
  return held.has(node.id) || isInstance(node) === toggled.has(node.id)
}

/** toggled の id を入れ替えたもの（開いていれば閉じ、閉じていれば開く） */
export function toggleFolding(toggled: ReadonlySet<NodeId>, id: NodeId): ReadonlySet<NodeId> {
  const next = new Set(toggled)
  if (!next.delete(id)) next.add(id)
  return next
}

/** copy は、インスタンスの中身（元の写し） */
export type LayerRow = { node: SceneNode; depth: number; copy: boolean }

/** 一覧に出す行。閉じているフレームの中身は含めない */
export function layerRows(scene: Scene, folding: Folding): LayerRow[] {
  const rows: LayerRow[] = []
  function visit(parentId: NodeId | null, depth: number, copy: boolean) {
    for (const id of layerOrder(scene, parentId)) {
      const node = scene.nodes[id]
      rows.push({ node, depth, copy })
      if (node.type === 'frame' && isOpen(node, folding)) visit(id, depth + 1, copy || isInstance(node))
    }
  }
  visit(null, 0, false)
  return rows
}

/**
 * ids を、描く順（奥から手前）に並べる。ほかの ids の中にあるもの（祖先も選ばれているもの）は、祖先と一緒に描かれるので除く。
 * 複数のものをまとめて PNG・SVG に書き出すときに使う（canvas/exportPng.ts の exportTargets）。
 */
export function paintOrder(scene: Scene, ids: readonly NodeId[]): NodeId[] {
  const wanted = new Set(ids)
  const ordered: NodeId[] = []
  function visit(children: readonly NodeId[]) {
    for (const id of children) {
      const node = scene.nodes[id]
      if (wanted.has(id)) ordered.push(id)
      else if (node.type === 'frame') visit(node.children)
    }
  }
  visit(scene.rootIds)
  return ordered
}
