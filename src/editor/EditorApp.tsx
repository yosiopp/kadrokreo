import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createCamera } from '../canvas/camera.ts'
import { pngFileName, renderPng } from '../canvas/exportPng.ts'
import type { Viewport } from '../canvas/viewport.ts'
import { getContentBounds } from '../document/geometry.ts'
import { IMAGE_MIME_TYPES, KDR_EXTENSION, decodeKdr } from '../document/kdr.ts'
import type { DesignDocument, NodeId, PageId } from '../document/types.ts'
import { Message } from '../ui/Message.tsx'
import { Logo } from '../ui/Logo.tsx'
import { OpenFileButton } from '../ui/OpenFile.tsx'
import { downloadBlob, safeFileName } from '../ui/download.ts'
import { TypeIcon } from '../ui/icons.tsx'
import { ZoomControls } from '../ui/ZoomControls.tsx'
import { useFileDrop } from '../ui/useFileDrop.ts'
import { EditorCanvas } from './EditorCanvas.tsx'
import type { Tool } from './tools.ts'
import { ComponentsPanel } from './ComponentsPanel.tsx'
import { LayersPanel } from './LayersPanel.tsx'
import { PagesPanel } from './PagesPanel.tsx'
import { COMPONENT_DRAG_TYPE, draggedComponent, instanceDropTarget, placeInstance } from './placeInstance.ts'
import { PropertiesPanel } from './PropertiesPanel.tsx'
import { Toolbar } from './Toolbar.tsx'
import { downloadKdr } from './exportKdr.ts'
import { RedoIcon, UndoIcon } from './icons.tsx'
import { placeImage, readImageFile } from './importImage.ts'
import { SVG_ACCEPT, convertSvgText, isSvgFile, placeSvg, readSvgFile, svgWarningMessage } from './importSvg.ts'
import { fitTextNodes } from './measure.ts'
import { addOrReuseAsset, createDocument, renameDocument, updatePage } from './operations/document.ts'
import { patchNodes, sortByDocumentOrder, topLevelIds } from './operations/tree.ts'
import { createId } from './nodes.ts'
import { loadSavedDocument, saveDocument } from './persistence.ts'
import { type EditorStore, createEditorStore } from './store.ts'

const SAVE_DELAY = 500

export default function EditorApp() {
  const [store, setStore] = useState<EditorStore | null>(null)

  // 自動保存したドキュメントの読み込みを待ってから画面を出す
  useEffect(() => {
    let cancelled = false
    loadSavedDocument().then((doc) => {
      if (!cancelled) setStore(createEditorStore(doc ?? createDocument(), fitTextNodes))
    })
    return () => {
      cancelled = true
    }
  }, [])

  return store ? <Editor store={store} /> : <div className="app" data-mode="editor" />
}

function Editor({ store }: { store: EditorStore }) {
  const [camera] = useState(createCamera)
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const [tool, setTool] = useState<Tool>('select')
  const [message, setMessage] = useState<string | null>(null)

  // ページごとに、最後に見ていた位置を覚えておく
  const viewportsRef = useRef(new Map<PageId, Viewport>())
  const shownPageRef = useRef(state.page.id)

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
    // 最後に保存できたドキュメント。失敗したときは進めないので、次の変更でもう一度試す
    let lastSaved: DesignDocument | null = null
    const save = () => {
      clearTimeout(timer)
      timer = 0
      const document = store.getState().document
      saveDocument(document).then((saved) => {
        if (saved) lastSaved = document
        // 保存できない環境では変更のたびに失敗するので、知らせるのは一度だけにする
        if (saved || warned) return
        warned = true
        setMessage('ブラウザへの自動保存に失敗しました。kdr に書き出して保存してください。')
      })
    }
    const unsubscribe = store.subscribe(() => {
      // 選択やページの切り替えだけなら、保存するものは変わっていない
      if (store.getState().document === lastSaved) return
      clearTimeout(timer)
      timer = window.setTimeout(save, SAVE_DELAY)
    })
    const flush = () => {
      if (timer !== 0) save()
    }
    window.addEventListener('pagehide', flush)
    return () => {
      unsubscribe()
      flush()
      window.removeEventListener('pagehide', flush)
    }
  }, [store])

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

  /** 選択中のもの（何も選んでいなければ表示中のページ全体）を PNG に書き出す */
  async function exportPng(scale: number) {
    const { document, page, selection } = store.getState()
    // 親子を一緒に選んでいたら親だけにして、重なり順に並べる
    const targets =
      selection.length > 0 ? sortByDocumentOrder(page, topLevelIds(page, selection)) : page.rootIds
    // 1 つだけ選んでいればその名前、そうでなければ「ドキュメント名 - ページ名」をファイル名にする
    const name =
      selection.length === 1 ? page.nodes[selection[0]].name : `${document.name} - ${page.name}`
    try {
      const png = await renderPng(page, document.assets, targets, scale)
      downloadBlob(png, pngFileName(safeFileName(name), scale))
    } catch (error) {
      showError(error, 'PNG の書き出しに失敗しました')
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
        <Toolbar tool={tool} onToolChange={setTool}>
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
      <Message text={message} onClose={() => setMessage(null)} />
      <div className="editor-body">
        <aside className="panel layers-panel">
          <PagesPanel store={store} state={state} />
          <ComponentsPanel store={store} state={state} camera={camera} />
          <LayersPanel store={store} state={state} />
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
            onPasteImages={importImages}
            onPasteSvg={importSvgText}
            dropTarget={dropTarget}
          />
          {dragging && <div className="drop-overlay">画像・SVG または kdr ファイルをドロップ</div>}
        </main>
        <PropertiesPanel store={store} state={state} onExportPng={exportPng} onReplaceImage={replaceImage} />
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
