import {
  type Bounds,
  type Point,
  applyMatrix,
  getAbsoluteBounds,
  getWorldCenter,
  getWorldMatrix,
  getWorldRotation,
  normalizeAngle,
  poseInParent,
  rotateVector,
  tidy,
} from '../../document/geometry.ts'
import { isLine } from '../../document/path.ts'
import type { NodeId, Scene, SceneNode } from '../../document/types.ts'
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
