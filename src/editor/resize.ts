import type { Bounds, Point } from '../document/geometry.ts'

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export function handlePoint(bounds: Bounds, handle: Handle): Point {
  const x = handle.includes('w')
    ? bounds.x
    : handle.includes('e')
      ? bounds.x + bounds.width
      : bounds.x + bounds.width / 2
  const y = handle.includes('n')
    ? bounds.y
    : handle.includes('s')
      ? bounds.y + bounds.height
      : bounds.y + bounds.height / 2
  return { x, y }
}

export function handleCursor(handle: Handle): string {
  if (handle === 'n' || handle === 's') return 'ns-resize'
  if (handle === 'e' || handle === 'w') return 'ew-resize'
  return handle === 'nw' || handle === 'se' ? 'nwse-resize' : 'nesw-resize'
}

/**
 * ハンドルを (dx, dy) だけ引いたときの矩形。反対側の辺を越えて引くと裏返る。
 * keepAspect は角のハンドルでのみ効く。
 */
export function resizeBounds(
  start: Bounds,
  handle: Handle,
  dx: number,
  dy: number,
  keepAspect = false,
): Bounds {
  let left = start.x
  let right = start.x + start.width
  let top = start.y
  let bottom = start.y + start.height
  if (handle.includes('w')) left += dx
  if (handle.includes('e')) right += dx
  if (handle.includes('n')) top += dy
  if (handle.includes('s')) bottom += dy

  if (keepAspect && handle.length === 2 && start.width > 0 && start.height > 0) {
    const scale = Math.max(
      Math.abs(right - left) / start.width,
      Math.abs(bottom - top) / start.height,
    )
    const width = start.width * scale * (right < left ? -1 : 1)
    const height = start.height * scale * (bottom < top ? -1 : 1)
    if (handle.includes('w')) left = right - width
    else right = left + width
    if (handle.includes('n')) top = bottom - height
    else bottom = top + height
  }

  return {
    x: Math.min(left, right),
    y: Math.min(top, bottom),
    width: Math.max(1, Math.abs(right - left)),
    height: Math.max(1, Math.abs(bottom - top)),
  }
}
