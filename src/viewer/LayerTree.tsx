import { useState } from 'react'
import type { NodeId, Scene, SceneNode } from '../document/types.ts'
import { TYPE_LABELS } from './inspect.ts'

type Props = {
  scene: Scene
  selectedId: NodeId | null
  onSelect: (id: NodeId) => void
}

type Row = { node: SceneNode; depth: number }

/**
 * フレームの中身を一覧に出すか。ふつうのフレームは開いた状態、インスタンスは閉じた状態から始まり、
 * toggled に入っているものは、その逆になる。選んでいるノードまでの道すじ（held）は、選んでいる間は開く。
 */
type Folding = { toggled: ReadonlySet<NodeId>; held: ReadonlySet<NodeId> }

function isOpen(node: SceneNode, { toggled, held }: Folding): boolean {
  if (held.has(node.id)) return true
  const instance = node.type === 'frame' && node.component?.role === 'instance'
  return instance === toggled.has(node.id)
}

/** 手前にあるものほど上に並べる。自動で並べるフレームの中だけは、並び順（先頭が上）のまま出す */
function buildRows(scene: Scene, folding: Folding): Row[] {
  const rows: Row[] = []
  function visit(ids: readonly NodeId[], depth: number, inLayout: boolean) {
    for (const id of inLayout ? ids : ids.toReversed()) {
      const node = scene.nodes[id]
      rows.push({ node, depth })
      if (node.type === 'frame' && isOpen(node, folding)) {
        visit(node.children, depth + 1, node.layout !== null)
      }
    }
  }
  visit(scene.rootIds, 0, false)
  return rows
}

/** viewer のレイヤー一覧。選ぶだけで、並べ替えや名前の変更はできない */
export function LayerTree({ scene, selectedId, onSelect }: Props) {
  const [toggled, setToggled] = useState<ReadonlySet<NodeId>>(new Set())

  // キャンバスで選んだものが、閉じたフレームの中に隠れたままにならないようにする
  const held = new Set<NodeId>()
  for (let id = selectedId === null ? null : scene.nodes[selectedId]?.parentId; id != null; ) {
    held.add(id)
    id = scene.nodes[id].parentId
  }
  const folding = { toggled, held }

  function toggle(id: NodeId) {
    const next = new Set(toggled)
    if (!next.delete(id)) next.add(id)
    setToggled(next)
  }

  return (
    <ul className="layer-list">
      {buildRows(scene, folding).map(({ node, depth }) => (
        <li
          key={node.id}
          className="layer-row inspect-layer"
          data-selected={node.id === selectedId}
          data-hidden={!node.visible}
          style={{ paddingLeft: 8 + depth * 14 }}
          title={TYPE_LABELS[node.type]}
          onClick={() => onSelect(node.id)}
        >
          {node.type === 'frame' && node.children.length > 0 ? (
            <button
              type="button"
              className="layer-caret"
              aria-label={isOpen(node, folding) ? '閉じる' : '開く'}
              onClick={(event) => {
                event.stopPropagation()
                toggle(node.id)
              }}
            >
              {isOpen(node, folding) ? '▾' : '▸'}
            </button>
          ) : (
            <span className="layer-caret" />
          )}
          <span className="layer-name">{node.name}</span>
        </li>
      ))}
    </ul>
  )
}
