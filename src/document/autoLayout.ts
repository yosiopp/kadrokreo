import type { Scene, SceneNode } from './types.ts'

// オートレイアウトの設定を読む関数。並べる処理そのもの（書き換える側）は editor/layout.ts にある。
// viewer の CSS の出力も、子を親いっぱいに伸ばしているかを知るためにこれを使う

/**
 * node を、親が伸ばす向き。親が自動で並べていて、その向きに伸ばす指定があるときだけ。
 * 回っているものは伸ばさない。テキストは高さを中身で決めるので縦には伸ばさず、幅に合わせて折り返すものだけ横に伸ばす。
 * 親が中身に合わせて大きさを決める向き（並べる向き）では、伸ばす先がないので伸ばさない。
 */
export function stretchedAxes(scene: Scene, node: SceneNode): { width: boolean; height: boolean } {
  const parent = node.parentId === null ? null : scene.nodes[node.parentId]
  const none = { width: false, height: false }
  if (parent?.type !== 'frame' || !parent.layout || node.rotation !== 0 || !node.visible) return none
  if (node.layoutPositioning === 'absolute') return none
  const { direction, widthMode, heightMode } = parent.layout
  const width =
    node.layoutFill.width &&
    !(node.type === 'text' && node.autoWidth) &&
    !(direction === 'horizontal' && widthMode === 'hug')
  const height = node.layoutFill.height && node.type !== 'text' && !(direction === 'vertical' && heightMode === 'hug')
  return { width, height }
}

/**
 * node の大きさの下限・上限が効く向き。大きさを自動で決める向きだけ:
 * 親いっぱいに伸ばしている向きと、自動で並べるフレームが中身に合わせている向き。
 * 手で決めた（固定の）大きさには効かない（既存のデザインツールと同じ）
 */
export function sizeLimited(scene: Scene, node: SceneNode): { width: boolean; height: boolean } {
  const stretched = stretchedAxes(scene, node)
  const hug = (mode: 'widthMode' | 'heightMode') => node.type === 'frame' && node.layout?.[mode] === 'hug'
  return { width: stretched.width || hug('widthMode'), height: stretched.height || hug('heightMode') }
}

/** value を node の下限・上限に収める。下限と上限が食い違えば下限を優先する（CSS と同じ） */
export function clampSize(node: SceneNode, axis: 'width' | 'height', value: number): number {
  const min = axis === 'width' ? node.minWidth : node.minHeight
  const max = axis === 'width' ? node.maxWidth : node.maxHeight
  return Math.max(min ?? -Infinity, Math.min(max ?? Infinity, value))
}

/** 下限か上限を 1 つでも決めているか */
export function hasSizeLimits(node: SceneNode): boolean {
  return node.minWidth !== null || node.maxWidth !== null || node.minHeight !== null || node.maxHeight !== null
}

/** 自動で並べるフレームが、実際に折り返すか。並べる向きを中身に合わせていれば（親に伸ばされていなければ）折り返さない */
export function wraps(scene: Scene, frame: SceneNode): boolean {
  if (frame.type !== 'frame' || !frame.layout?.wrap) return false
  const horizontal = frame.layout.direction === 'horizontal'
  const mode = horizontal ? frame.layout.widthMode : frame.layout.heightMode
  return mode === 'fixed' || stretchedAxes(scene, frame)[horizontal ? 'width' : 'height']
}
