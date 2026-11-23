import {
  type Bounds,
  type Point,
  applyMatrix,
  getAbsoluteBounds,
  getNodesBounds,
  getWorldCenter,
  getWorldMatrix,
  getWorldRotation,
  normalizeAngle,
  poseInParent,
  rotateVector,
  tidy,
} from '../../document/geometry.ts'
import { isLine } from '../../document/path.ts'
import { isInstance } from '../../document/component.ts'
import type { CornerRadius, NodeId, Paint, PathPoint, Scene, SceneNode } from '../../document/types.ts'
import { type NodePatch, patchNodes, topLevelIds, updateNode } from './tree.ts'

// 移動・回転・大きさの変更

/** dx, dy はページ上での移動量 */
export function translateNodes<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  dx: number,
  dy: number,
): T {
  if (dx === 0 && dy === 0) return scene
  return patchNodes(scene, topLevelIds(scene, ids), (node) => shifted(scene, node.id, dx, dy))
}

/** ページ上で (dx, dy) だけ動かしたときの x, y。親が回っていれば、親の向きに合わせて移動量を直す */
export function shifted(scene: Scene, id: NodeId, dx: number, dy: number): Point {
  const node = scene.nodes[id]
  const delta = rotateVector({ x: dx, y: dy }, -getWorldRotation(scene, node.parentId))
  return { x: tidy(node.x + delta.x), y: tidy(node.y + delta.y) }
}

/** ページ上の点 pivot を軸に、まとめて delta 度（時計回り）回す */
export function rotateNodes<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  pivot: Point,
  delta: number,
): T {
  if (delta === 0) return scene
  return patchNodes(scene, topLevelIds(scene, ids), (node) => {
    const center = getWorldCenter(scene, node.id)
    const arm = rotateVector({ x: center.x - pivot.x, y: center.y - pivot.y }, delta)
    const pose = poseInParent(
      scene,
      node.parentId,
      { x: pivot.x + arm.x, y: pivot.y + arm.y },
      getWorldRotation(scene, node.id) + delta,
      node,
    )
    return { x: pose.x, y: pose.y, rotation: pose.rotation }
  })
}

/**
 * ノードの枠を、いまのノードの座標系で表した box に変える。向きは変えない。
 * 回転したノードを、回転した軸に沿ってリサイズするのに使う。
 */
export function reshapeNode<T extends Scene>(scene: T, id: NodeId, box: Bounds): T {
  const node = scene.nodes[id]
  if (!node) return scene
  const center = applyMatrix(getWorldMatrix(scene, id), {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  })
  const size = { width: box.width, height: node.type === 'text' ? node.height : box.height }
  const pose = poseInParent(scene, node.parentId, center, getWorldRotation(scene, id), size)
  return updateNode(scene, id, { x: pose.x, y: pose.y, ...sizePatch(node, size.width, size.height) })
}

/**
 * 大きさを変えるパッチ。大きさが中身で決まるものは、変えた向きの決まり方も一緒に切り替える:
 * テキストは幅を変えると折り返しになり、自動で並べるフレームは変えた向きが「固定」になる
 * （そうしないと、すぐ中身に合わせた大きさへ戻ってしまう）。
 */
function sizePatch(node: SceneNode, width: number, height: number): NodePatch {
  if (node.type === 'text' && width === node.width) return {}
  const unhug = (axis: 'width' | 'height', value: number) =>
    node.sizing[axis] === 'hug' && value !== node[axis] ? 'fixed' : node.sizing[axis]
  // テキストの高さは常に中身で決まる（hug のまま）
  const sizing = { width: unhug('width', width), height: node.type === 'text' ? node.sizing.height : unhug('height', height) }
  const size = node.type === 'text' ? { width } : { width, height }
  if (sizing.width === node.sizing.width && sizing.height === node.sizing.height) return size
  return { ...size, sizing }
}

/** 幅や高さを数値で指定する。指定しなかった向きは変えない */
export function setSize<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  size: { width?: number; height?: number },
): T {
  return patchNodes(scene, ids, (node) =>
    sizePatch(node, size.width ?? node.width, size.height ?? node.height),
  )
}

/**
 * ページ座標の矩形 from に収まっていたノード群を、to に収まるよう拡大縮小する。
 * 子の位置と大きさは変えない。
 * 斜めに回っているノードは歪ませられないので、中心を動かし、面積が合う倍率で大きさを変える。
 * テキストは幅を変えると折り返しに切り替わる。高さは中身で決まるので、呼び出し側で合わせ直すこと。
 */
