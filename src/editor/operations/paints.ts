import type { Effect, LinearGradient, NodeId, Paint, Scene } from '../../document/types.ts'
import { patchNodes } from './tree.ts'

// 塗り・線・影の変更

/** index 番目（負なら後ろから）の色を変えたグラデーション */
export function withStopColor(gradient: LinearGradient, index: number, color: string): LinearGradient {
  const at = index < 0 ? gradient.stops.length + index : index
  return { ...gradient, stops: gradient.stops.with(at, { ...gradient.stops[at], color }) }
}

/** いちばん上の塗りを paint に置き換える（null なら取り除く）。塗りがなければ足す */
export function withTopPaint(paints: readonly Paint[], paint: Paint | null): Paint[] {
  const below = paints.slice(0, -1)
  return paint === null ? below : [...below, paint]
}

// プロパティパネルは、いちばん上の塗りと最初の影だけを編集する（複数の塗りや影を作る UI はまだない）

/**
 * 塗りの色を変える（null で塗りをなくす）。いちばん上の塗りがグラデーションなら始まりの色を変え、
 * 塗りをなくすとグラデーションもやめる。テキストは塗りを消せないので、null なら変えない
 */
export function setFill<T extends Scene>(scene: T, ids: readonly NodeId[], fill: string | null): T {
  return patchNodes(scene, ids, (node) => {
    if (!('fills' in node)) return null
    if (fill === null) return node.type === 'text' || node.fills.length === 0 ? null : { fills: withTopPaint(node.fills, null) }
    const top = node.fills.at(-1)
    const paint: Paint = top?.type === 'linear' ? withStopColor(top, 0, fill) : { type: 'solid', color: fill }
    return { fills: withTopPaint(node.fills, paint) }
  })
}

/**
 * いちばん上の塗りをグラデーションにする（enabled が false なら始まりの色の単色に戻す）。
 * 新しく付けるときは上から下へ、いまの色から白へ。塗りのない図形とテキストは変えない
 */
export function setGradientEnabled<T extends Scene>(scene: T, ids: readonly NodeId[], enabled: boolean): T {
  return patchNodes(scene, ids, (node) => {
    if (!('fills' in node) || node.type === 'text') return null
    const top = node.fills.at(-1)
    if (!top || (top.type === 'linear') === enabled) return null
    if (top.type === 'linear') return { fills: withTopPaint(node.fills, { type: 'solid', color: top.stops[0].color }) }
    const stops = [
      { offset: 0, color: top.color },
      { offset: 1, color: '#ffffff' },
    ]
    return { fills: withTopPaint(node.fills, { type: 'linear', angle: 90, stops }) }
  })
}

/** いちばん上の塗りがグラデーションの図形だけ、グラデーションを書き換える */
export function patchGradients<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  change: (gradient: LinearGradient) => LinearGradient,
): T {
  return patchNodes(scene, ids, (node) => {
    const top = 'fills' in node ? node.fills.at(-1) : undefined
    return top?.type === 'linear' && 'fills' in node ? { fills: withTopPaint(node.fills, change(top)) } : null
  })
}

/**
 * 線の色を変える（null で線をなくす）。いちばん上の線を単色に置き換える。
 * テキストと画像は線を持たないので変えない
 */
export function setStroke<T extends Scene>(scene: T, ids: readonly NodeId[], stroke: string | null): T {
  return patchNodes(scene, ids, (node) => {
    if (!('strokes' in node)) return null
    if (stroke === null) return node.strokes.length === 0 ? null : { strokes: withTopPaint(node.strokes, null) }
    return { strokes: withTopPaint(node.strokes, { type: 'solid', color: stroke }) }
  })
}

/** 影を付ける（null で外す）。最初の効果を置き換える */
export function setShadow<T extends Scene>(scene: T, ids: readonly NodeId[], shadow: Effect | null): T {
  return patchNodes(scene, ids, (node) => {
    if (!('effects' in node)) return null
    if (shadow === null) return node.effects.length === 0 ? null : { effects: node.effects.slice(1) }
    return { effects: [shadow, ...node.effects.slice(1)] }
  })
}

/** 影のある図形だけ、最初の影の一部を書き換える */
export function patchShadows<T extends Scene>(scene: T, ids: readonly NodeId[], patch: Partial<Omit<Effect, 'type'>>): T {
  return patchNodes(scene, ids, (node) =>
    'effects' in node && node.effects.length > 0
      ? { effects: node.effects.with(0, { ...node.effects[0], ...patch }) }
      : null,
  )
}
