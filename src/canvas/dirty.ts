import { type Bounds, type Matrix, type Size, getWorldMatrix, multiply, nodeMatrix, transformRect } from '../document/geometry.ts'
import type { Asset, AssetId, NodeId, Scene, SceneNode } from '../document/types.ts'
import { frameLabelPose } from './labels.ts'
import { FRAME_LABEL_FONT, FRAME_LABEL_HEIGHT, paintedRect } from './render.ts'
import type { Viewport } from './viewport.ts'

// 図形を動かしたとき（ドラッグの 1 歩など）に、描き直す範囲を決める（sceneCache.ts）。
// ノードは不変なので、前のページと参照が違うノードだけが変わった。変わったノードの前と後の描かれうる範囲（子孫も含む）を描き直せば、
// その外の画素は前の絵のままでよい。描き直しは範囲で切って、その範囲にかかるノードを全部描き直す（renderScene の region）ので、重なり順も合う。

/** 変わったノードがこれより多ければ、範囲を求めずに全部を描く（求めるだけで手間になる） */
const MAX_CHANGED = 2000
/** 描き直す範囲がこの割合より広ければ、全部を描く */
const MAX_AREA = 0.6
/** 範囲はこの数まで別々に描く。超えたら 1 つに囲む */
const MAX_REGIONS = 4
/** にじみの分だけ外へ広げる（画面のピクセル） */
const PAD = 2

/**
 * prev から next に変わったときに描き直す範囲（画面座標、CSS ピクセル。画面の実ピクセルの境目に揃える）。
 * 空なら描き直すものはない。全部を描くべきなら null。
 * measure は、文字の行分け（テキストの範囲）とフレーム名のラベルの幅を測るためのキャンバス
 */
export function changedRegions(
  prev: Scene,
  next: Scene,
  viewport: Viewport,
  size: Size,
  pixelRatio: number,
  measure: CanvasRenderingContext2D,
): Bounds[] | null {
  if (prev.rootIds !== next.rootIds) return null
  if (prev.nodes === next.nodes) return []
  const changed = changedIds(prev, next)
  if (changed === null) return null
  // ぼかしは範囲の外の画素を混ぜて描くので、範囲で切って描くと縁が合わない
  if (hasBlur(next, prev, changed)) return null

  const world: Bounds[] = []
  const screen: Bounds[] = []
  const roots = new Set(next.rootIds)
  for (const id of changed) {
    for (const scene of [prev, next]) {
      const node = scene.nodes[id]
      if (!node) continue
      collectPainted(scene, id, getWorldMatrix(scene, node.parentId), measure, world)
      // ブーリアン演算のノードの子が変わると、ノードの描く形（ノードの線の太さで）も変わる
      for (let parentId = node.parentId; parentId !== null; parentId = scene.nodes[parentId]?.parentId ?? null) {
        const parent = scene.nodes[parentId]
        if (parent?.type === 'frame' && parent.booleanOperation !== null) {
          world.push(transformRect(getWorldMatrix(scene, parentId), paintedRect(measure, parent)))
        }
      }
      if (roots.has(id) && node.type === 'frame' && node.visible) screen.push(labelBox(node, viewport, measure))
    }
  }

  return toRegions(world, screen, viewport, size, pixelRatio)
}

/**
 * デコードが済んだ画像（loaded）を使う画像のノードを描き直す範囲。changedRegions と同じく、全部を描くべきなら null
 */
export function assetRegions(
  scene: Scene,
  assets: Record<AssetId, Asset>,
  loaded: ReadonlySet<Asset>,
  viewport: Viewport,
  size: Size,
  pixelRatio: number,
  measure: CanvasRenderingContext2D,
): Bounds[] | null {
  if (hasBlur(scene, null, [])) return null
  const world: Bounds[] = []
  for (const id in scene.nodes) {
    const node = scene.nodes[id]
    if (node.type !== 'image' || !loaded.has(assets[node.assetId])) continue
    world.push(transformRect(getWorldMatrix(scene, id), paintedRect(measure, node)))
  }
  return toRegions(world, [], viewport, size, pixelRatio)
}

/** ページ座標の範囲と画面座標の範囲を、画面の実ピクセルに揃えた描き直す範囲にまとめる。広すぎれば null */
function toRegions(world: readonly Bounds[], screen: readonly Bounds[], viewport: Viewport, size: Size, pixelRatio: number): Bounds[] | null {
  const regions: Bounds[] = []
  const clampTo = { x: 0, y: 0, ...size }
  for (const rect of [...world.map((b) => toScreen(b, viewport)), ...screen]) {
    const snapped = snap(rect, pixelRatio, clampTo)
    if (snapped) addRegion(regions, snapped)
  }
  if (regions.length > MAX_REGIONS) {
    const all = regions.reduce(union)
    regions.length = 0
    regions.push(all)
  }
  const area = regions.reduce((sum, r) => sum + r.width * r.height, 0)
  if (area > size.width * size.height * MAX_AREA) return null
  return regions
}

