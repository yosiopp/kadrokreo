import { useEffect, useState } from 'react'
import { createCamera } from '../canvas/camera.ts'
import { isTextInput } from '../canvas/dom.ts'
import { exportTargets, pngFileName, renderPng } from '../canvas/exportPng.ts'
import { renderSvg, svgMarkup } from '../canvas/exportSvg.ts'
import { useEmbeddedFonts } from '../canvas/useEmbeddedFonts.ts'
import { svgFileName } from '../document/svgExport.ts'
import { assetBlob } from '../canvas/images.ts'
import { getAbsoluteBounds, getContentBounds, getNodesBounds } from '../document/geometry.ts'
import { decodeKdr } from '../document/kdr.ts'
import type { DesignDocument, EmbeddedFont, NodeId, PageId } from '../document/types.ts'
import { fontFileName } from '../document/fontFace.ts'
import { findMain, instanceOf } from '../document/component.ts'
import { ExportControls } from '../ui/ExportControls.tsx'
import { getExportOptions } from '../ui/exportOptions.ts'
import { Logo } from '../ui/Logo.tsx'
import { Message } from '../ui/Message.tsx'
import { OpenFileButton } from '../ui/OpenFile.tsx'
import { ZoomControls } from '../ui/ZoomControls.tsx'
import { downloadBlob, safeFileName } from '../ui/download.ts'
import { useFileDrop } from '../ui/useFileDrop.ts'
import { InspectPanel } from './InspectPanel.tsx'
import { formatViewLink, parseViewLink, resolveViewLink } from './link.ts'
import { copyText } from '../ui/clipboard.ts'
import { imageExtension, nodeMarkup, standaloneHtml } from './markup.ts'
import type { CodeStyle } from './inspect.ts'
import { LayerTree } from './LayerTree.tsx'
import { ViewerCanvas } from './ViewerCanvas.tsx'
import { type Step, stepFrom } from './traverse.ts'

/** 選択を動かすキー。[そのまま押したとき, Shift を押しながらのとき] */
const STEP_KEYS: Record<string, [Step, Step] | undefined> = {
  Enter: ['child', 'parent'],
  Tab: ['next', 'previous'],
}

