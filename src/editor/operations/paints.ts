import { isLine } from '../../document/path.ts'
import { compactRadius, cornerRadii } from '../../document/paint.ts'
import type { ColorStop, Effect, Gradient, NodeId, Paint, Scene, SceneNode } from '../../document/types.ts'
import { patchNodes } from './tree.ts'

// 塗り・線・影の変更。塗りの配列は先頭が一番下（いちばん上に見えるのは最後の要素）

/** 塗りの配列を持つ項目 */
export type PaintKey = 'fills' | 'strokes'

/** 塗りの種類 */
export type PaintType = Paint['type']

/** 塗り・線・影の数の上限（kdr の読み込みと同じ） */
export const MAX_PAINTS = 16
/** グラデーションの色の数の上限（kdr の読み込みと同じ） */
export const MAX_STOPS = 16

/** index 番目（負なら後ろから）の色を変えたグラデーション */
export function withStopColor<G extends Gradient>(gradient: G, index: number, color: string): G {
  const at = index < 0 ? gradient.stops.length + index : index
  return { ...gradient, stops: gradient.stops.with(at, { ...gradient.stops[at], color }) }
}

/** index 番目の色の位置を変えたグラデーション。位置の順に並べ直す */
export function withStopOffset<G extends Gradient>(gradient: G, index: number, offset: number): G {
  const clamped = Math.min(1, Math.max(0, offset))
  const stops = gradient.stops.with(index, { ...gradient.stops[index], offset: clamped })
  return { ...gradient, stops: sortStops(stops) }
}

/** 位置の順に並べる（同じ位置なら元の順） */
function sortStops(stops: readonly ColorStop[]): ColorStop[] {
  return stops.toSorted((a, b) => a.offset - b.offset)
}

/** いちばん離れている隣どうしの色の間に、間の色を 1 つ足したグラデーション。上限なら変えない */
export function withStopAdded<G extends Gradient>(gradient: G): G {
  const { stops } = gradient
  if (stops.length >= MAX_STOPS) return gradient
  let at = 0
  for (let i = 1; i < stops.length - 1; i++) {
    if (stops[i + 1].offset - stops[i].offset > stops[at + 1].offset - stops[at].offset) at = i
  }
  const offset = Math.round(((stops[at].offset + stops[at + 1].offset) / 2) * 1000) / 1000
  const color = mixColor(stops[at].color, stops[at + 1].color)
  return { ...gradient, stops: stops.toSpliced(at + 1, 0, { offset, color }) }
}

/** index 番目の色を取り除いたグラデーション。2 色より減らさない */
export function withStopRemoved<G extends Gradient>(gradient: G, index: number): G {
  if (gradient.stops.length <= 2) return gradient
  return { ...gradient, stops: gradient.stops.toSpliced(index, 1) }
}

/** 2 つの #rrggbb の中間の色 */
function mixColor(a: string, b: string): string {
  const channel = (color: string, i: number) => parseInt(color.slice(1 + i * 2, 3 + i * 2), 16)
  return `#${[0, 1, 2].map((i) => Math.round((channel(a, i) + channel(b, i)) / 2).toString(16).padStart(2, '0')).join('')}`
}

/**
 * 塗りの種類を変える。色はできるだけ受け継ぐ: 単色からグラデーションにするとその色から白へ、
 * グラデーションから単色にすると始まりの色、グラデーションどうしは色の並びをそのまま使う
 */
export function convertPaint(paint: Paint, type: PaintType): Paint {
  if (paint.type === type) return paint
  if (type === 'solid') return { type, color: paint.type === 'solid' ? paint.color : paint.stops[0].color }
  const stops =
    paint.type === 'solid'
      ? [
          { offset: 0, color: paint.color },
          { offset: 1, color: '#ffffff' },
        ]
      : paint.stops
  return type === 'linear' ? { type, angle: 90, stops } : { type, cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5, stops }
}

/** from 番目の塗りを to 番目へ動かす */
export function movePaint<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || to < 0 || to >= list.length) return [...list]
  const moved = list.toSpliced(from, 1)
  return moved.toSpliced(to, 0, list[from])
}

/** 空にできない塗りか（テキストの塗りと直線の線） */
function required(node: SceneNode, key: PaintKey): boolean {
  return (key === 'fills' && node.type === 'text') || (key === 'strokes' && node.type === 'path' && isLine(node))
}

