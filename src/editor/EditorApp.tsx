import { type RefObject, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createCamera } from '../canvas/camera.ts'
import { exportTargets, pngFileName, renderPng } from '../canvas/exportPng.ts'
import { renderSvg, svgMarkup } from '../canvas/exportSvg.ts'
import { syncEmbeddedFonts } from '../canvas/fonts.ts'
import { useEmbeddedFonts } from '../canvas/useEmbeddedFonts.ts'
import { fontFamilyValue } from '../document/fontFile.ts'
import { copyText } from '../ui/clipboard.ts'
import { getExportOptions } from '../ui/exportOptions.ts'
import { svgFileName } from '../document/svgExport.ts'
import type { Viewport } from '../canvas/viewport.ts'
import { getContentBounds } from '../document/geometry.ts'
import { IMAGE_MIME_TYPES, KDR_EXTENSION, decodeKdr } from '../document/kdr.ts'
import type { DesignDocument, EmbeddedFont, NodeId, PageId } from '../document/types.ts'
import { Message } from '../ui/Message.tsx'
import { Logo } from '../ui/Logo.tsx'
import { OpenFileButton } from '../ui/OpenFile.tsx'
import { downloadBlob, safeFileName } from '../ui/download.ts'
import { TypeIcon } from '../ui/icons.tsx'
import { ZoomControls } from '../ui/ZoomControls.tsx'
import { useFileDrop } from '../ui/useFileDrop.ts'
import { EditorCanvas, type MenuOpener } from './EditorCanvas.tsx'
import { DEFAULT_SHAPE_OPTIONS, type ShapeOptions, type Tool } from './tools.ts'
import { ComponentsPanel } from './ComponentsPanel.tsx'
import { LayersPanel } from './LayersPanel.tsx'
import { PagesPanel } from './PagesPanel.tsx'
import { COMPONENT_DRAG_TYPE, draggedComponent, instanceDropTarget, placeInstance } from './placeInstance.ts'
import { PropertiesPanel } from './PropertiesPanel.tsx'
import { Toolbar } from './Toolbar.tsx'
import { downloadKdr } from './exportKdr.ts'
import { RedoIcon, UndoIcon } from './icons.tsx'
import { readFontFile } from './importFont.ts'
import { placeImage, readImageFile } from './importImage.ts'
import { SVG_ACCEPT, convertSvgText, isSvgFile, placeSvg, readSvgFile, svgWarningMessage } from './importSvg.ts'
import { fitTextNodes } from './measure.ts'
import { addFont, addOrReuseAsset, createDocument, removeFont, renameDocument, updatePage } from './operations/document.ts'
import { patchNodes } from './operations/tree.ts'
import { createId } from './nodes.ts'
import { type SaveResult, type UnreadableReason, discardSavedDocument, loadSavedDocument, saveDocument } from './persistence.ts'
import { ElsewhereNotice, UnreadableNotice } from './SavedNotice.tsx'
import { type EditorStore, createEditorStore } from './store.ts'
import { type EditorTab, createEditorTab, openTabChannel } from './tabs.ts'

const SAVE_DELAY = 500

/** 保存先を別のタブが書いたので自動保存を止めた、という知らせ（閉じられない。このタブの内容は画面に残っている） */
const AUTOSAVE_STOPPED =
  '別のタブがこのドキュメントを編集しているため、このタブの自動保存を止めました。このタブの内容を残すには「kdr に書き出し」でファイルに保存してください。' +
  'ページを読み込み直すと、保存されている内容が開きます。'

/** 画面に出すもの */
type View =
  /** 別のタブが編集中かを確かめている・自動保存を読んでいる */
  | { kind: 'waiting' }
  /** 別のタブが編集中（taking は引き継いでいる途中） */
  | { kind: 'elsewhere'; taking: boolean }
  /** 読めない自動保存が残っている */
  | { kind: 'unreadable'; reason: UnreadableReason; error: string | null }
  /** 編集中。serial は開くたびに変わる番号、stopped は、保存先を別のタブが書いたので自動保存を止めた */
  | { kind: 'editor'; store: EditorStore; serial: number; stopped: boolean }

