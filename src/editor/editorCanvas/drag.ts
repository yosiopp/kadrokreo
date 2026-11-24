import { isFlowText } from '../../document/textPath.ts'
import type { CanvasPointer } from '../../canvas/CanvasView.tsx'
import {
  type Bounds,
  type Matrix,
  type Point,
  type Size,
  applyMatrix,
  boundsFromPoints,
  getCorners,
  getNodesBounds,
  getWorldRotation,
  normalizeAngle,
  rotateVector,
  tidy,
  toLocal,
} from '../../document/geometry.ts'
import { type Contour, type Vertex, isLine, pathFromPoints } from '../../document/path.ts'
import {
  flatVertices,
  isSmooth,
  moveControl,
  moveVertex,
  moveVertices,
  neighborVertex,
  reshapeContours,
  withFlatVertices,
} from '../pathEdit.ts'
import type { Gradient, NodeId, PathNode, Scene, SceneNode } from '../../document/types.ts'
import { patchGradientAt } from '../operations/paints.ts'
import { type GradientEdit, type GradientPart, dragGradient, toNodeSpace } from './gradientHandles.ts'
import { findFrameAt, nodesInMarquee } from '../hitTest.ts'
import { placeInLayout } from '../layout.ts'
import { fitTextNodes } from '../measure.ts'
import { createEllipse, createFrame, createLine, createRect } from '../nodes.ts'
import { reshapeNode, resizeNodes, rotateNodes, translateNodes } from '../operations/transform.ts'
import { insertNode, reparentNodes } from '../operations/tree.ts'
import { type Handle, resizeBounds } from '../resize.ts'
import { type Guide, findGuides, snapMove, snapResize, snapShape, toFrame } from '../snap.ts'
import type { EditorStore } from '../store.ts'
import {
  DRAG_THRESHOLD,
  type PointPart,
  SNAP_DISTANCE,
  angleFrom,
  constrainAngle,
  distance,
  editableContours,
  nextName,
  roundBox,
  roundPoint,
} from './handles.ts'

// キャンバスでポインタを押してから離すまでの操作（ジェスチャー）と、ドラッグ中のプレビュー

export type Gesture =
  // ノードの上（または選択枠の内側）で押しただけの状態。少し動かすと move になる。
  // 動かさずに離したら、collapseTo があればそれ 1 つに絞り、clickSelect があればそれを選び直す
  | { kind: 'press'; screen: Point; world: Point; collapseTo: NodeId | null; clickSelect?: NodeId[] }
  // corners は動かす前の各ノードの四隅（ページ座標）。rotation は全部が同じ向きに斜めに回っていればその角度（0〜90 未満）、でなければ 0
  | { kind: 'move'; world: Point; ids: NodeId[]; from: Bounds; corners: Point[][]; rotation: number; guides: Guide[] }
  | { kind: 'resize'; world: Point; handle: Handle; from: Bounds; ids: NodeId[]; guides: Guide[] }
  // 回転したノード 1 つを、その向きに沿ってリサイズする。size はつかんだ時点の大きさ
  // matrix はつかんだ時点のノードの座標系からページへの変換
  | { kind: 'reshape'; world: Point; handle: Handle; id: NodeId; rotation: number; size: Size; matrix: Matrix; guides: Guide[] }
  // pivot（ページ座標）を軸に回す。delta はつかんでから回した角度
  | { kind: 'rotate'; ids: NodeId[]; pivot: Point; startAngle: number; baseRotation: number; delta: number }
  | { kind: 'marquee'; world: Point; current: Point; base: NodeId[] }
  | CreateGesture
  | { kind: 'text'; screen: Point; world: Point }
  // 直線の端（0 が始点、1 が終点）やパスの頂点（vertex）、頂点の制御点（in / out）をつかんでいる。
  // group は一緒に動かす頂点（つかんだ頂点を含む、選んでいる頂点）。collapse なら、動かさずに離したとき、つかんだ頂点だけを選び直す
  | { kind: 'point'; id: NodeId; index: number; part: PointPart; group?: number[]; collapse?: boolean; screen?: Point; moved?: boolean }
  // 頂点の編集中の範囲選択。base は Shift で押したときに元から選んでいた頂点
  | { kind: 'vertexMarquee'; id: NodeId; screen: Point; world: Point; current: Point; base: number[]; dragged: boolean }
  // キャンバスで動かしているグラデーションのハンドルをつかんでいる。base はつかんだときのグラデーション
  | { kind: 'gradient'; edit: GradientEdit; part: GradientPart; base: Gradient }

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

/** shape は親の座標系での枠。直線なら頂点も含む */
export function previewCreate(
  store: EditorStore,
  gesture: CreateGesture,
  shape: Bounds & Partial<Pick<PathNode, 'points'>>,
) {
  // 直線は水平・垂直に引けるよう、幅や高さが 0 でもよい
  const minSize = isLine(gesture.node) ? 0 : 1
  const node = {
    ...gesture.node,
    ...shape,
    width: Math.max(minSize, shape.width),
    height: Math.max(minSize, shape.height),
  }
  store.preview((base) => insertNode(base, node, gesture.parentId))
}

