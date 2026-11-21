import { layerOrder } from '../document/layers.ts'
import type { NodeId, Scene } from '../document/types.ts'

// レイヤー一覧の並びに沿った、選択の移動と検索。

/** parent は親へ、child は一覧でいちばん上の子へ、next / previous は一覧で隣のきょうだいへ */
export type Step = 'parent' | 'child' | 'next' | 'previous'

/** id から step の向きへ進んだ先のノード。進む先がなければ null */
export function stepFrom(scene: Scene, id: NodeId, step: Step): NodeId | null {
  const node = scene.nodes[id]
  if (!node) return null
  if (step === 'parent') return node.parentId
  if (step === 'child') return layerOrder(scene, id)[0] ?? null

  // 端まで行ったら、反対の端へ回る
  const siblings = layerOrder(scene, node.parentId)
  if (siblings.length < 2) return null
  const offset = step === 'next' ? 1 : siblings.length - 1
  return siblings[(siblings.indexOf(id) + offset) % siblings.length]
}

/**
 * 名前か、テキストの内容に needle を含むノードを、レイヤー一覧の順に集める。大文字と小文字は区別しない。
 * 閉じているフレームやインスタンスの中身も対象にする。
 */
export function searchLayers(scene: Scene, needle: string): NodeId[] {
  const lower = needle.toLowerCase()
  const found: NodeId[] = []
  function visit(parentId: NodeId | null) {
    for (const id of layerOrder(scene, parentId)) {
      const node = scene.nodes[id]
      const text = node.type === 'text' ? `${node.name}\n${node.text}` : node.name
      if (text.toLowerCase().includes(lower)) found.push(id)
      visit(id)
    }
  }
  visit(null)
  return found
}

/**
 * ids を、描く順（奥から手前）に並べる。ほかの ids の中にあるもの（祖先も選ばれているもの）は、祖先と一緒に描かれるので除く。
 * 複数のものをまとめて PNG に書き出すときに使う。
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
