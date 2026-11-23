import { type Point, type Size, applyMatrix, getWorldMatrix, invert, normalizeAngle } from '../../document/geometry.ts'
import { gradientLine, radialTransform } from '../../document/paint.ts'
import type { Gradient, NodeId, Paint, Scene, SceneNode } from '../../document/types.ts'
import { type PaintKey, withStopOffset } from '../operations/paints.ts'

// キャンバスでグラデーションを動かすハンドルの位置と、つかんで動かしたときのグラデーション。
// 直線は始点・終点をつかんで、それぞれ自由に置く（Shift で、もう一方の端を中心に向きを 15° 刻みにする）。
// 円形は中心と、横・縦の半径の先をつかむ（半径の先を回すと楕円も回る）。角度は中心と、最初の色の向きを示す先（end）をつかむ。
// 色の位置（停止点）は、直線は始点から終点、円形は中心から横の半径の先、角度は中心から向きの先の線の上を動く（既存のデザインツールと同じ）

/** キャンバスで動かしているグラデーション。stop は選んでいる色の番号（なければ null） */
export type GradientEdit = { id: NodeId; key: PaintKey; index: number; stop: number | null }

/** つかめる所。start / end は直線の両端、center / radiusX / radiusY は円形の中心と半径の先、stop は色の位置 */
export type GradientPart =
  | { kind: 'start' }
  | { kind: 'end' }
  | { kind: 'center' }
  | { kind: 'radiusX' }
  | { kind: 'radiusY' }
  | { kind: 'stop'; index: number }

/** ハンドルの位置（ノードの座標系）。axis は色が並ぶ線の両端（直線は始点・終点、円形は中心と横の半径の先） */
export type GradientHandles = {
  axis: [Point, Point]
  /** 円形の縦の半径の先。直線なら null */
  radiusY: Point | null
  stops: Point[]
}

/** 編集しているノードの塗りが今もグラデーションなら、それ */
export function editedGradient(scene: Scene, edit: GradientEdit): Gradient | null {
  const node = scene.nodes[edit.id]
  if (!node || !(edit.key in node)) return null
  const paint = (node as unknown as Record<PaintKey, Paint[]>)[edit.key][edit.index]
  return paint && paint.type !== 'solid' ? paint : null
}

/** ノードの座標系でのハンドルの位置 */
export function gradientHandles(gradient: Gradient, size: Size): GradientHandles {
  let axis: [Point, Point]
  let radiusY: Point | null = null
  if (gradient.type === 'linear') {
    axis = gradientLine(gradient, size)
  } else if (gradient.type === 'conic') {
    const center = { x: gradient.cx * size.width, y: gradient.cy * size.height }
    const length = conicHandleLength(size)
    const radians = (gradient.angle * Math.PI) / 180
    axis = [center, { x: center.x + Math.cos(radians) * length, y: center.y + Math.sin(radians) * length }]
  } else {
    // 半径の先は、回す角度（angle）だけ回した楕円の軸の上
    const [a, b, c, d, cx, cy] = radialTransform(gradient, size)
    axis = [{ x: cx, y: cy }, { x: cx + a, y: cy + b }]
    radiusY = { x: cx + c, y: cy + d }
  }
  const [from, to] = axis
  const stops = gradient.stops.map((stop) => ({
    x: from.x + (to.x - from.x) * stop.offset,
    y: from.y + (to.y - from.y) * stop.offset,
  }))
  return { axis, radiusY, stops }
}

/** 角度のグラデーションの、中心から向きの先のハンドルまでの長さ（枠の短い辺の半分。つぶれた枠なら長い辺の半分） */
function conicHandleLength(size: Size): number {
  const short = Math.min(size.width, size.height) / 2
  return short > 0 ? short : Math.max(size.width, size.height) / 2
}

/** 色の印を、色が並ぶ線からどれだけ横へ離して出すか（画面ピクセル） */
const STOP_MARKER_OFFSET = 18

/**
 * 色の印の位置（画面座標）。線の上に置くと両端の色が始点・終点のハンドルと重なってつかみ分けられないので、
 * 線の向きの左側（左から右の線なら上）へ離して並べる。points は線の上の色の位置（画面座標）
 */
