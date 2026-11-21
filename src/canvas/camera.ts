import type { Bounds, Point, Size } from '../document/geometry.ts'
import { type Viewport, fitBounds, panBy, revealBounds, zoomAt } from './viewport.ts'

export type Camera = ReturnType<typeof createCamera>

/** ビューポートと表示領域のサイズを持つ。React の外に置いて、パンやズームで再レンダーを起こさない */
export function createCamera() {
  let viewport: Viewport = { x: 0, y: 0, zoom: 1 }
  let size: Size = { width: 0, height: 0 }
  // 表示領域のサイズが決まる前に fit を頼まれたら、決まった時点で実行する
  let pendingFit: Bounds | null = null
  const listeners = new Set<() => void>()

  function set(next: Viewport) {
    viewport = next
    for (const listener of listeners) listener()
  }

  const center = (): Point => ({ x: size.width / 2, y: size.height / 2 })

  return {
    getViewport: () => viewport,
    getSize: () => size,

    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    setSize(next: Size) {
      size = next
      if (pendingFit && next.width > 0 && next.height > 0) {
        const bounds = pendingFit
        pendingFit = null
        set(fitBounds(bounds, size))
      }
    },

    /** 保存しておいた表示位置に戻す */
    setViewport(next: Viewport) {
      pendingFit = null
      set(next)
    },

    panBy(dx: number, dy: number) {
      set(panBy(viewport, dx, dy))
    },

    zoomAt(anchor: Point, zoom: number) {
      set(zoomAt(viewport, anchor, zoom))
    },

    /** 画面中央を基準にズームする */
    zoomTo(zoom: number) {
      set(zoomAt(viewport, center(), zoom))
    },

    fit(bounds: Bounds | null) {
      if (!bounds) {
        pendingFit = null
        set({ x: -size.width / 2, y: -size.height / 2, zoom: 1 })
      } else if (size.width === 0 || size.height === 0) {
        pendingFit = bounds
      } else {
        set(fitBounds(bounds, size))
      }
    },

    /** bounds が画面に入っていなければ、見える位置へ動かす */
    reveal(bounds: Bounds) {
      if (size.width === 0 || size.height === 0) return
      const next = revealBounds(viewport, bounds, size)
      if (next !== viewport) set(next)
    },
  }
}
