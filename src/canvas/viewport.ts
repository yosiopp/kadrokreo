import type { Bounds, Point, Size } from '../document/geometry.ts'

/** x, y は画面左上に映っているページ座標。screen = (world - {x, y}) * zoom */
export type Viewport = { x: number; y: number; zoom: number }

export const MIN_ZOOM = 0.02
export const MAX_ZOOM = 64

export function screenToWorld(v: Viewport, p: Point): Point {
  return { x: v.x + p.x / v.zoom, y: v.y + p.y / v.zoom }
}

export function worldToScreen(v: Viewport, p: Point): Point {
  return { x: (p.x - v.x) * v.zoom, y: (p.y - v.y) * v.zoom }
}

export function panBy(v: Viewport, dx: number, dy: number): Viewport {
  return { ...v, x: v.x - dx / v.zoom, y: v.y - dy / v.zoom }
}

/** 画面上の anchor に映っているページ座標を動かさずにズームする */
export function zoomAt(v: Viewport, anchor: Point, zoom: number): Viewport {
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
  const world = screenToWorld(v, anchor)
  return { x: world.x - anchor.x / next, y: world.y - anchor.y / next, zoom: next }
}

/** bounds 全体が余白つきで収まるビューポート。等倍より大きくはしない */
export function fitBounds(bounds: Bounds, view: Size, padding = 48): Viewport {
  const availableWidth = Math.max(1, view.width - padding * 2)
  const availableHeight = Math.max(1, view.height - padding * 2)
  const zoom = Math.min(
    1,
    Math.max(
      MIN_ZOOM,
      Math.min(
        availableWidth / Math.max(1, bounds.width),
        availableHeight / Math.max(1, bounds.height),
      ),
    ),
  )
  return {
    x: bounds.x + bounds.width / 2 - view.width / 2 / zoom,
    y: bounds.y + bounds.height / 2 - view.height / 2 / zoom,
    zoom,
  }
}
