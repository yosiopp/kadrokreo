import type { Scene, SceneNode } from './types.ts'

// オートレイアウトの設定を読む関数。並べる処理そのもの（書き換える側）は editor/layout.ts にある。
// viewer の CSS の出力も、子を親いっぱいに伸ばしているかを知るためにこれを使う

/**
 * node を、親が伸ばす向き。sizing が fill で、親が自動で並べているときだけ。
 * 回っているもの・非表示のもの・並びから外したものは伸ばさない。テキストの高さは中身で決まるので、sizing の型の上で fill にならない。
 * 親が中身に合わせて大きさを決める向き（並べる向き）では、伸ばす先がないので伸ばさない。
 */
export function stretchedAxes(scene: Scene, node: SceneNode): { width: boolean; height: boolean } {
  const parent = node.parentId === null ? null : scene.nodes[node.parentId]
  const none = { width: false, height: false }
  if (parent?.type !== 'frame' || !parent.layout || node.rotation !== 0 || !node.visible) return none
  if (node.layoutPositioning === 'absolute') return none
  const { direction } = parent.layout
  const width = node.sizing.width === 'fill' && !(direction === 'horizontal' && parent.sizing.width === 'hug')
  const height = node.sizing.height === 'fill' && !(direction === 'vertical' && parent.sizing.height === 'hug')
  return { width, height }
}

/** 自動で並べるフレームが、その向きの大きさを中身に合わせているか */
export function hugs(node: SceneNode, axis: 'width' | 'height'): boolean {
  return node.type === 'frame' && node.layout !== null && node.sizing[axis] === 'hug'
}

/**
 * node の大きさの下限・上限が効く向き。大きさを自動で決める向きだけ:
 * 親いっぱいに伸ばしている向きと、自動で並べるフレームやテキストが中身に合わせている向き
 * （テキストの幅は上限で折り返す。テキストの高さは中身で決まるので数えない）。
 * 手で決めた（固定の）大きさには効かない（既存のデザインツールと同じ）
 */
export function sizeLimited(scene: Scene, node: SceneNode): { width: boolean; height: boolean } {
  const stretched = stretchedAxes(scene, node)
  const textHug = node.type === 'text' && node.sizing.width === 'hug'
  return { width: stretched.width || hugs(node, 'width') || textHug, height: stretched.height || hugs(node, 'height') }
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

/** 自動で並べるフレームが、実際に折り返すか。並べる向きを中身に合わせていれば折り返さない */
export function wraps(frame: SceneNode): boolean {
  if (frame.type !== 'frame' || !frame.layout?.wrap) return false
  const axis = frame.layout.direction === 'horizontal' ? 'width' : 'height'
  return frame.sizing[axis] !== 'hug'
}

/**
 * node が、親のフレームの大きさに追従する（constraints が効く）子か。
 * 親が自動で並べないフレームの子と、並びから外した子だけ（並びに加わっている子は、並べる側が位置を決める）
 */
export function followsConstraints(parent: SceneNode | undefined, node: SceneNode): boolean {
  return parent?.type === 'frame' && (parent.layout === null || node.layoutPositioning === 'absolute')
}