export function resizeNodes<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  from: Bounds,
  to: Bounds,
): T {
  const scaleX = from.width === 0 ? 1 : to.width / from.width
  const scaleY = from.height === 0 ? 1 : to.height / from.height
  return patchNodes(scene, topLevelIds(scene, ids), (node) => {
    const { id } = node
    // 直線は水平・垂直にできるよう、幅や高さが 0 になってよい
    const minSize = isLine(node) ? 0 : 1
    const rotation = normalizeAngle(getWorldRotation(scene, id))
    // ページ上では回っていなくても、親と逆向きに回して打ち消しているノードはこちらで扱う
    if (rotation !== 0 || node.rotation !== 0) {
      const center = getWorldCenter(scene, id)
      const moved = {
        x: to.x + (center.x - from.x) * scaleX,
        y: to.y + (center.y - from.y) * scaleY,
      }
      // 90° 回っていれば縦と横が入れ替わる
      const uniform = Math.sqrt(Math.abs(scaleX * scaleY))
      const [scaleW, scaleH] =
        rotation === 0 || rotation === 180
          ? [Math.abs(scaleX), Math.abs(scaleY)]
          : Math.abs(rotation) === 90
            ? [Math.abs(scaleY), Math.abs(scaleX)]
            : [uniform, uniform]
      const size = {
        width: Math.max(minSize, Math.round(node.width * scaleW)),
        height: node.type === 'text' ? node.height : Math.max(minSize, Math.round(node.height * scaleH)),
      }
      const pose = poseInParent(scene, node.parentId, moved, getWorldRotation(scene, id), size)
      return { x: pose.x, y: pose.y, ...sizePatch(node, size.width, size.height) }
    }

    const abs = getAbsoluteBounds(scene, id)
    const left = Math.round(to.x + (abs.x - from.x) * scaleX)
    const top = Math.round(to.y + (abs.y - from.y) * scaleY)
    const position = { x: node.x + left - abs.x, y: node.y + top - abs.y }
    const right = Math.round(to.x + (abs.x + abs.width - from.x) * scaleX)
    const bottom = Math.round(to.y + (abs.y + abs.height - from.y) * scaleY)
    const width = Math.max(minSize, right - left)
    const height = Math.max(minSize, bottom - top)
    return { ...position, ...sizePatch(node, width, height) }
  })
}

/**
 * プロパティパネルの「回転」に角度を入れたとき。1 つなら枠の中心を軸にその角度にする。
 * 複数で角度が揃っていれば、選択範囲の中心を軸にまとめて差の分だけ回す（ハンドルで回したのと同じ）。
 * 揃っていなければ、回す量が 1 つに決まらないので、それぞれを枠の中心を軸にその角度にする。
 */
export function setRotation<T extends Scene>(scene: T, ids: readonly NodeId[], rotation: number): T {
  const target = normalizeAngle(rotation)
  const tops = topLevelIds(scene, ids)
  const angles = new Set(tops.map((id) => scene.nodes[id].rotation))
  const bounds = getNodesBounds(scene, tops)
  if (tops.length > 1 && angles.size === 1 && bounds) {
    const [current] = angles
    const pivot = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
    return rotateNodes(scene, tops, pivot, normalizeAngle(target - current))
  }
  return patchNodes(scene, ids, () => ({ rotation: target }))
}

export type FlipDirection = 'horizontal' | 'vertical'

/**
 * 選択範囲の中心を通る線で、左右（horizontal）か上下（vertical）に裏返す。
 * kdr は裏返しを持たないので、形に焼き込む: 位置を鏡に映し、角度の符号を変え、
 * 中身（パスの頂点（輪郭すべて）・フレームの子・角丸の 4 隅・グラデーション・影のずれ・親の辺への固定）を鏡に映す。
 * テキストと画像は字や絵を裏返せないので、位置と向きだけを映す。インスタンスも中身は元のまま（位置と向きだけ）。
 * 自動で並べるフレームの並びの順は入れ替えない（並びから外した子は映す）。
 */
export function flipNodes<T extends Scene>(scene: T, ids: readonly NodeId[], direction: FlipDirection): T {
  const tops = topLevelIds(scene, ids)
  const bounds = getNodesBounds(scene, tops)
  if (!bounds) return scene
  const horizontal = direction === 'horizontal'
  const axis: Axis = horizontal ? 'x' : 'y'
  const middle = horizontal ? bounds.x + bounds.width / 2 : bounds.y + bounds.height / 2
  const patches = new Map<NodeId, NodePatch>()
  const add = (id: NodeId, patch: NodePatch) => patches.set(id, { ...patches.get(id), ...patch })

  for (const id of tops) {
    const node = scene.nodes[id]
    const center = getWorldCenter(scene, id)
    const mirrored = horizontal ? { x: 2 * middle - center.x, y: center.y } : { x: center.x, y: 2 * middle - center.y }
    const pose = poseInParent(scene, node.parentId, mirrored, -getWorldRotation(scene, id), node)
    add(id, { x: pose.x, y: pose.y, rotation: pose.rotation })
    // 親の中での固定の向き。親がページに対して 90° 回っていれば、ページの左右は親の上下になる
    const parentAngle = Math.abs(normalizeAngle(getWorldRotation(scene, node.parentId))) % 180
    if (parentAngle === 0 || parentAngle === 90) {
      const parentAxis: Axis = parentAngle === 0 ? axis : axis === 'x' ? 'y' : 'x'
      add(id, { constraints: swapConstraint(node.constraints, parentAxis) })
    }
    mirrorContent(scene, node, axis, add)
  }
  return patchNodes(scene, patches.keys(), (node) => patches.get(node.id) ?? null)
}

