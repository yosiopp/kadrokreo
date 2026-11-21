import { type DragEvent, useState } from 'react'
import type { PageId } from '../document/types.ts'
import { RenameInput } from './RenameInput.tsx'
import { DuplicateIcon, TrashIcon } from './icons.tsx'
import {
  addPage,
  createPage,
  duplicatePage,
  movePage,
  removePage,
  renamePage,
} from './operations.ts'
import type { EditorState, EditorStore } from './store.ts'

type Props = {
  store: EditorStore
  state: EditorState
}

/** ページのドラッグを、レイヤーやファイルのドラッグと区別するための種類 */
const DRAG_TYPE = 'application/x-kadrokreo-page'

export function PagesPanel({ store, state }: Props) {
  const { pages } = state.document
  const [renaming, setRenaming] = useState<PageId | null>(null)
  const [drop, setDrop] = useState<{ id: PageId; after: boolean } | null>(null)

  function add() {
    const page = createPage(`Page ${pages.length + 1}`)
    store.applyDocument((doc) => addPage(doc, page))
    store.setPage(page.id)
  }

  function duplicate(id: PageId) {
    let copyId: PageId | null = null
    store.applyDocument((doc) => {
      const result = duplicatePage(doc, id)
      copyId = result?.pageId ?? null
      return result?.document ?? doc
    })
    if (copyId) store.setPage(copyId)
  }

  function commitRename(id: PageId, name: string) {
    setRenaming(null)
    if (name.trim() !== '') store.applyDocument((doc) => renamePage(doc, id, name.trim()))
  }

  function onDragOver(event: DragEvent, id: PageId) {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const after = event.clientY > rect.top + rect.height / 2
    if (drop?.id !== id || drop.after !== after) setDrop({ id, after })
  }

  function onDrop(event: DragEvent) {
    const dragged = event.dataTransfer.getData(DRAG_TYPE)
    const target = drop
    setDrop(null)
    if (!dragged || !target || dragged === target.id) return
    event.preventDefault()
    store.applyDocument((doc) => {
      // movePage の index は、動かすページを取り除いた後の並びで数える
      const others = doc.pages.filter((page) => page.id !== dragged)
      const index = others.findIndex((page) => page.id === target.id) + (target.after ? 1 : 0)
      return movePage(doc, dragged, index)
    })
  }

  return (
    <section className="pages" aria-label="ページ">
      <h2 className="panel-title">
        ページ
        <button type="button" className="panel-action" title="ページを追加" aria-label="ページを追加" onClick={add}>
          +
        </button>
      </h2>
      <ul className="page-list" onDragLeave={() => setDrop(null)}>
        {pages.map((page) => (
          <li
            key={page.id}
            className="page-row"
            data-selected={page.id === state.page.id}
            data-drop={drop?.id === page.id ? (drop.after ? 'below' : 'above') : undefined}
            draggable={renaming !== page.id}
            onClick={() => store.setPage(page.id)}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData(DRAG_TYPE, page.id)
            }}
            onDragOver={(event) => onDragOver(event, page.id)}
            onDrop={onDrop}
            onDragEnd={() => setDrop(null)}
          >
            {renaming === page.id ? (
              <RenameInput name={page.name} onCommit={(name) => commitRename(page.id, name)} />
            ) : (
              <span className="page-name" onDoubleClick={() => setRenaming(page.id)}>
                {page.name}
              </span>
            )}
            <button
              type="button"
              className="row-action"
              title="ページを複製"
              aria-label={`${page.name} を複製`}
              onClick={(event) => {
                event.stopPropagation()
                duplicate(page.id)
              }}
            >
              <DuplicateIcon />
            </button>
            <button
              type="button"
              className="row-action"
              title="ページを削除"
              aria-label={`${page.name} を削除`}
              // 最後の 1 ページは消せない
              disabled={pages.length <= 1}
              onClick={(event) => {
                event.stopPropagation()
                store.applyDocument((doc) => removePage(doc, page.id))
              }}
            >
              <TrashIcon />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
