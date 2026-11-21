import type { Camera } from '../canvas/camera.ts'
import { LayerIcon } from '../ui/LayerParts.tsx'
import { variantSetOf, variantsIn } from '../document/variants.ts'
import { listComponents } from './components.ts'
import { COMPONENT_DRAG_TYPE, placeInstance } from './placeInstance.ts'
import type { EditorState, EditorStore } from './store.ts'

type Props = {
  store: EditorStore
  state: EditorState
  camera: Camera
}

/**
 * ドキュメントにあるコンポーネントの元の一覧。どのページにいても、ここからインスタンスを置ける。
 * 行を押すと画面の中央に、キャンバスへドラッグするとその位置に置く。
 */
export function ComponentsPanel({ store, state, camera }: Props) {
  // バリアントは、まとまりごとに 1 行にまとめる（置くのは最初のバリアント、元を表示はまとまりを選ぶ）
  const seen = new Set<string>()
  const components = listComponents(state.document).flatMap(({ page, node }) => {
    const set = variantSetOf(page, node.id)
    if (!set) return [{ page, node, name: node.name, shownId: node.id, count: 0 }]
    const key = `${page.id}:${set.id}`
    if (seen.has(key)) return []
    seen.add(key)
    const variants = variantsIn(page, set.id)
    return [{ page, node: variants[0], name: set.name, shownId: set.id, count: variants.length }]
  })

  /** 元のあるページへ移って、元を選ぶ */
  function showMain(pageId: string, nodeId: string) {
    store.setPage(pageId)
    store.select([nodeId])
  }

  return (
    <section className="components" aria-label="コンポーネント">
      <h2 className="panel-title">コンポーネント</h2>
      {components.length === 0 ? (
        <p className="panel-hint">フレームを選んで「コンポーネントにする」と、ここに並びます。</p>
      ) : (
        <ul className="component-list">
          {components.map(({ page, node, name, shownId, count }) => (
            <li
              key={node.component.id}
              className="component-row"
              draggable
              title="押すと画面の中央に、キャンバスへドラッグするとその位置に、インスタンスを置きます"
              onClick={() => placeInstance(store, camera, node.component.id)}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'copy'
                event.dataTransfer.setData(COMPONENT_DRAG_TYPE, node.component.id)
              }}
            >
              <LayerIcon node={node} />
              <span className="component-name">{name}</span>
              {count > 0 && <span className="component-page">{count} 種類</span>}
              {page.id !== state.page.id && <span className="component-page">{page.name}</span>}
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
          ))}
        </ul>
      )}
    </section>
  )
}
