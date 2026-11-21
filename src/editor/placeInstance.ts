import type { Camera } from '../canvas/camera.ts'
import { screenToWorld } from '../canvas/viewport.ts'
import type { Point } from '../document/geometry.ts'
import { createInstance } from './components.ts'
import { findFrameAt } from './hitTest.ts'
import type { EditorStore } from './store.ts'

/** コンポーネント一覧の行のドラッグを、ページやレイヤー、ファイルのドラッグと区別するための種類 */
export const COMPONENT_DRAG_TYPE = 'application/x-kadrokreo-component'

/**
 * いまのページの、画面上の screen の位置（省くと画面の中央）を中心にインスタンスを置いて選ぶ。
 * そこにフレームがあればその中へ入れる（入れられないフレームなら、ページ直下に置く）。
 */
export function placeInstance(store: EditorStore, camera: Camera, componentId: string, screen?: Point): void {
  const size = camera.getSize()
  const center = screenToWorld(camera.getViewport(), screen ?? { x: size.width / 2, y: size.height / 2 })
  const { page } = store.getState()
  const parentId = findFrameAt(page, center)
  let id: string | null = null
  store.applyDocument((doc) => {
    const result = createInstance(doc, page.id, componentId, { center, parentId })
    id = result.id
    return result.document
  })
  if (id) store.select([id])
}
