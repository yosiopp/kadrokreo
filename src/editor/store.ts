import type { DesignDocument, NodeId } from '../document/types.ts'
import { createHistory, pushHistory, redoHistory, undoHistory } from './history.ts'

export type EditorState = {
  document: DesignDocument
  selection: NodeId[]
  canUndo: boolean
  canRedo: boolean
}

type Recipe = (doc: DesignDocument) => DesignDocument

export type EditorStore = ReturnType<typeof createEditorStore>

export function createEditorStore(initial: DesignDocument) {
  let history = createHistory(initial)
  // ドラッグ中などの未確定の変更。履歴には commitPreview で 1 件としてまとめて積む
  let preview: DesignDocument | null = null
  let selection: NodeId[] = []
  let state = snapshot()
  const listeners = new Set<() => void>()

  function snapshot(): EditorState {
    const document = preview ?? history.present
    const alive = selection.filter((id) => Object.hasOwn(document.nodes, id))
    if (alive.length !== selection.length) selection = alive
    return {
      document,
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

  return {
    getState: () => state,

    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    /** 変更を確定し、Undo 1 回分として履歴に積む */
    apply(recipe: Recipe) {
      commitPreview()
      const before = history
      history = pushHistory(history, recipe(history.present))
      if (history !== before) emit()
    },

    /**
     * 履歴に積まずに変更を見せる。recipe には毎回プレビュー開始前のドキュメントが渡るので、
     * ドラッグなら「開始位置 + 累積移動量」で書ける。
     */
    preview(recipe: Recipe) {
      const next = recipe(history.present)
      if (next === (preview ?? history.present)) return
      preview = next
      emit()
    },

    commitPreview,
    cancelPreview,

    undo() {
      cancelPreview()
      const before = history
      history = undoHistory(history)
      if (history !== before) emit()
    },

    redo() {
      cancelPreview()
      const before = history
      history = redoHistory(history)
      if (history !== before) emit()
    },

    select(ids: readonly NodeId[]) {
      selection = [...ids]
      emit()
    },

    /** 別のドキュメントに差し替える。履歴と選択は捨てる */
    load(document: DesignDocument) {
      history = createHistory(document)
      preview = null
      selection = []
      emit()
    },
  }
}
