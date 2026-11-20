import { useState } from 'react'
import { CanvasView } from '../canvas/CanvasView.tsx'
import { createCamera } from '../canvas/camera.ts'
import { getContentBounds } from '../document/geometry.ts'
import { decodeKdr } from '../document/kdr.ts'
import type { DesignDocument } from '../document/types.ts'
import { OpenFileButton } from '../ui/OpenFile.tsx'
import { ZoomControls } from '../ui/ZoomControls.tsx'
import { useFileDrop } from '../ui/useFileDrop.ts'

export default function ViewerApp() {
  const [camera] = useState(createCamera)
  const [doc, setDoc] = useState<DesignDocument | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function openFile(file: File) {
    try {
      const next = await decodeKdr(file)
      setDoc(next)
      camera.fit(getContentBounds(next))
      setMessage(null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'ファイルを開けませんでした')
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
        {doc && <ZoomControls camera={camera} getContentBounds={() => getContentBounds(doc)} />}
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
      <main className="app-main">
        {doc ? (
          <CanvasView document={doc} camera={camera} panWithPrimaryButton />
        ) : (
          <div className="empty-state">
            <p>kdr ファイルを開くと、ここにデザインが表示されます。</p>
            <p>「kdr を開く」から選ぶか、このウィンドウにファイルをドロップしてください。</p>
          </div>
        )}
        {dragging && <div className="drop-overlay">kdr ファイルをドロップして開く</div>}
      </main>
    </div>
  )
}
