import { useEffect, useReducer, useRef, useState } from 'react'
import { type CanvasPointer, CanvasView } from '../canvas/CanvasView.tsx'
import type { Camera } from '../canvas/camera.ts'
import { hitTest } from '../canvas/hitTest.ts'
import { HIT_TOLERANCE, pickNode } from '../canvas/pick.ts'
import { type Viewport, worldToScreen } from '../canvas/viewport.ts'
import { isInstance, owningInstance } from '../document/component.ts'
import { type Point, applyMatrix, getNodesBounds, toLocal } from '../document/geometry.ts'
import { type Vertex, isLine, mapVertices, pathFromPoints } from '../document/path.ts'
import type { NodeId, PathNode, SceneNode } from '../document/types.ts'
import { TextEditor } from './TextEditor.tsx'
import { withoutCopies } from './components.ts'
import { type Gesture, createGesture, dragGesture, previewCreate, rotateGesture } from './editorCanvas/drag.ts'
import {
  DRAG_THRESHOLD,
  HANDLE_SIZE,
  type PointPart,
  type SelectionBox,
  constrainAngle,
  distance,
  editablePoints,
  handleAt,
  nextName,
  rotateHandleAt,
  roundPoint,
  selectionBoxOf,
  visibleControls,
} from './editorCanvas/handles.ts'
import { drawEditorOverlay } from './editorCanvas/overlay.ts'
import { useShortcuts } from './editorCanvas/useShortcuts.ts'
import { useTextEditing } from './editorCanvas/useTextEditing.ts'
import { findFrameAt } from './hitTest.ts'
import { createPath } from './nodes.ts'
import { insertNode } from './operations.ts'
import { deleteVertex, insertVertex, nearestOnPath, reshapePath, toggleSmooth } from './pathEdit.ts'
import { handleCursor } from './resize.ts'
import type { EditorState, EditorStore } from './store.ts'
import type { Tool } from './tools.ts'

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
  /** コンポーネントの一覧からドラッグしているインスタンスが入るフレーム（ページ直下なら null） */
  dropTarget?: NodeId | null
}

