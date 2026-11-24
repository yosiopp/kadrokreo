import { type RefObject, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { type CanvasPointer, CanvasView } from '../canvas/CanvasView.tsx'
import type { Camera } from '../canvas/camera.ts'
import { hitTest } from '../canvas/hitTest.ts'
import { HIT_TOLERANCE, pickNode } from '../canvas/pick.ts'
import { isBooleanNode } from '../document/booleanNode.ts'
import { type Viewport, worldToScreen } from '../canvas/viewport.ts'
import { isInstance, owningInstance } from '../document/component.ts'
import { type Point, applyMatrix, getNodesBounds, invert, toLocal } from '../document/geometry.ts'
import { type Vertex, isLine, mapVertices, pathFromPoints } from '../document/path.ts'
import type { Gradient, NodeId, PathNode, SceneNode } from '../document/types.ts'
import { ContextMenu, type MenuItem } from './ContextMenu.tsx'
import { TextEditor } from './TextEditor.tsx'
import { makeComponent, withoutCopies } from './components.ts'
import { type Gesture, createGesture, dragGesture, moveGesture, previewCreate, rotateGesture } from './editorCanvas/drag.ts'
import {
  DRAG_THRESHOLD,
  HANDLE_SIZE,
  type PointPart,
  type SelectionBox,
  constrainAngle,
  distance,
  editableContours,
  handleAt,
  nextName,
  rotateHandleAt,
  roundPoint,
  selectionBoxOf,
  visibleContourControls,
} from './editorCanvas/handles.ts'
import { drawEditorOverlay } from './editorCanvas/overlay.ts'
import {
  type GradientEdit,
  type GradientHandles,
  editedGradient,
  gradientPartAt,
  gradientToEdit,
  offsetOnAxis,
  stopMarkers,
  worldGradientHandles,
} from './editorCanvas/gradientHandles.ts'
import { patchGradientAt, withStopAt, withStopRemoved } from './operations/paints.ts'
import { canCreateBooleanNode, canFlattenBoolean } from './operations/booleanNodes.ts'
import { canOutlineStroke } from './operations/outline.ts'
import { BOOLEAN_LABELS, addContour, canBooleanPaths, canJoinPaths, canSplitPaths, maskAction } from './operations/paths.ts'
import { useShortcuts } from './editorCanvas/useShortcuts.ts'
import { useTextEditing } from './editorCanvas/useTextEditing.ts'
import { findFrameAt } from './hitTest.ts'
import { isSelfOrAncestor } from './operations/tree.ts'
import { createPath } from './nodes.ts'
import { insertNode, updateNodes } from './operations/tree.ts'
import {
  deleteContourVertices,
  editByContour,
  flatVertices,
  insertVertex,
  moveVertices,
  nearestOnContours,
  openAtSegment,
  reshapeContours,
  toggleSmooth,
  withFlatVertices,
} from './pathEdit.ts'
import { handleCursor } from './resize.ts'
import type { EditorState, EditorStore } from './store.ts'
import type { Tool } from './tools.ts'

// メニューに出すショートカットの表記。macOS は記号、ほかは Ctrl などの名前
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = MAC ? '⌘' : 'Ctrl+'
const SHIFT = MAC ? '⇧' : 'Shift+'
const ALT = MAC ? '⌥' : 'Alt+'
/** 右クリックメニューのブーリアン演算（キーは Alt + Shift で元を残す、⌘/Ctrl も足すと焼き込む） */
const BOOLEAN_MENU = [
  { op: 'union', key: 'U' },
  { op: 'subtract', key: 'S' },
  { op: 'intersect', key: 'I' },
  { op: 'exclude', key: 'X' },
] as const

// 選択枠・ハンドルの計算、ドラッグ中のプレビュー、重ねて描く印、キーボード、テキストの編集は editorCanvas/ にある。
// ここはポインタの押す・離すから、どのジェスチャーを始めるかを決める

type Props = {
  store: EditorStore
  camera: Camera
  state: EditorState
  tool: Tool
  onToolChange: (tool: Tool) => void
  /** クリップボードから画像が貼り付けられた */
  onPasteImages: (files: File[]) => void
  onPasteSvg: (text: string) => void
  /** 操作ができなかった理由などを知らせる */
  onMessage: (message: string) => void
  /** 選択中のものを SVG の文字にしてクリップボードへ入れる（右クリックメニューの「SVG としてコピー」） */
  onCopySvg: () => void
  /** コンポーネントの一覧からドラッグしているインスタンスが入るフレーム（ページ直下なら null） */
  dropTarget?: NodeId | null
  /** ほかの場所（レイヤーパネル）から右クリックメニューを出すための口。ここに出す関数を入れる */
  menuOpenerRef?: RefObject<MenuOpener | null>
}

/** 選択中のものについての右クリックメニューを、画面座標（clientX / clientY）に出す */
export type MenuOpener = (at: Point) => void

export function EditorCanvas({
  store,
  camera,
  state,
  tool,
  onToolChange,
  onPasteImages,
  onPasteSvg,
  onCopySvg,
  onMessage,
  dropTarget = null,
  menuOpenerRef,
}: Props) {
  const gestureRef = useRef<Gesture | null>(null)
  // ペンツールで描いている途中の頂点（ページ座標、制御点を含む）。cursor はポインタの位置
  const penRef = useRef<{ points: Vertex[]; cursor: Point | null } | null>(null)
  // ペンツールで押している間の、押した位置（画面座標）。ドラッグすると最後の頂点の制御点を引き出す
  const penPressRef = useRef<Point | null>(null)
  const [hover, setHover] = useState<NodeId | null>(null)
  const [cursor, setCursor] = useState('default')
  // 右クリックメニューを出している位置（ウィンドウの画面座標）
  const [menuAt, setMenuAt] = useState<Point | null>(null)
  const closeMenu = useCallback(() => setMenuAt(null), [])
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const { editing, editingRef, editText, startNewText, onTextInput, finishEditing } = useTextEditing(
    store,
    onToolChange,
  )

  // 頂点の編集中にペンツールへ切り替えたときの、そのパス。ペンで描いた形を新しいパスにせず、このパスの輪郭として足す
  const contourTargetRef = useRef<NodeId | null>(null)

  // ツールを切り替えたら、描きかけのパスや頂点の編集は終える（別のものを選んだときは、ストアが頂点の編集を終える）
  useEffect(() => {
    if (tool !== 'pen') {
      penRef.current = null
      contourTargetRef.current = null
    }
    const { vertexEdit, page, selection } = store.getState()
    if (tool === 'pen' && vertexEdit && selection.length === 1 && selection[0] === vertexEdit.id && page.nodes[vertexEdit.id]?.type === 'path') {
      contourTargetRef.current = vertexEdit.id
    }
    if (tool !== 'select' && vertexEdit) store.editVertices(null)
    if (tool !== 'select' && store.getState().gradientEdit) store.editGradient(null)
  }, [tool, store])

  /** 選択中のうち、インスタンスの中身（写し）でないもの。動かす・消す・複製するといった操作の対象になる */
  function ownIds(): NodeId[] {
    const { page, selection } = store.getState()
    return withoutCopies(page, selection)
  }

  /** 選択中のうち動かせるもの */
  function movableIds(): NodeId[] {
    const { page } = store.getState()
    return ownIds().filter((id) => !page.nodes[id].locked)
  }

  /** 選択ツールで、文字を編集中でなく、1 つだけ選んでいるときの、そのノード */
  function soleSelected(): SceneNode | null {
    if (tool !== 'select' || editingRef.current) return null
    const { page, selection } = store.getState()
    return selection.length === 1 ? (page.nodes[selection[0]] ?? null) : null
  }

  /** 直線を 1 本だけ選んでいるとき。枠のハンドルの代わりに、両端をつかんで動かせる */
  function selectedLine(): PathNode | null {
    const node = soleSelected()
    if (node?.type !== 'path' || !isLine(node) || node.locked) return null
    return owningInstance(store.getState().page, node.id) ? null : node
  }

  /** 頂点を編集中のパス。そのパスだけを選んでいる間だけ有効 */
  function editedPath(): PathNode | null {
    const node = soleSelected()
    return node?.type === 'path' && node.id === store.getState().vertexEdit?.id && !node.locked ? node : null
  }

  /** キャンバスで動かしているグラデーションと、そのハンドルの位置（ページ座標）。選択ツールで、そのノードだけを選んでいる間だけ */
  function editedGradientHandles(): { edit: GradientEdit; gradient: Gradient; handles: GradientHandles } | null {
    const node = soleSelected()
    const { page, gradientEdit: edit } = store.getState()
    if (!node || !edit || edit.id !== node.id) return null
    const gradient = editedGradient(page, edit)
    return gradient ? { edit, gradient, handles: worldGradientHandles(page, node.id, gradient) } : null
  }

  /** グラデーションのハンドルの画面座標。stops は色の印の位置（線の横に離す）、onLine は線の上の色の位置 */
  function screenGradientHandles(handles: GradientHandles): GradientHandles & { onLine: Point[] } {
    const viewport = camera.getViewport()
    const toScreen = (point: Point) => worldToScreen(viewport, point)
    const axis: [Point, Point] = [toScreen(handles.axis[0]), toScreen(handles.axis[1])]
    const onLine = handles.stops.map(toScreen)
    return {
      axis,
      radiusY: handles.radiusY && toScreen(handles.radiusY),
      focus: handles.focus && toScreen(handles.focus),
      stops: stopMarkers(axis, onLine),
      onLine,
    }
  }

  /** screen の近くにある、グラデーションのハンドル */
  function gradientPartNear(screen: Point) {
    const edited = editedGradientHandles()
    if (!edited) return null
    const part = gradientPartAt(screenGradientHandles(edited.handles), edited.gradient, (point) => distance(point, screen) <= HANDLE_SIZE)
    return part && { ...edited, part }
  }

  /** 点をつかんで形を変えられるノード。直線は選ぶだけで、パスは頂点の編集に入ると対象になる（直線も入れる） */
  function pointTarget(): PathNode | null {
    return editedPath() ?? selectedLine()
  }

  /** 頂点の編集中に選んでいる頂点（なければ空） */
  function selectedVertices(): number[] {
    return editedPath() ? (store.getState().vertexEdit?.vertices ?? []) : []
  }

  /** 頂点の編集中に選んでいる辺（なければ null） */
  function selectedSegment(): number | null {
    return editedPath() ? (store.getState().vertexEdit?.segment ?? null) : null
  }

  /** 頂点の編集中の、選んでいる頂点・辺を変える */
  function selectVertices(vertices: number[], segment: number | null = null) {
    const node = editedPath()
    if (node) store.editVertices({ id: node.id, vertices, segment })
  }

  /** screen にある、つかめる点。制御点のハンドルを頂点より先に調べる（頂点の近くに出るため） */
  function pointAt(screen: Point): { id: NodeId; index: number; part: PointPart } | null {
    const node = pointTarget()
    if (!node) return null
    const viewport = camera.getViewport()
    const near = (point: Point) => distance(worldToScreen(viewport, point), screen) <= HANDLE_SIZE
    const contours = editableContours(store.getState().page, node)
    for (const control of visibleContourControls(contours, selectedVertices())) {
      if (near(control.point)) return { id: node.id, index: control.index, part: control.part }
    }
    for (const [index, vertex] of flatVertices(contours).entries()) {
      if (near(vertex)) return { id: node.id, index, part: 'vertex' }
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
    // 頂点の編集から来たなら、そのパスの輪郭として足し、頂点の編集に戻る
    const target = contourTargetRef.current
    contourTargetRef.current = null
    const targetNode = target === null ? null : page.nodes[target]
    if (targetNode?.type === 'path' && !targetNode.locked) {
      const vertices = mapVertices(draft.points, (point) => toLocal(page, targetNode.parentId, point))
      store.apply((base) => addContour(base, targetNode.id, { vertices, closed }))
      store.select([targetNode.id])
      store.editVertices({ id: targetNode.id, vertices: [], segment: null })
      onToolChange('select')
      return
    }
    const parentId = findFrameAt(page, draft.points[0])
    const shape = pathFromPoints(
      mapVertices(draft.points, (point) => toLocal(page, parentId, point)),
      closed,
    )
    const node = { ...createPath(shape, closed), name: nextName(page, 'path') }
    store.apply((base) => insertNode(base, node, parentId))
    store.select([node.id])
    onToolChange('select')
  }

  /** リサイズと回転のハンドルを出す枠 */
  function selectionBox(): SelectionBox | null {
    if (tool !== 'select' || editingRef.current || pointTarget() || editedGradientHandles()) return null
    return selectionBoxOf(store.getState().page, movableIds())
  }

  function pick(pointer: CanvasPointer): NodeId | null {
    return pickNode(store.getState().page, camera.getViewport(), pointer)
  }

  /**
   * 選択枠の内側の、選んでいない所を押したか。図形のない所か、選んでいるものの親（フレーム）の上なら、
   * 選んでいるもの全体をつかんだことにする（既存のデザインツールと同じく、離れた図形の間をつかんでまとめて動かせる）
   */
  function insideSelection(pointer: CanvasPointer, hit: NodeId | null): boolean {
    const box = selectionBox()
    if (!box) return false
    const local = applyMatrix(invert(box.matrix), pointer.world)
    if (local.x < 0 || local.y < 0 || local.x > box.size.width || local.y > box.size.height) return false
    if (hit === null) return true
    const page = store.getState().page
    return !page.nodes[hit] || box.ids.every((id) => id !== hit && isSelfOrAncestor(page, hit, page.nodes[id].parentId))
  }

  /**
   * ペンツールで押した。頂点を足すか、最初の頂点なら閉じた形にして確定する。
   * 押したままドラッグすると、足した頂点からなめらかな曲線の制御点を引き出す（penDrag）
   */
  function penDown(pointer: CanvasPointer) {
    const draft = (penRef.current ??= { points: [], cursor: null })
    const last = draft.points.at(-1)
    // 最初の頂点をクリックすると、閉じた形になる
    if (draft.points.length >= 2) {
      const first = worldToScreen(camera.getViewport(), draft.points[0])
      if (distance(first, pointer.screen) <= HANDLE_SIZE) return finishPen(true)
    }
    const point = pointer.shiftKey && last ? constrainAngle(last, pointer.world) : roundPoint(pointer.world)
    // ダブルクリックの 2 回目など、同じ場所には重ねて打たない
    if (!last || last.x !== point.x || last.y !== point.y) draft.points.push(point)
    penPressRef.current = pointer.screen
    redraw()
  }

  /** ペンツールで押したままドラッグした。最後の頂点の out をポインタに、in をその反対側に置く（既存のデザインツールと同じ） */
  function penDrag(pointer: CanvasPointer) {
    const draft = penRef.current
    const press = penPressRef.current
    const last = draft?.points.at(-1)
    if (!draft || !press || !last || distance(pointer.screen, press) < DRAG_THRESHOLD) return
    // Shift で、頂点から見た向きを水平・垂直・45° に揃える
    const out = pointer.shiftKey ? constrainAngle(last, pointer.world) : roundPoint(pointer.world)
    const vertex = { x: last.x, y: last.y }
    draft.points[draft.points.length - 1] =
      out.x === vertex.x && out.y === vertex.y
        ? vertex
        : { ...vertex, out, in: { x: vertex.x * 2 - out.x, y: vertex.y * 2 - out.y } }
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
    if (tool === 'pen') return penDown(pointer)
    if (tool !== 'select') {
      gestureRef.current = createGesture(page, tool, pointer)
      return
    }

    // グラデーションを動かしている間は、そのハンドルを先に調べる。色の位置を押すとその色を選ぶ
    const gradientPart = gradientPartNear(pointer.screen)
    if (gradientPart) {
      const { edit, gradient, part } = gradientPart
      if (part.kind === 'stop') store.editGradient({ ...edit, stop: part.index })
      gestureRef.current = { kind: 'gradient', edit: store.getState().gradientEdit ?? edit, part, base: gradient }
      redraw()
      return
    }

    const grabbed = pointAt(pointer.screen)
    if (grabbed) {
      if (grabbed.part === 'vertex' && editedPath()) {
        // 頂点を押すと、その頂点を選ぶ（制御点のハンドルが出る）。Shift で選ぶ頂点に足す・外す。
        // 選んでいる頂点のどれかをつかんでドラッグすると、選んでいる頂点をまとめて動かす
        const selected = selectedVertices()
        const has = selected.includes(grabbed.index)
        if (pointer.shiftKey) {
          selectVertices(has ? selected.filter((index) => index !== grabbed.index) : [...selected, grabbed.index])
          if (has) return
        } else if (!has) {
          selectVertices([grabbed.index])
        }
        const group = has || pointer.shiftKey ? selectedVertices() : [grabbed.index]
        gestureRef.current = { kind: 'point', ...grabbed, group, collapse: has && !pointer.shiftKey, screen: pointer.screen }
        return
      }
      gestureRef.current = { kind: 'point', ...grabbed }
      redraw()
      return
    }

    // 頂点の編集中は、辺を押すとその辺を選び、空いた所や形の内側からのドラッグで頂点を範囲選択する
    const edited = editedPath()
    if (edited) {
      const nearest = nearestOnContours(editableContours(page, edited), pointer.world)
      if (nearest && nearest.distance * camera.getViewport().zoom <= HANDLE_SIZE) {
        selectVertices([], nearest.segment)
        return
      }
      const hit = pick(pointer)
      if (hit === null || hit === edited.id) {
        gestureRef.current = {
          kind: 'vertexMarquee',
          id: edited.id,
          screen: pointer.screen,
          world: pointer.world,
          current: pointer.world,
          base: pointer.shiftKey ? selectedVertices() : [],
          dragged: false,
        }
        return
      }
    }

    const viewport = camera.getViewport()
    const box = selectionBox()
    if (box && rotateHandleAt(viewport, box, pointer.screen)) {
      const pivot = applyMatrix(box.matrix, { x: box.size.width / 2, y: box.size.height / 2 })
      gestureRef.current = rotateGesture(page, box.ids, pivot, pointer.world)
      return
    }

    const handle = handleAt(viewport, box, pointer.screen)
    if (handle && box?.oriented) {
      gestureRef.current = {
        kind: 'reshape',
        world: pointer.world,
        handle,
        id: box.oriented,
        rotation: box.rotation,
        size: box.size,
        matrix: box.matrix,
        guides: [],
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
    if (!pointer.shiftKey && insideSelection(pointer, hit)) {
      // 選択枠の内側の空いた所。ドラッグなら選んでいるもの全体を動かし、クリックだけなら押した所のものを選び直す
      gestureRef.current = { kind: 'press', screen: pointer.screen, world: pointer.world, collapseTo: null, clickSelect: hit ? [hit] : [] }
      return
    }
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
        penDrag(pointer)
        penRef.current.cursor = pointer.world
        redraw()
        return
      }
      if (tool !== 'select' || editingRef.current) return
      const viewport = camera.getViewport()
      const box = selectionBox()
      const handle = handleAt(viewport, box, pointer.screen)
      const endpoint = pointAt(pointer.screen) ?? gradientPartNear(pointer.screen)
      const rotating = rotateHandleAt(viewport, box, pointer.screen)
      const rotation = box?.rotation ?? 0
      setCursor(
        rotating ? 'grab' : handle ? handleCursor(handle, rotation) : endpoint ? 'crosshair' : 'default',
      )
      setHover(rotating || handle || endpoint ? null : pick(pointer))
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
      gesture = gestureRef.current = moveGesture(store.getState().page, gesture.world, ids, from)
    }

    dragGesture(store, gesture, pointer, camera.getViewport().zoom)
    // 回している最中は、角度の表示を描き直す
    if (gesture.kind === 'rotate') redraw()
  }

  function onPointerUp(pointer: CanvasPointer) {
    penPressRef.current = null
    const gesture = gestureRef.current
    gestureRef.current = null
    if (!gesture) return

    switch (gesture.kind) {
      case 'press':
        if (gesture.collapseTo) store.select([gesture.collapseTo])
        else if (gesture.clickSelect) store.select(gesture.clickSelect)
        break
      case 'point':
        // 選んでいる頂点の 1 つを押しただけなら、その頂点だけを選び直す
        if (gesture.collapse && !gesture.moved) selectVertices([gesture.index])
        store.commitPreview()
        redraw()
        break
      case 'vertexMarquee':
        if (!gesture.dragged) {
          // クリックだけなら、形の内側では頂点の選択を外し、空いた所では頂点の編集を抜けて選択を外す（前からの動き）
          if (pick(pointer) === gesture.id) selectVertices([])
          else store.select([])
        }
        redraw()
        break
      case 'move':
      case 'resize':
      case 'reshape':
      case 'rotate':
      case 'gradient':
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
          previewCreate(store, gesture, { ...at, width: 100, height: isLine(gesture.node) ? 0 : 100 })
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
    penPressRef.current = null
    store.cancelPreview()
    redraw()
  }

  function onDoubleClick(pointer: CanvasPointer) {
    if (tool === 'pen') return finishPen(false)
    if (tool !== 'select' || editingRef.current) return
    if (addGradientStopAt(pointer)) return
    if (editVertexAt(pointer)) return
    const page = store.getState().page
    const tolerance = HIT_TOLERANCE / camera.getViewport().zoom
    const top = hitTest(page, pointer.world, { tolerance })
    if (!top) return
    // インスタンスは、ダブルクリックで中身を選べる（文言や色を、そのインスタンスだけ変えられる）。
    // ブーリアン演算のノードも、ダブルクリックで元の図形を選べる
    const boolean = isBooleanNode(page.nodes[top])
    const inner = isInstance(page.nodes[top]) || boolean
    const hit = inner ? (hitTest(page, pointer.world, { tolerance, deep: !boolean, booleanChildren: boolean }) ?? top) : top
    if (page.nodes[hit].type === 'text') {
      store.select([hit])
      editText(hit)
    } else if (inner) {
      store.select([hit])
    } else if (page.nodes[hit].type === 'path') {
      // パスは頂点の編集に入る。別のものを選ぶか Esc で抜ける
      store.select([hit])
      store.editVertices({ id: hit, vertices: [], segment: null })
    } else {
      // グラデーションの塗りか線を持つ図形は、キャンバスでグラデーションを動かす操作に入る（塗りの行のボタンと同じ）
      const edit = gradientToEdit(page.nodes[hit])
      if (edit) {
        store.select([hit])
        store.editGradient(edit)
      }
    }
  }

  /** グラデーションを動かしている間のダブルクリック。色が並ぶ線の上なら、そこに色を足して選ぶ。扱ったら true */
  function addGradientStopAt(pointer: CanvasPointer): boolean {
    const edited = editedGradientHandles()
    if (!edited) return false
    if (gradientPartNear(pointer.screen)) return true
    const { edit, handles } = edited
    // 線からの距離はページ座標で測り、画面の距離に直して比べる
    const axis = offsetOnAxis(handles, pointer.world)
    if (axis.distance * camera.getViewport().zoom > HANDLE_SIZE) return false
    const added = withStopAt(edited.gradient, Math.round(axis.offset * 1000) / 1000)
    if (added.index === -1) return true
    store.apply((base) => patchGradientAt(base, [edit.id], edit.key, edit.index, () => added.gradient))
    store.editGradient({ ...edit, stop: added.index })
    return true
  }

  /**
   * 頂点の編集中のダブルクリック。頂点なら角となめらかを切り替え、辺の上なら形を変えずに頂点を足す。
   * 扱ったら true
   */
  function editVertexAt(pointer: CanvasPointer): boolean {
    const node = editedPath()
    if (!node) return false
    const grabbed = pointAt(pointer.screen)
    if (grabbed?.part === 'vertex') {
      store.apply((base) =>
        reshapeContours(base, node.id, (contours) =>
          editByContour(contours, [grabbed.index], (vertices, closed, [index]) => toggleSmooth(vertices, index, closed)),
        ),
      )
      selectVertices([grabbed.index])
      return true
    }
    if (grabbed) return true
    // 辺の位置 t は、座標を変換しても変わらないので、ページ座標で探した位置をそのまま使える
    const page = store.getState().page
    const nearest = nearestOnContours(editableContours(page, node), pointer.world)
    if (!nearest || nearest.distance * camera.getViewport().zoom > HANDLE_SIZE) return false
    // 足した頂点は辺の始まりの頂点の次に入るので、通し番号は segment + 1 になる（後ろの輪郭の番号は 1 つずつずれる）
    store.apply((base) =>
      reshapeContours(base, node.id, (contours) =>
        editByContour(contours, [nearest.segment], (vertices, closed, [segment]) => insertVertex(vertices, closed, segment, nearest.t)),
      ),
    )
    selectVertices([nearest.segment + 1])
    return true
  }

  /**
   * Delete / Backspace。頂点の編集中に頂点を選んでいれば、その頂点をまとめて消す。閉じた形の辺を選んでいれば、その辺を消して開く。
   * 頂点の編集中は、消せなくてもノードは消さない。扱ったら true
   */
  function onDeleteKey(): boolean {
    // グラデーションを動かしている間は、選んでいる色を消す（2 色より減らさない）。ノードは消さない
    const edited = editedGradientHandles()
    if (edited) {
      const { edit } = edited
      if (edit.stop !== null && edited.gradient.stops.length > 2) {
        const stop = edit.stop
        store.apply((base) => patchGradientAt(base, [edit.id], edit.key, edit.index, (g) => withStopRemoved(g, stop)))
        store.editGradient({ ...edit, stop: null })
      }
      return true
    }
    const node = editedPath()
    if (!node) return false
    const indices = selectedVertices()
    const segment = selectedSegment()
    if (indices.length > 0) {
      store.apply((base) => reshapeContours(base, node.id, (contours) => deleteContourVertices(contours, indices)))
      selectVertices([])
    } else if (segment !== null) {
      store.apply((base) =>
        reshapeContours(base, node.id, (contours) =>
          editByContour(contours, [segment], (vertices, closed, [local]) => openAtSegment(vertices, closed, local)),
        ),
      )
      selectVertices([])
    }
    return true
  }

  /** 矢印キー。頂点の編集中に頂点を選んでいれば、その頂点をまとめて動かす。扱ったら true */
  function onNudgeKey(dx: number, dy: number): boolean {
    const node = editedPath()
    const indices = selectedVertices()
    if (!node || indices.length === 0) return false
    store.apply((base) =>
      reshapeContours(base, node.id, (contours) => withFlatVertices(contours, moveVertices(flatVertices(contours), indices, dx, dy))),
    )
    return true
  }

  /** Esc（ペンで描いている途中なら Enter も）で、いまの操作を 1 段だけ抜ける */
  function onCancelKey(key: string): boolean {
    if (key === 'enter' && !penRef.current) return false
    if (gestureRef.current) cancelGesture()
    else if (penRef.current) finishPen(false)
    else if (tool !== 'select') onToolChange('select')
    else if (editedPath()) store.editVertices(null)
    else if (editedGradientHandles()) store.editGradient(null)
    else store.select([])
    return true
  }

  const commands = useShortcuts({
    store,
    camera,
    dragging: () => gestureRef.current !== null,
    onCancelKey,
    onDeleteKey,
    onNudgeKey,
    ownIds,
    movableIds,
    onToolChange,
    editText,
    onPasteImages,
    onPasteSvg,
    onMessage,
  })

  /** メニューを出す前に、途中の操作（文字の編集・ペン・ほかのツール）を終える */
  function prepareMenu() {
    if (editingRef.current) finishEditing()
    if (penRef.current) finishPen(false)
    if (tool !== 'select') onToolChange('select')
    setHover(null)
  }

  /** 右クリック。押した所のものを選んで（選択枠の内側なら選択はそのまま）、メニューを出す */
  function onContextMenu(pointer: CanvasPointer) {
    if (gestureRef.current) return
    prepareMenu()
    const { selection } = store.getState()
    const hit = pick(pointer)
    if (hit ? !selection.includes(hit) && !insideSelection(pointer, hit) : !insideSelection(pointer, null)) {
      store.select(hit ? [hit] : [])
    }
    setMenuAt(pointer.client)
  }

  // レイヤーパネルの右クリックからも、同じメニューを出せるようにする（選ぶのはパネルの側）
  // 出す関数はいつも最新の値（ツールなど）を見る。入れ替えるのは描き終えたあと
  const openFromOutside = useRef<MenuOpener>(() => {})
  useLayoutEffect(() => {
    openFromOutside.current = (at) => {
      if (gestureRef.current) return
      prepareMenu()
      setMenuAt(at)
    }
  })
  useEffect(() => {
    if (!menuOpenerRef) return
    menuOpenerRef.current = (at) => openFromOutside.current(at)
    return () => {
      menuOpenerRef.current = null
    }
  }, [menuOpenerRef])

  /** 表示・ロックの切り替え。選んだもののうち 1 つでも見えている（ロックしていない）なら全部を隠す（ロックする） */
  function visibilityItems(): MenuItem[] {
    const { page, selection } = store.getState()
    // 写し（インスタンスの中身）は、表示の切り替えだけできる（レイヤーパネルの行と同じ）
    const shown = selection.some((id) => page.nodes[id]?.visible)
    const own = ownIds()
    const unlocked = own.some((id) => !page.nodes[id]?.locked)
    return [
      {
        label: shown ? '非表示にする' : '表示する',
        onSelect: () => store.apply((base) => updateNodes(base, selection, { visible: !shown })),
      },
      {
        label: unlocked ? 'ロックする' : 'ロックを解除',
        disabled: own.length === 0,
        onSelect: () => store.apply((base) => updateNodes(base, own, { locked: unlocked })),
      },
    ]
  }

  function menuItems(): MenuItem[] {
    const { document, page } = store.getState()
    const own = ownIds()
    const none = own.length === 0
    const canPaste = commands.canPaste()
    if (store.getState().selection.length === 0) {
      return [
        { label: '貼り付け', shortcut: `${MOD}V`, disabled: !canPaste, onSelect: commands.paste },
        'separator',
        { label: '全体を表示', shortcut: `${SHIFT}1`, onSelect: commands.zoomToFit },
      ]
    }
    const otherPages = document.pages.filter((other) => other.id !== page.id)
    return [
      { label: 'コピー', shortcut: `${MOD}C`, disabled: none, onSelect: commands.copy },
      { label: 'SVG としてコピー', onSelect: onCopySvg },
      { label: '貼り付け', shortcut: `${MOD}V`, disabled: !canPaste, onSelect: commands.paste },
      { label: '複製', shortcut: `${MOD}D`, disabled: none, onSelect: commands.duplicate },
      { label: '削除', shortcut: 'Delete', disabled: movableIds().length === 0, onSelect: commands.remove },
      'separator',
      ...visibilityItems(),
      'separator',
      { label: '最前面へ', shortcut: ']', disabled: none, onSelect: () => commands.reorder('front') },
      { label: '前面へ', shortcut: `${MOD}]`, disabled: none, onSelect: () => commands.reorder('forward') },
      { label: '背面へ', shortcut: `${MOD}[`, disabled: none, onSelect: () => commands.reorder('backward') },
      { label: '最背面へ', shortcut: '[', disabled: none, onSelect: () => commands.reorder('back') },
      'separator',
      { label: '左右に反転', shortcut: `${SHIFT}H`, disabled: movableIds().length === 0, onSelect: () => commands.flip('horizontal') },
      { label: '上下に反転', shortcut: `${SHIFT}V`, disabled: movableIds().length === 0, onSelect: () => commands.flip('vertical') },
      'separator',
      { label: 'フレームにまとめる（自動で並べる）', shortcut: `${SHIFT}A`, disabled: movableIds().length === 0, onSelect: commands.wrap },
      {
        label: maskAction(page, movableIds()) === 'clear' ? 'マスクをやめる' : 'マスクとして使う',
        shortcut: `${ALT}${MOD}M`,
        disabled: maskAction(page, movableIds()) === null,
        onSelect: commands.mask,
      },
      { label: 'パスを結合', shortcut: `${MOD}E`, disabled: !canJoinPaths(page, movableIds()), onSelect: commands.join },
      { label: 'パスを分割', shortcut: `${SHIFT}${MOD}E`, disabled: !canSplitPaths(page, movableIds()), onSelect: commands.split },
      {
        label: 'ブーリアン演算（パスに焼き込む）',
        disabled: !canBooleanPaths(page, movableIds()),
        submenu: BOOLEAN_MENU.map(({ op, key }) => ({ label: BOOLEAN_LABELS[op], shortcut: `${ALT}${SHIFT}${MOD}${key}`, onSelect: () => commands.booleanOp(op) })),
      },
      {
        label: 'ブーリアン演算（元を残す）',
        disabled: !canCreateBooleanNode(page, movableIds()) && !canFlattenBoolean(page, movableIds()),
        submenu: [
          ...BOOLEAN_MENU.map(({ op, key }) => ({
            label: BOOLEAN_LABELS[op],
            shortcut: `${ALT}${SHIFT}${key}`,
            disabled: !canCreateBooleanNode(page, movableIds()),
            onSelect: () => commands.booleanNode(op),
          })),
          'separator' as const,
          { label: '平らにする', disabled: !canFlattenBoolean(page, movableIds()), onSelect: commands.flattenBoolean },
        ],
      },
      { label: '線の輪郭化', shortcut: `${ALT}${MOD}O`, disabled: !canOutlineStroke(page, movableIds()), onSelect: commands.outlineStroke },
      {
        // 埋め込んでいない書体のテキストでも押せる（押すと、書体ファイルを足すよう説明を出す）
        label: 'テキストのアウトライン化',
        shortcut: `${SHIFT}${MOD}O`,
        disabled: !movableIds().some((id) => page.nodes[id]?.type === 'text'),
        onSelect: commands.outlineText,
      },
      {
        label: 'コンポーネントにする',
        shortcut: `${ALT}${MOD}K`,
        disabled: !own.some((id) => makeComponent(page, id) !== page),
        onSelect: commands.componentize,
      },
      'separator',
      { label: '選択へズーム', shortcut: `${SHIFT}2`, onSelect: commands.zoomToSelection },
      {
        label: '別のページへ移す',
        disabled: none || otherPages.length === 0,
        submenu: otherPages.map((other) => ({ label: other.name, onSelect: () => commands.moveToPage(other.id) })),
      },
    ]
  }

  /** 重ねて描くグラデーションのハンドル */
  function gradientOverlay() {
    const edited = editedGradientHandles()
    return (
      edited && {
        handles: screenGradientHandles(edited.handles),
        type: edited.gradient.type,
        colors: edited.gradient.stops.map((stop) => stop.color),
        selected: edited.edit.stop,
      }
    )
  }

  function drawOverlay(ctx: CanvasRenderingContext2D, viewport: Viewport) {
    drawEditorOverlay(ctx, viewport, {
      page: state.page,
      selection: state.selection,
      hover,
      gesture: gestureRef.current,
      pointed: pointTarget(),
      editedId: editedPath()?.id,
      selectedVertices: selectedVertices(),
      selectedSegment: selectedSegment(),
      gradient: gradientOverlay(),
      pen: penRef.current,
      box: selectionBox(),
      dropTarget,
    })
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
      onContextMenu={onContextMenu}
    >
      {menuAt && <ContextMenu at={menuAt} items={menuItems()} onClose={closeMenu} />}
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
