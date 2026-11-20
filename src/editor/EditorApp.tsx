import { useEffect, useState, useSyncExternalStore } from 'react'
import { createCamera } from '../canvas/camera.ts'
import { getContentBounds } from '../document/geometry.ts'
import { decodeKdr } from '../document/kdr.ts'
import { OpenFileButton } from '../ui/OpenFile.tsx'
import { ZoomControls } from '../ui/ZoomControls.tsx'
import { useFileDrop } from '../ui/useFileDrop.ts'
import { EditorCanvas, type Tool } from './EditorCanvas.tsx'
import { LayersPanel } from './LayersPanel.tsx'
import { PropertiesPanel } from './PropertiesPanel.tsx'
import { Toolbar } from './Toolbar.tsx'
import { downloadKdr } from './exportKdr.ts'
import { RedoIcon, UndoIcon } from './icons.tsx'
import { createDocument, renameDocument } from './operations.ts'
import { loadSavedDocument, saveDocument } from './persistence.ts'
import { createEditorStore } from './store.ts'

const SAVE_DELAY = 500

export default function EditorApp() {
  const [store] = useState(() => createEditorStore(loadSavedDocument() ?? createDocument()))
  const [camera] = useState(createCamera)
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const [tool, setTool] = useState<Tool>('select')
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    camera.fit(getContentBounds(store.getState().document))
  }, [camera, store])

  // 変更が落ち着いたら自動保存する。タブを閉じるときは待たずに書く
  useEffect(() => {
    let timer = 0
    const save = () => {
      clearTimeout(timer)
      timer = 0
      if (!saveDocument(store.getState().document)) {
        setMessage('ブラウザへの自動保存に失敗しました。kdr に書き出して保存してください。')
      }
    }
    const unsubscribe = store.subscribe(() => {
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

  const isEmpty = state.document.rootIds.length === 0

  function confirmDiscard(): boolean {
    return isEmpty || window.confirm('いま編集中の内容は破棄されます。よろしいですか？')
  }

  async function openFile(file: File) {
    if (!confirmDiscard()) return
    try {
      const doc = await decodeKdr(file)
      store.load(doc)
      camera.fit(getContentBounds(doc))
      setTool('select')
      setMessage(null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'ファイルを開けませんでした')
    }
  }

  function newDocument() {
    if (!confirmDiscard()) return
    store.load(createDocument())
    camera.fit(null)
    setMessage(null)
  }

  async function exportFile() {
    try {
      await downloadKdr(store.getState().document)
    } catch {
      setMessage('kdr ファイルの書き出しに失敗しました')
    }
  }

  const dragging = useFileDrop(openFile)

  return (
    <div className="app" data-mode="editor">
      <header className="app-header">
        <span className="app-title">kadrokreo</span>
        <span className="app-mode">editor</span>
        <NameField
          value={state.document.name}
          onCommit={(name) => store.apply((doc) => renameDocument(doc, name))}
        />
        <Toolbar tool={tool} onToolChange={setTool} />
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
        <ZoomControls camera={camera} getContentBounds={() => getContentBounds(store.getState().document)} />
        <button type="button" onClick={newDocument}>
          新規
        </button>
        <OpenFileButton onFile={openFile}>開く</OpenFileButton>
        <button type="button" className="primary" onClick={exportFile}>
          kdr に書き出し
        </button>
      </header>
      {message && (
        <div className="app-message" role="alert">
          {message}
          <button type="button" aria-label="閉じる" onClick={() => setMessage(null)}>
            ×
          </button>
        </div>
      )}
      <div className="editor-body">
        <LayersPanel store={store} state={state} />
        <main className="app-main">
          <EditorCanvas store={store} camera={camera} state={state} tool={tool} onToolChange={setTool} />
          {dragging && <div className="drop-overlay">kdr ファイルをドロップして開く</div>}
        </main>
        <PropertiesPanel store={store} state={state} />
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