export default function ViewerApp() {
  const [camera] = useState(createCamera)
  const [doc, setDoc] = useState<DesignDocument | null>(null)
  // kdr に埋め込んだ書体で描く
  useEmbeddedFonts(doc?.fonts, doc?.assets)
  const [pageId, setPageId] = useState<PageId | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [scale, setScale] = useState(1)
  // viewer は、既存のデザインツールの開発者向けモードに当たる表示。図形を選んで、大きさ・色・間隔・CSS を確かめられる。
  // 選択は画面の状態で、ドキュメントは変えない
  // Shift を押しながら選ぶと、いくつも選べる。2 つ選べば、その間隔が出る
  const [selection, setSelection] = useState<NodeId[]>([])
  const selectedId = selection.length === 1 ? selection[0] : null

  // 「リンクをコピー」を押したあと、少しのあいだ「コピーしました」と出す
  const [linkCopied, setLinkCopied] = useState(false)

  const page = doc ? (doc.pages.find((candidate) => candidate.id === pageId) ?? doc.pages[0]) : null
  // ページ直下のフレームを「画面」として一覧に出す
  const frames = page ? page.rootIds.map((id) => page.nodes[id]).filter((node) => node.type === 'frame') : []

  /** キャンバスの外（一覧やキーボード）から選ぶ。選んだものが画面に入っていなければ、見える位置へ寄せる */
  function selectAndReveal(id: NodeId, additive = false) {
    if (!page) return
    select(id, additive)
    camera.reveal(getAbsoluteBounds(page, id))
  }

  /** id を選ぶ。additive なら、選択に足す（もう選んでいれば外す）。id が null なら選択を外す */
  function select(id: NodeId | null, additive: boolean) {
    if (!additive) setSelection(id === null ? [] : [id])
    else if (id !== null) {
      setSelection((current) => (current.includes(id) ? current.filter((other) => other !== id) : [...current, id]))
    }
  }

  /** いくつものノードをまとめて選び、全体が見えるように寄せる（色や文字の一覧から選ぶとき） */
  function selectNodes(ids: NodeId[]) {
    if (!page) return
    setSelection(ids)
    const bounds = getNodesBounds(page, ids)
    if (bounds) camera.reveal(bounds)
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isTextInput(event.target) || event.isComposing) return
      if (event.key === 'Escape') {
        setSelection([])
        return
      }
      // 選択を、レイヤーの木に沿って動かす。Enter で子へ、Shift + Enter で親へ、Tab / Shift + Tab で隣へ
      if (!page || selectedId === null || event.metaKey || event.ctrlKey || event.altKey) return
      // フォーカスのあるボタンでは、Enter や Tab はそのボタンの操作
      if (event.target instanceof Element && event.target.closest('button, a, select')) return
      const step = STEP_KEYS[event.key]?.[event.shiftKey ? 1 : 0]
      if (!step) return
      event.preventDefault()
      const next = stepFrom(page, selectedId, step)
      if (next !== null) selectAndReveal(next)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  // 見ている場所（ページと選択）を URL のハッシュに書いておく。アドレスをそのまま渡せば、同じ場所から見てもらえる。
  // 履歴は積まない（戻るボタンで選択をさかのぼらない）
  useEffect(() => {
    if (!page) return
    const hash = formatViewLink({ pageId: page.id, selection })
    if (hash !== window.location.hash) {
      window.history.replaceState(null, '', hash || window.location.pathname + window.location.search)
    }
  }, [page, selection])

  // アドレス欄でハッシュを書き換えたら、そこへ移る
  useEffect(() => {
    function onHashChange() {
      if (doc) showLink(doc)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  })

  useEffect(() => {
    if (!linkCopied) return
    const timer = setTimeout(() => setLinkCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [linkCopied])

  /** URL のハッシュが指すページと選択を表示する。選んでいるものがあれば、そこが画面に収まるようにする */
  function showLink(target: DesignDocument) {
    const link = resolveViewLink(target, parseViewLink(window.location.hash))
    const linkedPage = target.pages.find((candidate) => candidate.id === link.pageId)!
    setPageId(link.pageId)
    setSelection(link.selection)
    camera.fit(
      link.selection.length > 0 ? getNodesBounds(linkedPage, link.selection) : getContentBounds(linkedPage),
    )
  }

  async function openFile(file: File) {
    try {
      const next = await decodeKdr(file)
      setDoc(next)
      showLink(next)
      setMessage(null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'ファイルを開けませんでした')
    }
  }

  /** ノード（いくつでも）、または表示中のページ全体を PNG として保存する。ドキュメントは変更しない */
  async function exportPng(nodeIds?: readonly NodeId[]) {
    if (!doc || !page) return
    const { targets, name } = exportTargets(doc, page, nodeIds ?? null)
    try {
      const png = await renderPng(page, doc.assets, targets, scale, getExportOptions().background)
      downloadBlob(png, pngFileName(safeFileName(name), scale))
      setMessage(null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'PNG の書き出しに失敗しました')
    }
  }

  /** ノード（いくつでも）、または表示中のページ全体を SVG として保存する。範囲とファイル名は PNG と同じ決め方 */
  function exportSvg(nodeIds?: readonly NodeId[]) {
    if (!doc || !page) return
    const { targets, name } = exportTargets(doc, page, nodeIds ?? null)
    try {
      downloadBlob(renderSvg(page, doc.assets, targets, getExportOptions(), doc.fonts), svgFileName(safeFileName(name)))
      setMessage(null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'SVG の書き出しに失敗しました')
    }
  }

  /** ノード（いくつでも）、または表示中のページ全体を SVG の文字にしてクリップボードへ入れる。中身は「SVG に」と同じ */
  async function copySvg(nodeIds?: readonly NodeId[]): Promise<boolean> {
    if (!doc || !page) return false
    const { targets } = exportTargets(doc, page, nodeIds ?? null)
    try {
      const copied = await copyText(svgMarkup(page, doc.assets, targets, getExportOptions(), doc.fonts))
      setMessage(copied ? null : 'クリップボードへコピーできませんでした')
      return copied
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'SVG のコピーに失敗しました')
      return false
    }
  }

  /** 画像のノードに埋め込んである、元のファイルを保存する */
  function saveImage(nodeId: NodeId) {
    const node = page?.nodes[nodeId]
    const asset = node?.type === 'image' ? doc?.assets[node.assetId] : undefined
    if (!node || !asset) return
    try {
      downloadBlob(assetBlob(asset), `${safeFileName(node.name)}.${imageExtension(asset.mime)}`)
      setMessage(null)
    } catch {
      setMessage('画像を保存できませんでした')
    }
  }

  /** kdr に埋め込んである書体のファイルを、元の形式のまま保存する（コピー用の CSS の @font-face が指す名前で） */
  function saveFont(font: EmbeddedFont) {
    const asset = doc && Object.hasOwn(doc.assets, font.assetId) ? doc.assets[font.assetId] : undefined
    if (!asset) return
    try {
      downloadBlob(assetBlob(asset), fontFileName(font, asset.mime))
      setMessage(null)
    } catch {
      setMessage('書体ファイルを保存できませんでした')
    }
  }

  /** ノードを、中身まで含めた HTML ファイルとして保存する。画像と書体は埋め込む */
  function saveHtml(nodeId: NodeId, style: CodeStyle) {
    if (!doc || !page) return
    const node = page.nodes[nodeId]
    // ファイルはブラウザで開いて見比べるためのものなので、出力形式によらず HTML + CSS にする
    const markup = nodeMarkup(page, nodeId, {
      style: { ...style, format: 'html' },
      assets: doc.assets,
      images: 'embed',
      fonts: doc.fonts,
    })
    const file = new Blob([standaloneHtml(node.name, markup)], { type: 'text/html' })
    downloadBlob(file, `${safeFileName(node.name)}.html`)
  }

  /** 選んでいるインスタンスの元を選ぶ。元が別のページにあれば、そのページへ切り替える */
  function goToMain(nodeId: NodeId) {
    if (!doc || !page) return
    const instance = instanceOf(page, nodeId)
    const main = instance && findMain(doc, instance.component.id)
    if (!main) return
    setPageId(main.page.id)
    setSelection([main.node.id])
    camera.reveal(getAbsoluteBounds(main.page, main.node.id))
  }

  /** ダブルクリックした所のフレーム（図形なら、それを含むいちばん近いフレーム）を画面いっぱいに表示する */
  function fitAt(nodeId: NodeId | null) {
    if (!page || nodeId === null) return
    let target = page.nodes[nodeId]
    while (target.type !== 'frame' && target.parentId !== null) target = page.nodes[target.parentId]
    camera.fit(getAbsoluteBounds(page, target.id))
  }

  const dragging = useFileDrop((files) => openFile(files[0]))

  return (
    <div className="app" data-mode="viewer">
      <header className="app-header">
        <Logo className="app-logo" />
        <span className="app-mode">viewer</span>
        {doc && <span className="document-name">{doc.name}</span>}
        <div className="app-header-spacer" />
        {page && <ZoomControls camera={camera} getContentBounds={() => getContentBounds(page)} />}
        {page && (
          <button
            type="button"
            title="いまのページと選択を指すアドレスをコピー（受け取った人が同じ kdr を開くと、そこから始まる）"
            onClick={async () => setLinkCopied(await copyText(window.location.href))}
          >
            {linkCopied ? 'コピーしました' : 'リンクをコピー'}
          </button>
        )}
        <OpenFileButton onFiles={(files) => openFile(files[0])} className={doc ? undefined : 'primary'}>
          kdr を開く
        </OpenFileButton>
      </header>
      <Message text={message} onClose={() => setMessage(null)} />
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
                        setSelection([])
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
                        onClick={() => exportPng([frame.id])}
                      >
                        PNG
                      </button>
                      <button
                        type="button"
                        className="frame-export"
                        title="このフレームを SVG に書き出し"
                        aria-label={`${frame.name} を SVG に書き出し`}
                        onClick={() => exportSvg([frame.id])}
                      >
                        SVG
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section className="panel-section" aria-label="書き出し">
              <h3 className="section-title">書き出し</h3>
              <ExportControls scale={scale} onScaleChange={setScale} onExport={() => exportPng()} onExportSvg={() => exportSvg()} onCopySvg={() => copySvg()}>
                ページを PNG に
              </ExportControls>
            </section>
            {page.rootIds.length > 0 && (
              <section aria-label="レイヤー">
                <h2 className="panel-title">レイヤー</h2>
                <LayerTree key={page.id} scene={page} selection={selection} onSelect={selectAndReveal} />
              </section>
            )}
          </aside>
        )}
        <main className="app-main">
          {doc && page ? (
            <ViewerCanvas
              page={page}
              assets={doc.assets}
              camera={camera}
              selection={selection}
              onSelect={select}
              onFit={fitAt}
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
            selection={selection}
            scale={scale}
            onScaleChange={setScale}
            onExport={() => exportPng(selection)}
            onExportSvg={() => exportSvg(selection)}
            onCopySvg={() => copySvg(selection)}
            onSelect={selectAndReveal}
            onSelectNodes={selectNodes}
            onSaveImage={() => selectedId && saveImage(selectedId)}
            onSaveFont={saveFont}
            onSaveHtml={(style) => selectedId && saveHtml(selectedId, style)}
            onGoToMain={() => selectedId && goToMain(selectedId)}
          />
        )}
      </div>
    </div>
  )
}
