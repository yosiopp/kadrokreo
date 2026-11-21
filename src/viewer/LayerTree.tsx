import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { isComponentPart } from '../document/variants.ts'
import { isOpen, layerRows, toggleFolding } from '../document/layers.ts'
import type { NodeId, Scene, SceneNode } from '../document/types.ts'
import { LayerCaret, LayerIcon } from '../ui/LayerParts.tsx'
import { TYPE_LABELS } from '../ui/labels.ts'
import { nodeKind } from '../document/path.ts'
import { searchLayers } from './traverse.ts'

type Props = {
  scene: Scene
  selection: readonly NodeId[]
  /** additive は Shift を押しながら押したとき（選択に足す・外す） */
  onSelect: (id: NodeId, additive: boolean) => void
}

/** 行から呼ぶ操作。描き直しても同じ参照のままなので、変わっていない行は描き直さずに済む */
type RowActions = {
  select: (id: NodeId, additive: boolean) => void
  toggleOpen: (id: NodeId) => void
}

/** viewer のレイヤー一覧。選ぶだけで、並べ替えや名前の変更はできない */
export function LayerTree({ scene, selection, onSelect }: Props) {
  const [toggled, setToggled] = useState<ReadonlySet<NodeId>>(new Set())
  const [query, setQuery] = useState('')

  // 操作は、いつも最新の値を見る（行に渡す関数の参照は変えない）。値は描き終えたあとに入れ替える
  const latest = useRef({ onSelect, toggled })
  useLayoutEffect(() => {
    latest.current = { onSelect, toggled }
  })
  const actions = useMemo<RowActions>(
    () => ({
      select: (id, additive) => latest.current.onSelect(id, additive),
      toggleOpen: (id) => setToggled(toggleFolding(latest.current.toggled, id)),
    }),
    [],
  )

  // キャンバスで選んだものが、閉じたフレームの中に隠れたままにならないようにする
  const held = new Set<NodeId>()
  for (const selected of selection) {
    for (let id = scene.nodes[selected]?.parentId; id != null && !held.has(id); ) {
      held.add(id)
      id = scene.nodes[id].parentId
    }
  }
  const folding = { toggled, held }
  const selected = new Set(selection)

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
          <LayerTreeItem
            key={node.id}
            node={node}
            depth={depth}
            selected={selected.has(node.id)}
            component={isComponentPart(scene, node.id)}
            open={searching ? null : isOpen(node, folding)}
            actions={actions}
          />
        ))}
      </ul>
    </>
  )
}

type ItemProps = {
  node: SceneNode
  depth: number
  selected: boolean
  component: boolean
  /** 開閉の印の向き。探している間は null（印を出さない） */
  open: boolean | null
  actions: RowActions
}

/** 一覧の 1 行。ノードと表示が変わっていなければ描き直さない */
const LayerTreeItem = memo(function LayerTreeItem({ node, depth, selected, component, open, actions }: ItemProps) {
  return (
    <li
      className="layer-row inspect-layer"
      data-selected={selected}
      data-hidden={!node.visible}
      data-component={component}
      style={{ paddingLeft: 8 + depth * 14 }}
      title={TYPE_LABELS[nodeKind(node)]}
      onClick={(event) => actions.select(node.id, event.shiftKey)}
    >
      {open !== null && <LayerCaret node={node} open={open} onToggle={() => actions.toggleOpen(node.id)} />}
      <LayerIcon node={node} />
      <span className="layer-name">{node.name}</span>
    </li>
  )
})