export function EditorCanvas({ store, camera, state, tool, onToolChange, onPasteImages, onPasteSvg, dropTarget = null }: Props) {
  const gestureRef = useRef<Gesture | null>(null)
  // ペンツールで描いている途中の頂点（ページ座標、制御点を含む）。cursor はポインタの位置
  const penRef = useRef<{ points: Vertex[]; cursor: Point | null } | null>(null)
  // ペンツールで押している間の、押した位置（画面座標）。ドラッグすると最後の頂点の制御点を引き出す
  const penPressRef = useRef<Point | null>(null)
  // 頂点を編集中のパス。ダブルクリックで入る
  const vertexEditRef = useRef<NodeId | null>(null)
  // 頂点の編集中に選んでいる頂点の番号。その頂点と両隣の制御点のハンドルを出す
  const vertexSelRef = useRef<number | null>(null)
  const [hover, setHover] = useState<NodeId | null>(null)
  const [cursor, setCursor] = useState('default')
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const { editing, editingRef, editText, startNewText, onTextInput, finishEditing } = useTextEditing(
    store,
    onToolChange,
  )

  // ツールを切り替えたら、描きかけのパスや頂点の編集は終える
  useEffect(() => {
    if (tool !== 'pen') penRef.current = null
    if (tool !== 'select') vertexEditRef.current = vertexSelRef.current = null
  }, [tool])

  // 別のものを選んだら、頂点の編集は終える
  useEffect(() => {
    const editing = vertexEditRef.current
    if (editing && (state.selection.length !== 1 || state.selection[0] !== editing)) {
      vertexEditRef.current = vertexSelRef.current = null
    }
  }, [state.selection])

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
    return node?.type === 'path' && node.id === vertexEditRef.current && !node.locked ? node : null
  }

  /** 点をつかんで形を変えられるノード。直線は選ぶだけで、パスは頂点の編集に入ると対象になる（直線も入れる） */
  function pointTarget(): PathNode | null {
    return editedPath() ?? selectedLine()
  }

  /** 頂点の編集中に選んでいる頂点（なければ null） */
  function selectedVertex(): number | null {
    const node = editedPath()
    const index = vertexSelRef.current
    return node && index !== null && index < node.points.length ? index : null
  }

  /** screen にある、つかめる点。制御点のハンドルを頂点より先に調べる（頂点の近くに出るため） */
  function pointAt(screen: Point): { id: NodeId; index: number; part: PointPart } | null {
    const node = pointTarget()
    if (!node) return null
    const viewport = camera.getViewport()
    const near = (point: Point) => distance(worldToScreen(viewport, point), screen) <= HANDLE_SIZE
    const vertices = editablePoints(store.getState().page, node)
    for (const control of visibleControls(vertices, selectedVertex(), node.closed)) {
      if (near(control.point)) return { id: node.id, index: control.index, part: control.part }
    }
    for (const [index, vertex] of vertices.entries()) {
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
    if (tool !== 'select' || editingRef.current || pointTarget()) return null
    return selectionBoxOf(store.getState().page, movableIds())
  }

  function pick(pointer: CanvasPointer): NodeId | null {
    return pickNode(store.getState().page, camera.getViewport(), pointer)
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

    const grabbed = pointAt(pointer.screen)
    if (grabbed) {
      // 頂点を押すと、その頂点を選ぶ（制御点のハンドルが出る）
      if (grabbed.part === 'vertex' && editedPath()) vertexSelRef.current = grabbed.index
      gestureRef.current = { kind: 'point', ...grabbed }
      redraw()
      return
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
        penDrag(pointer)
        penRef.current.cursor = pointer.world
        redraw()
        return
      }
      if (tool !== 'select' || editingRef.current) return
      const viewport = camera.getViewport()
      const box = selectionBox()
      const handle = handleAt(viewport, box, pointer.screen)
      const endpoint = pointAt(pointer.screen)
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
      gesture = gestureRef.current = { kind: 'move', world: gesture.world, ids, from, guides: [] }
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
    if (editVertexAt(pointer)) return
    const page = store.getState().page
    const tolerance = HIT_TOLERANCE / camera.getViewport().zoom
    const top = hitTest(page, pointer.world, { tolerance })
    if (!top) return
    // インスタンスは、ダブルクリックで中身を選べる（文言や色を、そのインスタンスだけ変えられる）
    const inner = isInstance(page.nodes[top])
    const hit = inner ? (hitTest(page, pointer.world, { tolerance, deep: true }) ?? top) : top
    if (page.nodes[hit].type === 'text') {
      store.select([hit])
      editText(hit)
    } else if (inner) {
      store.select([hit])
    } else if (page.nodes[hit].type === 'path') {
      // パスは頂点の編集に入る。別のものを選ぶか Esc で抜ける
      store.select([hit])
      vertexEditRef.current = hit
      vertexSelRef.current = null
      redraw()
    }
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
      store.apply((base) => reshapePath(base, node.id, (vertices, closed) => toggleSmooth(vertices, grabbed.index, closed)))
      vertexSelRef.current = grabbed.index
      redraw()
      return true
    }
    if (grabbed) return true
    // 辺の位置 t は、座標を変換しても変わらないので、ページ座標で探した位置をそのまま使える
    const page = store.getState().page
    const nearest = nearestOnPath(editablePoints(page, node), node.closed, pointer.world)
    if (!nearest || nearest.distance * camera.getViewport().zoom > HANDLE_SIZE) return false
    store.apply((base) =>
      reshapePath(base, node.id, (vertices, closed) => insertVertex(vertices, closed, nearest.segment, nearest.t)),
    )
    vertexSelRef.current = nearest.segment + 1
    redraw()
    return true
  }

  /** Delete / Backspace。頂点の編集中に頂点を選んでいれば、その頂点を消す。扱ったら true */
  function onDeleteKey(): boolean {
    const node = editedPath()
    const index = selectedVertex()
    if (!node || index === null) return false
    store.apply((base) => reshapePath(base, node.id, (vertices, closed) => deleteVertex(vertices, closed, index)))
    vertexSelRef.current = null
    redraw()
    return true
  }

  /** Esc（ペンで描いている途中なら Enter も）で、いまの操作を 1 段だけ抜ける */
  function onCancelKey(key: string): boolean {
    if (key === 'enter' && !penRef.current) return false
    if (gestureRef.current) cancelGesture()
    else if (penRef.current) finishPen(false)
    else if (tool !== 'select') onToolChange('select')
    else if (editedPath()) {
      vertexEditRef.current = vertexSelRef.current = null
      redraw()
    } else store.select([])
    return true
  }

  useShortcuts({
    store,
    camera,
    dragging: () => gestureRef.current !== null,
    onCancelKey,
    onDeleteKey,
    ownIds,
    movableIds,
    onToolChange,
    editText,
    onPasteImages,
    onPasteSvg,
  })

  function drawOverlay(ctx: CanvasRenderingContext2D, viewport: Viewport) {
    drawEditorOverlay(ctx, viewport, {
      page: state.page,
      selection: state.selection,
      hover,
      gesture: gestureRef.current,
      pointed: pointTarget(),
      editedId: editedPath()?.id,
      selectedVertex: selectedVertex(),
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