/**
 * 吸着先になるノード。parentId の子と、parentId のフレーム自身。
 * 動かしている最中のノードは除く。
 */
function snapTargets(page: Scene, parentId: NodeId | null, exclude: ReadonlySet<NodeId>): NodeId[] {
  const parent = parentId === null ? null : page.nodes[parentId]
  const siblings = parent?.type === 'frame' ? parent.children : page.rootIds
  const targets = siblings.filter((id) => !exclude.has(id) && page.nodes[id].visible)
  if (parent) targets.push(parent.id)
  return targets
}

/** 角度 a と b の違いが 90° の倍数か（向きの軸が同じか） */
function sameAxes(a: number, b: number): boolean {
  const d = (((a - b) % 90) + 90) % 90
  return d < 0.01 || d > 89.99
}

/** 選んだものをつかんで動かし始めたときのジェスチャー */
export function moveGesture(page: Scene, world: Point, ids: NodeId[], from: Bounds): Gesture {
  // 全部が同じ向きに斜めに回っていれば、その向きに沿っても吸着させる
  const angles = ids.map((id) => (((getWorldRotation(page, id) % 90) + 90) % 90))
  const rotation = angles.every((angle) => sameAxes(angle, angles[0])) && !sameAxes(angles[0], 0) ? angles[0] : 0
  return { kind: 'move', world, ids, from, corners: ids.map((id) => getCorners(page, id)), rotation, guides: [] }
}

/**
 * 吸着で足す量 snap を移動量 delta に足す。辺や中央どうし（整数か .5）なら今までどおり整数に丸め、
 * 斜めに回った図形の角に揃えたとき（端数が出る）は、丸めると揃わなくなるので丸めない
 */
function settle(delta: number, snap: number): number {
  return Number.isInteger(snap * 2) ? Math.round(delta + snap) : tidy(delta + snap)
}

/**
 * ドラッグ中のポインタの動きを、ジェスチャーに応じたプレビューにする。
 * ジェスチャーの途中の状態（ガイドや回した角度など）は gesture に書き込む。
 * press と text のジェスチャーは扱わない。
 */