export function stopMarkers(axis: readonly [Point, Point], points: readonly Point[]): Point[] {
  const [from, to] = axis
  const length = Math.hypot(to.x - from.x, to.y - from.y)
  const normal = length === 0 ? { x: 0, y: -1 } : { x: (to.y - from.y) / length, y: -(to.x - from.x) / length }
  return points.map((point) => ({ x: point.x + normal.x * STOP_MARKER_OFFSET, y: point.y + normal.y * STOP_MARKER_OFFSET }))
}

/** ページ座標でのハンドルの位置 */
export function worldGradientHandles(scene: Scene, id: NodeId, gradient: Gradient): GradientHandles {
  const node = scene.nodes[id]
  const matrix = getWorldMatrix(scene, id)
  const local = gradientHandles(gradient, node)
  const map = (point: Point) => applyMatrix(matrix, point)
  return {
    axis: [map(local.axis[0]), map(local.axis[1])],
    radiusY: local.radiusY && map(local.radiusY),
    stops: local.stops.map(map),
  }
}

/**
 * 近くにあるハンドル。near はハンドルの位置がポインタに十分近いか。handles の stops には色の印の位置（stopMarkers）を渡す。
 * 色の印を先に調べる（手前に描くので）
 */
export function gradientPartAt(
  handles: GradientHandles,
  gradient: Gradient,
  near: (point: Point) => boolean,
): GradientPart | null {
  // 手前に描く（後ろの番号）ものから調べる
  for (let i = handles.stops.length - 1; i >= 0; i--) {
    if (near(handles.stops[i])) return { kind: 'stop', index: i }
  }
  if (gradient.type === 'linear') {
    if (near(handles.axis[1])) return { kind: 'end' }
    if (near(handles.axis[0])) return { kind: 'start' }
    return null
  }
  if (gradient.type === 'conic') {
    if (near(handles.axis[1])) return { kind: 'end' }
    if (near(handles.axis[0])) return { kind: 'center' }
    return null
  }
  if (near(handles.axis[0])) return { kind: 'center' }
  if (near(handles.axis[1])) return { kind: 'radiusX' }
  if (handles.radiusY && near(handles.radiusY)) return { kind: 'radiusY' }
  return null
}