/** 編集中の内容を保存しきる関数（保存しきれたら true）。Editor が入れる */
type FlushRef = RefObject<(() => Promise<boolean>) | null>

/** editor の画面を開いた回数（開くたびに画面を作り直すためのキー） */
let opened = 0

/** 自動保存を読んで、出す画面を返す。編集するタブになったときと、読めない自動保存を破棄したあとに呼ぶ */
async function openSaved(): Promise<View> {
  const saved = await loadSavedDocument()
  if (saved.kind === 'unreadable') return { kind: 'unreadable', reason: saved.reason, error: null }
  const document = saved.kind === 'document' ? saved.document : createDocument()
  return { kind: 'editor', store: createEditorStore(document, fitTextNodes), serial: ++opened, stopped: false }
}

export default function EditorApp() {
  const [view, setView] = useState<View>({ kind: 'waiting' })
  const tabRef = useRef<EditorTab | null>(null)
  const flushRef: FlushRef = useRef(null)

  /** 保存先を別のタブが書いていた。このタブの内容は画面に残し、自動保存を止めて知らせる（知らせ合いからも外れる） */
  const stopAutosave = useCallback(() => {
    tabRef.current?.close()
    setView((current) => (current.kind === 'editor' ? { ...current, stopped: true } : current))
  }, [])

  // 編集するタブは 1 つだけ。別のタブが編集中なら、自動保存を読まずに知らせる
  useEffect(() => {
    const tab = createEditorTab({
      channel: openTabChannel(),
      async release() {
        const flushed = (await flushRef.current?.()) ?? true
        // 保存しきれなかった内容は捨てない。自動保存を止めたまま画面に残す
        if (!flushed && tabRef.current === tab) stopAutosave()
        return flushed
      },
      onChange(state) {
        if (tabRef.current !== tab) return
        if (state === 'owner') {
          void openSaved().then((next) => {
            // 読んでいる間に、タブを閉じた・別のタブに編集を渡した
            if (tabRef.current === tab && tab.state() === 'owner') setView(next)
          })
        } else if (state !== 'checking') setView({ kind: 'elsewhere', taking: state === 'taking' })
      },
    })
    tabRef.current = tab
    tab.start()
    // 別のタブを閉じたあとでこのタブを表に出したら、そのまま続きを編集できるようにする
    const recheck = () => {
      if (document.visibilityState === 'visible') tab.recheck()
    }
    // 戻る・進むで前の画面がそのまま戻ってきたら、その間に別のタブが編集しているかもしれないので開き直す
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload()
    }
    window.addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', recheck)
    window.addEventListener('pageshow', restored)
    return () => {
      tabRef.current = null
      tab.close()
      window.removeEventListener('focus', recheck)
      document.removeEventListener('visibilitychange', recheck)
      window.removeEventListener('pageshow', restored)
    }
  }, [stopAutosave])

  async function discardSaved() {
    const tab = tabRef.current
    if (tab === null || !window.confirm('残っている保存データを破棄します。元に戻せません。よろしいですか？')) return
    try {
      // 別のタブが書き換えていたら消されない。どちらでも、読み直した結果を出す
      await discardSavedDocument()
      const next = await openSaved()
      if (tabRef.current === tab && tab.state() === 'owner') setView(next)
    } catch {
      setView((current) => (current.kind === 'unreadable' ? { ...current, error: '保存データを破棄できませんでした。' } : current))
    }
  }

  switch (view.kind) {
    case 'waiting':
      return <div className="app" data-mode="editor" />
    case 'elsewhere':
      return <ElsewhereNotice taking={view.taking} onTakeOver={() => tabRef.current?.takeOver()} />
    case 'unreadable':
      return <UnreadableNotice reason={view.reason} error={view.error} onDiscard={discardSaved} />
    case 'editor':
      // 開き直したら（別のタブから編集を引き継いで読み直したら）、画面ごと作り直す
      return <Editor key={view.serial} store={view.store} autosaveStopped={view.stopped} onSaveBlocked={stopAutosave} flushRef={flushRef} />
  }
}