type Axis = 'x' | 'y'

/** node の座標系で axis の向きに中身を鏡に映すパッチを add へ積む。子孫もたどる */
function mirrorContent(scene: Scene, node: SceneNode, axis: Axis, add: (id: NodeId, patch: NodePatch) => void) {
  // 字・絵・インスタンスの中身（元の写し）は映せない
  if (node.type === 'text' || node.type === 'image' || isInstance(node)) return
  // 影のずれはページの向きで持つが、裏返す向きはどの深さでもページの同じ向きになる（回転の符号が変わるだけ）
  const patch: Record<string, unknown> = {
    fills: node.fills.map((paint) => mirrorPaint(paint, axis)),
    strokes: node.strokes.map((paint) => mirrorPaint(paint, axis)),
    effects: node.effects.map((effect) => ('x' in effect ? { ...effect, [axis]: -effect[axis] || 0 } : effect)),
  }
  if (node.type === 'rect' || node.type === 'frame') patch.cornerRadius = mirrorRadius(node.cornerRadius, axis)
  if (node.type === 'path') {
    // 頂点は枠に対する割合なので 1 から引き、制御点は頂点からのずれなので符号を変える
    const flip = <P extends { x: number; y: number }>(p: P, offset: boolean): P =>
      axis === 'x' ? { ...p, x: offset ? -p.x || 0 : tidy(1 - p.x) } : { ...p, y: offset ? -p.y || 0 : tidy(1 - p.y) }
    const mirrorPoints = (points: readonly PathPoint[]) =>
      points.map((point): PathPoint => {
        const next = flip(point, false)
        if (point.in) next.in = flip(point.in, true)
        if (point.out) next.out = flip(point.out, true)
        return next
      })
    patch.points = mirrorPoints(node.points)
    // 2 つ目以降の輪郭（穴など）も同じ枠に対する割合なので、同じく映す
    patch.contours = node.contours.map((contour) => ({ ...contour, points: mirrorPoints(contour.points) }))
  }
  add(node.id, patch as NodePatch)
  if (node.type !== 'frame') return
  for (const childId of node.children) {
    const child = scene.nodes[childId]
    // 自動で並べるフレームの並びの中の子は、位置をフレームが決めるので中身だけ映す
    if (!node.layout || child.layoutPositioning === 'absolute') {
      const size = axis === 'x' ? node.width : node.height
      add(childId, {
        [axis]: tidy(size - child[axis] - (axis === 'x' ? child.width : child.height)),
        rotation: tidy(normalizeAngle(-child.rotation)),
        constraints: swapConstraint(child.constraints, axis),
      })
    }
    mirrorContent(scene, child, axis, add)
  }
}

function mirrorPaint(paint: Paint, axis: Axis): Paint {
  if (paint.type === 'linear') {
    return axis === 'x' ? { ...paint, x1: tidy(1 - paint.x1), x2: tidy(1 - paint.x2) } : { ...paint, y1: tidy(1 - paint.y1), y2: tidy(1 - paint.y2) }
  }
  if (paint.type === 'radial') {
    // 楕円の軸の向きは、どちらの向きに映しても符号が変わる。焦点は軸に沿ったずれなので、横に映せば横の、縦に映せば縦のずれの符号が変わる
    const angle = paint.angle === 0 ? 0 : tidy(normalizeAngle(-paint.angle))
    return axis === 'x'
      ? { ...paint, cx: tidy(1 - paint.cx), angle, fx: -paint.fx || 0 }
      : { ...paint, cy: tidy(1 - paint.cy), angle, fy: -paint.fy || 0 }
  }
  if (paint.type === 'conic') {
    // 鏡に映すと回る向きが逆になるので、始まりの向きを映し、色の並びを逆にする（位置 t の色は 1 - t へ）
    const angle = axis === 'x' ? 180 - paint.angle : -paint.angle
    const stops = paint.stops.toReversed().map((stop) => ({ ...stop, offset: tidy(1 - stop.offset) }))
    return {
      ...paint,
      ...(axis === 'x' ? { cx: tidy(1 - paint.cx) } : { cy: tidy(1 - paint.cy) }),
      angle: tidy(normalizeAngle(angle)),
      stops,
    }
  }
  return paint
}

/** 左上・右上・右下・左下の 4 隅を鏡に映す */
function mirrorRadius(radius: CornerRadius, axis: Axis): CornerRadius {
  if (typeof radius === 'number') return radius
  const [tl, tr, br, bl] = radius
  return axis === 'x' ? [tr, tl, bl, br] : [bl, br, tr, tl]
}

function swapConstraint(
  constraints: SceneNode['constraints'],
  axis: Axis,
): SceneNode['constraints'] {
  const key = axis === 'x' ? 'horizontal' : 'vertical'
  const value = constraints[key]
  const swapped = value === 'start' ? 'end' : value === 'end' ? 'start' : value
  return swapped === value ? constraints : { ...constraints, [key]: swapped }
}
