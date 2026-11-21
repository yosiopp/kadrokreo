import type { CanvasPointer } from '../../canvas/CanvasView.tsx'
import {
  type Bounds,
  type Point,
  type Size,
  boundsFromPoints,
  getAbsoluteBounds,
  getNodesBounds,
  getWorldRotation,
  normalizeAngle,
  rotateVector,
  toLocal,
} from '../../document/geometry.ts'
import { lineBetween, pathFromPoints } from '../../document/path.ts'
import type { LineNode, NodeId, Scene, SceneNode } from '../../document/types.ts'
import { findFrameAt, nodesInMarquee } from '../hitTest.ts'
import { placeInLayout } from '../layout.ts'
import { fitTextNodes } from '../measure.ts'
import { createEllipse, createFrame, createLine, createRect } from '../nodes.ts'
import {
  insertNode,
  reparentNodes,
  reshapeNode,
  resizeNodes,
  rotateNodes,
  translateNodes,
  updateNode,
} from '../operations.ts'
import { type Handle, resizeBounds } from '../resize.ts'
import { type Guide, findGuides, snapMove, snapResize } from '../snap.ts'
import type { EditorStore } from '../store.ts'
import {
  DRAG_THRESHOLD,
  SNAP_DISTANCE,
  angleFrom,
  constrainAngle,
  distance,
  editablePoints,
  nextName,
  roundBox,
  roundPoint,
} from './handles.ts'

// キャンバスでポインタを押してから離すまでの操作（ジェスチャー）と、ドラッグ中のプレビュー

export type Gesture =
  // ノードの上で押しただけの状態。少し動かすと move になる
  | { kind: 'press'; screen: Point; world: Point; collapseTo: NodeId | null }
  | { kind: 'move'; world: Point; ids: NodeId[]; from: Bounds; guides: Guide[] }
  | { kind: 'resize'; world: Point; handle: Handle; from: Bounds; ids: NodeId[]; guides: Guide[] }
  // 回転したノード 1 つを、その向きに沿ってリサイズする。size はつかんだ時点の大きさ
  | { kind: 'reshape'; world: Point; handle: Handle; id: NodeId; rotation: number; size: Size }
  // pivot（ページ座標）を軸に回す。delta はつかんでから回した角度
  | { kind: 'rotate'; ids: NodeId[]; pivot: Point; startAngle: number; baseRotation: number; delta: number }
  | { kind: 'marquee'; world: Point; current: Point; base: NodeId[] }
  | CreateGesture
  | { kind: 'text'; screen: Point; world: Point }
  // 直線の端（0 が始点、1 が終点）やパスの頂点をつかんでいる
  | { kind: 'point'; id: NodeId; index: number }

type CreateGesture = {
  kind: 'create'
  screen: Point
  world: Point
  node: SceneNode
  parentId: NodeId | null
  dragged: boolean
}

/** 図形を描くツールで押したときのジェスチャー */
export function createGesture(
  page: Scene,
  tool: 'frame' | 'rect' | 'ellipse' | 'line',
  pointer: CanvasPointer,
): CreateGesture {
  const world = roundPoint(pointer.world)
  const create = {
    frame: createFrame,
    rect: createRect,
    ellipse: createEllipse,
    line: createLine,
  }[tool]
  return {
    kind: 'create',
    screen: pointer.screen,
    world,
    node: { ...create({ x: 0, y: 0, width: 1, height: 1 }), name: nextName(page, tool) },
    parentId: findFrameAt(page, world),
    dragged: false,
  }
}

/** 回転ハンドルを押したときのジェスチャー。pivot（ページ座標）を軸に ids を回す */
export function rotateGesture(page: Scene, ids: NodeId[], pivot: Point, world: Point): Gesture {
  return {
    kind: 'rotate',
    ids,
    pivot,
    startAngle: angleFrom(pivot, world),
    // 1 つだけ選んでいるときは、そのノードの角度をきりのよい値に揃えられるようにする
    baseRotation: ids.length === 1 ? page.nodes[ids[0]].rotation : 0,
    delta: 0,
  }
}