/** 参照が変わったノード（足された・消されたものを含む）。多すぎれば null */
function changedIds(prev: Scene, next: Scene): NodeId[] | null {
  const ids: NodeId[] = []
  for (const id in next.nodes) {
    if (prev.nodes[id] !== next.nodes[id]) {
      ids.push(id)
      if (ids.length > MAX_CHANGED) return null
    }
  }
  for (const id in prev.nodes) {
    if (!(id in next.nodes)) {
      ids.push(id)
      if (ids.length > MAX_CHANGED) return null
    }
  }
  return ids
}

// ページのノードの表ごとに、ぼかしの効果を持つノードがあるかを覚える
const blurCache = new WeakMap<Scene['nodes'], boolean>()

const blurred = (node: SceneNode | undefined) =>
  node?.effects.some((effect) => effect.type === 'layer-blur' || effect.type === 'background-blur') ?? false

/**
 * next のページにぼかし（layer-blur / background-blur）を持つノードがあるか。前のページ（prev）に無かったと分かっていれば、
 * 変わったノード（changed）だけを見る（ドラッグの 1 歩ごとに全部のノードを見ないため）
 */
export function hasBlur(next: Scene, prev: Scene | null, changed: readonly NodeId[]): boolean {
  const cached = blurCache.get(next.nodes)
  if (cached !== undefined) return cached
  let found = false
  if (prev && blurCache.get(prev.nodes) === false) found = changed.some((id) => blurred(next.nodes[id]))
  else
    for (const id in next.nodes) {
      if (blurred(next.nodes[id])) {
        found = true
        break
      }
    }
  blurCache.set(next.nodes, found)
  return found
}

/** ノードとその子孫が描かれうる範囲（ページ座標）を out に足す。切り取るフレームの中は、フレームの範囲で足りる */
function collectPainted(scene: Scene, id: NodeId, parent: Matrix, measure: CanvasRenderingContext2D, out: Bounds[]): void {
  const node = scene.nodes[id]
  const world = multiply(parent, nodeMatrix(node))
  out.push(transformRect(world, paintedRect(measure, node)))
  if (node.type === 'frame' && !node.clipContent) {
    for (const child of node.children) collectPainted(scene, child, world, measure, out)
  }
}

/** フレーム名のラベルが描かれうる範囲（画面座標）。傾いたラベルは、文字の長さを半径とする正方形で囲む */
function labelBox(node: Extract<SceneNode, { type: 'frame' }>, viewport: Viewport, measure: CanvasRenderingContext2D): Bounds {
  measure.save()
  measure.font = FRAME_LABEL_FONT
  const width = measure.measureText(node.name).width
  measure.restore()
  const { origin, angle } = frameLabelPose(node, viewport)
  if (angle === 0) return { x: origin.x, y: origin.y - FRAME_LABEL_HEIGHT, width, height: FRAME_LABEL_HEIGHT }
  const reach = width + FRAME_LABEL_HEIGHT
  return { x: origin.x - reach, y: origin.y - reach, width: reach * 2, height: reach * 2 }
}

function toScreen(b: Bounds, viewport: Viewport): Bounds {
  return { x: (b.x - viewport.x) * viewport.zoom, y: (b.y - viewport.y) * viewport.zoom, width: b.width * viewport.zoom, height: b.height * viewport.zoom }
}

/**
 * にじみの分だけ広げ、画面の実ピクセルの境目に外向きに揃え、画面に収める。画面の外なら null。
 * 境目に揃えないと、範囲で切った縁が半端な画素になり、前の絵とつないだ所に筋が出る
 */
export function snap(rect: Bounds, pixelRatio: number, clampTo: Bounds): Bounds | null {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return clampTo
  const left = Math.max(clampTo.x, Math.floor((rect.x - PAD) * pixelRatio) / pixelRatio)
  const top = Math.max(clampTo.y, Math.floor((rect.y - PAD) * pixelRatio) / pixelRatio)
  const right = Math.min(clampTo.x + clampTo.width, Math.ceil((rect.x + rect.width + PAD) * pixelRatio) / pixelRatio)
  const bottom = Math.min(clampTo.y + clampTo.height, Math.ceil((rect.y + rect.height + PAD) * pixelRatio) / pixelRatio)
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** 範囲の並びに rect を足す。重なる範囲は 1 つに囲む（囲んだら、また別の範囲と重なりうるので繰り返す） */
export function addRegion(regions: Bounds[], rect: Bounds): void {
  let current = rect
  for (let i = 0; i < regions.length; ) {
    if (overlaps(regions[i], current)) {
      current = union(regions[i], current)
      regions.splice(i, 1)
      i = 0
    } else i++
  }
  regions.push(current)
}

function overlaps(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

function union(a: Bounds, b: Bounds): Bounds {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }
}
