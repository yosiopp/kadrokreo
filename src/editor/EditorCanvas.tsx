import { useEffect, useReducer, useRef, useState } from 'react'
import { type CanvasPointer, CanvasView } from '../canvas/CanvasView.tsx'
import type { Camera } from '../canvas/camera.ts'
import { isTextInput } from '../canvas/dom.ts'
import { type Viewport, worldToScreen } from '../canvas/viewport.ts'
import {
  type Bounds,
  type Matrix,
  type Point,
  type Size,
  applyMatrix,
  boundsFromPoints,
  getAbsoluteBounds,
  getContentBounds,
  getCorners,
  getNodesBounds,
  getWorldMatrix,
  getWorldRotation,
  normalizeAngle,
  rotateVector,
  toLocal,
} from '../document/geometry.ts'
import { lineBetween, lineEndpoints, pathFromPoints, pathPoints } from '../document/path.ts'
import type { LineNode, NodeId, PathNode, Scene, SceneNode, TextNode } from '../document/types.ts'
import { TextEditor } from './TextEditor.tsx'
import { findFrameAt, hitTest, hitTestFrameLabel, nodesInMarquee } from './hitTest.ts'
import { isInstance, makeComponent, owningInstance } from './components.ts'
import { placeInLayout, wrapInAutoLayout } from './layout.ts'
import { fitTextNodes, measureFrameLabel, measureTextNode } from './measure.ts'
import {
  createEllipse,
  createFrame,
  createLine,
  createPath,
  createRect,
  createText,
} from './nodes.ts'
import {
  type Fragment,
  type ReorderDirection,
  copyFragment,
  insertNode,
  pasteIntoPage,
  removeNodes,
  reorderNodes,
  reparentNodes,
  reshapeNode,
  resizeNodes,
  rotateNodes,
  translateNodes,
  updateNode,
} from './operations.ts'
import { HANDLES, type Handle, handleCursor, handlePoint, resizeBounds } from './resize.ts'
import { type Guide, findGuides, snapMove, snapResize } from './snap.ts'
import type { EditorState, EditorStore } from './store.ts'

export type Tool = 'select' | 'frame' | 'rect' | 'ellipse' | 'line' | 'pen' | 'text'

type Props = {
  store: EditorStore
  camera: Camera
  state: EditorState
  tool: Tool
  onToolChange: (tool: Tool) => void
  /** クリップボードから画像が貼り付けられた */
  onPasteImages: (files: File[]) => void
}

type Gesture =
  // ノードの上で押しただけの状態。少し動かすと move になる
  | { kind: 'press'; screen: Point; world: Point; collapseTo: NodeId | null }
  | { kind: 'move'; world: Point; ids: NodeId[]; from: Bounds; guides: Guide[] }
  | { kind: 'resize'; world: Point; handle: Handle; from: Bounds; ids: NodeId[]; guides: Guide[] }
  // 回転したノード 1 つを、その向きに沿ってリサイズする。size はつかんだ時点の大きさ
  | { kind: 'reshape'; world: Point; handle: Handle; id: NodeId; rotation: number; size: Size }
  // pivot（ページ座標）を軸に回す。delta はつかんでから回した角度
  | { kind: 'rotate'; ids: NodeId[]; pivot: Point; startAngle: number; baseRotation: number; delta: number }
  | { kind: 'marquee'; world: Point; current: Point; base: NodeId[] }
  | {
      kind: 'create'
      screen: Point
      world: Point
      node: SceneNode
      parentId: NodeId | null
      dragged: boolean
    }
  | { kind: 'text'; screen: Point; world: Point }
  // 直線の端（0 が始点、1 が終点）やパスの頂点をつかんでいる
  | { kind: 'point'; id: NodeId; index: number }

/** draft は新規作成中のテキスト。確定するまでドキュメントには入れない */
type Editing = { id: NodeId; draft: { node: TextNode; parentId: NodeId | null } | null }

const ACCENT = '#0d99ff'
const GUIDE = '#f24822'
const SNAP_DISTANCE = 6
const DRAG_THRESHOLD = 4
const HANDLE_SIZE = 8
/** 回転ハンドルを枠の上辺からどれだけ離すか（画面ピクセル） */
const ROTATE_HANDLE_OFFSET = 22

/**
 * 選択範囲を囲む枠。1 つだけ選んでいてそれが回っていれば、その向きに合わせる。
 * それ以外は軸に平行に囲む。
 */
type SelectionBox = {
  ids: NodeId[]
  /** 枠の座標系（左上が原点）からページ座標系への変換 */
  matrix: Matrix
  size: Size
  /** ページ上での枠の向き（度） */
  rotation: number
  /** ページ上で囲む、軸に平行な矩形 */
  bounds: Bounds
  /** 枠がノードの向きに合っているとき、そのノード */
  oriented: NodeId | null
}
const NAMES = {
  frame: 'Frame',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  path: 'Path',
  text: 'Text',
  image: 'Image',
} as const

function toScreenBounds(viewport: Viewport, bounds: Bounds): Bounds {
  return {
    ...worldToScreen(viewport, bounds),
    width: bounds.width * viewport.zoom,
    height: bounds.height * viewport.zoom,
  }
}