/** shape は親の座標系での枠。直線なら向きも含む */
export function previewCreate(
  store: EditorStore,
  gesture: CreateGesture,
  shape: Bounds & Partial<Pick<LineNode, 'direction'>>,
) {
  // 直線は水平・垂直に引けるよう、幅や高さが 0 でもよい
  const minSize = gesture.node.type === 'line' ? 0 : 1
  const node = {
    ...gesture.node,
    ...shape,
    width: Math.max(minSize, shape.width),
    height: Math.max(minSize, shape.height),
  }
  store.preview((base) => insertNode(base, node, gesture.parentId))
}

/**
 * 吸着先になる矩形（ページ座標）。parentId の子と、parentId のフレーム自身。
 * 動かしている最中のノードは除く。
 */
function snapTargets(page: Scene, parentId: NodeId | null, exclude: ReadonlySet<NodeId>): Bounds[] {
  const parent = parentId === null ? null : page.nodes[parentId]
  const siblings = parent?.type === 'frame' ? parent.children : page.rootIds
  const targets = siblings
    .filter((id) => !exclude.has(id) && page.nodes[id].visible)
    .map((id) => getAbsoluteBounds(page, id))
  if (parent) targets.push(getAbsoluteBounds(page, parent.id))
  return targets
}

/**
 * ドラッグ中のポインタの動きを、ジェスチャーに応じたプレビューにする。
 * ジェスチャーの途中の状態（ガイドや回した角度など）は gesture に書き込む。
 * press と text のジェスチャーは扱わない。
 */
