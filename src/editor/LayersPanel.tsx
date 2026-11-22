import { type DragEvent, type MouseEvent, memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { isInstance, owningInstance } from '../document/component.ts'
import { isComponentPart } from '../document/variants.ts'
import { isOpen, layerRows, toggleFolding } from '../document/layers.ts'
import type { NodeId, Scene, SceneNode } from '../document/types.ts'
import { LayerCaret, LayerIcon } from '../ui/LayerParts.tsx'
import { useVirtualRows } from '../ui/virtualRows.ts'
import { RenameInput } from './RenameInput.tsx'
import { withoutCopies } from './components.ts'
import { EyeIcon, LockIcon } from './icons.tsx'
import { type Placement, placeNodes } from './operations/arrange.ts'
import { updateNode } from './operations/tree.ts'
import type { EditorState, EditorStore } from './store.ts'

type Props = {
  store: EditorStore
  state: EditorState
}

type Drop = { id: NodeId; placement: Placement }

/** 自動で並べるフレームの子か。一覧での上下が、重なり順と逆になる */
function isInLayout(scene: Scene, id: NodeId): boolean {
  const parentId = scene.nodes[id]?.parentId
  const parent = parentId == null ? null : scene.nodes[parentId]
  return parent?.type === 'frame' && parent.layout !== null
}

/** 行から呼ぶ操作。描き直しても同じ参照のままなので、変わっていない行は描き直さずに済む */
type RowActions = {
  click: (event: MouseEvent, id: NodeId) => void
  toggleOpen: (id: NodeId) => void
  startRename: (id: NodeId) => void
  commitRename: (id: NodeId, name: string) => void
  dragStart: (event: DragEvent, id: NodeId) => void
  dragOver: (event: DragEvent, node: SceneNode, copy: boolean) => void
  drop: (event: DragEvent) => void
  clearDrop: () => void
  toggleLocked: (node: SceneNode) => void
  toggleVisible: (node: SceneNode) => void
}

export function LayersPanel({ store, state }: Props) {
  const { page, selection } = state
  const [toggled, setToggled] = useState<ReadonlySet<NodeId>>(new Set())
  const [renaming, setRenaming] = useState<NodeId | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)

  // キャンバスでインスタンスの中身を選んだとき、何を選んでいるのかが一覧でも分かるようにする
  const held = new Set(selection.flatMap((id) => owningInstance(page, id)?.id ?? []))
  const folding = { toggled, held }

  // 写し（インスタンスの中身）は、表示の切り替えのほかは、一覧からは触れない
  const rows = layerRows(page, folding)
  const selected = new Set(selection)
  // 行は見えている分だけ作る（数千行あっても、開いたときに全部を作らない）
  const listRef = useRef<HTMLUListElement>(null)
  const visible = useVirtualRows(listRef, rows.length)

  // Shift で範囲を選ぶときの起点。最後に Shift なしで押した行と、押した直後の選択。
  // 選択がほか（キャンバスなど）で変わったら、起点は選択の最後のものにする
  const anchorRef = useRef<{ id: NodeId; selection: readonly NodeId[] } | null>(null)

  // 操作は、いつも最新の値を見る（行に渡す関数の参照は変えない）。値は描き終えたあとに入れ替える
  const latest = useRef({ store, selection, toggled, drop, folding, rows })
  useLayoutEffect(() => {
    latest.current = { store, selection, toggled, drop, folding, rows }
  })

  const actions = useMemo<RowActions>(() => {
    const now = () => latest.current
    const toggleOpen = (id: NodeId) => setToggled(toggleFolding(now().toggled, id))
    return {
      click(event, id) {
        const { store, rows } = now()
        const selection = store.getState().selection
        const setAnchor = () => {
          anchorRef.current = { id, selection: store.getState().selection }
        }
        if (event.metaKey || event.ctrlKey) {
          // Cmd / Ctrl で 1 行ずつ足す・外す。外した行も、次の Shift の起点になる
          store.select(selection.includes(id) ? selection.filter((other) => other !== id) : [...selection, id])
          setAnchor()
        } else if (event.shiftKey) {
          // Shift で、起点の行から押した行までを選ぶ（見えている行の並びで。写しの行は、押した行のほかは飛ばす）
          const anchor = anchorRef.current?.selection === selection ? anchorRef.current.id : selection.at(-1)
          const from = rows.findIndex((row) => row.node.id === anchor)
          const to = rows.findIndex((row) => row.node.id === id)
          if (from === -1 || to === -1) {
            store.select([...selection.filter((other) => other !== id), id])
            setAnchor()
            return
          }
          const range = rows.slice(Math.min(from, to), Math.max(from, to) + 1)
          store.select(range.filter((row) => !row.copy || row.node.id === id).map((row) => row.node.id))
          // 続けて Shift で押したときも、同じ起点から選び直す
          anchorRef.current = { id: rows[from].node.id, selection: store.getState().selection }
        } else {
          store.select([id])
          setAnchor()
        }
      },
      toggleOpen,
      startRename: (id) => setRenaming(id),
      commitRename(id, name) {
        setRenaming(null)
        if (name.trim() !== '') now().store.apply((base) => updateNode(base, id, { name: name.trim() }))
      },
      dragStart(event, id) {
        const { store, selection } = now()
        if (!selection.includes(id)) store.select([id])
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', id)
      },
      dragOver(event, node, copy) {
        // ファイルなど、レイヤー以外のドラッグは受けない。インスタンスの中へも入れられない
        if (!event.dataTransfer.types.includes('text/plain') || copy) return
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        const ratio = (event.clientY - rect.top) / rect.height
        // フレームは中央に落とすと中へ入る
        const edge = node.type === 'frame' && !isInstance(node) ? 0.25 : 0.5
        const placement = ratio < edge ? 'above' : ratio >= 1 - edge ? 'below' : 'inside'
        const { drop } = now()
        if (drop?.id !== node.id || drop.placement !== placement) setDrop({ id: node.id, placement })
      },
      drop(event) {
        event.preventDefault()
        const { store, drop: target, folding } = now()
        setDrop(null)
        if (!target) return
        const ids = store.getState().selection
        store.apply((base) => {
          // drop.placement は一覧での見た目の位置。自動で並べるフレームの中では、一覧で上にあるほど先頭（奥）になる
          const flipped = target.placement !== 'inside' && isInLayout(base, target.id)
          const placement = !flipped ? target.placement : target.placement === 'above' ? 'below' : 'above'
          // インスタンスの中身は、外へ出せない
          return placeNodes(base, withoutCopies(base, ids), target.id, placement)
        })
        const frame = store.getState().page.nodes[target.id]
        if (target.placement === 'inside' && frame && !isOpen(frame, folding)) toggleOpen(target.id)
      },
      clearDrop: () => setDrop(null),
      toggleLocked: (node) => now().store.apply((base) => updateNode(base, node.id, { locked: !node.locked })),
      toggleVisible: (node) => now().store.apply((base) => updateNode(base, node.id, { visible: !node.visible })),
    }
  }, [])

  return (
    <section className="layers" aria-label="レイヤー">
      <h2 className="panel-title">レイヤー</h2>
      {rows.length === 0 && <p className="panel-hint">ツールを選んでキャンバスに図形を描くと、ここに並びます。</p>}
      <ul
        ref={listRef}
        className="layer-list"
        style={{ paddingTop: visible.before, paddingBottom: `calc(12px + ${visible.after}px)` }}
        onDragLeave={actions.clearDrop}
      >
        {rows.slice(visible.start, visible.end).map(({ node, depth, copy }) => (
          <LayerItem
            key={node.id}
            node={node}
            depth={depth}
            copy={copy}
            selected={selected.has(node.id)}
            open={isOpen(node, folding)}
            component={isComponentPart(page, node.id)}
            drop={drop?.id === node.id ? drop.placement : undefined}
            renaming={renaming === node.id}
            actions={actions}
          />
        ))}
      </ul>
    </section>
  )
}

