import { useSyncExternalStore } from 'react'
import type { Bounds } from '../document/geometry.ts'
import type { Camera } from '../canvas/camera.ts'

type Props = {
  camera: Camera
  /** 「全体表示」で収める範囲 */
  getContentBounds: () => Bounds | null
}

export function ZoomControls({ camera, getContentBounds }: Props) {
  const zoom = useSyncExternalStore(camera.subscribe, () => camera.getViewport().zoom)
  return (
    <div className="zoom-controls">
      <button type="button" title="縮小" onClick={() => camera.zoomTo(zoom / 1.25)}>
        −
      </button>
      <button type="button" className="zoom-value" title="100% に戻す" onClick={() => camera.zoomTo(1)}>
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" title="拡大" onClick={() => camera.zoomTo(zoom * 1.25)}>
        +
      </button>
      <button type="button" title="全体を表示" onClick={() => camera.fit(getContentBounds())}>
        全体表示
      </button>
    </div>
  )
}
