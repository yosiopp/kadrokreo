import type { Point } from '../document/geometry.ts'
import type { NodeId, Scene } from '../document/types.ts'
import { type HitOptions, hitTest, hitTestFrameLabel } from './hitTest.ts'
import { measureFrameLabel } from './measure.ts'
import type { Viewport } from './viewport.ts'

/** 小さな図形をつかみやすくするための遊び（画面ピクセル） */
export const HIT_TOLERANCE = 3

/**
 * ポインタの下で最も手前にあるノード。ページ直下のフレームは、名前のラベルでも当たる。
 * editor の選択と、viewer の選択の両方が使う。
 */
export function pickNode(
  scene: Scene,
  viewport: Viewport,
  pointer: { screen: Point; world: Point },
  options: Omit<HitOptions, 'tolerance'> = {},
): NodeId | null {
  return (
    hitTestFrameLabel(scene, viewport, pointer.screen, measureFrameLabel, options) ??
    hitTest(scene, pointer.world, { ...options, tolerance: HIT_TOLERANCE / viewport.zoom })
  )
}