/** 小さく映っているときは辺のハンドルを出さない。角と重なってつかめなくなるため */
function visibleHandles(screen: Bounds): Handle[] {
  return HANDLES.filter((handle) => {
    if (handle.length === 2) return true
    return handle === 'n' || handle === 's' ? screen.width >= 24 : screen.height >= 24
  })
}

function roundPoint(p: Point): Point {
  return { x: Math.round(p.x), y: Math.round(p.y) }
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** 直線の両端（ページ座標） */
function lineEnds(page: Scene, line: LineNode): Point[] {
  const matrix = getWorldMatrix(page, line.id)
  return lineEndpoints(line).map((end) => applyMatrix(matrix, end))
}

/** 直線の両端（始点・終点の順）またはパスの頂点（ページ座標） */
function editablePoints(page: Scene, node: LineNode | PathNode): Point[] {
  if (node.type === 'line') return lineEnds(page, node)
  const matrix = getWorldMatrix(page, node.id)
  return pathPoints(node).map((point) => applyMatrix(matrix, point))
}

/** ハンドルを引いた後の枠の大きさを整数にする。つかんでいない側の辺は動かさない */
function roundBox(box: Bounds, handle: Handle): Bounds {
  const width = Math.max(1, Math.round(box.width))
  const height = Math.max(1, Math.round(box.height))
  return {
    x: handle.includes('w') ? box.x + box.width - width : box.x,
    y: handle.includes('n') ? box.y + box.height - height : box.y,
    width,
    height,
  }
}

/** from から見た to の向きを 45° 刻みに揃える */
function constrainAngle(from: Point, to: Point): Point {
  const step = Math.PI / 4
  const angle = Math.round(Math.atan2(to.y - from.y, to.x - from.x) / step) * step
  const length = distance(from, to)
  return roundPoint({ x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length })
}

/** from から見た to の向き（度）。右が 0 で時計回り */
function angleFrom(from: Point, to: Point): number {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI
}

function nextName(page: Scene, type: SceneNode['type']): string {
  const count = Object.values(page.nodes).filter((node) => node.type === type).length
  return `${NAMES[type]} ${count + 1}`
}

export function EditorCanvas({ store, camera, state, tool, onToolChange, onPasteImages }: Props) {
  const gestureRef = useRef<Gesture | null>(null)
  const editingRef = useRef<Editing | null>(null)
  const clipboardRef = useRef<{ fragment: Fragment; pastes: number } | null>(null)
  // ペンツールで描いている途中の頂点（ページ座標）。cursor はポインタの位置
  const penRef = useRef<{ points: Point[]; cursor: Point | null } | null>(null)
  // 頂点を編集中のパス。ダブルクリックで入る
  const vertexEditRef = useRef<NodeId | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [hover, setHover] = useState<NodeId | null>(null)
  const [cursor, setCursor] = useState('default')
  const [, redraw] = useReducer((n: number) => n + 1, 0)

  // ツールを切り替えたら、描きかけのパスや頂点の編集は終える
  useEffect(() => {
    if (tool !== 'pen') penRef.current = null
    if (tool !== 'select') vertexEditRef.current = null
  }, [tool])

  // 別のものを選んだら、頂点の編集は終える
  useEffect(() => {
    const editing = vertexEditRef.current
    if (editing && (state.selection.length !== 1 || state.selection[0] !== editing)) {
      vertexEditRef.current = null
    }
  }, [state.selection])

  function changeEditing(next: Editing | null) {
    editingRef.current = next
    setEditing(next)
  }

  /**
   * 選択中のうち、インスタンスの中身（写し）でないもの。
   * 写しは色や文言を上書きできるだけで、動かす・消す・複製するといった操作の対象にはしない。
   */
  function ownIds(): NodeId[] {
    const { page, selection } = store.getState()
    return selection.filter((id) => !owningInstance(page, id))
  }

  /** 選択中のうち動かせるもの */
  function movableIds(): NodeId[] {
    const { page } = store.getState()
    return ownIds().filter((id) => !page.nodes[id].locked)
  }

  /** 直線を 1 本だけ選んでいるとき。枠のハンドルの代わりに、両端をつかんで動かせる */
  function selectedLine(): LineNode | null {
    if (tool !== 'select' || editingRef.current) return null
    const { page, selection } = store.getState()
    const node = selection.length === 1 ? page.nodes[selection[0]] : null
    return node?.type === 'line' && !node.locked && !owningInstance(page, node.id) ? node : null
  }

  /** 頂点を編集中のパス。そのパスだけを選んでいる間だけ有効 */
  function editedPath(): PathNode | null {
    if (tool !== 'select' || editingRef.current) return null
    const { page, selection } = store.getState()
    const node = selection.length === 1 ? page.nodes[selection[0]] : null
    return node?.type === 'path' && node.id === vertexEditRef.current && !node.locked ? node : null
  }

  /** 点をつかんで形を変えられるノード。直線は選ぶだけで、パスは頂点の編集に入ると対象になる */
  function pointTarget(): LineNode | PathNode | null {
    return selectedLine() ?? editedPath()
  }

  /** screen にある、つかめる点 */
  function pointAt(screen: Point): { id: NodeId; index: number } | null {
    const node = pointTarget()
    if (!node) return null
    const points = editablePoints(store.getState().page, node)
    for (const [index, point] of points.entries()) {
      if (distance(worldToScreen(camera.getViewport(), point), screen) <= HANDLE_SIZE) {
        return { id: node.id, index }
      }
    }
    return null
  }

  /** ペンツールで描いた頂点をパスとして確定する */
  function finishPen(closed: boolean) {
    const draft = penRef.current
    penRef.current = null
    redraw()
    if (!draft || draft.points.length < 2) return

    const page = store.getState().page
    const parentId = findFrameAt(page, draft.points[0])
    const shape = pathFromPoints(draft.points.map((point) => toLocal(page, parentId, point)))
    const node = { ...createPath(shape, closed), name: nextName(page, 'path') }
    store.apply((base) => insertNode(base, node, parentId))
    store.select([node.id])
    onToolChange('select')
  }

  /** リサイズと回転のハンドルを出す枠 */
  function selectionBox(): SelectionBox | null {
    if (tool !== 'select' || editingRef.current || pointTarget()) return null
    const page = store.getState().page
    const ids = movableIds()
    const bounds = getNodesBounds(page, ids)
    if (!bounds) return null

    const rotation = ids.length === 1 ? normalizeAngle(getWorldRotation(page, ids[0])) : 0
    if (rotation !== 0) {
      const { width, height } = page.nodes[ids[0]]
      const matrix = getWorldMatrix(page, ids[0])
      return { ids, matrix, size: { width, height }, rotation, bounds, oriented: ids[0] }
    }
    return {
      ids,
      matrix: [1, 0, 0, 1, bounds.x, bounds.y],
      size: { width: bounds.width, height: bounds.height },
      rotation: 0,
      bounds,
      oriented: null,
    }
  }

  /** 枠の座標系の点を画面座標に直す */
  function boxToScreen(box: SelectionBox, point: Point): Point {
    return worldToScreen(camera.getViewport(), applyMatrix(box.matrix, point))
  }

  /** 画面に映っている枠の大きさ。どのハンドルを出すかを決めるのに使う */
  function screenSize(box: SelectionBox): Bounds {
    const zoom = camera.getViewport().zoom
    return { x: 0, y: 0, width: box.size.width * zoom, height: box.size.height * zoom }
  }

  /** 回転ハンドルの位置（画面座標）。枠の上辺の中央から少し離す */
  function rotateHandlePoint(box: SelectionBox): Point {
    const offset = ROTATE_HANDLE_OFFSET / camera.getViewport().zoom
    return boxToScreen(box, { x: box.size.width / 2, y: -offset })
  }

  /**
   * 吸着先になる矩形（ページ座標）。parentId の子と、parentId のフレーム自身。
   * 動かしている最中のノードは除く。
   */
  function snapTargets(parentId: NodeId | null, exclude: ReadonlySet<NodeId>): Bounds[] {
    const page = store.getState().page
    const parent = parentId === null ? null : page.nodes[parentId]
    const siblings = parent?.type === 'frame' ? parent.children : page.rootIds
    const targets = siblings
      .filter((id) => !exclude.has(id) && page.nodes[id].visible)
      .map((id) => getAbsoluteBounds(page, id))
    if (parent) targets.push(getAbsoluteBounds(page, parent.id))
    return targets
  }

  function handleAt(screen: Point): Handle | null {
    const box = selectionBox()
    if (!box) return null
    // 角を先に調べる
    const handles = visibleHandles(screenSize(box)).toSorted((a, b) => b.length - a.length)
    for (const handle of handles) {
      const p = boxToScreen(box, handlePoint({ x: 0, y: 0, ...box.size }, handle))
      if (Math.abs(p.x - screen.x) <= HANDLE_SIZE && Math.abs(p.y - screen.y) <= HANDLE_SIZE) {
        return handle
      }
    }
    return null
  }

  function rotateHandleAt(screen: Point): boolean {
    const box = selectionBox()
    return box !== null && distance(rotateHandlePoint(box), screen) <= HANDLE_SIZE
  }

  function pick(pointer: CanvasPointer): NodeId | null {
    const page = store.getState().page
    const viewport = camera.getViewport()
    return (
      hitTestFrameLabel(page, viewport, pointer.screen, measureFrameLabel) ??
      hitTest(page, pointer.world, { tolerance: 3 / viewport.zoom })
    )
  }

  /** shape は親の座標系での枠。直線なら向きも含む */
  function previewCreate(
    gesture: Extract<Gesture, { kind: 'create' }>,
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

  /** width を渡すと、その幅で折り返すテキストになる */
  function startNewText(world: Point, width?: number) {
    const page = store.getState().page
    // 既存のテキストの上をクリックしたら、新しく作らずそれを編集する
    const hit = hitTest(page, world)
    if (hit && page.nodes[hit].type === 'text') {
      store.select([hit])
      changeEditing({ id: hit, draft: null })
      return
    }
    const template: TextNode = {
      ...createText({ x: 0, y: 0, width: width ?? 0, height: 0 }),
      name: nextName(page, 'text'),
      autoWidth: width === undefined,
    }
    const size = measureTextNode(template)
    const parentId = findFrameAt(page, world)
    const local = toLocal(page, parentId, world)
    // クリックで作ったときは、その位置が 1 行目の中央に来るように置く
    const lift = width === undefined ? (template.fontSize * template.lineHeight) / 2 : 0
    const node: TextNode = {
      ...template,
      ...size,
      x: Math.round(local.x),
      y: Math.round(local.y - lift),
    }
    store.preview((base) => insertNode(base, node, parentId))
    store.select([node.id])
    changeEditing({ id: node.id, draft: { node, parentId } })
  }

  function onTextInput(text: string) {
    const current = editingRef.current
    if (!current) return
    if (current.draft) {
      const { node, parentId } = current.draft
      const next = { ...node, text, ...measureTextNode({ ...node, text }) }
      store.preview((base) => insertNode(base, next, parentId))
      store.select([node.id])
    } else {
      const node = store.getState().page.nodes[current.id]
      if (node?.type !== 'text') return
      const size = measureTextNode({ ...node, text })
      store.preview((base) => updateNode(base, current.id, { text, ...size }))
    }
  }

  function finishEditing() {
    const current = editingRef.current
    if (!current) return
    changeEditing(null)
    const node = store.getState().page.nodes[current.id]
    if (node?.type === 'text' && node.text.trim() !== '') {
      store.commitPreview()
    } else {
      // 空のテキストは残さない。インスタンスの中身は消せないので、元の文言に戻すだけ
      store.cancelPreview()
      const removable = !current.draft && !owningInstance(store.getState().page, current.id)
      if (removable) store.apply((page) => removeNodes(page, [current.id]))
    }
    onToolChange('select')
  }

  function onPointerDown(pointer: CanvasPointer) {
    if (editingRef.current) {
      // 編集中のクリックは確定だけして、選択などは行わない
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      finishEditing()
      return
    }
    setHover(null)
    const { page, selection } = store.getState()

    if (tool === 'text') {
      gestureRef.current = { kind: 'text', screen: pointer.screen, world: pointer.world }
      return
    }
    if (tool === 'pen') {
      const draft = (penRef.current ??= { points: [], cursor: null })
      const last = draft.points.at(-1)
      // 最初の頂点をクリックすると、閉じた形になる
      if (draft.points.length >= 2) {
        const first = worldToScreen(camera.getViewport(), draft.points[0])
        if (distance(first, pointer.screen) <= HANDLE_SIZE) return finishPen(true)
      }
      const point =
        pointer.shiftKey && last ? constrainAngle(last, pointer.world) : roundPoint(pointer.world)
      // ダブルクリックの 2 回目など、同じ場所には重ねて打たない
      if (!last || last.x !== point.x || last.y !== point.y) draft.points.push(point)
      redraw()
      return
    }
    if (tool !== 'select') {
      const world = roundPoint(pointer.world)
      const create = {
        frame: createFrame,
        rect: createRect,
        ellipse: createEllipse,
        line: createLine,
      }[tool]
      gestureRef.current = {
        kind: 'create',
        screen: pointer.screen,
        world,
        node: { ...create({ x: 0, y: 0, width: 1, height: 1 }), name: nextName(page, tool) },
        parentId: findFrameAt(page, world),
        dragged: false,
      }
      return
    }

    const grabbed = pointAt(pointer.screen)
    if (grabbed) {
      gestureRef.current = { kind: 'point', ...grabbed }
      return
    }

    const box = selectionBox()
    if (box && rotateHandleAt(pointer.screen)) {
      const pivot = applyMatrix(box.matrix, { x: box.size.width / 2, y: box.size.height / 2 })
      gestureRef.current = {
        kind: 'rotate',
        ids: box.ids,
        pivot,
        startAngle: angleFrom(pivot, pointer.world),
        // 1 つだけ選んでいるときは、そのノードの角度をきりのよい値に揃えられるようにする
        baseRotation: box.ids.length === 1 ? page.nodes[box.ids[0]].rotation : 0,
        delta: 0,
      }
      return
    }

    const handle = handleAt(pointer.screen)
    if (handle && box?.oriented) {
      gestureRef.current = {
        kind: 'reshape',
        world: pointer.world,
        handle,
        id: box.oriented,
        rotation: box.rotation,
        size: box.size,
      }
      return
    }
    if (handle && box) {
      gestureRef.current = {
        kind: 'resize',
        world: pointer.world,
        handle,
        from: box.bounds,
        ids: box.ids,
        guides: [],
      }
      return
    }

    const hit = pick(pointer)
    if (!hit) {
      if (!pointer.shiftKey) store.select([])
      gestureRef.current = {
        kind: 'marquee',
        world: pointer.world,
        current: pointer.world,
        base: pointer.shiftKey ? selection : [],
      }
      return
    }

    let collapseTo: NodeId | null = null
    if (pointer.shiftKey) {
      const selected = selection.includes(hit)
      store.select(selected ? selection.filter((id) => id !== hit) : [...selection, hit])
      if (selected) return
    } else if (selection.includes(hit)) {
      // 複数選択の 1 つを押した場合、ドラッグなら全体を動かし、クリックだけならそれ 1 つに絞る
      collapseTo = hit
    } else {
      store.select([hit])
    }
    gestureRef.current = { kind: 'press', screen: pointer.screen, world: pointer.world, collapseTo }
  }

  function onPointerMove(pointer: CanvasPointer) {
    let gesture = gestureRef.current
    if (!gesture) {
      if (tool === 'pen' && penRef.current) {
        penRef.current.cursor = pointer.world
        redraw()
        return
      }
      if (tool !== 'select' || editingRef.current) return
      const handle = handleAt(pointer.screen)
      const endpoint = pointAt(pointer.screen)
      const rotating = rotateHandleAt(pointer.screen)
      const rotation = selectionBox()?.rotation ?? 0
      setCursor(
        rotating ? 'grab' : handle ? handleCursor(handle, rotation) : endpoint ? 'crosshair' : 'default',
      )
      setHover(rotating || handle || endpoint ? null : pick(pointer))
      return
    }

    if (gesture.kind === 'rotate') {
      const { ids, pivot, baseRotation } = gesture
      let delta = Math.round(normalizeAngle(angleFrom(pivot, pointer.world) - gesture.startAngle))
      // Shift で 15° 刻みに揃える
      if (pointer.shiftKey) delta = Math.round((baseRotation + delta) / 15) * 15 - baseRotation
      gesture.delta = delta
      store.preview((base) => rotateNodes(base, ids, pivot, delta))
      redraw()
      return
    }

    if (gesture.kind === 'reshape') {
      const { id, handle, size } = gesture
      // ポインタの動きを、ノードの向きに沿った成分に直す
      const moved = rotateVector(
        { x: pointer.world.x - gesture.world.x, y: pointer.world.y - gesture.world.y },
        -gesture.rotation,
      )
      // 画像は歪まないよう、Shift を押さない限り縦横比を保つ
      const keepAspect = pointer.shiftKey !== (store.getState().page.nodes[id]?.type === 'image')
      const box = roundBox(
        resizeBounds({ x: 0, y: 0, ...size }, handle, moved.x, moved.y, keepAspect),
        handle,
      )
      store.preview((base) => fitTextNodes(reshapeNode(base, id, box), [id]))
      return
    }

    if (gesture.kind === 'point') {
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
        const shape =
          node.type === 'line' ? lineBetween(points[0], points[1]) : pathFromPoints(points)
        return updateNode(base, id, { ...shape, rotation: 0 })
      })
      return
    }

    if (gesture.kind === 'press') {
      if (distance(pointer.screen, gesture.screen) < DRAG_THRESHOLD) return
      const ids = movableIds()
      const from = getNodesBounds(store.getState().page, ids)
      if (!from) {
        gestureRef.current = null
        return
      }
      gesture = gestureRef.current = { kind: 'move', world: gesture.world, ids, from, guides: [] }
    }

    if (gesture.kind === 'move') {
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

      // 自動で並べるフレームの中では、位置はフレームが決める。ポインタの位置に応じて順番だけ入れ替える
      const parent = parentId === null ? null : store.getState().page.nodes[parentId]
      if (parent?.type === 'frame' && parent.layout) {
        gesture.guides = []
        store.preview((base) => placeInLayout(base, ids, parent.id, pointer.world))
        return
      }

      // 近くの図形や親フレームの端・中央に吸着する。Cmd / Ctrl を押している間は吸着しない
      const targets = pointer.modKey ? [] : snapTargets(parentId, exclude)
      const snap = snapMove(
        { ...gesture.from, x: gesture.from.x + dx, y: gesture.from.y + dy },
        targets,
        SNAP_DISTANCE / camera.getViewport().zoom,
      )
      // Shift で向きを固定しているときは、固定した向きには吸着させない
      if (!pointer.shiftKey || dx !== 0) dx = Math.round(dx + snap.dx)
      if (!pointer.shiftKey || dy !== 0) dy = Math.round(dy + snap.dy)
      gesture.guides = findGuides(
        { ...gesture.from, x: gesture.from.x + dx, y: gesture.from.y + dy },
        targets,
      )

      store.preview((base) => reparentNodes(translateNodes(base, ids, dx, dy), ids, parentId))
    } else if (gesture.kind === 'resize') {
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
      const targets = pointer.modKey ? [] : snapTargets(page.nodes[ids[0]].parentId, exclude)
      if (!keepAspect) to = snapResize(to, handle, targets, SNAP_DISTANCE / camera.getViewport().zoom)
      const target = to
      store.preview((base) => fitTextNodes(resizeNodes(base, ids, from, target), ids))
      const resized = getNodesBounds(store.getState().page, ids)
      gesture.guides = resized ? findGuides(resized, targets, handle) : []
    } else if (gesture.kind === 'marquee') {
      gesture.current = pointer.world
      const hits = nodesInMarquee(
        store.getState().page,
        boundsFromPoints(gesture.world, gesture.current),
      )
      store.select([...new Set([...gesture.base, ...hits])])
    } else if (gesture.kind === 'create') {
      if (!gesture.dragged && distance(pointer.screen, gesture.screen) < DRAG_THRESHOLD) return
      gesture.dragged = true
      // フレームの中に描くときは、フレームが回っていてもその中の座標で形を決める
      const page = store.getState().page
      const from = roundPoint(toLocal(page, gesture.parentId, gesture.world))
      const to = toLocal(page, gesture.parentId, pointer.world)
      if (gesture.node.type === 'line') {
        // Shift で水平・垂直・45° に揃える
        const end = pointer.shiftKey ? constrainAngle(from, to) : roundPoint(to)
        previewCreate(gesture, lineBetween(from, end))
        return
      }
      let end = roundPoint(to)
      if (pointer.shiftKey) {
        const dx = end.x - from.x
        const dy = end.y - from.y
        const side = Math.max(Math.abs(dx), Math.abs(dy))
        end = { x: from.x + (dx < 0 ? -side : side), y: from.y + (dy < 0 ? -side : side) }
      }
      previewCreate(gesture, boundsFromPoints(from, end))
    }
  }

  function onPointerUp(pointer: CanvasPointer) {
    const gesture = gestureRef.current
    gestureRef.current = null
    if (!gesture) return

    switch (gesture.kind) {
      case 'press':
        if (gesture.collapseTo) store.select([gesture.collapseTo])
        break
      case 'move':
      case 'resize':
      case 'reshape':
      case 'rotate':
      case 'point':
        store.commitPreview()
        redraw()
        break
      case 'marquee':
        redraw()
        break
      case 'create':
        // ドラッグせずクリックしただけなら既定の大きさで置く
        if (!gesture.dragged) {
          const at = roundPoint(toLocal(store.getState().page, gesture.parentId, gesture.world))
          previewCreate(gesture, { ...at, width: 100, height: gesture.node.type === 'line' ? 0 : 100 })
        }
        store.commitPreview()
        store.select([gesture.node.id])
        onToolChange('select')
        break
      case 'text': {
        // ドラッグして作ると、その幅で折り返すテキストになる
        const end = pointer.world
        const dragged = distance(pointer.screen, gesture.screen) >= DRAG_THRESHOLD
        const width = Math.round(Math.abs(end.x - gesture.world.x))
        if (dragged && width >= 1) {
          const origin = { x: Math.min(gesture.world.x, end.x), y: Math.min(gesture.world.y, end.y) }
          startNewText(origin, width)
        } else {
          startNewText(gesture.world)
        }
        break
      }
    }
  }

  function cancelGesture() {
    gestureRef.current = null
    store.cancelPreview()
    redraw()
  }

  function onDoubleClick(pointer: CanvasPointer) {
    if (tool === 'pen') return finishPen(false)
    if (tool !== 'select' || editingRef.current) return
    const page = store.getState().page
    const tolerance = 3 / camera.getViewport().zoom
    const top = hitTest(page, pointer.world, { tolerance })
    if (!top) return
    // インスタンスは、ダブルクリックで中身を選べる（文言や色を、そのインスタンスだけ変えられる）
    const inner = isInstance(page.nodes[top])
    const hit = inner ? (hitTest(page, pointer.world, { tolerance, deep: true }) ?? top) : top
    if (page.nodes[hit].type === 'text') {
      store.select([hit])
      changeEditing({ id: hit, draft: null })
    } else if (inner) {
      store.select([hit])
    } else if (page.nodes[hit].type === 'path') {
      // パスは頂点の編集に入る。別のものを選ぶか Esc で抜ける
      store.select([hit])
      vertexEditRef.current = hit
      redraw()
    }
  }

  /** いまのページへ貼り付けて、貼り付けたものを選択する */
  function paste(fragment: Fragment, offset: number) {
    const pageId = store.getState().page.id
    let ids: NodeId[] = []
    store.applyDocument((document) => {
      const result = pasteIntoPage(document, pageId, fragment, offset)
      ids = result.ids
      return result.document
    })
    store.select(ids)
  }

  /** 選択中のノードを、使っている画像ごと切り出す */
  function copySelection(): Fragment {
    const { document, page } = store.getState()
    return copyFragment(page, document.assets, ownIds())
  }

  function onKeyDown(event: KeyboardEvent) {
    if (isTextInput(event.target) || event.isComposing) return
    const { page, selection } = store.getState()
    const key = event.key.toLowerCase()

    if (key === 'escape' || (key === 'enter' && penRef.current)) {
      if (gestureRef.current) cancelGesture()
      else if (penRef.current) finishPen(false)
      else if (tool !== 'select') onToolChange('select')
      else if (editedPath()) {
        vertexEditRef.current = null
        redraw()
      } else store.select([])
      return
    }
    // ドラッグ中に削除などが割り込むと、プレビュー中の変更と食い違う
    if (gestureRef.current) return

    const reorder = (direction: ReorderDirection) =>
      store.apply((base) => reorderNodes(base, ownIds(), direction))
    const remove = () => store.apply((base) => removeNodes(base, movableIds()))
    const zoom = camera.getViewport().zoom

    if ((event.metaKey || event.ctrlKey) && event.altKey && event.code === 'KeyK') {
      // 選んでいるフレームをコンポーネントにする（Alt を押すと key が記号になるので code で見る）
      store.apply((base) => ownIds().reduce((next, id) => makeComponent(next, id), base))
      event.preventDefault()
      return
    }
    if (event.metaKey || event.ctrlKey) {
      switch (key) {
        case 'z':
          if (event.shiftKey) store.redo()
          else store.undo()
          break
        case 'y':
          store.redo()
          break
        case 'a':
          store.select(page.rootIds.filter((id) => page.nodes[id].visible && !page.nodes[id].locked))
          break
        case 'd':
          if (ownIds().length > 0) paste(copySelection(), 10)
          break
        case ']':
          reorder('forward')
          break
        case '[':
          reorder('backward')
          break
        case '0':
          camera.zoomTo(1)
          break
        case '=':
        case '+':
        case ';':
          camera.zoomTo(zoom * 1.25)
          break
        case '-':
          camera.zoomTo(zoom / 1.25)
          break
        default:
          return
      }
      event.preventDefault()
      return
    }
    if (event.altKey) return

    const step = event.shiftKey ? 10 : 1
    const nudge = (dx: number, dy: number) =>
      store.apply((base) => translateNodes(base, movableIds(), dx, dy))
    const tools: Record<string, Tool> = {
      v: 'select',
      f: 'frame',
      r: 'rect',
      o: 'ellipse',
      l: 'line',
      p: 'pen',
      t: 'text',
    }

    if (event.shiftKey && key === 'a') {
      // 選んだものを、自動で並べるフレームにまとめる
      let frameId: NodeId | null = null
      store.apply((base) => {
        const result = wrapInAutoLayout(base, movableIds(), nextName(base, 'frame'))
        frameId = result.id
        return result.scene
      })
      if (frameId) store.select([frameId])
    } else if (event.shiftKey && event.code === 'Digit1') camera.fit(getContentBounds(page))
    else if (event.shiftKey && event.code === 'Digit0') camera.zoomTo(1)
    else if (Object.hasOwn(tools, key)) onToolChange(tools[key])
    else if (key === 'delete' || key === 'backspace') remove()
    else if (key === ']') reorder('front')
    else if (key === '[') reorder('back')
    else if (key === 'arrowleft') nudge(-step, 0)
    else if (key === 'arrowright') nudge(step, 0)
    else if (key === 'arrowup') nudge(0, -step)
    else if (key === 'arrowdown') nudge(0, step)
    else if (key === 'enter' && selection.length === 1 && page.nodes[selection[0]].type === 'text') {
      changeEditing({ id: selection[0], draft: null })
    } else return
    event.preventDefault()
  }

  // コピーと貼り付けはブラウザの clipboard イベントで受ける。キー入力で受けると、
  // OS のクリップボードにある画像を貼り付けられない
  function onCopy(event: ClipboardEvent) {
    if (isTextInput(event.target) || gestureRef.current) return
    const { page } = store.getState()
    if (ownIds().length === 0) return
    clipboardRef.current = { fragment: copySelection(), pastes: 0 }
    // OS のクリップボードも置き換える（中身はレイヤー名）。古い画像が残っていると、
    // 貼り付けでそちらが優先されてしまう
    const names = clipboardRef.current.fragment.rootIds.map((id) => page.nodes[id].name)
    event.clipboardData?.setData('text/plain', names.join('\n'))
    event.preventDefault()
    if (event.type === 'cut') store.apply((base) => removeNodes(base, movableIds()))
  }

  function onPaste(event: ClipboardEvent) {
    if (isTextInput(event.target) || gestureRef.current) return
    const images = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'))
    event.preventDefault()
    if (images.length > 0) {
      onPasteImages(images)
    } else if (clipboardRef.current) {
      const clipboard = clipboardRef.current
      clipboard.pastes += 1
      paste(clipboard.fragment, clipboard.pastes * 10)
    }
  }

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('copy', onCopy)
    window.addEventListener('cut', onCopy)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('copy', onCopy)
      window.removeEventListener('cut', onCopy)
      window.removeEventListener('paste', onPaste)
    }
  })

  function drawOverlay(ctx: CanvasRenderingContext2D, viewport: Viewport) {
    const { page, selection } = state
    const gesture = gestureRef.current
    ctx.strokeStyle = ACCENT
    ctx.lineWidth = 1

    /** ページ座標の点をつないだ線を引く */
    const polyline = (points: Point[], close: boolean) => {
      ctx.beginPath()
      for (const [index, point] of points.entries()) {
        const p = worldToScreen(viewport, point)
        // 回っていない枠の線がにじまないよう、ピクセルの中心に合わせる
        const x = Math.round(p.x) + 0.5
        const y = Math.round(p.y) + 0.5
        if (index === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      if (close) ctx.closePath()
      ctx.stroke()
    }

    const drawHandle = (p: Point) => {
      const x = Math.round(p.x - HANDLE_SIZE / 2) + 0.5
      const y = Math.round(p.y - HANDLE_SIZE / 2) + 0.5
      ctx.fillRect(x, y, HANDLE_SIZE, HANDLE_SIZE)
      ctx.strokeRect(x, y, HANDLE_SIZE, HANDLE_SIZE)
    }

    // 回っていればその向きのまま枠をなぞる。直線は枠ではなく線そのものをなぞる
    const outlineNode = (id: NodeId) => {
      const node = page.nodes[id]
      if (node.type === 'line') polyline(lineEnds(page, node), false)
      else polyline(getCorners(page, id), true)
    }

    if (hover && !gesture && page.nodes[hover] && !selection.includes(hover)) {
      ctx.lineWidth = 2
      outlineNode(hover)
      ctx.lineWidth = 1
    }
    // 頂点を編集中のパスは、枠ではなく形そのものを後でなぞる
    const editedId = editedPath()?.id
    for (const id of selection) if (id !== editedId) outlineNode(id)

    const pointed = pointTarget()
    const current = pointed && page.nodes[pointed.id]
    if (current?.type === 'line' || current?.type === 'path') {
      const points = editablePoints(page, current)
      // 頂点を編集中のパスは、形そのものをなぞって見せる
      if (current.type === 'path') polyline(points, current.closed)
      ctx.fillStyle = '#ffffff'
      for (const point of points) drawHandle(worldToScreen(viewport, point))
    }

    // ペンツールで描いている途中の線。最後の頂点からポインタまでも結ぶ
    const draft = penRef.current
    if (draft && draft.points.length > 0) {
      polyline(draft.cursor ? [...draft.points, draft.cursor] : draft.points, false)
      ctx.fillStyle = '#ffffff'
      for (const point of draft.points) drawHandle(worldToScreen(viewport, point))
    }

    const box = selectionBox()
    if (box && gesture?.kind !== 'move') {
      const { width: w, height: h } = box.size
      const corner = (x: number, y: number) => applyMatrix(box.matrix, { x, y })
      if (selection.length > 1) polyline([corner(0, 0), corner(w, 0), corner(w, h), corner(0, h)], true)

      // 回転ハンドル。上辺の中央から柄を伸ばした先に置く
      const knob = rotateHandlePoint(box)
      const stem = boxToScreen(box, { x: w / 2, y: 0 })
      ctx.beginPath()
      ctx.moveTo(stem.x, stem.y)
      ctx.lineTo(knob.x, knob.y)
      ctx.stroke()
      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.arc(knob.x, knob.y, HANDLE_SIZE / 2, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()

      for (const handle of visibleHandles(screenSize(box))) {
        drawHandle(boxToScreen(box, handlePoint({ x: 0, y: 0, width: w, height: h }, handle)))
      }

      // 選択範囲の大きさを下に出す。回している最中は角度を出す
      const label =
        gesture?.kind === 'rotate'
          ? `${normalizeAngle(gesture.baseRotation + gesture.delta)}°`
          : `${Math.round(w)} × ${Math.round(h)}`
      const screen = toScreenBounds(viewport, box.bounds)
      ctx.font = '11px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const width = ctx.measureText(label).width + 10
      const centerX = screen.x + screen.width / 2
      const top = screen.y + screen.height + 8
      ctx.fillStyle = ACCENT
      ctx.beginPath()
      ctx.roundRect(centerX - width / 2, top, width, 18, 4)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.fillText(label, centerX, top + 9.5)
    }

    if (gesture?.kind === 'move' || gesture?.kind === 'resize') {
      ctx.strokeStyle = GUIDE
      ctx.beginPath()
      for (const guide of gesture.guides) {
        const along = guide.axis === 'x' ? 'y' : 'x'
        const from = worldToScreen(viewport, { x: 0, y: 0, [guide.axis]: guide.position, [along]: guide.from })
        const to = worldToScreen(viewport, { x: 0, y: 0, [guide.axis]: guide.position, [along]: guide.to })
        ctx.moveTo(Math.round(from.x) + 0.5, Math.round(from.y) + 0.5)
        ctx.lineTo(Math.round(to.x) + 0.5, Math.round(to.y) + 0.5)
      }
      ctx.stroke()
      ctx.strokeStyle = ACCENT
    }

    if (gesture?.kind === 'marquee') {
      const b = toScreenBounds(viewport, boundsFromPoints(gesture.world, gesture.current))
      ctx.fillStyle = 'rgba(13, 153, 255, 0.12)'
      ctx.fillRect(b.x, b.y, b.width, b.height)
      ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.width, b.height)
    }
  }

  return (
    <CanvasView
      scene={state.page}
      assets={state.document.assets}
      camera={camera}
      hiddenId={editing?.id}
      cursor={tool === 'select' ? cursor : tool === 'text' ? 'text' : 'crosshair'}
      drawOverlay={drawOverlay}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={cancelGesture}
      onDoubleClick={onDoubleClick}
    >
      {editing && (
        <TextEditor
          key={editing.id}
          scene={state.page}
          camera={camera}
          id={editing.id}
          selectAll={editing.draft === null}
          onInput={onTextInput}
          onDone={finishEditing}
        />
      )}
    </CanvasView>
  )
}
