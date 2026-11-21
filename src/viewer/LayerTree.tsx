import { useState } from 'react'
import { isComponentPart } from '../document/component.ts'
import { isOpen, layerRows, toggleFolding } from '../document/layers.ts'
import type { NodeId, Scene } from '../document/types.ts'
import { LayerCaret, LayerIcon } from '../ui/LayerParts.tsx'
import { TYPE_LABELS } from '../ui/labels.ts'
import { searchLayers } from './traverse.ts'

type Props = {
  scene: Scene
  selection: readonly NodeId[]
  /** additive は Shift を押しながら押したとき（選択に足す・外す） */
  onSelect: (id: NodeId, additive: boolean) => void
}

/** viewer のレイヤー一覧。選ぶだけで、並べ替えや名前の変更はできない */
export function LayerTree({ scene, selection, onSelect }: Props) {
  const [toggled, setToggled] = useState<ReadonlySet<NodeId>>(new Set())
  const [query, setQuery] = useState('')

  // キャンバスで選んだものが、閉じたフレームの中に隠れたままにならないようにする
  const held = new Set<NodeId>()
  for (const selected of selection) {
    for (let id = scene.nodes[selected]?.parentId; id != null && !held.has(id); ) {
      held.add(id)
      id = scene.nodes[id].parentId
    }
  }
  const folding = { toggled, held }

  // 探している間は、木ではなく、見つかったものだけを平らに並べる
  const needle = query.trim()
  const searching = needle !== ''
  const rows = searching
    ? searchLayers(scene, needle).map((id) => ({ node: scene.nodes[id], depth: 0 }))
    : layerRows(scene, folding)

  return (
    <>
      <input
        type="search"
        className="layer-search"
        aria-label="レイヤーを検索"
        placeholder="名前や文言で検索"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          setQuery('')
          event.currentTarget.blur()
        }}
      />
      {searching && rows.length === 0 && <p className="panel-hint">見つかりません。</p>}
      <ul className="layer-list">
        {rows.map(({ node, depth }) => (
          <li
            key={node.id}
            className="layer-row inspect-layer"
            data-selected={selection.includes(node.id)}
            data-hidden={!node.visible}
            data-component={isComponentPart(scene, node.id)}
            style={{ paddingLeft: 8 + depth * 14 }}
            title={TYPE_LABELS[node.type]}
            onClick={(event) => onSelect(node.id, event.shiftKey)}
          >
            {!searching && (
              <LayerCaret
                node={node}
                open={isOpen(node, folding)}
                onToggle={() => setToggled(toggleFolding(toggled, node.id))}
              />
            )}
            <LayerIcon node={node} />
            <span className="layer-name">{node.name}</span>
          </li>
        ))}
      </ul>
    </>
  )
}
