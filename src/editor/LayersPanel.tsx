import { type DragEvent, type MouseEvent, useState } from 'react'
import type { NodeId, Scene, SceneNode } from '../document/types.ts'
import { EyeIcon, LockIcon, TypeIcon } from './icons.tsx'
import { type Placement, placeNodes, updateNode } from './operations.ts'
import type { EditorState, EditorStore } from './store.ts'

type Props = {
  store: EditorStore
  state: EditorState
}

type Row = { node: SceneNode; depth: number }

/**
 * 手前にあるものほど上に並べる。
 * 自動で並べるフレームの中だけは、キャンバスでの並び順（先頭が上）のまま出す。
 */
function buildRows(scene: Scene, collapsed: ReadonlySet<NodeId>): Row[] {
  const rows: Row[] = []
  function visit(ids: readonly NodeId[], depth: number, inLayout: boolean) {
    for (const id of inLayout ? ids : ids.toReversed()) {
      const node = scene.nodes[id]
      rows.push({ node, depth })
      if (node.type === 'frame' && !collapsed.has(id)) {
        visit(node.children, depth + 1, node.layout !== null)
      }
    }
  }
  visit(scene.rootIds, 0, false)
  return rows
}

/** 自動で並べるフレームの子か。一覧での上下が、重なり順と逆になる */
function isInLayout(scene: Scene, id: NodeId): boolean {
  const parentId = scene.nodes[id]?.parentId
  const parent = parentId == null ? null : scene.nodes[parentId]
  return parent?.type === 'frame' && parent.layout !== null
}

export function LayersPanel({ store, state }: Props) {
  const { page, selection } = state
  const [collapsed, setCollapsed] = useState<ReadonlySet<NodeId>>(new Set())
  const [renaming, setRenaming] = useState<NodeId | null>(null)
  const [drop, setDrop] = useState<{ id: NodeId; placement: Placement } | null>(null)

  function onRowClick(event: MouseEvent, id: NodeId) {
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      store.select(selection.includes(id) ? selection.filter((other) => other !== id) : [...selection, id])
    } else {
      store.select([id])
    }
  }

  function toggleCollapsed(id: NodeId) {
    const next = new Set(collapsed)
    if (!next.delete(id)) next.add(id)
    setCollapsed(next)
  }

  function commitRename(id: NodeId, name: string) {
    setRenaming(null)
    if (name.trim() !== '') store.apply((base) => updateNode(base, id, { name: name.trim() }))
  }

  function onDragStart(event: DragEvent, id: NodeId) {
    if (!selection.includes(id)) store.select([id])
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', id)
  }

  function onDragOver(event: DragEvent, node: SceneNode) {
    // ファイルなど、レイヤー以外のドラッグは受けない
    if (!event.dataTransfer.types.includes('text/plain')) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientY - rect.top) / rect.height
    // フレームは中央に落とすと中へ入る
    const edge = node.type === 'frame' ? 0.25 : 0.5
    const placement = ratio < edge ? 'above' : ratio >= 1 - edge ? 'below' : 'inside'
    if (drop?.id !== node.id || drop.placement !== placement) setDrop({ id: node.id, placement })
  }

  function onDrop(event: DragEvent) {
    event.preventDefault()
    const target = drop
    setDrop(null)
    if (!target) return
    const ids = store.getState().selection
    store.apply((base) => {
      // drop.placement は一覧での見た目の位置。自動で並べるフレームの中では、一覧で上にあるほど先頭（奥）になる
      const flipped = target.placement !== 'inside' && isInLayout(base, target.id)
      const placement = !flipped ? target.placement : target.placement === 'above' ? 'below' : 'above'
      return placeNodes(base, ids, target.id, placement)
    })
    if (target.placement === 'inside' && collapsed.has(target.id)) toggleCollapsed(target.id)
  }

  const rows = buildRows(page, collapsed)

  return (
    <section className="layers" aria-label="レイヤー">
      <h2 className="panel-title">レイヤー</h2>
      {rows.length === 0 && <p className="panel-hint">ツールを選んでキャンバスに図形を描くと、ここに並びます。</p>}
      <ul className="layer-list" onDragLeave={() => setDrop(null)}>
        {rows.map(({ node, depth }) => (
          <li
            key={node.id}
            className="layer-row"
            data-selected={selection.includes(node.id)}
            data-hidden={!node.visible}
            data-drop={drop?.id === node.id ? drop.placement : undefined}
            style={{ paddingLeft: 8 + depth * 16 }}
            draggable={renaming !== node.id}
            onClick={(event) => onRowClick(event, node.id)}
            onDragStart={(event) => onDragStart(event, node.id)}
            onDragOver={(event) => onDragOver(event, node)}
            onDrop={onDrop}
            onDragEnd={() => setDrop(null)}
          >
            {node.type === 'frame' && node.children.length > 0 ? (
              <button
                type="button"
                className="layer-caret"
                aria-label={collapsed.has(node.id) ? '開く' : '閉じる'}
                onClick={(event) => {
                  event.stopPropagation()
                  toggleCollapsed(node.id)
                }}
              >
                {collapsed.has(node.id) ? '▸' : '▾'}
              </button>
            ) : (
              <span className="layer-caret" />
            )}
            <span className="layer-icon">
              <TypeIcon type={node.type} />
            </span>
            {renaming === node.id ? (
              <input
                className="layer-name-input"
                defaultValue={node.name}
                autoFocus
                onFocus={(event) => event.target.select()}
                onClick={(event) => event.stopPropagation()}
                onBlur={(event) => commitRename(node.id, event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return
                  if (event.key === 'Enter') event.currentTarget.blur()
                  if (event.key === 'Escape') {
                    // 元の名前に戻してから確定すれば、何も変わらない
                    event.currentTarget.value = node.name
                    event.currentTarget.blur()
                  }
                }}
              />
            ) : (
              <span className="layer-name" onDoubleClick={() => setRenaming(node.id)}>
                {node.name}
              </span>
            )}
            <button
              type="button"
              className="layer-toggle"
              data-active={node.locked}
              title={node.locked ? 'ロックを解除' : 'ロック'}
              aria-label={node.locked ? 'ロックを解除' : 'ロック'}
              onClick={(event) => {
                event.stopPropagation()
                store.apply((base) => updateNode(base, node.id, { locked: !node.locked }))
              }}
            >
              <LockIcon open={!node.locked} />
            </button>
            <button
              type="button"
              className="layer-toggle"
              data-active={!node.visible}
              title={node.visible ? '非表示にする' : '表示する'}
              aria-label={node.visible ? '非表示にする' : '表示する'}
              onClick={(event) => {
                event.stopPropagation()
                store.apply((base) => updateNode(base, node.id, { visible: !node.visible }))
              }}
            >
              <EyeIcon off={!node.visible} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
