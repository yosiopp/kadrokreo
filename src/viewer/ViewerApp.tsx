import { useEffect, useState } from 'react'
import { type CanvasPointer, CanvasView } from '../canvas/CanvasView.tsx'
import { createCamera } from '../canvas/camera.ts'
import { isTextInput } from '../canvas/dom.ts'
import { pngFileName, renderPng } from '../canvas/exportPng.ts'
import { hitTest } from '../canvas/hitTest.ts'
import type { Viewport } from '../canvas/viewport.ts'
import { getAbsoluteBounds, getContentBounds } from '../document/geometry.ts'
import { decodeKdr } from '../document/kdr.ts'
import type { DesignDocument, NodeId, PageId } from '../document/types.ts'
import { ExportControls } from '../ui/ExportControls.tsx'
import { OpenFileButton } from '../ui/OpenFile.tsx'
import { ZoomControls } from '../ui/ZoomControls.tsx'
import { downloadBlob, safeFileName } from '../ui/download.ts'
import { useFileDrop } from '../ui/useFileDrop.ts'
import { InspectPanel } from './InspectPanel.tsx'
import { LayerTree } from './LayerTree.tsx'
import { drawInspectOverlay } from './overlay.ts'

export default function ViewerApp() {
  const [camera] = useState(createCamera)
  const [doc, setDoc] = useState<DesignDocument | null>(null)
  const [pageId, setPageId] = useState<PageId | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [scale, setScale] = useState(1)
  // viewer は、既存のデザインツールの開発者向けモードに当たる表示。図形を選んで、大きさ・色・間隔・CSS を確かめられる。
  // 選択は画面の状態で、ドキュメントは変えない
  const [selectedId, setSelectedId] = useState<NodeId | null>(null)
  const [hoverId, setHoverId] = useState<NodeId | null>(null)

  const page = doc ? (doc.pages.find((candidate) => candidate.id === pageId) ?? doc.pages[0]) : null
  // ページ直下のフレームを「画面」として一覧に出す
  const frames = page ? page.rootIds.map((id) => page.nodes[id]).filter((node) => node.type === 'frame') : []

  function clearSelection() {
    setSelectedId(null)
    setHoverId(null)
  }

  /** ポインタの下で最も手前にあるノード。インスタンスの中身や、ロック中のものも対象にする */
  function nodeAt(pointer: CanvasPointer): NodeId | null {
    if (!page) return null
    return hitTest(page, pointer.world, {
      tolerance: 3 / camera.getViewport().zoom,
      deep: true,
      locked: true,
    })
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isTextInput(event.target) || event.isComposing) return
      if (event.key === 'Escape') clearSelection()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  async function openFile(file: File) {
    try {
      const next = await decodeKdr(file)
      setDoc(next)
      setPageId(next.pages[0].id)
      clearSelection()
      camera.fit(getContentBounds(next.pages[0]))
      setMessage(null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'ファイルを開けませんでした')
    }
  }

  /** ノード 1 つ、または表示中のページ全体を PNG として保存する。ドキュメントは変更しない */
  async function exportPng(nodeId?: NodeId) {
    if (!doc || !page) return
    const targets = nodeId ? [nodeId] : page.rootIds
    const name = nodeId ? page.nodes[nodeId].name : `${doc.name} - ${page.name}`
    try {
      const png = await renderPng(page, doc.assets, targets, scale)
      downloadBlob(png, pngFileName(safeFileName(name), scale))
      setMessage(null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'PNG の書き出しに失敗しました')
    }
  }

  const dragging = useFileDrop((files) => openFile(files[0]))

  return (
    <div className="app" data-mode="viewer">
      <header className="app-header">
        <span className="app-title">kadrokreo</span>
        <span className="app-mode">viewer</span>
        {doc && <span className="document-name">{doc.name}</span>}
        <div className="app-header-spacer" />
        {page && <ZoomControls camera={camera} getContentBounds={() => getContentBounds(page)} />}
        <OpenFileButton onFiles={(files) => openFile(files[0])} className={doc ? undefined : 'primary'}>
          kdr を開く
        </OpenFileButton>
      </header>
      {message && (
        <div className="app-message" role="alert">
          {message}
          <button type="button" aria-label="閉じる" onClick={() => setMessage(null)}>
            ×
          </button>
        </div>
      )}
      <div className="viewer-body">
        {doc && page && (
          <aside className="panel viewer-sidebar">
            <section aria-label="ページ">
              <h2 className="panel-title">ページ</h2>
              <ul className="page-list">
                {doc.pages.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="list-button"
                      aria-current={item.id === page.id ? 'page' : undefined}
                      onClick={() => {
                        setPageId(item.id)
                        clearSelection()
                        camera.fit(getContentBounds(item))
                      }}
                    >
                      {item.name}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
            {frames.length > 0 && (
              <section aria-label="フレーム">
                <h2 className="panel-title">フレーム</h2>
                <ul className="page-list">
                  {frames.map((frame) => (
                    <li key={frame.id} className="frame-item">
                      <button
                        type="button"
                        className="list-button"
                        title="このフレームを表示"
                        onClick={() => camera.fit(getAbsoluteBounds(page, frame.id))}
                      >
                        {frame.name}
                      </button>
                      <button
                        type="button"
                        className="frame-export"
                        title="このフレームを PNG に書き出し"
                        aria-label={`${frame.name} を PNG に書き出し`}
                        onClick={() => exportPng(frame.id)}
                      >
                        PNG
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section className="panel-section" aria-label="書き出し">
              <h3 className="section-title">書き出し</h3>
              <ExportControls scale={scale} onScaleChange={setScale} onExport={() => exportPng()}>
                ページを PNG に
              </ExportControls>
            </section>
            {page.rootIds.length > 0 && (
              <section aria-label="レイヤー">
                <h2 className="panel-title">レイヤー</h2>
                <LayerTree scene={page} selectedId={selectedId} onSelect={setSelectedId} />
              </section>
            )}
          </aside>
        )}
        <main className="app-main">
          {doc && page ? (
            <CanvasView
              scene={page}
              assets={doc.assets}
              camera={camera}
              panWithPrimaryButton
              // ドラッグは画面の移動。動かさずに離したときだけ、その場所のものを選ぶ
              cursor="default"
              drawOverlay={(ctx: CanvasRenderingContext2D, viewport: Viewport) =>
                drawInspectOverlay(ctx, viewport, page, selectedId, hoverId)
              }
              onClick={(pointer) => setSelectedId(nodeAt(pointer))}
              onPointerMove={(pointer) => setHoverId(nodeAt(pointer))}
              onPointerLeave={() => setHoverId(null)}
            />
          ) : (
            <div className="empty-state">
              <p>kdr ファイルを開くと、ここにデザインが表示されます。</p>
              <p>「kdr を開く」から選ぶか、このウィンドウにファイルをドロップしてください。</p>
            </div>
          )}
          {dragging && <div className="drop-overlay">kdr ファイルをドロップして開く</div>}
        </main>
        {doc && page && (
          <InspectPanel
            document={doc}
            page={page}
            selectedId={selectedId}
            scale={scale}
            onScaleChange={setScale}
            onExport={() => selectedId && exportPng(selectedId)}
          />
        )}
      </div>
    </div>
  )
}
