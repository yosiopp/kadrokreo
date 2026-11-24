import { findPage } from '../document/pages.ts'
import type { DesignDocument, NodeId, Page, PageId } from '../document/types.ts'
import { createHistory, pushHistory, redoHistory, undoHistory } from './history.ts'
import { type FitText, captureOverrides, syncComponents } from './components.ts'
import { applyConstraints } from './constraints.ts'
import { relayout } from './layout.ts'
import { fitMovedVariants } from './variants.ts'
import { updatePage } from './operations/document.ts'
import { fitBooleanNodes } from './operations/booleanNodes.ts'
import { type GradientEdit, editedGradient } from './editorCanvas/gradientHandles.ts'
import { pathContours } from '../document/path.ts'
import { deferSlowBooleans, takeDeferredBooleans } from '../document/booleanNode.ts'
import { contourSegment, flatVertices } from './pathEdit.ts'

export type EditorState = {
  document: DesignDocument
  /** 表示・編集しているページ */
  page: Page
  /** page の中で選択しているノード */
  selection: NodeId[]
  canUndo: boolean
  canRedo: boolean
  /** 頂点を編集中のパスと、選んでいる頂点・辺。そのパスだけを選んでいる間だけ有効（選択が変わると null に戻る） */
  vertexEdit: VertexEdit | null
  /** キャンバスで動かしているグラデーション。そのノードだけを選んでいて、その塗りがグラデーションの間だけ有効 */
  gradientEdit: GradientEdit | null
}

/**
 * パスの頂点の編集。vertices は選んでいる頂点の番号（昇順）、segment は選んでいる辺
 * （その番号の頂点から次の頂点への辺。頂点と辺は同時には選ばない）
 */
export type VertexEdit = { id: NodeId; vertices: number[]; segment: number | null }

type DocumentRecipe = (doc: DesignDocument) => DesignDocument
type PageRecipe = (page: Page) => Page

export type EditorStore = ReturnType<typeof createEditorStore>