export function dragGesture(store: EditorStore, gesture: Gesture, pointer: CanvasPointer, zoom: number) {
  switch (gesture.kind) {
    case 'gradient': {
      const { edit, part, base } = gesture
      const page = store.getState().page
      const node = page.nodes[edit.id]
      if (!node) return
      const local = toNodeSpace(page, edit.id, pointer.world)
      const moved = dragGradient(base, part, local, node, pointer.shiftKey)
      store.preview((scene) => patchGradientAt(scene, [edit.id], edit.key, edit.index, () => moved.gradient))
      if (moved.stop !== null && moved.stop !== store.getState().gradientEdit?.stop) store.editGradient({ ...edit, stop: moved.stop })
      return
    }
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
      let box = roundBox(resizeBounds({ x: 0, y: 0, ...size }, handle, moved.x, moved.y, keepAspect), handle)
      gesture.guides = []
      if (!keepAspect && !pointer.modKey) {
        // ノードの向きに沿った座標で、動かしている辺を近くの図形の辺（斜めなら角）に揃える
        const page = store.getState().page
        const node = page.nodes[id]
        const origin = toFrame(applyMatrix(gesture.matrix, { x: 0, y: 0 }), gesture.rotation)
        const targets = snapTargets(page, node.parentId, new Set([id])).map((target) => snapShape([getCorners(page, target)], gesture.rotation)!)
        const framed = snapResize({ ...box, x: box.x + origin.x, y: box.y + origin.y }, handle, targets, SNAP_DISTANCE / zoom)
        box = { ...framed, x: tidy(framed.x - origin.x), y: tidy(framed.y - origin.y), width: tidy(framed.width), height: tidy(framed.height) }
        // テキストの高さは中身で決まるので、上下の辺は揃えない
        const guideHandle = isFlowText(node) ? (handle.replace(/[ns]/g, '') as Handle) : handle
        if (guideHandle) {
          gesture.guides = findGuides({ ...box, x: box.x + origin.x, y: box.y + origin.y }, targets, guideHandle).map((guide) => ({ ...guide, rotation: gesture.rotation }))
        }
      }
      const target = box
      store.preview((base) => fitTextNodes(reshapeNode(base, id, target), [id]))
      return
    }
    case 'point': {
      const { id, index, part, group } = gesture
      if (gesture.screen && !gesture.moved) {
        // 押しただけの間は動かさない（クリックで選び直すため）
        if (distance(pointer.screen, gesture.screen) < DRAG_THRESHOLD) return
        gesture.moved = true
      }
      store.preview((base) => {
        const node = base.nodes[id]
        if (node?.type !== 'path') return base
        // 親の座標系で形を作り直す。ノード自体が回っていた場合、その向きは点の位置に織り込まれる
        const target = toLocal(base, node.parentId, pointer.world)
        // 頂点の番号は全部の輪郭をつないだ通し番号。頂点や制御点を動かすだけなら、輪郭の切れ目は気にしなくてよい
        const edit = (vertices: Vertex[], contours: Contour[]): Vertex[] => {
          if (part === 'vertex' && group && group.length > 1) {
            // 選んでいる頂点をまとめて、つかんだ頂点と同じだけ動かす
            const to = roundPoint(target)
            return moveVertices(vertices, group, to.x - vertices[index].x, to.y - vertices[index].y)
          }
          if (part === 'vertex') {
            // Shift で、隣の点から見て水平・垂直・45° に揃える
            const neighbor = neighborVertex(contours, index)
            return moveVertex(vertices, index, pointer.shiftKey && neighbor ? constrainAngle(neighbor, target) : roundPoint(target))
          }
          // 制御点。Shift で頂点から見た向きを 45° 刻みに、Alt でなめらかな頂点の反対側を追従させない
          const vertex = vertices[index]
          const to = pointer.shiftKey ? constrainAngle(vertex, target) : roundPoint(target)
          return moveControl(vertices, index, part, to, !pointer.altKey && isSmooth(vertex))
        }
        return reshapeContours(base, id, (contours) => withFlatVertices(contours, edit(flatVertices(contours), contours)))
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

      // 近くの図形や親フレームの端・中央（斜めに回った図形は角も）に吸着する。Cmd / Ctrl を押している間は吸着しない
      const targetIds = pointer.modKey ? [] : snapTargets(page, parentId, exclude)
      const threshold = SNAP_DISTANCE / zoom
      const movedCorners = (x: number, y: number) => gesture.corners.map((set) => set.map((p) => ({ x: p.x + x, y: p.y + y })))
      const { rotation } = gesture
      let snapped = false
      if (rotation !== 0 && !pointer.shiftKey) {
        // 同じ向きに回した図形どうしは、その向きに沿って辺と中央を揃える（同じ角度で並べたカードなど）
        const targets = targetIds
          .filter((id) => sameAxes(getWorldRotation(page, id), rotation))
          .map((id) => snapShape([getCorners(page, id)], rotation)!)
        const snap = snapMove(snapShape(movedCorners(dx, dy), rotation)!, targets, threshold)
        if (snap.dx !== 0 || snap.dy !== 0) {
          const delta = rotateVector({ x: snap.dx, y: snap.dy }, rotation)
          dx = tidy(dx + delta.x)
          dy = tidy(dy + delta.y)
          gesture.guides = findGuides(snapShape(movedCorners(dx, dy), rotation)!, targets).map((guide) => ({ ...guide, rotation }))
          snapped = true
        }
      }
      if (!snapped) {
        const targets = targetIds.map((id) => snapShape([getCorners(page, id)])!)
        const snap = snapMove(snapShape(movedCorners(dx, dy))!, targets, threshold)
        // Shift で向きを固定しているときは、固定した向きには吸着させない
        if (!pointer.shiftKey || dx !== 0) dx = settle(dx, snap.dx)
        if (!pointer.shiftKey || dy !== 0) dy = settle(dy, snap.dy)
        gesture.guides = findGuides(snapShape(movedCorners(dx, dy))!, targets)
      }

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
      const targets = pointer.modKey
        ? []
        : snapTargets(page, page.nodes[ids[0]].parentId, exclude).map((id) => snapShape([getCorners(page, id)])!)
      if (!keepAspect) to = snapResize(to, handle, targets, SNAP_DISTANCE / zoom)
      const target = to
      store.preview((base) => fitTextNodes(resizeNodes(base, ids, from, target), ids))
      const resized = getNodesBounds(store.getState().page, ids)
      gesture.guides = resized ? findGuides(resized, targets, handle) : []
      return
    }
    case 'vertexMarquee': {
      gesture.current = pointer.world
      if (!gesture.dragged && distance(pointer.screen, gesture.screen) < DRAG_THRESHOLD) return
      gesture.dragged = true
      const node = store.getState().page.nodes[gesture.id]
      if (node?.type !== 'path') return
      const area = boundsFromPoints(gesture.world, gesture.current)
      const contains = (p: Point) => p.x >= area.x && p.x <= area.x + area.width && p.y >= area.y && p.y <= area.y + area.height
      const inside = flatVertices(editableContours(store.getState().page, node))
        .map((vertex, i) => (contains(vertex) ? i : -1))
        .filter((i) => i >= 0)
      store.editVertices({ id: gesture.id, vertices: [...gesture.base, ...inside], segment: null })
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
      if (isLine(gesture.node)) {
        // Shift で水平・垂直・45° に揃える
        const end = pointer.shiftKey ? constrainAngle(from, to) : roundPoint(to)
        previewCreate(store, gesture, pathFromPoints([from, end]))
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
