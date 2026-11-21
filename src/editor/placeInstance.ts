import type { Camera } from '../canvas/camera.ts'
import { screenToWorld } from '../canvas/viewport.ts'
import type { Point } from '../document/geometry.ts'
import type { NodeId } from '../document/types.ts'
import { canHoldInstance, createInstance } from './components.ts'
import { findFrameAt } from './hitTest.ts'
import type { EditorStore } from './store.ts'

/** コンポーネント一覧の行のドラッグを、ページやレイヤー、ファイルのドラッグと区別するための種類 */
export const COMPONENT_DRAG_TYPE = 'application/x-kadrokreo-component'

// ドラッグの途中（dragover）では dataTransfer の中身を読めないので、ドラッグしているコンポーネントをここに覚えておく。
// 入る先のフレームを示すのに使う（置くときは dataTransfer の値を使う）
let dragged: string | null = null

/** コンポーネント一覧の行のドラッグを始めた・終えた */
export function setDraggedComponent(componentId: string | null): void {
  dragged = componentId
}

/** コンポーネント一覧からドラッグしているコンポーネント。ドラッグしていなければ null */
export function draggedComponent(): string | null {
  return dragged
}

/** 画面上の screen の位置（省くと画面の中央）の、ページ上の位置 */
function worldAt(camera: Camera, screen?: Point): Point {
  const size = camera.getSize()
  return screenToWorld(camera.getViewport(), screen ?? { x: size.width / 2, y: size.height / 2 })
}

/**
 * 画面上の screen の位置にインスタンスを置いたときに入るフレーム（ページ直下なら null）。
 * そこのフレームに入れられない（インスタンスの中や、循環する元の中）ならページ直下
 */
export function instanceDropTarget(store: EditorStore, camera: Camera, componentId: string, screen?: Point): NodeId | null {
  const { page, document } = store.getState()
  const parentId = findFrameAt(page, worldAt(camera, screen))
  return parentId !== null && canHoldInstance(document, page, parentId, componentId) ? parentId : null
}

/**
 * いまのページの、画面上の screen の位置（省くと画面の中央）を中心にインスタンスを置いて選ぶ。
 * そこにフレームがあればその中へ入れる（入れられないフレームなら、ページ直下に置く）。
 */
export function placeInstance(store: EditorStore, camera: Camera, componentId: string, screen?: Point): void {
  const center = worldAt(camera, screen)
  const { page } = store.getState()
  const parentId = instanceDropTarget(store, camera, componentId, screen)
  let id: string | null = null
  store.applyDocument((doc) => {
    const result = createInstance(doc, page.id, componentId, { center, parentId })
    id = result.id
    return result.document
  })
  if (id) store.select([id])
}
