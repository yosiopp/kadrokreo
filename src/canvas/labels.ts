import { type Point, applyMatrix, nodeMatrix, normalizeAngle } from '../document/geometry.ts'
import { type Viewport, worldToScreen } from './viewport.ts'

/** フレーム名ラベルの書体 */
export const FRAME_LABEL_FONT = '11px system-ui, sans-serif'
/** フレーム名ラベルの高さ（画面ピクセル）。フレームを囲む矩形の上辺のすぐ上に置く */
export const FRAME_LABEL_HEIGHT = 18

/**
 * 回した枠（幅 width・高さ height、時計回りに rotation 度）の 4 辺のうち、ラベルを沿わせる辺。
 * top は画面で上にある辺、bottom は下にある辺。from → to が文字の進む向きで、angle はその向き（度、-45 より大きく 45 以下）。
 * 文字が逆さや縦にならないよう、左から右へ読める向きに最も近い辺を選ぶ。
 * ラベルを置く外側は、top なら文字の上、bottom なら文字の下になる。点は枠の座標系（左上が原点）
 */
export function labelEdge(
  width: number,
  height: number,
  rotation: number,
  side: 'top' | 'bottom',
): { from: Point; to: Point; angle: number } {
  const corners = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ]
  // 角を時計回りにたどると、i 番目の辺（上・右・下・左）の向きは rotation + i * 90 度。下の辺は逆向きに読む
  for (let i = 0; i < 4; i++) {
    const angle = normalizeAngle(rotation + i * 90 + (side === 'bottom' ? 180 : 0))
    if (angle > -45 && angle <= 45) {
      const [a, b] = [corners[i], corners[(i + 1) % 4]]
      return side === 'top' ? { from: a, to: b, angle } : { from: b, to: a, angle }
    }
  }
  return { from: corners[0], to: corners[1], angle: 0 }
}

/**
 * ページ直下のフレームの名前ラベルの置き場所（画面座標）。origin が文字の始まり（辺の上）で、文字は angle 度傾けて辺の外側に出す。
 * 回したフレームでは、画面で上にある辺に沿わせる
 */
export function frameLabelPose(
  node: Point & { width: number; height: number; rotation: number },
  viewport: Viewport,
): { origin: Point; angle: number } {
  const edge = labelEdge(node.width, node.height, node.rotation, 'top')
  return { origin: worldToScreen(viewport, applyMatrix(nodeMatrix(node), edge.from)), angle: edge.angle }
}