/**
 * 塗り（key）の配列を change で作り直す。key を持たないノードと change が null を返したノードは変えない。
 * テキストの塗りと直線の線は空にできないので、空にする変更は当てない。数は上限で止める
 */
export function updatePaints<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  key: PaintKey,
  change: (paints: readonly Paint[]) => Paint[] | null,
): T {
  return patchNodes(scene, ids, (node) => {
    if (!(key in node)) return null
    const paints = (node as unknown as Record<PaintKey, Paint[]>)[key]
    const next = change(paints)
    if (next === null || next.length > MAX_PAINTS) return null
    if (next.length === 0 && (paints.length === 0 || required(node, key))) return null
    return { [key]: next }
  })
}

/** index 番目（配列の番号。先頭が一番下）の塗りを change で書き換える。その番目がないノードは変えない */
export function patchPaintAt<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  key: PaintKey,
  index: number,
  change: (paint: Paint) => Paint,
): T {
  return updatePaints(scene, ids, key, (paints) => (index < paints.length ? paints.with(index, change(paints[index])) : null))
}

/** index 番目の塗りがグラデーションのノードだけ、そのグラデーションを書き換える */
export function patchGradientAt<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  key: PaintKey,
  index: number,
  change: (gradient: Gradient) => Gradient,
): T {
  return patchPaintAt(scene, ids, key, index, (paint) => (paint.type === 'solid' ? paint : change(paint)))
}

/** いちばん上の塗りを paint に置き換える（null なら取り除く）。塗りがなければ足す */
export function withTopPaint(paints: readonly Paint[], paint: Paint | null): Paint[] {
  const below = paints.slice(0, -1)
  return paint === null ? below : [...below, paint]
}

/**
 * 塗りの色を変える（null で塗りをなくす）。いちばん上の塗りがグラデーションなら始まりの色を変え、
 * 塗りをなくすとグラデーションもやめる。テキストは塗りを消せないので、null なら変えない
 */
export function setFill<T extends Scene>(scene: T, ids: readonly NodeId[], fill: string | null): T {
  return updatePaints(scene, ids, 'fills', (fills) => {
    if (fill === null) return withTopPaint(fills, null)
    const top = fills.at(-1)
    return withTopPaint(fills, top && top.type !== 'solid' ? withStopColor(top, 0, fill) : { type: 'solid', color: fill })
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

/** 効果の配列を change で作り直す。効果を持たないノードと change が null を返したノードは変えない。数は上限で止める */
export function updateEffects<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  change: (effects: readonly Effect[]) => Effect[] | null,
): T {
  return patchNodes(scene, ids, (node) => {
    if (!('effects' in node)) return null
    const next = change(node.effects)
    return next === null || next.length > MAX_PAINTS ? null : { effects: next }
  })
}

/** 影を付ける（null で外す）。最初の効果を置き換える */
export function setShadow<T extends Scene>(scene: T, ids: readonly NodeId[], shadow: Effect | null): T {
  return updateEffects(scene, ids, (effects) => {
    if (shadow === null) return effects.length === 0 ? null : effects.slice(1)
    return [shadow, ...effects.slice(1)]
  })
}

/** index 番目の影があるノードだけ、その影の一部を書き換える */
export function patchEffectAt<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  index: number,
  patch: Partial<Omit<Effect, 'type'>>,
): T {
  return updateEffects(scene, ids, (effects) =>
    index < effects.length ? effects.with(index, { ...effects[index], ...patch }) : null,
  )
}

/**
 * 角丸を変える。corner が null なら 4 隅とも value に、0〜3（左上・右上・右下・左下）ならその隅だけ。
 * 4 隅が揃えば数値 1 つにまとめる。角丸を持たないノードは変えない
 */
export function setCornerRadius<T extends Scene>(scene: T, ids: readonly NodeId[], corner: number | null, value: number): T {
  return patchNodes(scene, ids, (node) => {
    if (!('cornerRadius' in node)) return null
    if (corner === null) return { cornerRadius: value }
    return { cornerRadius: compactRadius(cornerRadii(node.cornerRadius).with(corner, value) as [number, number, number, number]) }
  })
}
