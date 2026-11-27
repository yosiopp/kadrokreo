import { type Viewport, worldToScreen } from '../../canvas/viewport.ts'
import type { Point } from '../../document/geometry.ts'
import type { Page, PageGuide } from '../../document/types.ts'
import type { SnapLine } from '../snap.ts'

// ページのガイド線（ルーラーから引き出す縦・横の線）の操作。どれも新しいページを返し、変化がなければ同じ参照を返す

/** 1 ページに置けるガイド線の数（kdr の読み込みの上限と同じ） */
export const MAX_GUIDES = 1000

export function addGuide(page: Page, guide: PageGuide): Page {
  if (page.guides.length >= MAX_GUIDES) return page
  return { ...page, guides: [...page.guides, guide] }
}

export function moveGuide(page: Page, index: number, position: number): Page {
  const guide = page.guides[index]
  if (!guide || guide.position === position) return page
  return { ...page, guides: page.guides.with(index, { ...guide, position }) }
}

export function removeGuide(page: Page, index: number): Page {
  if (!page.guides[index]) return page
  return { ...page, guides: page.guides.toSpliced(index, 1) }
}

export function clearGuides(page: Page): Page {
  return page.guides.length === 0 ? page : { ...page, guides: [] }
}

/** 画面座標 screen から tolerance ピクセル以内にあるガイド線の番号（重なっていれば後に置いたもの）。無ければ null */
export function guideAt(page: Page, viewport: Viewport, screen: Point, tolerance: number): number | null {
  for (let index = page.guides.length - 1; index >= 0; index--) {
    const { axis, position } = page.guides[index]
    const at = worldToScreen(viewport, { x: position, y: position })
    if (Math.abs((axis === 'x' ? at.x : at.y) - (axis === 'x' ? screen.x : screen.y)) <= tolerance) return index
  }
  return null
}

/** 吸着の相手にするガイド線（端の無い線） */
export function guideSnapLines(page: Page): SnapLine[] {
  return page.guides.map(({ axis, position }) => ({ axis, position, from: -Infinity, to: Infinity }))
}