/** 色が並ぶ線の上で、point（ノードの座標系）に最も近い位置（0〜1）と、線からの距離 */
export function offsetOnAxis(handles: GradientHandles, point: Point): { offset: number; distance: number } {
  const [from, to] = handles.axis
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = dx * dx + dy * dy
  const t = length === 0 ? 0 : Math.min(1, Math.max(0, ((point.x - from.x) * dx + (point.y - from.y) * dy) / length))
  const distance = Math.hypot(from.x + dx * t - point.x, from.y + dy * t - point.y)
  return { offset: t, distance }
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits

/**
 * つかんだ所を point（ノードの座標系）へ動かしたグラデーション。base はつかんだときのグラデーションで、
 * いつも base から作り直す（色の位置を動かすと並べ直すので、途中の結果から作ると番号がずれる）。
 * constrain（Shift）は、直線の向き（もう一方の端を中心に）と角度の向きを 15° 刻みにし、円形の半径を縦横で揃える（円にする）。
 * 返す stop は、動かしたあとの選んでいる色の番号
 */
export function dragGradient(
  base: Gradient,
  part: GradientPart,
  point: Point,
  size: Size,
  constrain: boolean,
): { gradient: Gradient; stop: number | null } {
  if (part.kind === 'stop') {
    const offset = round(offsetOnAxis(gradientHandles(base, size), point).offset, 3)
    const moved = withStopOffset(base, part.index, offset)
    // 並べ直したあとの番号（withStopOffset と同じ、位置の順で同じ位置なら元の順）
    const order = base.stops
      .map((stop, i) => ({ i, offset: i === part.index ? offset : stop.offset }))
      .toSorted((a, b) => a.offset - b.offset)
    return { gradient: moved, stop: order.findIndex((entry) => entry.i === part.index) }
  }
  if (base.type === 'linear') {
    if ((part.kind !== 'start' && part.kind !== 'end') || size.width === 0 || size.height === 0) return { gradient: base, stop: null }
    let target = point
    if (constrain) {
      // もう一方の端を中心に、長さを保って向きを 15° 刻みにする
      const [from, to] = gradientLine(base, size)
      const pivot = part.kind === 'end' ? from : to
      const dx = point.x - pivot.x
      const dy = point.y - pivot.y
      const length = Math.hypot(dx, dy)
      const step = (Math.round((Math.atan2(dy, dx) * 180) / Math.PI / 15) * 15 * Math.PI) / 180
      target = { x: pivot.x + Math.cos(step) * length, y: pivot.y + Math.sin(step) * length }
    }
    const x = round(target.x / size.width, 4)
    const y = round(target.y / size.height, 4)
    return { gradient: part.kind === 'end' ? { ...base, x2: x, y2: y } : { ...base, x1: x, y1: y }, stop: null }
  }
  if (base.type === 'conic') {
    if (part.kind === 'center') {
      if (size.width === 0 || size.height === 0) return { gradient: base, stop: null }
      return { gradient: { ...base, cx: round(point.x / size.width, 4), cy: round(point.y / size.height, 4) }, stop: null }
    }
    if (part.kind !== 'end') return { gradient: base, stop: null }
    const dx = point.x - base.cx * size.width
    const dy = point.y - base.cy * size.height
    if (dx === 0 && dy === 0) return { gradient: base, stop: null }
    const degrees = (Math.atan2(dy, dx) * 180) / Math.PI
    return { gradient: { ...base, angle: normalizeAngle(constrain ? Math.round(degrees / 15) * 15 : Math.round(degrees)) }, stop: null }
  }
  if (size.width === 0 || size.height === 0) return { gradient: base, stop: null }
  switch (part.kind) {
    case 'center':
      return { gradient: { ...base, cx: round(point.x / size.width, 4), cy: round(point.y / size.height, 4) }, stop: null }
    case 'radiusX':
    case 'radiusY': {
      // 半径の先は、中心からの距離が半径、向きが楕円の回す角度になる（縦の半径の先は、回す角度より 90° 先）。
      // Shift なら縦横の半径を揃え（円にする）、向きを 15° 刻みにする
      const dx = point.x - base.cx * size.width
      const dy = point.y - base.cy * size.height
      const px = Math.hypot(dx, dy)
      if (px === 0) return { gradient: base, stop: null }
      const degrees = (Math.atan2(dy, dx) * 180) / Math.PI - (part.kind === 'radiusY' ? 90 : 0)
      const angle = normalizeAngle(constrain ? Math.round(degrees / 15) * 15 : round(degrees, 1))
      if (constrain) {
        return { gradient: { ...base, angle, rx: round(px / size.width, 4), ry: round(px / size.height, 4) }, stop: null }
      }
      return {
        gradient:
          part.kind === 'radiusX' ? { ...base, angle, rx: round(px / size.width, 4) } : { ...base, angle, ry: round(px / size.height, 4) },
        stop: null,
      }
    }
    default:
      return { gradient: base, stop: null }
  }
}

/** ページ座標の点を、ノードの座標系に直す */
export function toNodeSpace(scene: Scene, id: NodeId, world: Point): Point {
  return applyMatrix(invert(getWorldMatrix(scene, id)), world)
}

/**
 * ダブルクリックでキャンバスのグラデーションの操作に入るときの、動かす塗り。
 * 見えている塗りの中で手前（後ろの番号）のグラデーションを選び、塗りになければ線から探す（既存のデザインツールと同じく、ダブルクリックで操作に入る道）
 */
export function gradientToEdit(node: SceneNode): GradientEdit | null {
  for (const key of ['fills', 'strokes'] as const) {
    if (!(key in node)) continue
    const paints = (node as unknown as Record<PaintKey, Paint[]>)[key]
    for (let index = paints.length - 1; index >= 0; index--) {
      const paint = paints[index]
      if (paint.visible && paint.type !== 'solid') return { id: node.id, key, index, stop: null }
    }
  }
  return null
}