/** fitText は、文言を上書きしたインスタンスのテキストの大きさを測り直すのに使う（ブラウザでだけ渡せる） */
export function createEditorStore(initial: DesignDocument, fitText?: FitText) {
  let history = createHistory(initial)
  // ドラッグ中などの未確定の変更。履歴には commitPreview で 1 件としてまとめて積む
  let preview: DesignDocument | null = null
  // 今のプレビューを作った変更。重いブーリアン演算をドラッグ中に後回しにしたら、確定するときにこれでもう一度後始末する
  let previewRecipe: DocumentRecipe | null = null
  let pageId = initial.pages[0].id
  let selection: NodeId[] = []
  let vertexEdit: VertexEdit | null = null
  let gradientEdit: GradientEdit | null = null
  let state = snapshot()
  /**
   * 後始末（settle）を終えて落ち着いたページ。演算のノードの枠は結果に合い、自動で並べるフレームは並べ直しても変わらない。
   * ここからの変更なら、枠合わせと並べ直しは変わったノードのまわりだけを見ればよい（読み込んだばかりのページは、checkSettled で落ち着いていると確かめてから入れる）
   */
  const settledPages = new WeakSet<Page>()
  /** checkSettled で確かめたドキュメント */
  const checkedDocs = new WeakSet<DesignDocument>()
  const listeners = new Set<() => void>()

  function snapshot(): EditorState {
    const document = preview ?? history.present
    // 表示していたページが（Undo などで）なくなったら、先頭のページへ移る
    const page = findPage(document, pageId) ?? document.pages[0]
    if (page.id !== pageId) {
      pageId = page.id
      selection = []
    }
    const alive = selection.filter((id) => Object.hasOwn(page.nodes, id))
    if (alive.length !== selection.length) selection = alive
    vertexEdit = checkVertexEdit(page, vertexEdit)
    gradientEdit = checkGradientEdit(page, gradientEdit)
    return {
      document,
      page,
      selection,
      canUndo: history.past.length > 0,
      canRedo: history.future.length > 0,
      vertexEdit,
      gradientEdit,
    }
  }

  /** グラデーションの編集が今のページと選択に合っているか確かめ、合わなければ null、なくなった色は選ばない */
  function checkGradientEdit(page: Page, edit: GradientEdit | null): GradientEdit | null {
    if (!edit || selection.length !== 1 || selection[0] !== edit.id) return null
    const gradient = editedGradient(page, edit)
    if (!gradient) return null
    return edit.stop !== null && edit.stop >= gradient.stops.length ? { ...edit, stop: null } : edit
  }

  /** 頂点の編集が今のページと選択に合っているか確かめ、合わなければ null、なくなった頂点・辺は外す */
  function checkVertexEdit(page: Page, edit: VertexEdit | null): VertexEdit | null {
    if (!edit) return null
    const node = page.nodes[edit.id]
    if (node?.type !== 'path' || selection.length !== 1 || selection[0] !== edit.id) return null
    // 頂点と辺の番号は、全部の輪郭をつないだ通し番号（pathEdit.ts）
    const contours = pathContours(node)
    const count = flatVertices(contours).length
    const vertices = edit.vertices.filter((index) => index < count)
    const segment = edit.segment !== null && contourSegment(contours, edit.segment) ? edit.segment : null
    return vertices.length === edit.vertices.length && segment === edit.segment ? edit : { ...edit, vertices, segment }
  }

  function emit() {
    state = snapshot()
    for (const listener of listeners) listener()
  }

  /** プレビューを終える（ブーリアン演算の後回しをやめる）。後回しにした演算があったか */
  function endPreview(): boolean {
    deferSlowBooleans(false)
    const recipe = previewRecipe
    previewRecipe = null
    return takeDeferredBooleans() && recipe !== null
  }

  function commitPreview() {
    const recipe = previewRecipe
    const redo = endPreview()
    if (preview === null) return
    // ドラッグ中に計算し直さなかった演算を計算し、枠を結果に合わせる（recipe はプレビュー前のドキュメントからの変更なので、同じ結果になる）
    if (redo) preview = settle(history.present, recipe!(history.present))
    history = pushHistory(history, preview)
    preview = null
    emit()
  }

  function cancelPreview() {
    endPreview()
    if (preview === null) return
    preview = null
    emit()
  }

  /**
   * 変更のあとの後始末。インスタンスの中身への変更を上書きとして覚え、大きさが変わったフレームの子を辺に追従させ、
   * 自動で並べるフレームを並べ直し、コンポーネントのインスタンスを元に合わせる。
   * どの操作も、レイアウトやインスタンスのことは気にせずノードを動かしてよい。
   */
  function settle(before: DesignDocument, after: DesignDocument): DesignDocument {
    if (after === before) return after
    checkSettled(before)
    // まとまりの外へ出した・中へ入れたバリアントの名前を合わせてから、上書きを覚える
    let current = captureOverrides(before, fitMovedVariants(before, after))
    let base = before
    // インスタンスを直すと大きさが変わって並べ直しが要る、ということがあるので、落ち着くまで繰り返す
    for (let pass = 0; pass < 4; pass++) {
      const previous = base
      const arranged = mapPages(current, (page) =>
        previous.pages.includes(page) ? page : arrange(findPage(previous, page.id), page),
      )
      // 前の回の結果（最初は変更の前）が合っていれば、そこから変わったところに関わるインスタンスだけを見る
      const synced = syncComponents(arranged, fitText, pass === 0 ? before : current)
      if (synced === current) {
        // 変わったページは、どれもどこかの回で後始末して落ち着いた。次の変更では、ここからの差分だけを後始末する
        // （変わっていないページは前のまま。読み込んだまま一度も後始末していないページを落ち着いたことにしない）
        for (const page of current.pages) if (!before.pages.includes(page)) settledPages.add(page)
        break
      }
      base = current
      current = synced
    }
    return current
  }

  /**
   * 後始末を通っていないドキュメント（読み込んだばかりなど）が、もう落ち着いているかを一度だけ確かめて覚える。
   * 落ち着いていれば、そこからの変更（読み込んだ直後のドラッグの 1 歩ずつ）も変わったノードのまわりだけを見られる。
   * 落ち着いていなければ何も覚えず、今までどおり全部を見る（ファイルの値は書き換えない）
   */
  function checkSettled(doc: DesignDocument) {
    if (checkedDocs.has(doc)) return
    checkedDocs.add(doc)
    // 合っていれば同期の覚え書き（syncedDocs）に入る
    syncComponents(doc, fitText)
    for (const page of doc.pages) {
      if (!settledPages.has(page) && fitBooleanNodes(page) === page && relayout(page, fitText) === page) settledPages.add(page)
    }
  }

  /**
   * 変わったページの後始末: 大きさが変わったフレームの子を追従させてから並べ直す。
   * 並べ直しでも大きさが変わる（中身に合わせる、親いっぱいに伸ばす）ので、その子も追従させ、もう一度並べる
   */
  function arrange(prior: Page | undefined, page: Page): Page {
    const follow = (from: Page, to: Page) => {
      const resized: NodeId[] = []
      const followed = applyConstraints(from, to, resized)
      return fitText && resized.length > 0 ? fitText(followed, resized) : followed
    }
    // 後始末を終えたページからの変更なら、枠合わせと並べ直しは変わったノードのまわりだけを見る
    const base = prior && settledPages.has(prior) ? prior : undefined
    // ブーリアン演算のノードの枠を結果に合わせる。子をずらして合わせるので、子を辺に追従させる前の比べ元にする
    const constrained = fitBooleanNodes(prior ? follow(prior, page) : page, base)
    const arranged = relayout(constrained, fitText, base)
    const followed = follow(constrained, arranged)
    return followed === arranged ? arranged : relayout(followed, fitText, base)
  }

  function mapPages(doc: DesignDocument, change: (page: Page) => Page): DesignDocument {
    const pages = doc.pages.map(change)
    return pages.every((page, i) => page === doc.pages[i]) ? doc : { ...doc, pages }
  }

  function applyDocument(recipe: DocumentRecipe) {
    commitPreview()
    const before = history
    history = pushHistory(history, settle(history.present, recipe(history.present)))
    if (history !== before) emit()
  }

  function previewDocument(recipe: DocumentRecipe) {
    // ドラッグ中は、重いブーリアン演算を計算し直さずに前の結果を見せる（離したときに commitPreview が計算する）
    deferSlowBooleans(true)
    previewRecipe = recipe
    const next = settle(history.present, recipe(history.present))
    if (next === (preview ?? history.present)) return
    preview = next
    emit()
  }

  /**
   * Undo / Redo で変わったのが別のページなら、そのページを表示する。
   * そうしないと、何が戻ったのか見えない。
   */
  function followChange(from: DesignDocument, to: DesignDocument) {
    const find = (doc: DesignDocument) => findPage(doc, pageId)
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

    /** apply と同じ。recipe の結果（scene のほかに、作ったノードの id などを持つもの）を返す */
    applyWith<R extends { scene: Page }>(recipe: (page: Page) => R): R | undefined {
      let result: R | undefined
      applyDocument((doc) => updatePage(doc, pageId, (page) => (result = recipe(page)).scene))
      return result
    },

    /** applyDocument と同じ。recipe の結果（document のほかに、作ったノードの id などを持つもの）を返す */
    applyDocumentWith<R extends { document: DesignDocument }>(recipe: (doc: DesignDocument) => R): R | undefined {
      let result: R | undefined
      applyDocument((doc) => (result = recipe(doc)).document)
      return result
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

    /** パスの頂点の編集に入る・選ぶ頂点や辺を変える（null で抜ける）。パスを 1 つだけ選んでいるときだけ有効 */
    editVertices(edit: VertexEdit | null) {
      vertexEdit = edit && { ...edit, vertices: [...new Set(edit.vertices)].sort((a, b) => a - b) }
      if (vertexEdit) gradientEdit = null
      emit()
    },

    /** キャンバスでグラデーションを動かし始める・選ぶ色を変える（null で抜ける）。そのノードを 1 つだけ選んでいるときだけ有効 */
    editGradient(edit: GradientEdit | null) {
      gradientEdit = edit
      if (edit) vertexEdit = null
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
      endPreview()
      preview = null
      pageId = document.pages[0].id
      selection = []
      emit()
    },
  }
}