type EditorProps = {
  store: EditorStore
  /** 保存先を別のタブが書いたので、自動保存を止めている */
  autosaveStopped: boolean
  /** 自動保存が、保存先を別のタブが書いていたために書けなかった */
  onSaveBlocked: () => void
  flushRef: FlushRef
}

function Editor({ store, autosaveStopped, onSaveBlocked, flushRef }: EditorProps) {
  const [camera] = useState(createCamera)
  const state = useSyncExternalStore(store.subscribe, store.getState)
  // kdr に埋め込んだ書体で描く
  useEmbeddedFonts(state.document.fonts, state.document.assets)
  const [tool, setTool] = useState<Tool>('select')
  const [shapeOptions, setShapeOptions] = useState<ShapeOptions>(DEFAULT_SHAPE_OPTIONS)
  const [message, setMessage] = useState<string | null>(null)

  // ページごとに、最後に見ていた位置を覚えておく
  const viewportsRef = useRef(new Map<PageId, Viewport>())
  const shownPageRef = useRef(state.page.id)
  // レイヤーパネルの右クリックから、キャンバスと同じメニューを出す（出す関数はキャンバスが入れる）
  const menuOpenerRef = useRef<MenuOpener | null>(null)

  useEffect(() => {
    camera.fit(getContentBounds(store.getState().page))
  }, [camera, store])

  const pageId = state.page.id
  useEffect(() => {
    const previous = shownPageRef.current
    if (previous === pageId) return
    viewportsRef.current.set(previous, camera.getViewport())
    shownPageRef.current = pageId
    const saved = viewportsRef.current.get(pageId)
    if (saved) camera.setViewport(saved)
    else camera.fit(getContentBounds(store.getState().page))
  }, [camera, store, pageId])

  /** ドキュメントを丸ごと差し替える */
  function replaceDocument(doc: DesignDocument) {
    store.load(doc)
    viewportsRef.current.clear()
    shownPageRef.current = doc.pages[0].id
    camera.fit(getContentBounds(doc.pages[0]))
    setTool('select')
    setMessage(null)
  }

  // 変更が落ち着いたら自動保存する。タブを閉じるときは待たずに書く
  useEffect(() => {
    let timer = 0
    let warned = false
    // 保存先を別のタブが書いた・編集を別のタブに渡したあとは、もう書かない
    let stopped = false
    // 最後に保存できたドキュメント。失敗したときは進めないので、次の変更でもう一度試す
    let lastSaved: DesignDocument | null = null
    // 保存している途中のドキュメントと、その結果
    let saving: DesignDocument | null = null
    let last: Promise<SaveResult> = Promise.resolve('saved')
    // 開いてから変更があったか
    let changed = false
    const save = () => {
      clearTimeout(timer)
      timer = 0
      const document = store.getState().document
      saving = document
      last = saveDocument(document).then((result) => {
        if (saving === document) saving = null
        if (result === 'saved') lastSaved = document
        else if (result === 'blocked') {
          // 別のタブが保存先を書いていた。上書きせず、このタブの自動保存を止めて知らせる
          stopped = true
          clearTimeout(timer)
          timer = 0
          onSaveBlocked()
        } else if (!warned) {
          // 保存できない環境では変更のたびに失敗するので、知らせるのは一度だけにする
          warned = true
          setMessage('ブラウザへの自動保存に失敗しました。kdr に書き出して保存してください。')
        }
        return result
      })
      return last
    }
    const unsubscribe = store.subscribe(() => {
      // 選択やページの切り替えだけなら、保存するものは変わっていない
      if (stopped || store.getState().document === lastSaved) return
      changed = true
      clearTimeout(timer)
      timer = window.setTimeout(save, SAVE_DELAY)
    })
    const flush = () => {
      if (timer !== 0 && !stopped) save()
    }
    // 別のタブに編集を渡す前に、保存していない変更を書ききる。以後は書かない
    const release = async () => {
      if (stopped) return false
      stopped = true
      const document = store.getState().document
      const unsaved = changed && document !== lastSaved && document !== saving
      return (await (unsaved ? save() : last)) === 'saved'
    }
    flushRef.current = release
    window.addEventListener('pagehide', flush)
    return () => {
      unsubscribe()
      flush()
      window.removeEventListener('pagehide', flush)
      if (flushRef.current === release) flushRef.current = null
    }
  }, [store, flushRef, onSaveBlocked])

  const isEmpty = state.document.pages.every((page) => page.rootIds.length === 0)

  function confirmDiscard(): boolean {
    return isEmpty || window.confirm('いま編集中の内容は破棄されます。よろしいですか？')
  }

  function showError(error: unknown, fallback: string) {
    setMessage(error instanceof Error ? error.message : fallback)
  }

  async function openDocument(file: File) {
    // SVG は開かずに、図形にして今のページへ取り込む
    if (isSvgFile(file)) return importImages([file])
    if (!confirmDiscard()) return
    try {
      replaceDocument(await decodeKdr(file))
    } catch (error) {
      showError(error, 'ファイルを開けませんでした')
    }
  }

  /** 画像と SVG を置く。SVG は画像としてではなく、図形のノードに変換して取り込む */
  async function importImages(files: File[]) {
    setMessage(null)
    let placed = 0
    const notices: string[] = []
    for (const file of files) {
      try {
        if (isSvgFile(file)) {
          const imported = await readSvgFile(file)
          placeSvg(store, camera, imported, placed * 20)
          const notice = svgWarningMessage(imported.name, imported.warnings)
          if (notice) notices.push(notice)
        } else {
          placeImage(store, camera, await readImageFile(file), placed * 20)
        }
        placed++
      } catch (error) {
        notices.push(error instanceof Error ? error.message : '画像を取り込めませんでした')
      }
    }
    if (notices.length > 0) setMessage(notices.join('\n'))
    if (placed > 0) setTool('select')
  }

  /** クリップボードの SVG の文字（デザインツールの「SVG としてコピー」など）を取り込む */
  function importSvgText(text: string) {
    setMessage(null)
    try {
      const imported = convertSvgText(text, 'SVG')
      placeSvg(store, camera, imported)
      setMessage(svgWarningMessage('SVG', imported.warnings))
      setTool('select')
    } catch (error) {
      showError(error, 'SVG を取り込めませんでした')
    }
  }

  /**
   * 選んでいる画像を、ファイルの画像に差し替える。大きさと収め方はそのまま。
   * インスタンスの中の画像なら、そのインスタンスだけの上書きになる（ストアの後始末が覚える）
   */
  async function replaceImage(file: File) {
    setMessage(null)
    try {
      const image = await readImageFile(file)
      const { page, selection } = store.getState()
      store.applyDocument((doc) => {
        // 同じ画像がすでにあれば、そのアセットを使う
        const { document, assetId } = addOrReuseAsset(doc, image.asset, createId)
        return updatePage(document, page.id, (base) =>
          patchNodes(base, selection, (node) => (node.type === 'image' ? { assetId } : null)),
        )
      })
    } catch (error) {
      showError(error, '画像を差し替えられませんでした')
    }
  }

  /**
   * 書体ファイルを kdr に埋め込む。同じ書体名・太さ・斜体の書体があれば差し替える。
   * 最後に取り込めた書体の、テキストの書体名に書く値を返す（取り込めなければ null）
   */
  async function addFonts(files: File[]): Promise<string | null> {
    setMessage(null)
    let last: string | null = null
    const notices: string[] = []
    for (const file of files) {
      try {
        const { asset, face } = await readFontFile(file)
        store.applyDocument((doc) => addFont(doc, asset, face, createId))
        // テキストに使う前（大きさを測る前）に登録しておく
        const { document } = store.getState()
        syncEmbeddedFonts(document.fonts, document.assets)
        last = fontFamilyValue(face.family)
      } catch (error) {
        notices.push(error instanceof Error ? error.message : '書体を取り込めませんでした')
      }
    }
    if (notices.length > 0) setMessage(notices.join('\n'))
    return last
  }

  function removeEmbeddedFont(font: EmbeddedFont) {
    store.applyDocument((doc) => removeFont(doc, font))
  }

  /** ドロップされたファイル。画像と SVG はキャンバスに置き、それ以外は kdr として開く */
  function openFiles(files: File[]) {
    const images = files.filter((file) => file.type.startsWith('image/') || isSvgFile(file))
    if (images.length > 0) importImages(images)
    else openDocument(files[0])
  }

  function newDocument() {
    if (!confirmDiscard()) return
    replaceDocument(createDocument())
  }

  async function exportFile() {
    try {
      await downloadKdr(store.getState().document)
    } catch (error) {
      showError(error, 'kdr ファイルの書き出しに失敗しました')
    }
  }

  /** 書き出す範囲（描く順）とファイル名（拡張子の前）。選択中のもの、何も選んでいなければ表示中のページ全体。viewer・CLI と同じ決め方 */
  function exportTargetsNow() {
    const { document, page, selection } = store.getState()
    const { targets, name } = exportTargets(document, page, selection)
    return { document, page, targets, name: safeFileName(name) }
  }

  /** 選択中のもの（何も選んでいなければ表示中のページ全体）を PNG に書き出す */
  async function exportPng(scale: number) {
    const { document, page, targets, name } = exportTargetsNow()
    try {
      const png = await renderPng(page, document.assets, targets, scale, getExportOptions().background)
      downloadBlob(png, pngFileName(name, scale))
    } catch (error) {
      showError(error, 'PNG の書き出しに失敗しました')
    }
  }

  /** 選択中のもの（何も選んでいなければ表示中のページ全体）を SVG に書き出す */
  function exportSvg() {
    const { document, page, targets, name } = exportTargetsNow()
    try {
      downloadBlob(renderSvg(page, document.assets, targets, getExportOptions(), document.fonts), svgFileName(name))
    } catch (error) {
      showError(error, 'SVG の書き出しに失敗しました')
    }
  }

  /** 選択中のもの（何も選んでいなければ表示中のページ全体）を SVG の文字にしてクリップボードへ入れる（「SVG に」と同じ中身） */
  async function copySvg(): Promise<boolean> {
    const { document, page, targets } = exportTargetsNow()
    try {
      const copied = await copyText(svgMarkup(page, document.assets, targets, getExportOptions(), document.fonts))
      if (!copied) setMessage('クリップボードへコピーできませんでした')
      return copied
    } catch (error) {
      showError(error, 'SVG のコピーに失敗しました')
      return false
    }
  }

  const dragging = useFileDrop(openFiles)
  // コンポーネントの一覧からドラッグしているとき、インスタンスが入るフレーム（ページ直下なら null）
  const [dropTarget, setDropTarget] = useState<NodeId | null>(null)

  return (
    <div className="app" data-mode="editor">
      <header className="app-header">
        <Logo className="app-logo" />
        <span className="app-mode">editor</span>
        <NameField
          value={state.document.name}
          onCommit={(name) => store.applyDocument((doc) => renameDocument(doc, name))}
        />
        <Toolbar tool={tool} onToolChange={setTool} shapeOptions={shapeOptions} onShapeOptionsChange={setShapeOptions}>
          <OpenFileButton
            className="icon-button"
            title="画像・SVG を配置"
            accept={[...IMAGE_MIME_TYPES, SVG_ACCEPT].join(',')}
            multiple
            onFiles={importImages}
          >
            <TypeIcon type="image" />
          </OpenFileButton>
        </Toolbar>
        <div className="toolbar">
          <button
            type="button"
            className="icon-button"
            title="元に戻す (⌘/Ctrl+Z)"
            aria-label="元に戻す"
            disabled={!state.canUndo}
            onClick={store.undo}
          >
            <UndoIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            title="やり直す (⌘/Ctrl+Shift+Z)"
            aria-label="やり直す"
            disabled={!state.canRedo}
            onClick={store.redo}
          >
            <RedoIcon />
          </button>
        </div>
        <div className="app-header-spacer" />
        <ZoomControls camera={camera} getContentBounds={() => getContentBounds(store.getState().page)} />
        <button type="button" onClick={newDocument}>
          新規
        </button>
        <OpenFileButton accept={`${KDR_EXTENSION},${SVG_ACCEPT}`} onFiles={(files) => openDocument(files[0])}>
          開く
        </OpenFileButton>
        <button type="button" className="primary" onClick={exportFile}>
          kdr に書き出し
        </button>
      </header>
      {autosaveStopped && (
        <div className="app-message autosave-stopped" role="alert">
          {AUTOSAVE_STOPPED}
        </div>
      )}
      <Message text={message} onClose={() => setMessage(null)} />
      <div className="editor-body">
        <aside className="panel layers-panel">
          <PagesPanel store={store} state={state} />
          <ComponentsPanel store={store} state={state} camera={camera} />
          <LayersPanel store={store} state={state} onContextMenu={(at) => menuOpenerRef.current?.(at)} />
        </aside>
        <main
          className="app-main"
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes(COMPONENT_DRAG_TYPE)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
            const componentId = draggedComponent()
            const rect = event.currentTarget.getBoundingClientRect()
            const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top }
            setDropTarget(componentId === null ? null : instanceDropTarget(store, camera, componentId, screen))
          }}
          onDragLeave={(event) => {
            // 中の要素へ移っただけなら消さない
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null)
          }}
          onDrop={(event) => {
            setDropTarget(null)
            const componentId = event.dataTransfer.getData(COMPONENT_DRAG_TYPE)
            if (!componentId) return
            event.preventDefault()
            const rect = event.currentTarget.getBoundingClientRect()
            placeInstance(store, camera, componentId, { x: event.clientX - rect.left, y: event.clientY - rect.top })
          }}
        >
          <EditorCanvas
            store={store}
            camera={camera}
            state={state}
            tool={tool}
            onToolChange={setTool}
            shapeOptions={shapeOptions}
            onPasteImages={importImages}
            onPasteSvg={importSvgText}
            onCopySvg={copySvg}
            onMessage={setMessage}
            dropTarget={dropTarget}
            menuOpenerRef={menuOpenerRef}
          />
          {dragging && <div className="drop-overlay">画像・SVG または kdr ファイルをドロップ</div>}
        </main>
        <PropertiesPanel store={store} state={state} onExportPng={exportPng} onExportSvg={exportSvg} onCopySvg={copySvg} onReplaceImage={replaceImage} onAddFonts={addFonts} onRemoveFont={removeEmbeddedFont} />
      </div>
    </div>
  )
}

function NameField({ value, onCommit }: { value: string; onCommit: (name: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      className="document-name"
      aria-label="ドキュメント名"
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== null && draft.trim() !== '') onCommit(draft.trim())
        setDraft(null)
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          const input = event.currentTarget
          setDraft(null)
          requestAnimationFrame(() => input.blur())
        }
      }}
    />
  )
}
