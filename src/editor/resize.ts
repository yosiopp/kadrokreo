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

const HANDLE_ANGLES: Record<Handle, number> = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 }
const CURSORS = ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize']

/** rotation は枠の向き（度）。回した枠では、ハンドルを引く向きに合うカーソルにする */
export function handleCursor(handle: Handle, rotation = 0): string {
  const angle = (((HANDLE_ANGLES[handle] + rotation) % 180) + 180) % 180
  return CURSORS[Math.round(angle / 45) % 4]
}

/**
 * ハンドルを (dx, dy) だけ引いたときの矩形。反対側の辺を越えて引くと裏返る。
 * keepAspect のとき、辺のハンドルではもう一方の向きを中央を保ったまま伸縮する。
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

  if (keepAspect && start.width > 0 && start.height > 0) {
    if (handle.length === 2) {
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
    } else if (handle === 'e' || handle === 'w') {
      const height = (start.height * Math.abs(right - left)) / start.width
      top = start.y + (start.height - height) / 2
      bottom = top + height
    } else {
      const width = (start.width * Math.abs(bottom - top)) / start.height
      left = start.x + (start.width - width) / 2
      right = left + width
    }
  }

  return {
    x: Math.min(left, right),
    y: Math.min(top, bottom),
    width: Math.max(1, Math.abs(right - left)),
    height: Math.max(1, Math.abs(bottom - top)),
  }
}
