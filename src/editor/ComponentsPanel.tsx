import { type ReactNode, useState } from 'react'
import type { Camera } from '../canvas/camera.ts'
import { LayerIcon } from '../ui/LayerParts.tsx'
import { type ComponentEntry, type ComponentSort, componentEntries } from './componentList.ts'
import { COMPONENT_DRAG_TYPE, placeInstance, setDraggedComponent } from './placeInstance.ts'
import type { EditorState, EditorStore } from './store.ts'

type Props = {
  store: EditorStore
  state: EditorState
  camera: Camera
}

const SORT_LABELS: Record<ComponentSort, string> = {
  document: 'ページ順',
  name: '名前順',
}

/**
 * ドキュメントにあるコンポーネントの元の一覧。どのページにいても、ここからインスタンスを置ける。
 * 行を押すと画面の中央に、キャンバスへドラッグするとその位置に置く。
 * バリアントのまとまりは 1 行で、開くとバリアントを 1 つずつ選んで置ける。
 */
export function ComponentsPanel({ store, state, camera }: Props) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<ComponentSort>('document')
  // 開いているまとまり（ページの id とまとまりの id）
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const entries = componentEntries(state.document, query, sort)
  const searching = query.trim() !== ''

  /** 元のあるページへ移って、元を選ぶ */
  function showMain(pageId: string, nodeId: string) {
    store.setPage(pageId)
    store.select([nodeId])
  }

  function toggle(key: string) {
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }

  /** インスタンスを置ける行（まとまりの行も、バリアントの行も） */
  function row(entry: ComponentEntry, depth: number, extra?: ReactNode) {
    const { page, node, name, shownId } = entry
    return (
      <li
        key={`${depth}:${node.component.id}`}
        className="component-row"
        data-depth={depth}
        draggable
        title="押すと画面の中央に、キャンバスへドラッグするとその位置に、インスタンスを置きます"
        onClick={() => placeInstance(store, camera, node.component.id)}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'copy'
          event.dataTransfer.setData(COMPONENT_DRAG_TYPE, node.component.id)
          setDraggedComponent(node.component.id)
        }}
        onDragEnd={() => setDraggedComponent(null)}
      >
        {extra}
        <LayerIcon node={node} />
        <span className="component-name">{name}</span>
        {depth === 0 && entry.variants.length > 0 && (
          <span className="component-page">{entry.variants.length} 種類</span>
        )}
        {depth === 0 && page.id !== state.page.id && <span className="component-page">{page.name}</span>}
        <button
          type="button"
          className="row-action"
          title="元を表示"
          aria-label={`${name} の元を表示`}
          onClick={(event) => {
            event.stopPropagation()
            showMain(page.id, shownId)
          }}
        >
          →
        </button>
      </li>
    )
  }

  const total = componentEntries(state.document, '', sort).length

  return (
    <section className="components" aria-label="コンポーネント">
      <h2 className="panel-title">コンポーネント</h2>
      {total === 0 ? (
        <p className="panel-hint">フレームを選んで「コンポーネントにする」と、ここに並びます。</p>
      ) : (
        <>
          <div className="component-tools">
            <input
              type="search"
              className="component-search"
              placeholder="検索"
              aria-label="コンポーネントを検索"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setQuery('')
                  event.currentTarget.blur()
                }
              }}
            />
            <select
              aria-label="コンポーネントの並べ方"
              value={sort}
              onChange={(event) => {
                setSort(event.target.value as ComponentSort)
                // フォーカスを残すとキーボードショートカットが効かなくなる
                event.target.blur()
              }}
            >
              {Object.entries(SORT_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {entries.length === 0 ? (
            <p className="panel-hint">「{query.trim()}」に当てはまるコンポーネントはありません。</p>
          ) : (
            <ul className="component-list">
              {entries.flatMap((entry) => {
                if (entry.variants.length === 0) return [row(entry, 0)]
                const key = `${entry.page.id}:${entry.shownId}`
                // 検索しているときは、当てはまるバリアントを開いて見せる
                const expanded = searching || open.has(key)
                const toggleButton = (
                  <button
                    type="button"
                    className="component-toggle"
                    aria-expanded={expanded}
                    aria-label={`${entry.name} のバリアントを${expanded ? '閉じる' : '開く'}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      toggle(key)
                    }}
                  >
                    {expanded ? '▾' : '▸'}
                  </button>
                )
                return [
                  row(entry, 0, toggleButton),
                  ...(expanded ? entry.variants.map((variant) => row(variant, 1)) : []),
                ]
              })}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