type ItemProps = {
  node: SceneNode
  depth: number
  copy: boolean
  selected: boolean
  open: boolean
  component: boolean
  drop: Placement | undefined
  renaming: boolean
  actions: RowActions
}

/** 一覧の 1 行。ノードと表示が変わっていなければ描き直さない（行が数千あっても、ドラッグ 1 歩で全部を描き直さない） */
const LayerItem = memo(function LayerItem({ node, depth, copy, selected, open, component, drop, renaming, actions }: ItemProps) {
  return (
    <li
      className="layer-row"
      data-selected={selected}
      data-hidden={!node.visible}
      data-copy={copy}
      data-component={component}
      data-drop={drop}
      style={{ paddingLeft: 8 + depth * 16 }}
      draggable={!copy && !renaming}
      onClick={(event) => actions.click(event, node.id)}
      onDragStart={(event) => actions.dragStart(event, node.id)}
      onDragOver={(event) => actions.dragOver(event, node, copy)}
      onDrop={actions.drop}
      onDragEnd={actions.clearDrop}
    >
      <LayerCaret node={node} open={open} onToggle={() => actions.toggleOpen(node.id)} />
      <LayerIcon node={node} />
      {renaming ? (
        <RenameInput name={node.name} onCommit={(name) => actions.commitRename(node.id, name)} />
      ) : (
        // 写しの名前は元と同じ。変えられない
        <span className="layer-name" onDoubleClick={() => !copy && actions.startRename(node.id)}>
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
            actions.toggleLocked(node)
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
          actions.toggleVisible(node)
        }}
      >
        <EyeIcon off={!node.visible} />
      </button>
    </li>
  )
})
