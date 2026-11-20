import { type DragEvent, type MouseEvent, useState } from 'react'
import type { NodeId, Scene, SceneNode } from '../document/types.ts'
import { isInstance, owningInstance } from './components.ts'
import { EyeIcon, LockIcon, TypeIcon } from './icons.tsx'
import { type Placement, placeNodes, updateNode } from './operations.ts'
import type { EditorState, EditorStore } from './store.ts'

type Props = {
  store: EditorStore
  state: EditorState
}

/** copy は、インスタンスの中身（元の写し）。表示の切り替えのほかは、一覧からは触れない */
type Row = { node: SceneNode; depth: number; copy: boolean }

/**
 * フレームの中身を一覧に出すか。ふつうのフレームは開いた状態、インスタンスは閉じた状態から始まり、
 * toggled に入っているものは、その逆になる。中身を選んでいるインスタンス（held）は、選んでいる間は開く。
 */
type Folding = { toggled: ReadonlySet<NodeId>; held: ReadonlySet<NodeId> }

function isOpen(node: SceneNode, { toggled, held }: Folding): boolean {
  return held.has(node.id) || isInstance(node) === toggled.has(node.id)
}

/**
 * 手前にあるものほど上に並べる。
 * 自動で並べるフレームの中だけは、キャンバスでの並び順（先頭が上）のまま出す。
 */
function buildRows(scene: Scene, folding: Folding): Row[] {
  const rows: Row[] = []
  function visit(ids: readonly NodeId[], depth: number, inLayout: boolean, copy: boolean) {
    for (const id of inLayout ? ids : ids.toReversed()) {
      const node = scene.nodes[id]
      rows.push({ node, depth, copy })
      if (node.type === 'frame' && isOpen(node, folding)) {
        visit(node.children, depth + 1, node.layout !== null, copy || isInstance(node))
      }
    }
  }
  visit(scene.rootIds, 0, false, false)
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
  const [toggled, setToggled] = useState<ReadonlySet<NodeId>>(new Set())
  const [renaming, setRenaming] = useState<NodeId | null>(null)
  const [drop, setDrop] = useState<{ id: NodeId; placement: Placement } | null>(null)

  function onRowClick(event: MouseEvent, id: NodeId) {
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      store.select(selection.includes(id) ? selection.filter((other) => other !== id) : [...selection, id])
    } else {
      store.select([id])
    }
  }

  function toggleOpen(id: NodeId) {
    const next = new Set(toggled)
    if (!next.delete(id)) next.add(id)
    setToggled(next)
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

  function onDragOver(event: DragEvent, { node, copy }: Row) {
    // ファイルなど、レイヤー以外のドラッグは受けない。インスタンスの中へも入れられない
    if (!event.dataTransfer.types.includes('text/plain') || copy) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientY - rect.top) / rect.height
    // フレームは中央に落とすと中へ入る
    const edge = node.type === 'frame' && !isInstance(node) ? 0.25 : 0.5
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
      // インスタンスの中身は、外へ出せない
      const movable = ids.filter((id) => !owningInstance(base, id))
      return placeNodes(base, movable, target.id, placement)
    })
    const frame = store.getState().page.nodes[target.id]
    if (target.placement === 'inside' && frame && !isOpen(frame, folding)) toggleOpen(target.id)
  }

  // キャンバスでインスタンスの中身を選んだとき、何を選んでいるのかが一覧でも分かるようにする
  const held = new Set(selection.flatMap((id) => owningInstance(page, id)?.id ?? []))
  const folding = { toggled, held }
  const rows = buildRows(page, folding)

  return (
    <section className="layers" aria-label="レイヤー">
      <h2 className="panel-title">レイヤー</h2>
      {rows.length === 0 && <p className="panel-hint">ツールを選んでキャンバスに図形を描くと、ここに並びます。</p>}
      <ul className="layer-list" onDragLeave={() => setDrop(null)}>
        {rows.map(({ node, depth, copy }) => (
          <li
            key={node.id}
            className="layer-row"
            data-selected={selection.includes(node.id)}
            data-hidden={!node.visible}
            data-copy={copy}
            data-drop={drop?.id === node.id ? drop.placement : undefined}
            style={{ paddingLeft: 8 + depth * 16 }}
            draggable={!copy && renaming !== node.id}
            onClick={(event) => onRowClick(event, node.id)}
            onDragStart={(event) => onDragStart(event, node.id)}
            onDragOver={(event) => onDragOver(event, { node, depth, copy })}
            onDrop={onDrop}
            onDragEnd={() => setDrop(null)}
          >
            {node.type === 'frame' && node.children.length > 0 ? (
              <button
                type="button"
                className="layer-caret"
                aria-label={isOpen(node, folding) ? '閉じる' : '開く'}
                onClick={(event) => {
                  event.stopPropagation()
                  toggleOpen(node.id)
                }}
              >
                {isOpen(node, folding) ? '▾' : '▸'}
              </button>
            ) : (
              <span className="layer-caret" />
            )}
            <span className="layer-icon">
              <TypeIcon type={node.type} role={node.type === 'frame' ? node.component?.role : undefined} />
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
              // 写しの名前は元と同じ。変えられない
              <span className="layer-name" onDoubleClick={() => !copy && setRenaming(node.id)}>
                {node.name}
              </span>
            )}
            {!copy && (
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
            )}
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
