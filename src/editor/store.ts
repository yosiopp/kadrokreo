import type { DesignDocument, NodeId, Page, PageId } from '../document/types.ts'
import { createHistory, pushHistory, redoHistory, undoHistory } from './history.ts'
import { updatePage } from './operations.ts'

export type EditorState = {
  document: DesignDocument
  /** 表示・編集しているページ */
  page: Page
  /** page の中で選択しているノード */
  selection: NodeId[]
  canUndo: boolean
  canRedo: boolean
}

type DocumentRecipe = (doc: DesignDocument) => DesignDocument
type PageRecipe = (page: Page) => Page

export type EditorStore = ReturnType<typeof createEditorStore>

export function createEditorStore(initial: DesignDocument) {
  let history = createHistory(initial)
  // ドラッグ中などの未確定の変更。履歴には commitPreview で 1 件としてまとめて積む
  let preview: DesignDocument | null = null
  let pageId = initial.pages[0].id
  let selection: NodeId[] = []
  let state = snapshot()
  const listeners = new Set<() => void>()

  function snapshot(): EditorState {
    const document = preview ?? history.present
    // 表示していたページが（Undo などで）なくなったら、先頭のページへ移る
    const page = document.pages.find((candidate) => candidate.id === pageId) ?? document.pages[0]
    if (page.id !== pageId) {
      pageId = page.id
      selection = []
    }
    const alive = selection.filter((id) => Object.hasOwn(page.nodes, id))
    if (alive.length !== selection.length) selection = alive
    return {
      document,
      page,
      selection,
      canUndo: history.past.length > 0,
      canRedo: history.future.length > 0,
    }
  }

  function emit() {
    state = snapshot()
    for (const listener of listeners) listener()
  }

  function commitPreview() {
    if (preview === null) return
    history = pushHistory(history, preview)
    preview = null
    emit()
  }

  function cancelPreview() {
    if (preview === null) return
    preview = null
    emit()
  }

  function applyDocument(recipe: DocumentRecipe) {
    commitPreview()
    const before = history
    history = pushHistory(history, recipe(history.present))
    if (history !== before) emit()
  }

  function previewDocument(recipe: DocumentRecipe) {
    const next = recipe(history.present)
    if (next === (preview ?? history.present)) return
    preview = next
    emit()
  }

  /**
   * Undo / Redo で変わったのが別のページなら、そのページを表示する。
   * そうしないと、何が戻ったのか見えない。
   */
  function followChange(from: DesignDocument, to: DesignDocument) {
    const find = (doc: DesignDocument) => doc.pages.find((page) => page.id === pageId)
    if (find(from) !== find(to)) return
    const changed = to.pages.find((page) => !from.pages.includes(page))
    if (changed) {
      pageId = changed.id
      selection = []
    }
  }

  function travel(step: typeof undoHistory) {
    cancelPreview()
    const before = history.present
    history = step(history)
    if (history.present === before) return
    followChange(before, history.present)
    emit()
  }

  return {
    getState: () => state,

    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    /** いまのページへの変更を確定し、Undo 1 回分として履歴に積む */
    apply(recipe: PageRecipe) {
      applyDocument((doc) => updatePage(doc, pageId, recipe))
    },

    /**
     * 履歴に積まずに、いまのページへの変更を見せる。recipe には毎回プレビュー開始前のページが渡るので、
     * ドラッグなら「開始位置 + 累積移動量」で書ける。
     */
    preview(recipe: PageRecipe) {
      previewDocument((doc) => updatePage(doc, pageId, recipe))
    },

    /** ページの追加や名前の変更など、ドキュメント全体に対する変更 */
    applyDocument,
    previewDocument,
    commitPreview,
    cancelPreview,

    undo: () => travel(undoHistory),
    redo: () => travel(redoHistory),

    select(ids: readonly NodeId[]) {
      selection = [...ids]
      emit()
    },

    /** 表示するページを切り替える。選択は解除する */
    setPage(id: PageId) {
      if (id === pageId) return
      commitPreview()
      pageId = id
      selection = []
      emit()
    },

    /** 別のドキュメントに差し替える。履歴と選択は捨てる */
    load(document: DesignDocument) {
      history = createHistory(document)
      preview = null
      pageId = document.pages[0].id
      selection = []
      emit()
    },
  }
}