export function dragGesture(store: EditorStore, gesture: Gesture, pointer: CanvasPointer, zoom: number) {
  switch (gesture.kind) {
    case 'rotate': {
      const { ids, pivot, baseRotation } = gesture
      let delta = Math.round(normalizeAngle(angleFrom(pivot, pointer.world) - gesture.startAngle))
      // Shift で 15° 刻みに揃える
      if (pointer.shiftKey) delta = Math.round((baseRotation + delta) / 15) * 15 - baseRotation
      gesture.delta = delta
      store.preview((base) => rotateNodes(base, ids, pivot, delta))
      return
    }
    case 'reshape': {
      const { id, handle, size } = gesture
      // ポインタの動きを、ノードの向きに沿った成分に直す
      const moved = rotateVector(
        { x: pointer.world.x - gesture.world.x, y: pointer.world.y - gesture.world.y },
        -gesture.rotation,
      )
      // 画像は歪まないよう、Shift を押さない限り縦横比を保つ
      const keepAspect = pointer.shiftKey !== (store.getState().page.nodes[id]?.type === 'image')
      const box = roundBox(resizeBounds({ x: 0, y: 0, ...size }, handle, moved.x, moved.y, keepAspect), handle)
      store.preview((base) => fitTextNodes(reshapeNode(base, id, box), [id]))
      return
    }
    case 'point': {
      const { id, index } = gesture
      store.preview((base) => {
        const node = base.nodes[id]
        if (node?.type !== 'line' && node?.type !== 'path') return base
        // 親の座標系で形を作り直す。ノード自体が回っていた場合、その向きは点の位置に織り込まれる
        const points = editablePoints(base, node).map((point) => toLocal(base, node.parentId, point))
        const target = toLocal(base, node.parentId, pointer.world)
        // Shift で、隣の点から見て水平・垂直・45° に揃える
        const neighbor = points[index === 0 ? 1 : index - 1]
        points[index] = pointer.shiftKey ? constrainAngle(neighbor, target) : roundPoint(target)
        const shape = node.type === 'line' ? lineBetween(points[0], points[1]) : pathFromPoints(points)
        return updateNode(base, id, { ...shape, rotation: 0 })
      })
      return
    }
    case 'move': {
      const { ids } = gesture
      let dx = Math.round(pointer.world.x - gesture.world.x)
      let dy = Math.round(pointer.world.y - gesture.world.y)
      if (pointer.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0
        else dx = 0
      }
      const exclude = new Set(ids)
      // ポインタの下にあるフレームの中へ入れる（フレームの外へ出せばページ直下に戻る）
      const parentId = findFrameAt(store.getState().page, pointer.world, exclude)

      // 自動で並べるフレームの中では、位置はフレームが決める。ポインタの位置に応じて順番だけ入れ替える。
      // ただし、そのフレームの中で並びから外してある子は、ほかのフレームと同じく自由に動かす
      const page = store.getState().page
      const parent = parentId === null ? null : page.nodes[parentId]
      const free = ids.every(
        (id) => page.nodes[id].parentId === parentId && page.nodes[id].layoutPositioning === 'absolute',
      )
      if (parent?.type === 'frame' && parent.layout && !free) {
        gesture.guides = []
        store.preview((base) => placeInLayout(base, ids, parent.id, pointer.world))
        return
      }

      // 近くの図形や親フレームの端・中央に吸着する。Cmd / Ctrl を押している間は吸着しない
      const targets = pointer.modKey ? [] : snapTargets(page, parentId, exclude)
      const snap = snapMove(
        { ...gesture.from, x: gesture.from.x + dx, y: gesture.from.y + dy },
        targets,
        SNAP_DISTANCE / zoom,
      )
      // Shift で向きを固定しているときは、固定した向きには吸着させない
      if (!pointer.shiftKey || dx !== 0) dx = Math.round(dx + snap.dx)
      if (!pointer.shiftKey || dy !== 0) dy = Math.round(dy + snap.dy)
      gesture.guides = findGuides({ ...gesture.from, x: gesture.from.x + dx, y: gesture.from.y + dy }, targets)

      store.preview((base) => reparentNodes(translateNodes(base, ids, dx, dy), ids, parentId))
      return
    }
    case 'resize': {
      const { ids, from, handle } = gesture
      const page = store.getState().page
      // 画像は歪まないよう、Shift を押さない限り縦横比を保つ
      const onlyImages = ids.every((id) => page.nodes[id].type === 'image')
      // 斜めに回ったノードは歪ませられないので、含まれていれば常に縦横比を保つ
      const skewed = ids.some((id) => getWorldRotation(page, id) % 90 !== 0)
      const keepAspect = skewed || pointer.shiftKey !== onlyImages
      let to = resizeBounds(
        from,
        handle,
        pointer.world.x - gesture.world.x,
        pointer.world.y - gesture.world.y,
        keepAspect,
      )
      const exclude = new Set(ids)
      const targets = pointer.modKey ? [] : snapTargets(page, page.nodes[ids[0]].parentId, exclude)
      if (!keepAspect) to = snapResize(to, handle, targets, SNAP_DISTANCE / zoom)
      const target = to
      store.preview((base) => fitTextNodes(resizeNodes(base, ids, from, target), ids))
      const resized = getNodesBounds(store.getState().page, ids)
      gesture.guides = resized ? findGuides(resized, targets, handle) : []
      return
    }
    case 'marquee': {
      gesture.current = pointer.world
      const hits = nodesInMarquee(store.getState().page, boundsFromPoints(gesture.world, gesture.current))
      store.select([...new Set([...gesture.base, ...hits])])
      return
    }
    case 'create': {
      if (!gesture.dragged && distance(pointer.screen, gesture.screen) < DRAG_THRESHOLD) return
      gesture.dragged = true
      // フレームの中に描くときは、フレームが回っていてもその中の座標で形を決める
      const page = store.getState().page
      const from = roundPoint(toLocal(page, gesture.parentId, gesture.world))
      const to = toLocal(page, gesture.parentId, pointer.world)
      if (gesture.node.type === 'line') {
        // Shift で水平・垂直・45° に揃える
        const end = pointer.shiftKey ? constrainAngle(from, to) : roundPoint(to)
        previewCreate(store, gesture, lineBetween(from, end))
        return
      }
      let end = roundPoint(to)
      if (pointer.shiftKey) {
        const dx = end.x - from.x
        const dy = end.y - from.y
        const side = Math.max(Math.abs(dx), Math.abs(dy))
        end = { x: from.x + (dx < 0 ? -side : side), y: from.y + (dy < 0 ? -side : side) }
      }
      previewCreate(store, gesture, boundsFromPoints(from, end))
      return
    }
  }
}
